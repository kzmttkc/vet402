// ============================================================
// Vouch — chunked eth_getLogs (owner/funder/outcome indexer core).
//
// The follow-through throughput of every indexer rides on this function:
// a wide catch-up range is split into fixed-size chunks and fetched with a
// small bounded fan-out. The properties that must hold no matter how the
// fetches interleave:
//   1. every block in [from,to] is covered exactly once (no gaps, no dup scans);
//   2. the returned logs are in ascending block order — transfer replay in
//      owner-indexer depends on it (fail-closed: a mis-ordered burn/mint pair
//      would flip ownership the wrong way);
//   3. the fan-out never exceeds the configured bound (don't hammer the RPC);
//   4. transient rate-limits and over-wide-range errors degrade (retry /
//      bisect), never silently drop a chunk.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetLearnedRangeCapsForTests,
  getLogsChunked,
  getLogsChunkConcurrency,
  providerStatedRangeLimit,
} from "@/lib/chain/chunked-logs";

type Range = { start: bigint; end: bigint };
type Log = { blockNumber: bigint; id: string };

// Minimal fake that records every getLogs call and returns one log per range
// tagged with its start block, so tests can assert coverage and ordering.
function makeClient(opts?: {
  onRange?: (r: Range) => Log[] | Error;
  trackConcurrency?: boolean;
}) {
  const calls: Range[] = [];
  let inFlight = 0;
  let peak = 0;
  const client = {
    async getLogs(params: { fromBlock: bigint; toBlock: bigint }) {
      const range = { start: params.fromBlock, end: params.toBlock };
      calls.push(range);
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      try {
        // Yield so overlapping fetches actually interleave under parallelism.
        await new Promise((r) => setTimeout(r, 1));
        const out = opts?.onRange?.(range);
        if (out instanceof Error) throw out;
        return (out ?? [{ blockNumber: range.start, id: `${range.start}-${range.end}` }]) as unknown[];
      } finally {
        inFlight--;
      }
    },
  };
  return {
    client: client as unknown as Parameters<typeof getLogsChunked>[0],
    calls,
    peak: () => peak,
  };
}

test("covers the whole range in ascending, gap-free chunks", async () => {
  const { client, calls } = makeClient();
  const logs = (await getLogsChunked(
    client,
    { fromBlock: 100n, toBlock: 349n },
    100n,
    4,
  )) as unknown as Log[];

  // 100-199, 200-299, 300-349 — no gaps, last chunk clamped to toBlock.
  const ordered = [...calls].sort((a, b) => Number(a.start - b.start));
  assert.deepEqual(
    ordered.map((c) => [c.start, c.end]),
    [
      [100n, 199n],
      [200n, 299n],
      [300n, 349n],
    ],
  );
  // Result is index-aligned to ascending ranges regardless of fetch interleave.
  assert.deepEqual(
    logs.map((l) => l.blockNumber),
    [100n, 200n, 300n],
  );
});

test("single block range is one inclusive chunk", async () => {
  const { client, calls } = makeClient();
  const logs = (await getLogsChunked(client, { fromBlock: 5n, toBlock: 5n }, 100n, 4)) as unknown as Log[];
  assert.deepEqual(calls, [{ start: 5n, end: 5n }]);
  assert.equal(logs.length, 1);
});

test("empty when fromBlock > toBlock (no calls)", async () => {
  const { client, calls } = makeClient();
  const logs = await getLogsChunked(client, { fromBlock: 10n, toBlock: 9n }, 100n, 4);
  assert.equal(logs.length, 0);
  assert.equal(calls.length, 0);
});

test("fan-out never exceeds the configured concurrency", async () => {
  const { client, peak } = makeClient({ trackConcurrency: true });
  // 20 chunks, cap 3 → peak in-flight must stay <= 3.
  await getLogsChunked(client, { fromBlock: 0n, toBlock: 199n }, 10n, 3);
  assert.ok(peak() <= 3, `peak in-flight ${peak()} exceeded cap 3`);
  assert.ok(peak() >= 2, `expected real parallelism, saw peak ${peak()}`);
});

test("concurrency 1 stays strictly sequential", async () => {
  const { client, peak } = makeClient({ trackConcurrency: true });
  await getLogsChunked(client, { fromBlock: 0n, toBlock: 99n }, 10n, 1);
  assert.equal(peak(), 1);
});

test("a configured pacing delay forces sequential fetching", async () => {
  process.env.GET_LOGS_CHUNK_DELAY_MS = "1";
  try {
    const { client, peak } = makeClient({ trackConcurrency: true });
    // concurrency 4 requested, but delay pins it to one-at-a-time.
    await getLogsChunked(client, { fromBlock: 0n, toBlock: 99n }, 10n, 4);
    assert.equal(peak(), 1);
  } finally {
    delete process.env.GET_LOGS_CHUNK_DELAY_MS;
  }
});

test("rate-limited chunk is retried, not dropped", async () => {
  let failedOnce = false;
  const { client, calls } = makeClient({
    onRange: (r) => {
      if (r.start === 10n && !failedOnce) {
        failedOnce = true;
        return Object.assign(new Error("rate limit exceeded"), { code: -32016 });
      }
      return [{ blockNumber: r.start, id: `${r.start}` }];
    },
  });
  const logs = (await getLogsChunked(client, { fromBlock: 0n, toBlock: 29n }, 10n, 2)) as unknown as Log[];
  // 3 chunks + 1 retry of the middle chunk = 4 calls; all three blocks present.
  assert.equal(calls.length, 4);
  assert.deepEqual(
    logs.map((l) => l.blockNumber),
    [0n, 10n, 20n],
  );
});

test("over-wide-range error bisects until it succeeds", async () => {
  // Reject any single getLogs wider than 4 blocks (non-rate-limit error) so
  // the 10-block chunk must bisect down.
  const { client } = makeClient({
    onRange: (r) => {
      if (r.end - r.start > 4n) return new Error("query returned more than 10000 results");
      return [{ blockNumber: r.start, id: `${r.start}-${r.end}` }];
    },
  });
  const logs = (await getLogsChunked(client, { fromBlock: 0n, toBlock: 9n }, 10n, 2)) as unknown as Log[];
  // The chunk bisected into sub-ranges that each satisfy the <=4 span limit.
  assert.ok(logs.length >= 1);
  assert.ok(logs.every((l) => typeof l.blockNumber === "bigint"));
});

test("concurrency env clamps to a sane bounded range", () => {
  const prev = process.env.GET_LOGS_CHUNK_CONCURRENCY;
  try {
    delete process.env.GET_LOGS_CHUNK_CONCURRENCY;
    assert.equal(getLogsChunkConcurrency(), 4); // conservative default

    process.env.GET_LOGS_CHUNK_CONCURRENCY = "1";
    assert.equal(getLogsChunkConcurrency(), 1);

    process.env.GET_LOGS_CHUNK_CONCURRENCY = "100";
    assert.equal(getLogsChunkConcurrency(), 8); // capped — never hammer the RPC

    process.env.GET_LOGS_CHUNK_CONCURRENCY = "0";
    assert.equal(getLogsChunkConcurrency(), 1); // floored to sequential

    process.env.GET_LOGS_CHUNK_CONCURRENCY = "not-a-number";
    assert.equal(getLogsChunkConcurrency(), 4);
  } finally {
    if (prev === undefined) delete process.env.GET_LOGS_CHUNK_CONCURRENCY;
    else process.env.GET_LOGS_CHUNK_CONCURRENCY = prev;
  }
});

// ============================================================
// 2026-08-12 incident — the bisection amplifier.
//
// fetchRange treated EVERY getLogs failure as "the range is too wide" and
// recursively halved it. For errors that halving can never fix (a provider
// rejecting the request shape, an auth failure, a dead endpoint) that turns
// ONE failed call into ~2^depth failed calls: production logs showed a 2,000
// block chunk bisected down to 15-block ranges, thousands of doomed requests
// deep, which is what consumed the scoring path's entire time budget.
//
// Bisection must be reserved for errors that bisection can actually resolve.
// Everything else has to fail fast and let the caller's `*_unavailable`
// degradation path run.
// ============================================================

test("a non-range error fails fast instead of bisecting", async () => {
  const { client, calls } = makeClient({
    onRange: () => new Error("JSON is not a valid request object."),
  });
  await assert.rejects(
    () => getLogsChunked(client, { fromBlock: 0n, toBlock: 1_999n }, 2_000n, 1),
    /JSON is not a valid request object/,
  );
  // Exactly one attempt — no halving, no amplification.
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length} (bisection amplified)`);
});

test("an auth/provider failure is not retried into thousands of calls", async () => {
  const { client, calls } = makeClient({
    onRange: () => Object.assign(new Error("Unauthorized"), { status: 401 }),
  });
  await assert.rejects(() =>
    getLogsChunked(client, { fromBlock: 0n, toBlock: 9_999n }, 10_000n, 1),
  );
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
});

test("range-shaped errors still bisect (regression guard)", async () => {
  for (const message of [
    "query returned more than 10000 results",
    "eth_getLogs is limited to a 10,000 range",
    "block range is too wide",
    "response size exceeded",
    "HTTP response body exceeded the size limit.\n\nMax: 10485760 bytes\nReceived: 10502144 bytes",
  ]) {
    const { client, calls } = makeClient({
      onRange: (r) => (r.end - r.start > 4n ? new Error(message) : [{ blockNumber: r.start, id: "x" }]),
    });
    const logs = await getLogsChunked(client, { fromBlock: 0n, toBlock: 9n }, 10n, 1);
    assert.ok(calls.length > 1, `"${message}" should have bisected, saw ${calls.length} call(s)`);
    assert.ok(logs.length >= 1, `"${message}" produced no logs`);
  }
});

test("a scan that outlives its deadline aborts instead of running unbounded", async () => {
  // 1,000 sequential chunks, each costing ~1ms inside the fake client.
  const { client, calls } = makeClient({ onRange: () => [] });
  await assert.rejects(
    () =>
      getLogsChunked(client, { fromBlock: 0n, toBlock: 99_999n }, 100n, 1, { deadlineMs: 100 }),
    /deadline/i,
  );
  // Stopped early rather than grinding through all 1,000 chunks.
  assert.ok(
    calls.length < 1000,
    `expected an early abort, made all ${calls.length} calls`,
  );
});

test("range words echoed back inside our own request do not trigger bisection", async () => {
  // viem puts the endpoint URL and the FULL serialized request body into
  // error.message. Matching range keywords against that string tests our own
  // payload, not the provider's complaint — and a wide scan's payload is
  // exactly where range-ish words show up. Only the provider's words count.
  const viemShaped = Object.assign(
    new Error(
      [
        "JSON is not a valid request object.",
        "",
        "URL: https://rpc.example.com/v2/key?note=limited%20to%20a%20block%20range",
        'Request body: {"method":"eth_getLogs","params":[{"comment":"more than a query timeout"}]}',
        "",
        "Details: JSON is not a valid request object.",
        "Version: viem@2.55.1",
      ].join("\n"),
    ),
    { code: -32600, details: "JSON is not a valid request object.", shortMessage: "JSON is not a valid request object." },
  );

  const { client, calls } = makeClient({ onRange: () => viemShaped });
  await assert.rejects(() =>
    getLogsChunked(client, { fromBlock: 0n, toBlock: 9_999n }, 10_000n, 1),
  );
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length} (echoed text caused bisection)`);
});

test("a request-shape rejection never bisects, even carrying range words", async () => {
  // The production case (2026-08-12). A 680-block query — nowhere near any
  // range limit — was rejected with "JSON is not a valid request object." and
  // bisected all the way to 20-block chunks, logging `matched=text:block range`.
  // A range keyword reached the matcher through a field the echo-stripper does
  // not cover. Whatever that field is, the verdict is the same: if the request
  // itself is invalid, halving the range cannot make it valid.
  const shapeRejection = Object.assign(new Error("JSON is not a valid request object."), {
    code: -32600,
    shortMessage: "JSON is not a valid request object.",
    details: "eth_getLogs block range rejected: JSON is not a valid request object.",
  });

  const { client, calls } = makeClient({ onRange: () => shapeRejection });
  await assert.rejects(() =>
    getLogsChunked(client, { fromBlock: 0n, toBlock: 679n }, 2_000n, 1),
  );
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length} (bisection amplified)`);
});

test("an auth rejection never bisects, even carrying range words", async () => {
  const authRejection = Object.assign(new Error("HTTP request failed."), {
    code: -32005,
    details: "Unauthorized: block range limit applies to paid tiers only",
  });

  const { client, calls } = makeClient({ onRange: () => authRejection });
  await assert.rejects(() =>
    getLogsChunked(client, { fromBlock: 0n, toBlock: 9_999n }, 10_000n, 1),
  );
  // The -32005 code alone would have said "too wide" — the shape check wins.
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
});

test("a provider that really does complain about the range still bisects", async () => {
  const providerComplaint = Object.assign(new Error("HTTP request failed."), {
    code: -32614,
    details: "eth_getLogs is limited to a 10,000 range",
  });
  const { client, calls } = makeClient({
    onRange: (r) => (r.end - r.start > 4n ? providerComplaint : [{ blockNumber: r.start, id: "x" }]),
  });
  const logs = await getLogsChunked(client, { fromBlock: 0n, toBlock: 9n }, 10n, 1);
  assert.ok(calls.length > 1, "should have bisected");
  assert.ok(logs.length >= 1);
});

// ============================================================
// 2026-09-29: Base の公開 RPC が eth_getLogs の上限を 10,000 → 2,000 ブロックへ
// 下げた。8,000 ブロックの chunk は毎回 8000→4000→2000 と二分され、無駄な往復が
// レート制限を呼び、wallet→agent 解決が 3 秒の予算に収まらなくなった
// （週次 benchmark-scan が 0/42、未キャッシュの有料スコアが 503）。
// ============================================================
test("providerStatedRangeLimit reads the ceiling the provider names", () => {
  const baseRpc = Object.assign(new Error("RPC Request failed."), {
    code: -32614,
    details: "eth_getLogs is limited to a 2,000 range",
  });
  assert.equal(providerStatedRangeLimit(baseRpc), 2000n);
  assert.equal(providerStatedRangeLimit(new Error("query returned more than 10000 results")), null);
  assert.equal(providerStatedRangeLimit(new Error("rate limit exceeded")), null);
});

test("a stated ceiling splits at that width directly instead of halving", async () => {
  __resetLearnedRangeCapsForTests();
  const complaint = () =>
    Object.assign(new Error("RPC Request failed."), {
      code: -32614,
      details: "eth_getLogs is limited to a 2,000 range",
    });
  const { client, calls } = makeClient({
    onRange: (r) =>
      r.end - r.start + 1n > 2000n ? complaint() : [{ blockNumber: r.start, id: `${r.start}` }],
  });
  const logs = (await getLogsChunked(client, { fromBlock: 0n, toBlock: 7999n }, 8000n, 2)) as unknown as Log[];
  // 1 rejected 8000-block call + 4 exact 2000-block calls — no 4000-block detour.
  assert.equal(calls.length, 5);
  assert.deepEqual(
    logs.map((l) => l.blockNumber),
    [0n, 2000n, 4000n, 6000n],
  );

  // The same endpoint's NEXT scan starts at the learned width: zero rejections.
  calls.length = 0;
  await getLogsChunked(client, { fromBlock: 0n, toBlock: 7999n }, 8000n, 2);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.end - c.start + 1n <= 2000n));
  __resetLearnedRangeCapsForTests();
});

test("a stated ceiling that is still too wide falls back to bisection (no loop)", async () => {
  __resetLearnedRangeCapsForTests();
  const complaint = Object.assign(new Error("RPC Request failed."), {
    code: -32614,
    details: "eth_getLogs is limited to a 8 range",
  });
  const { client, calls } = makeClient({
    onRange: (r) => (r.end - r.start > 2n ? complaint : [{ blockNumber: r.start, id: "x" }]),
  });
  const logs = (await getLogsChunked(client, { fromBlock: 0n, toBlock: 15n }, 16n, 1)) as unknown as Log[];
  assert.ok(calls.length < 40, `bounded call count, got ${calls.length}`);
  const covered = new Set<bigint>();
  for (const c of calls) {
    if (c.end - c.start <= 2n) for (let b = c.start; b <= c.end; b++) covered.add(b);
  }
  assert.equal(covered.size, 16);
  assert.ok(logs.length >= 1);
  __resetLearnedRangeCapsForTests();
});

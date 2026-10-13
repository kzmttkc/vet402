// ============================================================
// vet402 — eth_getLogs の読み先の切り替え（2026-10-13）。
//
// 10/8 に Base の公開 RPC が eth_getLogs だけを断り始め（HTTP 429・-32011
// "request limit reached"。1 ブロックの範囲でも同じ）、読み先が 1 つしか無かったので
// index-feedback・index-owners・index-settlements の checkpoint が 5 日止まった。
// ここが固定すること:
//   1. 答えない読み先は飛ばされ、次の読み先の答えがそのまま返る
//   2. 飛ばした読み先は一定時間だけ後回し（毎回の無駄な往復を払わない）で、時間が切れたら先頭に戻る
//   3. 「範囲が広すぎる」は読み先を替えずに呼び手へ返す（割って聞き直すのは chunked-logs）
//   4. 全部の読み先が断ったら、何も返さず投げる（空の答えを作らない）
//   5. 範囲の上限を error.data に書く読み先でも、その幅で割って全範囲を 1 回ずつ読む
// エラーの形は 10/13 に viem 2.55.1 で実際に取れたもの（下の makeBaseRefusal / makeTenderlyTooWide）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetLearnedRangeCapsForTests,
  getLogsChunked,
  isRangeTooWideError,
  isRateLimitError,
  providerStatedRangeLimit,
} from "@/lib/chain/chunked-logs";
import {
  __resetLogScanFailoverForTests,
  getLogsWithFailover,
  invalidLogScanFallbackEntries,
  LOG_SCAN_ENDPOINT_COOLDOWN_MS,
  logScanFallbackRpcUrls,
  type LogScanEndpoint,
} from "@/lib/chain/log-scan-failover";
import { DeadlineExceededError } from "@/lib/util/deadline";

type Args = { fromBlock: bigint; toBlock: bigint };
type Log = { blockNumber: bigint; from: string };

/** mainnet.base.org が 10/8 から eth_getLogs に返す形（viem の RpcRequestError）。 */
function makeBaseRefusal(): Error {
  return Object.assign(new Error("RPC Request failed.\n\nURL: https://rpc.example\nRequest body: {\"method\":\"eth_getLogs\"}\n\nDetails: request limit reached\nVersion: viem@2.55.1"), {
    name: "RpcRequestError",
    code: -32011,
    details: "request limit reached",
    shortMessage: "RPC Request failed.",
  });
}

/** Tenderly の公開 gateway が 1,000 ブロックを超える範囲に返す形（上限は cause.data にしか無い）。 */
function makeTenderlyTooWide(): Error {
  return Object.assign(
    new Error("Invalid parameters were provided to the RPC method.\nDouble check you have provided the correct parameters."),
    {
      name: "InvalidParamsRpcError",
      code: -32602,
      details: "invalid params",
      shortMessage:
        "Invalid parameters were provided to the RPC method.\nDouble check you have provided the correct parameters.",
      cause: {
        name: "RpcRequestError",
        code: -32602,
        details: "invalid params",
        shortMessage: "RPC Request failed.",
        data: "Block range too large for public access: maximum 1000 blocks. Try with this block range [0x31ea286, 0x31ea66e], or use an access key for larger ranges.",
      },
    },
  );
}

function makeRateLimit(): Error {
  return Object.assign(new Error("RPC Request failed."), { code: -32005, details: "rate limit exceeded" });
}

function endpoint(
  key: string,
  behave: (args: Args) => Log[] | Error,
): LogScanEndpoint<Args, Log[]> & { calls: Args[] } {
  const calls: Args[] = [];
  return {
    key,
    label: key,
    calls,
    async getLogs(args: Args) {
      calls.push(args);
      const out = behave(args);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

const oneLogFrom = (name: string) => (args: Args) => [{ blockNumber: args.fromBlock, from: name }];

test("the real error shapes classify the way the failover relies on", () => {
  // -32011 は rate-limit でも range でもない: 待っても割っても直らなかった（10/13 実測）。
  assert.equal(isRateLimitError(makeBaseRefusal()), false);
  assert.equal(isRangeTooWideError(makeBaseRefusal()), false);
  // data にしか無い「範囲が広すぎる」を読めること。読めないと走査ごと落ちる。
  assert.equal(isRangeTooWideError(makeTenderlyTooWide()), true);
  assert.equal(providerStatedRangeLimit(makeTenderlyTooWide()), 1000n);
  assert.equal(isRateLimitError(makeRateLimit()), true);
});

test("providerStatedRangeLimit reads the other phrasings measured on 10/13", () => {
  const withDetails = (details: string) => Object.assign(new Error("RPC Request failed."), { details });
  assert.equal(
    providerStatedRangeLimit(withDetails("Block range too large: maximum allowed is 50 blocks on your current plan.")),
    50n,
  );
  assert.equal(
    providerStatedRangeLimit(withDetails("You can make eth_getLogs requests with up to a 10 block range.")),
    10n,
  );
  // 文字列でない data（revert の戻り値など）は読まない。
  assert.equal(providerStatedRangeLimit(Object.assign(new Error("x"), { data: { maximum: "1000 blocks" } })), null);
});

test("an endpoint that refuses eth_getLogs is skipped and the next endpoint's answer is returned as is", async () => {
  __resetLogScanFailoverForTests();
  const primary = endpoint("primary", makeBaseRefusal);
  const fallback = endpoint("fallback", oneLogFrom("fallback"));
  const logs = await getLogsWithFailover([primary, fallback], { fromBlock: 5n, toBlock: 9n });
  assert.deepEqual(logs, [{ blockNumber: 5n, from: "fallback" }]);
  assert.equal(primary.calls.length, 1);
  assert.equal(fallback.calls.length, 1);
});

test("a refused endpoint goes to the back for the cooldown, then is tried first again", async () => {
  __resetLogScanFailoverForTests();
  let t = 1_000_000;
  let primaryHealthy = false;
  const primary = endpoint("primary", (a) => (primaryHealthy ? oneLogFrom("primary")(a) : makeBaseRefusal()));
  const fallback = endpoint("fallback", oneLogFrom("fallback"));
  const eps = [primary, fallback];
  const ask = () => getLogsWithFailover(eps, { fromBlock: 1n, toBlock: 1n }, () => t);

  await ask(); // primary を 1 回試して断られる
  await ask();
  await ask();
  // 後回しの間は、主の読み先に無駄な往復を払わない。
  assert.equal(primary.calls.length, 1);
  assert.equal(fallback.calls.length, 3);

  // 期限が切れたら先頭に戻る。直っていれば、そのまま元の読み先に戻る。
  t += LOG_SCAN_ENDPOINT_COOLDOWN_MS + 1;
  primaryHealthy = true;
  const logs = await ask();
  assert.deepEqual(logs, [{ blockNumber: 1n, from: "primary" }]);
  assert.equal(fallback.calls.length, 3);
});

test("a cooled-down endpoint is still asked when every other endpoint fails", async () => {
  __resetLogScanFailoverForTests();
  const t = 5_000;
  let primaryHealthy = false;
  let fallbackHealthy = true;
  const primary = endpoint("primary", (a) => (primaryHealthy ? oneLogFrom("primary")(a) : makeBaseRefusal()));
  const fallback = endpoint("fallback", (a) => (fallbackHealthy ? oneLogFrom("fallback")(a) : new Error("fetch failed")));
  const ask = () => getLogsWithFailover([primary, fallback], { fromBlock: 1n, toBlock: 1n }, () => t);
  await ask(); // primary は後回しに
  primaryHealthy = true;
  fallbackHealthy = false;
  const logs = await ask();
  assert.deepEqual(logs, [{ blockNumber: 1n, from: "primary" }]);
});

test("a range-too-wide answer is handed back without switching endpoints", async () => {
  __resetLogScanFailoverForTests();
  const first = endpoint("first", makeTenderlyTooWide);
  const second = endpoint("second", oneLogFrom("second"));
  await assert.rejects(
    getLogsWithFailover([first, second], { fromBlock: 0n, toBlock: 7999n }),
    (e: unknown) => isRangeTooWideError(e),
  );
  // 2 番目に聞いていない: 範囲を割るのは呼び手（fetchRange）で、同じ読み先に聞き直す。
  assert.equal(second.calls.length, 0);
  // 後回しにもしていない。
  await assert.rejects(getLogsWithFailover([first, second], { fromBlock: 0n, toBlock: 7999n }));
  assert.equal(first.calls.length, 2);
});

test("a deadline is the caller's, not the endpoint's: no switch", async () => {
  __resetLogScanFailoverForTests();
  const first = endpoint("first", () => new DeadlineExceededError("getLogsChunked", 2500));
  const second = endpoint("second", oneLogFrom("second"));
  await assert.rejects(
    getLogsWithFailover([first, second], { fromBlock: 0n, toBlock: 1n }),
    DeadlineExceededError,
  );
  assert.equal(second.calls.length, 0);
});

test("when every endpoint fails nothing is returned, and a rate-limit error is the one thrown", async () => {
  __resetLogScanFailoverForTests();
  const primary = endpoint("primary", makeBaseRefusal);
  const fallback = endpoint("fallback", makeRateLimit);
  await assert.rejects(
    getLogsWithFailover([primary, fallback], { fromBlock: 0n, toBlock: 1n }),
    // rate-limit を投げる = fetchRange の backoff に乗る（待てば通る種類の失敗が 1 つでもあるとき）。
    (e: unknown) => isRateLimitError(e),
  );

  __resetLogScanFailoverForTests();
  const a = endpoint("a", makeBaseRefusal);
  const b = endpoint("b", () => new Error("fetch failed"));
  await assert.rejects(
    getLogsWithFailover([a, b], { fromBlock: 0n, toBlock: 1n }),
    (e: unknown) => (e as { code?: number }).code === -32011,
  );
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
});

test("a rate-limited endpoint is not cooled down", async () => {
  __resetLogScanFailoverForTests();
  let limited = true;
  const first = endpoint("first", (a) => (limited ? makeRateLimit() : oneLogFrom("first")(a)));
  const second = endpoint("second", oneLogFrom("second"));
  assert.deepEqual(await getLogsWithFailover([first, second], { fromBlock: 1n, toBlock: 1n }), [
    { blockNumber: 1n, from: "second" },
  ]);
  limited = false;
  // 次の呼び出しは、また先頭から。
  assert.deepEqual(await getLogsWithFailover([first, second], { fromBlock: 2n, toBlock: 2n }), [
    { blockNumber: 2n, from: "first" },
  ]);
});

test("a single endpoint behaves exactly as before (its own error, no wrapping)", async () => {
  __resetLogScanFailoverForTests();
  const only = endpoint("only", makeBaseRefusal);
  await assert.rejects(
    getLogsWithFailover([only], { fromBlock: 0n, toBlock: 1n }),
    (e: unknown) => (e as { code?: number }).code === -32011,
  );
});

test("10/8 の形: 主が getLogs を断り、予備が 1,000 ブロックまで → 全範囲を 1 回ずつ、欠けなく読む", async () => {
  __resetLearnedRangeCapsForTests();
  __resetLogScanFailoverForTests();
  const primary = endpoint("primary", makeBaseRefusal);
  const fallback = endpoint("fallback", (a) =>
    a.toBlock - a.fromBlock + 1n > 1000n ? makeTenderlyTooWide() : [{ blockNumber: a.fromBlock, from: "fallback" }],
  );
  const client = {
    chain: { id: 8453 },
    transport: { url: "https://primary.example" },
    getLogs: (args: Args) => getLogsWithFailover([primary, fallback], args),
  } as unknown as Parameters<typeof getLogsChunked>[0];

  // 本番の設定と同じ 8,000 ブロックの chunk で、20,000 ブロック。
  const logs = (await getLogsChunked(client, { fromBlock: 0n, toBlock: 19_999n }, 8000n, 4)) as unknown as Log[];

  const served = fallback.calls.filter((c) => c.toBlock - c.fromBlock + 1n <= 1000n);
  // 0..19999 を 1,000 ブロックずつ、重複も穴もなく。
  const starts = served.map((c) => c.fromBlock).sort((x, y) => Number(x - y));
  assert.deepEqual(starts, Array.from({ length: 20 }, (_, i) => BigInt(i * 1000)));
  assert.ok(served.every((c) => c.toBlock === c.fromBlock + 999n));
  assert.equal(logs.length, 20);
  assert.deepEqual(logs.map((l) => l.blockNumber), starts); // 昇順のまま
  // 主の読み先への無駄な往復は、並列の最初の一斉（4 本）まで。以後は後回し。
  assert.ok(primary.calls.length <= 4, `primary was asked ${primary.calls.length} times`);

  // 同じ読み先の次の走査は、最初から 1,000 ブロック幅（断られる往復 0）。
  fallback.calls.length = 0;
  await getLogsChunked(client, { fromBlock: 0n, toBlock: 7999n }, 8000n, 4);
  assert.equal(fallback.calls.length, 8);
  assert.ok(fallback.calls.every((c) => c.toBlock - c.fromBlock + 1n <= 1000n));
  __resetLearnedRangeCapsForTests();
});

test("10/8〜10/13 の形: 読み先が 1 つで getLogs を断る → 走査は 1 件も返さず落ちる（空の答えにしない）", async () => {
  __resetLearnedRangeCapsForTests();
  __resetLogScanFailoverForTests();
  const primary = endpoint("primary", makeBaseRefusal);
  const client = {
    chain: { id: 8453 },
    transport: { url: "https://primary-only.example" },
    getLogs: (args: Args) => getLogsWithFailover([primary], args),
  } as unknown as Parameters<typeof getLogsChunked>[0];
  await assert.rejects(
    getLogsChunked(client, { fromBlock: 0n, toBlock: 7999n }, 8000n, 1),
    (e: unknown) => (e as { code?: number }).code === -32011,
  );
  // 割っても待っても直らない断り方なので、bisect も backoff もしない（1 回で諦める）。
  assert.equal(primary.calls.length, 1);
});

test("LOG_SCAN_FALLBACK_RPC_URLS: unset/none/off/empty = no fallback (no third party is added by default), a list = that list in order", () => {
  assert.deepEqual(logScanFallbackRpcUrls({}), []);
  assert.deepEqual(logScanFallbackRpcUrls({ LOG_SCAN_FALLBACK_RPC_URLS: "" }), []);
  assert.deepEqual(logScanFallbackRpcUrls({ LOG_SCAN_FALLBACK_RPC_URLS: " none " }), []);
  assert.deepEqual(logScanFallbackRpcUrls({ LOG_SCAN_FALLBACK_RPC_URLS: "OFF" }), []);
  const env = {
    LOG_SCAN_FALLBACK_RPC_URLS: " https://a.example/v2/key , not-a-url, ftp://c.example, https://b.example ,https://a.example/v2/key",
  };
  assert.deepEqual(logScanFallbackRpcUrls(env), ["https://a.example/v2/key", "https://b.example"]);
  // 捨てた項目は数だけ分かる（値は鍵を含みうるので返さない）。
  assert.equal(invalidLogScanFallbackEntries(env), 2);
  assert.equal(invalidLogScanFallbackEntries({}), 0);
  assert.equal(invalidLogScanFallbackEntries({ LOG_SCAN_FALLBACK_RPC_URLS: "none" }), 0);
});

test("getIndexerPublicClient: with no fallback configured it is the plain primary client; with one, only getLogs is wrapped", async () => {
  const { getIndexerPublicClient } = await import("@/lib/chain/client");
  const saved = { ...process.env };
  try {
    process.env.INDEXER_RPC_URL = "https://primary.example";
    delete process.env.LOG_SCAN_FALLBACK_RPC_URLS;
    const plain = getIndexerPublicClient();
    assert.equal((plain.transport as { url?: string }).url, "https://primary.example");

    // 予備が主と同じ URL なら、予備なしと同じ。
    process.env.LOG_SCAN_FALLBACK_RPC_URLS = "https://primary.example";
    const same = getIndexerPublicClient();
    assert.equal(same.getLogs.toString(), plain.getLogs.toString());

    process.env.LOG_SCAN_FALLBACK_RPC_URLS = "https://fallback.example";
    const wrapped = getIndexerPublicClient();
    // 学んだ範囲の上限の鍵（chain + transport.url）は主の読み先のまま。
    assert.equal((wrapped.transport as { url?: string }).url, "https://primary.example");
    assert.equal(wrapped.chain.id, 8453);
    assert.notEqual(wrapped.getLogs.toString(), plain.getLogs.toString());
    // getLogs 以外は主の client の関数そのまま。
    assert.equal(wrapped.getBlockNumber.toString(), plain.getBlockNumber.toString());
  } finally {
    for (const key of ["INDEXER_RPC_URL", "LOG_SCAN_FALLBACK_RPC_URLS"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("production config names a malformed fallback entry as a warning (never an error: a fallback must not stop production)", async () => {
  const { collectProductionEnvIssues } = await import("@/lib/config/production-env");
  const saved = process.env.LOG_SCAN_FALLBACK_RPC_URLS;
  const savedAppEnv = process.env.APP_ENV;
  const about = () => collectProductionEnvIssues().filter((i) => i.message.includes("LOG_SCAN_FALLBACK_RPC_URLS"));
  try {
    // collectProductionEnvIssues は APP_ENV=production のときだけ調べる。
    process.env.APP_ENV = "production";
    for (const value of ["https://a.example, nope , ftp://c.example", "https://a.example", "none", ""]) {
      process.env.LOG_SCAN_FALLBACK_RPC_URLS = value;
      const issues = about();
      const expected = invalidLogScanFallbackEntries({ LOG_SCAN_FALLBACK_RPC_URLS: value });
      // config の数え方と、読み先を組む側の数え方が同じ。
      assert.equal(issues.length, expected > 0 ? 1 : 0, `value=${JSON.stringify(value)}`);
      if (expected > 0) {
        assert.equal(issues[0]!.level, "warn");
        assert.ok(issues[0]!.message.includes(` ${expected} `));
        // 値（鍵を含みうる）は文に出さない。
        assert.ok(!issues[0]!.message.includes("example"));
      }
    }
  } finally {
    if (saved === undefined) delete process.env.LOG_SCAN_FALLBACK_RPC_URLS;
    else process.env.LOG_SCAN_FALLBACK_RPC_URLS = saved;
    if (savedAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedAppEnv;
  }
});

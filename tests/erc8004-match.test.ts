// ============================================================
// ERC-8004 段階 A の読み手（2026-11-08）。偽の DB で readErc8004Match の配線を固定する。
// 完全一致そのものは SQL の側（tests/erc8004-match.pg.test.ts で実 DB）。ここでは
//   1. 一致の行が owner として要約に入り、数が合う
//   2. 同じ payTo を持つ agent が複数でも購入は 1 回だけ数える
//   3. 失敗は unavailable・数を持たない・DB の文言を外に出さない・キャッシュに残らない
//   4. 索引の到達点が読めない時も unavailable（0 を出さない）
//   5. 数は SQL が数えた全件、一覧は上位だけ（行を全部運ばない）
//   6. キャッシュの包み: 成功は readAt つき・失敗は保存しない
//   7. state API は既存のキーを保ったまま erc8004 を足し、成功の経路でも ok の形を出す
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { __setDbForTests } from "@/lib/db/client";
import {
  readErc8004Match,
  ERC8004_MATCH_SQL,
  makeErc8004CachedReader,
  __setErc8004CacheForTests,
  type Erc8004MatchSummary,
} from "@/lib/observatory/erc8004-match";

after(() => {
  __setDbForTests(null);
  __setErc8004CacheForTests(null);
});

/** 素通しの包み（tsx の中には incrementalCache が無いので unstable_cache の代わり）。 */
const passThrough = (<T,>(fn: T) => fn) as unknown as Parameters<typeof makeErc8004CachedReader>[0];

const OWNER = `0x${"ab".repeat(20)}`;

type MatchRow = { match_kind: string; agent_id: string; pay_to: string; purchases: number; settled: number };

/** SQL が返す 1 行を、渡した行から作る（数は SQL と同じく payTo ごとに 1 回）。 */
function sqlRow(rows: MatchRow[], walletRows: number, totals?: Record<string, number>) {
  const perPayTo = new Map(rows.map((r) => [r.pay_to, r]));
  return {
    scanned_agents: "1123563",
    wallet_rows: walletRows,
    matched_agents: totals?.matched_agents ?? new Set(rows.map((r) => r.agent_id)).size,
    matched_pay_to: totals?.matched_pay_to ?? perPayTo.size,
    matched_purchases: totals?.matched_purchases ?? [...perPayTo.values()].reduce((a, r) => a + r.purchases, 0),
    matched_settled: totals?.matched_settled ?? [...perPayTo.values()].reduce((a, r) => a + r.settled, 0),
    top: rows,
  };
}

function fakeDb(opts: { checkpoint: bigint | null; matchRows?: MatchRow[]; walletRows?: number; fail?: boolean; totals?: Record<string, number> }) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (opts.checkpoint === null ? [] : [{ lastBlock: opts.checkpoint }]) }),
      }),
    }),
    execute: async (q: unknown) => {
      if (opts.fail) throw new Error("connect ECONNREFUSED db.internal.example:5432");
      const text = JSON.stringify(q);
      if (text.includes("scanned_agents") && text.includes("owner_agents oa")) {
        return { rows: [sqlRow(opts.matchRows ?? [], opts.walletRows ?? 0, opts.totals)] };
      }
      // 2026-11-10（要件 3.10）: Ethereum・BNB Chain の索引。ここでは一度も走っていない形（到達点なし）。
      if (text.includes("erc8004_chain_agents")) {
        return { rows: [{ ...sqlRow([], 0), index_block: null, scanned_agents: "0" }] };
      }
      throw new Error(`unexpected query ${text.slice(0, 80)}`);
    },
  };
}

test("an owner match comes through as matchKind owner with its counts", async () => {
  __setDbForTests(
    fakeDb({
      checkpoint: 53_900_000n,
      matchRows: [{ match_kind: "owner", agent_id: "42", pay_to: OWNER, purchases: 12, settled: 9 }],
    }),
  );
  const s = await readErc8004Match();
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.scannedAgents, 1_123_563);
  assert.equal(s.byChain["eip155:8453"].indexBlock, "53900000");
  assert.deepEqual(s.matches, [
    { agentId: "42", chainId: "eip155:8453", payTo: OWNER, matchKind: "owner", purchases: 12, settled: 9 },
  ]);
  assert.equal(s.matchedPurchases, 12);
  assert.equal(s.matchedSettled, 9);
  assert.ok(s.notes.includes("agent_wallet index empty"));
});

test("one payTo owning several agents counts its purchases once", async () => {
  __setDbForTests(
    fakeDb({
      checkpoint: 1n,
      walletRows: 3,
      matchRows: [
        { match_kind: "owner", agent_id: "1", pay_to: OWNER, purchases: 20, settled: 15 },
        { match_kind: "owner", agent_id: "2", pay_to: OWNER, purchases: 20, settled: 15 },
        { match_kind: "agent_wallet", agent_id: "3", pay_to: OWNER, purchases: 20, settled: 15 },
      ],
    }),
  );
  const s = await readErc8004Match();
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.matchedAgents, 3);
  assert.equal(s.matchedPayTo, 1);
  assert.equal(s.matchedPurchases, 20);
  assert.equal(s.matchedSettled, 15);
  assert.deepEqual(s.notes, [], "a populated agentWallet index is scanned, not noted");
  assert.ok(s.matches.some((m) => m.matchKind === "agent_wallet"));
});

test("a DB failure is unavailable, has no counts and does not leak the DB message", async (t) => {
  t.mock.method(console, "error", () => {});
  __setDbForTests(fakeDb({ checkpoint: 1n, fail: true }));
  const s = await readErc8004Match();
  assert.equal(s.status, "unavailable");
  assert.equal("matchedAgents" in s, false);
  assert.equal("matches" in s, false);
  assert.equal(JSON.stringify(s).includes("db.internal.example"), false);
});

test("an unreadable owner index checkpoint is unavailable, never 0", async () => {
  __setDbForTests(fakeDb({ checkpoint: null }));
  const s = await readErc8004Match();
  assert.equal(s.status, "unavailable");
  assert.equal("scannedAgents" in s, false);
});

test("counts come from the SQL totals, the list is only the top rows", async () => {
  __setDbForTests(
    fakeDb({
      checkpoint: 1n,
      matchRows: [{ match_kind: "owner", agent_id: "5", pay_to: OWNER, purchases: 3, settled: 1 }],
      totals: { matched_agents: 4321, matched_pay_to: 321, matched_purchases: 98765, matched_settled: 54321 },
    }),
  );
  const s = await readErc8004Match();
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.matchedAgents, 4321);
  assert.equal(s.byChain["eip155:8453"].matchedAgents, 4321);
  assert.equal(s.matchedPayTo, 321);
  assert.equal(s.matchedPurchases, 98765);
  assert.equal(s.matchedSettled, 54321);
  assert.equal(s.matches.length, 1);
});

test("the match SQL is one round trip that limits the listed rows to 200", () => {
  assert.match(ERC8004_MATCH_SQL, /LIMIT 200\b/);
  assert.match(ERC8004_MATCH_SQL, /json_agg/);
  assert.match(ERC8004_MATCH_SQL, /count\(DISTINCT agent_id\) FROM m/);
  assert.match(ERC8004_MATCH_SQL, /FROM paid WHERE pay_to IN \(SELECT pay_to FROM m\)/, "purchases are summed once per payTo");
});

test("cached reader: ok gets readAt, a failure is not stored and the next read retries", async () => {
  const store = new Map<string, unknown>();
  // unstable_cache と同じく、解決した値だけを保存し、投げた時は保存しない包み。
  const storing = ((fn: () => Promise<unknown>, keys: string[]) => async () => {
    const k = keys.join("|");
    if (store.has(k)) return store.get(k);
    const v = await fn();
    store.set(k, v);
    return v;
  }) as unknown as Parameters<typeof makeErc8004CachedReader>[0];

  const ok: Erc8004MatchSummary = {
    status: "ok", checkedAt: "2026-11-08T00:00:00.000Z", scannedAgents: 1, matchedAgents: 0, matchedPayTo: 0,
    matchedPurchases: 0, matchedSettled: 0,
    byChain: {
      "eip155:8453": { status: "scanned", scannedAgents: 1, matchedAgents: 0, indexBlock: "1" },
      "eip155:1": { status: "unavailable", reason: "index_not_started" },
      "eip155:56": { status: "unavailable", reason: "index_not_started" },
    },
    matches: [], notes: [],
  };
  const answers: Erc8004MatchSummary[] = [{ status: "unavailable", checkedAt: "2026-11-08T00:00:00.000Z", reason: "query_failed" }, ok];
  let calls = 0;
  const read = makeErc8004CachedReader(storing, async () => answers[calls++]);

  const first = await read();
  assert.equal(first.status, "unavailable");
  assert.equal(first.readAt, "2026-11-08T00:00:00.000Z");
  assert.equal(store.size, 0, "a failure is not stored");

  const second = await read();
  assert.equal(second.status, "ok");
  assert.equal(second.readAt, ok.checkedAt);
  assert.equal(calls, 2, "the read after a failure went to the database again");

  await read();
  assert.equal(calls, 2, "an ok read is served from the cache");
});

test("cached reader: a broken cache wrapper is unavailable with a fixed reason", async (t) => {
  t.mock.method(console, "error", () => {});
  const broken = (() => async () => {
    throw new Error("Invariant: incrementalCache missing");
  }) as unknown as Parameters<typeof makeErc8004CachedReader>[0];
  const r = await makeErc8004CachedReader(broken, async () => {
    throw new Error("not reached");
  })();
  assert.equal(r.status, "unavailable");
  if (r.status !== "unavailable") return;
  assert.equal(r.reason, "query_failed");
});

test("the cached read keeps no catch inside the cache and uses PUBLIC_READ_REVALIDATE", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/lib/observatory/erc8004-match.ts", "utf8");
  const inner = src.slice(src.indexOf("const inner = cache("), src.indexOf("/** 公開の集計と同じ窓で載せる"));
  assert.match(inner, /if \(summary\.status !== "ok"\) throw/);
  assert.doesNotMatch(inner, /\bcatch\b/, "no catch inside unstable_cache");
  assert.match(inner, /PUBLIC_READ_REVALIDATE/);
});

test("the match SQL compares the indexed side without lower() so the index is used", () => {
  assert.match(ERC8004_MATCH_SQL, /JOIN owner_agents oa ON oa\.owner = paid\.pay_to/);
  assert.match(ERC8004_MATCH_SQL, /JOIN agents a ON a\.wallet = paid\.pay_to AND a\.chain_id = 8453/);
});

test("state API keeps every existing key and adds erc8004", async (t) => {
  // tsx の中では unstable_cache が incrementalCache missing で投げ、unavailable に倒れる（想定どおり）。
  t.mock.method(console, "error", () => {});
  __setDbForTests(null);
  __setErc8004CacheForTests(null);
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state", { headers: { "x-forwarded-for": "203.0.113.80" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  // 2026-11-08 変更前のトップレベルのキー（本番 /api/v1/observatory/state から写した）。
  const before = [
    "activeEndpoints", "byChain", "byChainScope", "byChainTestnetEndpoints", "byChainUnclassified", "catalogSnapshots",
    "cdpBazaarIngestStale", "cdpBazaarLastStrongPassAt", "cite", "coverage7d", "delistedEndpoints", "disclaimer",
    "eventCounts", "humanReadable", "l1", "l1Rates", "latestSnapshot", "license", "licenseUrl", "methodUndeclared",
    "methodology", "operatorEndpointsExcluded", "operatorExclusionConfigured", "publishedFail", "publishedPass",
    "publishedPassActive", "publishedPassActiveProbeOlderThan7d", "publishedUnverified", "retrievedAt",
    "spendingHalted", "totalEndpoints", "withdrawnFail",
  ];
  for (const k of before) assert.ok(k in body, `${k} must stay`);
  assert.ok(body.erc8004, "erc8004 present");
  assert.equal(typeof body.erc8004.status, "string");
  assert.equal(typeof body.erc8004.readAt, "string");
  assert.match(body.erc8004.about, /counts once/);
  assert.doesNotMatch(body.erc8004.about, /[—–;]|\bwe\b/i);
  if (body.erc8004.status === "unavailable") assert.equal("matchedAgents" in body.erc8004, false);
});

test("state API publishes the ok shape with readAt and about when the read succeeds", async () => {
  // 偽の DB は erc8004 の読みにだけ渡す（他の集計の読み手は DB が無い時の空の形に倒れる）。
  const fake = fakeDb({
    checkpoint: 54_462_269n,
    matchRows: [{ match_kind: "owner", agent_id: "94639", pay_to: OWNER, purchases: 552, settled: 455 }],
  });
  const summary = await makeErc8004CachedReader(passThrough, async () => {
    __setDbForTests(fake);
    try {
      return await readErc8004Match();
    } finally {
      __setDbForTests(null);
    }
  })();
  assert.equal(summary.status, "ok");

  const { GET } = await import("@/app/api/v1/observatory/state/route");
  // route を通す: 包みを「上で読んだ ok を返す」ものにして、route の組み立てを確かめる。
  __setErc8004CacheForTests((() => async () => summary) as unknown as Parameters<typeof makeErc8004CachedReader>[0]);
  let body;
  try {
    const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state", { headers: { "x-forwarded-for": "203.0.113.81" } }));
    assert.equal(res.status, 200);
    body = await res.json();
  } finally {
    __setErc8004CacheForTests(null);
  }
  assert.equal(body.erc8004.status, "ok");
  assert.equal(body.erc8004.readAt, summary.readAt);
  assert.equal(body.erc8004.matchedPurchases, 552);
  assert.equal(body.erc8004.byChain["eip155:8453"].indexBlock, "54462269");
  assert.deepEqual(body.erc8004.byChain["eip155:1"], { status: "unavailable", reason: "index_not_started" });
  assert.match(body.erc8004.about, /counts once/);
});

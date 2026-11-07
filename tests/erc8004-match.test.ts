// ============================================================
// ERC-8004 段階 A の読み手（2026-11-08）。偽の DB で readErc8004Match の配線を固定する。
// 完全一致そのものは SQL の側（tests/erc8004-match.pg.test.ts で実 DB）。ここでは
//   1. 一致の行が owner として要約に入り、数が合う
//   2. 同じ payTo を持つ agent が複数でも購入は 1 回だけ数える
//   3. 失敗は unavailable・数を持たない・DB の文言を外に出さない・キャッシュに残らない
//   4. 索引の到達点が読めない時も unavailable（0 を出さない）
//   5. state API は既存のキーを保ったまま erc8004 を足す
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { __setDbForTests } from "@/lib/db/client";
import { readErc8004Match, ERC8004_MATCH_SQL } from "@/lib/observatory/erc8004-match";

after(() => __setDbForTests(null));

const OWNER = `0x${"ab".repeat(20)}`;

function fakeDb(opts: { checkpoint: bigint | null; matchRows?: Record<string, unknown>[]; walletRows?: number; fail?: boolean }) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (opts.checkpoint === null ? [] : [{ lastBlock: opts.checkpoint }]) }),
      }),
    }),
    execute: async (q: unknown) => {
      if (opts.fail) throw new Error("connect ECONNREFUSED db.internal.example:5432");
      const text = JSON.stringify(q);
      if (text.includes("scanned_agents")) return { rows: [{ scanned_agents: "1123563", wallet_rows: opts.walletRows ?? 0 }] };
      if (text.includes("owner_agents oa")) return { rows: opts.matchRows ?? [] };
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

test("the cached read does not keep a failure: unavailable is thrown out of unstable_cache", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/lib/observatory/erc8004-match.ts", "utf8");
  const inner = src.slice(src.indexOf("const readErc8004MatchCachedInner = unstable_cache("), src.indexOf("export async function getErc8004MatchCached"));
  assert.match(inner, /if \(summary\.status !== "ok"\) throw/);
  assert.doesNotMatch(inner, /\bcatch\b/, "no catch inside unstable_cache");
  assert.match(inner, /PUBLIC_READ_REVALIDATE/);
});

test("the match SQL compares the indexed side without lower() so the index is used", () => {
  assert.match(ERC8004_MATCH_SQL, /JOIN owner_agents oa ON oa\.owner = paid\.pay_to/);
  assert.match(ERC8004_MATCH_SQL, /JOIN agents a ON a\.wallet = paid\.pay_to AND a\.chain_id = 8453/);
});

test("state API keeps every existing key and adds erc8004", async () => {
  __setDbForTests(null);
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

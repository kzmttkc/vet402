// ============================================================
// ERC-8004 段階 A の合格の表（2026-11-08・Claude が先に固定。実装はこの表を緑にする）。
// 数えるのは、購入の payTo と Base の ERC-8004 agent の持ち主（または agentWallet）の
// アドレスの完全一致だけ。読めなかった時は 0 を出さない。索引の無いチェーンは not_indexed。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeErc8004Match, ERC8004_MATCH_SQL } from "@/lib/observatory/erc8004-match";

const A = `0x${"aa".repeat(20)}`;
const B = `0x${"bb".repeat(20)}`;

test("ERC-8004 A: counts distinct agents and payTo, sums purchases and settled", () => {
  const s = summarizeErc8004Match({
    checkedAt: "2026-11-08T00:00:00.000Z",
    scannedAgents: 1_123_563,
    indexBlock: "53900000",
    ownerMatches: [
      { agentId: "7", payTo: A.toUpperCase().replace("0X", "0x"), purchases: 10, settled: 8 },
      { agentId: "9", payTo: A, purchases: 2, settled: 1 },
      { agentId: "9", payTo: B, purchases: 5, settled: 5 },
    ],
    walletMatches: null,
  });
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.matchedAgents, 2);
  assert.equal(s.matchedPayTo, 2);
  assert.equal(s.matchedPurchases, 17);
  assert.equal(s.matchedSettled, 14);
  assert.equal(s.scannedAgents, 1_123_563);
  assert.equal(s.checkedAt, "2026-11-08T00:00:00.000Z");
  assert.equal(s.byChain["eip155:8453"].status, "scanned");
  assert.equal(s.byChain["eip155:1"].status, "not_indexed");
  assert.equal(s.byChain["eip155:56"].status, "not_indexed");
  assert.equal("matchedAgents" in s.byChain["eip155:1"], false, "a chain that is not indexed carries no count");
  for (const m of s.matches) {
    assert.equal(m.payTo, m.payTo.toLowerCase());
    assert.equal(m.chainId, "eip155:8453");
    assert.ok(m.matchKind === "owner" || m.matchKind === "agent_wallet");
  }
  assert.deepEqual(s.matches.map((m) => m.purchases), [10, 5, 2], "sorted by purchases, largest first");
});

test("ERC-8004 A: an empty agentWallet index is a note, not a scanned zero", () => {
  const s = summarizeErc8004Match({ checkedAt: "2026-11-08T00:00:00.000Z", scannedAgents: 5, indexBlock: "1", ownerMatches: [], walletMatches: null });
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.ok(s.notes.includes("agent_wallet index empty"));
  assert.equal(s.matchedAgents, 0);
});

test("ERC-8004 A: a failed read is unavailable and carries no counts", () => {
  const s = summarizeErc8004Match({ checkedAt: "2026-11-08T00:00:00.000Z", error: "connection refused" });
  assert.equal(s.status, "unavailable");
  for (const k of ["matchedAgents", "matchedPayTo", "matchedPurchases", "scannedAgents", "matches"]) {
    assert.equal(k in s, false, `${k} must be absent when the read failed`);
  }
});

test("ERC-8004 A: at most 200 matches are listed", () => {
  const ownerMatches = Array.from({ length: 250 }, (_, i) => ({ agentId: String(i), payTo: `0x${i.toString(16).padStart(40, "0")}`, purchases: i + 1, settled: 0 }));
  const s = summarizeErc8004Match({ checkedAt: "2026-11-08T00:00:00.000Z", scannedAgents: 250, indexBlock: "1", ownerMatches, walletMatches: [] });
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.matches.length, 200);
  assert.equal(s.matchedAgents, 250, "the counts cover every match, not only the listed 200");
});

test("ERC-8004 A: the match query is exact address equality, never a near match", () => {
  const q = ERC8004_MATCH_SQL.toLowerCase();
  assert.ok(q.includes("owner_agents"));
  assert.ok(q.includes("x402_l1_purchases"));
  for (const bad of [" like ", " ilike ", "similarity", "levenshtein", "%"]) assert.equal(q.includes(bad), false, `query must not use ${bad.trim()}`);
});

test("ERC-8004 A: the state API publishes erc8004 and export.csv does not change", () => {
  const state = readFileSync("src/app/api/v1/observatory/state/route.ts", "utf8");
  assert.ok(state.includes("erc8004"));
  const exportRoute = readFileSync("src/app/api/v1/observatory/export.csv/route.ts", "utf8");
  assert.equal(exportRoute.includes("erc8004"), false);
});

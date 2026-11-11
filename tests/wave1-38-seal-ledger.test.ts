// ============================================================
// 第 1 波 3.8 と 3.8b の合格試験（DB なし。npm test で走る分）。
// 合格テストの文は ~/Takeshi_Automation/output/1110/factory/specs_3.7_3.8_9a_3.4.md の 3.8 と 3.8b。
//
// DB の行を通す試験（辿れる tx の一覧、state の 2 段、anchors の遅れと穴、probe402 の数、
// 訂正の self と third_party）は tests/wave1-38-seal-ledger.pg.test.ts にある。CI は
// test:db でそれを毎回走らせる。ここは DB が無くても見られる入口だけを見る。
//
// [fix] はこの枝の変更が無いと落ちる行。[guard] は main で既に満たしていて、退行を止める行。
// 公開の入口が無いときは import の例外ではなく、その名前を出して落とす。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { formatSettledReceipt } from "@/lib/observatory/home-example";
import { settledTier } from "@/lib/observatory/settled-tier";

async function entry<T>(path: string): Promise<T> {
  try {
    return (await import(path)) as T;
  } catch (error) {
    assert.fail(`public entry missing: ${path} (${(error as Error).message.split("\n")[0]})`);
  }
}

type TierCheck = { ok: boolean; reason?: string };
type Validate = (l1: unknown) => TierCheck;

// 11/09 の state の一次（合格テストの文の「一次の取得」）。
const L1_1109 = { settled: 14427, settledNonceBound: 12498, settledAmountPayeeOnly: 1929 };

test("[fix] 3.8-6a-1: the two settled tiers pass only as two numbers that sum to settled", async () => {
  const { validateL1SettledTwoTier } = await entry<{ validateL1SettledTwoTier: Validate }>("@/lib/observatory/settled-two-tier");
  assert.equal(validateL1SettledTwoTier(L1_1109).ok, true);
  const { settledNonceBound: _b, ...noBound } = L1_1109;
  const { settledAmountPayeeOnly: _w, ...noWeak } = L1_1109;
  assert.equal(validateL1SettledTwoTier(noBound).reason, "nonce_bound_missing");
  assert.equal(validateL1SettledTwoTier(noWeak).reason, "amount_payee_only_missing");
  assert.equal(validateL1SettledTwoTier({ settled: 14427 }).ok, false, "one settled number alone fails");
  assert.equal(
    validateL1SettledTwoTier({ ...L1_1109, settledNonceBound: 14427 }).reason,
    "tier_sum_ne_settled",
    "lifting 1,929 into the bound tier fails",
  );
  assert.equal(validateL1SettledTwoTier({ settled: 0 }).ok, false, "an empty ledger still names both tiers");
  assert.equal(validateL1SettledTwoTier({ settled: 0, settledNonceBound: 0, settledAmountPayeeOnly: 0 }).ok, true);
});

test("[fix] 3.8-6a-1: the state GET checks the tiers before it answers 200", () => {
  const src = readFileSync("src/app/api/v1/observatory/state/route.ts", "utf8");
  const check = src.indexOf("validateL1SettledTwoTier(stats.l1)");
  assert.ok(check > 0, "state route calls the tier check on stats.l1");
  const answer = src.indexOf("return NextResponse.json(\n      {\n        ...stats,");
  assert.ok(answer > check, "the check runs before the 200 body");
  assert.match(src.slice(check, answer), /status: 503/);
});

test("[guard] 3.8-6a-1 and 3.8b-3: a Stellar settled row is amount_payee_only even with a nonce", () => {
  assert.equal(
    settledTier({ status: "settled", settlementVerified: true, authNonce: "0xabc", network: "stellar:pubnet" }),
    "amount_payee_only",
  );
  assert.equal(settledTier({ status: "settled", settlementVerified: true, authNonce: "0xabc", network: "eip155:8453" }), "nonce_bound");
});

test("[fix] 3.8b-2: the traceable chains are the ten public names, without Robinhood, Polygon or Monad", async () => {
  const { traceablePublicChains } = await entry<{ traceablePublicChains: () => { label: string; network: string }[] }>(
    "@/lib/observatory/chains",
  );
  assert.equal(typeof traceablePublicChains, "function", "chains.ts exports traceablePublicChains");
  assert.deepEqual(
    traceablePublicChains().map((c) => c.label).sort(),
    ["Arbitrum One", "Arc", "Avalanche C-Chain", "BNB Chain", "Base", "Celo", "Solana", "Stellar", "Tempo", "XRPL"],
  );
  const networks = traceablePublicChains().map((c) => c.network);
  assert.ok(!networks.includes("eip155:4663"));
});

test("[fix] 3.8b: with no database the traceable route answers 503, not an invented list", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { GET } = await entry<{ GET: (r: NextRequest) => Promise<Response> }>("@/app/api/v1/observatory/traceable-by-chain/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/observatory/traceable-by-chain"));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "observatory_unavailable");
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("[guard] 3.8b-4: a Gateway row with only a batch tx is not a home grade receipt", () => {
  const row = {
    attempted_at: "2026-11-08T12:02:00Z",
    resource_key: "gw.example/api",
    network: "eip155:5042",
    spent_units: "10000",
    tx_hash: "",
    gateway_batch_tx: `0x${"ba".repeat(32)}`,
    settlement_source: "circle_gateway",
    id: "gw-1",
  };
  assert.equal(formatSettledReceipt(row, { rows: 1, settled: 1, from: "", to: "" }), null);
});

test("[fix] 3.8b-4: the traceable query leaves out Circle Gateway rows even when tx_hash is filled", () => {
  const src = readFileSync("src/lib/observatory/traceable-by-chain.ts", "utf8");
  assert.match(src, /IS DISTINCT FROM 'circle_gateway'/);
  assert.doesNotMatch(src, /coalesce\([^)]*batchTx/i, "the batch tx is never read into tx");
});

test("[fix] 3.8 money: a new anchor send stops before it is signed or sent", async () => {
  const { gateAnchorOnchainSend } = await entry<{
    gateAnchorOnchainSend: (i: unknown, o?: unknown) => { status: string; reason: string };
  }>("@/lib/observatory/anchor-onchain-send");
  const intent = { day: "2026-11-09", rootHash: "0".repeat(64), entryCount: 1, chainTarget: "evm" };
  const prev = process.env.ANCHOR_WRITES_ENABLED;
  try {
    delete process.env.ANCHOR_WRITES_ENABLED;
    assert.equal(gateAnchorOnchainSend(intent, { ownerApproved: true, documentedSpendCapUsd: "1" }).reason, "writes_disabled");
    process.env.ANCHOR_WRITES_ENABLED = "true";
    assert.equal(gateAnchorOnchainSend(intent).reason, "documented_spend_cap_missing");
    for (const ownerApproved of [false, true]) {
      const r = gateAnchorOnchainSend(intent, { ownerApproved, documentedSpendCapUsd: "1" });
      assert.equal(r.status, "stopped");
      assert.equal(r.reason, "owner_approval_required");
    }
  } finally {
    if (prev === undefined) delete process.env.ANCHOR_WRITES_ENABLED;
    else process.env.ANCHOR_WRITES_ENABLED = prev;
  }
  const src = readFileSync("src/lib/observatory/anchor-onchain-send.ts", "utf8");
  assert.doesNotMatch(src, /sendTransaction|sendRawTransaction|writeContract|signTransaction|privateKey|createWalletClient|fetch\(/);
  assert.doesNotMatch(src, /would_send/);
});

test("[fix] 3.8b: the public docs for the traceable route follow the public English rules", () => {
  const forbidden = /\b(we|our|us)\b|—|–|;|Key-less|in-house|Append-only|third-party/i;
  const docs = readFileSync("src/app/docs/api/page.tsx", "utf8");
  const i = docs.indexOf('path: "/api/v1/observatory/traceable-by-chain"');
  assert.ok(i > 0, "docs page lists the route");
  assert.doesNotMatch(/note: "([^"]*)"/.exec(docs.slice(i))![1], forbidden);
  const spec = readFileSync("docs/openapi.yaml", "utf8");
  const a = spec.indexOf("  /api/v1/observatory/traceable-by-chain:");
  assert.ok(a > 0, "openapi lists the route");
  assert.doesNotMatch(spec.slice(a, spec.indexOf("\n  /api/", a + 10)), forbidden);
  for (const gone of ["/api/v1/observatory/daily-head", "/api/v1/observatory/proposed-corrections"]) {
    assert.ok(!spec.includes(`  ${gone}:`), `${gone} is not a second copy of the anchors and ledger-corrections routes`);
  }
});

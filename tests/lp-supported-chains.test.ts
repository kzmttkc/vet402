// ============================================================
// LP §5 "Chains" (2026-09-19).
//
// The section states, per chain, whether vet402 buys there. Two ways for it to go
// wrong: a static word outliving the ledger (the 2026-08-13 "probed daily" shape),
// and a chain name that does not join to `stats.l1.byChain`, which would print
// "0 settled" next to a chain that has thousands. Both are pinned here.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LANE_STATE_SENTENCE,
  SUPPORTED_CHAINS,
  effectiveLaneState,
  laneBody,
  type LaneChain,
} from "@/components/site/supported-chains-data";
import { chainLabel } from "@/lib/observatory/chains";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const lanes = SUPPORTED_CHAINS.filter((c): c is LaneChain => c.kind === "lane");

test("the section lists the six chains, in order", () => {
  assert.deepEqual(
    SUPPORTED_CHAINS.map((c) => c.chain),
    ["Base", "Solana", "Tempo", "XRPL", "Arc", "Robinhood Chain (4663, mainnet)"],
  );
});

test("every lane name is the chainLabel() of its mainnet id — the join key into l1.byChain", () => {
  const ids: Record<string, string> = {
    Base: "eip155:8453",
    Solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    Tempo: "eip155:4217",
    XRPL: "xrpl:0",
    Arc: "eip155:5042",
  };
  for (const lane of lanes) {
    assert.ok(ids[lane.chain], `no mainnet id pinned for ${lane.chain}`);
    assert.equal(chainLabel(ids[lane.chain]), lane.chain);
  }
});

test("the ledger overrules the static word in both directions", () => {
  // unreadable ledger: the static word stands
  assert.equal(effectiveLaneState("pending_first_purchase", null), "pending_first_purchase");
  assert.equal(effectiveLaneState("running", null), "running");
  // a settled purchase exists: a pending lane stops reading pending
  assert.equal(effectiveLaneState("pending_first_purchase", 1), "settled_on_record");
  assert.equal(effectiveLaneState("running", 3396), "running");
  assert.equal(effectiveLaneState("settled_on_record", 8), "settled_on_record");
  // none exists: no lane reads as running
  assert.equal(effectiveLaneState("running", 0), "pending_first_purchase");
  assert.equal(effectiveLaneState("settled_on_record", 0), "pending_first_purchase");
});

test("lane copy names the asset and the rail; Tempo says it is not x402", () => {
  const byName = new Map(lanes.map((l) => [l.chain, l]));
  assert.equal(
    laneBody(byName.get("Base")!, null),
    `USDC over x402. ${LANE_STATE_SENTENCE.running}`,
  );
  assert.equal(
    laneBody(byName.get("Tempo")!, null),
    `USDC.e over MPP, not x402. ${LANE_STATE_SENTENCE.settled_on_record}`,
  );
  assert.equal(
    laneBody(byName.get("XRPL")!, null),
    `RLUSD over x402, through the t54 facilitator. ${LANE_STATE_SENTENCE.settled_on_record}`,
  );
  assert.equal(
    laneBody(byName.get("Arc")!, null),
    `USDC over x402. ${LANE_STATE_SENTENCE.pending_first_purchase}`,
  );
});

test("the Robinhood Chain row carries the agreed sentence and nothing else", () => {
  const row = SUPPORTED_CHAINS.find((c) => c.kind === "building");
  assert.ok(row && row.kind === "building");
  const text = row.body.map((p) => (typeof p === "string" ? p : p.code)).join("");
  assert.equal(
    text,
    "vet402 /rwa, which reconstructs Stock Token holdings and trade history from public chain data, is being implemented. The purchase lane and the settlement index are not supported.",
  );
  // 日本語の原文（申し合わせ）が正典としてファイルに残っていること
  const src = read("src/components/site/supported-chains-data.ts");
  assert.ok(src.includes("Robinhood Chain（4663・本番網）: Stock Token の保有と取引履歴を公開チェーンデータから"));
  assert.ok(src.includes("再構成する `vet402 /rwa` を実装中。購入レーンと決済索引は未対応"));
  for (const banned of [/open house/i, /ethonline/i, /\bsafe/i, /recommend/i, /yield/i, /deposit/i, /winning/i]) {
    assert.ok(!banned.test(`${row.chain} ${text}`), `Robinhood row must not say ${banned}`);
  }
});

test("no static count in the section copy — counts come from stats.l1.byChain", () => {
  const data = read("src/components/site/supported-chains-data.ts");
  const copy = [
    ...Object.values(LANE_STATE_SENTENCE),
    ...lanes.map((l) => `${l.asset} ${l.rail}`),
  ].join(" ");
  assert.ok(!/\d{2,}/.test(copy.replace(/x402|t54/g, "")), "no multi-digit number in lane copy");
  assert.ok(data.includes("ARC-SWAP"), "the Arc swap line stays marked");
  const home = read("src/app/page.tsx");
  assert.ok(home.includes("stats.l1.byChain.map((c) => [c.chain, c.settled])"));
  assert.ok(home.includes('id="chains"'));
});

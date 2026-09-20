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
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  LANE_STATE_SENTENCE,
  SUPPORTED_CHAINS,
  chainsLegend,
  effectiveLaneState,
  laneBody,
  markerOf,
  settledByChainOf,
  settledCountOf,
  type LaneChain,
} from "@/components/site/supported-chains-data";
import { SupportedChains } from "@/components/site/SupportedChains";
import { chainLabel, toCaip2 } from "@/lib/observatory/chains";

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

test("a testnet id never joins a mainnet lane", () => {
  assert.notEqual(chainLabel("eip155:5042002"), "Arc");
  assert.notEqual(chainLabel("eip155:42431"), "Tempo");
  assert.notEqual(chainLabel("xrpl:1"), "XRPL");
  // the reader folds through toCaip2 first; that must not move a testnet onto a mainnet label either
  assert.notEqual(chainLabel(toCaip2("arc-testnet")), "Arc");
  assert.notEqual(chainLabel(toCaip2("solana-devnet")), "Solana");
  // and the v1 slugs the ledger may carry do land on the lane
  assert.equal(chainLabel(toCaip2("base")), "Base");
  assert.equal(chainLabel(toCaip2("solana")), "Solana");
  assert.equal(chainLabel(toCaip2("xrpl")), "XRPL");
});

test("the ledger overrules the static word in both directions", () => {
  // unreadable ledger: the static word stands
  assert.equal(effectiveLaneState("pending_first_purchase", null), "pending_first_purchase");
  assert.equal(effectiveLaneState("settled_on_record", null), "settled_on_record");
  // a settled purchase exists: a pending lane stops reading pending
  assert.equal(effectiveLaneState("pending_first_purchase", 1), "settled_on_record");
  assert.equal(effectiveLaneState("settled_on_record", 8), "settled_on_record");
  // a readable ledger holds none: the lane stops claiming settled purchases
  assert.equal(effectiveLaneState("settled_on_record", 0), "pending_first_purchase");
});

test("an empty byChain is an unread ledger: no counts, no overrule (review C1)", () => {
  // reader.ts swallows a missing-schema error on the L1 aggregate and returns byChain: [] while
  // totalEndpoints (the L0 catalog) is still > 0. That must never print "Base: 0, pending".
  for (const unread of [[], null, undefined]) {
    const map = settledByChainOf(unread);
    assert.equal(map, null);
    for (const row of SUPPORTED_CHAINS) {
      assert.equal(settledCountOf(row, map), null, `${row.chain}: no count line`);
    }
    const base = lanes.find((l) => l.chain === "Base")!;
    assert.equal(markerOf(base, settledCountOf(base, map)).label, "implemented");
    assert.equal(laneBody(base, settledCountOf(base, map)), `USDC over x402. ${LANE_STATE_SENTENCE.settled_on_record}`);
    const html = renderToStaticMarkup(createElement(SupportedChains, { settledByChain: map }));
    assert.ok(!html.includes("Settled purchases on record"), "no count line anywhere");
    assert.ok(!html.split("Solana")[0].includes(">pending<"), "the Base row is not marked pending");
  }
});

test("a readable ledger: counts per lane, absent lane is 0, same-label rows are summed", () => {
  const map = settledByChainOf([
    { chain: "Base", settled: 3000 },
    { chain: "Base", settled: 396 },
    { chain: "XRPL", settled: 1 },
  ]);
  assert.ok(map);
  const by = new Map(SUPPORTED_CHAINS.map((r) => [r.chain, r]));
  assert.equal(settledCountOf(by.get("Base")!, map), 3396);
  assert.equal(settledCountOf(by.get("XRPL")!, map), 1);
  assert.equal(settledCountOf(by.get("Arc")!, map), 0);
  assert.equal(markerOf(by.get("Arc")!, 0).label, "pending");
  assert.equal(markerOf(by.get("Arc")!, 1).label, "implemented");
  const html = renderToStaticMarkup(createElement(SupportedChains, { settledByChain: map }));
  assert.ok(html.includes("Settled purchases on record: 3,396"));
  assert.equal(html.split("Settled purchases on record").length - 1, lanes.length, "one count line per lane");
});

test("a building row stays building and prints no count, whatever the ledger holds", () => {
  const row = SUPPORTED_CHAINS.find((c) => c.kind === "building")!;
  for (const settled of [null, 0, 1, 822]) {
    assert.deepEqual(markerOf(row, settled), { label: "building", live: false });
  }
  // even a ledger row under the very same name does not give it a count
  const map = settledByChainOf([{ chain: row.chain, settled: 5 }, { chain: "Robinhood Chain", settled: 5 }]);
  assert.equal(settledCountOf(row, map), null);
  const html = renderToStaticMarkup(createElement(SupportedChains, { settledByChain: map }));
  const tail = html.slice(html.indexOf("Robinhood Chain"));
  assert.ok(!tail.includes("Settled purchases on record"));
});

test("lane copy names the asset and the rail; Tempo says it is not x402", () => {
  const byName = new Map(lanes.map((l) => [l.chain, l]));
  for (const name of ["Base", "Solana"]) {
    assert.equal(laneBody(byName.get(name)!, null), `USDC over x402. ${LANE_STATE_SENTENCE.settled_on_record}`);
  }
  // no freshness word without a freshness measurement behind it (review W1)
  for (const s of Object.values(LANE_STATE_SENTENCE)) assert.ok(!/\brunning\b/i.test(s));
  assert.equal(
    laneBody(byName.get("Tempo")!, null),
    `USDC.e over MPP, not x402. ${LANE_STATE_SENTENCE.settled_on_record}`,
  );
  assert.equal(
    laneBody(byName.get("XRPL")!, null),
    `RLUSD over x402, through the t54 facilitator. ${LANE_STATE_SENTENCE.settled_on_record}`,
  );
  // 2026-09-20: the first real Arc purchase settled and was reconciled; Arc reads like the other lanes.
  assert.equal(
    laneBody(byName.get("Arc")!, null),
    "USDC over x402. Settled and reconciled purchases are on record.",
  );
});

test("no lane starts as pending today; the state itself stays reachable from the ledger", () => {
  for (const lane of lanes) assert.equal(lane.state, "settled_on_record", lane.chain);
  // unread ledger: no row is drawn pending
  const unread = renderToStaticMarkup(createElement(SupportedChains, { settledByChain: null }));
  assert.ok(!unread.includes(">pending<"));
  // a readable ledger that holds nothing for Arc still overrules the static word
  const arc = lanes.find((l) => l.chain === "Arc")!;
  assert.equal(laneBody(arc, 0), `USDC over x402. ${LANE_STATE_SENTENCE.pending_first_purchase}`);
});

test("the legend names the pending marker only when a row is drawn pending", () => {
  const everyLane = settledByChainOf(lanes.map((l) => ({ chain: l.chain, settled: 1 })));
  assert.equal(
    chainsLegend(everyLane),
    "A lane is marked implemented when the public ledger holds a settled purchase on that chain, and building when the work has not shipped.",
  );
  for (const map of [null, everyLane]) {
    assert.ok(!/\bpending\b/.test(chainsLegend(map)));
    const html = renderToStaticMarkup(createElement(SupportedChains, { settledByChain: map }));
    assert.ok(!html.includes(">pending<"), "no pending row, so no pending in the legend");
  }
  // a readable ledger with nothing on Arc: the row is pending, and the legend says what that means
  const noArc = settledByChainOf([{ chain: "Base", settled: 2 }]);
  const html = renderToStaticMarkup(createElement(SupportedChains, { settledByChain: noArc }));
  assert.ok(html.includes(">pending<"));
  assert.equal(
    chainsLegend(noArc),
    "A lane is marked implemented when the public ledger holds a settled purchase on that chain, pending when it is built but has not bought yet, and building when the work has not shipped.",
  );
});

test("an unread ledger: the legend does not define the markers by the ledger, and says it was not read (review W1)", () => {
  // with settledByChain === null the markers come from the static states, not from the ledger
  for (const unread of [[], null, undefined]) {
    assert.equal(
      chainsLegend(settledByChainOf(unread)),
      "A lane is marked implemented when a settled purchase is on record, and building when the work has not shipped. " +
        "The public ledger could not be read for this rendering, so the markers below are the state written into this page when it was last updated and no counts are shown.",
    );
  }
  // the read shape never carries the unread sentence
  assert.ok(!chainsLegend(settledByChainOf([{ chain: "Base", settled: 2 }])).includes("could not be read"));
  // these sentences are invisible to the claims gate (no assertive term), so pin here that no
  // date or count slips into them unchecked
  for (const s of [chainsLegend(null), chainsLegend(settledByChainOf([{ chain: "Base", settled: 2 }]))]) {
    assert.ok(!/\d/.test(s), `no digit in the legend: ${s}`);
  }
});

test("the page folds the ledger once and feeds the legend and the rows from that one read", () => {
  const home = read("src/app/page.tsx");
  assert.equal(home.split("settledByChainOf(").length - 1, 1, "one fold");
  assert.ok(home.includes("{chainsLegend(settledByChain)}"));
  assert.ok(home.includes("<SupportedChains settledByChain={settledByChain} />"));
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
});

test("the contents row for the section points at the heading that exists", () => {
  const home = read("src/app/page.tsx");
  const toc = home.match(/\{ no: "5\.", title: "Chains", href: "#([a-z-]+)"/);
  assert.ok(toc, "the contents list carries a row for section 5, Chains");
  const heading = home.match(/<h2 id="([a-z-]+)" className="sec-head scroll-mt-24">\s*<span className="sec-no">5\.<\/span>\s*<span>Chains<\/span>/);
  assert.ok(heading, "section 5 has an <h2> with an id");
  assert.equal(toc[1], heading[1], "the contents href and the heading id are the same anchor");
  assert.equal(heading[1], "chains");
});

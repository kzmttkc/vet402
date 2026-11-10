// ============================================================
// #20 Robinhood Chain — 公開 EVM レーン記録（vet402-delivery roots）の取り込み。
// 正本: tests/fixtures/evm-lane/robinhood-roots.json（vet402-delivery の写し）。
//
// Run: npx tsx --test tests/evm-lane-robinhood-ingest.test.ts
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVM_LANE_ROOTS_KIND,
  evmLanePublicCountsFromRoots,
  evmLanePurchaseRecords,
  loadEvmLaneRootsJson,
  mapEvmLaneIngestRows,
  robinhoodChainLabelForByChain,
  ROBINHOOD_CAIP2,
  ingestEvmLaneRobinhood,
} from "@/lib/observatory/evm-lane-ingest";
import { chainIdentity, publicChainLabel } from "@/lib/observatory/chains";

const FIXTURE = join(__dirname, "fixtures/evm-lane/robinhood-roots.json");

test("fixture is vet402-delivery robinhood roots (lane robinhood, chain eip155:4663)", () => {
  const roots = loadEvmLaneRootsJson(FIXTURE);
  assert.equal(roots.kind, EVM_LANE_ROOTS_KIND);
  assert.equal(roots.lane, "robinhood");
  assert.equal(roots.chain, ROBINHOOD_CAIP2);
});

test("public counts match vet402-delivery data/evm/roots/robinhood.json (2026-11-10 fixture)", () => {
  const roots = loadEvmLaneRootsJson(FIXTURE);
  const counts = evmLanePublicCountsFromRoots(roots);
  assert.equal(counts.published, 14, "8 on 2026-09-30 and 6 on 2026-11-08");
  assert.equal(counts.delivered, 13);
  assert.equal(counts.settled, 13, "delivered rows with settlementTx");
});

test("ingest rows: 14 attempts, 13 settled, all network eip155:4663", () => {
  const roots = loadEvmLaneRootsJson(FIXTURE);
  const mapped = mapEvmLaneIngestRows(roots);
  assert.equal(mapped.length, 14);
  assert.equal(mapped.filter((r) => r.status === "settled").length, 13);
  assert.ok(mapped.every((r) => r.record.chain === ROBINHOOD_CAIP2));
  const recs = evmLanePurchaseRecords(roots);
  assert.equal(recs.length, 14);
});

test("byChain identity: Robinhood Chain / eip155:4663", () => {
  assert.equal(robinhoodChainLabelForByChain(), "Robinhood Chain");
  const id = chainIdentity("Robinhood Chain");
  assert.equal(id.label, publicChainLabel(ROBINHOOD_CAIP2));
  assert.equal(id.network, ROBINHOOD_CAIP2);
  assert.equal(id.chain, "Robinhood Chain");
});

test("ingest module is importable (implementation present)", () => {
  assert.equal(typeof ingestEvmLaneRobinhood, "function");
  assert.equal(readFileSync(FIXTURE, "utf8").includes("vet402-evm-purchase"), true);
});

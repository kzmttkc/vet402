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
  EVM_LANE_ENDPOINT_SOURCE,
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
import { notSellerRetestRequestSourceSql, SELLER_RETEST_REQUEST_SOURCE } from "@/lib/observatory/seller-retest-requests";
import { settlementSourceOf } from "@/lib/observatory/settlement-source";
import { settledTier } from "@/lib/observatory/settled-tier";

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

test("fixture salt is Merkle leaf noise, not EIP-3009 nonce (must not become auth_nonce)", () => {
  const roots = loadEvmLaneRootsJson(FIXTURE);
  const withSalt = evmLanePurchaseRecords(roots).filter((r) => typeof r.salt === "string" && r.salt.length > 0);
  assert.ok(withSalt.length > 0, "fixture carries salt on delivered rows");
  const settled = mapEvmLaneIngestRows(roots).filter((r) => r.status === "settled" && r.record.settlementTx);
  assert.equal(settled.length, 13);
  for (const row of settled) {
    const late =
      row.record.settlementTx && row.record.chainCheck
        ? { source: "chain_read", txHash: row.record.settlementTx, linkedAt: row.record.at }
        : null;
    assert.equal(
      settlementSourceOf({ txHash: row.record.settlementTx, lateSettlement: late }),
      "vet402_index",
      "chain-check tx is not a seller receipt",
    );
    assert.equal(
      settledTier({ status: "settled", authNonce: null, settlementVerified: true, network: row.record.chain }),
      "amount_payee_only",
      "salt must not be written as auth_nonce",
    );
  }
});

test("L0/L1 listing exclusion covers vet402_evm_lane alongside seller_retest_request", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/observatory/seller-retest-requests.ts"), "utf8");
  assert.match(src, new RegExp(EVM_LANE_ENDPOINT_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(SELLER_RETEST_REQUEST_SOURCE, EVM_LANE_ENDPOINT_SOURCE);
  assert.equal(typeof notSellerRetestRequestSourceSql, "function");
});

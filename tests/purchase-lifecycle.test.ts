// B1: 購入の段階。鎖の組み直しで取り消した行は数から消さず、取り消しの段階へ移す。
// export.csv の status は変えない。分からない行を delivered にも not_delivered にも寄せない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { e6PublicStage } from "@/lib/observatory/e6-record";
import {
  LIFECYCLE_NOTE,
  LIFECYCLE_STAGES,
  LIFECYCLE_STAGE_COPY,
  countLifecycle,
  emptyLifecycleCounts,
  lifecycleStageOf,
  openLifecycleRow,
  revokeForChainReorg,
  type LifecycleStage,
} from "@/lib/observatory/purchase-lifecycle";
import { showRow } from "@/lib/sellers/board";
import type { SellerRowFacts } from "@/lib/sellers/fix-modes";
import { toRowFacts } from "@/lib/sellers/reader";
import { mergeReorgRevokedAt, reorgInvalidationConfirmed } from "@/lib/observatory/purchase-lifecycle-write";

const AT = "2026-11-01T00:00:00Z";
const REVOKED_AT = "2026-11-02T03:04:05Z";

function deliveredRow(id: string) {
  return openLifecycleRow({
    id,
    status: "settled",
    httpStatusPaid: 200,
    txHash: "0xabc",
    payloadNonEmpty: true,
    attemptedAt: AT,
    network: "eip155:8453",
  });
}

test("B1: stage list keeps not_delivered as the same word as the trade dispute stage", () => {
  const dispute = e6PublicStage({
    purchaseId: "p",
    payer: { paymentTx: "0x1", receivedBodyHash: null, state: null },
    seller: { paymentVerified: null, deliveredBodyHash: null, deliverySignature: null },
    updatedAt: AT,
  });
  assert.equal(dispute, "not_delivered");
  assert.ok(LIFECYCLE_STAGES.includes(dispute));
  for (const stage of [
    "http_402",
    "signed",
    "settlement_claimed",
    "chain_reread",
    "delivered",
    "held",
    "not_delivered",
    "reorg_revoked",
    "unknown",
  ] as const) {
    assert.ok(LIFECYCLE_STAGES.includes(stage), stage);
    assert.equal(typeof LIFECYCLE_STAGE_COPY[stage], "string");
  }
});

test("B1: a chain reorg keeps the row, moves it to reorg_revoked, and leaves the ledger status", () => {
  const kept = deliveredRow("keep");
  const gone = deliveredRow("move");
  const before = countLifecycle([kept, gone]);
  assert.equal(before.total, 2);
  assert.equal(before.stages.delivered, 2);
  assert.equal(before.stages.reorg_revoked, 0);

  const moved = revokeForChainReorg(gone, REVOKED_AT);
  const after = countLifecycle([kept, moved]);

  assert.equal(after.total, 2, "the revoked row stays in the total");
  assert.equal(after.stages.delivered, 1);
  assert.equal(after.stages.reorg_revoked, 1);
  assert.equal(moved.status, "settled", "export.csv status is unchanged");
  assert.equal(lifecycleStageOf(moved), "reorg_revoked");
  assert.equal(moved.transitions.length, 2);
  assert.equal(moved.transitions[0]?.stage, "delivered");
  assert.equal(moved.transitions[0]?.at, AT);
  assert.equal(moved.transitions[1]?.stage, "reorg_revoked");
  assert.equal(moved.transitions[1]?.at, REVOKED_AT);
  assert.equal(countLifecycle([moved]).stages.reorg_revoked, 1);

  const again = revokeForChainReorg(moved, "2026-11-03T00:00:00Z");
  assert.equal(again.transitions.length, 2, "a second reorg does not add another row");
  assert.equal(countLifecycle([kept, again]).total, 2);
});

test("B1: unknown and held rows are not folded into delivered or not_delivered", () => {
  const cases: { status: string; httpStatusPaid: number | null; txHash?: string | null; payloadNonEmpty?: boolean | null; want: LifecycleStage }[] = [
    { status: "settled", httpStatusPaid: 200, txHash: "0xabc", payloadNonEmpty: true, want: "delivered" },
    { status: "settled", httpStatusPaid: 400, txHash: "0xabc", want: "held" },
    { status: "settled", httpStatusPaid: 202, txHash: "0xabc", payloadNonEmpty: true, want: "chain_reread" },
    { status: "settled", httpStatusPaid: 500, txHash: "0xabc", want: "not_delivered" },
    { status: "settle_claimed", httpStatusPaid: 200, txHash: "0xabc", want: "settlement_claimed" },
    { status: "settle_failed", httpStatusPaid: null, want: "signed" },
    { status: "price_mismatch", httpStatusPaid: null, want: "http_402" },
    { status: "no_402", httpStatusPaid: 200, want: "unknown" },
    { status: "in_flight", httpStatusPaid: null, want: "unknown" },
    { status: "settle_claim_refuted", httpStatusPaid: 200, txHash: "0xabc", want: "unknown" },
  ];
  for (const c of cases) {
    const stage = lifecycleStageOf({
      status: c.status,
      httpStatusPaid: c.httpStatusPaid,
      txHash: c.txHash ?? null,
      payloadNonEmpty: c.payloadNonEmpty ?? null,
      attemptedAt: AT,
      network: "eip155:8453",
    });
    assert.equal(stage, c.want, c.status);
    if (c.want !== "delivered") assert.notEqual(stage, "delivered");
    if (c.want !== "not_delivered") assert.notEqual(stage, "not_delivered");
  }
  const empty = emptyLifecycleCounts();
  assert.equal(empty.total, 0);
  assert.equal(Object.keys(empty.stages).length, LIFECYCLE_STAGES.length);
});

test("B1: public stage copy uses vet402, and has no we, semicolon, or dash", () => {
  const texts = [LIFECYCLE_NOTE, ...LIFECYCLE_STAGES.map((s) => LIFECYCLE_STAGE_COPY[s])];
  for (const text of texts) {
    assert.match(text, /vet402/);
    assert.equal(/\b(we|our|ours|us)\b/i.test(text), false, text);
    assert.equal(text.includes(";"), false, text);
    assert.equal(text.includes("—"), false, text);
    assert.equal(text.includes("–"), false, text);
  }
});

test("B1: /sellers shows the revocation stage without changing the ledger status", () => {
  const facts: SellerRowFacts = {
    endpointId: "e1",
    status: "settled",
    httpStatusPaid: 200,
    txHash: "0xabc",
    attemptedAt: AT,
    network: "eip155:8453",
    method: "GET",
    meta: { purchaseLifecycle: { reorgRevokedAt: REVOKED_AT } },
    schema: null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    payloadNonEmpty: true,
  };
  const shown = showRow(facts);
  assert.equal(shown.facts.status, "settled");
  assert.equal(shown.lifecycleStage, "reorg_revoked");
  assert.equal(shown.lifecycleAt, REVOKED_AT);
});

test("B1: the sellers reader keeps a reorg time the page stage reads, and the ledger status stays", () => {
  const facts = toRowFacts({
    endpoint_id: "e1",
    status: "settled",
    http_status_paid: 200,
    tx_hash: "0xabc",
    attempted_at: AT,
    network: "eip155:8453",
    method: "GET",
    meta_min: { requestBody: "declared" },
    payload_non_empty: true,
    reorg_revoked_at: REVOKED_AT,
  });
  assert.equal(facts.status, "settled");
  assert.equal(facts.reorgRevokedAt, REVOKED_AT);
  assert.equal(facts.meta?.requestBody, "declared");
  const shown = showRow(facts);
  assert.equal(shown.facts.status, "settled");
  assert.equal(shown.lifecycleStage, "reorg_revoked");
  assert.equal(shown.lifecycleAt, REVOKED_AT);
});

test("B1: a sellers row with no reorg time stays delivered", () => {
  const facts = toRowFacts({
    endpoint_id: "e1",
    status: "settled",
    http_status_paid: 200,
    tx_hash: "0xabc",
    attempted_at: AT,
    network: "eip155:8453",
    method: "GET",
    payload_non_empty: true,
  });
  assert.equal(facts.reorgRevokedAt ?? null, null);
  assert.equal(showRow(facts).lifecycleStage, "delivered");
});

test("B1: only two invalidating chain reads revoke, and the first time stays", () => {
  assert.equal(reorgInvalidationConfirmed("tx_not_found", "tx_reverted"), true);
  assert.equal(reorgInvalidationConfirmed("tx_reverted", "tx_not_found"), true);
  assert.equal(reorgInvalidationConfirmed("tx_not_found", "rpc_unavailable"), false);
  assert.equal(reorgInvalidationConfirmed("tx_not_found", null), false);
  assert.equal(reorgInvalidationConfirmed("no_matching_transfer", "no_matching_transfer"), false);
  assert.equal(reorgInvalidationConfirmed("wrong_chain", "wrong_chain"), false);
  const first = mergeReorgRevokedAt({ selection: "census", requestBody: "declared" }, REVOKED_AT);
  assert.equal(first.wrote, true);
  assert.equal(first.meta.selection, "census");
  assert.equal(first.meta.requestBody, "declared");
  assert.equal("status" in first.meta, false);
  const life = first.meta.purchaseLifecycle as { reorgRevokedAt?: string };
  assert.equal(life.reorgRevokedAt, REVOKED_AT);
  const again = mergeReorgRevokedAt(first.meta, "2026-11-03T00:00:00Z");
  assert.equal(again.wrote, false);
  assert.equal((again.meta.purchaseLifecycle as { reorgRevokedAt?: string }).reorgRevokedAt, REVOKED_AT);
});

test("B1: state API publishes a lifecycle count for every stage", async () => {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.lifecycle?.note, "string");
  assert.match(body.lifecycle.note, /vet402/);
  let sum = 0;
  for (const stage of LIFECYCLE_STAGES) {
    const n = body.lifecycle.stages[stage];
    assert.equal(typeof n, "number", stage);
    sum += n;
  }
  assert.equal(body.lifecycle.total, sum);
  assert.equal(body.l1.settledNonceBound + body.l1.settledAmountPayeeOnly, body.l1.settled);
});

// ============================================================
// 公開判定フィード（次波①・SPEC20 A4の資金不要版）。
// 「拒否デモ」を演出でなく台帳で示す: 日次L1が実際に下した
// 署名前拒否（price_mismatch / over_cap / 壁の不履行）と署名後の
// 決済結果を、同じ重みで1本のフィードにする。
// 固定する性質:
//  - 分類の写像が固定（refused_* / paid_settled / paid_no_settlement）
//  - 我々側の都合（budget_denied / request_error / in_flight）は含めない
//  - 並びは新しい順・境界日数は飽和
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decisions feed (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("decision feed mapping", async () => {
    const { getDecisionFeed } = await import("@/lib/observatory/decisions");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);

    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "d.example/api", resourceUrl: "https://d.example/api", network: "eip155:8453", method: "GET" })
      .returning();
    const buy = (status: string, spent: string, hoursAgo: number, tx?: string) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id, status, spentUnits: spent, txHash: tx ?? null,
        amountUnits: "3000",
        attemptedAt: new Date(Date.now() - hoursAgo * 3600_000),
      });
    await buy("price_mismatch", "0", 5);
    await buy("over_cap", "0", 4);
    await buy("no_402", "0", 3);
    await buy("settled", "3000", 2, "0xabc");
    await buy("settle_failed", "2000", 1);
    await buy("budget_denied", "0", 1); // 我々側の都合 → 出さない
    await buy("in_flight", "1000", 0.5); // 進行中 → 出さない

    const feed = await getDecisionFeed(30);
    assert.equal(feed.rows.length, 5);
    const kinds = feed.rows.map((r) => r.decision);
    // 新しい順
    assert.deepEqual(kinds, [
      "paid_no_settlement",
      "paid_settled",
      "refused_wall_unpayable",
      "refused_over_cap",
      "refused_price_mismatch",
    ]);
    assert.equal(feed.totals.refused, 3);
    assert.equal(feed.totals.paidSettled, 1);
    assert.equal(feed.totals.paidNoSettlement, 1);
    const settledRow = feed.rows.find((r) => r.decision === "paid_settled")!;
    assert.equal(settledRow.txHash, "0xabc");
    assert.ok(feed.definition.includes("budget_denied"), "除外規則を定義文に同梱");
  });
}

// ------------------------------------------------------------
// 2026-09-04 外部監査 E・P0-4: /decisions の見出しは "last 30 days" と書いて
// いたが、totals は LIMIT 200 で切った行を数えていた。30 日に 200 件を超える
// 判定があると、見出しの数は「直近 200 件の内訳」であって窓の集計ではない。
// /impact §3 の「In the last 30 days vet402 refused N」も同じ feed を読む。
// 合計は行の表示件数から独立させ、窓全体を SQL で数える。
// ------------------------------------------------------------
import { decisionTotalsFromStatusCounts } from "@/lib/observatory/decisions";

test("合計は status ごとの件数から組み、表示行数に依存しない", () => {
  const totals = decisionTotalsFromStatusCounts([
    { status: "price_mismatch", n: 120 },
    { status: "payto_mismatch", n: 3 },
    { status: "payto_operator_self", n: 1 },
    { status: "over_cap", n: 40 },
    { status: "no_402", n: 7 },
    { status: "no_eligible_accept", n: 9 },
    { status: "settled", n: 900 },
    { status: "settle_failed", n: 700 },
    { status: "delivered_no_receipt", n: 12 },
  ]);
  assert.deepEqual(totals, {
    refused: 120 + 3 + 1 + 40 + 7 + 9,
    paidSettled: 900,
    paidNoSettlement: 700,
    paidNoReceipt: 12,
  });
});

test("表示上限（200 行）を超える件数でも合計はそのまま出る", () => {
  const totals = decisionTotalsFromStatusCounts([{ status: "over_cap", n: 5_000 }]);
  assert.equal(totals.refused, 5_000);
});

test("写像に無い status は合計のどれにも入れない（黙って refused に混ぜない）", () => {
  const totals = decisionTotalsFromStatusCounts([
    { status: "budget_denied", n: 50 },
    { status: "in_flight", n: 4 },
    { status: "settled", n: 2 },
  ]);
  assert.deepEqual(totals, { refused: 0, paidSettled: 2, paidNoSettlement: 0, paidNoReceipt: 0 });
});

test("claim 系（未検証・反証・不正形式）は settled にも no_settlement にも数えない", () => {
  const totals = decisionTotalsFromStatusCounts([
    { status: "settle_claimed", n: 43 },
    { status: "settle_claim_refuted", n: 2 },
    { status: "settle_claimed_unverifiable", n: 1 },
  ]);
  assert.deepEqual(totals, { refused: 0, paidSettled: 0, paidNoSettlement: 0, paidNoReceipt: 0 });
});

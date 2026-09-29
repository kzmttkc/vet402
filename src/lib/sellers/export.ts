// ============================================================
// /sellers の区分を 1 出品 1 行で持ち出す公開 export（2026-09-29 監査 5 周目・データ記者の立場）。
//
// /sellers は「delivered / seller's side / vet402's side / not sorted …」の件数を出していたが、その元データ
// （どの出品の最新の行が、どの区分に振られたか）は公開の export に無く、数え直せなかった。ここは
// board.ts の buildSellerBoard と**同じ入力・同じ分類関数**（classifySellerRow・failureDaysOf）で行を作るだけで、
// 分類の規則は持たない（fix-modes.ts が正典。ここで変えない）。
//
// 1 行 = Base の掲載中の出品（active・代表 network が Base）1 つ。購入の行が無い出品も not_tried として出すので、
// 行を outcome で数えると /sellers の見出しの件数（delivered・pending・seller・vet402・unsorted・notPaid・notTried）と
// 同じになる（tests/sellers-export.test.ts が固定）。
// 純関数（DB 無し）。DB から読むのは reader.ts の readSellerExport。
// ============================================================
import { failureDaysOf, type FailureDays, type LatestRow } from "./board";
import { classifySellerRow, NOT_IN_EXPORT_STATUSES, sideLabelOf } from "./fix-modes";

export const SELLER_EXPORT_COLUMNS = [
  "host",
  "endpoint_id",
  "resource_key",
  "outcome",
  "fix_mode",
  "side_label",
  "confirmed_seller",
  "held_reason",
  "latest_attempted_at",
  "latest_status",
  "latest_network",
  "latest_http_status_paid",
  "purchase_id",
  "in_ledger_export",
] as const;

export type SellerExportColumn = (typeof SELLER_EXPORT_COLUMNS)[number];

/** outcome の値。buildSellerBoard の OutcomeCounts の鍵と 1 対 1（not_bought = notPaid・not_tried = notTried）。 */
export const SELLER_EXPORT_OUTCOMES = ["delivered", "pending", "seller", "vet402", "unsorted", "not_bought", "not_tried"] as const;
export type SellerExportOutcome = (typeof SELLER_EXPORT_OUTCOMES)[number];

export type SellerExportRow = Record<SellerExportColumn, string>;

/** Base の掲載中の出品 1 つ（購入の有無を問わない）。 */
export interface SellerListingRef {
  endpointId: string;
  resourceKey: string;
  host: string;
}

/**
 * listings: Base の掲載中の出品すべて。latest: 購入のある出品の最新行（出品ごとに 1 行・rowId 付き）。
 * days: reader が読んだ、seller の側の候補になった失敗の日付（board と同じ材料）。
 * 並びは host → resource_key → endpoint_id。
 */
export function buildSellerExportRows(
  listings: readonly SellerListingRef[],
  latest: readonly (LatestRow & { rowId?: string })[],
  days?: FailureDays,
): SellerExportRow[] {
  // board.ts の mergeDays と同じ: reader の読んだ日付と手元の行の日付の和。
  const allDays = new Map<string, Set<string>>();
  if (days) for (const [k, v] of days) allDays.set(k, new Set(v));
  failureDaysOf(latest, allDays);

  const byEndpoint = new Map<string, LatestRow & { rowId?: string }>();
  for (const r of latest) byEndpoint.set(r.endpointId, r);

  const out: SellerExportRow[] = [];
  for (const l of listings) {
    const r = byEndpoint.get(l.endpointId);
    if (!r) {
      out.push({
        host: l.host,
        endpoint_id: l.endpointId,
        resource_key: l.resourceKey,
        outcome: "not_tried",
        fix_mode: "",
        side_label: "",
        confirmed_seller: "",
        held_reason: "",
        latest_attempted_at: "",
        latest_status: "",
        latest_network: "",
        latest_http_status_paid: "",
        purchase_id: "",
        in_ledger_export: "",
      });
      continue;
    }
    const c = classifySellerRow(r, { sellerFailureDays: allDays.get(r.endpointId) });
    const inExport = !NOT_IN_EXPORT_STATUSES.has(r.status);
    out.push({
      host: l.host,
      endpoint_id: l.endpointId,
      resource_key: l.resourceKey,
      outcome: c.bucket,
      fix_mode: c.mode?.key ?? "",
      side_label: c.mode ? sideLabelOf(c.mode) : "",
      confirmed_seller: c.bucket === "seller" ? String(c.confirmedSeller) : "",
      held_reason: c.held ?? "",
      latest_attempted_at: r.attemptedAt,
      latest_status: r.status,
      latest_network: r.network ?? "",
      latest_http_status_paid: r.httpStatusPaid === null ? "" : String(r.httpStatusPaid),
      purchase_id: r.rowId ?? "",
      in_ledger_export: String(inExport),
    });
  }
  out.sort(
    (a, b) =>
      a.host.localeCompare(b.host) || a.resource_key.localeCompare(b.resource_key) || a.endpoint_id.localeCompare(b.endpoint_id),
  );
  return out;
}

/** outcome ごとの行数（/sellers の見出しと突き合わせる用）。 */
export function countSellerExportOutcomes(rows: readonly SellerExportRow[]): Record<SellerExportOutcome, number> {
  const n = Object.fromEntries(SELLER_EXPORT_OUTCOMES.map((o) => [o, 0])) as Record<SellerExportOutcome, number>;
  for (const r of rows) {
    if ((SELLER_EXPORT_OUTCOMES as readonly string[]).includes(r.outcome)) n[r.outcome as SellerExportOutcome]++;
  }
  return n;
}

/**
 * CSV はコメント行を持てないので、列の定義をレスポンスヘッダで運ぶ（ASCII のみ）。
 */
export const SELLER_EXPORT_COLUMN_NOTES =
  "One row per active Base listing (the rows /sellers counts), classified by its latest purchase row with the same function /sellers uses. " +
  "outcome = delivered | pending (settle_claimed, awaiting on-chain re-read) | seller (seller's side) | vet402 (vet402's side) | unsorted (not sorted yet) | " +
  "not_bought (tried, vet402 did not sign) | not_tried (no purchase row); counting rows by outcome gives the /sellers totals. " +
  "fix_mode = the failure kind key (blank for delivered, pending, not_tried); side_label = the words of the /sellers 'whose side' column; " +
  "confirmed_seller = true when a seller's-side failure was seen on 2 or more UTC days (blank unless outcome=seller); " +
  "held_reason = as in /api/v1/observatory/export.csv; purchase_id = the latest row's id (the purchase_id column of the ledger export and the subject_id in /api/v1/observatory/corrections); " +
  "in_ledger_export = whether that row appears in /api/v1/observatory/export.csv (rows in vet402-side states such as halted or request_error do not). " +
  "Full definitions: https://vet402.com/openapi.yaml";

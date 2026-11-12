/**
 * Read the decision store and return a CSV of purchases recorded there.
 * The header uses the same column names in the same order as
 * GET /api/v1/observatory/export.csv.
 * vet402 does not receive this CSV.
 * A row is not labeled settled, because vet402 has not read the transfer again on chain.
 */
import { type DecisionStoreOptions } from "./pay-or-refuse.js";
/**
 * 公開 `/api/v1/observatory/export.csv` の凍結列（export-columns.ts と同じ名前と順番）。
 * ここから足さない。12/12 より前の凍結を超えない。
 */
export declare const LOCAL_PURCHASE_EXPORT_COLUMNS: readonly ["attempted_at", "resource_key", "network", "status", "amount_units", "spent_units", "tx_hash", "http_status_paid", "latency_ms", "l2_schema", "held_reason", "request_body", "request_body_sha256", "settlement_source", "request_query", "request_query_sha256", "confirmed_units", "purchase_id", "l2_reading"];
/**
 * 同じ DecisionStore を読む。ファイルは足さない。通信もしない。
 * 店がまだ無いときは見出しだけを返す。
 */
export declare function exportLocalPurchaseCsv(options?: DecisionStoreOptions): Promise<string>;

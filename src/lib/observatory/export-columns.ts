// ============================================================
// 公開 export（/api/v1/observatory/export.csv）の列の正典。
//
// 列位置で読む利用者を壊さないため、**追加は末尾だけ**・既存列の名前と順序と意味は変えない。
// route ファイルは Next.js の規約で HTTP メソッド以外を export できないので、列の一覧はここに置き、
// テスト（tests/export-request-body.test.ts）が「足した列は openapi・methodology・llms.txt にも
// 名前で出ている」を同じ配列から検査する。
// ============================================================

/** 2026-09-17 まで（held_reason は 2026-09-17 の追加）。 */
const COLUMNS_UNTIL_2026_09_17 = [
  "attempted_at",
  "resource_key",
  "network",
  "status",
  "amount_units",
  "spent_units",
  "tx_hash",
  "http_status_paid",
  "latency_ms",
  "l2_schema",
  "held_reason",
] as const;

/**
 * 2026-09-20 の追加。
 *   request_body        有料の要求がどんな本文で出たか（request-body.ts）
 *   request_body_sha256  宣言本文を送った行の、送ったバイト列の SHA-256（本文そのものは出さない）
 *   settlement_source    その行の tx を名指したのが売り手か vet402 の索引か（settlement-source.ts）
 */
export const EXPORT_CSV_COLUMNS_SINCE_2026_09_20 = ["request_body", "request_body_sha256", "settlement_source"] as const;

export const EXPORT_CSV_COLUMNS = [...COLUMNS_UNTIL_2026_09_17, ...EXPORT_CSV_COLUMNS_SINCE_2026_09_20] as const;

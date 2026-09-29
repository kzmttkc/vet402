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

/**
 * 2026-09-21 の追加（本文の 2 列と同じ形で、宣言クエリの側）。
 *   request_query         有料の要求がどの URL で出たか: declared / empty / refused（request-query.ts）
 *   request_query_sha256  宣言クエリを足した行の、足した対の form-urlencoded 文字列の SHA-256
 *                         （文字列そのものは出さない）
 */
export const EXPORT_CSV_COLUMNS_SINCE_2026_09_21 = ["request_query", "request_query_sha256"] as const;

/**
 * 2026-09-29 の追加（敵対的監査 4 周目）。
 *   confirmed_units  vet402 がチェーン上で送金を確かめた額（USDC の最小単位）。settled の行は spent_units と同じ、
 *                    それ以外の行は 0。**spent_units は署名した額（賭けた額）で、動いた額ではない**——tx の無い
 *                    settle_failed にも価格と同じ額が入る。その意味は変えず、動いた額を別の列で出す。
 *                    規則は confirmedUnitsSql（下）。
 *   purchase_id      その行の購入の id（UUID・監査 5 周目）。/api/v1/observatory/corrections の subject_id
 *                    （subject_type = purchase）と同じ値で、訂正ログの行と export の行を結ぶ鍵。id は購入ごとに
 *                    DB が振る乱数で、払い手・売り手・金額を何も含まない（公開してよい値）。
 */
export const EXPORT_CSV_COLUMNS_SINCE_2026_09_29 = ["confirmed_units", "purchase_id"] as const;

/**
 * 2026-09-29 の追加（監査 7 周目）。
 *   l2_reading  l2_schema を今の読み方で読み直した値（l2-check.ts l2ReadingOf・記録頁と判定の facts.l2 と同じ関数）。
 *               古い行の 16,000 バイトで切れた本文は not_checked、閉じていない JSON は mismatch のまま等。l2_schema
 *               （記録したときの値）は台帳の互換のため変えない。
 */
export const EXPORT_CSV_COLUMNS_SINCE_2026_09_29_B = ["l2_reading"] as const;

/** 列を足したら openapi・methodology・llms.txt の説明にも名前で出す（tests/export-request-body.test.ts）。 */
export const EXPORT_CSV_COLUMNS_ADDED = [
  ...EXPORT_CSV_COLUMNS_SINCE_2026_09_20,
  ...EXPORT_CSV_COLUMNS_SINCE_2026_09_21,
  ...EXPORT_CSV_COLUMNS_SINCE_2026_09_29,
  ...EXPORT_CSV_COLUMNS_SINCE_2026_09_29_B,
] as const;

export const EXPORT_CSV_COLUMNS = [...COLUMNS_UNTIL_2026_09_17, ...EXPORT_CSV_COLUMNS_ADDED] as const;

/**
 * `confirmed_units` の SQL 式。settled（vet402 が送金をチェーン上で再読した）行だけが spent_units を持ち、
 * それ以外は '0'——settle_claimed（照合待ち）も 0 で、照合が済んで settled になった時点で額が入る。
 * 0 は「確かめた送金が無い」であって「送金が無かったと確かめた」ではない。
 */
export function confirmedUnitsSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`confirmedUnitsSql: bad alias ${JSON.stringify(alias)}`);
  return `CASE WHEN ${alias}.status = 'settled' THEN coalesce(${alias}.spent_units::text, '0') ELSE '0' END`;
}

/**
 * CSV はコメント行を持てないので、取り違えやすい 2 列の意味をレスポンスヘッダで運ぶ（ASCII のみ）。
 */
export const EXPORT_CSV_COLUMN_NOTES =
  "spent_units = USDC base units vet402 signed for on the attempt (what it put at stake), not units shown to have moved; " +
  "confirmed_units = units vet402 re-read on-chain as transferred (spent_units on settled rows, 0 on every other row, " +
  "including settle_claimed rows awaiting re-read); " +
  "purchase_id = the purchase's id, the subject_id of its rows in /api/v1/observatory/corrections; " +
  "l2_reading = l2_schema read again with today's rules (the value the record page and the decision use; l2_schema keeps the value recorded at the time). Full column definitions: https://vet402.com/openapi.yaml";

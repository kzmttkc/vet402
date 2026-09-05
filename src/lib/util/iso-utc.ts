// ============================================================
// Postgres の `timestamptz::text`（"2026-09-04 19:02:29.789686+00"）を
// ISO8601 UTC（"2026-09-04T19:02:29.789Z"）へ直す 1 関数（2026-09-05）。
//
// WHY: 鮮度の時刻は機械が読んで**そのまま人の目に出す**（payOrRefuse は
// last_attempt_at を拒否理由の文面に載せる）。Postgres の text 表現は
// ISO8601 ではないので、そのまま渡すと受け手ごとに解釈が割れる。
// 読めない値を捏造しない: パースできなければ null を返す（"Invalid Date" を
// 文字列にして出さない）。
// ============================================================
export function toIsoUtc(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

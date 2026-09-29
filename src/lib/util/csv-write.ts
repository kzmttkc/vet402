// ============================================================
// 公開 CSV の書き出し（RFC 4180 の引用）。購入台帳の export.csv と同じ規則を、2026-09-29 に足した
// 2 つの export（/api/v1/sellers/export.csv・/api/v1/observatory/l0/export.csv）が共有する。
// ============================================================

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLines(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n") + "\n";
}

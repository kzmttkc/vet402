// ============================================================
// 公開 CSV の書き出し（RFC 4180 の引用）。購入台帳の export.csv と同じ規則を、2026-09-29 に足した
// 2 つの export（/api/v1/sellers/export.csv・/api/v1/observatory/l0/export.csv）が共有する。
// 2026-09-29（監査 6 周目）: 購入台帳の export.csv も同じ csvCell を使う（全 export 共通の無害化）。
// ============================================================

/**
 * 表計算ソフトが式として読む先頭（2026-09-29 監査 6 周目・中・CSV injection）: `=` `+` `-` `@`・タブ・CR。
 * カタログの resource は売り手が書いた文字列で、`=HYPERLINK(...)` のような値が export を開いた人の表計算ソフトで
 * 式として動く。先頭に `'` を付けて文字列として読ませる（OWASP の推奨）。数（number / bigint）と、10 進の数の
 * 形だけの文字列（`-1`・`-0.5`。台帳の数の列）は式にならないので付けない。
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v !== "number" && typeof v !== "bigint" && FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLines(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n") + "\n";
}

// ============================================================
// 公開面の「小数 1 桁の %」を 1 か所で丸める（2026-09-29 監査 6 周目・整合性の監査人）。
//
// /observatory の判定バーは丸めの残りを最大の段へ寄せていたので pass 61.1%、
// /observatory/state は素直に丸めて 61.0%（21,268 / 34,840 = 61.04%）——同じ数が
// 頁ごとに違って見えた。面は全部ここを通す。段の合計が 100.0 にならないことはあるが、
// 各段は分子／分母から誰でも同じ値を再計算できる（合計を揃えるために 1 段だけ動かさない）。
// ============================================================

/** 小数 1 桁の %（分母 0・非有限は null）。 */
export function pct1(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

/** pct1 の表示形（"61.0%"、分母 0 は "—"）。 */
export function formatPct1(n: number, d: number): string {
  const v = pct1(n, d);
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

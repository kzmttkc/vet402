// ============================================================
// USDC units（10^6 = $1）の表示（2026-09-02 監査 P2）。
// /impact と /decisions が別々の関数で "$16.71" と "$16.712" を出していた。
// 桁の規則はここ 1 箇所: 1 セント以上は小数 2 桁、1 セント未満は 4 桁
// （$0.00 と $0.0030 を区別する）、数にならないものは "—"。
// ============================================================

export function formatUsdcUnits(units: string | number | null | undefined): string {
  if (units === null || units === undefined) return "—";
  const n = Number(units) / 1_000_000;
  if (!Number.isFinite(n)) return "—";
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

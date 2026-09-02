// ============================================================
// 図の算術（2026-09-02・UI/UX 監査「文字だらけで直感的でない」への回答）。
// RFC の紙の世界に「装飾」は持ち込まないが、「データの図」は持ち込む。
// ここは純関数だけ——描画は src/components/site/Figures.tsx。
// ============================================================

export type ShareSegment<K extends string = string> = {
  key: K;
  n: number;
  /** 0–100。合計は 100 になる（丸めの残りは最大の段へ）。 */
  pct: number;
  /** 描画幅（%）。n>0 の段は最小幅を保証し、見えない段を作らない。 */
  widthPct: number;
};

/**
 * 積み上げバーの段。n=0 の段は幅 0、n>0 の段は最低 minWidthPct を保つ。
 * 最小幅で膨らんだ分は最大の段から差し引くので、幅の合計は常に 100。
 * fail 1 / 20,460 を「0.005% の見えない線」にしないための規則。
 */
export function shareSegments<K extends string>(
  counts: readonly { key: K; n: number }[],
  minWidthPct = 1.5,
): ShareSegment<K>[] {
  const total = counts.reduce((a, c) => a + Math.max(0, c.n), 0);
  if (total === 0) return counts.map((c) => ({ key: c.key, n: 0, pct: 0, widthPct: 0 }));
  const raw = counts.map((c) => ({ key: c.key, n: Math.max(0, c.n), pct: (Math.max(0, c.n) / total) * 100 }));
  // pct: 小数 1 桁へ丸め、残りは最大の段へ
  const rounded = raw.map((r) => ({ ...r, pct: Math.round(r.pct * 10) / 10 }));
  const largest = rounded.reduce((best, r, i) => (r.n > rounded[best].n ? i : best), 0);
  const drift = Math.round((100 - rounded.reduce((a, r) => a + r.pct, 0)) * 10) / 10;
  rounded[largest].pct = Math.round((rounded[largest].pct + drift) * 10) / 10;
  // widthPct: 最小幅の保証
  const widths = rounded.map((r) => (r.n > 0 ? Math.max(r.pct, minWidthPct) : 0));
  const overflow = widths.reduce((a, w) => a + w, 0) - 100;
  if (overflow > 0) widths[largest] = Math.max(0, widths[largest] - overflow);
  return rounded.map((r, i) => ({ ...r, widthPct: Math.round(widths[i] * 100) / 100 }));
}

export type GaugeCell = "settled" | "failed";

/**
 * 決済目盛り。attempts ≤ maxCells なら 1 試行 = 1 目盛り（正確な個数）。
 * 超えるときは maxCells 個へ比例配分し、settled が 1 以上なら最低 1 目盛りは残す
 * （「0 に丸めて成功が消える」を避ける）。
 */
export function gaugeCells(settled: number, attempts: number, maxCells = 20): { cells: GaugeCell[]; scaled: boolean } {
  const s = Math.max(0, Math.min(settled, attempts));
  const a = Math.max(0, attempts);
  if (a === 0) return { cells: [], scaled: false };
  if (a <= maxCells) {
    return { cells: [...Array<GaugeCell>(s).fill("settled"), ...Array<GaugeCell>(a - s).fill("failed")], scaled: false };
  }
  let k = Math.round((s / a) * maxCells);
  if (s > 0 && k === 0) k = 1;
  if (s < a && k === maxCells) k = maxCells - 1;
  return { cells: [...Array<GaugeCell>(k).fill("settled"), ...Array<GaugeCell>(maxCells - k).fill("failed")], scaled: true };
}

export type TimelinePoint<V extends string = string> = { at: Date; verdict: V };

/**
 * 時間軸上の位置（0–1）。範囲は最初と最後の点。点が 1 つなら 1.0（右端）。
 * 同じ日の点は同じ x に重なる——重なりは描画側が縦にずらすのではなく、
 * 「同日に複数回測った」事実としてそのまま重ねる。
 */
export function timelinePositions<V extends string>(points: readonly TimelinePoint<V>[]): { x: number; verdict: V; at: Date }[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((p, q) => p.at.getTime() - q.at.getTime());
  const t0 = sorted[0].at.getTime();
  const t1 = sorted[sorted.length - 1].at.getTime();
  const span = t1 - t0;
  return sorted.map((p) => ({ x: span === 0 ? 1 : (p.at.getTime() - t0) / span, verdict: p.verdict, at: p.at }));
}

/** 漏斗の段の幅（%）。先頭を 100 とし、以降は先頭比。n>0 は最低 minWidthPct。 */
export function funnelWidths(ns: readonly number[], minWidthPct = 1.5): number[] {
  const head = ns[0] ?? 0;
  if (head <= 0) return ns.map(() => 0);
  return ns.map((n) => (n <= 0 ? 0 : Math.max(minWidthPct, Math.round((n / head) * 1000) / 10)));
}

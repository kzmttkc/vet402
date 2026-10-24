// L0 の帯の4段。/observatory と /observatory/state は同じ4語を分母にする。
// verdict のチップは率を変えない（表の行だけを絞る）。
import { pct1 } from "@/lib/util/pct";

export const L0_BAND_ORDER = ["pass", "fail", "unverified", "withdrawn"] as const;

export type L0BandKey = (typeof L0_BAND_ORDER)[number];

export type L0BandCounts = Record<L0BandKey, number>;

export type L0Band = {
  counts: L0BandCounts;
  /** 4段の合計。キャプションに出す総数はこれ。 */
  total: number;
  /** pass / total を pct1 で丸めた値。/observatory/state の pass と同じ丸め。 */
  passShare: number | null;
};

export function l0BandTotal(counts: L0BandCounts): number {
  return L0_BAND_ORDER.reduce((n, key) => n + counts[key], 0);
}

export function l0PassShare(counts: L0BandCounts): number | null {
  return pct1(counts.pass, l0BandTotal(counts));
}

function bandOf(counts: L0BandCounts): L0Band {
  return { counts, total: l0BandTotal(counts), passShare: l0PassShare(counts) };
}

/**
 * 絞り込みの帯。`verdict` は受け取るが率に使わない。
 * 検索・network・settled は、呼び手が既に絞った4数を渡す。
 */
export function l0BandFromVerdictCounts(
  counts: L0BandCounts,
  verdict?: string | null,
): L0Band {
  void verdict;
  return bandOf({
    pass: counts.pass,
    fail: counts.fail,
    unverified: counts.unverified,
    withdrawn: counts.withdrawn,
  });
}

/** 絞り込み無しの帯。state の pass は totalEndpoints を分母にする。4段の合計がそれと一致する。 */
export function l0BandFromStats(stats: {
  publishedPass: number;
  publishedFail: number;
  publishedUnverified: number;
  withdrawnFail?: number;
  totalEndpoints: number;
}): L0Band & { statePassShare: number | null } {
  const band = bandOf({
    pass: stats.publishedPass,
    fail: stats.publishedFail,
    unverified: stats.publishedUnverified,
    withdrawn: stats.withdrawnFail ?? 0,
  });
  return { ...band, statePassShare: pct1(stats.publishedPass, stats.totalEndpoints) };
}

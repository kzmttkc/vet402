// ============================================================
// 公開ヘッドの鮮度と、ヘッドが無い日（2026-11-10 公平審査 3.8 の 6c-2）。
//
// ヘッドの日付 H は、公開した UTC 日 P の前日以前（P − H ≥ 1）で、遅れは 3 日未満
// （P − H ≤ 2）。probe402 はヘッドが 11/04、公開が 11/07 以降で、11/05〜11/07 が
// 封印済みなのに未掲載だった。その形を合格にしない。
//
// ヘッドが無い日は 2 種類あり、どちらも根を埋めずに「no_head_for_day」と書く。
//   - 鎖の途中の穴（ある日の次に封印した日が、翌日ではない）
//   - ヘッドの翌日から P の前日まで（日次ジョブが止まっている間）
// ============================================================
import { missingDaysBetween } from "@/lib/observatory/anchors";

const DAY_MS = 86_400_000;
export const MAX_HEAD_LAG_DAYS = 3;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 公開 UTC 日 P とヘッドの最終日 H の差（P − H、日数）。 */
export function headLagDays(publishedUtcDay: string, headDay: string | null): number | null {
  if (!headDay) return null;
  return Math.round((Date.parse(`${publishedUtcDay}T00:00:00Z`) - Date.parse(`${headDay}T00:00:00Z`)) / DAY_MS);
}

export type MissingHeadDay = { day: string; status: "no_head_for_day" };

/**
 * ヘッドが無い日の一覧（古い順）。anchors は新しい日が先（getAnchors の順）。
 * 窓の外（anchors の最古より前）は数えない。ヘッドが 1 行も無いときは P の前日だけを返す。
 */
export function missingHeadDays(
  publishedUtcDay: string,
  anchorsNewestFirst: readonly { day: string }[],
): MissingHeadDay[] {
  const yesterday = shiftDay(publishedUtcDay, -1);
  const days = new Set<string>();
  if (anchorsNewestFirst.length === 0) {
    days.add(yesterday);
  } else {
    for (let i = 0; i + 1 < anchorsNewestFirst.length; i++) {
      const newer = anchorsNewestFirst[i].day;
      const older = anchorsNewestFirst[i + 1].day;
      for (const d of missingDaysBetween(older, newer, [older, newer])) days.add(d);
    }
    const head = anchorsNewestFirst[0].day;
    if (head < yesterday) {
      for (const d of missingDaysBetween(shiftDay(head, 1), yesterday, [])) days.add(d);
    }
  }
  return [...days].sort().map((day) => ({ day, status: "no_head_for_day" as const }));
}

export type HeadFreshness = {
  ok: boolean;
  publishedUtcDay: string;
  headDay: string | null;
  lagDays: number | null;
  code: "no_head" | "head_not_before_published" | "head_too_stale" | null;
};

export function evaluateHeadFreshness(publishedUtcDay: string, headDay: string | null): HeadFreshness {
  const lag = headLagDays(publishedUtcDay, headDay);
  const base = { publishedUtcDay, headDay, lagDays: lag };
  if (headDay === null || lag === null) return { ...base, ok: false, code: "no_head" };
  if (lag < 1) return { ...base, ok: false, code: "head_not_before_published" };
  if (lag >= MAX_HEAD_LAG_DAYS) return { ...base, ok: false, code: "head_too_stale" };
  return { ...base, ok: true, code: null };
}

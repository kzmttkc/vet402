// ============================================================
// E6 の日次 root 用射影。canonicalDayPayload（L1 台帳）は触らない。
// anchorDay の鎖と並ぶ、E6 専用の決定的 JSON（purchaseId 昇順の verify 行）。
// ============================================================
import { createHash } from "node:crypto";
import { e6AnchorVerifyLine, type E6Record } from "@/lib/observatory/e6-record";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** その UTC 日に updatedAt が載る E6 行だけを、purchaseId 昇順で正規化する。 */
export function e6RecordsForDay(day: string, records: readonly E6Record[]): E6Record[] {
  if (!DAY_RE.test(day)) return [];
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + 86_400_000;
  return records
    .filter((r) => {
      const t = Date.parse(r.updatedAt);
      return t >= start && t < end;
    })
    .sort((a, b) => a.purchaseId.localeCompare(b.purchaseId));
}

export function e6DayPayload(day: string, records: readonly E6Record[]): { payload: string; count: number } {
  const rows = e6RecordsForDay(day, records).map((r) => e6AnchorVerifyLine(r).line);
  return { payload: JSON.stringify({ v: 1, kind: "e6", day, lines: rows }), count: rows.length };
}

export function e6DayRootHash(prevRoot: string | null, day: string, records: readonly E6Record[]): string {
  const { payload } = e6DayPayload(day, records);
  return createHash("sha256").update(prevRoot ?? "genesis").update("\n").update(payload).digest("hex");
}

/** 渡した日次 root と再計算結果が一致し、その日の payload に verify 行があるか。 */
export function e6LineMatchesDayRoot(
  dayRoot: string,
  prevRoot: string | null,
  day: string,
  records: readonly E6Record[],
  record: E6Record,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(dayRoot)) return false;
  const computed = e6DayRootHash(prevRoot, day, records);
  if (computed !== dayRoot) return false;
  const inDay = e6RecordsForDay(day, records).some((r) => r.purchaseId === record.purchaseId);
  if (!inDay) return false;
  const { line } = e6AnchorVerifyLine(record);
  const { payload } = e6DayPayload(day, records);
  let lines: string[] = [];
  try {
    const parsed = JSON.parse(payload) as { lines?: string[] };
    lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  } catch {
    return false;
  }
  return lines.includes(line);
}

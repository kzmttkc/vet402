// vet402 — feedback index cron cadence vs live health tail scan (2026-11-07).
// At 0.2 s Base blocks the unindexed tail grows ~18,000 blocks/h; /api/health
// reads it under TAIL_SCAN_DEADLINE_MS (2.5 s). This test pins vercel.json so
// the largest gap between index-feedback runs stays within one segment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Expand minute (0–59) or hour (0–23) cron subfields: number, list, or step star-slash-N. */
function expandCronField(field: string, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max + 1 }, (_, i) => i);
  }
  const step = field.match(/^\*\/(\d+)$/);
  if (step) {
    const n = Number(step[1]);
    assert.ok(n > 0 && Number.isInteger(n), `invalid step ${field}`);
    const out: number[] = [];
    for (let i = 0; i <= max; i += n) out.push(i);
    return out;
  }
  return field.split(",").map((part) => {
    const v = Number(part);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= max, `out of range ${part} in ${field}`);
    return v;
  });
}

/** Minutes after midnight for a simple daily cron (day/month/weekday are `*`). */
function cronToMinutesOfDay(schedule: string): number[] {
  const parts = schedule.trim().split(/\s+/);
  assert.equal(parts.length, 5, schedule);
  const [minute, hour, dom, month, dow] = parts;
  assert.equal(dom, "*", `day-of-month must be * (${schedule})`);
  assert.equal(month, "*", `month must be * (${schedule})`);
  assert.equal(dow, "*", `weekday must be * (${schedule})`);

  const minutes = expandCronField(minute, 59);
  const hours = expandCronField(hour, 23);
  const out = new Set<number>();
  for (const h of hours) {
    for (const m of minutes) {
      out.add(h * 60 + m);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function maxGapMinutes(sortedMinutesOfDay: number[]): number {
  assert.ok(sortedMinutesOfDay.length >= 2, "need at least two runs per day");
  let maxGap = 0;
  for (let i = 0; i < sortedMinutesOfDay.length; i++) {
    const cur = sortedMinutesOfDay[i]!;
    const next = sortedMinutesOfDay[(i + 1) % sortedMinutesOfDay.length]!;
    const gap =
      i === sortedMinutesOfDay.length - 1
        ? 24 * 60 - cur + next
        : next - cur;
    maxGap = Math.max(maxGap, gap);
  }
  return maxGap;
}

test("index-feedback cron cadence keeps the live tail inside the health probe", () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  assert.ok(Array.isArray(vercel.crons), "vercel.json crons");
  assert.ok(vercel.crons.length <= 100, `Vercel allows at most 100 cron entries (got ${vercel.crons.length})`);

  const feedback = vercel.crons.filter((c) => c.path === "/api/cron/index-feedback");
  assert.ok(feedback.length >= 1, "at least one /api/cron/index-feedback entry");

  const allRuns = new Set<number>();
  for (const { schedule } of feedback) {
    for (const m of cronToMinutesOfDay(schedule)) allRuns.add(m);
  }
  const sorted = [...allRuns].sort((a, b) => a - b);
  const maxGap = maxGapMinutes(sorted);

  // At 0.2 s Base blocks, 30 min ≈ 9,000 blocks — inside what the 2.5 s health
  // probe can read live; 1.5 h ≈ 27,000 blocks was measured to fail in production.
  assert.ok(
    maxGap <= 30,
    `largest gap between index-feedback runs is ${maxGap} min (want ≤ 30); schedules: ${feedback.map((f) => f.schedule).join(", ")}`,
  );
});

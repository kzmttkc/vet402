// coverage7d を上げるための L0 列の優先（式は変えない・7 日窓の落ちかけ→外→内）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  COVERAGE7D_MEASURED_COUNT_TARGET,
  L0_COVERAGE7D_RETENTION_GRACE_DAYS,
  L0_COVERAGE7D_WINDOW_DAYS,
  L0_CRON_DRAIN_BUDGET_MS,
  L0_CRON_MAX_DURATION_MS,
  L0_PROBE_BATCH_BUDGET_MS,
  L0_PROBE_CANDIDATE_SELECT_RESERVE_MS,
  L0_PROBE_PRIORITY_RESERVE_MS,
  L0_PROBE_RETURN_MS,
  L0_PROBE_ROUTE_TAIL_MS,
  L0_PROBE_SCHEDULE_HOLD_MS,
  l0Coverage7dQueueClassSql,
  l0ProbedWithinCoverage7dSql,
  l0ProbeStartsPerRunBounds,
  l0ProbeEffectiveDailyCapacity,
  projectCoverage7dMeasured,
  COVERAGE7D_BASELINE_2026_11_09,
  L0_CRON_C1_DEFAULT_LIMIT,
} from "@/lib/observatory/l0-coverage7d";
import { l0ProbeCronRunsPerDay } from "@/lib/observatory/l0-schedule";
import { PRIORITY_DOMAIN_INTERVAL_MS } from "@/lib/observatory/reprobe-priority";
import { REPROBE_MIN_INTERVAL_MS } from "@/lib/observatory/l0-rule-change-reprobe";
import { L0_NORMAL_DOMAIN_INTERVAL_MS } from "@/lib/observatory/l0-coverage7d";
import { pct1 } from "@/lib/util/pct";

const read = (p: string) => readFileSync(p, "utf8");

test("coverage7d の 7 日窓は 7 日固定（getCoverageShare と同じ述語）", () => {
  assert.equal(L0_COVERAGE7D_WINDOW_DAYS, 7);
  const within = new PgDialect().sqlToQuery(l0ProbedWithinCoverage7dSql()).sql.replace(/\s+/g, " ");
  assert.match(within, /x402_l0_probes p/);
  assert.match(within, /p\.probed_at > now\(\) - interval '7 days'/);
  const reader = read("src/lib/observatory/reader.ts");
  assert.match(reader, /p\.probed_at > now\(\) - interval '7 days'/);
  assert.doesNotMatch(reader, /interval '6 days'/);
});

test("l0OrderBy: 落ちかけ→窓外→窓内後回しの 3 段が先頭、全 tier で hostSpread あり", async () => {
  const { l0OrderBy } = await import("@/lib/observatory/coverage");
  const render = (tier: "c1" | "c2" | "all") =>
    new PgDialect().sqlToQuery(l0OrderBy(tier)).sql.replace(/\s+/g, " ");
  const qClass = new PgDialect().sqlToQuery(l0Coverage7dQueueClassSql()).sql.replace(/\s+/g, " ");
  assert.match(qClass, /THEN 0/);
  assert.match(qClass, /THEN 1/);
  assert.match(qClass, /ELSE 2 END/);
  assert.equal(L0_COVERAGE7D_RETENTION_GRACE_DAYS, 6);
  for (const tier of ["c1", "c2", "all"] as const) {
    const sql = render(tier);
    assert.match(sql, new RegExp(`^${qClass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`), `${tier} は coverage7d の 3 段が先頭`);
    assert.match(sql, /row_number\(\) OVER \(PARTITION BY lower\(split_part/, `${tier} はホストを混ぜる hostSpread を含む`);
  }
  const c1 = render("c1");
  assert.match(c1, /WHEN lp\.rule_change_reprobe AND row_number\(\)/);
  assert.match(c1, /WHEN lp\.probe_count = 1 AND lp\.last_verdict = 'fail' THEN/);
});

test("probe-runner: 通常列も合計時間上限・ドメイン頭打ち・ホスト混在・batch 期限", () => {
  const body = read("src/lib/observatory/probe-runner.ts");
  assert.match(body, /fillPriorityByDomain\(fetchCandidatePage/);
  assert.match(body, /interleaveByHost\(candidates/);
  assert.match(body, /runWithDomainInterval\(orderedCandidates/);
  assert.match(body, /withTotalLimit\(request, normalRequestLimitMs\)/);
  assert.match(body, /keepLease = true/);
  assert.match(body, /intervalMs: L0_NORMAL_DOMAIN_INTERVAL_MS/);
  assert.match(body, /deadlineAt: batchDeadlineAt/);
  assert.match(body, /batchBudgetMs = L0_PROBE_BATCH_BUDGET_MS/);
  assert.doesNotMatch(body, /Array\.from\(\{ length: Math\.min\(concurrency, candidates\.length \}/);
  assert.equal(PRIORITY_DOMAIN_INTERVAL_MS, REPROBE_MIN_INTERVAL_MS);
  assert.equal(L0_NORMAL_DOMAIN_INTERVAL_MS, REPROBE_MIN_INTERVAL_MS);
  assert.equal(L0_PROBE_SCHEDULE_HOLD_MS, L0_PROBE_RETURN_MS, "見込みの保持は 10.5 秒上限と同じ");
});

test("cron: drain 後の batch と vercel の l0-probe が 300s 内（7 本以上）", async () => {
  const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const l0 = vercel.crons.filter((row) => row.path === "/api/cron/l0-probe");
  assert.ok(l0.length >= 7, "日次 7 回で 10.5 秒保持の下でも落ちかけを維持できる枠");
  const route = read("src/app/api/cron/l0-probe/route.ts");
  assert.match(route, /maxDuration = 300/);
  assert.match(route, /L0_CRON_C1_DEFAULT_LIMIT/);
  assert.match(route, /L0_PROBE_BATCH_BUDGET_MS/);
  assert.ok(L0_CRON_C1_DEFAULT_LIMIT >= 4000, "C1 の 1 回あたり既定を 4000 以上に");
  assert.equal(
    L0_PROBE_BATCH_BUDGET_MS + L0_CRON_DRAIN_BUDGET_MS + L0_PROBE_ROUTE_TAIL_MS,
    L0_CRON_MAX_DURATION_MS,
    "drain + batch + tail が maxDuration 300s",
  );
});

test("同一ドメイン同時1件: 10.5 秒保持で 1 レーンの開始数を切り、偏り時は単一レーン", () => {
  const bounds = l0ProbeStartsPerRunBounds({
    cronL0RunsPerDay: 7,
    limitPerRun: 4500,
    priorityCap: 50,
    maxDurationSec: 300,
    concurrency: 40,
    domainIntervalMs: REPROBE_MIN_INTERVAL_MS,
    batchBudgetMs: L0_PROBE_BATCH_BUDGET_MS,
    priorityReserveMs: L0_PROBE_PRIORITY_RESERVE_MS,
    candidateSelectReserveMs: L0_PROBE_CANDIDATE_SELECT_RESERVE_MS,
  });
  const expectedSlots = Math.floor(
    (L0_PROBE_BATCH_BUDGET_MS - L0_PROBE_PRIORITY_RESERVE_MS - L0_PROBE_CANDIDATE_SELECT_RESERVE_MS) /
      Math.max(REPROBE_MIN_INTERVAL_MS, L0_PROBE_SCHEDULE_HOLD_MS),
  );
  assert.equal(bounds.slotsPerLane, expectedSlots);
  assert.equal(bounds.startSpacingMs, L0_PROBE_RETURN_MS);
  assert.equal(bounds.singleDomainStarts, Math.min(4450, expectedSlots));
  assert.ok(bounds.diverseHostStarts <= 4450);
  assert.notEqual(bounds.diverseHostStarts, 4450, "旧式 floor(300秒/1秒)×40 の 4,450 上限は使わない");
  assert.notEqual(bounds.slotsPerLane, 300, "間隔だけで 300 スロット/レーンと見積もらない");
  const narrow = l0ProbeStartsPerRunBounds({
    cronL0RunsPerDay: 7,
    limitPerRun: 4500,
    priorityCap: 50,
    maxDurationSec: 300,
    concurrency: 40,
    distinctRegisteredDomains: 3,
  });
  assert.equal(narrow.diverseHostStarts, expectedSlots * 3);
  const narrowDaily = l0ProbeEffectiveDailyCapacity({
    cronL0RunsPerDay: 7,
    limitPerRun: 4500,
    priorityCap: 50,
    maxDurationSec: 300,
    concurrency: 40,
    distinctRegisteredDomains: 3,
  });
  assert.equal(narrowDaily.effectivePerRun, narrowDaily.singleDomainStarts);
});

test("窓の落ちかけ: 1 日の枠が維持に足りないとき分子は下がる", () => {
  const low = projectCoverage7dMeasured(COVERAGE7D_BASELINE_2026_11_09, 1_680, 7);
  assert.ok(low.fallOffShortfallPerDay > 0);
  assert.ok(low.measured < COVERAGE7D_BASELINE_2026_11_09.measuredLast7d);
  assert.ok(low.measured < COVERAGE7D_MEASURED_COUNT_TARGET);
});

test("7 日後見込み: 落ちかけ維持＋窓外で分子 29,633・pct1>22.4（算術・要確認）", () => {
  const cronRuns = l0ProbeCronRunsPerDay();
  assert.ok(cronRuns >= 7);
  const runs = l0ProbeEffectiveDailyCapacity({
    cronL0RunsPerDay: cronRuns,
    limitPerRun: L0_CRON_C1_DEFAULT_LIMIT,
    priorityCap: 50,
    maxDurationSec: 300,
    concurrency: 40,
    domainIntervalMs: REPROBE_MIN_INTERVAL_MS,
  });
  assert.ok(runs.effectivePerDay > 4_000, "複数本 cron・ホスト混在で落ちかけ＋窓外に十分な枠");
  const day7 = projectCoverage7dMeasured(COVERAGE7D_BASELINE_2026_11_09, runs.effectivePerDay, 7);
  assert.ok(day7.retentionPerDay >= COVERAGE7D_BASELINE_2026_11_09.measuredLast7d / L0_COVERAGE7D_WINDOW_DAYS - 1);
  assert.ok(day7.measured >= COVERAGE7D_MEASURED_COUNT_TARGET, `7 日後分子 ${day7.measured}`);
  const pct = pct1(day7.measured, COVERAGE7D_BASELINE_2026_11_09.activeEndpoints);
  assert.ok(pct !== null && pct > 22.4, `7 日後の見込み ${pct}% が 22.4 を上回る`);
});

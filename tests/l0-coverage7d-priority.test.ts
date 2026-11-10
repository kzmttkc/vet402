// coverage7d を上げるための L0 列の優先（式は変えない・7 日窓の外を先に）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  L0_COVERAGE7D_WINDOW_DAYS,
  l0Coverage7dQueueClassSql,
  l0ProbedWithinCoverage7dSql,
} from "@/lib/observatory/l0-coverage7d";
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

test("l0OrderBy: 全 tier で 7 日窓に無い行が先（queue class 0）、その後に既存の組み合わせ", async () => {
  const { l0OrderBy } = await import("@/lib/observatory/coverage");
  const render = (tier: "c1" | "c2" | "all") =>
    new PgDialect().sqlToQuery(l0OrderBy(tier)).sql.replace(/\s+/g, " ");
  const qClass = new PgDialect().sqlToQuery(l0Coverage7dQueueClassSql()).sql.replace(/\s+/g, " ");
  assert.match(qClass, /CASE WHEN EXISTS/);
  assert.match(qClass, /THEN 1 ELSE 0 END/);
  for (const tier of ["c1", "c2", "all"] as const) {
    const sql = render(tier);
    assert.match(sql, new RegExp(`^${qClass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`), `${tier} は窓外優先が先頭`);
  }
  const c1 = render("c1");
  assert.match(c1, /WHEN lp\.rule_change_reprobe AND row_number\(\)/);
  assert.match(c1, /WHEN lp\.probe_count = 1 AND lp\.last_verdict = 'fail' THEN/);
});

test("probe-runner: 普通の列も登録ドメイン間隔（優先と同じ下限）で流す", () => {
  const body = read("src/lib/observatory/probe-runner.ts");
  assert.match(body, /runWithDomainInterval\(orderedCandidates/);
  assert.match(body, /intervalMs: L0_NORMAL_DOMAIN_INTERVAL_MS/);
  assert.doesNotMatch(body, /Array\.from\(\{ length: Math\.min\(concurrency, candidates\.length \}/);
  assert.equal(PRIORITY_DOMAIN_INTERVAL_MS, REPROBE_MIN_INTERVAL_MS);
  assert.equal(L0_NORMAL_DOMAIN_INTERVAL_MS, REPROBE_MIN_INTERVAL_MS);
});

test("cron: C1 の既定件数が上がり、vercel に l0-probe が 2 本（maxDuration 300 内）", async () => {
  const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const l0 = vercel.crons.filter((row) => row.path === "/api/cron/l0-probe");
  assert.equal(l0.length, 2, "日次 2 回で件数を上げる（Hobby 日次の範囲）");
  const route = read("src/app/api/cron/l0-probe/route.ts");
  assert.match(route, /maxDuration = 300/);
  assert.match(route, /L0_CRON_C1_DEFAULT_LIMIT/);
  const { L0_CRON_C1_DEFAULT_LIMIT } = await import("@/lib/observatory/l0-coverage7d");
  assert.ok(L0_CRON_C1_DEFAULT_LIMIT >= 4000, "C1 の 1 回あたり既定を 4000 以上に");
});

test("7 日後見込み: 窓外優先で 1 日あたりの有効新規が増えれば pct1 は 22.4 を超えうる（算術・要確認）", async () => {
  const {
    l0ProbeEffectiveDailyCapacity,
    projectCoverage7dMeasured,
    COVERAGE7D_BASELINE_2026_11_09,
  } = await import("@/lib/observatory/l0-coverage7d");
  const { L0_CRON_C1_DEFAULT_LIMIT } = await import("@/lib/observatory/l0-coverage7d");
  const runs = l0ProbeEffectiveDailyCapacity({
    cronL0RunsPerDay: 2,
    limitPerRun: L0_CRON_C1_DEFAULT_LIMIT,
    priorityCap: 50,
    maxDurationSec: 300,
    concurrency: 40,
    domainIntervalMs: REPROBE_MIN_INTERVAL_MS,
  });
  assert.ok(runs.effectivePerDay > 3000, "2 本 cron と件数増で 3000/日を上回る想定");
  const day7 = projectCoverage7dMeasured(
    COVERAGE7D_BASELINE_2026_11_09,
    runs.effectivePerDay,
    7,
  );
  const pct = pct1(day7.measured, COVERAGE7D_BASELINE_2026_11_09.activeEndpoints);
  assert.ok(pct !== null && pct > 22.4, `7 日後の見込み ${pct}% が 22.4 を上回る（線形・窓のちらつきは未モデル）`);
});

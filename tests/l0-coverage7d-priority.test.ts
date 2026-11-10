// coverage7d を上げる L0 列（式と分母は reader.ts のまま・c36.rr3 の指摘を閉じる形・2026-11-10）。
//   - 窓の外を先に、窓の内の更新は 1 回 L0_COVERAGE7D_IN_WINDOW_PER_RUN 件まで毎回残す。
//   - 時間: ルートの開始から 300 秒の内側で返る。drain・優先の選定・優先の段・候補 SELECT は上限で打ち切る。
//   - 見込み: 1 件がレーンを占める最悪の時間（要求の上限＋DB の予算）で切った下限。DB を読まないので、
//     ホストの分布は公開 export.csv の標本（fixture）を前提として明記して使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  COVERAGE7D_BASELINE_2026_11_09,
  COVERAGE7D_MEASURED_COUNT_TARGET,
  COVERAGE7D_OUT_OF_WINDOW_POOL_FLOOR_2026_11_10,
  L0_COVERAGE7D_IN_WINDOW_PER_RUN,
  L0_COVERAGE7D_WINDOW_DAYS,
  L0_COVERAGE_RUN_LIMIT,
  L0_CRON_C1_DEFAULT_LIMIT,
  L0_CRON_CONCURRENCY,
  L0_CRON_DRAIN_CAP_MS,
  L0_CRON_MAX_DURATION_MS,
  L0_NORMAL_DOMAIN_INTERVAL_MS,
  L0_PROBE_CANDIDATE_SELECT_CAP_MS,
  L0_PROBE_DB_BUDGET_MS,
  L0_PROBE_LANE_HOLD_MS,
  L0_PROBE_PRIORITY_SELECT_CAP_MS,
  L0_PROBE_PRIORITY_STAGE_MS,
  L0_PROBE_REQUEST_LIMIT_MS,
  L0_PROBE_SETTLE_TAIL_MS,
  L0_ROUTE_RETURN_SAFETY_MS,
  coverage7dMeetsTarget,
  l0Coverage7dQueueClassSql,
  l0NormalLaneWindowMs,
  l0PerDomainCap,
  l0ProbedWithinCoverage7dSql,
  l0RunDeadlineAt,
  l0SlotsPerLane,
  l0WorstCaseStartsPerRun,
  poolFromDomainSample,
  projectCoverage7dLowerBound,
} from "@/lib/observatory/l0-coverage7d";
import {
  L0_COVERAGE_CRON_PATH,
  L0_PROBE_CRON_PATH,
  l0CronRunModesPerDay,
  l0ProbeCronSchedules,
} from "@/lib/observatory/l0-schedule";
import { PRIORITY_REQUEST_TOTAL_MS, runWithDomainInterval } from "@/lib/observatory/reprobe-priority";
import { REPROBE_MIN_INTERVAL_MS } from "@/lib/observatory/l0-rule-change-reprobe";
import { pct1 } from "@/lib/util/pct";

const read = (p: string) => readFileSync(p, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sample = JSON.parse(read("tests/fixtures/l0-coverage7d-domain-sample-2026-11-10.json")) as {
  endpoints: number;
  sizeToDomains: [number, number][];
};

test("式と分母は reader.ts のまま（7 日窓・active・運営 payTo 除外・seller_retest_request 除外）", () => {
  assert.equal(L0_COVERAGE7D_WINDOW_DAYS, 7);
  const within = flat(new PgDialect().sqlToQuery(l0ProbedWithinCoverage7dSql()).sql);
  assert.match(within, /p\.probed_at > now\(\) - interval '7 days'/);
  const reader = read("src/lib/observatory/reader.ts");
  const share = reader.slice(reader.indexOf("export async function getCoverageShare"));
  const body = share.slice(0, share.indexOf("\n}\n"));
  assert.match(body, /count\(\*\) FILTER \(WHERE e\.status = 'active'\)::int AS active/);
  assert.match(body, /p\.probed_at > now\(\) - interval '7 days'/);
  assert.match(body, /WHERE \$\{operatorExclusionPredicate\("e"\)\} AND \$\{notSellerRetestRequestSourceSql\(\)\}/);
  assert.match(body, /pct: pct1\(measured, active\)/);
  assert.equal(pct1(29_633, 131_995), 22.5);
  assert.equal(pct1(29_632, 131_995), 22.4);
  assert.equal(COVERAGE7D_MEASURED_COUNT_TARGET, 29_633);
});

test("並び: 窓の内の更新（1 回の上限つき）→ 窓の外 → 窓の内の残り。c2 は 6 時間の測り直しのまま", async () => {
  const { l0OrderBy } = await import("@/lib/observatory/coverage");
  const render = (tier: "c1" | "c2" | "all" | "coverage") => flat(new PgDialect().sqlToQuery(l0OrderBy(tier)).sql);
  const q = new PgDialect().sqlToQuery(l0Coverage7dQueueClassSql());
  const qs = flat(q.sql);
  // 窓の内 ⇔ max(probed_at) > now() - 7 days（reader の EXISTS と同じ集合。NULL は窓の外）。
  assert.match(qs, /COALESCE\(lp\.last_probed_at > now\(\) - interval '7 days', false\)/);
  assert.match(qs, /row_number\(\) OVER \(PARTITION BY COALESCE\(lp\.last_probed_at > now\(\) - interval '7 days', false\) ORDER BY lp\.rule_change_reprobe DESC NULLS LAST, \(lp\.probe_count = 1 AND lp\.last_verdict = 'fail'\) DESC NULLS LAST, lp\.last_probed_at ASC NULLS FIRST, e\.id ASC\) <= \$1 THEN 0/);
  assert.match(qs, /WHEN NOT COALESCE\(lp\.last_probed_at > now\(\) - interval '7 days', false\) THEN 1 ELSE 2 END/);
  assert.deepEqual(q.params, [L0_COVERAGE7D_IN_WINDOW_PER_RUN]);
  assert.ok(L0_COVERAGE7D_IN_WINDOW_PER_RUN > 0, "窓の内の更新を切らさない");
  for (const tier of ["c1", "coverage"] as const) {
    assert.ok(render(tier).startsWith(`${qs},`), `${tier} は coverage7d の 3 段が先頭`);
    assert.match(render(tier), /row_number\(\) OVER \(PARTITION BY lower\(split_part/, `${tier} はホストを混ぜる`);
  }
  for (const tier of ["c2", "all"] as const) {
    assert.doesNotMatch(render(tier), /COALESCE\(lp\.last_probed_at/, `${tier} は窓の外を先にしない（c2 の 6 時間の測り直しを削らない）`);
  }
});

test("時間: ルートの開始から 300 秒の内側で返る（drain・選定・優先の段・候補 SELECT・走行・書き込みの和）", () => {
  assert.equal(L0_CRON_MAX_DURATION_MS, 300_000);
  assert.equal(l0RunDeadlineAt(1_000), 1_000 + L0_CRON_MAX_DURATION_MS - L0_ROUTE_RETURN_SAFETY_MS);
  assert.equal(L0_PROBE_REQUEST_LIMIT_MS, PRIORITY_REQUEST_TOTAL_MS);
  assert.equal(L0_PROBE_LANE_HOLD_MS, L0_PROBE_REQUEST_LIMIT_MS + L0_PROBE_DB_BUDGET_MS, "レーンの保持は要求の上限＋行の DB");
  assert.ok(L0_PROBE_DB_BUDGET_MS >= 1_000, "リース・直近 SELECT・INSERT・リース解放の予算");
  const full = l0NormalLaneWindowMs("full");
  const coverage = l0NormalLaneWindowMs("coverage");
  assert.equal(
    L0_CRON_DRAIN_CAP_MS + L0_PROBE_PRIORITY_SELECT_CAP_MS + L0_PROBE_PRIORITY_STAGE_MS +
      L0_PROBE_CANDIDATE_SELECT_CAP_MS + full + L0_PROBE_SETTLE_TAIL_MS + L0_ROUTE_RETURN_SAFETY_MS,
    L0_CRON_MAX_DURATION_MS,
  );
  assert.equal(
    L0_PROBE_CANDIDATE_SELECT_CAP_MS + coverage + L0_PROBE_SETTLE_TAIL_MS + L0_ROUTE_RETURN_SAFETY_MS,
    L0_CRON_MAX_DURATION_MS,
  );
  assert.ok(L0_PROBE_SETTLE_TAIL_MS >= L0_PROBE_DB_BUDGET_MS * 2, "最後の行の書き込みを待つ余白");
  assert.equal(L0_PROBE_PRIORITY_STAGE_MS, 55_000);
  // floor(窓 / max(保持, 間隔))。
  assert.equal(l0SlotsPerLane(coverage), Math.floor(coverage / Math.max(L0_PROBE_LANE_HOLD_MS, REPROBE_MIN_INTERVAL_MS)));
  assert.equal(l0SlotsPerLane(coverage), 22);
  assert.equal(l0SlotsPerLane(full), 12);
  assert.equal(L0_NORMAL_DOMAIN_INTERVAL_MS, REPROBE_MIN_INTERVAL_MS);
});

test("ルートとランナー: 期限はルートの開始から・各段に上限・レーン保持の上限・ドメイン保持の共有", () => {
  const probeRoute = read("src/app/api/cron/l0-probe/route.ts");
  assert.match(probeRoute, /export const maxDuration = 300;/);
  assert.match(probeRoute, /const runDeadlineAt = l0RunDeadlineAt\(routeStartedAt\)/);
  assert.match(probeRoute, /withTotalLimit\(drain, L0_CRON_DRAIN_CAP_MS\)/);
  assert.match(probeRoute, /runDeadlineAt,/);
  const covRoute = read("src/app/api/cron/l0-coverage/route.ts");
  assert.match(covRoute, /export const maxDuration = 300;/);
  assert.match(covRoute, /authorizeCron\(request\)/);
  assert.match(covRoute, /tier: "coverage"/);
  assert.match(covRoute, /skipPriority: true/);
  assert.match(covRoute, /runDeadlineAt: l0RunDeadlineAt\(routeStartedAt\)/);
  assert.doesNotMatch(covRoute, /drainVerificationRequests/, "coverage の回は drain しない（drain と優先は l0-probe と c2 の回）");
  const runner = read("src/lib/observatory/probe-runner.ts");
  assert.match(runner, /withTotalLimit\(selecting, L0_PROBE_PRIORITY_SELECT_CAP_MS\)/);
  assert.match(runner, /L0_PROBE_CANDIDATE_SELECT_CAP_MS/);
  assert.match(runner, /Math\.min\(now\(\) \+ L0_PROBE_PRIORITY_STAGE_MS, laneEndAt\)/);
  assert.match(runner, /laneHoldMaxMs: laneHoldMs/);
  assert.match(runner, /preferLongestDomainQueue: true/);
  assert.match(runner, /holds,/);
  assert.match(runner, /return \{ holdDomainUntil: request \}/);
  assert.doesNotMatch(runner, /summary\.priorityAbandoned\+\+;\s*keepLease = true;\s*return;/, "上限超過は要求が終わるまでドメインを離さない");
});

test("cron: l0-probe（drain と優先つき）は 1 本、coverage は 6 本。申し立ての時刻は l0-probe だけ", () => {
  const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const probe = vercel.crons.filter((r) => r.path === L0_PROBE_CRON_PATH);
  const coverage = vercel.crons.filter((r) => r.path === L0_COVERAGE_CRON_PATH);
  assert.deepEqual(probe.map((r) => r.schedule), ["30 10 * * *"]);
  assert.equal(coverage.length, 6);
  assert.ok(vercel.crons.length <= 100);
  assert.deepEqual(l0ProbeCronSchedules(vercel.crons), ["30 10 * * *"], "申し立ての測り直しは優先の段がある回だけ");
  const modes = l0CronRunModesPerDay(vercel.crons);
  assert.equal(modes.filter((m) => m === "full").length, 1);
  assert.equal(modes.filter((m) => m === "coverage").length, 6);
  assert.equal(L0_CRON_CONCURRENCY, 40);
  assert.ok(L0_COVERAGE_RUN_LIMIT >= 4_000 && L0_CRON_C1_DEFAULT_LIMIT >= 4_000);
});

test("見込みの式は実装と一致する: 全件が最悪の保持のとき、仮想の時計で数えた開始数＝l0WorstCaseStartsPerRun", async () => {
  // 3 レーン、保持 12、窓 50 → 1 レーン floor(50/12) = 4 回。並びはわざと小さいドメインを先にする。
  const sizes: Record<string, number> = { a: 1, b: 1, c: 1, d: 6, e: 5, f: 2 };
  const items: { id: string; d: string }[] = [];
  const order = ["a", "b", "c", "f", "e", "d"];
  for (const d of order) for (let i = 0; i < sizes[d]!; i++) items.push({ id: `${d}${i}`, d });
  let t = 0;
  let seq = 0;
  const timers: { at: number; seq: number; resolve: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((r) => timers.push({ at: t + ms, seq: seq++, resolve: r }));
  let started = 0;
  const hold = 12;
  const window = 50;
  const done = runWithDomainInterval(items, {
    concurrency: 3,
    intervalMs: 1,
    deadlineAt: window - hold + 1, // 最後の開始が窓の内で返り切る線（ランナーと同じ: laneEnd − 保持）
    laneHoldMaxMs: hold,
    preferLongestDomainQueue: true,
    domainOf: (x) => x.d,
    now: () => t,
    sleep,
    run: async () => {
      started++;
      await sleep(hold);
    },
  });
  let finished = false;
  done.then(() => (finished = true));
  for (let i = 0; i < 2_000 && !finished; i++) {
    for (let k = 0; k < 30; k++) await new Promise<void>((r) => setImmediate(r));
    if (finished) break;
    timers.sort((x, y) => x.at - y.at || x.seq - y.seq);
    const next = timers.shift();
    if (!next) break;
    t = Math.max(t, next.at);
    next.resolve();
  }
  assert.ok(finished);
  const slots = l0SlotsPerLane(window, hold, 1);
  assert.equal(slots, 4);
  const model = l0WorstCaseStartsPerRun(Object.values(sizes), 3, slots);
  assert.equal(started, model.starts);
  assert.equal(model.starts, 12, "min(3 レーン × 4 回, Σ min(n, 4)) = min(12, 1+1+1+4+4+2)");
});

const pool = () => poolFromDomainSample(sample.sizeToDomains, COVERAGE7D_OUT_OF_WINDOW_POOL_FLOOR_2026_11_10);
const baseInput = () => ({
  runModes: l0CronRunModesPerDay(),
  countFullRuns: false,
  lanes: L0_CRON_CONCURRENCY,
  laneHoldMs: L0_PROBE_LANE_HOLD_MS,
  listLimit: L0_COVERAGE_RUN_LIMIT,
  inWindowQuota: L0_COVERAGE7D_IN_WINDOW_PER_RUN,
  poolDomainSizes: pool(),
  days: L0_COVERAGE7D_WINDOW_DAYS,
});

test("7 日後見込み（下限）: coverage の 6 回だけで分子 29,633 以上・pct1 > 22.4", () => {
  assert.equal(COVERAGE7D_OUT_OF_WINDOW_POOL_FLOOR_2026_11_10, 56_197);
  const p = pool();
  assert.ok(p.reduce((a, b) => a + b, 0) <= COVERAGE7D_OUT_OF_WINDOW_POOL_FLOOR_2026_11_10);
  assert.equal(l0PerDomainCap(L0_COVERAGE_RUN_LIMIT, L0_CRON_CONCURRENCY), 113, "ランナーと同じ ceil(4500 / 40)");
  const r = projectCoverage7dLowerBound(baseInput());
  // 1 回 = 40 レーン × 22 − 窓の内 100 = 780。1 日 6 回 = 4,680。7 日 = 32,760。
  assert.equal(r.perRun.find((x) => x.mode === "coverage")?.outOfWindowStarts, 780);
  assert.equal(r.measuredLowerBound, 32_760);
  assert.ok(r.measuredLowerBound >= COVERAGE7D_MEASURED_COUNT_TARGET);
  assert.ok(coverage7dMeetsTarget(r.measuredLowerBound, COVERAGE7D_BASELINE_2026_11_09.activeEndpoints));
  assert.equal(pct1(r.measuredLowerBound, COVERAGE7D_BASELINE_2026_11_09.activeEndpoints), 24.8);
  assert.ok(coverage7dMeetsTarget(r.measuredLowerBound, 132_040), "2026-11-10 の公開分母でも");
  assert.ok(r.poolLeft > 0, "標本の形のままでは窓の外が尽きない");
  // 10:30 の回（c1・drain と優先つき）も数えると 35,420。
  assert.equal(projectCoverage7dLowerBound({ ...baseInput(), countFullRuns: true }).measuredLowerBound, 35_420);
});

test("見込みは赤になりうる: 全部の回が drain と優先つきなら 18,620、打ち切り率 10% でも 29,633 未満", () => {
  const allFull = projectCoverage7dLowerBound({
    ...baseInput(),
    runModes: ["full", "full", "full", "full", "full", "full", "full"],
    countFullRuns: true,
  });
  assert.equal(allFull.measuredLowerBound, 18_620);
  assert.equal(coverage7dMeetsTarget(allFull.measuredLowerBound, COVERAGE7D_BASELINE_2026_11_09.activeEndpoints), false);
  const abandoned = projectCoverage7dLowerBound({ ...baseInput(), abandonRate: 0.1 });
  assert.ok(abandoned.measuredLowerBound < COVERAGE7D_MEASURED_COUNT_TARGET, `${abandoned.measuredLowerBound}`);
  const slowDb = projectCoverage7dLowerBound({ ...baseInput(), laneHoldMs: 15_000 });
  assert.ok(slowDb.measuredLowerBound < COVERAGE7D_MEASURED_COUNT_TARGET, `保持 15 秒なら ${slowDb.measuredLowerBound}`);
  const narrow = projectCoverage7dLowerBound({ ...baseInput(), poolDomainSizes: [50_000, 6_000] });
  assert.ok(narrow.measuredLowerBound < COVERAGE7D_MEASURED_COUNT_TARGET, "ドメインが 2 つなら 2 レーンしか使えない");
});

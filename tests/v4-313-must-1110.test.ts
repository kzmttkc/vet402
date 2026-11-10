// 3.13 Must（11/10 S1-2 物差し、11/13 F4 判定初版）— specs_rest.md 準拠（2026-11-10）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { NextRequest } from "next/server";

import { buildGate2Report } from "@/lib/gate2/report";
import {
  DELIVERY_HIT_RATE_YARDSTICK_PATH,
  REPURCHASE_RESULTS_READ_NOT_BEFORE,
  applyMinSampleChange,
  loadDeliveryHitRateYardstick,
  validateMinSampleChangelog,
  validateYardstickAgainstRepurchaseBoundary,
} from "@/lib/v4/delivery-hit-rate-yardstick";
import {
  F4_TRAINING_SNAPSHOT_SOURCE,
  loadNamedBuyerTrainingRowsUpToSnapshot,
} from "@/lib/v4/f4-training-snapshot";
import { partitionLedgerByTimeSplit, type LedgerTimeSplitRow } from "@/lib/v4/ledger-time-split";
import {
  NAMED_BUYER_SCOPE_PHRASE_EN,
  NAMED_BUYER_SCOPE_PHRASE_JA,
  buildNamedBuyerDeliveryForecast,
  buildNamedBuyerDeliveryForecastFromPinnedSnapshot,
  trainingRowsOnOrBeforeSnapshot,
} from "@/lib/v4/named-buyer-delivery-forecast";
import { assertPublicEnglishSurface } from "@/lib/v4/public-english";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const FORBIDDEN_HIT_RATE_MARKETING = [
  "93.9%",
  "96.45%",
  "93.9",
  "96.45",
  "0.0597",
  "0.0355",
  "0.0348",
  "5300",
  "5,300",
];

function gitYardstickFirstCommitIso(): string {
  const raw = execSync(`git log --diff-filter=A --format=%cI -1 -- ${DELIVERY_HIT_RATE_YARDSTICK_PATH}`, {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  assert.ok(raw, "yardstick file must exist in git history");
  return new Date(raw).toISOString();
}

function gitLogSCommitterIso(needle: string, relPath: string): string {
  const raw = execSync(
    `git log -S ${JSON.stringify(needle)} --reverse --format=%cI -- ${relPath} | head -1`,
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  assert.ok(raw, `git must contain ${needle} in ${relPath}`);
  return new Date(raw).toISOString();
}

test("3.13-S1-2: 物差し JSON が存在し fixedAt と minSample と時間分割がある", () => {
  const doc = loadDeliveryHitRateYardstick();
  assert.equal(typeof doc.fixedAt, "string");
  assert.ok(doc.fixedAt.endsWith("Z"));
  assert.equal(typeof doc.documentFirstCommittedAt, "string");
  assert.equal(typeof doc.minSample, "number");
  assert.equal(doc.minSample, doc.minSampleInitial);
  assert.ok(doc.minSample > 0);
  assert.match(doc.minSampleRationale, /S1-2/);
  assert.equal(typeof doc.timeSplit.trainEndUtcDate, "string");
  assert.equal(typeof doc.timeSplit.evalStartUtcDate, "string");
  assert.ok(doc.timeSplit.evalStartUtcDate > doc.timeSplit.trainEndUtcDate);
  validateYardstickAgainstRepurchaseBoundary(doc);
});

test("3.13-S1-2: fixedAt は git 初出コミット以降かつ買い直し境界より前", () => {
  const doc = loadDeliveryHitRateYardstick();
  const raw = JSON.parse(read(DELIVERY_HIT_RATE_YARDSTICK_PATH)) as Record<string, unknown>;
  assert.equal("repurchaseResultsReadNotBefore" in raw, false);
  const gitFirst = gitYardstickFirstCommitIso();
  assert.equal(
    new Date(doc.documentFirstCommittedAt).toISOString(),
    gitFirst,
    "documentFirstCommittedAt must match git first commit",
  );
  const fixed = new Date(doc.fixedAt).getTime();
  const committed = new Date(doc.documentFirstCommittedAt).getTime();
  const notBefore = new Date(REPURCHASE_RESULTS_READ_NOT_BEFORE).getTime();
  assert.ok(fixed >= committed, "fixedAt must not precede document first commit");
  assert.ok(fixed < notBefore, "fixedAt must precede REPURCHASE_RESULTS_READ_NOT_BEFORE");
  assert.notEqual(doc.fixedAt, doc.fixedAtInitial);
  assert.ok(doc.fixedAtChangelog.length >= 1, "fixedAt move must be published in fixedAtChangelog");
  const fixedAtIntroduced = new Date(gitLogSCommitterIso(doc.fixedAt, DELIVERY_HIT_RATE_YARDSTICK_PATH)).getTime();
  assert.ok(fixed >= fixedAtIntroduced, "fixedAt must be on or after the commit that introduced this fixedAt value");
  assert.equal(doc.fixedAtChangelog[doc.fixedAtChangelog.length - 1]!.next, doc.fixedAt);
  for (const entry of doc.fixedAtChangelog) {
    const nextIntroduced = new Date(gitLogSCommitterIso(entry.next, DELIVERY_HIT_RATE_YARDSTICK_PATH)).getTime();
    assert.ok(
      new Date(entry.changedAt).getTime() >= nextIntroduced,
      `fixedAtChangelog changedAt must be on or after commit that introduced next ${entry.next}`,
    );
  }
});

test("3.13-S1-2: 買い直し境界は実装定数のみで S1-3 結果読取コミットは無い", () => {
  assert.equal(REPURCHASE_RESULTS_READ_NOT_BEFORE, "2026-11-11T00:00:00.000Z");
  const doc = loadDeliveryHitRateYardstick();
  const fixed = new Date(doc.fixedAt).getTime();
  const boundary = new Date(REPURCHASE_RESULTS_READ_NOT_BEFORE).getTime();
  assert.ok(fixed < boundary, "fixedAt must precede code repurchase-results boundary");
  const readResultTimes = execSync(
    'git log --grep="S1-3" --grep="repurchase results" --all-match --format=%cI -i',
    { cwd: ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (readResultTimes.length === 0) {
    assert.deepEqual(readResultTimes, [], "no commit reads S1-3 repurchase results yet");
    return;
  }
  for (const iso of readResultTimes) {
    assert.ok(fixed < new Date(iso).getTime(), `fixedAt must precede S1-3 results read commit at ${iso}`);
  }
});

test("3.13-S1-2: 台帳の時間分割が学習と評価に分かれる", () => {
  const doc = loadDeliveryHitRateYardstick();
  assert.equal(typeof doc.minSampleInitial, "number");
  assert.equal(doc.minSample, doc.minSampleInitial);
  const rows: LedgerTimeSplitRow[] = [
    { attemptedAt: "2026-10-07T23:59:59.000Z", delivered: true },
    { attemptedAt: "2026-10-08T12:00:00.000Z", delivered: true },
    { attemptedAt: "2026-10-09T00:00:00.000Z", delivered: false },
    { attemptedAt: "2026-11-01T00:00:00.000Z", delivered: true },
  ];
  const { train, eval: evalRows } = partitionLedgerByTimeSplit(rows, doc.timeSplit);
  assert.equal(train.length, 2);
  assert.equal(evalRows.length, 2);
  assert.ok(train.every((r) => r.attemptedAt.slice(0, 10) <= doc.timeSplit.trainEndUtcDate));
  assert.ok(evalRows.every((r) => r.attemptedAt.slice(0, 10) >= doc.timeSplit.evalStartUtcDate));
});

test("3.13-S1-2: buildGate2Report の judgementA/C を的中率欄に混ぜない（gate2 は PMF）", () => {
  const yardstickSrc = read("src/lib/v4/delivery-hit-rate-yardstick.ts");
  const gate2Src = read("src/lib/gate2/report.ts");
  assert.match(yardstickSrc, /validateMinSampleChangelog/);
  assert.match(yardstickSrc, /validateFixedAtChangelog/);
  assert.doesNotMatch(yardstickSrc, /buildGate2Report/);
  assert.doesNotMatch(gate2Src, /delivery-hit-rate-yardstick/);
  assert.doesNotMatch(gate2Src, /judgementA.*hitRate|hitRate.*judgementA/);
  assert.doesNotMatch(gate2Src, /judgementC[\s\S]*deliveryRate/);
});

test("3.13-S1-2: gate2 judgementB に purpose だけ足して PMF 週次表を完了にしない", () => {
  const gate2Src = read("src/lib/gate2/report.ts");
  assert.doesNotMatch(gate2Src, /pmf_weekly_external_api_usage/);
  assert.match(gate2Src, /judgementB:\s*\{\s*rows:/);
});

test("3.13-S1-2: 公開 API の物差しに V4 宣伝禁止数を載せない", async () => {
  const { GET } = await import("@/app/api/v1/v4/delivery-hit-rate-yardstick/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/v4/delivery-hit-rate-yardstick"));
  assert.equal(res.status, 200);
  const body = JSON.stringify(await res.json());
  for (const bad of FORBIDDEN_HIT_RATE_MARKETING) {
    assert.equal(body.includes(bad), false, `yardstick API must not include marketing figure ${bad}`);
  }
  assert.equal(body.includes("evalRowCountLowerBoundConfirmOnly"), false);
  assert.equal(body.includes("instrumentation"), false);
});

test("3.13-S1-2: minSample の変更は changelog に残す", () => {
  const doc = loadDeliveryHitRateYardstick();
  validateMinSampleChangelog(doc);
  for (const entry of doc.minSampleChangelog) {
    assert.equal(typeof entry.changedAt, "string");
    assert.equal(typeof entry.previous, "number");
    assert.equal(typeof entry.next, "number");
    assert.notEqual(entry.previous, entry.next);
  }
  const bumped = { ...doc, minSample: doc.minSampleInitial + 1, minSampleChangelog: [] as typeof doc.minSampleChangelog };
  assert.throws(() => validateMinSampleChangelog(bumped), /without a published changelog/);
  const withLog = applyMinSampleChange(doc, doc.minSampleInitial + 1, "2026-11-10T13:00:00.000Z", "test");
  assert.doesNotThrow(() => validateMinSampleChangelog(withLog));
});

test("3.13-F4: 日本語の名乗る買い手限定句が無い予測は不可", () => {
  const rows = trainingRowsOnOrBeforeSnapshot(
    [{ attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true }],
    "2026-11-09",
  );
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/a",
    trainingRows: rows,
  });
  assert.ok(out.text.startsWith(`${NAMED_BUYER_SCOPE_PHRASE_JA}。`));
  const englishOnly = out.text.replace(`${NAMED_BUYER_SCOPE_PHRASE_JA}。`, "");
  assert.equal(englishOnly.includes(NAMED_BUYER_SCOPE_PHRASE_JA), false);
  assert.ok(englishOnly.includes(NAMED_BUYER_SCOPE_PHRASE_EN));
});

test("3.13-F4: 予測文に名乗る買い手の限定句がある", () => {
  const rows = trainingRowsOnOrBeforeSnapshot(
    [
      { attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true },
      { attemptedAt: "2026-11-10T00:00:00.000Z", resourceKey: "host/a", delivered: false },
    ],
    "2026-11-09",
  );
  assert.equal(rows.length, 1);
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/a",
    trainingRows: rows,
  });
  assert.ok(out.text.includes(NAMED_BUYER_SCOPE_PHRASE_JA), "forecast must include Japanese scope phrase");
  assert.ok(out.text.includes(NAMED_BUYER_SCOPE_PHRASE_EN));
  assert.equal(out.snapshotDate, "2026-11-09");
  assert.equal(out.trainingSnapshotSource, F4_TRAINING_SNAPSHOT_SOURCE);
  assertPublicEnglishSurface(out.text.replace(`${NAMED_BUYER_SCOPE_PHRASE_JA}。`, ""));
});

test("3.13-F4: スナップショット日より後の行を学習に混ぜない", () => {
  const all = [
    { attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true },
    { attemptedAt: "2026-11-10T00:00:00.000Z", resourceKey: "host/a", delivered: false },
  ];
  assert.throws(
    () =>
      buildNamedBuyerDeliveryForecast({
        snapshotDate: "2026-11-09",
        resourceKey: "host/a",
        trainingRows: all,
      }),
    /after snapshot/i,
  );
  const routeSrc = read("src/app/api/v1/v4/named-buyer-delivery-forecast/route.ts");
  assert.doesNotMatch(routeSrc, /buildNamedBuyerDeliveryForecastFromFixture|f4-named-buyer-training-fixture/);
  const pinned = loadNamedBuyerTrainingRowsUpToSnapshot("2026-10-19");
  assert.ok(pinned.length >= 1);
  assert.ok(pinned.every((r) => r.attemptedAt.slice(0, 10) <= "2026-10-19"));
});

test("3.13-F4: decidePayer の別名にしない", () => {
  const src = read("src/lib/v4/named-buyer-delivery-forecast.ts");
  assert.doesNotMatch(src, /decidePayer|buildDecision/);
  assert.doesNotMatch(src, /f4-named-buyer-training-fixture/);
});

test("3.13-F4: V4 宣伝禁止の正解率を予測の的中率として書かない", () => {
  const rows = trainingRowsOnOrBeforeSnapshot(
    [{ attemptedAt: "2026-11-08T00:00:00.000Z", resourceKey: "host/a", delivered: true }],
    "2026-11-09",
  );
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/a",
    trainingRows: rows,
  });
  assert.ok(
    out.text.includes(NAMED_BUYER_SCOPE_PHRASE_JA),
    "F4 v1 forecast must include the Japanese scope phrase, not English-only scope",
  );
  const serialized = JSON.stringify(out);
  for (const bad of FORBIDDEN_HIT_RATE_MARKETING) {
    assert.equal(serialized.includes(bad), false);
  }
});

test("3.13-F4: 公開 forecast API が scope と snapshotDate を返す", async () => {
  const { GET } = await import("@/app/api/v1/v4/named-buyer-delivery-forecast/route");
  const resourceKey = "agent402.tools/api/skill/domain-intel";
  const res = await GET(
    new NextRequest(
      `http://localhost/api/v1/v4/named-buyer-delivery-forecast?snapshotDate=2026-10-19&resourceKey=${encodeURIComponent(resourceKey)}`,
    ),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.snapshotDate, "2026-10-19");
  assert.equal(body.trainingSnapshotSource, F4_TRAINING_SNAPSHOT_SOURCE);
  assert.ok(String(body.text).includes(NAMED_BUYER_SCOPE_PHRASE_JA));
  assert.ok(String(body.text).includes(NAMED_BUYER_SCOPE_PHRASE_EN));
  assert.ok(body.trainCount >= 1);
  assert.equal(body.deliveryRate, null);
  assert.equal(String(body.text).includes("100.0%"), false);
  assert.match(String(body.text), /below minSample 100/);
});

test("3.13-F4: Stellar 日次スナップショットから学習行を読む", () => {
  const out = buildNamedBuyerDeliveryForecastFromPinnedSnapshot(
    "2026-10-19",
    "agent402.tools/api/skill/domain-intel",
  );
  assert.equal(out.trainCount, 1);
  assert.equal(out.trainDelivered, 1);
  assert.equal(out.deliveryRate, null);
  assert.equal(out.text.includes("100.0%"), false);
  assert.match(out.text, /below minSample/);
});

test("3.13-F4: minSample 未満では deliveryRate を公開しない", () => {
  const doc = loadDeliveryHitRateYardstick();
  const rows = Array.from({ length: doc.minSample - 1 }, (_, i) => ({
    attemptedAt: `2026-11-0${(i % 8) + 1}T00:00:00.000Z`,
    resourceKey: "host/b",
    delivered: i % 2 === 0,
  }));
  const out = buildNamedBuyerDeliveryForecast({
    snapshotDate: "2026-11-09",
    resourceKey: "host/b",
    trainingRows: rows,
  });
  assert.equal(out.trainCount, doc.minSample - 1);
  assert.equal(out.deliveryRate, null);
  assert.match(out.text, /below minSample/);
  assert.doesNotMatch(out.text, /Estimated delivery rate \d/);
});

test("3.13: 正典パスがリポに存在する", () => {
  read(DELIVERY_HIT_RATE_YARDSTICK_PATH);
  read("src/lib/v4/f4-training-snapshot.ts");
  const forecastSrc = read("src/lib/v4/named-buyer-delivery-forecast.ts");
  assert.match(forecastSrc, /buildNamedBuyerDeliveryForecastFromPinnedSnapshot/);
  assert.match(forecastSrc, /f4-training-snapshot/);
  assert.ok(read("content/drafts/v4-methodology-rewrite-1116.md").includes("approval"));
});

test("3.13: buildGate2Report の形は維持する", async () => {
  assert.equal(typeof buildGate2Report, "function");
  const gate2Src = read("src/lib/gate2/report.ts");
  assert.match(gate2Src, /judgementA:\s*\{[\s\S]*externalSignups/);
  assert.doesNotMatch(gate2Src, /judgementB:[\s\S]*purpose:/);
});

test("3.13-S1-2: 新規公開英語に hit-rate 複合語を置かない", () => {
  const openapi = read("docs/openapi.yaml");
  const apiPage = read("src/app/docs/api/page.tsx");
  const doc = loadDeliveryHitRateYardstick();
  const yardstickSlice = openapi.slice(
    openapi.indexOf("summary: Pre-registered delivery hit"),
    openapi.indexOf("/api/v1/v4/named-buyer-delivery-forecast"),
  );
  const noteMatch = apiPage.match(/note: "(Pre-registered delivery hit[^"]+)"/);
  assert.ok(noteMatch, "api docs page must describe yardstick note");
  for (const chunk of [yardstickSlice, noteMatch![1]!, doc.minSampleRationale]) {
    assert.equal(/\bhit-rate\b/i.test(chunk), false, "public copy must use hit rate not hit-rate");
    assertPublicEnglishSurface(chunk);
  }
});

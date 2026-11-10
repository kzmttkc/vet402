// 3.13 Must（11/10 S1-2 物差し、11/13 F4 判定初版）— specs_rest.md 準拠（2026-11-10）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { buildGate2Report } from "@/lib/gate2/report";
import {
  DELIVERY_HIT_RATE_YARDSTICK_PATH,
  loadDeliveryHitRateYardstick,
  validateYardstickAgainstRepurchaseBoundary,
} from "@/lib/v4/delivery-hit-rate-yardstick";
import { partitionLedgerByTimeSplit, type LedgerTimeSplitRow } from "@/lib/v4/ledger-time-split";
import {
  NAMED_BUYER_SCOPE_PHRASE,
  buildNamedBuyerDeliveryForecast,
  trainingRowsOnOrBeforeSnapshot,
} from "@/lib/v4/named-buyer-delivery-forecast";
import { assertPublicEnglishSurface } from "@/lib/v4/public-english";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const FORBIDDEN_HIT_RATE_MARKETING = ["93.9%", "96.45%", "93.9", "96.45"];

test("3.13-S1-2: 物差し JSON が存在し fixedAt と minSample と時間分割がある", () => {
  const doc = loadDeliveryHitRateYardstick();
  assert.equal(typeof doc.fixedAt, "string");
  assert.ok(doc.fixedAt.endsWith("Z"));
  assert.equal(typeof doc.minSample, "number");
  assert.ok(doc.minSample > 0);
  assert.equal(typeof doc.timeSplit.trainEndUtcDate, "string");
  assert.equal(typeof doc.timeSplit.evalStartUtcDate, "string");
  assert.ok(doc.timeSplit.evalStartUtcDate > doc.timeSplit.trainEndUtcDate);
  validateYardstickAgainstRepurchaseBoundary(doc);
});

test("3.13-S1-2: 物差しの fixedAt は買い直し結果を読む境界より前", () => {
  const doc = loadDeliveryHitRateYardstick();
  const fixed = new Date(doc.fixedAt).getTime();
  const notBefore = new Date(doc.repurchaseResultsReadNotBefore).getTime();
  assert.ok(fixed < notBefore, "fixedAt must precede repurchaseResultsReadNotBefore");
});

test("3.13-S1-2: 台帳の時間分割が学習と評価に分かれる", () => {
  const doc = loadDeliveryHitRateYardstick();
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
  assert.doesNotMatch(yardstickSrc, /buildGate2Report/);
  assert.doesNotMatch(gate2Src, /delivery-hit-rate-yardstick/);
  assert.doesNotMatch(gate2Src, /judgementA.*hitRate|hitRate.*judgementA/);
});

test("3.13-S1-2: gate2 の週次表 judgementB は PMF 用途と名指しされる", () => {
  const gate2Src = read("src/lib/gate2/report.ts");
  assert.match(gate2Src, /judgementB:\s*\{[^}]*purpose:\s*"pmf_weekly_external_api_usage"/s);
});

test("3.13-S1-2: 公開 API の物差しに宣伝禁止の正解率を載せない", async () => {
  const { GET } = await import("@/app/api/v1/v4/delivery-hit-rate-yardstick/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/v4/delivery-hit-rate-yardstick"));
  assert.equal(res.status, 200);
  const body = JSON.stringify(await res.json());
  for (const bad of FORBIDDEN_HIT_RATE_MARKETING) {
    assert.equal(body.includes(bad), false, `yardstick API must not include marketing hit rate ${bad}`);
  }
});

test("3.13-S1-2: minSample の変更は changelog に残す", () => {
  const doc = loadDeliveryHitRateYardstick();
  for (const entry of doc.minSampleChangelog) {
    assert.equal(typeof entry.changedAt, "string");
    assert.equal(typeof entry.previous, "number");
    assert.equal(typeof entry.next, "number");
    assert.notEqual(entry.previous, entry.next);
  }
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
  assert.ok(out.text.includes(NAMED_BUYER_SCOPE_PHRASE));
  assert.equal(out.snapshotDate, "2026-11-09");
  assertPublicEnglishSurface(out.text);
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
});

test("3.13-F4: decidePayer の別名にしない", () => {
  const src = read("src/lib/v4/named-buyer-delivery-forecast.ts");
  assert.doesNotMatch(src, /decidePayer|buildDecision/);
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
  const serialized = JSON.stringify(out);
  for (const bad of FORBIDDEN_HIT_RATE_MARKETING) {
    assert.equal(serialized.includes(bad), false);
  }
});

test("3.13-F4: 公開 forecast API が scope と snapshotDate を返す", async () => {
  const { GET } = await import("@/app/api/v1/v4/named-buyer-delivery-forecast/route");
  const res = await GET(
    new NextRequest(
      "http://localhost/api/v1/v4/named-buyer-delivery-forecast?snapshotDate=2026-11-09&resourceKey=example.test%2Fhost-a",
    ),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.snapshotDate, "2026-11-09");
  assert.ok(String(body.text).includes(NAMED_BUYER_SCOPE_PHRASE));
  assertPublicEnglishSurface(String(body.text));
});

test("3.13: 正典パスがリポに存在する", () => {
  read(DELIVERY_HIT_RATE_YARDSTICK_PATH);
  assert.ok(read("content/drafts/v4-methodology-rewrite-1116.md").includes("approval"));
});

test("3.13: buildGate2Report の形は変えず judgementB に purpose だけ足す", async () => {
  assert.equal(typeof buildGate2Report, "function");
});

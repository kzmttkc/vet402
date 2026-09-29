// ============================================================
// 2026-09-29 監査 6 周目（整合性の監査人）の中・低。同じ数・同じ語が面ごとに違って見えた所を固定する。
//   1. 丸めは 1 か所（src/lib/util/pct.ts）: /observatory の判定バーが 61.1%、/state が 61.0% だった
//   2. /accuracy の窓は「past 168 hours to <時刻> UTC」（SQL は now() - interval '7 days'）
//   3. llms.txt / llms-full.txt の Freshness 節は各 route の Cache-Control から最大の古さを出す
//   4. held（vet402 の保留）と awaiting on-chain verification（照合待ち）を公開面の語で分ける
//   5. /impact と /state の「final outcome」を別の名前に
//   6. /corrections の JST を UTC に
//   7. anchors・coverage の日付は UTC を明示（計算結果の同一性は audit-r6-consistency.pg.test.ts）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pct1, formatPct1 } from "@/lib/util/pct";
import { shareSegments } from "@/lib/figures/share";
import { pct1 as deliveredPct1 } from "@/lib/observatory/delivered-rates";
import {
  FRESHNESS_LEAD,
  PUBLIC_FRESHNESS,
  freshnessLines,
  humanDuration,
  maxStaleSecondsOf,
} from "@/lib/observatory/freshness";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { DECISION_CACHE_TTL_MS } from "@/lib/decision/cache";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("1. 判定バーの % は /state と同じ丸め（残りを最大の段へ寄せない）", () => {
  // 旧実装: 61.0 + 0.2 + 38.7 = 99.9 → 残り 0.1 を pass へ寄せて 61.1% と出していた
  const counts = [
    { key: "pass", n: 21_268 },
    { key: "fail", n: 81 },
    { key: "unverified", n: 13_491 },
  ];
  const total = 34_840;
  const segs = shareSegments(counts);
  for (const s of segs) assert.equal(s.pct, pct1(s.n, total), `${s.key} の % が pct1 と違う`);
  assert.equal(segs[0].pct, 61);
  assert.equal(formatPct1(21_268, total), "61.0%");
  // 描画幅は合計 100 のまま
  assert.equal(Math.round(segs.reduce((a, s) => a + s.widthPct, 0) * 100) / 100, 100);
  // delivered-rates の pct1 は同じ関数
  assert.equal(deliveredPct1, pct1);
  assert.equal(formatPct1(1, 0), "—");
});

test("1. 公開面は % を自前で丸めない（pct.ts を通す）", () => {
  for (const f of [
    "src/app/observatory/state/page.tsx",
    "src/app/page.tsx",
    "src/app/accuracy/page.tsx",
    "src/app/impact/page.tsx",
    "src/components/site/Figures.tsx",
  ]) {
    assert.doesNotMatch(read(f), /\*\s*100\)\.toFixed\(1\)/, `${f} が % を toFixed で丸めている`);
  }
  assert.doesNotMatch(read("src/lib/figures/share.ts"), /drift/);
});

test("2. /accuracy の窓は 168 時間と終わりの時刻で書く", () => {
  const page = read("src/app/accuracy/page.tsx");
  assert.doesNotMatch(page, /7 days to \{generatedOn\}/);
  assert.ok(page.includes("past 168 hours to {generatedAt}"));
  // 計算は変えていない（SQL は now() - interval '7 days' のまま）
  assert.ok(read("src/lib/scoring/l0-accuracy.ts").includes("attempted_at > now() - interval '7 days'"));
});

test("3. Freshness の表は各 route の Cache-Control と一致する", () => {
  for (const row of PUBLIC_FRESHNESS) {
    if (row.cacheControl) {
      for (const src of row.sources) {
        assert.ok(read(src).includes(row.cacheControl), `${src} に ${row.cacheControl} が無い（表と route がずれた）`);
      }
      assert.equal(row.maxStaleSec, maxStaleSecondsOf(row.cacheControl));
    }
  }
  assert.equal(maxStaleSecondsOf("public, s-maxage=900, stale-while-revalidate=1800"), 2700);
  assert.equal(maxStaleSecondsOf("public, max-age=3600"), 3600);
  assert.equal(humanDuration(2700), "45 minutes");
  assert.equal(humanDuration(10_800), "3 hours");
  // Cache-Control を持たない 2 面は定数から
  const html = PUBLIC_FRESHNESS.find((r) => r.sources.includes("src/lib/observatory/public-read-revalidate.ts"))!;
  assert.equal(html.maxStaleSec, PUBLIC_READ_REVALIDATE);
  const decision = PUBLIC_FRESHNESS.find((r) => r.sources.includes("src/lib/decision/cache.ts"))!;
  assert.equal(decision.maxStaleSec * 1000, DECISION_CACHE_TTL_MS);
  // state は 45 分（s-maxage の 15 分だけではない）
  const state = PUBLIC_FRESHNESS.find((r) => r.surface.includes("/api/v1/observatory/state"))!;
  assert.equal(state.maxStaleSec, 45 * 60);
});

test("3. Freshness の表の Cache-Control を持つ route は、全部この表に載っている（observatory・sellers・accuracy）", () => {
  const listed = new Set(PUBLIC_FRESHNESS.flatMap((r) => r.sources));
  for (const f of [
    "src/app/api/v1/observatory/state/route.ts",
    "src/app/api/v1/observatory/decisions/route.ts",
    "src/app/api/v1/observatory/export.csv/route.ts",
    "src/app/api/v1/observatory/history/route.ts",
    "src/app/api/v1/observatory/anchors/route.ts",
    "src/app/api/v1/observatory/backtest/route.ts",
    "src/app/api/v1/observatory/concentration/route.ts",
    "src/app/api/v1/observatory/l0/export.csv/route.ts",
    "src/app/api/v1/sellers/export.csv/route.ts",
    "src/app/api/v1/accuracy/route.ts",
  ]) {
    assert.ok(listed.has(f), `${f} が Freshness の表に無い`);
  }
});

test("3. llms.txt と llms-full.txt は同じ Freshness の行を載せ、「15 分」とは言わない", async () => {
  const llms = read("public/llms.txt");
  assert.ok(llms.includes(FRESHNESS_LEAD), "llms.txt に Freshness の前文が無い");
  for (const line of freshnessLines()) assert.ok(llms.includes(line), `llms.txt に次の行が無い: ${line}`);
  assert.doesNotMatch(llms, /cached up to 15 minutes/);
  assert.doesNotMatch(llms, /for up to 15 minutes \(`s-maxage=900`\)/);
  const { GET } = await import("@/app/llms-full.txt/route");
  const full = await GET().text();
  assert.ok(full.includes("## Freshness"));
  for (const line of freshnessLines()) assert.ok(full.includes(line), `llms-full.txt に次の行が無い: ${line}`);
});

test("4. held（vet402 の保留）と awaiting on-chain verification（照合待ち）を分けて書く", () => {
  const llms = read("public/llms.txt");
  assert.ok(llms.includes("`l1_not_counted_held`"), "llms.txt が l1_not_counted_held の中身を説明していない");
  assert.match(llms, /`l1_not_counted_held`[^.]*counts both kinds together/);
  assert.ok(llms.includes("it is empty on a row awaiting on-chain verification (`settle_claimed`)"));
  const state = read("src/app/observatory/state/page.tsx");
  assert.ok(state.includes("Awaiting on-chain verification"));
  assert.ok(state.includes("vet402&apos;s hold"));
  assert.ok(state.includes("<code>l1_not_counted_held</code> covers both"));
});

test("5. /impact と /state は「final outcome」を別の名前で呼ぶ", () => {
  const impact = read("src/app/impact/page.tsx");
  const state = read("src/app/observatory/state/page.tsx");
  assert.ok(impact.includes("signed attempts with a final status"));
  assert.ok(state.includes("of attempts counted in the delivery rate"));
  for (const [name, src] of [
    ["impact", impact],
    ["state", state],
  ] as const) {
    assert.doesNotMatch(src, /final(,)? (counted )?outcome/, `${name} に final outcome が残っている`);
  }
});

test("6. /corrections は UTC で書く", () => {
  const page = read("src/app/corrections/page.tsx");
  assert.doesNotMatch(page, /\bJST\b/);
  assert.ok(page.includes("2026-09-02 03:51 UTC"));
});

test("7. anchors・coverage の日付は接続の TimeZone に依らない", () => {
  const anchors = read("src/lib/observatory/anchors.ts");
  assert.doesNotMatch(anchors, /attempted_at [<>]=? \$\{day\}::date/);
  assert.ok(anchors.includes("utcDayStartOf(day)"));
  const coverage = read("src/lib/observatory/coverage.ts");
  assert.doesNotMatch(coverage, /d\.day > \(current_date/);
});

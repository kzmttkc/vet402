// ============================================================
// 監査 E「数字の出所と分母の混在」＋表示層（2026-09-04）。
//
// 同じ「attempts」が 4 つの API で 4 値（state 3,019 / decisions 3,060 / history 2,689 /
// export 3,151）だった。表示側の正典は /api/v1/observatory/state の l1.attempts と決め、
// 数字の隣に分母と出所を書く。ここはその文言と形をソースで固定する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { L1Ratio, ProbeTimeline } from "@/components/site/Figures";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ---- 1. 分母ラベル ------------------------------------------------------

test("LP Fig.1: first stage is 'Endpoints on record' and the caption says it includes delisted", () => {
  const home = read("src/app/page.tsx");
  const fig = home.slice(home.indexOf("<FunnelFigure"), home.indexOf("</FunnelFigure>") > 0 ? home.indexOf("</FunnelFigure>") : home.indexOf("/>", home.indexOf("<FunnelFigure")));
  assert.ok(!home.includes('label: "Catalog endpoints"'), "the old label is gone");
  assert.ok(home.includes('label: "Endpoints on record"'), "the first stage names the denominator");
  assert.match(fig, /includes delisted/, "caption states that on record includes delisted");
  assert.match(fig, /activeEndpoints/, "caption prints the active count next to it");
});

test("observatory doc-head names fetched vs catalog total in words", () => {
  const page = read("src/app/observatory/page.tsx");
  const head = page.slice(page.indexOf('className="doc-head"'), page.indexOf("doc-title"));
  assert.match(head, /fetched/, "the first number is called fetched");
  assert.match(head, /of catalog/, "the second number is called the catalog total");
  // fetched > total の理由（重複 URL の正規化前の生件数）が本文で読める
  assert.match(page, /before duplicate/i);
});

test("State §3: attempts-denominator and endpoints-denominator rows carry different labels", () => {
  const page = read("src/app/observatory/state/page.tsx");
  const s3 = page.slice(page.indexOf("L1 covert-purchase measurements"), page.indexOf("Listing-change events observed"));
  assert.match(s3, /share of attempts/i, "settled row names its denominator");
  assert.match(s3, /share of endpoints purchased from/i, "endpoints-settled row names its denominator");
});

test("State §5: the anchor entry count is that day's, not 'over N entries'", () => {
  const page = read("src/app/observatory/state/page.tsx");
  assert.ok(!page.includes("covering{"), "old 'covering N entries' wording is gone");
  assert.match(page, /that day&apos;s|that day's/);
});

test("attempts figures cite /api/v1/observatory/state as their source on every page that prints them", () => {
  for (const rel of ["src/app/impact/page.tsx", "src/app/observatory/state/page.tsx", "src/app/observatory/page.tsx"]) {
    const src = read(rel);
    assert.match(src, /as reported by/, `${rel} states the source`);
    assert.ok(src.includes("/api/v1/observatory/state"), `${rel} names the state API`);
  }
});

test("impact §3: the backtest attempt count carries its own definition so it is not read as the L1 total", () => {
  const page = read("src/app/impact/page.tsx");
  assert.match(page, /definition:/);
});

// ---- 2. settled / delivered の併記 ---------------------------------------

test("L1Ratio: without delivered it renders settled/attempts unchanged", () => {
  const html = renderToStaticMarkup(createElement(L1Ratio, { settled: 3, attempts: 5 }));
  assert.match(html, />3\/5</);
  assert.doesNotMatch(html, /·/);
});

test("L1Ratio: with delivered it renders 'delivered · settled / attempts'", () => {
  const html = renderToStaticMarkup(createElement(L1Ratio, { settled: 3, attempts: 5, delivered: 4 }));
  assert.match(html, /4/);
  assert.match(html, /·/);
  assert.match(html, /3\/5/);
  assert.match(html, /title="[^"]*delivered[^"]*"/, "the cell explains its three numbers");
});

test("L1Ratio: no attempts is a dash, never 0/0", () => {
  const html = renderToStaticMarkup(createElement(L1Ratio, { settled: 0, attempts: 0 }));
  assert.doesNotMatch(html, /0\/0/);
});

test("observatory list row type reads l1Delivered as optional (correction B fills it)", () => {
  const reader = read("src/lib/observatory/reader.ts");
  assert.match(reader, /l1Delivered\?: number/);
  const page = read("src/app/observatory/page.tsx");
  assert.ok(page.includes("<L1Ratio"), "the L1 cell goes through L1Ratio");
  assert.ok(page.includes("delivered={row.l1Delivered}"));
});

// ---- 3. 時間軸: 同日 2 回のプローブも 2 段に載る -------------------------

test("ProbeTimeline: two probes on the same day (6 h apart in a 30-day span) sit on different lanes", () => {
  const html = renderToStaticMarkup(
    createElement(ProbeTimeline, {
      n: 1,
      probes: [
        { at: new Date("2026-08-04T00:00:00Z"), verdict: "pass" },
        { at: new Date("2026-09-03T04:00:00Z"), verdict: "pass" },
        { at: new Date("2026-09-03T10:00:00Z"), verdict: "pass" },
      ],
      caption: "c",
    }),
  );
  const tops = [...html.matchAll(/class="absolute top-\[(\d+)px\]/g)].map((m) => Number(m[1]));
  assert.equal(tops.length, 3);
  assert.notEqual(tops[1], tops[2]);
});

// ---- 4. /accuracy: 空の台帳に見えないように観測所の実数を出す ------------

test("/accuracy prints the observatory's live counts from the state API when all three tables are empty", () => {
  const page = read("src/app/accuracy/page.tsx");
  assert.ok(page.includes("/api/v1/observatory/state"), "numbers come from the state API");
  assert.match(page, /!hasAnyData && !hasBenchmarkData/, "shown only when every table is empty");
  assert.match(page, /l1\.attempts/);
  assert.match(page, /l1\.settled/);
});

// ---- 5. 390px の購入表: Attempted / Result / HTTP を先頭 3 列に -----------

test("endpoint purchase table leads with Attempted / Result / HTTP, receipt fourth", () => {
  const page = read("src/app/observatory/e/[id]/page.tsx");
  const table = page.slice(page.indexOf("L1 purchase history, newest first"), page.indexOf("</thead>", page.indexOf("L1 purchase history, newest first")));
  const order = [...table.matchAll(/<th scope="col"[^>]*>\s*([^<]+?)\s*<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(order.slice(0, 4), ["Attempted at", "Result", "HTTP", "Receipt (tx)"]);
});

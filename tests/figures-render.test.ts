// ============================================================
// Figures.tsx の描画（2026-09-02 デザイン監査 P2）。図は「測った数字」を形にする
// ものなので、形の規則が崩れたら数字の読みが変わる——ここで固定する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VerdictShareBar, FunnelFigure, ProbeTimeline } from "@/components/site/Figures";

const hrefs = { pass: "/observatory?verdict=pass", fail: "/observatory?verdict=fail", unverified: "/observatory?verdict=unverified" };

test("VerdictShareBar: fail 段は斜線ハッチ（塗りではなく pattern）で描く", () => {
  const html = renderToStaticMarkup(
    createElement(VerdictShareBar, { n: 1, counts: { pass: 3342, fail: 5, unverified: 17117 }, hrefs, active: null, caption: "c" }),
  );
  assert.match(html, /<pattern[^>]*id="[^"]*fail[^"]*"/, "a hatch pattern is defined");
  assert.match(html, /fill="url\(#[^"]*fail[^"]*\)"/, "the fail segment is filled with it");
});

test("VerdictShareBar: 最小幅で膨らんだ段があるときだけ注記を出す", () => {
  const inflated = renderToStaticMarkup(
    createElement(VerdictShareBar, { n: 1, counts: { pass: 3342, fail: 5, unverified: 17117 }, hrefs, active: null, caption: "c" }),
  );
  assert.match(inflated, /segments under 1\.5% are drawn at 1\.5%/);
  const even = renderToStaticMarkup(
    createElement(VerdictShareBar, { n: 1, counts: { pass: 10, fail: 10, unverified: 10 }, hrefs, active: null, caption: "c" }),
  );
  assert.doesNotMatch(even, /drawn at 1\.5%/);
});

test("VerdictShareBar: 凡例リンクは hover で brand-deep へ", () => {
  const html = renderToStaticMarkup(
    createElement(VerdictShareBar, { n: 1, counts: { pass: 1, fail: 1, unverified: 1 }, hrefs, active: null, caption: "c" }),
  );
  assert.match(html, /<a [^>]*class="[^"]*hover:text-brand-deep/);
});

test("figcaption の measure は 72ch", () => {
  const html = renderToStaticMarkup(
    createElement(VerdictShareBar, { n: 1, counts: { pass: 1, fail: 1, unverified: 1 }, hrefs, active: null, caption: "c" }),
  );
  assert.match(html, /<figcaption class="[^"]*max-w-\[72ch\]/);
});

test("FunnelFigure: 1 段目は枠のみ（unverified の hair 塗りと二義にならない）", () => {
  const html = renderToStaticMarkup(
    createElement(FunnelFigure, { n: 3, stages: [{ label: "a", n: 100 }, { label: "b", n: 50 }], caption: "c" }),
  );
  const firstSvg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
  assert.doesNotMatch(firstSvg, /fill="#dfe3e9"/, "no hair fill on stage 1");
  assert.match(firstSvg, /fill="none"/);
});

test("ProbeTimeline: 記号幅より近い 2 点は縦に 1 段ずらす", () => {
  const html = renderToStaticMarkup(
    createElement(ProbeTimeline, {
      n: 2,
      probes: [
        { at: new Date("2026-08-01T00:00:00Z"), verdict: "pass" },
        { at: new Date("2026-09-01T23:40:00Z"), verdict: "pass" },
        { at: new Date("2026-09-02T05:40:00Z"), verdict: "fail" },
      ],
      caption: "c",
    }),
  );
  const tops = [...html.matchAll(/class="absolute top-\[(\d+)px\]/g)].map((m) => Number(m[1]));
  assert.equal(tops.length, 3);
  assert.notEqual(tops[1], tops[2], "the two overlapping marks sit on different lanes");
  assert.equal(tops[0], tops[1], "the isolated mark shares the base lane");
});

test("VerdictShareBar: legendExtra は凡例の行の中に描かれる（[receipts N] の置き場）", () => {
  const html = renderToStaticMarkup(
    createElement(VerdictShareBar, {
      n: 1,
      counts: { pass: 1, fail: 1, unverified: 1 },
      hrefs,
      active: null,
      caption: "c",
      legendExtra: createElement("a", { href: "/observatory?l1=1" }, "[receipts 12]"),
    }),
  );
  const legend = html.slice(html.indexOf("<p"), html.indexOf("</p>"));
  assert.match(legend, /\[receipts 12\]/);
});

// 帯の4段は、どの頁・どの絞り込みでも、その表示の総数と一致する。
// /observatory の pass 割合は /observatory/state と同じ分母（totalEndpoints）になる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VerdictShareBar } from "@/components/site/Figures";
import { l0BandFromStats, l0BandFromVerdictCounts, type L0Band, type L0BandCounts } from "@/lib/observatory/l0-band";

const HREFS = {
  pass: "/observatory?verdict=pass",
  fail: "/observatory?verdict=fail",
  unverified: "/observatory?verdict=unverified",
  withdrawn: "/observatory?verdict=withdrawn",
};

const CHIPS = [null, "pass", "fail", "unverified", "withdrawn"] as const;

const SCOPES: { name: string; counts: L0BandCounts }[] = [
  { name: "search", counts: { pass: 10, fail: 2, unverified: 3, withdrawn: 5 } },
  { name: "network", counts: { pass: 100, fail: 0, unverified: 0, withdrawn: 1 } },
  { name: "settled", counts: { pass: 4, fail: 1, unverified: 0, withdrawn: 0 } },
  { name: "empty", counts: { pass: 0, fail: 0, unverified: 0, withdrawn: 0 } },
];

function digits(raw: string): number {
  return Number(raw.replace(/[^\d]/g, ""));
}

function renderedBand(band: L0Band, active: (typeof CHIPS)[number]): string {
  return renderToStaticMarkup(
    createElement(VerdictShareBar, {
      n: 1,
      counts: band.counts,
      hrefs: HREFS,
      active,
      caption: `${band.total.toLocaleString()} endpoints`,
    }),
  );
}

function legendNumbers(html: string): { key: string; n: number; pct: number }[] {
  return [...html.matchAll(/>(pass|fail|unverified|withdrawn) ([0-9][0-9,]*)<span[^>]*>\(([0-9.]+)%\)/g)].map((m) => ({
    key: m[1]!,
    n: digits(m[2]!),
    pct: Number(m[3]),
  }));
}

test("絞り込み無しの pass 割合は /observatory と /observatory/state で同じ", () => {
  const stats = {
    publishedPass: 59525,
    publishedFail: 2483,
    publishedUnverified: 19038,
    withdrawnFail: 4893,
    totalEndpoints: 85939,
  };
  const band = l0BandFromStats(stats);
  assert.equal(band.total, stats.totalEndpoints);
  assert.equal(band.counts.pass + band.counts.fail + band.counts.unverified + band.counts.withdrawn, band.total);
  assert.equal(band.passShare, band.statePassShare);
  const html = renderedBand(band, null);
  const legend = legendNumbers(html);
  assert.deepEqual(legend.map((row) => row.key), ["pass", "fail", "unverified", "withdrawn"]);
  assert.equal(legend.reduce((n, row) => n + row.n, 0), band.total);
  assert.equal(legend[0]?.pct, band.passShare);
  assert.equal(legend[0]?.pct, band.statePassShare);
});

for (const scope of SCOPES) {
  for (const chip of CHIPS) {
    test(`${scope.name} / verdict=${chip ?? "any"}: 帯の4段の合計が表示の総数`, () => {
      const band = l0BandFromVerdictCounts(scope.counts, chip);
      assert.deepEqual(band.counts, scope.counts);
      const expected = scope.counts.pass + scope.counts.fail + scope.counts.unverified + scope.counts.withdrawn;
      assert.equal(band.total, expected);
      const html = renderedBand(band, chip);
      const legend = legendNumbers(html);
      assert.equal(legend.length, 4);
      assert.equal(legend.reduce((n, row) => n + row.n, 0), band.total);
      const label = html.match(/aria-label="([^"]+)"/)?.[1] ?? "";
      const aria = [...label.matchAll(/(pass|fail|unverified|withdrawn) ([0-9][0-9,]*)/g)];
      assert.equal(aria.length, 4);
      assert.equal(aria.reduce((n, m) => n + digits(m[2]!), 0), band.total);
      if (band.total > 0) assert.equal(legend.find((row) => row.key === "pass")?.pct, band.passShare);
    });
  }
}

test("withdrawn 段は既存の霧色で、新しい色を足さない", () => {
  const band = l0BandFromVerdictCounts({ pass: 3, fail: 2, unverified: 2, withdrawn: 2 });
  const html = renderedBand(band, null);
  const fills = [...html.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]!);
  const allowed = new Set(["none", "#233456", "#9f0712", "#dfe3e9", "#8f9cb2"]);
  for (const fill of fills) {
    assert.ok(allowed.has(fill) || fill.startsWith("url(#"), fill);
  }
  assert.ok(fills.includes("#8f9cb2"));
});

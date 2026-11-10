import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { hostBadgeCopy, hostBadgeWidth, renderHostBadgeSvg } from "@/lib/badge/host-badge";
import { __setDbForTests } from "@/lib/db/client";
import { GET as hostBadgeGET } from "@/app/api/badge/host/[host]/route";
import { renderReceiptBadgeSvg, endpointReceiptBadge } from "@/lib/badge/receipt-badge";

const RGB_FILL = /fill="(#[0-9a-fA-F]{6})"/g;
const RGB_STROKE = /stroke="(#[0-9a-fA-F]{6})"/g;

function assertGreyHex(hex: string, ctx: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `${ctx}: ${hex}`);
  assert.equal(m[1], m[2], `${ctx}: R=G=B ${hex}`);
  assert.equal(m[2], m[3], `${ctx}: R=G=B ${hex}`);
}

function assertAllGreySvg(svg: string) {
  for (const re of [RGB_FILL, RGB_STROKE]) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(svg))) assertGreyHex(m[1], "svg");
  }
}

test("line1 shows answered of settled", () => {
  const b = hostBadgeCopy({ host: "api.example.com", settled: 10, answered: 7, asOfDate: "2026-11-11" });
  assert.equal(b.line1, "7 of 10 paid calls by vet402 answered with 2xx · 30 days");
  assert.match(b.aria, /7 were answered/);
  assert.doesNotMatch(b.aria.toLowerCase(), /trust|safe|verified|score/);
});

test("zero settled uses no paid calls line", () => {
  const b = hostBadgeCopy({ host: "shop.example", settled: 0, answered: 0, asOfDate: "2026-11-11" });
  assert.equal(b.line1, "no paid calls in 30 days");
  assert.match(b.aria, /made no paid calls/);
});

test("host is escaped in SVG", () => {
  const b = hostBadgeCopy({ host: 'evil"><script>', settled: 1, answered: 1, asOfDate: "2026-11-11" });
  const svg = renderHostBadgeSvg(b);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;") || svg.includes("&quot;"));
});

test("renderHostBadgeSvg uses only R=G=B fills", () => {
  const b = hostBadgeCopy({ host: "agentsvc.io", settled: 75, answered: 75, asOfDate: "2026-11-11" });
  assertAllGreySvg(renderHostBadgeSvg(b));
});

test("ROUTE invalid hostname returns 404", async () => {
  __setDbForTests(null);
  const res = await hostBadgeGET(
    new NextRequest("http://localhost/api/badge/host/not%21valid.svg"),
    { params: Promise.resolve({ host: "not!valid.svg" }) },
  );
  assert.equal(res.status, 404);
});

test("receipt badge output has only grey fills", () => {
  const svg = renderReceiptBadgeSvg(endpointReceiptBadge({ attemptCount: 1, settledCount: 1, deliveredCount: 1 }));
  assertAllGreySvg(svg);
});

test("width grows with longer line1", () => {
  const short = hostBadgeCopy({ host: "a.example", settled: 1, answered: 1, asOfDate: "2026-11-11" });
  const long = hostBadgeCopy({ host: "a.example", settled: 9999, answered: 9998, asOfDate: "2026-11-11" });
  assert.ok(hostBadgeWidth(long.line1, long.line2) > hostBadgeWidth(short.line1, short.line2));
});

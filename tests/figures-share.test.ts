import { test } from "node:test";
import assert from "node:assert/strict";
import { shareSegments, gaugeCells, timelinePositions, funnelWidths } from "@/lib/figures/share";

test("shareSegments: fail 1 / 20,460 でも見える幅を持ち、合計は 100", () => {
  const s = shareSegments([
    { key: "pass", n: 3342 },
    { key: "fail", n: 1 },
    { key: "unverified", n: 17117 },
  ]);
  const fail = s.find((x) => x.key === "fail")!;
  assert.equal(fail.pct, 0);
  assert.equal(fail.widthPct, 1.5);
  assert.equal(Math.round(s.reduce((a, x) => a + x.widthPct, 0) * 100) / 100, 100);
  assert.equal(Math.round(s.reduce((a, x) => a + x.pct, 0) * 10) / 10, 100);
});

test("shareSegments: 全部 0 は幅 0", () => {
  assert.deepEqual(
    shareSegments([{ key: "a", n: 0 }, { key: "b", n: 0 }]).map((x) => x.widthPct),
    [0, 0],
  );
});

test("gaugeCells: 20 以下は 1 試行 1 目盛り", () => {
  const g = gaugeCells(10, 10);
  assert.equal(g.scaled, false);
  assert.equal(g.cells.length, 10);
  assert.ok(g.cells.every((c) => c === "settled"));
  assert.deepEqual(gaugeCells(3, 5).cells, ["settled", "settled", "settled", "failed", "failed"]);
});

test("gaugeCells: 21 以上は 20 目盛りへ比例。成功 1 が 0 に消えない", () => {
  const g = gaugeCells(1, 200);
  assert.equal(g.scaled, true);
  assert.equal(g.cells.length, 20);
  assert.equal(g.cells.filter((c) => c === "settled").length, 1);
  const h = gaugeCells(199, 200);
  assert.equal(h.cells.filter((c) => c === "failed").length, 1);
});

test("timelinePositions: 最初 0・最後 1・1 点なら 1", () => {
  const d = (s: string) => new Date(s);
  const p = timelinePositions([
    { at: d("2026-09-01"), verdict: "pass" },
    { at: d("2026-08-14"), verdict: "fail" },
    { at: d("2026-08-23"), verdict: "pass" },
  ]);
  assert.equal(p[0].x, 0);
  assert.equal(p[0].verdict, "fail");
  assert.equal(p[2].x, 1);
  assert.equal(p[1].x, 0.5);
  assert.deepEqual(timelinePositions([{ at: d("2026-09-01"), verdict: "pass" }]).map((q) => q.x), [1]);
});

test("funnelWidths: 先頭 100・以降は先頭比・最低幅あり", () => {
  assert.deepEqual(funnelWidths([20460, 3342, 902]), [100, 16.3, 4.4]);
  assert.deepEqual(funnelWidths([1000, 1, 0]), [100, 1.5, 0]);
  assert.deepEqual(funnelWidths([0, 0]), [0, 0]);
});

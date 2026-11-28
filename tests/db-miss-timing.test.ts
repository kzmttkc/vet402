// db_resolve / db_decide の Server-Timing 細分段（2026-11-28 依頼 AB）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPresignCheckTiming } from "@/lib/api/check-seller-miss-timing";
import { runDbMissTimingPhase, sliceWithApp, timedDbExecute } from "@/lib/db/miss-timing";
import { takeResolveModuleCold, __resetResolveModuleColdForTests } from "@/lib/resolve/lookup";

test("formatPresignCheckTiming: resolve と decide の細分段は dur のみ（名前は db_*）", () => {
  const s = formatPresignCheckTiming(5, "fresh", 1, {
    db_resolve: 100,
    db_resolve_conn: 2,
    db_resolve_q: 80,
    db_resolve_qn: 2,
    db_resolve_app: 18,
    db_resolve_cold: 1,
    db_decide: 50,
    db_decide_conn: 1,
    db_decide_q: 40,
    db_decide_qn: 1,
    db_decide_app: 9,
  });
  assert.match(s, /db_resolve;dur=100\.0/);
  assert.match(s, /db_resolve_qn;dur=2\.0/);
  assert.match(s, /db_resolve_cold;dur=1\.0/);
  assert.match(s, /db_decide_q;dur=40\.0/);
  assert.doesNotMatch(s, /https?:|example|SELECT/i);
  assert.equal(
    s,
    'cache;dur=5.0;desc="fresh", db_resolve;dur=100.0, db_resolve_conn;dur=2.0, db_resolve_q;dur=80.0, db_resolve_qn;dur=2.0, db_resolve_app;dur=18.0, db_resolve_cold;dur=1.0, db_decide;dur=50.0, db_decide_conn;dur=1.0, db_decide_q;dur=40.0, db_decide_qn;dur=1.0, db_decide_app;dur=9.0, terms;dur=1.0',
  );
});

test("formatPresignCheckTiming: 既存の db_resolve / db_decide だけの形は変わらない", () => {
  const s = formatPresignCheckTiming(5, "fresh", 1, { db_resolve: 9, db_outcomes: 8, db_decide: 2, db_l1_recent: 3 });
  assert.equal(s, 'cache;dur=5.0;desc="fresh", db_resolve;dur=9.0, db_outcomes;dur=8.0, db_decide;dur=2.0, db_l1_recent;dur=3.0, terms;dur=1.0');
});

test("db miss timing: 問い合わせは q と qn に足され、app は壁時計の残り", async () => {
  const { slice } = await runDbMissTimingPhase("resolve", async () => {
    await timedDbExecute(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await timedDbExecute(async () => {
      await new Promise((r) => setTimeout(r, 3));
    });
  });
  assert.equal(slice.qn, 2);
  assert.ok(slice.q! >= 8);
  const s = sliceWithApp(slice, 20);
  assert.equal(s.qn, 2);
  assert.ok((s.app ?? 0) + (s.q ?? 0) + (s.conn ?? 0) <= 20.001);
});

test("resolve module cold: 1 回だけ 1、以降 0", () => {
  __resetResolveModuleColdForTests();
  assert.equal(takeResolveModuleCold(), 1);
  assert.equal(takeResolveModuleCold(), 0);
  __resetResolveModuleColdForTests();
});
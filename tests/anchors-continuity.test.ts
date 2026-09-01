// ============================================================
// 台帳ハッシュ鎖の連続性（2026-09-02 監査指摘）。
//
// 本番の ledger_anchors は 2026-08-14〜08-31 の 18 日間に 17 行——1 日欠けていた。
// anchorDay は `WHERE day < ${day} ORDER BY day DESC LIMIT 1` で「直前に存在する
// 日」を取っていたので、cron が 1 回落ちると翌日は穴を飛ばして連結し、
// cli/verify-anchors.ts は prevRoot == 前行の rootHash しか見ないため
// 「chainIntact: true」を 5 日間言い続けた。連結は保たれ、連続は失われていた。
//
// 修正: (1) 前日 root は day-1 に限る（無ければ先に埋める）、(2) cron は
// 欠けた日を古い順に埋めてから昨日を固定する、(3) 検証は連結と連続の両方。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingDaysBetween, chainContinuity } from "@/lib/observatory/anchors";

test("欠けた日を列挙する（両端を含む閉区間）", () => {
  assert.deepEqual(
    missingDaysBetween("2026-08-14", "2026-08-18", ["2026-08-14", "2026-08-15", "2026-08-17", "2026-08-18"]),
    ["2026-08-16"],
  );
  assert.deepEqual(missingDaysBetween("2026-08-14", "2026-08-14", []), ["2026-08-14"]);
  assert.deepEqual(missingDaysBetween("2026-08-14", "2026-08-16", ["2026-08-14", "2026-08-15", "2026-08-16"]), []);
});

test("連結していても日付が飛んでいれば intact ではない", () => {
  const rows = [
    { day: "2026-08-18", rootHash: "c", prevRoot: "b" },
    { day: "2026-08-16", rootHash: "b", prevRoot: "a" },
    { day: "2026-08-15", rootHash: "a", prevRoot: null },
  ];
  const r = chainContinuity(rows);
  assert.equal(r.linked, true);
  assert.equal(r.contiguous, false);
  assert.deepEqual(r.gaps, ["2026-08-17"]);
  assert.equal(r.intact, false);
});

test("連続していても prevRoot が合わなければ intact ではない", () => {
  const rows = [
    { day: "2026-08-16", rootHash: "b", prevRoot: "zzz" },
    { day: "2026-08-15", rootHash: "a", prevRoot: null },
  ];
  const r = chainContinuity(rows);
  assert.equal(r.linked, false);
  assert.equal(r.contiguous, true);
  assert.equal(r.intact, false);
});

test("連結かつ連続で intact", () => {
  const rows = [
    { day: "2026-08-16", rootHash: "b", prevRoot: "a" },
    { day: "2026-08-15", rootHash: "a", prevRoot: null },
  ];
  assert.equal(chainContinuity(rows).intact, true);
});

test("1行以下は連結も連続も自明に真", () => {
  assert.equal(chainContinuity([{ day: "2026-08-15", rootHash: "a", prevRoot: null }]).intact, true);
  assert.equal(chainContinuity([]).intact, true);
});

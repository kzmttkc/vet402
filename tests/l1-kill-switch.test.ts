// ============================================================
// 2026-09-05 監査 P0: 実行時の停止スイッチ（fail-closed の 3 分岐）。
//
// 事故の形: 不正な支出を見つけても、L1 実購入を止める手段が Vercel env
// `OBSERVATORY_L1_ENABLED` の変更＋再デプロイしかなかった（budget.ts の
// isL1Enabled は process.env しか見ない）。起動点は 4 つ（Vercel cron・
// 管理リポ launchd の 3 本・/api/v1/demo/verify level=l1）あり、再デプロイが
// 完了するまでのどれもが金を動かせる。
//
// だから停止は **DB の 1 行**（runtime_flags.l1_spending_halt）に置く。
// 到達時間は「次の署名まで」で、デプロイを待たない。
//
// 判定の方針（ここが本体）:
//   表が無い / 行が無い → halted=false。未導入は「現状維持」であって停止指示ではない。
//     （逆にすると、この表を作る前のデプロイが全部止まる）
//   DB 到達不能 / クエリ例外 → halted=true。**読めないなら止める側へ倒す。**
//     金を動かす関門で「読めなかったので通した」は許されない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideHalt, SPENDING_HALT_FLAG } from "@/lib/observatory/kill-switch";

test("フラグ名は l1_spending_halt（DDL・runbook・admin ルートが同じ名で参照する）", () => {
  assert.equal(SPENDING_HALT_FLAG, "l1_spending_halt");
});

// 判定は「止めるか」だけでなく「何を読んでそう決めたか」も返す。呼び手の一部
// （公開デモ口）は「運用者が実際に止めた」と「DB が読めないので止めた」を
// 区別して見せ方を変える必要がある——資金の扱いは同じ（どちらも署名しない）。
test("判定は根拠（source）を必ず返す", () => {
  assert.equal(decideHalt({ kind: "row", enabled: true, reason: null }).source, "row");
  assert.equal(decideHalt({ kind: "row", enabled: false, reason: null }).source, "row");
  assert.equal(decideHalt({ kind: "absent" }).source, "absent");
  assert.equal(decideHalt({ kind: "schema_missing" }).source, "schema_missing");
  assert.equal(decideHalt({ kind: "unreachable", detail: "x" }).source, "unreachable");
});

test("行があって enabled=true → 止まる。理由は運用者が書いた文言を返す", () => {
  const v = decideHalt({ kind: "row", enabled: true, reason: "suspicious payout to 0xdead" });
  assert.equal(v.halted, true);
  assert.match(v.reason, /suspicious payout to 0xdead/);
});

test("行があって enabled=true・reason 未記入でも止まる（理由が無いことは通す理由にならない）", () => {
  const v = decideHalt({ kind: "row", enabled: true, reason: null });
  assert.equal(v.halted, true);
  assert.ok(v.reason.length > 0, "理由の文字列は必ず返す（ログと応答に出る）");
});

test("行があって enabled=false → 通す", () => {
  const v = decideHalt({ kind: "row", enabled: false, reason: "resumed after audit" });
  assert.equal(v.halted, false);
});

test("fail-closed 分岐 1: 表が無い（未導入）→ 通す", () => {
  const v = decideHalt({ kind: "schema_missing" });
  assert.equal(v.halted, false, "runtime_flags を作る前のデプロイを止めてはいけない");
  assert.match(v.reason, /flag_table_absent/);
});

test("fail-closed 分岐 2: 行が無い（一度も止めていない）→ 通す", () => {
  const v = decideHalt({ kind: "absent" });
  assert.equal(v.halted, false);
  assert.match(v.reason, /no_flag_row/);
});

test("fail-closed 分岐 3: DB 到達不能・クエリ例外 → 止める", () => {
  const v = decideHalt({ kind: "unreachable", detail: "ECONNREFUSED" });
  assert.equal(v.halted, true, "読めないなら止める側へ倒す——金を動かす関門の既定は停止");
  assert.match(v.reason, /unreadable/);
  assert.match(v.reason, /ECONNREFUSED/);
});

test("理由の文字列は応答に載るので長さを縛る（売り手の文字列ではないが際限なく伸ばさない）", () => {
  const v = decideHalt({ kind: "unreachable", detail: "x".repeat(5000) });
  assert.ok(v.reason.length <= 400, `reason が長すぎる: ${v.reason.length}`);
});

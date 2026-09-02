// §7.4 カバレッジ階層（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { tierOf, LOOKUPS_C2_THRESHOLD, L0_INTERVAL_HOURS } from "@/lib/observatory/coverage";

const base = { listedWithin30d: false, settledWithin30d: false, attributedSettlements: 0, lookups7d: 0, hasDeclaration: false, reverifyRequested: false };

test("C0: カタログにあるが 30 日以内の listed も決済も無い", () => assert.equal(tierOf(base), "C0"));
test("C1: 30 日以内に listed、または決済があった", () => {
  assert.equal(tierOf({ ...base, listedWithin30d: true }), "C1");
  assert.equal(tierOf({ ...base, settledWithin30d: true }), "C1");
});
test("C2: 決済帰属あり、または問い合わせが閾値以上", () => {
  assert.equal(tierOf({ ...base, listedWithin30d: true, attributedSettlements: 1 }), "C2");
  assert.equal(tierOf({ ...base, listedWithin30d: true, lookups7d: LOOKUPS_C2_THRESHOLD }), "C2");
  assert.equal(tierOf({ ...base, listedWithin30d: true, lookups7d: LOOKUPS_C2_THRESHOLD - 1 }), "C1");
});
test("C3: 宣言のある C2", () => assert.equal(tierOf({ ...base, attributedSettlements: 1, hasDeclaration: true }), "C3"));
test("宣言があっても C2 条件が無ければ C3 にならない", () => assert.equal(tierOf({ ...base, listedWithin30d: true, hasDeclaration: true }), "C1"));
test("C4: 再検証要求は最優先", () => assert.equal(tierOf({ ...base, reverifyRequested: true }), "C4"));
test("L0 周期: C0 は測らない、C1 日次、C2/C3 6 時間、C4 即時", () => {
  assert.equal(L0_INTERVAL_HOURS.C0, null);
  assert.equal(L0_INTERVAL_HOURS.C1, 24);
  assert.equal(L0_INTERVAL_HOURS.C2, 6);
  assert.equal(L0_INTERVAL_HOURS.C3, 6);
  assert.equal(L0_INTERVAL_HOURS.C4, 0);
});
// 2026-09-02 監査 A1: 未置換パスパラメータの URL は正しい要求を作れない。日次枠を使わない
// （C1〜C3 に入れない）。C4（異議・再検証要求）だけは残す——要求は出さず行だけ残る。
test("パステンプレート URL は C0（測れない endpoint に日次枠を使わない）", () => {
  assert.equal(tierOf({ ...base, listedWithin30d: true, pathTemplate: true }), "C0");
  assert.equal(tierOf({ ...base, settledWithin30d: true, pathTemplate: true }), "C0");
  assert.equal(tierOf({ ...base, listedWithin30d: true, attributedSettlements: 1, pathTemplate: true }), "C0");
  assert.equal(tierOf({ ...base, attributedSettlements: 1, hasDeclaration: true, pathTemplate: true }), "C0");
  assert.equal(tierOf({ ...base, reverifyRequested: true, pathTemplate: true }), "C4");
  assert.equal(tierOf({ ...base, listedWithin30d: true, pathTemplate: false }), "C1");
});

// 2026-09-02 監査 P1-6: REGISTRY_WRITE_TIERS（ERC-8004 に書く階層の集合・既定 C2,C3）。
test("parseRegistryWriteTiers: 未設定・空は既定 C2,C3", async () => {
  const { parseRegistryWriteTiers } = await import("@/lib/observatory/coverage");
  assert.deepEqual([...parseRegistryWriteTiers(undefined)].sort(), ["C2", "C3"]);
  assert.deepEqual([...parseRegistryWriteTiers("")].sort(), ["C2", "C3"]);
  assert.deepEqual([...parseRegistryWriteTiers("  ")].sort(), ["C2", "C3"]);
});
test("parseRegistryWriteTiers: 大小・空白を許し、知らない語は捨てる", async () => {
  const { parseRegistryWriteTiers } = await import("@/lib/observatory/coverage");
  assert.deepEqual([...parseRegistryWriteTiers("c1, C2 ,bogus")].sort(), ["C1", "C2"]);
  assert.deepEqual([...parseRegistryWriteTiers("bogus")], [], "知らない語だけなら空集合（何も書かない）");
});

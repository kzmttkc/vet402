// §7.2 wash_flag（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWash, type WashContext } from "@/lib/settlements/wash";

const base = { payerId: "eip155:8453:0xaaa", payeeId: "eip155:8453:0xbbb", blockTime: new Date("2026-09-01T00:00:00Z") };
const ctx = (over: Partial<WashContext> = {}): WashContext => ({
  testWallets: new Set(),
  sameCluster: () => false,
  reverseWithinHours: () => false,
  ...over,
});

test("何にも当たらなければ none", () => assert.equal(classifyWash(base, ctx()), "none"));
test("同一 EOA は self_deal", () => assert.equal(classifyWash({ ...base, payeeId: base.payerId }, ctx()), "self_deal"));
test("同一ファウンダー／同一 8004 オーナーは self_deal", () =>
  assert.equal(classifyWash(base, ctx({ sameCluster: () => true })), "self_deal"));
test("24 時間以内の往復は circular", () => {
  let seenHours = 0;
  const r = classifyWash(base, ctx({ reverseWithinHours: (_p, _q, _at, h) => ((seenHours = h), true) }));
  assert.equal(r, "circular");
  assert.equal(seenHours, 24);
});
test("既知の測定ウォレット（vet402 自身を含む）は test", () =>
  assert.equal(classifyWash(base, ctx({ testWallets: new Set([base.payerId]) })), "test"));
test("優先順位: test > self_deal > circular（測定は実需から必ず除く）", () => {
  const r = classifyWash(
    { ...base, payeeId: base.payerId },
    ctx({ testWallets: new Set([base.payerId]), sameCluster: () => true, reverseWithinHours: () => true }),
  );
  assert.equal(r, "test");
  const r2 = classifyWash(base, ctx({ sameCluster: () => true, reverseWithinHours: () => true }));
  assert.equal(r2, "self_deal");
});
test("payer か payee が不明なら none（分類できないものに旗を立てない）", () => {
  assert.equal(classifyWash({ ...base, payerId: null }, ctx({ sameCluster: () => true })), "none");
  assert.equal(classifyWash({ ...base, payeeId: null }, ctx({ reverseWithinHours: () => true })), "none");
});
test("blockTime が無ければ circular は判定しない", () =>
  assert.equal(classifyWash({ ...base, blockTime: null }, ctx({ reverseWithinHours: () => true })), "none"));

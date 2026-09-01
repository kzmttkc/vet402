// §7.2 帰属規則（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { attribute, ATTRIBUTION_WINDOW_MS } from "@/lib/settlements/attribution";

const env = {
  payTo: "0xbbb",
  amount: "1000",
  asset: "0xusdc",
  network: "eip155:8453",
  observedAt: new Date("2026-09-01T00:00:00Z"),
};
const tx = (over: Partial<Parameters<typeof attribute>[0]> = {}) => ({
  payee: "0xBBB",
  amount: "1000",
  asset: "0xUSDC",
  chain: "eip155:8453",
  blockTime: new Date("2026-09-01T00:01:00Z"),
  ...over,
});

test("payTo・amount・asset 一致、時刻が観測窓内 → confirmed（大文字小文字は無視）", () =>
  assert.equal(attribute(tx(), env), "confirmed"));
test("payTo 一致・amount 不一致 → probable", () => assert.equal(attribute(tx({ amount: "999" }), env), "probable"));
test("payTo 一致・時刻が窓外 → probable", () =>
  assert.equal(attribute(tx({ blockTime: new Date(env.observedAt.getTime() + ATTRIBUTION_WINDOW_MS + 1) }), env), "probable"));
test("payTo 不一致 → unmatched", () => assert.equal(attribute(tx({ payee: "0xccc" }), env), "unmatched"));
test("チェーンが違えば unmatched（v1 スラグは CAIP-2 に寄せて比べる）", () => {
  assert.equal(attribute(tx({ chain: "eip155:137" }), env), "unmatched");
  assert.equal(attribute(tx(), { ...env, network: "base" }), "confirmed");
});
test("封筒に asset 宣言が無ければ amount 一致だけで confirmed", () =>
  assert.equal(attribute(tx({ asset: null }), { ...env, asset: null }), "confirmed"));
test("blockTime か observedAt が無ければ confirmed にはならない", () => {
  assert.equal(attribute(tx({ blockTime: null }), env), "probable");
  assert.equal(attribute(tx(), { ...env, observedAt: null }), "probable");
});

// §8.2 買い手事実（純関数部分）
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryBurstRate } from "@/lib/decision/buyer-facts";

const at = (s: string) => new Date(s);

test("同一 resource への 60 秒以内の再署名率", () => {
  const r = retryBurstRate([
    { resourceId: "r1", at: at("2026-09-01T00:00:00Z") },
    { resourceId: "r1", at: at("2026-09-01T00:00:30Z") }, // burst
    { resourceId: "r1", at: at("2026-09-01T01:00:00Z") }, // not
    { resourceId: "r2", at: at("2026-09-01T00:00:00Z") },
    { resourceId: "r2", at: at("2026-09-01T00:00:59Z") }, // burst
  ]);
  assert.equal(r, 2 / 3);
});
test("resource が付かない決済は分母に入れない", () => {
  assert.equal(retryBurstRate([{ resourceId: null, at: at("2026-09-01T00:00:00Z") }, { resourceId: null, at: at("2026-09-01T00:00:01Z") }]), null);
});
test("列が 2 未満なら null（ノイズから率を出さない）", () => {
  assert.equal(retryBurstRate([]), null);
  assert.equal(retryBurstRate([{ resourceId: "r1", at: at("2026-09-01T00:00:00Z") }]), null);
});
test("順序は問わない（並べ替えてから見る）", () => {
  const r = retryBurstRate([
    { resourceId: "r1", at: at("2026-09-01T00:00:30Z") },
    { resourceId: "r1", at: at("2026-09-01T00:00:00Z") },
  ]);
  assert.equal(r, 1);
});

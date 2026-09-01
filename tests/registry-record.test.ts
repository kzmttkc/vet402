// §11 ERC-8004 Validation レコード: subject / result{level, verdict} / uri / hash / requestHash
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildValidationRecord } from "@/lib/chain/registry";

const base = {
  endpointId: "00000000-0000-0000-0000-000000000001",
  agentId: 42n,
  level: "l1" as const,
  verdict: "pass" as const,
  evidenceUri: "https://vet402.com/observatory/e/00000000-0000-0000-0000-000000000001",
};

test("レコードは subject / result / hash / requestHash を持ち、response は verdict の写像", () => {
  const r = buildValidationRecord({ ...base, subject: { type: "payee", id: "eip155:8453:0xabc" }, requestKey: "eip155:8453:0xdeadbeef" });
  assert.deepEqual(r.subject, { type: "payee", id: "eip155:8453:0xabc" });
  assert.deepEqual(r.result, { level: "l1", verdict: "pass" });
  assert.match(r.hash, /^0x[0-9a-f]{64}$/);
  assert.match(r.requestHash, /^0x[0-9a-f]{64}$/);
  assert.equal(r.requestKey, "eip155:8453:0xdeadbeef");
  assert.equal(r.response, 100);
  assert.equal(buildValidationRecord({ ...base, verdict: "fail" }).response, 0);
});

test("requestHash は purchase_id から決定的に導く（同じ購入 → 同じ hash、別の購入 → 別の hash）", () => {
  const a = buildValidationRecord({ ...base, requestKey: "eip155:8453:0x1" });
  const b = buildValidationRecord({ ...base, requestKey: "eip155:8453:0x1" });
  const c = buildValidationRecord({ ...base, requestKey: "eip155:8453:0x2" });
  assert.equal(a.requestHash, b.requestHash);
  assert.notEqual(a.requestHash, c.requestHash);
});

test("hash は証拠 JSON の keccak——subject や verdict が変われば変わる", () => {
  const a = buildValidationRecord(base);
  const b = buildValidationRecord({ ...base, verdict: "fail" });
  const c = buildValidationRecord({ ...base, subject: { type: "resource_hash", id: "r" } });
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
});

test("L0 のみでは書かない（§11）", () => {
  assert.throws(() => buildValidationRecord({ ...base, level: "l0" as unknown as "l1" }), /l0_not_allowed/);
});

test("subject 省略時は agent（registry が話す語彙）", () => {
  const r = buildValidationRecord(base);
  assert.deepEqual(r.subject, { type: "agent", id: "42" });
});

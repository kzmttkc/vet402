// §7.3 resolve の入口判別（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyQuery } from "@/lib/resolve/classify";

test("URL → url", () => assert.deepEqual(classifyQuery(" https://e.com/api/x "), { kind: "url", value: "https://e.com/api/x" }));
test("domain → domain（小文字化）", () => assert.deepEqual(classifyQuery("E.com"), { kind: "domain", value: "e.com" }));
test("EVM address → address（小文字化）", () => assert.equal(classifyQuery("0x" + "A".repeat(40)).kind, "address"));
test("EVM tx → tx", () => assert.equal(classifyQuery("0x" + "a".repeat(64)).kind, "tx"));
test("Solana base58: 32–44 文字は address、80–90 文字は tx", () => {
  assert.equal(classifyQuery("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").kind, "address");
  assert.equal(classifyQuery("5".repeat(88)).kind, "tx");
});
test("payee_id 形式（chain:addr）→ payee_id", () => {
  assert.equal(classifyQuery("eip155:8453:0x" + "a".repeat(40)).kind, "payee_id");
  assert.equal(classifyQuery("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").kind, "payee_id");
});
test("判別不能・空・長すぎ → unknown", () => {
  assert.equal(classifyQuery("???").kind, "unknown");
  assert.equal(classifyQuery("").kind, "unknown");
  assert.equal(classifyQuery("a".repeat(3000)).kind, "unknown");
});

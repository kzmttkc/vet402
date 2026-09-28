// §7.3 resolve の入口判別（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyQuery, explainInvalidQuery } from "@/lib/resolve/classify";
import { canonicalUrl } from "@/lib/ids/canonical";
import { withNotFound } from "@/lib/resolve/lookup";

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

// 2026-09-29 再監査（DX）: 400 の本文が原因と直し方を言うこと。

test("スキームの無い URL は「absolute https URL」と言い、https を足した q を返す", () => {
  const r = explainInvalidQuery("api.exa.ai/search");
  assert.ok(r);
  assert.match(r.message, /url must be an absolute https URL/);
  assert.equal(r.suggestion, "https://api.exa.ai/search");
});

test("http:// の URL は空の 200 ではなく 400 の理由になる（canonicalUrl が受けない形）", () => {
  assert.equal(canonicalUrl("http://api.exa.ai/search"), null);
  const r = explainInvalidQuery("http://api.exa.ai/search");
  assert.ok(r);
  assert.match(r.message, /absolute https URL/);
  assert.equal(r.suggestion, "https://api.exa.ai/search");
});

test("受け付ける形には理由を返さない（classify と canonicalUrl が通す形）", () => {
  for (const q of [
    "https://api.exa.ai/search",
    "api.exa.ai",
    "0x" + "a".repeat(40),
    "0x" + "a".repeat(64),
    "eip155:8453:0x" + "a".repeat(40),
  ]) {
    assert.equal(explainInvalidQuery(q), null, q);
  }
});

test("判別不能・空は受け付ける形を列挙した理由になる", () => {
  assert.match(explainInvalidQuery("???")?.message ?? "", /accepted form/);
  assert.match(explainInvalidQuery("")?.message ?? "", /q is required/);
  assert.match(explainInvalidQuery(null)?.message ?? "", /q is required/);
});

test("カタログに無い url / domain / address は空の endpoints と not_found を返す", () => {
  for (const kind of ["url", "domain", "address", "payee_id"] as const) {
    const out = withNotFound({ query: { kind, value: "https://nowhere.example/x" }, disclaimer: "d" });
    assert.deepEqual(out.endpoints, [], kind);
    assert.equal(out.not_found?.reason, "not_in_catalog", kind);
    assert.match(out.not_found?.next ?? "", /\/docs\/api#endpoints$/);
    assert.match(out.not_found?.note ?? "", /not a finding/);
  }
});

test("何か引けたとき・tx のときは not_found を足さない", () => {
  const hit = withNotFound({
    query: { kind: "domain", value: "e.com" },
    endpoints: [
      {
        endpoint_id: "a",
        resource_id: null,
        observatory_id: "u",
        canonical_url: "https://e.com/x",
        method: "GET",
        payee_id: null,
        catalog_status: "listed",
        first_seen: null,
        last_seen: null,
      },
    ],
    disclaimer: "d",
  });
  assert.equal(hit.not_found, undefined);
  const tx = withNotFound({ query: { kind: "tx", value: "0x" + "a".repeat(64) }, disclaimer: "d" });
  assert.equal(tx.not_found, undefined);
  assert.equal(tx.endpoints, undefined);
});

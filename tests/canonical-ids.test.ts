// ============================================================
// §5 オブジェクト識別子。すべての測定・信用はこの ID に載る（文字列比較で一意）。
// 既存の uuid は主キーのまま残し、これらは列として並走する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUrl,
  resourceId,
  endpointHash,
  payeeId,
  payerId,
  purchaseId,
  observationId,
  agentId8004,
} from "@/lib/ids/canonical";

test("canonical_url: https 強制・host 小文字・既定ポート除去・末尾スラッシュ統一・クエリ辞書順", () => {
  const c = canonicalUrl("HTTPS://Api.Example.com:443/v1/quote/?b=2&a=1");
  assert.equal(c?.url, "https://api.example.com/v1/quote?a=1&b=2");
  assert.deepEqual(c?.undeclaredQuery, []);
});

test("非既定ポートは残る", () => {
  assert.equal(canonicalUrl("https://e.com:8443/x")?.url, "https://e.com:8443/x");
});

test("http 掲載は canonical にならない（L0 fail・購入しない）", () => {
  assert.equal(canonicalUrl("http://example.com/x"), null);
  assert.equal(canonicalUrl("not a url"), null);
});

test("署名用の可変クエリは測定対象から外し undeclared に載せる", () => {
  const c = canonicalUrl("https://e.com/x?sig=abc&ts=1&q=1");
  assert.equal(c?.url, "https://e.com/x?q=1");
  assert.deepEqual(c?.undeclaredQuery, ["sig", "ts"]);
});

test("ルートパスは末尾スラッシュ無しに統一", () => {
  assert.equal(canonicalUrl("https://e.com/")?.url, "https://e.com");
  assert.equal(canonicalUrl("https://e.com")?.url, "https://e.com");
});

test("resource_id は method + canonical_url の sha256、v1/v2 の違いや表記で変わらない", () => {
  const a = resourceId("GET", "https://e.com/x");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, resourceId("get", "https://E.com/x/"));
  assert.notEqual(a, resourceId("POST", "https://e.com/x"));
});

test("endpoint_hash は origin + pathname_prefix（最後のセグメントを落とした親パス）", () => {
  assert.equal(endpointHash("https://e.com/api/quote"), endpointHash("https://e.com/api/other"));
  assert.notEqual(endpointHash("https://e.com/api/quote"), endpointHash("https://e.com/v2/quote"));
  // 1 セグメント以下は origin + "/"
  assert.equal(endpointHash("https://e.com/quote"), endpointHash("https://e.com/"));
});

test("payee_id: EVM は小文字、Solana は base58 のまま（大文字小文字が意味を持つ）", () => {
  assert.equal(
    payeeId("eip155:8453", "0xABCDEF0000000000000000000000000000000001"),
    "eip155:8453:0xabcdef0000000000000000000000000000000001",
  );
  assert.equal(
    payeeId("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  assert.equal(payerId, payeeId);
});

test("v1 スラグのチェーンは CAIP-2 に寄せる", () => {
  assert.equal(payeeId("base", "0xABC"), "eip155:8453:0xabc");
});

test("purchase_id / observation_id / agent_id", () => {
  assert.equal(purchaseId("eip155:8453", "0xAB"), "eip155:8453:0xab");
  assert.equal(purchaseId("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "AbC"), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:AbC");
  assert.match(observationId("r", "2026-09-02T00:00:00Z", "L0"), /^[0-9a-f]{64}$/);
  assert.notEqual(observationId("r", "2026-09-02T00:00:00Z", "L0"), observationId("r", "2026-09-02T00:00:00Z", "L1"));
  assert.equal(agentId8004(8453, 42n), "eip155:8453:8004:42");
});

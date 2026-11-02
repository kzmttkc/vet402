import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerResponseHeadersOf } from "@/lib/observatory/seller-retest";

test("売り手の支払いのヘッダーを保存する（Goldsky の funding と balance）", () => {
  const h = new Headers({ "x-goldsky-x402-funding": "credit", "x-goldsky-x402-balance": "3890", "x-other": "no" });
  assert.deepEqual(sellerResponseHeadersOf(h), { "x-goldsky-x402-balance": "3890", "x-goldsky-x402-funding": "credit" });
  assert.equal(sellerResponseHeadersOf(new Headers({ "x-other": "no" })), null);
});

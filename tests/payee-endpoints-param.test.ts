// ============================================================
// GET /api/v1/payees/{payee_id}/endpoints — パラメータの正規化。
//
// 2026-09-02 敵対的監査: Next.js は動的セグメントを一度復号して渡すので、
// ハンドラ側の decodeURIComponent は二度目の復号になる。`%25` を含む URL は
// `%` として届き、それを再復号すると URIError → 500。不正な id は 400 で返す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePayeeParam } from "@/app/api/v1/payees/[address]/endpoints/route";

test("不正なパーセントエンコード（%25 由来の %）は例外にせず null（→ 400）", () => {
  assert.equal(normalizePayeeParam("%"), null);
  assert.equal(normalizePayeeParam("%E0%A4%A"), null);
  assert.equal(normalizePayeeParam("0x%zz"), null);
});

test("正常な id はこれまで通り正規化される", () => {
  assert.equal(
    normalizePayeeParam("0x52E29E0D2AA49BFBFC548C0A9F2196F4AA51F3EA"),
    "eip155:8453:0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
  );
  assert.equal(normalizePayeeParam("eip155%3A8453%3A0xabc"), "eip155:8453:0xabc", "chain:address の % エンコードは復号される（既存挙動）");
  assert.equal(normalizePayeeParam("garbage"), null);
});

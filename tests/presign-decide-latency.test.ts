// db_decide / db_resolve の短縮（2026-11-28 依頼 W）: 並列の契約と GET/POST の優先。
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefetchSellerRefundStats } from "@/lib/decision/seller-refunds";
import { preferGetResourceHit } from "@/lib/resolve/lookup";

const ref = (id: string) => ({
  ref: {
    endpoint_id: id,
    resource_id: null,
    observatory_id: id,
    canonical_url: "https://example/x",
    method: "GET",
    payee_id: null,
    catalog_status: "listed" as const,
    first_seen: null,
    last_seen: null,
  },
  network: "eip155:8453",
});

test("preferGetResourceHit: GET を POST より優先", () => {
  assert.equal(preferGetResourceHit(ref("g"), ref("p"))?.ref.observatory_id, "g");
});

test("preferGetResourceHit: GET が無ければ POST", () => {
  assert.equal(preferGetResourceHit(null, ref("p"))?.ref.observatory_id, "p");
});

test("prefetchSellerRefundStats: 壊れた URL なら読み始めない", () => {
  assert.equal(prefetchSellerRefundStats("not-a-url"), null);
});
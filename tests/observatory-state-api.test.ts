// ============================================================
// vet402 — State-of-x402 JSON API (2026-08-18).
//
// Machine-readable twin of /observatory/state. These pin that the endpoint
// returns the aggregate figures with their denominators, the per-chain
// breakdown, and RateLimit headers — and never fabricates numbers (an empty
// DB returns zeros, not nulls-as-data). The reader math itself is covered in
// observatory-reader.test.ts against a real Postgres; this exercises the route
// wrapper's shape and headers.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

test("state API returns the aggregate shape with RateLimit headers", async () => {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  // With no DATABASE_URL in this unit context the readers degrade to empty —
  // the route must still answer 200 with a well-formed, honest zero state,
  // never a 500.
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("RateLimit-Limit"), "RateLimit-Limit present");

  const body = await res.json();
  for (const key of [
    "totalEndpoints",
    "activeEndpoints",
    "delistedEndpoints",
    "publishedPass",
    "publishedFail",
    "publishedUnverified",
  ]) {
    assert.equal(typeof body[key], "number", `${key} must be a number`);
  }
  assert.ok(Array.isArray(body.byChain), "byChain must be an array");
  assert.ok(body.l1 && typeof body.l1.attempts === "number", "l1 attempts present");
  // Facts-only contract: no evaluative vocabulary in the payload.
  const raw = JSON.stringify(body).toLowerCase();
  assert.ok(!raw.includes('"score"'), "payload must not carry a score field");
  assert.ok(typeof body.disclaimer === "string" && body.disclaimer.length > 0);
});

// 2026-09-05 監査 S-4 / S-17: settled の証拠強度は 1 段ではない。公開 API が
// 2 層を出し、和が settled と一致することを型と不変条件で固定する（本番実測
// 2026-09-05: 1,629 = 71 nonce_bound + 1,558 amount_payee_only）。
test("state API publishes the two settled tiers and they sum to l1.settled", async () => {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  assert.equal(res.status, 200);
  const body = await res.json();

  for (const key of [
    "attempts",
    "settled",
    "delivered",
    "settledNonceBound",
    "settledAmountPayeeOnly",
    "settledTimeWindowOk",
    "settledTimeWindowUnknown",
  ]) {
    assert.equal(typeof body.l1[key], "number", `l1.${key} must be a number`);
  }
  assert.equal(
    body.l1.settledNonceBound + body.l1.settledAmountPayeeOnly,
    body.l1.settled,
    "the two tiers must partition l1.settled — a tier that changes the total is a different number, not a strength label",
  );
  assert.ok(
    body.l1.settledTimeWindowOk + body.l1.settledTimeWindowUnknown <= body.l1.settled,
    "time-window counts are a view of settled, never larger than it",
  );

  assert.ok(Array.isArray(body.l1.byChain), "l1.byChain must be an array");
  for (const c of body.l1.byChain) {
    assert.equal(typeof c.chain, "string");
    assert.equal(
      c.settledNonceBound + c.settledAmountPayeeOnly,
      c.settled,
      `${c.chain}: per-chain tiers must partition that chain's settled`,
    );
  }
  assert.equal(
    body.l1.byChain.reduce((n: number, c: { settled: number }) => n + c.settled, 0),
    body.l1.settled,
    "l1.byChain must account for every settled row (it is not mainnet-filtered like the L0 byChain)",
  );

  // 過大主張を消す方向の変更である以上、免責はどこが弱いかを名指しする。
  assert.match(body.disclaimer, /nonce/i, "disclaimer must name the nonce binding");
});

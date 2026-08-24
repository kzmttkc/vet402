// verify-at-settle fast surface (node:test — run with `npm test` after build).
//
// 2026-08-22 (audit): docs/verify-at-settle.md claimed the caller-side
// fail-closed reading of `cache_cold` was "exactly what @vet402/sdk / the
// Python SDK do by default". Measured: `verdict-fast` appeared NOWHERE under
// packages/ — the SDK only ever called /payees/{a}/score. The doc described a
// code path that did not exist. These tests pin the path that now does, and
// the one rule that matters at a settle-time call site:
//
//   cache_cold is the ABSENCE of a verdict, and the absence of a verdict is
//   not an allow.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVouchClient, payeeVerdictFastAllows } from "../dist/index.js";

const WALLET = "0x1111111111111111111111111111111111111111";

function jsonFetch(body, status = 200) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

const client = (fetchFn) =>
  createVouchClient({
    apiUrl: "https://vet402.test/api/v1",
    apiKey: "vouch_live_test",
    fetch: fetchFn,
  });

const hit = (recommendation, cacheExpiresAt) => ({
  status: "hit",
  recommendation,
  score: 84,
  cacheExpiresAt,
  handlerMicros: 12.5,
});

const cold = {
  status: "cache_cold",
  recommendation: null,
  warmVia: `/api/v1/payees/${WALLET}/score`,
  note: "This surface never computes. Treat cache_cold as not-ALLOW (fail closed) and warm asynchronously.",
  handlerMicros: 3.1,
};

test("hits the verdict-fast path, not the score path", async () => {
  const { calls, fetchFn } = jsonFetch(cold);
  await client(fetchFn).getPayeeVerdictFast(WALLET);
  assert.equal(
    calls[0].url,
    `https://vet402.test/api/v1/payees/${WALLET}/verdict-fast`,
  );
});

test("an invalid address is rejected before any request is made", () => {
  // Throws SYNCHRONOUSLY despite the Promise return type — same as
  // getPayeeScore / getWalletScore, so the quirk stays consistent across the
  // client rather than being special-cased here.
  const { calls, fetchFn } = jsonFetch(cold);
  assert.throws(
    () => client(fetchFn).getPayeeVerdictFast("0xnope"),
    /invalid_wallet_address/,
  );
  assert.equal(calls.length, 0);
});

test("cache_cold is NOT an allow", async () => {
  const { fetchFn } = jsonFetch(cold);
  const verdict = await client(fetchFn).getPayeeVerdictFast(WALLET);
  assert.equal(verdict.status, "cache_cold");
  assert.equal(verdict.recommendation, null);
  assert.equal(payeeVerdictFastAllows(verdict), false);
  // The body names the warm-up path so the caller does not have to build it.
  assert.match(verdict.warmVia, /\/score$/);
});

test("a fresh hit + ALLOW is the only thing that clears", async () => {
  const expires = new Date(Date.now() + 60_000).toISOString();
  const { fetchFn } = jsonFetch(hit("ALLOW", expires));
  const verdict = await client(fetchFn).getPayeeVerdictFast(WALLET);
  assert.equal(payeeVerdictFastAllows(verdict), true);
});

test("WARN and BLOCK hits do not clear", async () => {
  const expires = new Date(Date.now() + 60_000).toISOString();
  for (const recommendation of ["WARN", "BLOCK"]) {
    assert.equal(payeeVerdictFastAllows(hit(recommendation, expires)), false, recommendation);
  }
});

test("an ALLOW past its own cacheExpiresAt does not clear", () => {
  // The server already refuses to return an expired entry; a fast path that
  // gates money must not depend on the other side having done that.
  const expired = new Date(Date.now() - 1).toISOString();
  assert.equal(payeeVerdictFastAllows(hit("ALLOW", expired)), false);
});

test("an unparseable cacheExpiresAt does not clear (fail closed)", () => {
  assert.equal(payeeVerdictFastAllows(hit("ALLOW", "not-a-date")), false);
});

test("the freshness check honours an injected clock", () => {
  const expires = new Date(1_000_000).toISOString();
  assert.equal(payeeVerdictFastAllows(hit("ALLOW", expires), 999_999), true);
  assert.equal(payeeVerdictFastAllows(hit("ALLOW", expires), 1_000_000), false);
});

test("the fast surface is bounded by the same timeout as every other call", async () => {
  const calls = [];
  const fetchFn = (url, init) => {
    calls.push({ url, init });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  };
  const vouch = createVouchClient({
    apiKey: "vouch_live_test",
    fetch: fetchFn,
    timeoutMs: 25,
  });
  await assert.rejects(() => vouch.getPayeeVerdictFast(WALLET));
  assert.ok(calls[0].init.signal.aborted);
});

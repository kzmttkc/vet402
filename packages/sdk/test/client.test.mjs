// Construction contract for createVouchClient (node:test, no framework —
// run with `npm test` after `npm run build`).
//
// 2026-08-13 (hackathon persona R2): the most obvious first line a new
// integrator writes — `createVouchClient({ apiKey })` — threw a raw
//
//   TypeError: Cannot read properties of undefined (reading 'replace')
//       at dist/index.js:11
//
// A stack trace pointing into our compiled output, naming none of our
// options. There is exactly one URL that argument could sensibly default to,
// so it defaults to it now. Anything genuinely malformed still fails, but
// with a message that says what to pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVouchClient, VouchApiError, DEFAULT_API_URL } from "../dist/index.js";

const WALLET = "0x1111111111111111111111111111111111111111";

function captureFetch(response) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return (
      response ??
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  };
  return { calls, fetchFn };
}

test("apiUrl defaults to the hosted production API", async () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({ apiKey: "vouch_live_test", fetch: fetchFn });
  await vouch.getWalletScore(WALLET);
  assert.equal(DEFAULT_API_URL, "https://vet402.com/api/v1");
  assert.equal(calls[0].url, `https://vet402.com/api/v1/wallets/${WALLET}/score`);
});

test("an explicit apiUrl still wins, trailing slash trimmed", async () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({
    apiUrl: "http://localhost:3000/api/v1/",
    apiKey: "vouch_live_test",
    fetch: fetchFn,
  });
  await vouch.getWalletScore(WALLET);
  assert.equal(calls[0].url, `http://localhost:3000/api/v1/wallets/${WALLET}/score`);
});

test("a blank apiUrl fails with a message that names the option", () => {
  assert.throws(() => createVouchClient({ apiUrl: "   ", apiKey: "k" }), (err) => {
    assert.match(err.message, /invalid_api_url/);
    assert.match(err.message, /apiUrl/);
    return true;
  });
});

// 2026-09-07 (ETHOnline): the API answers `/decision` key-less (10/min per IP,
// commit 3738890), so a judge with only a Graph key must be able to walk
// SKILL.md. `apiKey` is optional. Both directions are pinned: without a key
// NO Authorization header goes on the wire (not `Bearer undefined`, which the
// server would reject as invalid_api_key and which would look like a bug in
// the judge's key); with a key it is the bearer token, unchanged.
test("no apiKey: the request carries no Authorization header at all", async () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({ fetch: fetchFn });
  await vouch.getWalletScore(WALLET);
  const headers = calls[0].init.headers;
  assert.equal("Authorization" in headers, false, `Authorization leaked: ${JSON.stringify(headers)}`);
  assert.equal(JSON.stringify(headers).includes("undefined"), false, JSON.stringify(headers));
});

test("an empty apiKey is treated as absent, not sent as `Bearer `", async () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({ apiKey: "   ", fetch: fetchFn });
  await vouch.getWalletScore(WALLET);
  assert.equal("Authorization" in calls[0].init.headers, false);
});

test("with apiKey: the bearer token is what goes on the wire", async () => {
  const { calls, fetchFn } = captureFetch();
  const vouch = createVouchClient({ apiKey: "vouch_live_test", fetch: fetchFn });
  await vouch.getWalletScore(WALLET);
  assert.equal(calls[0].init.headers.Authorization, "Bearer vouch_live_test");
});

test("a non-string apiKey still fails with a message that names the option", () => {
  assert.throws(() => createVouchClient({ apiKey: 123 }), (err) => {
    assert.match(err.message, /invalid_api_key/);
    assert.match(err.message, /apiKey/);
    return true;
  });
});

test("key-less and key-requiring: the server's 401 is passed through as the server's own word", async () => {
  // The SDK does not pre-empt the server. Operations that need a key
  // (webhooks, watchlist, attest…) fail with the server's `missing_api_key`,
  // which the caller can read; the SDK never invents a refusal of its own.
  const { fetchFn } = captureFetch(
    new Response(JSON.stringify({ error: "missing_api_key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  );
  const vouch = createVouchClient({ fetch: fetchFn });
  await assert.rejects(
    () => vouch.getWalletScore(WALLET),
    (err) => {
      assert.ok(err instanceof VouchApiError);
      assert.equal(err.code, "missing_api_key");
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("a non-2xx answer throws VouchApiError carrying code and status", async () => {
  const { fetchFn } = captureFetch(
    new Response(JSON.stringify({ error: "missing_api_key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  );
  const vouch = createVouchClient({ apiKey: "k", fetch: fetchFn });
  await assert.rejects(
    () => vouch.getWalletScore(WALLET),
    (err) => {
      assert.ok(err instanceof VouchApiError);
      assert.equal(err.code, "missing_api_key");
      assert.equal(err.status, 401);
      // message stays the bare code so pre-0.2.0 `err.message` checks hold.
      assert.equal(err.message, "missing_api_key");
      return true;
    },
  );
});

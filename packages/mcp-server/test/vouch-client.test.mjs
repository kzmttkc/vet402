// @vet402/mcp-server — transport contract (node:test, no framework —
// run with `npm test` after `npm run build`).
//
// 2026-08-22 (audit): this package had NO tests at all and no `test` script,
// while shipping a published npm binary (`bin: vet402-mcp`) that an MCP client
// launches with `npx`. Everything below is the minimum a binary that gates
// payments owes: arguments are validated before anything leaves the process,
// failures carry the API's own code, and no request can hang forever.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attestX402Payment,
  fetchAgentScore,
  fetchPayeeScore,
  fetchWalletScore,
  VouchApiError,
} from "../dist/vouch-client.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TX_HASH = `0x${"a".repeat(64)}`;

/** Swap in a fake global fetch for one test, always restoring the real one. */
async function withFetch(fetchFn, env, body) {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  globalThis.fetch = fetchFn;
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ["VOUCH_API_KEY", "VOUCH_API_URL", "VOUCH_TIMEOUT_MS"]) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
}

const jsonFetch = (body, status = 200) => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchFn };
};

/** Accepts the connection and never answers — only the abort ends it. */
const hangingFetch = () => {
  const calls = [];
  const fetchFn = (url, init) => {
    calls.push({ url, init });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  };
  return { calls, fetchFn };
};

const KEY = { VOUCH_API_KEY: "vouch_live_test", VOUCH_API_URL: "https://vet402.test/api/v1" };

// ---------------- input validation ----------------

test("an invalid wallet is rejected before any request leaves the process", async () => {
  const { calls, fetchFn } = jsonFetch({});
  await withFetch(fetchFn, KEY, async () => {
    await assert.rejects(() => fetchPayeeScore("0xnope"), /invalid_wallet_address/);
    await assert.rejects(() => fetchWalletScore("not-a-wallet"), /invalid_wallet_address/);
  });
  assert.equal(calls.length, 0);
});

test("an invalid agent id is rejected before any request", async () => {
  const { calls, fetchFn } = jsonFetch({});
  await withFetch(fetchFn, KEY, async () => {
    await assert.rejects(() => fetchAgentScore("not-a-number"), /invalid_agent_id/);
    await assert.rejects(() => fetchAgentScore("12", "0xnope"), /invalid_wallet_address/);
  });
  assert.equal(calls.length, 0);
});

test("an invalid tx hash is rejected before any attestation is sent", async () => {
  const { calls, fetchFn } = jsonFetch({});
  await withFetch(fetchFn, KEY, async () => {
    await assert.rejects(
      () => attestX402Payment({ wallet: WALLET, txHash: "0xdeadbeef" }),
      /invalid_tx_hash/,
    );
  });
  assert.equal(calls.length, 0);
});

// ---------------- configuration ----------------

test("a missing VOUCH_API_KEY fails with a message that names the env var", async () => {
  const { fetchFn } = jsonFetch({});
  await withFetch(fetchFn, { VOUCH_API_KEY: undefined }, async () => {
    delete process.env.VOUCH_API_KEY;
    await assert.rejects(() => fetchPayeeScore(WALLET), (err) => {
      assert.match(err.message, /VOUCH_API_KEY/);
      return true;
    });
  });
});

test("the bearer token and payee path are what actually go on the wire", async () => {
  const { calls, fetchFn } = jsonFetch({ payee: WALLET, recommendation: "ALLOW" });
  await withFetch(fetchFn, KEY, () => fetchPayeeScore(WALLET));
  assert.equal(calls[0].url, `https://vet402.test/api/v1/payees/${WALLET}/score`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer vouch_live_test");
});

// ---------------- error mapping ----------------

test("a non-2xx answer throws VouchApiError carrying the API's own code", async () => {
  const { fetchFn } = jsonFetch({ error: "rate_limit_exceeded" }, 429);
  await withFetch(fetchFn, KEY, async () => {
    await assert.rejects(() => fetchPayeeScore(WALLET), (err) => {
      assert.ok(err instanceof VouchApiError);
      assert.equal(err.message, "rate_limit_exceeded");
      return true;
    });
  });
});

test("an error body's reason is carried through for the model to see", async () => {
  const { fetchFn } = jsonFetch(
    { error: "attestation_unverifiable", reason: "tx not found on chain" },
    400,
  );
  await withFetch(fetchFn, KEY, async () => {
    await assert.rejects(
      () => attestX402Payment({ wallet: WALLET, txHash: TX_HASH }),
      (err) => {
        assert.equal(err.message, "attestation_unverifiable");
        assert.equal(err.reason, "tx not found on chain");
        return true;
      },
    );
  });
});

test("a non-2xx with an unparseable body still gets a synthetic code", async () => {
  const fetchFn = async () => new Response("Bad Gateway", { status: 502 });
  await withFetch(fetchFn, KEY, async () => {
    await assert.rejects(() => fetchPayeeScore(WALLET), /vouch_api_error_502/);
  });
});

// ---------------- timeout ----------------

test("every request carries an abort signal", async () => {
  const { calls, fetchFn } = jsonFetch({ ok: true });
  await withFetch(fetchFn, KEY, () => fetchPayeeScore(WALLET));
  assert.ok(calls[0].init.signal, "no signal was passed to fetch");
  assert.equal(calls[0].init.signal.aborted, false);
});

test("an upstream that never answers times out instead of hanging", async () => {
  const { calls, fetchFn } = hangingFetch();
  await withFetch(fetchFn, { ...KEY, VOUCH_TIMEOUT_MS: "25" }, async () => {
    await assert.rejects(() => fetchPayeeScore(WALLET), (err) => {
      assert.equal(err.name, "TimeoutError");
      return true;
    });
  });
  assert.ok(calls[0].init.signal.aborted);
});

test("a malformed VOUCH_TIMEOUT_MS falls back instead of taking the server down", async () => {
  // A typo in an MCP client's env block must not break every tool call.
  for (const bad of ["not-a-number", "0", "-5", "Infinity", ""]) {
    const { calls, fetchFn } = jsonFetch({ ok: true });
    await withFetch(fetchFn, { ...KEY, VOUCH_TIMEOUT_MS: bad }, () =>
      fetchPayeeScore(WALLET),
    );
    assert.ok(calls[0].init.signal, `VOUCH_TIMEOUT_MS=${JSON.stringify(bad)} lost the signal`);
    assert.equal(calls[0].init.signal.aborted, false);
  }
});

test("attestation POSTs are bounded too, not just score reads", async () => {
  const { calls, fetchFn } = hangingFetch();
  await withFetch(fetchFn, { ...KEY, VOUCH_TIMEOUT_MS: "25" }, async () => {
    await assert.rejects(() => attestX402Payment({ wallet: WALLET, txHash: TX_HASH }));
  });
  assert.ok(calls[0].init.signal.aborted);
  assert.equal(calls[0].init.method, "POST");
});

// Wave 1 §3.9: read hook under a payment fetch wrapper. Signs and sends stay unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const {
  createVet402ReadHook,
  getVet402ReadSnapshot,
  getVet402LocalRecords,
  getVet402ReadResult,
  appendDecision,
  DEFAULT_DECISION_STORE,
} = await import("../dist/index.js");

// No test may reach the hosted API. Hooks that use the default base read a port that was opened and closed here.
const CLOSED_PORT = await new Promise((resolveP) => {
  const s = http.createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolveP(port));
  });
});
process.env["VET402_API_URL"] = `http://127.0.0.1:${CLOSED_PORT}/api/v1`;

const here = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(here, "../dist");
const HOOK_DIST = join(DIST_DIR, "vet402-read-hook.js");
const PAY_CHECKED_DIST = join(DIST_DIR, "pay-checked.js");

const FORBIDDEN_HOOK_MODULES = [
  "x402-pay.js",
  "pay-or-refuse.js",
  "pay-checked.js",
  "spend-guard.js",
  "svm-pay.js",
  "spend-rules.js",
];
const FORBIDDEN_HOOK_MODULE_PATTERN = /auth-capture.*\.js$/;

function resolveRelativeModule(fromFile, specifier) {
  let path = specifier;
  if (path.endsWith(".js")) {
    return resolve(dirname(fromFile), path);
  }
  const asJs = resolve(dirname(fromFile), `${path}.js`);
  try {
    readFileSync(asJs);
    return asJs;
  } catch {
    const indexJs = resolve(dirname(fromFile), path, "index.js");
    return indexJs;
  }
}

function collectRelativeImportGraph(entryFile) {
  const seen = new Set();
  const stack = [resolve(entryFile)];
  while (stack.length > 0) {
    const abs = stack.pop();
    if (seen.has(abs)) continue;
    let body;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    seen.add(abs);
    const specs = [];
    for (const m of body.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']/g)) specs.push(m[1]);
    for (const m of body.matchAll(/\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g)) specs.push(m[1]);
    for (const spec of specs) {
      stack.push(resolveRelativeModule(abs, spec));
    }
  }
  return seen;
}

const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const OTHER_RESOURCE = "https://example.test/other";

const X402_ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  payTo: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  amount: "1000",
  maxTimeoutSeconds: 60,
};

const X402_AUTHORIZATION = {
  from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  to: X402_ACCEPT.payTo,
  value: "1000",
  validAfter: "0",
  validBefore: "9999999999",
  nonce: `0x${"11".repeat(32)}`,
};

function makeSpyAccount(spy) {
  return {
    address: X402_AUTHORIZATION.from,
    signTypedData: async () => {
      spy.n += 1;
      return `0x${"11".repeat(65)}`;
    },
  };
}

function minimalStoredRow(overrides) {
  return {
    recommendation: "ALLOW",
    reason_codes: [],
    verdict_source: "decision",
    evidence: [],
    decision: null,
    payeeScore: null,
    policy_override: null,
    source: "pay-checked",
    at: new Date().toISOString(),
    status: "paid",
    resource: RESOURCE,
    txHash: null,
    nonce: null,
    ...overrides,
  };
}

/** Same shape as @x402/fetch wrapFetchWithPayment: 402, then one sign and one resend with X-PAYMENT. */
async function wrapFetchWithPayment(baseFetch, spy) {
  const { signX402Payment, encodePaymentHeader } = await import("../dist/x402-pay.js");
  const account = makeSpyAccount(spy);
  const counters = { sign: 0, send: 0 };
  const wrapped = async (input, init) => {
    const first = await baseFetch(input, init);
    if (first.status !== 402) return first;
    const resourceUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { signature } = await signX402Payment({
      account,
      accept: X402_ACCEPT,
      authorization: X402_AUTHORIZATION,
      chainId: 8453,
    });
    counters.sign = spy.n;
    const { headerName, headerValue } = encodePaymentHeader({
      x402Version: 2,
      accept: X402_ACCEPT,
      payload: { signature, authorization: X402_AUTHORIZATION },
      resourceUrl,
    });
    const headers = new Headers(init?.headers);
    headers.set(headerName, headerValue);
    counters.send += 1;
    return baseFetch(input, { ...init, headers });
  };
  wrapped.__counters = counters;
  wrapped.__spy = spy;
  return wrapped;
}

function make402Then200Base() {
  const calls = [];
  return async (input, init) => {
    calls.push({ input, init });
    const headers = new Headers(init?.headers);
    if (!headers.get("X-PAYMENT") && !headers.get("PAYMENT-SIGNATURE")) {
      return new Response("payment required", { status: 402 });
    }
    return new Response("ok", { status: 200 });
  };
}

function startObservatoryServer(onState) {
  let stateHits = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/observatory/state") {
      stateHits += 1;
      return onState(req, res, stateHits);
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        apiBase: `http://127.0.0.1:${port}`,
        getStateHits: () => stateHits,
        close: () => new Promise((r, e) => server.close((err) => (err ? e(err) : r()))),
      });
    });
  });
}

async function assertPaymentParity(hookOptions) {
  const base = make402Then200Base();
  const spyBare = { n: 0 };
  const barePay = await wrapFetchWithPayment(base, spyBare);
  await barePay(RESOURCE);

  const spyHooked = { n: 0 };
  globalThis.__vet402TestSignSpy = spyHooked;
  try {
    const hook = createVet402ReadHook(
      hookOptions ?? {
        readBeforePay: async () => ({ deliveredRatePct: 88, vet402Unreachable: false }),
        readLocalRecords: false,
      },
    );
    const hookedPay = await wrapFetchWithPayment(hook(base), spyHooked);
    await hookedPay(RESOURCE);

    if (hookedPay.__counters.send !== barePay.__counters.send) {
      throw new Error("payment wrapper send count changed under the read hook");
    }
    if (spyHooked.n !== spyBare.n || spyHooked.n !== hookedPay.__counters.sign) {
      throw new Error("extra sign call detected under the read hook");
    }
    assert.equal(spyBare.n, 1);
    assert.equal(barePay.__counters.send, 1);
  } finally {
    delete globalThis.__vet402TestSignSpy;
  }
}

test("payment wrapper: hook inside pay wrap keeps sign and send at one each", async () => {
  await assertPaymentParity();
});

test("hook alone: 402 passes through with base called once and no global fetch", async () => {
  let baseCalls = 0;
  const base = async () => {
    baseCalls += 1;
    return new Response("pay", { status: 402 });
  };
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deliveredOfAttemptsPct: 70 }));
  });
  let globalFetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    globalFetchCalls += 1;
    return origFetch(...args);
  };
  try {
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(
      base,
    );
    const res = await wrapped(RESOURCE);
    assert.equal(res.status, 402);
    assert.equal(baseCalls, 1);
    assert.equal(globalFetchCalls, 0);
    assert.equal(obs.getStateHits(), 1);
  } finally {
    globalThis.fetch = origFetch;
    await obs.close();
  }
});

test("default hook reads observatory state via node http without calling global fetch", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deliveredOfAttemptsPct: 70 }));
  });
  let globalFetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    globalFetchCalls += 1;
    throw new Error("global fetch must not be used for observatory read");
  };
  try {
    let baseCalls = 0;
    const base = async () => {
      baseCalls += 1;
      return new Response("ok", { status: 200 });
    };
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(
      base,
    );
    await wrapped(RESOURCE);
    assert.equal(obs.getStateHits(), 1);
    assert.equal(baseCalls, 1);
    assert.equal(globalFetchCalls, 0);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), {
      deliveredRatePct: 70,
      vet402Unreachable: false,
    });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "ok");
  } finally {
    globalThis.fetch = origFetch;
    await obs.close();
  }
});

test("observatory read uses node http only and ignores global fetch replaced after hook creation", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deliveredOfAttemptsPct: 70 }));
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = origFetch;
  try {
    const createHook = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase });
    let postCreateFetchCalls = 0;
    globalThis.fetch = async () => {
      postCreateFetchCalls += 1;
      throw new Error("replaced global fetch must not be used for observatory read");
    };
    let baseCalls = 0;
    const base = async () => {
      baseCalls += 1;
      return new Response("ok", { status: 200 });
    };
    const wrapped = createHook(base);
    await wrapped(RESOURCE);
    assert.equal(obs.getStateHits(), 1);
    assert.equal(postCreateFetchCalls, 0);
    assert.equal(baseCalls, 1);
  } finally {
    globalThis.fetch = origFetch;
    await obs.close();
  }
});

test("global fetch replaced by a paying wrapper before hook creation: observatory 402 adds no signature", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        accepts: [X402_ACCEPT],
        authorization: X402_AUTHORIZATION,
      }),
    );
  });
  const globalSpy = { n: 0 };
  let globalFetchCalls = 0;
  const origFetch = globalThis.fetch;
  const payingGlobal = await wrapFetchWithPayment(origFetch, globalSpy);
  globalThis.fetch = async (...args) => {
    globalFetchCalls += 1;
    return payingGlobal(...args);
  };
  try {
    const base = async () => new Response("ok", { status: 200 });
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(base);
    await wrapped(RESOURCE);
    assert.equal(globalSpy.n, 0);
    assert.equal(globalFetchCalls, 0);
    assert.equal(obs.getStateHits(), 1);
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "unreachable");
    assert.deepEqual(getVet402ReadSnapshot(wrapped), {
      deliveredRatePct: null,
      vet402Unreachable: true,
    });
  } finally {
    globalThis.fetch = origFetch;
    await obs.close();
  }
});

test("hook inside pay wrap with paying global fetch: sign count stays one", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deliveredOfAttemptsPct: 1 }));
  });
  const globalSpy = { n: 0 };
  const origFetch = globalThis.fetch;
  globalThis.fetch = await wrapFetchWithPayment(origFetch, globalSpy);
  const spyOuter = { n: 0 };
  try {
    const hook = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase });
    const pay = await wrapFetchWithPayment(hook(make402Then200Base()), spyOuter);
    await pay(RESOURCE);
    assert.equal(spyOuter.n, 1);
    assert.equal(pay.__counters.send, 1);
    assert.equal(globalSpy.n, 0);
  } finally {
    globalThis.fetch = origFetch;
    await obs.close();
  }
});

test("dist hook import graph avoids payment modules (pay-checked reaches x402-pay)", () => {
  const hookGraph = collectRelativeImportGraph(HOOK_DIST);
  const hookBasenames = [...hookGraph].map((p) => p.split("/").pop());
  for (const forbidden of FORBIDDEN_HOOK_MODULES) {
    assert.ok(!hookBasenames.includes(forbidden), `hook graph must not include ${forbidden}`);
  }
  for (const name of hookBasenames) {
    assert.doesNotMatch(name, FORBIDDEN_HOOK_MODULE_PATTERN, `hook graph must not include ${name}`);
  }

  const payCheckedGraph = collectRelativeImportGraph(PAY_CHECKED_DIST);
  const payCheckedBasenames = [...payCheckedGraph].map((p) => p.split("/").pop());
  assert.ok(payCheckedBasenames.includes("x402-pay.js"), "pay-checked graph should reach x402-pay.js");

  const hookBody = readFileSync(HOOK_DIST, "utf8");
  const storeMatch = hookBody.match(/DEFAULT_STORE_PATH\s*=\s*"([^"]+)"/);
  assert.ok(storeMatch, "DEFAULT_STORE_PATH in vet402-read-hook.js");
  assert.equal(storeMatch[1], DEFAULT_DECISION_STORE);

  for (const name of [
    "signX402Payment",
    "executeX402Payment",
    "payOrRefuse",
    "payChecked",
    "SpendGuard",
    "appendDecision",
    "signTypedData",
    "sendTransaction",
    "writeContract",
    "createChainPayment",
  ]) {
    assert.doesNotMatch(hookBody, new RegExp(`\\b${name}\\b`), name);
  }
  for (const api of [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "createWriteStream",
    "rm",
    "unlink",
    "mkdir",
  ]) {
    assert.doesNotMatch(hookBody, new RegExp(`\\b${api}\\b`), api);
  }
});

test("hanging readBeforePay times out and payment wrapper still signs once", async () => {
  let underlyingCalls = 0;
  const base = async (input, init) => {
    underlyingCalls += 1;
    const headers = new Headers(init?.headers);
    if (!headers.get("X-PAYMENT") && !headers.get("PAYMENT-SIGNATURE")) {
      return new Response("payment required", { status: 402 });
    }
    return new Response("ok", { status: 200 });
  };
  const hooked = createVet402ReadHook({
    readTimeoutMs: 50,
    readLocalRecords: false,
    readBeforePay: () => new Promise(() => {}),
  })(base);
  const spy = { n: 0 };
  const payWrapped = await wrapFetchWithPayment(hooked, spy);
  const res = await payWrapped(RESOURCE);
  assert.equal(res.status, 200);
  assert.equal(underlyingCalls, 2);
  assert.equal(spy.n, 1);
  assert.deepEqual(getVet402ReadSnapshot(hooked), {
    deliveredRatePct: null,
    vet402Unreachable: true,
  });
  assert.equal(getVet402ReadResult(hooked).snapshotStatus, "timeout");
});

test("payment parity guard rejects a hook that calls signX402Payment", async () => {
  await assert.rejects(
    () =>
      assertPaymentParity({
        readLocalRecords: false,
        readBeforePay: async () => {
          const { signX402Payment } = await import("../dist/x402-pay.js");
          const spy = globalThis.__vet402TestSignSpy;
          await signX402Payment({
            account: makeSpyAccount(spy),
            accept: X402_ACCEPT,
            authorization: X402_AUTHORIZATION,
            chainId: 8453,
          });
          return { deliveredRatePct: 1, vet402Unreachable: false };
        },
      }),
    /extra sign call detected under the read hook/,
  );
});

test("unreachable vet402: payment still succeeds, snapshot empty, local records empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-hook-empty-"));
  const missingStore = join(dir, "nope.jsonl");
  const base = make402Then200Base();
  const spy = { n: 0 };
  const hook = createVet402ReadHook({
    store: missingStore,
    readBeforePay: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const hooked = hook(base);
  const payWrapped = await wrapFetchWithPayment(hooked, spy);
  const res = await payWrapped(RESOURCE);
  assert.equal(res.status, 200);
  assert.equal(spy.n, 1);
  assert.deepEqual(getVet402ReadSnapshot(hooked), {
    deliveredRatePct: null,
    vet402Unreachable: true,
  });
  assert.deepEqual(getVet402LocalRecords(hooked), []);
  assert.equal(getVet402ReadResult(hooked).local.status, "unreachable");
});

test("local JSONL scan stops after read timeout and leaves no partial records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-hook-deadline-"));
  const store = join(dir, "decisions.jsonl");
  const line = JSON.stringify(minimalStoredRow({ resource: RESOURCE }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(store, `${line}\n`.repeat(20_000), "utf8");

  let baseCalls = 0;
  const base = async () => {
    baseCalls += 1;
    return new Response("ok", { status: 200 });
  };
  const wrapped = createVet402ReadHook({
    store,
    readTimeoutMs: 1,
    readBeforePay: async () => ({ deliveredRatePct: 1, vet402Unreachable: false }),
  })(base);
  await wrapped(RESOURCE);
  assert.equal(baseCalls, 1);
  assert.deepEqual(getVet402LocalRecords(wrapped), []);
  assert.equal(getVet402ReadResult(wrapped).local.status, "timeout");
});

test("decision store: matching resource rows, no writes, missing path, bad lines, Request input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-hook-store-"));
  const store = join(dir, "decisions.jsonl");

  await appendDecision(minimalStoredRow({ resource: RESOURCE, at: "2026-01-01T00:00:00.000Z" }), { store });
  await appendDecision(minimalStoredRow({ resource: RESOURCE, at: "2026-01-02T00:00:00.000Z" }), { store });
  await appendDecision(minimalStoredRow({ resource: OTHER_RESOURCE }), { store });

  const bytesBefore = readFileSync(store);

  const base = async () => new Response("ok");
  const wrapped = createVet402ReadHook({
    store,
    readBeforePay: async () => ({ deliveredRatePct: 10, vet402Unreachable: false }),
  })(base);

  await wrapped(RESOURCE);
  const records = getVet402LocalRecords(wrapped);
  assert.equal(records?.length, 2);
  assert.ok(records.every((r) => r.resource === RESOURCE));

  const bytesAfter = readFileSync(store);
  assert.deepEqual(bytesAfter, bytesBefore);

  const missingStore = join(dir, "missing.jsonl");
  const wrappedMissing = createVet402ReadHook({ store: missingStore })(base);
  await wrappedMissing(RESOURCE);
  assert.deepEqual(getVet402LocalRecords(wrappedMissing), []);

  const corruptStore = join(dir, "corrupt.jsonl");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    corruptStore,
    `${JSON.stringify(minimalStoredRow({ resource: RESOURCE }))}\n{not json\n`,
    "utf8",
  );
  const wrappedCorrupt = createVet402ReadHook({ store: corruptStore })(base);
  await wrappedCorrupt(RESOURCE);
  assert.equal(getVet402LocalRecords(wrappedCorrupt)?.length, 1);

  const req = new Request(RESOURCE);
  const wrappedReq = createVet402ReadHook({ store })(base);
  await wrappedReq(req);
  assert.equal(getVet402LocalRecords(wrappedReq)?.length, 2);

  const wrappedOff = createVet402ReadHook({ store, readLocalRecords: false })(base);
  await wrappedOff(RESOURCE);
  assert.equal(getVet402LocalRecords(wrappedOff), undefined);
});

test("slow or throwing observatory read leaves init reference unchanged", async () => {
  const init = { method: "POST", headers: { "X-Custom": "keep" }, body: "payload" };
  const slow = createVet402ReadHook({
    readLocalRecords: false,
    readBeforePay: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { deliveredRatePct: 55, vet402Unreachable: false };
    },
  })(async (_input, passedInit) => {
    assert.strictEqual(passedInit, init);
    return new Response("ok");
  });
  await slow(RESOURCE, init);

  const throwing = createVet402ReadHook({
    readLocalRecords: false,
    readBeforePay: async () => {
      throw new Error("read failed");
    },
  })(async (_input, passedInit) => {
    assert.strictEqual(passedInit, init);
    return new Response("ok");
  });
  await throwing(RESOURCE, init);
});

test("snapshot status ok from observatory delivered rate", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deliveredOfAttemptsPct: 42 }));
  });
  try {
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(
      async () => new Response("ok"),
    );
    await wrapped(RESOURCE);
    const snap = getVet402ReadSnapshot(wrapped);
    assert.deepEqual(snap, { deliveredRatePct: 42, vet402Unreachable: false });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "ok");
  } finally {
    await obs.close();
  }
});

test("snapshot status none from observatory zero attempts", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ l1: { attempts: 0, delivered: 0 } }));
  });
  try {
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(
      async () => new Response("ok"),
    );
    await wrapped(RESOURCE);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: false });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "none");
  } finally {
    await obs.close();
  }
});

test("snapshot status timeout when observatory server never responds", async () => {
  const obs = await startObservatoryServer(() => {});
  try {
    const wrapped = createVet402ReadHook({
      readLocalRecords: false,
      observatoryApiBase: obs.apiBase,
      readTimeoutMs: 50,
    })(async () => new Response("ok"));
    await wrapped(RESOURCE);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: true });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "timeout");
  } finally {
    await obs.close();
  }
});

test("snapshot status unreachable on observatory HTTP 402", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(402);
    res.end();
  });
  try {
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(
      async () => new Response("ok"),
    );
    await wrapped(RESOURCE);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: true });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "unreachable");
  } finally {
    await obs.close();
  }
});

test("snapshot status unreachable on observatory HTTP 500", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(500);
    res.end("error");
  });
  try {
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(
      async () => new Response("ok"),
    );
    await wrapped(RESOURCE);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: true });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "unreachable");
  } finally {
    await obs.close();
  }
});

test("snapshot status unreachable on closed observatory port", async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const wrapped = createVet402ReadHook({
    readLocalRecords: false,
    observatoryApiBase: `http://127.0.0.1:${port}`,
    readTimeoutMs: 500,
  })(async () => new Response("ok"));
  await wrapped(RESOURCE);
  assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: true });
  assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "unreachable");
});

test("snapshot status unreachable on invalid observatory JSON", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{not-json");
  });
  try {
    const wrapped = createVet402ReadHook({ readLocalRecords: false, observatoryApiBase: obs.apiBase })(
      async () => new Response("ok"),
    );
    await wrapped(RESOURCE);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: true });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "unreachable");
  } finally {
    await obs.close();
  }
});

test("snapshot status truncated on oversized observatory response", async () => {
  const obs = await startObservatoryServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20; i += 1) res.write(chunk);
    res.end();
  });
  const t0 = Date.now();
  try {
    let baseCalls = 0;
    const wrapped = createVet402ReadHook({
      readLocalRecords: false,
      observatoryApiBase: obs.apiBase,
      maxResponseBytes: 65_536,
      readTimeoutMs: 2000,
    })(async () => {
      baseCalls += 1;
      return new Response("ok");
    });
    await wrapped(RESOURCE);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(baseCalls, 1);
    assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: null, vet402Unreachable: true });
    assert.equal(getVet402ReadResult(wrapped).snapshotStatus, "truncated");
  } finally {
    await obs.close();
  }
});

test("local status ok when JSONL rows match resource", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-hook-local-ok-"));
  const store = join(dir, "d.jsonl");
  await appendDecision(minimalStoredRow({ resource: RESOURCE }), { store });
  const wrapped = createVet402ReadHook({
    store,
    readBeforePay: async () => ({ deliveredRatePct: 1, vet402Unreachable: false }),
  })(async () => new Response("ok"));
  await wrapped(RESOURCE);
  assert.equal(getVet402LocalRecords(wrapped)?.length, 1);
  assert.equal(getVet402ReadResult(wrapped).local.status, "ok");
});

test("local status none when JSONL has no matching resource", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-hook-local-none-"));
  const store = join(dir, "d.jsonl");
  await appendDecision(minimalStoredRow({ resource: OTHER_RESOURCE }), { store });
  const wrapped = createVet402ReadHook({ store })(async () => new Response("ok"));
  await wrapped(RESOURCE);
  assert.deepEqual(getVet402LocalRecords(wrapped), []);
  assert.equal(getVet402ReadResult(wrapped).local.status, "none");
});

test("local status unreachable on missing store path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-hook-local-unreach-"));
  const store = join(dir, "missing.jsonl");
  const wrapped = createVet402ReadHook({ store })(async () => new Response("ok"));
  await wrapped(RESOURCE);
  assert.deepEqual(getVet402LocalRecords(wrapped), []);
  assert.equal(getVet402ReadResult(wrapped).local.status, "unreachable");
});

test("oversized JSONL returns within readTimeoutMs as truncated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-hook-big-jsonl-"));
  const store = join(dir, "big.jsonl");
  const filler = JSON.stringify(minimalStoredRow({ resource: OTHER_RESOURCE }));
  const tailMatch = JSON.stringify(
    minimalStoredRow({ resource: RESOURCE, at: "2026-11-13T00:00:00.000Z" }),
  );
  const fillerBlock = `${filler}\n`.repeat(400_000);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(store, fillerBlock + `${tailMatch}\n`, "utf8");

  const t0 = Date.now();
  const wrapped = createVet402ReadHook({
    store,
    maxStoreBytes: 65_536,
    readTimeoutMs: 2000,
    readBeforePay: async () => ({ deliveredRatePct: null, vet402Unreachable: false }),
  })(async () => new Response("ok"));
  await wrapped(RESOURCE);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(getVet402ReadResult(wrapped).local.status, "truncated");
  const records = getVet402LocalRecords(wrapped);
  assert.ok(records.some((r) => r.at === "2026-11-13T00:00:00.000Z"));

  const store5 = join(dir, "big5.jsonl");
  const fiveMbPad = " ".repeat(5 * 1024 * 1024);
  await writeFile(store5, `${fiveMbPad}\n${tailMatch}\n`, "utf8");
  const t1 = Date.now();
  const wrapped5 = createVet402ReadHook({
    store: store5,
    readTimeoutMs: 2000,
    readBeforePay: async () => ({ deliveredRatePct: null, vet402Unreachable: false }),
  })(async () => new Response("ok"));
  await wrapped5(RESOURCE);
  assert.ok(Date.now() - t1 < 2000);
  assert.equal(getVet402ReadResult(wrapped5).local.status, "truncated");
});

test("readLocalRecords false: getVet402ReadResult has no local part", async () => {
  const wrapped = createVet402ReadHook({
    readLocalRecords: false,
    readBeforePay: async () => ({ deliveredRatePct: 5, vet402Unreachable: false }),
  })(async () => new Response("ok"));
  await wrapped(RESOURCE);
  assert.equal(getVet402LocalRecords(wrapped), undefined);
  const result = getVet402ReadResult(wrapped);
  assert.equal(result.local, undefined);
  assert.equal(result.snapshotStatus, "ok");
  assert.deepEqual(getVet402ReadSnapshot(wrapped), { deliveredRatePct: 5, vet402Unreachable: false });
});

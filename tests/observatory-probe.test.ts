// ============================================================
// vet402 Observatory L0 — no-purchase probe (design §4).
//
// The #3113 guard is the reason this module exists in this shape: probing a
// POST-declared endpoint with GET makes a healthy service look dead. So:
//   - the probe NEVER guesses a method — undeclared means no request at all,
//     verdict `unverified`;
//   - a POST-declared endpoint is probed with POST (asserted here);
//   - a single fail is never a publishable fail (legal: multiple-measurement
//     condition) — publishedVerdict() gates on consecutive fails.
// A 402 challenge is the healthy signal; anything else is recorded as fact
// with a factual reason code, never an evaluative word.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeEndpoint,
  publishedVerdict,
  MIN_CONSECUTIVE_FAILS_TO_PUBLISH,
  type ProbeTarget,
} from "@/lib/observatory/l0-probe";

const CATALOG_ACCEPT = {
  amount: "3000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  network: "eip155:8453",
  payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
};

function target(overrides: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    resourceUrl: "https://svc.example/api",
    method: "GET",
    payTo: CATALOG_ACCEPT.payTo,
    network: CATALOG_ACCEPT.network,
    priceAmount: CATALOG_ACCEPT.amount,
    priceAsset: CATALOG_ACCEPT.asset,
    ...overrides,
  };
}

/** A well-formed x402 challenge matching the catalog declaration. */
function challengeBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        amount: CATALOG_ACCEPT.amount,
        asset: CATALOG_ACCEPT.asset,
        network: CATALOG_ACCEPT.network,
        payTo: CATALOG_ACCEPT.payTo,
        ...overrides,
      },
    ],
  });
}

function respond(status: number, body: string) {
  return async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
}

// 2026-09-02 製品定義書 §6.1: 「GET および、掲載が POST のみなら POST」。宣言の無い
// Resource は GET で測る（それ以前は「推測しない」として unverified・無送信だった）。
// GET は x402 の壁に対して副作用の無い最小の問い合わせであり、#3113 が守っていた
// 「宣言に無い POST を撃たない」はそのまま保たれる。
test("undeclared method → probed with GET (§6.1), never POST", async () => {
  let seen: string | undefined;
  const result = await probeEndpoint(target({ method: null }), {
    fetchImpl: async (_url, init) => {
      seen = init?.method;
      return new Response("", { status: 500 });
    },
  });
  assert.equal(seen, "GET");
  assert.equal(result.method, "GET");
  assert.equal(result.failReason, "no_402");
});

test("a POST-declared endpoint is probed with POST — the #3113 regression test", async () => {
  let seenMethod: string | undefined;
  const result = await probeEndpoint(target({ method: "POST" }), {
    fetchImpl: async (_url, init) => {
      seenMethod = init?.method;
      return new Response(challengeBody(), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(seenMethod, "POST");
  assert.equal(result.verdict, "pass");
});

test("402 with accepts matching the catalog declaration → pass, all checks true", async () => {
  const result = await probeEndpoint(target(), {
    fetchImpl: respond(402, challengeBody()),
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.httpStatus, 402);
  assert.equal(result.has402Challenge, true);
  assert.equal(result.acceptsValid, true);
  assert.equal(result.priceConsistent, true);
  assert.equal(result.metadataConsistent, true);
  assert.equal(result.failReason, null);
  assert.ok(typeof result.latencyMs === "number");
});

test("2xx (no payment wall) → fail with no_402 — recorded, not retried here", async () => {
  const result = await probeEndpoint(target(), { fetchImpl: respond(200, "{}") });
  assert.equal(result.verdict, "fail");
  assert.equal(result.failReason, "no_402");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.has402Challenge, false);
});

test("404 → fail with no_402 and the status preserved as evidence", async () => {
  const result = await probeEndpoint(target(), { fetchImpl: respond(404, "not found") });
  assert.equal(result.verdict, "fail");
  assert.equal(result.httpStatus, 404);
});

test("network failures map to factual reason codes", async () => {
  const dns = await probeEndpoint(target(), {
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND svc.example"), {
          code: "ENOTFOUND",
        }),
      });
    },
  });
  assert.equal(dns.verdict, "fail");
  assert.equal(dns.failReason, "dns");

  const tls = await probeEndpoint(target(), {
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("certificate has expired"), {
          code: "CERT_HAS_EXPIRED",
        }),
      });
    },
  });
  // 2026-09-02 製品定義書 §6.1: 「TLSエラー、地理ブロック、レート制限で判定不能なら
  // unverified」。到達不能（dns / timeout）は fail のまま——壁に届いていない。
  assert.equal(tls.verdict, "unverified");
  assert.equal(tls.failReason, "tls");

  const timeout = await probeEndpoint(target(), {
    fetchImpl: async () => {
      throw Object.assign(new DOMException("The operation was aborted", "AbortError"), {});
    },
  });
  assert.equal(timeout.verdict, "fail");
  assert.equal(timeout.failReason, "timeout");
});

test("402 whose price contradicts the catalog → fail price_mismatch (both facts recorded)", async () => {
  const result = await probeEndpoint(target(), {
    fetchImpl: respond(402, challengeBody({ amount: "99999" })),
  });
  assert.equal(result.verdict, "fail");
  assert.equal(result.failReason, "price_mismatch");
  assert.equal(result.has402Challenge, true);
  assert.equal(result.priceConsistent, false);
});

test("402 whose payTo contradicts the catalog → fail metadata_mismatch", async () => {
  const result = await probeEndpoint(target(), {
    fetchImpl: respond(402, challengeBody({ payTo: "0x0000000000000000000000000000000000000bad" })),
  });
  assert.equal(result.verdict, "fail");
  assert.equal(result.failReason, "metadata_mismatch");
  assert.equal(result.metadataConsistent, false);
});

test("402 with an unparseable body → fail accepts_invalid", async () => {
  const result = await probeEndpoint(target(), {
    fetchImpl: respond(402, "<html>payment required</html>"),
  });
  assert.equal(result.verdict, "fail");
  assert.equal(result.failReason, "accepts_invalid");
  assert.equal(result.acceptsValid, false);
});

test("catalog rows with no declared price still pass on a valid 402 (consistency checks skip, not fail)", async () => {
  const result = await probeEndpoint(
    target({ priceAmount: null, priceAsset: null, payTo: null, network: null }),
    { fetchImpl: respond(402, challengeBody()) },
  );
  assert.equal(result.verdict, "pass");
  assert.equal(result.priceConsistent, null);
  assert.equal(result.metadataConsistent, null);
});

// ---- publication gate: a single fail is not a published fail ----------------

test("publishedVerdict never publishes a single fail", () => {
  assert.equal(MIN_CONSECUTIVE_FAILS_TO_PUBLISH, 2);
  // newest first
  assert.equal(publishedVerdict(["fail"]), "unverified");
  assert.equal(publishedVerdict(["fail", "pass"]), "unverified");
  assert.equal(publishedVerdict(["fail", "fail"]), "fail");
  assert.equal(publishedVerdict(["fail", "fail", "pass"]), "fail");
  assert.equal(publishedVerdict(["pass", "fail", "fail"]), "pass");
  assert.equal(publishedVerdict(["unverified", "fail", "fail"]), "unverified");
  assert.equal(publishedVerdict([]), "unverified");
});

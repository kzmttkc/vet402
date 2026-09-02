// ============================================================
// SSRF guard for outbound fetches whose URL we did not choose.
//
// The observatory probes ~15k endpoints whose `resource` URL is copied
// verbatim out of the public Bazaar discovery catalog — third-party,
// self-declared input. Nothing in that pipeline used to stop a listed
// resource from pointing at 169.254.169.254, 127.0.0.1, or a bare internal
// name, and both the L0 prober and the L1 purchaser followed redirects, so
// even a public-looking host could bounce us inward.
//
// These tests fix the contract: no socket to a non-public address, on the
// first hop or any later one.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UnsafeTargetError,
  isPublicHostUrl,
  safeFetch,
} from "@/lib/net/safe-fetch";
import type { AddressResolver } from "@/lib/net/public-address";
import { probeEndpoint } from "@/lib/observatory/l0-probe";

/** Resolver stub: every hostname maps to whatever the table says. */
function resolver(table: Record<string, string[]>): AddressResolver {
  return async (hostname: string) => {
    const addrs = table[hostname];
    if (!addrs) throw new Error(`NXDOMAIN ${hostname}`);
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

function response(status: number, headers: Record<string, string> = {}, body = "") {
  return new Response(body, { status, headers });
}

// ---- string-level gate ------------------------------------------------------

test("isPublicHostUrl rejects the addresses an SSRF actually aims at", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/", // EC2/IMDS
    "http://169.254.170.2/v2/credentials/", // ECS task role
    "http://[fd00::1]/", // ULA
    "http://[::1]:9001/2018-06-01/runtime/invocation/next", // Lambda runtime API
    "http://127.0.0.1:3000/api/admin/gate2",
    "http://localhost/",
    "https://vault.internal/v1/secret",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://10.0.0.5/",
    "https://192.168.1.1/",
    "https://172.16.0.1/",
    "https://100.64.0.1/", // CGNAT
    "https://redis/", // bare single-label internal name
    "file:///etc/passwd",
    "data:text/plain,hello",
    "ftp://example.com/",
    "https://user:pass@example.com/", // credentials smuggled into the URL
    "not a url",
  ]) {
    assert.equal(isPublicHostUrl(url), false, `should reject ${url}`);
  }
});

test("isPublicHostUrl accepts ordinary public endpoints", () => {
  for (const url of [
    "https://api.example.com/paid",
    "http://api.example.com/paid",
    "https://api.example.com:8443/paid",
    "https://8.8.8.8/",
  ]) {
    assert.equal(isPublicHostUrl(url), true, `should accept ${url}`);
  }
});

// ---- resolved-address gate --------------------------------------------------

test("safeFetch refuses a public-looking name that resolves to link-local", async () => {
  let called = 0;
  await assert.rejects(
    () =>
      safeFetch(
        "https://evil.example/paid",
        {},
        {
          fetchImpl: async () => {
            called++;
            return response(200);
          },
          resolve: resolver({ "evil.example": ["169.254.169.254"] }),
        },
      ),
    (error: unknown) =>
      error instanceof UnsafeTargetError && error.reason === "unsafe_host",
  );
  assert.equal(called, 0, "no socket may be opened to a rejected target");
});

test("safeFetch refuses when ANY resolved address is private", async () => {
  await assert.rejects(
    () =>
      safeFetch(
        "https://mixed.example/paid",
        {},
        {
          fetchImpl: async () => response(402),
          resolve: resolver({ "mixed.example": ["93.184.216.34", "10.1.2.3"] }),
        },
      ),
    (error: unknown) => error instanceof UnsafeTargetError,
  );
});

test("safeFetch refuses a name that does not resolve", async () => {
  await assert.rejects(
    () => safeFetch("https://nope.example/x", {}, { fetchImpl: async () => response(402), resolve: resolver({}) }),
    (error: unknown) => error instanceof UnsafeTargetError && error.reason === "unresolvable",
  );
});

test("safeFetch passes a public target through untouched", async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const res = await safeFetch(
    "https://api.example.com/paid",
    { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    {
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init?.method });
        return response(402, { "content-type": "application/json" }, "{}");
      },
      resolve: resolver({ "api.example.com": ["93.184.216.34"] }),
    },
  );
  assert.equal(res.status, 402);
  assert.deepEqual(seen, [{ url: "https://api.example.com/paid", method: "POST" }]);
});

// ---- redirects: the bypass that makes a first-hop-only check theater --------

test("safeFetch re-checks every redirect hop", async () => {
  const hops: string[] = [];
  await assert.rejects(
    () =>
      safeFetch(
        "https://api.example.com/paid",
        {},
        {
          fetchImpl: async (url) => {
            hops.push(url);
            return response(302, { location: "http://169.254.169.254/latest/meta-data/" });
          },
          resolve: resolver({ "api.example.com": ["93.184.216.34"] }),
        },
      ),
    (error: unknown) => error instanceof UnsafeTargetError && error.reason === "unsafe_host",
  );
  assert.deepEqual(hops, ["https://api.example.com/paid"], "the inward hop is never requested");
});

test("safeFetch follows a legitimate redirect and returns the final response", async () => {
  const hops: string[] = [];
  const res = await safeFetch(
    "https://api.example.com/paid",
    {},
    {
      fetchImpl: async (url) => {
        hops.push(url);
        if (hops.length === 1) return response(301, { location: "/v2/paid" });
        return response(402, {}, '{"accepts":[]}');
      },
      resolve: resolver({ "api.example.com": ["93.184.216.34"] }),
    },
  );
  assert.equal(res.status, 402);
  assert.deepEqual(hops, ["https://api.example.com/paid", "https://api.example.com/v2/paid"]);
});

test("safeFetch stops a redirect loop instead of following it forever", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      safeFetch(
        "https://api.example.com/a",
        {},
        {
          fetchImpl: async () => {
            calls++;
            return response(302, { location: "https://api.example.com/a" });
          },
          resolve: resolver({ "api.example.com": ["93.184.216.34"] }),
          maxRedirects: 3,
        },
      ),
    (error: unknown) =>
      error instanceof UnsafeTargetError && error.reason === "too_many_redirects",
  );
  assert.equal(calls, 4, "initial request + maxRedirects follows, then stop");
});

test("safeFetch demotes POST to GET on a 303 the way the platform fetch does", async () => {
  const seen: Array<{ method?: string; hasBody: boolean; contentType: string | null }> = [];
  await safeFetch(
    "https://api.example.com/paid",
    { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    {
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          method: init?.method,
          hasBody: init?.body !== undefined && init?.body !== null,
          contentType: headers.get("content-type"),
        });
        return seen.length === 1
          ? response(303, { location: "https://api.example.com/done" })
          : response(402);
      },
      resolve: resolver({ "api.example.com": ["93.184.216.34"] }),
    },
  );
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[1].hasBody, false);
  assert.equal(seen[1].contentType, null);
});

// ---- the observatory's production default -----------------------------------
//
// These call probeEndpoint with NO injected fetchImpl, i.e. exactly what the
// cron runs. A catalog row aimed inward must cost zero requests and must be
// recorded as `unverified` — "we did not measure it", never `fail`, which is a
// published claim about the seller.

test("L0 probe refuses a catalog row pointing at the metadata service", async () => {
  const result = await probeEndpoint({
    resourceUrl: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    method: "GET",
    payTo: null,
    network: null,
    priceAmount: null,
    priceAsset: null,
  });
  assert.equal(result.verdict, "unverified");
  assert.equal(result.failReason, "unsafe_target");
  assert.equal(result.httpStatus, null);
});

test("L0 probe refuses loopback and bare internal names", async () => {
  for (const resourceUrl of [
    "http://127.0.0.1:3000/api/admin/gate2",
    "http://localhost:9001/2018-06-01/runtime/invocation/next",
    "https://vault.internal/v1/secret",
    "file:///etc/passwd",
  ]) {
    const result = await probeEndpoint({
      resourceUrl,
      method: "GET",
      payTo: null,
      network: null,
      priceAmount: null,
      priceAsset: null,
    });
    assert.equal(result.verdict, "unverified", resourceUrl);
    assert.equal(result.failReason, "unsafe_target", resourceUrl);
  }
});

// ---- IPv6 forms that embed an IPv4 (2026-09-02 adversarial audit, S1) -------
//
// WHATWG URL rewrites `http://[::ffff:127.0.0.1]/` into `[::ffff:7f00:1]`, so
// a guard that only looks for a dotted-quad tail never sees the loopback it
// was meant to reject. Every IPv4-embedding IPv6 form must be judged as the
// IPv4 it targets — mapped, compatible, NAT64 (both prefixes), 6to4 — whether
// written hex, dotted, upper-case, or fully expanded.

test("isPublicHostUrl rejects IPv6 literals that embed a private IPv4", () => {
  for (const url of [
    "http://[::ffff:127.0.0.1]/", // mapped, dotted (URL normalizes to hex)
    "http://[::ffff:7f00:1]/", // mapped, hex
    "http://[::FFFF:7F00:1]/", // mapped, upper-case
    "http://[0:0:0:0:0:ffff:7f00:1]/", // mapped, no zero compression
    "http://[0000:0000:0000:0000:0000:ffff:a9fe:a9fe]/", // mapped IMDS, expanded
    "http://[::7f00:1]/", // IPv4-compatible (::/96)
    "http://[::a9fe:a9fe]/", // IPv4-compatible IMDS
    "http://[64:ff9b::7f00:1]/", // NAT64 well-known prefix
    "http://[64:ff9b::a9fe:a9fe]/", // NAT64 → IMDS
    "http://[64:FF9B::0A00:0001]/", // NAT64, upper-case, 10.0.0.1
    "http://[64:ff9b:1::7f00:1]/", // NAT64 local-use prefix (64:ff9b:1::/48)
    "http://[64:ff9b:1:abcd::7f00:1]/", // NAT64 local-use, non-zero middle
    "http://[2002:7f00:1::]/", // 6to4 → 127.0.0.1
    "http://[2002:a9fe:a9fe::1]/", // 6to4 → 169.254.169.254
    "http://[2002:c0a8:101::]/", // 6to4 → 192.168.1.1
  ]) {
    assert.equal(isPublicHostUrl(url), false, `should reject ${url}`);
  }
});

test("isPublicHostUrl still accepts IPv6 literals that embed a public IPv4", () => {
  for (const url of [
    "http://[::ffff:8.8.8.8]/",
    "http://[::ffff:808:808]/",
    "http://[64:ff9b::808:808]/",
    "http://[2002:808:808::]/",
    "https://[2606:4700:4700::1111]/",
  ]) {
    assert.equal(isPublicHostUrl(url), true, `should accept ${url}`);
  }
});

test("safeFetch refuses a name whose AAAA is an IPv4-mapped loopback in hex", async () => {
  let called = 0;
  await assert.rejects(
    () =>
      safeFetch(
        "https://mapped.example/paid",
        {},
        {
          fetchImpl: async () => {
            called++;
            return response(200);
          },
          resolve: resolver({ "mapped.example": ["::ffff:7f00:1"] }),
        },
      ),
    (error: unknown) => error instanceof UnsafeTargetError && error.reason === "unsafe_host",
  );
  assert.equal(called, 0, "no socket may be opened to a mapped loopback");
});

test("safeFetch refuses a redirect to an IPv6 literal that embeds a private IPv4", async () => {
  const hops: string[] = [];
  await assert.rejects(
    () =>
      safeFetch(
        "https://api.example.com/paid",
        {},
        {
          fetchImpl: async (url) => {
            hops.push(url);
            return response(302, { location: "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/" });
          },
          resolve: resolver({ "api.example.com": ["93.184.216.34"] }),
        },
      ),
    (error: unknown) => error instanceof UnsafeTargetError && error.reason === "unsafe_host",
  );
  assert.deepEqual(hops, ["https://api.example.com/paid"], "the NAT64 hop must never be fetched");
});

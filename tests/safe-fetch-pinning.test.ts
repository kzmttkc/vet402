// ============================================================
// DNS-rebinding closure for safeFetch (2026-09-02 audit P2-1).
//
// The gate in safe-fetch.ts resolves a hostname and judges every address it
// gets back. Until now the socket was then opened by a SECOND, independent
// resolution inside fetch — so a record that answers 93.184.216.34 to the
// gate and 127.0.0.1 to the connect wins. The public, key-less
// POST /api/v1/demo/verify reaches this path.
//
// These tests fix the closed contract:
//   - the transport connects to the addresses the gate verified and NOTHING
//     else — it never performs a DNS lookup of its own (fail-closed when no
//     pin was supplied);
//   - safeFetch hands each hop's verified addresses to the transport, so a
//     flip between "check" and "connect" cannot move the socket;
//   - IP literals are pinned as written, without a resolver round-trip;
//   - the Host header / SNI stay the hostname (the pin changes where the
//     socket goes, not what the server is told).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  PinMissingError,
  createPinnedLookup,
  pinnedFetch,
  type PinnedTarget,
} from "@/lib/net/pinned-fetch";
import { safeFetch } from "@/lib/net/safe-fetch";
import type { AddressResolver } from "@/lib/net/public-address";

function response(status: number, headers: Record<string, string> = {}, body = "") {
  return new Response(body, { status, headers });
}

/** A loopback HTTP server that records what the client told it. */
async function withServer<T>(
  fn: (port: number, seen: Array<{ host: string | undefined; url: string | undefined; remote: string | undefined }>) => Promise<T>,
): Promise<T> {
  const seen: Array<{ host: string | undefined; url: string | undefined; remote: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url, remote: req.socket.remoteAddress });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(port, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---- the transport: connects where the pin says, never where DNS says ------

test("pinnedFetch connects to the pinned address and never asks DNS", async () => {
  // `.invalid` is reserved (RFC 2606) and never resolves. If this request
  // reaches the loopback server, the socket went where the pin said, not
  // where a resolver would have sent it.
  await withServer(async (port, seen) => {
    const pin: PinnedTarget = {
      hostname: "pinned.invalid",
      addresses: [{ address: "127.0.0.1", family: 4 }],
    };
    const res = await pinnedFetch(`http://pinned.invalid:${port}/probe`, { method: "GET" }, pin);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "pinned ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, `pinned.invalid:${port}`, "Host header keeps the name, not the IP");
    assert.equal(seen[0].url, "/probe");
    assert.equal(seen[0].remote, "127.0.0.1");
  });
});

test("pinnedFetch refuses to open a socket when no pin was supplied", async () => {
  // Fail-closed: a request that reaches the transport without a verified
  // address set must not fall back to the system resolver. The error is ours
  // (pin missing), not the resolver's (ENOTFOUND), which is the proof that
  // DNS was never consulted.
  await withServer(async (port) => {
    await assert.rejects(
      () => pinnedFetch(`http://unpinned.invalid:${port}/`, { method: "GET" }),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause;
        return cause instanceof PinMissingError && cause.code === "ERR_OUTBOUND_PIN_MISSING";
      },
    );
  });
});

// ---- the lookup handed to undici: the only thing net.connect may consult ---

test("pinned lookup answers only from the pin table, in both callback shapes", async () => {
  const pins = new Map<string, PinnedTarget>([
    [
      "dual.example",
      {
        hostname: "dual.example",
        addresses: [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        ],
      },
    ],
  ]);
  const lookup = createPinnedLookup(pins);
  const call = (hostname: string, options: { all?: boolean; family?: number }) =>
    new Promise<unknown[]>((resolve) => lookup(hostname, options, (...args: unknown[]) => resolve(args)));

  // Node's autoSelectFamily path: `all: true`, expects [{ address, family }].
  assert.deepEqual(await call("dual.example", { all: true }), [
    null,
    [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ],
  ]);
  // Legacy path: (err, address, family).
  assert.deepEqual(await call("dual.example", {}), [null, "93.184.216.34", 4]);
  // A family constraint narrows, never widens.
  assert.deepEqual(await call("dual.example", { all: true, family: 6 }), [
    null,
    [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
  ]);
  // Unknown name → our error, no fallback.
  const [err] = await call("nobody.example", { all: true });
  assert.ok(err instanceof PinMissingError);
  assert.equal((err as PinMissingError).code, "ERR_OUTBOUND_PIN_MISSING");
  // A name that is itself an IP literal is passed through as-is.
  assert.deepEqual(await call("8.8.8.8", { all: true }), [null, [{ address: "8.8.8.8", family: 4 }]]);
});

// ---- safeFetch: the pin is the address the GATE saw ------------------------

test("safeFetch pins the address the gate verified, even when DNS flips afterwards", async () => {
  // First answer public, every later answer loopback — the classic rebinding
  // record. The transport must be told the first answer and the resolver
  // must not be asked again for this hop.
  let calls = 0;
  const flipping: AddressResolver = async () => {
    calls++;
    return calls === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  };
  const pins: Array<PinnedTarget | undefined> = [];
  const res = await safeFetch(
    "https://rebind.example/paid",
    {},
    {
      fetchImpl: async (_url, _init, pin) => {
        pins.push(pin);
        return response(402);
      },
      resolve: flipping,
    },
  );
  assert.equal(res.status, 402);
  assert.equal(calls, 1, "one resolution per hop: check and connect share it");
  assert.deepEqual(pins, [
    { hostname: "rebind.example", addresses: [{ address: "93.184.216.34", family: 4 }] },
  ]);
  // The record really does flip — the pin is what kept it out.
  assert.deepEqual(await flipping("rebind.example"), [{ address: "127.0.0.1", family: 4 }]);
});

test("safeFetch pins each redirect hop to that hop's own verified address", async () => {
  const table: Record<string, string> = {
    "api.example.com": "93.184.216.34",
    "cdn.example.net": "198.51.100.7",
  };
  const pins: Array<PinnedTarget | undefined> = [];
  const res = await safeFetch(
    "https://api.example.com/paid",
    {},
    {
      fetchImpl: async (url, _init, pin) => {
        pins.push(pin);
        return url.startsWith("https://api.example.com/")
          ? response(302, { location: "https://cdn.example.net/paid" })
          : response(402);
      },
      resolve: async (hostname) => [{ address: table[hostname], family: 4 }],
    },
  );
  assert.equal(res.status, 402);
  assert.deepEqual(pins, [
    { hostname: "api.example.com", addresses: [{ address: "93.184.216.34", family: 4 }] },
    { hostname: "cdn.example.net", addresses: [{ address: "198.51.100.7", family: 4 }] },
  ]);
});

test("safeFetch pins an IP literal as written without consulting the resolver", async () => {
  const pins: Array<PinnedTarget | undefined> = [];
  const neverResolve: AddressResolver = async (hostname) => {
    throw new Error(`resolver must not be asked about a literal: ${hostname}`);
  };
  for (const url of ["https://8.8.8.8/", "https://[2606:4700:4700::1111]/"]) {
    await safeFetch(
      url,
      {},
      {
        fetchImpl: async (_url, _init, pin) => {
          pins.push(pin);
          return response(402);
        },
        resolve: neverResolve,
      },
    );
  }
  assert.deepEqual(pins, [
    { hostname: "8.8.8.8", addresses: [{ address: "8.8.8.8", family: 4 }] },
    { hostname: "2606:4700:4700::1111", addresses: [{ address: "2606:4700:4700::1111", family: 6 }] },
  ]);
});

// ============================================================
// pinnedFetch — `fetch` whose socket goes ONLY where the SSRF gate said.
//
// WHY (2026-09-02 audit P2-1). safe-fetch.ts resolves a hostname and judges
// every address, then handed the request to the platform fetch — which ran
// its own, second resolution to open the socket. A DNS record that answers a
// public address to the first lookup and 127.0.0.1 to the second (TTL 0,
// "rebinding") passed the gate and connected inward. The key-less public
// POST /api/v1/demo/verify reaches this path. webhooks.ts already closed the
// same hole for customer URLs by connecting to the literal IP over
// node:https; this file gives the observatory's Response-based callers the
// same guarantee without giving up the fetch API.
//
// HOW. undici lets a dispatcher's connector take a custom `lookup`, the
// function net/tls.connect consults instead of dns.lookup. Ours answers from
// a pin table that safeFetch fills with the addresses it just verified for
// the hop, and answers with an error for any hostname not in the table
// (fail-closed: the transport never resolves on its own). Host header, SNI,
// and certificate validation are untouched — the pin changes where the
// bytes go, not what the server is told or checked against.
//
// Node's bundled fetch and the npm `undici` package are different copies of
// the same library and do not share dispatchers reliably, so BOTH the fetch
// and the Agent come from the npm package here (pinned as a direct dependency
// in package.json). The Response is the WHATWG shape callers already use
// (status / headers / body.getReader / text), cast to the global type at the
// boundary.
// ============================================================
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type PinnedAddress = { address: string; family: number };

/** The addresses the gate verified for one hostname — the ONLY connect targets. */
export type PinnedTarget = { hostname: string; addresses: PinnedAddress[] };

/**
 * The fetchImpl shape safeFetch drives. `pin` is what the gate verified for
 * this hop; a transport that receives no pin must refuse (see PinMissingError).
 */
export type PinnedFetchImpl = (
  url: string,
  init?: RequestInit,
  pin?: PinnedTarget,
) => Promise<Response>;

/** Raised (as the undici TypeError's `cause`) when connect asks for a hostname nobody pinned. */
export class PinMissingError extends Error {
  readonly code = "ERR_OUTBOUND_PIN_MISSING";
  readonly hostname: string;
  constructor(hostname: string) {
    super(`outbound connect refused: no verified address pinned for ${hostname}`);
    this.name = "PinMissingError";
    this.hostname = hostname;
  }
}

/** Exactly node:net's `LookupFunction`, so the Agent's connector accepts it unchanged. */
export type PinnedLookup = net.LookupFunction;

/**
 * The `lookup` handed to undici's connector. It is the only resolver the
 * transport has, and it only knows what `pins` knows.
 *
 * Node calls it in two shapes: `{ all: true }` (autoSelectFamily, the default
 * since Node 20) expects an array of `{ address, family }`; the legacy shape
 * expects `(err, address, family)`. A `family` of 4/6 narrows the answer and
 * an empty narrowing is an error, never a fallback.
 */
export function createPinnedLookup(pins: ReadonlyMap<string, PinnedTarget>): PinnedLookup {
  return (hostname, options, cb) => {
    const wanted = Number(options?.family ?? 0) || 0;
    let addresses: PinnedAddress[];
    const literal = net.isIP(hostname);
    if (literal !== 0) {
      // net.connect skips lookup for literals; if a caller still asks, the
      // literal is its own answer (safe-fetch already judged it as public).
      addresses = [{ address: hostname, family: literal }];
    } else {
      const pin = pins.get(hostname.toLowerCase());
      if (!pin) {
        queueMicrotask(() => cb(new PinMissingError(hostname), ""));
        return;
      }
      addresses = pin.addresses;
    }
    if (wanted === 4 || wanted === 6) addresses = addresses.filter((a) => a.family === wanted);
    if (addresses.length === 0) {
      queueMicrotask(() => cb(new PinMissingError(hostname), ""));
      return;
    }
    const answer = addresses.map((a) => ({ address: a.address, family: a.family }));
    if (options?.all) queueMicrotask(() => cb(null, answer));
    else queueMicrotask(() => cb(null, answer[0].address, answer[0].family));
  };
}

/**
 * Build a transport. One Agent, one pin table: the table holds a hostname
 * only while a request that verified it is in flight (reference counted, so
 * two concurrent hops to the same host cannot pull each other's pin out from
 * under a pending connect). Every entry ever placed in the table came from
 * the gate, so the last writer winning is harmless; an absent entry is an
 * error, which is the whole point.
 *
 * The pin is released when the fetch promise settles (headers received). By
 * then the socket is connected; streaming the body never reconnects, and a
 * later request to the same origin either reuses that verified socket or
 * connects fresh under its own pin.
 */
export function createPinnedFetch(): PinnedFetchImpl {
  const pins = new Map<string, PinnedTarget & { refs: number }>();
  const agent = new Agent({ connect: { lookup: createPinnedLookup(pins) } });

  const acquire = (pin: PinnedTarget) => {
    const key = pin.hostname.toLowerCase();
    const current = pins.get(key);
    pins.set(key, { hostname: key, addresses: pin.addresses, refs: (current?.refs ?? 0) + 1 });
  };
  const release = (pin: PinnedTarget) => {
    const key = pin.hostname.toLowerCase();
    const current = pins.get(key);
    if (!current) return;
    if (current.refs <= 1) pins.delete(key);
    else current.refs -= 1;
  };

  return async (url, init, pin) => {
    if (!pin) {
      // Same shape as an undici connect failure (TypeError with a `cause`),
      // so callers' error classification sees one kind of refusal.
      let hostname = url;
      try {
        hostname = new URL(url).hostname;
      } catch {
        /* keep the raw string for the message */
      }
      throw new TypeError("fetch failed", { cause: new PinMissingError(hostname) });
    }
    acquire(pin);
    try {
      // The two RequestInit/Response types (lib.dom vs undici-types) describe
      // the same runtime objects; the casts are at this one boundary only.
      const res = await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher: agent,
      });
      return res as unknown as Response;
    } finally {
      release(pin);
    }
  };
}

/** The production transport safe-fetch.ts installs as its default fetchImpl. */
export const pinnedFetch: PinnedFetchImpl = createPinnedFetch();

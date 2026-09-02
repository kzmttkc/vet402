// ============================================================
// Outbound-address classification — the shared half of the SSRF defense.
//
// Extracted verbatim (2026-08-15 security audit) from src/lib/webhooks.ts,
// which had the only correct copy in the codebase. It now has two callers:
//
//   - webhook delivery (customer-registered URL, HTTPS, socket pinned to the
//     verified IP — see webhooks.ts),
//   - the observatory's L0 prober / L1 purchaser, whose target URLs come from
//     the public Bazaar catalog and are therefore third-party input we never
//     chose (see src/lib/net/safe-fetch.ts).
//
// One copy, one set of tests: a predicate this load-bearing must not be
// re-derived per caller.
// ============================================================
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * True only for addresses that are safe to egress to: globally-routable
 * unicast IPv4/IPv6. Everything private, reserved, loopback, link-local,
 * CGNAT, ULA, multicast, or unspecified is rejected. IPv4-mapped/embedded
 * IPv6 forms are unwrapped and judged as the IPv4 they target.
 */
export function isPublicUnicastIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPublicIPv4(ip);
  if (!net.isIPv6(ip)) return false;

  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone); // strip scope id (fe80::1%eth0)

  const groups = expandIPv6(s);
  if (!groups) return false;

  // Any form that embeds an IPv4 is judged as the IPv4 it targets. This is
  // done on the expanded groups, never on the text: WHATWG URL rewrites
  // `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]` (2026-09-02 audit S1), so a
  // dotted-tail regex saw a loopback only when the caller happened to spell
  // it that way.
  const embedded = embeddedIPv4(groups);
  if (embedded) return isPublicIPv4(embedded);

  const [g0] = groups;
  if (groups.every((g) => g === 0)) return false; // :: unspecified
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  return true;
}

/**
 * Expand an IPv6 string (already validated by net.isIPv6, scope id removed)
 * into its 8 16-bit groups. Handles `::` zero compression and a dotted-quad
 * tail (`::ffff:1.2.3.4`). Returns null on anything malformed.
 */
export function expandIPv6(s: string): number[] | null {
  let text = s;
  const tail: number[] = [];
  // Dotted-quad tail → two trailing groups.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(dotted[2]);
    if (!m) return null;
    const o = m.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    tail.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
    text = dotted[1];
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }
  const parseSide = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = parseSide(halves[0]);
  if (!head) return null;
  let groups: number[];
  if (halves.length === 2) {
    const rest = parseSide(halves[1]);
    if (!rest) return null;
    const fill = 8 - head.length - rest.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
  }
  return groups.length === 8 ? groups : null;
}

/**
 * The IPv4 an IPv6 address carries, as dotted text, or null if it is a
 * native IPv6 address. Prefixes (all judged on expanded groups):
 *   ::ffff:0:0/96   IPv4-mapped        → last 32 bits
 *   ::/96           IPv4-compatible    → last 32 bits (covers :: and ::1 too)
 *   64:ff9b::/96    NAT64 well-known   → last 32 bits
 *   64:ff9b:1::/48  NAT64 local-use    → last 32 bits
 *   2002::/16       6to4               → bits 16..47
 */
export function embeddedIPv4(g: readonly number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const leading5Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (leading5Zero && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]); // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4(g[6], g[7]); // 64:ff9b::/96
    if (g[2] === 1) return v4(g[6], g[7]); // 64:ff9b:1::/48
  }
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
  return null;
}

export function isPublicIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return false; // this-net / private / loopback
  if (a === 169 && b === 254) return false; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // private /12
  if (a === 192 && b === 168) return false; // private /16
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a >= 224) return false; // multicast + reserved + 255.255.255.255 broadcast
  return true;
}

/** Injectable resolver — real DNS in prod, a mock in tests. `all:true` so a
 *  hostname that resolves to a mix of public and private is rejected on the
 *  private one, not silently accepted on whichever came first. */
export type AddressResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export const defaultResolver: AddressResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolve `hostname` and return a single verified public IP, or null if it
 * does not resolve or ANY resolved address is non-public. Returning a concrete
 * IP (not just a boolean) is what lets a caller connect by literal address and
 * close the DNS-rebinding window (webhooks.ts does exactly that).
 */
export async function resolvePublicTarget(
  hostname: string,
  resolve: AddressResolver = defaultResolver,
): Promise<{ ip: string; family: 4 | 6 } | null> {
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await resolve(hostname);
  } catch {
    return null; // NXDOMAIN / SERVFAIL → do not egress
  }
  if (!addrs || addrs.length === 0) return null;
  for (const a of addrs) {
    if (!isPublicUnicastIp(a.address)) return null; // any private address → abort
  }
  const first = addrs[0];
  return { ip: first.address, family: first.family === 6 ? 6 : 4 };
}

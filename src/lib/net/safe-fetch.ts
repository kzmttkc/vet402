// ============================================================
// safeFetch — an SSRF-guarded `fetch` for URLs we did not choose.
//
// WHY (2026-08-15 security audit). The observatory's target list is the public
// CDP Bazaar catalog: `resource` is a string a third party self-declared, and
// vet402 copies it into x402_endpoints.resource_url and then requests it from
// inside its own serverless function — twice, in fact (L0 probe, L1 paid
// purchase), both with `redirect: "follow"`. Nothing checked where that URL
// pointed. A listed resource of `http://169.254.169.254/latest/meta-data/…`,
// `http://127.0.0.1:3000/api/admin/gate2`, or a bare internal name would have
// been fetched on schedule by our cron, with the first 500 bytes of the reply
// written to x402_l0_probes.raw_response_meta. Measured the same day: 1,400
// sampled catalog rows were all https with public hostnames — so this is a
// gate on an unlocked door, not a fire being put out.
//
// WHAT IT GUARANTEES: no request is issued to a URL whose scheme is not
// http(s), or whose host is (or resolves to) a non-public-unicast address —
// on the first hop OR on any redirect hop, because a first-hop-only check that
// then follows redirects is theater.
//
// WHAT IT ALSO GUARANTEES (2026-09-02 audit P2-1): the socket is PINNED to the
// addresses the gate verified. Until this date the check resolved the name
// once and the platform fetch resolved it again to connect, so a record that
// flips between the two lookups ("rebinding": public to the check, 127.0.0.1
// to the connect) walked through — reachable from the key-less public
// POST /api/v1/demo/verify. Now every hop resolves exactly once; the verified
// addresses travel with the request as a `pin`, and the default transport
// (src/lib/net/pinned-fetch.ts) is an undici Agent whose connector `lookup`
// answers only from that pin and errors for anything else. IP literals are
// pinned as written. Host header, SNI and certificate validation keep the
// hostname. This is the same guarantee webhooks.ts gives customer URLs, kept
// behind the Response API these callers are built on. Tests:
// tests/safe-fetch-pinning.test.ts.
//
// WHAT IT ALSO GUARANTEES (2026-08-22 audit). Credentials do not cross an
// origin boundary on a redirect. The L1 paid retry puts a signed EIP-3009
// authorization in `X-PAYMENT` (x402 v1) / `PAYMENT-SIGNATURE` (v2) — the
// header names encodePaymentHeader actually emits, read from
// observatory/x402-payer.ts, not guessed. Before this, a seller answering
// 302 to a host it does not control handed that authorization to a third
// party: the SSRF gate re-ran on every hop (correct, unchanged) but the
// headers rode along. The blast radius was already bounded — the
// authorization names `to = accept.payTo` and expires at `now + 600s`, so a
// stranger can only push the money to the payee it was always going to — yet
// it still allows a double settle and makes the on-chain payer disagree with
// who we think paid.
//
// WHAT IT ALSO GUARANTEES (2026-09-19 audit). The same removal for credential
// headers whose NAME the seller chose. MPP (Tempo) challenges carry a `header`
// parameter and the credential must ride in that field or the seller cannot
// read it, so the fixed table below could never cover this lane: the caller
// declares the names for that one request (SafeFetchOptions.sensitiveHeaders)
// and they are dropped on the same boundary.
//
// WHAT IT STILL DOES NOT: a SAME-origin redirect keeps every header, which is
// intended (that is one server talking to itself, and the paid retry has to
// survive a trailing-slash 301). Nor does it re-sign anything: a stripped
// payment header means the next hop sees an unpaid request and answers 402,
// which the caller records as a measurement — degraded, never forged.
// ============================================================
import {
  defaultResolver,
  isPublicUnicastIp,
  type AddressResolver,
} from "./public-address";
import { pinnedFetch, type PinnedFetchImpl, type PinnedTarget } from "./pinned-fetch";

export type UnsafeTargetReason =
  | "unsafe_scheme"
  | "unsafe_host"
  | "unresolvable"
  | "too_many_redirects";

export class UnsafeTargetError extends Error {
  readonly reason: UnsafeTargetReason;
  readonly target: string;

  constructor(reason: UnsafeTargetReason, target: string) {
    super(`unsafe outbound target (${reason}): ${target}`);
    this.name = "UnsafeTargetError";
    this.reason = reason;
    this.target = target;
  }
}

/** Hostnames that are internal by name rather than by address. */
function isInternalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  );
}

/**
 * String-level gate: everything decidable without touching DNS. Public API so
 * callers can reject a stored URL cheaply (and so the rules are testable
 * without a resolver).
 */
export function isPublicHostUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (isInternalName(host)) return false;

  // IPv6 literal — URL.hostname keeps the brackets.
  if (host.startsWith("[")) {
    return isPublicUnicastIp(host.slice(1, -1));
  }
  // IPv4 literal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return isPublicUnicastIp(host);
  }
  // A single-label name (no dot) is an intranet name by construction.
  if (!host.includes(".")) return false;
  return true;
}

function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Throws UnsafeTargetError unless `url` is safe to open a socket to, and
 * returns the addresses that passed — the ONLY addresses the transport may
 * connect to for this hop. Resolution happens here exactly once; the
 * transport never resolves again (pinned-fetch.ts).
 */
async function assertPublicTarget(url: URL, resolve: AddressResolver): Promise<PinnedTarget> {
  const href = url.toString();
  if (!isPublicHostUrl(href)) {
    throw new UnsafeTargetError(
      url.protocol !== "https:" && url.protocol !== "http:" ? "unsafe_scheme" : "unsafe_host",
      href,
    );
  }
  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host)) {
    // Already judged as a literal, nothing to resolve: pin it as written
    // (brackets dropped — net.connect wants the bare address).
    const literal = host.startsWith("[") ? host.slice(1, -1) : host;
    return { hostname: literal, addresses: [{ address: literal, family: literal.includes(":") ? 6 : 4 }] };
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new UnsafeTargetError("unresolvable", href);
  }
  if (!addrs || addrs.length === 0) throw new UnsafeTargetError("unresolvable", href);
  for (const a of addrs) {
    // ANY non-public answer rejects the name: a split record where one A is
    // public and the next is 127.0.0.1 must not be decided by ordering.
    if (!isPublicUnicastIp(a.address)) throw new UnsafeTargetError("unsafe_host", href);
  }
  return {
    hostname: host,
    addresses: addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })),
  };
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Headers dropped when a redirect crosses an origin.
 *
 * The first four are what the fetch spec itself removes on a cross-origin
 * redirect (`Authorization`, `Cookie`, `Cookie2`, `Proxy-Authorization`);
 * undici does this for us only when IT follows the redirect, and we follow
 * manually so the SSRF gate can re-run — so we owe the same removal.
 *
 * The last two are the x402 payment headers, which no spec knows about and
 * which are the reason this list exists at all. Names taken verbatim from
 * encodePaymentHeader() in src/lib/observatory/x402-payer.ts:
 * `X-PAYMENT` for x402 v1, `PAYMENT-SIGNATURE` for v2. Lowercase because
 * Headers normalizes on both set and delete.
 *
 * A name added to the payer must be added here too — there is a test that
 * asserts both of the current ones are stripped, so a rename breaks loudly.
 *
 * A FIXED table can only cover header names WE choose. The MPP lane (Tempo)
 * does not choose: the seller's challenge carries a `header` parameter naming
 * the field the credential must ride in, and the reference server reads the
 * credential from that field only (mppx server/Transport.js getCredential), so
 * answering in `Authorization` would simply look unpaid. Those names are
 * therefore passed per call in SafeFetchOptions.sensitiveHeaders and dropped
 * on the same boundary — see the L1 paid leg in observatory/l1-runner.ts.
 */
const CROSS_ORIGIN_SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
  "x-payment",
  "payment-signature",
] as const;

/**
 * Same origin = same scheme, host AND port. `URL.origin` gives exactly that
 * for http(s) (the only schemes assertPublicTarget lets through), so an
 * https→http downgrade to the same hostname counts as a crossing — which it
 * is, since the credential would then travel in clear text.
 */
function crossesOrigin(from: URL, to: URL): boolean {
  return from.origin !== to.origin;
}

export type SafeFetchOptions = {
  /**
   * Transport. Receives the hop's verified addresses as a third argument
   * and must connect to those only; the default is the pinned undici
   * transport. Tests that inject a mock are exercising the gate, not the
   * socket — the socket has its own tests.
   */
  fetchImpl?: PinnedFetchImpl;
  resolve?: AddressResolver;
  /** Hops followed after the initial request. */
  maxRedirects?: number;
  /**
   * What to do when a redirect would carry the request BODY to another origin
   * (a 307/308, or a 301/302 that does not demote the method). `"follow"` (the
   * default) keeps the fetch-spec behaviour. `"refuse"` hands the 3xx back
   * without sending anything to the other origin.
   *
   * 2026-09-17 (Issue #29): the L1 paid POST now carries the input body the
   * seller's own 402 declares. The payment headers already stop at the origin
   * boundary, but a 307/308 would still deliver that body to whatever host the
   * seller's Location names. The runner passes "refuse" for a declared body.
   * Refusing rather than stripping the body: the cross-origin hop carries no
   * payment header either way, so it cannot be the purchase; following it
   * with a bodiless POST would only record a third party's answer as the
   * seller's paid response. A `{}` body is not affected, so every request
   * this runner sent before the declared body existed behaves as it did.
   */
  crossOriginBody?: "follow" | "refuse";
  /**
   * Extra header names this request carries a credential in, dropped on a
   * cross-origin redirect exactly like the fixed table above (case-insensitive).
   *
   * 2026-09-19（横断監査 W1）: MPP（Tempo）の credential のヘッダ名は売り手の
   * challenge が決める（`header` パラメータ・既定 Authorization）。固定名の表は
   * 我々が選んだ名前しか知らないので、売り手が `header="x-pay"` を返して有料
   * リトライを別オリジンへ 302 すると、署名済みの credential が第三者に渡った。
   * 呼び手が「この要求で機微なヘッダ」を宣言し、gate はここで必ず落とす。
   */
  sensitiveHeaders?: readonly string[];
  /**
   * Called once per hop where a credential header was actually removed because
   * the redirect crossed an origin. Not called when the request carried none.
   *
   * 2026-09-19（独立レビュー W-4）: 落とすと次のホップは当然 401/402 を返す。呼び手が
   * それを「売り手が決済に失敗した」として公開台帳に書いてしまわないよう、**落とした側が
   * 事実を伝える**。最終 URL から推測させない——`Response.url` は手で作った Response では
   * 空で、転送を手で追うこの実装では当てにできない。
   */
  onCredentialsStripped?: (hop: { from: string; to: string }) => void;
};

/** Per-call options a drop-in fetchImpl accepts as a third argument. */
export type SafeFetchCallOptions = Pick<
  SafeFetchOptions,
  "crossOriginBody" | "sensitiveHeaders" | "onCredentialsStripped"
>;

/**
 * `fetch`, except every hop's target must be a public address. Redirects are
 * followed manually (`redirect: "manual"`) so each `Location` passes the same
 * gate as the URL the caller handed us — with the platform's own follow logic
 * we would only ever see the first hop.
 *
 * Method/body handling mirrors the fetch spec (and undici): 303 always demotes
 * to GET; 301/302 demote a POST to GET; 307/308 preserve both. The body is
 * dropped along with the method, and with it Content-Type.
 */
export async function safeFetch(
  input: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const { fetchImpl = pinnedFetch, resolve = defaultResolver, maxRedirects = 5, crossOriginBody = "follow", sensitiveHeaders = [], onCredentialsStripped } = options;
  // 固定名の表＋この要求ぶんの宣言。Headers は set/delete で正規化するので小文字で持つ。
  const dropOnCrossOrigin = [
    ...CROSS_ORIGIN_SENSITIVE_HEADERS,
    ...sensitiveHeaders.map((name) => name.toLowerCase()),
  ];

  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new UnsafeTargetError("unsafe_scheme", input);
  }

  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);

  for (let hop = 0; ; hop++) {
    const pin = await assertPublicTarget(current, resolve);

    const response = await fetchImpl(
      current.toString(),
      {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
      },
      pin,
    );

    const location = REDIRECT_STATUS.has(response.status)
      ? response.headers.get("location")
      : null;
    if (!location) return response;

    if (hop >= maxRedirects) {
      throw new UnsafeTargetError("too_many_redirects", current.toString());
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return response; // unparseable Location: hand the 3xx back, don't guess
    }

    const demote =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method !== "GET" &&
        method !== "HEAD");
    if (demote) {
      method = "GET";
      body = undefined;
      headers = new Headers(headers);
      headers.delete("content-type");
      headers.delete("content-length");
    }
    // A body that would reach another origin: refuse when the caller asked
    // (see SafeFetchOptions.crossOriginBody). Checked after demotion, because
    // a 303 or a demoted 301/302 no longer carries the body.
    if (crossOriginBody === "refuse" && body !== undefined && body !== null && crossesOrigin(current, next)) {
      return response;
    }
    // Credentials stop at the origin boundary (see the header block above).
    // Cloned rather than mutated in place so the caller's own `init.headers`
    // is never edited underneath it.
    if (crossesOrigin(current, next)) {
      // 実際に何か載っていたときだけ呼び手へ伝える（下の onCredentialsStripped）。
      const carried = dropOnCrossOrigin.some((name) => headers.has(name));
      headers = new Headers(headers);
      for (const name of dropOnCrossOrigin) headers.delete(name);
      if (carried) onCredentialsStripped?.({ from: current.origin, to: next.origin });
    }
    current = next;
  }
}

/**
 * The drop-in `fetchImpl` shape the observatory modules take. Their injection
 * point already has the (url, init) signature, so the guard installs as the
 * production default without touching a call site.
 */
export function createSafeFetchImpl(
  options: SafeFetchOptions = {},
): (url: string, init?: RequestInit, call?: SafeFetchCallOptions) => Promise<Response> {
  return (url, init, call) => safeFetch(url, init ?? {}, { ...options, ...(call ?? {}) });
}

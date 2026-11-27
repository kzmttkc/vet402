// ============================================================
// POST /api/v1/check/presign — 署名前スキャン（2026-11-27 F7）。
//
// エージェントが売り手から受け取った 402（PAYMENT-REQUIRED の challenge）を、署名する前にそのまま渡す口。
// 判定は GET /api/v1/check と同じ読み手（getCheckSellerCached・60 秒）から取る。新しい判定の規則は無い:
//   - recommendation / reason_codes / rules_version は check の値をそのまま返す（書き換えない）
//   - accept ごとの照合は SDK の payOrRefuse が署名の前に使う matchDeclaredPayTerms（packages/sdk/src/terms-match.ts）
//     をそのまま import して当てる。語も SDK の語（payee_mismatch・price_above_declared など）
// verified_terms が無い掲載だけ、SDK と同じく facts.payees で照合するため、resolve と decide（5 分の LRU）を 1 回読む。
// 鍵なし。回数制限は GET /api/v1/check と同じ IP の枠（"resolve" の桶）を分け合う。応答は signedJson で署名する。
// 保存するのは client_usage_daily の件数だけ（route = rest:presign）。402 の本文・URL は保存しない（IP は GET /api/v1/check と同じく回数制限の桶のキーにだけ使う）。
// ============================================================
import { matchDeclaredPayTerms, normalizeAccept, type TermsAccept, type TermsDecision, type TermsMismatchReason } from "../../../packages/sdk/src/terms-match";
import { getCheckSellerCached, type CheckSellerCacheTiming } from "@/lib/api/check-seller-cache";
import { rejectUnknownQuery } from "@/lib/api/export-guard";
import { withNoindex } from "@/lib/api/public-read-robots";
import { isHttpsAbsoluteUrl } from "@/lib/mcp/schemas";
import { ERROR_TEXT } from "@/lib/mcp/text";
import type { CheckSellerDeps } from "@/lib/mcp/tools";
import type { CheckSellerOutput } from "@/lib/mcp/schemas";
import { signedJson } from "@/lib/signing/response-signature";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const PRESIGN_DOCS = "https://vet402.com/docs/api#endpoints";
/** 受け取る本文の上限（バイト）。GET /api/v1/diagnose が読む 402 の上限と同じ 64 KB。 */
export const PRESIGN_MAX_BODY_BYTES = 64 * 1024;
/** 1 つの 402 で照合する accept の上限。 */
export const PRESIGN_MAX_ACCEPTS = 32;
const WRAPPER_KEYS = ["challenge", "url", "method"] as const;

export const PRESIGN_TERMS_NOTE =
  "terms_match compares each accept in the 402 with the terms vet402 paid and saw delivered (verified_terms, verified_pay_to_by_network, facts.payees). " +
  "It uses the same function the vet402 SDK payOrRefuse runs before it signs. It does not change recommendation. " +
  "It does not apply your own limits such as a per-transaction ceiling. terms_match true on a network does not mean the SDK pays on that network. " +
  "An accept with no readable amount, payTo, scheme or asset is evidence_unavailable.";

export type PresignAcceptResult = {
  index: number;
  readable: boolean;
  scheme: string | null;
  network: string | null;
  asset: string | null;
  amount: string | null;
  pay_to: string | null;
  /** true: SDK の照合を通る。false: 通らない（reason_codes に理由）。null: 照合する判定が無い（カタログに無い）。 */
  terms_match: boolean | null;
  reason_codes: string[];
};

type Parsed =
  | { ok: true; challenge: Record<string, unknown>; url: string | null; method: string | null }
  | { ok: false; status: number; body: Record<string, unknown> };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(error: string, message: string, extra: Record<string, unknown> = {}): Parsed {
  return { ok: false, status: 400, body: { error, message, ...extra, documentation: PRESIGN_DOCS } };
}

/** PAYMENT-REQUIRED ヘッダの値（base64 の JSON）を読む。読めなければ null。 */
function decodeHeaderChallenge(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (s.length === 0 || s.length > PRESIGN_MAX_BODY_BYTES * 2 || !/^[A-Za-z0-9+/_=-]+$/.test(s)) return null;
  try {
    const v = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** 本文を読む。形は 2 つ: 402 の本文そのもの（accepts を持つ）か、{ challenge, url?, method? }。 */
export function parsePresignBody(text: string): Parsed {
  if (Buffer.byteLength(text, "utf8") > PRESIGN_MAX_BODY_BYTES) {
    return { ok: false, status: 413, body: { error: "body_too_large", message: "The body is larger than 64 KB.", documentation: PRESIGN_DOCS } };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return bad("invalid_body", "The body must be JSON: the 402 body itself, or { \"challenge\": <402 body or PAYMENT-REQUIRED header value>, \"url\"?: string, \"method\"?: string }.");
  }
  if (!isObj(json)) return bad("invalid_body", "The body must be a JSON object.");

  let challenge: Record<string, unknown> | null;
  let url: unknown = null;
  let method: unknown = null;
  if (Array.isArray(json.accepts)) {
    challenge = json;
  } else if ("challenge" in json) {
    const unknownKeys = Object.keys(json).filter((k) => !(WRAPPER_KEYS as readonly string[]).includes(k));
    if (unknownKeys.length > 0) return bad("invalid_body", "Unknown keys in the body.", { allowed: [...WRAPPER_KEYS] });
    challenge = typeof json.challenge === "string" ? decodeHeaderChallenge(json.challenge) : isObj(json.challenge) ? json.challenge : null;
    url = json.url ?? null;
    method = json.method ?? null;
  } else {
    return bad("invalid_body", "Send the 402 body (with accepts) or { \"challenge\": ... }.", { allowed: [...WRAPPER_KEYS] });
  }
  if (!challenge || !Array.isArray(challenge.accepts)) {
    return bad("invalid_challenge", "challenge must be the 402 JSON body or the base64 PAYMENT-REQUIRED header value, with an accepts array.");
  }
  if (challenge.accepts.length === 0 || challenge.accepts.length > PRESIGN_MAX_ACCEPTS) {
    return bad("invalid_challenge", `accepts must have 1 to ${PRESIGN_MAX_ACCEPTS} entries.`);
  }
  if (url !== null && (typeof url !== "string" || !isHttpsAbsoluteUrl(url))) {
    return bad("invalid_url", ERROR_TEXT.invalid_url);
  }
  if (method !== null && (typeof method !== "string" || !/^[A-Za-z]{1,10}$/.test(method))) {
    return bad("invalid_method", "method must be an HTTP method name such as GET or POST.", { expected: "method" });
  }
  return { ok: true, challenge, url: url as string | null, method: method === null ? null : (method as string).toUpperCase() };
}

/** 照合する URL。呼び手の url → v2 の resource.url → v1 の accepts[].resource の順。 */
export function resourceUrlOf(challenge: Record<string, unknown>, callerUrl: string | null): { url: string | null; source: "body" | "challenge" | null } {
  if (callerUrl) return { url: callerUrl, source: "body" };
  const r = challenge.resource;
  if (isObj(r) && typeof r.url === "string" && isHttpsAbsoluteUrl(r.url)) return { url: r.url, source: "challenge" };
  if (typeof r === "string" && isHttpsAbsoluteUrl(r)) return { url: r, source: "challenge" };
  for (const a of challenge.accepts as unknown[]) {
    if (isObj(a) && typeof a.resource === "string" && isHttpsAbsoluteUrl(a.resource)) return { url: a.resource, source: "challenge" };
  }
  return { url: null, source: null };
}

function acceptRow(index: number, accept: TermsAccept | null): Omit<PresignAcceptResult, "terms_match" | "reason_codes"> {
  return {
    index,
    readable: accept !== null,
    scheme: accept?.scheme ?? null,
    network: accept?.network ? accept.network : null,
    asset: accept?.asset ?? null,
    amount: accept?.amount ?? null,
    pay_to: accept?.payTo ?? null,
  };
}

/** accept ごとに SDK と同じ照合をかける。decision が null（カタログに無い）なら照合しない。 */
export function compareAccepts(rawAccepts: readonly unknown[], decision: TermsDecision | null): PresignAcceptResult[] {
  return rawAccepts.map((raw, index) => {
    const accept = normalizeAccept(raw);
    const row = acceptRow(index, accept);
    // 額が 10 進の整数でない accept は読めない扱い（SDK は照合の前に evaluateMoneyGate で同じ確かめをする。BigInt を投げさせない）。
    if (accept === null || !/^[0-9]+$/.test(accept.amount)) {
      return { ...row, readable: false, terms_match: false, reason_codes: ["evidence_unavailable"] };
    }
    if (decision === null) return { ...row, terms_match: null, reason_codes: ["resource_uncatalogued"] };
    const mismatch: TermsMismatchReason[] | null = matchDeclaredPayTerms(decision, accept, { network: accept.network }, true);
    return { ...row, terms_match: mismatch === null, reason_codes: mismatch ?? [] };
  });
}

/** verified_terms が無いときだけ facts.payees を読む（SDK はそのとき facts.payees で照合する）。 */
async function payeesFor(deps: CheckSellerDeps, url: string, method: string | null): Promise<string[]> {
  const resolved = deps.resolveForRoute
    ? (await deps.resolveForRoute(url, method ? { method } : {})).result
    : await deps.resolve(url, method ? { method } : {});
  if (!resolved.resource) return [];
  const decision = await deps.decide({
    role: "payer",
    observatoryId: resolved.resource.observatory_id,
    operatorBlacklist: false,
    callerMaterial: null,
    skipScore: true,
  });
  const facts = decision?.facts as { payees?: unknown } | undefined;
  return Array.isArray(facts?.payees) ? facts.payees.filter((p): p is string => typeof p === "string") : [];
}

function serverTimingInner(cacheMs: number, cachePath: string, termsMs: number): string {
  const desc = cachePath ? `;desc="${cachePath}"` : "";
  return `cache;dur=${cacheMs.toFixed(1)}${desc}, terms;dur=${termsMs.toFixed(1)}`;
}

function respond(
  request: Request,
  status: number,
  body: Record<string, unknown>,
  signStart: number,
  innerTiming: string,
): Response {
  const signMs = performance.now() - signStart;
  const res = signedJson(request, body, { status, headers: withNoindex({ "Cache-Control": "private, no-store" }) });
  res.headers.set("Server-Timing", `${innerTiming}, sign;dur=${signMs.toFixed(1)}`);
  return res;
}

export async function handlePresign(request: Request, deps: CheckSellerDeps): Promise<Response> {
  const badQuery = rejectUnknownQuery(new URL(request.url).searchParams, [], {});
  if (badQuery) {
    const signStart = performance.now();
    return respond(request, 400, { ...(await badQuery.json()), documentation: PRESIGN_DOCS }, signStart, "cache;dur=0;desc=\"fresh\", terms;dur=0");
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PRESIGN_MAX_BODY_BYTES) {
    const signStart = performance.now();
    return respond(request, 413, { error: "body_too_large", message: "The body is larger than 64 KB.", documentation: PRESIGN_DOCS }, signStart, "cache;dur=0;desc=\"fresh\", terms;dur=0");
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    const signStart = performance.now();
    return respond(request, 400, { error: "invalid_body", message: "The body could not be read.", documentation: PRESIGN_DOCS }, signStart, "cache;dur=0;desc=\"fresh\", terms;dur=0");
  }
  const parsed = parsePresignBody(text);
  if (!parsed.ok) {
    const signStart = performance.now();
    return respond(request, parsed.status, parsed.body, signStart, "cache;dur=0;desc=\"fresh\", terms;dur=0");
  }

  const { url, source } = resourceUrlOf(parsed.challenge, parsed.url);
  if (!url) {
    const signStart = performance.now();
    return respond(request, 400, {
      error: "invalid_url",
      message: "The 402 has no https resource URL. Pass the URL you called as url.",
      documentation: PRESIGN_DOCS,
    }, signStart, "cache;dur=0;desc=\"fresh\", terms;dur=0");
  }

  try {
    const cacheTiming: CheckSellerCacheTiming = {};
    const tCache = performance.now();
    const out: CheckSellerOutput = await getCheckSellerCached(deps, { url, method: parsed.method ?? undefined }, cacheTiming);
    const cacheMs = performance.now() - tCache;
    const cachePath = cacheTiming.path ?? "unknown";
  const tTerms = performance.now();
    let decision: TermsDecision | null = null;
    if (!out.not_in_catalog) {
      decision = {
        verified_terms: out.verified_terms,
        verified_pay_to_by_network: out.verified_pay_to_by_network,
        facts: { payees: out.verified_terms ? [] : await payeesFor(deps, url, parsed.method) },
      };
    }
    const accepts = compareAccepts(parsed.challenge.accepts as unknown[], decision);
    const termsMs = performance.now() - tTerms;
    const innerTiming = serverTimingInner(cacheMs, cachePath, termsMs);
    const version = parsed.challenge.x402Version;
    const body: Record<string, unknown> = {
      resource_url: url,
      resource_url_source: source,
      canonical_url: out.canonical_url,
      method: out.method,
      not_in_catalog: out.not_in_catalog,
      recommendation: out.recommendation,
      reason_codes: [...out.reason_codes],
      truncated: out.truncated,
      next_action: out.next_action,
      spending_halted: out.spending_halted,
      verified_terms: out.verified_terms,
      verified_pay_to_by_network: out.verified_pay_to_by_network,
      x402_version: version === 1 || version === 2 ? version : null,
      accepts,
      matching_accepts: accepts.filter((a) => a.terms_match === true).map((a) => a.index),
      terms_note: PRESIGN_TERMS_NOTE,
      record_url: out.record_url,
      diagnose_url: out.diagnose_url,
      check_url: `https://vet402.com/api/v1/check?url=${encodeURIComponent(url)}${parsed.method ? `&method=${parsed.method}` : ""}`,
      rules_version: out.rules_version,
      as_of: out.as_of,
    };
    const signStart = performance.now();
    return respond(request, 200, body, signStart, innerTiming);
  } catch (error) {
    logServerErrorSafe("presign", error);
    const signStart = performance.now();
    return respond(request, 503, { error: "temporarily_unavailable" }, signStart, "cache;dur=0;desc=\"coalesced\", terms;dur=0");
  }
}

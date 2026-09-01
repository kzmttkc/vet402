// ============================================================
// vet402 Observatory L0 — no-purchase probe (design §4).
//
// What a probe is: one request sent with the CATALOG-DECLARED method,
// expecting the x402 payment wall (HTTP 402 + parseable accepts[]) to stop
// it before anything executes. The 402 itself is the observable — no
// payment is ever attached, so a healthy endpoint bills nothing and runs
// nothing.
//
// #3113 guard (the module's founding constraint):
//   - method comes from the catalog declaration when declared;
//   - undeclared method → GET (製品定義書 §6.1・2026-09-02。それ以前は
//     「推測しない」として unverified にしていた。GET は x402 の壁に対して
//     副作用の無い最小の問い合わせであり、仕様がこれを既定に置いた);
//   - POST probes carry an empty JSON body — the x402 wall sits in front of
//     the handler, so a compliant server answers 402 before parsing. If a
//     server instead answers 2xx, that fact is recorded (no_402) and the
//     prober does NOT retry — one accidental execution is one too many.
//
// Verdict vocabulary is closed: pass | fail | unverified.
//   fail-closed direction is toward `unverified` — "no proof" ≠ "dead".
// Publication additionally gates single fails (legal multiple-measurement
// condition): see publishedVerdict().
// ============================================================

import { readBodyCapped } from "@/lib/net/read-capped";
import { UnsafeTargetError, createSafeFetchImpl } from "@/lib/net/safe-fetch";
import { parseChallenge, type ChallengeAccept as EnvelopeAccept } from "./x402-payer";
import { toCaip2 } from "./chains";

export type ProbeTarget = {
  resourceUrl: string;
  /** Catalog-declared method or null (undeclared → probed with GET, §6.1). */
  method: string | null;
  /** Catalog-declared facts to cross-check against the live 402 challenge. */
  payTo: string | null;
  network: string | null;
  priceAmount: string | null;
  priceAsset: string | null;
};

/**
 * 封筒の方言（§5「方言差は観測属性に持つ」）。v2 = PAYMENT-REQUIRED ヘッダ、
 * v1 = JSON ボディ、both = 両方、unpayable = 402 だがどちらにも封筒が無い。
 * 402 以外・到達不能のときは null（方言を語れない）。
 */
export type ProbeDialect = "v1" | "v2" | "both" | "unpayable";

export type ProbeResult = {
  method: string;
  verdict: "pass" | "fail" | "unverified";
  dialect: ProbeDialect | null;
  httpStatus: number | null;
  has402Challenge: boolean | null;
  acceptsValid: boolean | null;
  /** null = catalog declared no price → nothing to compare (skip ≠ fail). */
  priceConsistent: boolean | null;
  metadataConsistent: boolean | null;
  latencyMs: number | null;
  failReason: string | null;
  rawResponseMeta: Record<string, unknown> | null;
};

export type ProbeOptions = {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /**
   * §10 再検証（売り手異議・C4）。通常測定と別の経路で測る——UA と accept を変え、
   * rawResponseMeta.route に "recheck" を残す。egress が同一である事実は隠さない
   * （meta.route = "recheck_same_egress"）。
   */
  recheck?: boolean;
};

// SSRF (2026-08-15 audit). resourceUrl is third-party input: it is whatever a
// seller declared to the public Bazaar catalog, copied verbatim into our DB.
// The production default fetch therefore refuses any target that is — or
// redirects to — a non-public address, so a listed
// `http://169.254.169.254/latest/meta-data/…` costs zero requests instead of
// being fetched on schedule with 500 bytes of the reply stored in
// x402_l0_probes.raw_response_meta. Tests inject their own fetchImpl and are
// exercising the parse/verdict logic, not the network policy — that has its
// own tests in tests/outbound-ssrf.test.ts.
const guardedFetch = createSafeFetchImpl();

/** Published-fail gate: fewer consecutive fails than this renders as `unverified`. */
export const MIN_CONSECUTIVE_FAILS_TO_PUBLISH = 2;

/**
 * The verdict the PUBLIC page may show, from probe verdicts ordered newest
 * first. A pass or unverified passes through; a fail is only publishable
 * when the newest MIN_CONSECUTIVE_FAILS_TO_PUBLISH probes all failed —
 * a single fail (transient blip, our own network hiccup) must never brand
 * an endpoint dead in public.
 */
export function publishedVerdict(newestFirst: readonly string[]): "pass" | "fail" | "unverified" {
  const latest = newestFirst[0];
  if (latest === "pass") return "pass";
  if (latest === "fail") {
    let streak = 0;
    for (const v of newestFirst) {
      if (v !== "fail") break;
      streak++;
    }
    return streak >= MIN_CONSECUTIVE_FAILS_TO_PUBLISH ? "fail" : "unverified";
  }
  return "unverified";
}

function classifyNetworkError(
  error: unknown,
): "dns" | "tls" | "timeout" | "network" | "unsafe_target" | "redirect_limit" {
  // The guard fired before (or between) sockets. `unresolvable` is reported as
  // `dns` because that is exactly what the unguarded fetch used to report for
  // the same catalog row — the reason code must not change meaning just
  // because the check moved earlier.
  if (error instanceof UnsafeTargetError) {
    if (error.reason === "unresolvable") return "dns";
    if (error.reason === "too_many_redirects") return "redirect_limit";
    return "unsafe_target";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  // undici wraps the syscall error in TypeError.cause with a `code`.
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = typeof cause === "object" && cause !== null ? String((cause as { code?: unknown }).code ?? "") : "";
  const msg = cause instanceof Error ? cause.message : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code.startsWith("CERT_") || code.startsWith("ERR_TLS") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || /certificate|TLS|SSL/i.test(msg))
    return "tls";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  return "network";
}

/**
 * 402 の封筒を読む。§6.1「PAYMENT-REQUIRED または互換の支払い封筒がパース
 * できる」——ヘッダ（v2）とボディ（v1/v2）の両方を見る。旧実装はボディしか
 * 読まず、本番で 6,907 件の v2 の店を accepts_invalid と誤判定していた
 * （2026-09-02 実測・tests/l0-envelope-dialect.test.ts）。
 * パース本体は L1 と同じ parseChallenge（x402-payer.ts）を使い、L0 と L1 が
 * 別の封筒理解を持たないようにする。
 */
function parseEnvelope(
  headers: Headers,
  bodyText: string,
): { accepts: EnvelopeAccept[] | null; dialect: ProbeDialect; source: "header" | "body" | "both" | "none" } {
  const fromHeader = parseChallenge({ headers, bodyText: "" }, { lenient: true });
  const fromBody = bodyText ? parseChallenge({ headers: new Headers(), bodyText }, { lenient: true }) : null;
  const h = fromHeader && fromHeader.accepts.length > 0 ? fromHeader : null;
  const b = fromBody && fromBody.accepts.length > 0 ? fromBody : null;
  if (h && b) return { accepts: h.accepts, dialect: "both", source: "both" };
  if (h) return { accepts: h.accepts, dialect: "v2", source: "header" };
  if (b) return { accepts: b.accepts, dialect: b.x402Version === 2 ? "v2" : "v1", source: "body" };
  return { accepts: null, dialect: "unpayable", source: "none" };
}

const lower = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v.toLowerCase() : null);

export async function probeEndpoint(
  target: ProbeTarget,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const { fetchImpl = guardedFetch, timeoutMs = 10_000 } = options;

  // §6.1: 「GET および、掲載が POST のみなら POST」。宣言が無い Resource は GET で
  // 測る。2026-08 までは「推測しない」として unverified にしていたが、仕様 §17
  // （食い違えば実装を直す）に従い GET を既定にした。本番の該当は active 2 件。
  const method = (target.method ?? "GET").toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const UA = options.recheck
    ? "vet402-observatory-l0-recheck/1.0 (+https://vet402.com/observatory/methodology)"
    : "vet402-observatory-l0/1.0 (+https://vet402.com/observatory/methodology)";
  const ACCEPT = options.recheck ? "*/*" : "application/json";

  let response: Response;
  try {
    response = await fetchImpl(target.resourceUrl, {
      method,
      signal: controller.signal,
      // The guarded default follows redirects itself, re-checking each hop
      // (safe-fetch.ts); it overrides this to "manual" so the platform cannot
      // follow one for us. Left declared for an injected fetchImpl.
      redirect: "follow",
      headers: { accept: ACCEPT, "user-agent": UA },
      // Empty JSON body on POST: the x402 wall answers 402 before the handler
      // parses anything, so this cannot trigger work on a compliant server.
      ...(method === "POST"
        ? { body: "{}", headers: { accept: ACCEPT, "content-type": "application/json", "user-agent": UA } }
        : {}),
    });
  } catch (error) {
    const reason = classifyNetworkError(error);
    clearTimeout(timer);
    // §6.1: 到達不能（DNS・タイムアウト・接続拒否）は fail。TLS エラーと、我々が
    // 接触を拒んだ対象（unsafe_target）は判定不能 → unverified。「証明が無い」と
    // 「死んでいる」を混ぜない。
    const undecidable = reason === "unsafe_target" || reason === "tls";
    return {
      method,
      verdict: undecidable ? "unverified" : "fail",
      dialect: null,
      httpStatus: null,
      // `false` would assert we looked and saw no wall; on a refused target we
      // never looked.
      has402Challenge: reason === "unsafe_target" ? null : false,
      acceptsValid: null,
      priceConsistent: null,
      metadataConsistent: null,
      latencyMs: Date.now() - startedAt,
      failReason: reason,
      rawResponseMeta: { error: reason, client: UA, method },
    };
  }

  const latencyMs = Date.now() - startedAt;
  // 2026-08-22 監査: 本文は上限バイトで打ち切って読む（全部読んでから
  // slice すると上限が何も守らない）。abort タイマーも本文読み取りが
  // 終わるまで張ったままにする——AbortController はヘッダまでしか効かない
  // ので、先に解除すると遅いボディ送出を無制限に待てる（l1-runner と同じ欠陥）。
  let bodyText = "";
  try {
    bodyText = await readBodyCapped(response, 4_000);
  } catch {
    bodyText = "";
  } finally {
    clearTimeout(timer);
  }
  const meta: Record<string, unknown> = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    server: response.headers.get("server"),
    bodyHead: bodyText.slice(0, 500),
    client: UA,
    method,
    ...(options.recheck ? { route: "recheck_same_egress" } : {}),
  };

  if (response.status === 429) {
    // レート制限は「判定不能」であって「機械が払える 402 ではない」ではない（§6.1）。
    return {
      method,
      verdict: "unverified",
      dialect: null,
      httpStatus: 429,
      has402Challenge: null,
      acceptsValid: null,
      priceConsistent: null,
      metadataConsistent: null,
      latencyMs,
      failReason: "rate_limited",
      rawResponseMeta: meta,
    };
  }

  if (response.status !== 402) {
    // 200 で本編を返すのも、401/403 で鍵を要求するのも「機械が払える 402」ではない。
    return {
      method,
      verdict: "fail",
      dialect: null,
      httpStatus: response.status,
      has402Challenge: false,
      acceptsValid: null,
      priceConsistent: null,
      metadataConsistent: null,
      latencyMs,
      failReason: "no_402",
      rawResponseMeta: meta,
    };
  }

  const envelope = parseEnvelope(response.headers, bodyText);
  meta.dialect = envelope.dialect;
  meta.envelopeSource = envelope.source;
  const accepts = envelope.accepts;
  if (!accepts) {
    return {
      method,
      verdict: "fail",
      dialect: "unpayable",
      httpStatus: 402,
      has402Challenge: true,
      acceptsValid: false,
      priceConsistent: null,
      metadataConsistent: null,
      latencyMs,
      failReason: "accepts_invalid",
      rawResponseMeta: meta,
    };
  }
  const dialect = envelope.dialect;

  // Cross-check the live challenge against the catalog declaration. The
  // challenge may carry several accepts; we look for ANY that matches. A
  // declaration the catalog never made is not checkable → null (skip ≠ fail).
  const declaredPrice = target.priceAmount !== null || target.priceAsset !== null;
  const declaredMeta = target.payTo !== null || target.network !== null;
  const declaredNetwork = toCaip2(target.network);

  const priceConsistent = declaredPrice
    ? accepts.some(
        (a) =>
          (target.priceAmount === null || String(a.amount) === target.priceAmount) &&
          (target.priceAsset === null || lower(a.asset) === lower(target.priceAsset)),
      )
    : null;

  const metadataConsistent = declaredMeta
    ? accepts.some(
        (a) =>
          // 両辺を lower して比較する。カタログ側は 2026-08-20 まで全小文字
          // 保存（片側lowerで一致していた）、以降は base58 の原文保存なので、
          // 片側だけ lower すると Solana 行が全て偽の metadata_mismatch になる
          // （このズレは l1-runner の Solana 統合テストが実際に検出した）。
          // 大文字小文字はここでは同一性の情報として使わない——payTo の
          // 「どの口座か」は base58 の文字列全体が既に一意に定める。
          // network は両辺を CAIP-2 に寄せて比べる（カタログに v1 スラグが残る）。
          (target.payTo === null || lower(a.payTo) === lower(target.payTo)) &&
          (declaredNetwork === null || toCaip2(a.network) === declaredNetwork),
      )
    : null;

  if (priceConsistent === false) {
    return {
      method,
      verdict: "fail",
      dialect,
      httpStatus: 402,
      has402Challenge: true,
      acceptsValid: true,
      priceConsistent,
      metadataConsistent,
      latencyMs,
      failReason: "price_mismatch",
      rawResponseMeta: meta,
    };
  }
  if (metadataConsistent === false) {
    return {
      method,
      verdict: "fail",
      dialect,
      httpStatus: 402,
      has402Challenge: true,
      acceptsValid: true,
      priceConsistent,
      metadataConsistent,
      latencyMs,
      failReason: "metadata_mismatch",
      rawResponseMeta: meta,
    };
  }

  return {
    method,
    verdict: "pass",
    dialect,
    httpStatus: 402,
    has402Challenge: true,
    acceptsValid: true,
    priceConsistent,
    metadataConsistent,
    latencyMs,
    failReason: null,
    rawResponseMeta: meta,
  };
}

// ============================================================
// MCP の入口の tool 本体（2026-10-28・要件書 v3 §2.2）。
//
//   ① check_x402_seller        払う側。resolve → decide（skipScore・callerMaterial なし）→ 最新 5 件の購入
//   ③ check_my_x402_endpoint   売り手。/sellers/[host] と同じ resolveSellerPage と、ホストの出品・購入
//   ② find_x402_sellers        払う側。GET /api/v1/find と同じ Wilson 順位（p95 1.5 秒を満たしたときだけ載せる）
//   check_8004_agent           ERC-8004 の feedback 1 件を再読（GET /api/v1/erc8004/check と同じ JSON）
//
// 出力は schemas.ts の欄だけを、ライブラリの戻り値から 1 つずつ写して作る（広げて返さない）。
// 外へ出ない: 読むのは DB だけ。decide は必ず skipScore: true（受取人スコアは RPC へ出る）。
// 読み手は引数（McpDeps）で受け取る: route は cached の読み手を、pg テストは reader の関数を渡す。
// ============================================================
import type { McpServer } from "@modelcontextprotocol/server";
import type { decide as decideFn } from "@/lib/decision/decide";
import type { resolve as resolveFn, resolveForRoute as resolveForRouteFn, ResolveOpts } from "@/lib/resolve/lookup";
import { takeResolveModuleCold } from "@/lib/resolve/lookup";
import { runDbMissTimingPhase, sliceWithApp } from "@/lib/db/miss-timing";
import { usageChainOf } from "@/lib/api/decision-usage";
import { canonicalUrl } from "@/lib/ids/canonical";
import type { SellerFacts } from "@/lib/decision/types";
import { L1_WINDOW_DAYS } from "@/lib/decision/rules";
import { LISTING_SOURCES } from "@/lib/observatory/listing-sources";
import { searchLikePattern } from "@/lib/observatory/reader";
import { isDelivered } from "@/lib/observatory/delivery";
import { resolveSellerPage, type SellerPageData, type ShownRow } from "@/lib/sellers/board";
import { parseSellerHostParam } from "@/lib/sellers/host";
import { diagnoseUrlFor } from "@/lib/api/diagnose-url";
import type { CheckSellerCacheTiming } from "@/lib/api/check-seller-miss-timing";
import type { DecideRequest } from "@/lib/decision/decide";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import type { FindListing } from "@/lib/find/reads";
import { FIND_POOL_SIZE, FIND_WINDOW_DAYS, FIND_MIN_DELIVERED_RATE, rankFindAlternatives, wilsonLower } from "@/lib/find/rank";
import { PUBLIC_RULES_VERSION } from "@/lib/decision/rules-version-public";
import { DELIVERY_RATE_FORMULA } from "@/lib/delivery/delivery-rate";
import type { Erc8004CheckInput, Erc8004CheckDeps, Erc8004CheckError } from "@/lib/erc8004-check/run-check";
import type { Erc8004CheckResult } from "@/lib/erc8004-check/types";
import { getErc8004CheckCached } from "@/lib/erc8004-check/cache";
import { pct1 } from "@/lib/util/pct";
import type { FoundListing, HostExtras } from "./reads";
import { runCheckPaymentProof } from "@/lib/payment-proof/handle";
import { checkConcordiumAgent, isConcordiumAgent } from "./concordium";
import { checkNearAiAttestation } from "./nearai";
import {
  check8004AgentInput,
  check8004AgentOutput,
  checkConcordiumAgentInput,
  checkConcordiumAgentOutput,
  checkNearAiAttestationInput,
  checkNearAiAttestationOutput,
  checkEndpointInput,
  checkEndpointOutput,
  checkPaymentProofInput,
  checkPaymentProofOutput,
  checkSellerInput,
  checkSellerOutput,
  findSellersInput,
  findSellersOutput,
  isHttpsAbsoluteUrl,
  SELLER_TEXT_MAX_CHARS,
  type CheckEndpointOutput,
  type CheckSellerOutput,
  type FindSellersOutput,
  type L1PurchaseOut,
} from "./schemas";
import {
  ERROR_TEXT,
  fixFirstUrlOf,
  METHOD_URL,
  OUTPUT_TEXT,
  recordUrlOf,
  sellerUrlOf,
  TOOL_EMPTY_HINT,
  TOOL_TEXT,
} from "./text";
import { verdictNextStep } from "@/lib/decision/verdict-next-step";

export const TOOL_NAMES = {
  checkSeller: "check_x402_seller",
  checkEndpoint: "check_my_x402_endpoint",
  checkPayment: "check_payment_proof",
  findSellers: "find_x402_sellers",
  check8004: "check_8004_agent",
  checkConcordium: "check_concordium_agent",
  checkNearAi: "check_nearai_attestation",
} as const;

const FIND_MIN_DELIVERED_PCT = Math.round(FIND_MIN_DELIVERED_RATE * 100);

export { runCheckPaymentProof };

/**
 * ② を v1 に載せるか。要件書 §2.2: 本番と同じ件数規模の fixture で p95 1.5 秒を満たしたときだけ。
 * 測定は tests/mcp-find-p95.pg.test.ts（満たさなくなったらそのテストが落ちる）。
 */
export const FIND_TOOL_ENABLED = true;

export type SellerPageLoaders = Parameters<typeof resolveSellerPage>[1];

export type McpDeps = {
  resolve: typeof resolveFn;
  resolveForRoute?: typeof resolveForRouteFn;
  /** check 系 tool が endpoint の network を集計へ渡す（URL・IP は渡さない）。 */
  captureUsageNetwork?: (network: string) => void;
  decide: typeof decideFn;
  l1Purchases: (endpointId: string) => Promise<L1PurchaseOut[]>;
  sellerPage: SellerPageLoaders;
  hostExtras: (host: string) => Promise<HostExtras>;
  findAlternatives: (like: string, poolLimit: number) => Promise<{ fetchedAt: string; listings: FindListing[] }>;
  findUntested: (like: string) => Promise<FoundListing[]>;
  erc8004Check?: (input: Erc8004CheckInput, deps?: Erc8004CheckDeps) => Promise<Erc8004CheckResult | { error: Erc8004CheckError }>;
  /** check_concordium_agent が vet402-concordium を読む fetch（試験で差し替える）。 */
  concordiumFetch?: typeof fetch;
  now?: () => Date;
};

/** ① check_x402_seller が読む読み手だけ（tests の最小 fake deps 用）。 */
export type CheckSellerDeps = Pick<McpDeps, "resolve" | "resolveForRoute" | "captureUsageNetwork" | "decide" | "l1Purchases"> & {
  now?: () => Date;
};

/** 1 回の要求の状態。DB を読めなかった tool があれば route が 503 にする。 */
export type McpRequestState = { unavailable: boolean; usageNetwork?: string };

/** structuredContent の上限（同じ JSON を TextContent にも載せるので、応答全体は約 2 倍になる。16KB 以内に収める）。 */
export const MAX_STRUCTURED_BYTES = 7_000;

/** 配列の末尾から落として上限に収める。落としたら truncated を立てる。 */
export function fitBudget<T extends { truncated: boolean }>(out: T, arrays: (keyof T)[]): T {
  const size = () => Buffer.byteLength(JSON.stringify(out), "utf8");
  while (size() > MAX_STRUCTURED_BYTES) {
    let longest: keyof T | null = null;
    let len = 0;
    for (const k of arrays) {
      const v = out[k];
      if (Array.isArray(v) && v.length > len) {
        longest = k;
        len = v.length;
      }
    }
    if (!longest) break;
    (out[longest] as unknown[]).pop();
    out.truncated = true;
  }
  return out;
}

/**
 * 売り手が書いた文（description）。エージェントにとってプロンプト注入の口になるので、改行・制御文字・書式文字を落とし、
 * 空白を 1 つに詰め、200 字（コードポイント）で切る。空なら null。
 */
export function sanitizeSellerText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const flat = raw
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cps = Array.from(flat);
  const cut = (cps.length > SELLER_TEXT_MAX_CHARS ? cps.slice(0, SELLER_TEXT_MAX_CHARS).join("") : flat).trim();
  return cut === "" ? null : cut;
}

/** price_amount は USDC の基本単位（10^6 = 1 ドル）の整数文字列。それ以外は null。 */
export function priceUsdOf(amount: string | null): number | null {
  if (!amount || !/^\d{1,30}$/.test(amount)) return null;
  const n = Number(amount) / 1_000_000;
  return Number.isFinite(n) ? n : null;
}

const listingSources = () => LISTING_SOURCES.map((s) => ({ source: s.source, name: s.name, url: s.url, protocol: s.protocol, sync_times_utc: [...s.sync_times_utc] }));

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// ① check_x402_seller
// ------------------------------------------------------------

export function emptyCheckSellerHint(asOf: string): CheckSellerOutput {
  return {
    evidence_age: null,
    canonical_url: null,
    method: null,
    not_in_catalog: true,
    recommendation: null,
    reason_codes: [],
    reasons: [],
    delivery: null,
    l0_status: null,
    verified_terms: null,
    verified_pay_to_by_network: [],
    spending_halted: null,
    refunds: null,
    freshness: null,
    l1_purchases: [],
    same_host_listings: [],
    listing_sources: listingSources(),
    note: TOOL_EMPTY_HINT.check_x402_seller,
    record_url: null,
    method_url: METHOD_URL,
    diagnose_url: null,
    as_of: asOf,
    truncated: false,
    next_action: null,
    rules_version: PUBLIC_RULES_VERSION,
  };
}

function emitUsageNetwork(deps: Pick<McpDeps, "captureUsageNetwork">, network: string | null | undefined): void {
  const chain = usageChainOf(network);
  if (chain) deps.captureUsageNetwork?.(chain);
}

/** check_my_x402_endpoint 用。URL に一致する掲載が 1 チェーンに定まるときだけ network を返す。 */
export function usageNetworkFromMatchingListings(
  listings: ReadonlyArray<{ resourceUrl: string; network: string | null | undefined }>,
  rawUrl: string,
): string | null | undefined {
  const c = canonicalUrl(rawUrl);
  if (!c) return undefined;
  const matches = listings.filter((l) => canonicalUrl(l.resourceUrl)?.url === c.url);
  const chains = new Set<string>();
  for (const l of matches) {
    const chain = usageChainOf(l.network);
    if (chain) chains.add(chain);
  }
  if (chains.size !== 1) return null;
  for (const l of matches) {
    const chain = usageChainOf(l.network);
    if (chain) return l.network ?? null;
  }
  return null;
}

export async function checkSeller(
  deps: CheckSellerDeps,
  input: { url: string; method?: string },
  timing?: CheckSellerCacheTiming,
): Promise<CheckSellerOutput> {
  const now = (deps.now ?? (() => new Date()))();
  const method = input.method ? input.method.toUpperCase() : undefined;
  const resolveOpts = { ...(method ? { method } : {}), skipDomainEndpointsOnResourceHit: true } satisfies ResolveOpts;
  const miss = timing?.miss ?? (timing ? (timing.miss = {}) : undefined);
  let resolved: Awaited<ReturnType<typeof resolveFn>>;
  if (miss) {
    const tResolve = performance.now();
    miss.db_resolve_cold = takeResolveModuleCold();
    const read = async () => {
      if (deps.resolveForRoute) {
        const bundle = await deps.resolveForRoute(input.url, resolveOpts);
        if (bundle.usageNetwork) deps.captureUsageNetwork?.(bundle.usageNetwork);
        return bundle.result;
      }
      return deps.resolve(input.url, resolveOpts);
    };
    const { value, slice } = await runDbMissTimingPhase("resolve", read);
    resolved = value;
    const wall = performance.now() - tResolve;
    miss.db_resolve = wall;
    const s = sliceWithApp(slice, wall);
    miss.db_resolve_conn = s.conn;
    miss.db_resolve_q = s.q;
    miss.db_resolve_qn = s.qn;
    miss.db_resolve_app = s.app;
  } else if (deps.resolveForRoute) {
    const bundle = await deps.resolveForRoute(input.url, resolveOpts);
    resolved = bundle.result;
    if (bundle.usageNetwork) deps.captureUsageNetwork?.(bundle.usageNetwork);
  } else {
    resolved = await deps.resolve(input.url, resolveOpts);
  }
  const resource = resolved.resource;
  const decideReq = {
    role: "payer" as const,
    observatoryId: "",
    operatorBlacklist: false,
    callerMaterial: null,
    skipScore: true,
    missTiming: miss,
  } satisfies DecideRequest & { observatoryId: string };
  let decision: Awaited<ReturnType<typeof decideFn>> = null;
  let purchases: L1PurchaseOut[] = [];
  if (resource) {
    decideReq.observatoryId = resource.observatory_id;
    // decide と l1Purchases は互いに依存しないので並列に読む。l1Purchases の失敗は、直列の時と同じく
    // decision がある時だけ投げる（decision が無ければ以前は l1Purchases を読まずに not_in_catalog を返していた）。
    const t0 = performance.now();
    const l1Settled = deps.l1Purchases(resource.observatory_id).then(
      (rows) => {
        if (miss) miss.db_l1_recent = performance.now() - t0;
        return { ok: true as const, rows };
      },
      (error: unknown) => ({ ok: false as const, error }),
    );
    decision = await deps.decide(decideReq);
    const l1 = await l1Settled;
    if (decision) {
      if (!l1.ok) throw l1.error;
      purchases = l1.rows;
      if (timing) {
        const payees = (decision.facts as { payees?: unknown }).payees;
        if (Array.isArray(payees)) timing.catalogPayees = payees.filter((p): p is string => typeof p === "string");
      }
    }
  }
  if (!resource || !decision) {
    // resource は当たったが判定が無い時、skip で同じホストの掲載を読んでいない。公開 resolve と同じ読み
    // （skip なし）をここで1回して、same_host_listings を今までと同じにする（2026-11-28）。
    let endpoints = resolved.endpoints;
    if (resource && endpoints === undefined) {
      endpoints = (await deps.resolve(input.url, method ? { method } : {})).endpoints;
    }
    const host = hostnameOf(input.url);
    const same = (endpoints ?? []).filter((e) => host !== null && hostnameOf(e.canonical_url) === host).slice(0, 5);
    return fitBudget<CheckSellerOutput>(
      {
        evidence_age: null,
        canonical_url: null,
        method: method ?? null,
        not_in_catalog: true,
        recommendation: null,
        reason_codes: [],
        reasons: [],
        delivery: null,
        l0_status: null,
        verified_terms: null,
        verified_pay_to_by_network: [],
        spending_halted: null,
        refunds: null,
        freshness: null,
        l1_purchases: [],
        same_host_listings: same.map((e) => ({
          url: e.canonical_url,
          method: e.method,
          catalog_status: e.catalog_status,
          record_url: recordUrlOf(e.observatory_id),
        })),
        listing_sources: listingSources(),
        note: OUTPUT_TEXT.notInCatalog,
        record_url: null,
        method_url: METHOD_URL,
        diagnose_url: diagnoseUrlFor(input.url),
        as_of: now.toISOString(),
        truncated: false,
        next_action: null,
        rules_version: PUBLIC_RULES_VERSION,
      },
      ["same_host_listings"],
    );
  }
  const facts = decision.facts as SellerFacts;
  const vt = decision.verified_terms;
  const out: CheckSellerOutput = {
    evidence_age: decision.evidence_age ?? null,
    canonical_url: resource.canonical_url,
    method: resource.method,
    not_in_catalog: false,
    recommendation: decision.recommendation,
    reason_codes: [...decision.reason_codes],
    reasons: decision.reasons.map((r) => ({
      code: r.code,
      text: r.text,
      effect: r.effect,
      max_recommendation: r.max_recommendation,
      evidence_status: r.evidence_status,
      evidence: r.evidence.map((e) => ({ kind: e.kind, id: e.id, url: e.url })),
    })),
    delivery: {
      paid_attempts: facts.l1.n_attempts,
      delivered: facts.l1.n_delivered,
      settled_not_delivered: decision.l1_basis?.n_paid_undelivered ?? 0,
      last_attempt_at: facts.l1.last_attempt_at,
      window_days: L1_WINDOW_DAYS,
    },
    l0_status: facts.l0.status,
    verified_terms: vt
      ? {
          purchase_id: vt.purchase_id,
          pay_to: vt.pay_to,
          asset: vt.asset,
          amount: vt.amount,
          decimals: vt.decimals,
          network: vt.network,
          scheme: vt.scheme,
          protocol: vt.protocol,
          verified_at: vt.verified_at,
        }
      : null,
    // 2026-11-22: 広げて返さず 1 欄ずつ写す（schemas の strict と同じ欄だけ）。
    verified_pay_to_by_network: (decision.verified_pay_to_by_network ?? []).map((v) => ({
      network: v.network,
      pay_to: v.pay_to,
      purchase_id: v.purchase_id,
      verified_at: v.verified_at,
    })),
    spending_halted: decision.spending_halted,
    refunds: decision.refunds
      ? {
          ...decision.refunds,
          networks_read: [...decision.refunds.networks_read],
        }
      : null,
    freshness: { l0: decision.freshness.l0, l1: decision.freshness.l1, l2: decision.freshness.l2 },
    l1_purchases: purchases.slice(0, 5).map(copyPurchase),
    same_host_listings: [],
    listing_sources: [],
    note: null,
    record_url: recordUrlOf(resource.observatory_id),
    diagnose_url: null,
    method_url: METHOD_URL,
    // 判定は 5 分キャッシュされる。キャッシュから返した文書に「今」を付けない（判定を作った時刻）。
    as_of: decision.scoredAt,
    truncated: false,
    next_action: verdictNextStep(decision.recommendation, decision.reason_codes),
    rules_version: decision.rules_version,
  };
  fitBudget(out, ["reasons"]);
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_STRUCTURED_BYTES) {
    fitBudget(out, ["l1_purchases", "reason_codes"]);
  }
  return out;
}

function copyPurchase(p: L1PurchaseOut): L1PurchaseOut {
  return { attempted_at: p.attempted_at, network: p.network, status: p.status, tx_hash: p.tx_hash, explorer_url: p.explorer_url };
}

// ------------------------------------------------------------
// ③ check_my_x402_endpoint
// ------------------------------------------------------------

/** next-buy.ts の notBefore（"YYYY-MM-DD HH:MM UTC"）を ISO 8601 UTC にする。読めなければ null。 */
function notBeforeIso(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(s);
  return m ? `${m[1]}T${m[2]}:00Z` : null;
}

type ResultCounts = NonNullable<CheckEndpointOutput["l1"]>["listings_by_latest_result"];

function bucketCounts(rows: readonly (ShownRow | null)[]): ResultCounts {
  const c: ResultCounts = { delivered: 0, pending: 0, seller_side: 0, vet402_side: 0, not_sorted: 0, not_paid: 0, not_tried: 0 };
  for (const r of rows) {
    if (!r) c.not_tried++;
    else if (r.bucket === "delivered") c.delivered++;
    else if (r.bucket === "pending") c.pending++;
    else if (r.bucket === "seller") c.seller_side++;
    else if (r.bucket === "vet402") c.vet402_side++;
    else if (r.bucket === "unsorted") c.not_sorted++;
    else c.not_paid++;
  }
  return c;
}

/** 頁の行（Base の最新＋それより前・他チェーンの最新）から、払った回数・届いた回数・失敗の種類を数える。 */
export function endpointNumbers(page: SellerPageData): {
  paid: number;
  delivered: number;
  modes: Map<string, number>;
  byLatest: ResultCounts | null;
} {
  const modes = new Map<string, number>();
  let paid = 0;
  let delivered = 0;
  const count = (r: ShownRow) => {
    if (r.signed) paid++;
    if (r.bucket === "delivered") delivered++;
    if (r.mode && r.bucket !== "delivered") modes.set(r.mode.key, (modes.get(r.mode.key) ?? 0) + 1);
  };
  if (page.kind === "base") {
    for (const l of page.detail.listings) {
      for (const r of [l.latest, ...l.earlier]) if (r) count(r);
      const o = l.otherChain;
      if (o) {
        paid++;
        if (isDelivered({ status: o.status, httpStatusPaid: o.httpStatusPaid, payloadNonEmpty: o.payloadNonEmpty ?? null })) delivered++;
      }
    }
    const s = page.detail.summary;
    return {
      paid,
      delivered,
      modes,
      byLatest: {
        delivered: s.delivered,
        pending: s.pending,
        seller_side: s.seller,
        vet402_side: s.vet402,
        not_sorted: s.unsorted,
        not_paid: s.notPaid,
        not_tried: s.notTried,
      },
    };
  }
  if (page.kind === "other_chains") {
    for (const l of page.other.listings) count(l.latest);
    return { paid, delivered, modes, byLatest: bucketCounts(page.other.listings.map((l) => l.latest)) };
  }
  return { paid: 0, delivered: 0, modes, byLatest: null };
}

export async function checkEndpoint(deps: McpDeps, input: { url: string }): Promise<CheckEndpointOutput | "invalid_host"> {
  const hostname = hostnameOf(input.url);
  const host = hostname ? parseSellerHostParam(hostname) : null;
  if (!host) return "invalid_host";
  const [page, extras] = await Promise.all([resolveSellerPage(host, deps.sellerPage), deps.hostExtras(host)]);
  const byId = new Map(extras.listings.map((l) => [l.endpointId, l]));

  const known = new Map(LISTING_SOURCES.map((s) => [s.source, s]));
  const listed = new Map<string, { listings: number; last: string | null }>();
  for (const l of extras.listings) {
    if (l.status !== "active") continue;
    const cur = listed.get(l.source) ?? { listings: 0, last: null };
    cur.listings++;
    if (l.lastSeenAt && (!cur.last || l.lastSeenAt > cur.last)) cur.last = l.lastSeenAt;
    listed.set(l.source, cur);
  }
  const listedIn = [...listed.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, v]) => ({
      source,
      name: known.get(source)?.name ?? source,
      sync_times_utc: [...(known.get(source)?.sync_times_utc ?? [])],
      listings: v.listings,
      last_seen_at: v.last,
    }));

  const nums = endpointNumbers(page);
  const modes = [...nums.modes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count, fix_first_url: fixFirstUrlOf(key) }));

  let l0: CheckEndpointOutput["l0"] = null;
  let listings: CheckEndpointOutput["listings"] = [];
  let asOf = extras.fetchedAt;
  const notes: string[] = [];
  if (page.kind === "base") {
    asOf = page.detail.fetchedAt;
    const c = { pass: 0, fail: 0, unverified: 0, not_probed: 0, last_checked_at: null as string | null };
    for (const l of page.detail.listings) {
      const v = l.nextBuyFacts?.latestL0Verdict ?? null;
      if (v === "pass") c.pass++;
      else if (v === "fail") c.fail++;
      else if (v === "unverified") c.unverified++;
      else c.not_probed++;
      const at = l.nextBuyFacts?.latestL0At ?? null;
      if (at && (!c.last_checked_at || at > c.last_checked_at)) c.last_checked_at = at;
    }
    l0 = c;
    listings = page.detail.listings.map((l) => ({
      url: l.resourceUrl,
      network: byId.get(l.endpointId)?.network ?? l.latest?.facts.network ?? null,
      l0_latest: l.nextBuyFacts?.latestL0Verdict ?? null,
      latest_result: l.latest?.bucket ?? null,
      next_purchase_earliest_at: l.nextBuy?.kind === "window" ? notBeforeIso(l.nextBuy.notBefore) : null,
      record_url: recordUrlOf(l.endpointId),
    }));
  } else if (page.kind === "other_chains") {
    asOf = page.other.fetchedAt;
    notes.push(OUTPUT_TEXT.otherChainsPage);
    listings = page.other.listings.map((l) => ({
      url: byId.get(l.endpointId)?.resourceUrl ?? `https://${l.resourceKey}`,
      network: l.latest.facts.network ?? byId.get(l.endpointId)?.network ?? null,
      l0_latest: null,
      latest_result: l.latest.bucket,
      next_purchase_earliest_at: null,
      record_url: recordUrlOf(l.endpointId),
    }));
  } else {
    notes.push(OUTPUT_TEXT.hostNotOnRecord);
  }
  const fixFirst = modes[0]?.fix_first_url ?? null;
  if (fixFirst) notes.push(OUTPUT_TEXT.fixFirstNote);

  emitUsageNetwork(deps, usageNetworkFromMatchingListings(extras.listings, input.url) ?? null);

  return fitBudget<CheckEndpointOutput>(
    {
      host,
      on_record: page.kind !== "none",
      page_kind: page.kind,
      listed_in: listedIn,
      listing_sources: listingSources(),
      l0,
      l1: nums.byLatest ? { paid_attempts: nums.paid, delivered: nums.delivered, listings_by_latest_result: nums.byLatest } : null,
      l1_failure_modes: modes,
      listings,
      l1_purchases: extras.purchases.slice(0, 5).map(copyPurchase),
      fix_first_url: fixFirst,
      notes,
      record_url: page.kind === "none" ? null : sellerUrlOf(host),
      method_url: METHOD_URL,
      as_of: asOf,
      truncated: false,
    },
    ["listings", "l1_failure_modes", "listed_in", "l1_purchases"],
  );
}

// ------------------------------------------------------------
// ② find_x402_sellers
// ------------------------------------------------------------

export async function findSellers(
  deps: McpDeps,
  input: { query?: string; limit?: number },
): Promise<FindSellersOutput | "invalid_query"> {
  const query = (input.query ?? "").trim();
  if (input.query === undefined) {
    return {
      query: "",
      sellers: [],
      untested: [],
      note: TOOL_EMPTY_HINT.find_x402_sellers,
      method_url: METHOD_URL,
      rate_formula: DELIVERY_RATE_FORMULA,
      rules_version: PUBLIC_RULES_VERSION,
      as_of: (deps.now?.() ?? new Date()).toISOString(),
      truncated: false,
    };
  }
  if (!query) return "invalid_query";
  const like = searchLikePattern(query);
  if (!like) return "invalid_query";
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const [pool, untested] = await Promise.all([
    deps.findAlternatives(like, FIND_POOL_SIZE),
    deps.findUntested(like),
  ]);
  const ranked = rankFindAlternatives(pool.listings, null, limit);
  const mapSeller = (s: FindListing) => ({
    url: s.url,
    seller_description: sanitizeSellerText(s.description),
    text_source: "seller" as const,
    price_usd: priceUsdOf(s.priceAmount),
    network: s.network,
    delivered_30d: s.delivered30d,
    paid_attempts_30d: s.paidAttempts30d,
    delivered_rate_pct: pct1(s.delivered30d, s.paidAttempts30d),
    wilson_lower_bound: wilsonLower(s.delivered30d, s.paidAttempts30d),
    last_attempt_at: s.lastAttemptAt,
    record_url: recordUrlOf(s.observatoryId),
  });
  return fitBudget<FindSellersOutput>(
    {
      query,
      sellers: ranked.alternatives.map(mapSeller),
      untested: untested.map((s) => ({
        url: s.url,
        seller_description: sanitizeSellerText(s.description),
        text_source: "seller" as const,
        price_usd: priceUsdOf(s.priceAmount),
        network: s.network,
        record_url: recordUrlOf(s.observatoryId),
      })),
      method_url: METHOD_URL,
      rate_formula: DELIVERY_RATE_FORMULA,
      rules_version: PUBLIC_RULES_VERSION,
      as_of: pool.fetchedAt,
      truncated: false,
    },
    ["untested", "sellers"],
  );
}

const ERC8004_INPUT_ERRORS = new Set<Erc8004CheckError>([
  "invalid_chain",
  "invalid_agent_id",
  "missing_client_or_index",
  "invalid_client",
  "invalid_feedback_index",
  "feedback_not_found",
  "ambiguous_feedback_index",
]);

export async function check8004Agent(
  deps: McpDeps,
  input: { chain?: string; agentId?: string; client?: string; feedbackIndex?: string },
): Promise<Erc8004CheckResult | { error: Erc8004CheckError }> {
  if (!input.agentId?.trim()) {
    return { error: "invalid_agent_id" };
  }
  const run = deps.erc8004Check ?? ((body, extra) => getErc8004CheckCached(body, extra));
  return run(
    {
      chain: input.chain ?? null,
      agentId: input.agentId,
      client: input.client ?? null,
      feedbackIndex: input.feedbackIndex ?? null,
    },
    undefined,
  );
}

export { ERC8004_INPUT_ERRORS };

// ------------------------------------------------------------
// 登録
// ------------------------------------------------------------

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const CHAIN_READ_ANNOTATIONS = { ...ANNOTATIONS, openWorldHint: true } as const;

const PAYMENT_INPUT_CODES = new Set(["invalid_payment_response", "invalid_transaction", "invalid_body"]);

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(out: Record<string, unknown>): ToolResult {
  return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out) }] };
}

function fail(code: keyof typeof ERROR_TEXT): ToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: ERROR_TEXT[code] }) }] };
}

async function guarded(state: McpRequestState, tool: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    // 入力の URL や DB の例外の本文（params）を生で出さない。log-safe が伏せる。
    logServerErrorSafe(`mcp.${tool}`, error);
    state.unavailable = true;
    return fail("temporarily_unavailable");
  }
}

export function registerVet402Tools(server: McpServer, deps: McpDeps, state: McpRequestState): void {
  server.registerTool(
    TOOL_NAMES.checkSeller,
    {
      title: TOOL_TEXT.check_x402_seller.title,
      description: TOOL_TEXT.check_x402_seller.description,
      inputSchema: checkSellerInput,
      outputSchema: checkSellerOutput,
      annotations: { title: TOOL_TEXT.check_x402_seller.title, ...ANNOTATIONS },
    },
    async (args) =>
      guarded(state, TOOL_NAMES.checkSeller, async () => {
        const now = (deps.now ?? (() => new Date()))();
        if (!args.url?.trim()) return ok(emptyCheckSellerHint(now.toISOString()));
        if (!isHttpsAbsoluteUrl(args.url)) return fail("invalid_url");
        return ok(await checkSeller(deps, { url: args.url, method: args.method }));
      }),
  );
  server.registerTool(
    TOOL_NAMES.checkEndpoint,
    {
      title: TOOL_TEXT.check_my_x402_endpoint.title,
      description: TOOL_TEXT.check_my_x402_endpoint.description,
      inputSchema: checkEndpointInput,
      outputSchema: checkEndpointOutput,
      annotations: { title: TOOL_TEXT.check_my_x402_endpoint.title, ...ANNOTATIONS },
    },
    async (args) =>
      guarded(state, TOOL_NAMES.checkEndpoint, async () => {
        if (!args.url?.trim()) {
          return fail("missing_endpoint_url");
        }
        if (!isHttpsAbsoluteUrl(args.url)) return fail("invalid_url");
        const out = await checkEndpoint(deps, { url: args.url });
        return out === "invalid_host" ? fail("invalid_host") : ok(out);
      }),
  );
  server.registerTool(
    TOOL_NAMES.checkPayment,
    {
      title: TOOL_TEXT.check_payment_proof.title,
      description: TOOL_TEXT.check_payment_proof.description,
      inputSchema: checkPaymentProofInput,
      outputSchema: checkPaymentProofOutput,
      annotations: { title: TOOL_TEXT.check_payment_proof.title, ...CHAIN_READ_ANNOTATIONS },
    },
    async (args) =>
      guarded(state, TOOL_NAMES.checkPayment, async () => {
        try {
          const out = await runCheckPaymentProof(args);
          return ok({ ...out });
        } catch (error) {
          if (error instanceof Error && PAYMENT_INPUT_CODES.has(error.message)) {
            return fail(error.message as "invalid_payment_response" | "invalid_transaction" | "invalid_body");
          }
          throw error;
        }
      }),
  );
  server.registerTool(
    TOOL_NAMES.check8004,
    {
      title: TOOL_TEXT.check_8004_agent.title,
      description: TOOL_TEXT.check_8004_agent.description,
      inputSchema: check8004AgentInput,
      outputSchema: check8004AgentOutput,
      annotations: { title: TOOL_TEXT.check_8004_agent.title, ...CHAIN_READ_ANNOTATIONS },
    },
    async (args) =>
      guarded(state, TOOL_NAMES.check8004, async () => {
        if (!args.agentId?.trim()) {
          return fail("invalid_agent_id");
        }
        const out = await check8004Agent(deps, { ...args, agentId: args.agentId });
        if ("error" in out) {
          if (ERC8004_INPUT_ERRORS.has(out.error)) return fail(out.error as keyof typeof ERROR_TEXT);
          return fail("invalid_agent_id");
        }
        return ok(out as unknown as Record<string, unknown>);
      }),
  );
  server.registerTool(
    TOOL_NAMES.checkNearAi,
    {
      title: TOOL_TEXT.check_nearai_attestation.title,
      description: TOOL_TEXT.check_nearai_attestation.description,
      inputSchema: checkNearAiAttestationInput,
      outputSchema: checkNearAiAttestationOutput,
      annotations: { title: TOOL_TEXT.check_nearai_attestation.title, ...CHAIN_READ_ANNOTATIONS },
    },
    async () =>
      guarded(state, TOOL_NAMES.checkNearAi, async () => {
        const out = await checkNearAiAttestation();
        if (out === "unavailable") return fail("nearai_unavailable");
        return ok(out as unknown as Record<string, unknown>);
      }),
  );
  server.registerTool(
    TOOL_NAMES.checkConcordium,
    {
      title: TOOL_TEXT.check_concordium_agent.title,
      description: TOOL_TEXT.check_concordium_agent.description,
      inputSchema: checkConcordiumAgentInput,
      outputSchema: checkConcordiumAgentOutput,
      annotations: { title: TOOL_TEXT.check_concordium_agent.title, ...CHAIN_READ_ANNOTATIONS },
    },
    async (args) =>
      guarded(state, TOOL_NAMES.checkConcordium, async () => {
        const agent = (args.agent ?? "").trim();
        if (!agent || !isConcordiumAgent(agent)) return fail("invalid_concordium_agent");
        // Concordium 側に届かなくても vet402 の障害（503）には数えない。state.unavailable を立てない。
        const out = await checkConcordiumAgent(agent, deps.concordiumFetch ?? fetch);
        if (out === "unavailable") return fail("concordium_unavailable");
        return ok(out);
      }),
  );
  if (!FIND_TOOL_ENABLED) return;
  server.registerTool(
    TOOL_NAMES.findSellers,
    {
      title: TOOL_TEXT.find_x402_sellers.title,
      description: TOOL_TEXT.find_x402_sellers.description,
      inputSchema: findSellersInput,
      outputSchema: findSellersOutput,
      annotations: { title: TOOL_TEXT.find_x402_sellers.title, ...ANNOTATIONS },
    },
    async (args) =>
      guarded(state, TOOL_NAMES.findSellers, async () => {
        const out = await findSellers(deps, args);
        return out === "invalid_query" ? fail("invalid_query") : ok(out);
      }),
  );
}

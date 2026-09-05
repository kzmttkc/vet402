// ============================================================
// §8.1 売り手事実。集計は純関数 assembleSellerFacts に置き、DB 読みは loadSellerFacts。
//
//   l0.status        = publishedVerdict（2 連続 fail ゲート。1 回の fail を公開しない）
//   l1.n_attempts    = 署名した試行（spent が立つ status）。署名前の拒否は数えない
//   l1.n_settled     = チェーンで確定（status = settled）
//   l1.n_delivered   = settled かつ 2xx かつ非空
//   l2.status        = 宣言が無ければ undeclared。あれば直近の配達の l2_schema:
//                      match → conform、mismatch → mismatch、それ以外 → undeclared
//                      （未検査を mismatch と書かない）
//   offer_stability  = 24h 窓で (amount, asset, payTo) の実質変更 ≥ 3 → drifting
//   wash_dominated   = raw ≥ 10 かつ real ≤ raw × 10%
// trustScore はここに入れない（§8.3）。
// ============================================================
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { publishedVerdict } from "@/lib/observatory/l0-probe";
import { purchaseId as toPurchaseId } from "@/lib/ids/canonical";
import { toCaip2 } from "@/lib/observatory/chains";
import { getSettlementCounts } from "@/lib/settlements/census";
import { rowsOf } from "@/lib/settlements/upsert";
import { toIsoUtc } from "@/lib/util/iso-utc";
import type { Dialect, Evidence, L2Status, OfferStability, SellerFacts } from "./types";

export type ProbeInput = {
  probedAt: string;
  verdict: string;
  dialect: string | null;
  failReason: string | null;
  priceAmount: string | null;
  priceAsset: string | null;
  payTo: string | null;
};

export type PurchaseInput = {
  attemptedAt: string;
  status: string;
  latencyMs: number | null;
  httpStatusPaid: number | null;
  payloadNonEmpty: boolean | null;
  l2Schema: string | null;
  txHash: string | null;
  network: string | null;
  /** §6.3: l1-runner が raw_response_meta.l2 に残す判定材料（2026-09-02 以降の行だけ持つ）。 */
  l2Detail?: { missing: string[]; declarationHash: string | null; responseHash: string } | null;
};

export type SellerFactsInput = {
  /** newest first */
  probes: ProbeInput[];
  /** newest first */
  purchases: PurchaseInput[];
  settlements30d: { raw: number; real: number; test: number; uniquePayersReal: number };
  payees: string[];
  declaredSchema: unknown | null;
  /**
   * 全履歴での最終試行時刻（ISO8601 UTC）。`purchases` から導かない——あちらは
   * 直近 30 日 / 200 行の窓なので、窓の外の試行が「一度も無い」に化ける。
   */
  lastAttemptAt: string | null;
};

/** 署名した（＝支払い済み・spent が立つ）status。§6.2 の n_attempts。 */
export const SIGNED_STATUSES = new Set([
  "settled",
  "settle_claimed",
  "settle_claim_refuted",
  "settle_claimed_unverifiable",
  "delivered_no_receipt",
  "settle_failed",
]);

export const DRIFT_CHANGES_PER_24H = 3;
export const WASH_DOMINATED_MIN_RAW = 10;
export const WASH_DOMINATED_REAL_SHARE = 0.1;

const DIALECTS = new Set(["v1", "v2", "both", "unpayable"]);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function offerStabilityOf(probesNewestFirst: readonly ProbeInput[]): OfferStability {
  const passes = probesNewestFirst.filter((p) => p.verdict === "pass");
  if (passes.length < 2) return "unknown";
  const asc = [...passes].reverse();
  const key = (p: ProbeInput) => `${p.priceAmount ?? ""}|${(p.priceAsset ?? "").toLowerCase()}|${(p.payTo ?? "").toLowerCase()}`;
  const changes: number[] = [];
  for (let i = 1; i < asc.length; i++) {
    if (key(asc[i]) !== key(asc[i - 1])) changes.push(Date.parse(asc[i].probedAt));
  }
  for (let i = 0; i < changes.length; i++) {
    let n = 1;
    for (let j = i + 1; j < changes.length && changes[j] - changes[i] <= 86_400_000; j++) n++;
    if (n >= DRIFT_CHANGES_PER_24H) return "drifting";
  }
  return "stable";
}

export function assembleSellerFacts(input: SellerFactsInput): SellerFacts {
  const { probes, purchases } = input;
  const latestProbe = probes[0] ?? null;
  const l0Status = publishedVerdict(probes.map((p) => p.verdict));

  // §6.2 probe_error: 決済は確定したが 4xx——我々のリクエストが不正だった（2026-09-02
  // 本番実測: settled 980 件のうち 79 件・54 endpoint。exa.ai/search は POST に `{}` を
  // 送って 400）。F-1（2026-08-26）と同型の冤罪を避けるため、n_attempts から外す。
  const isProbeError = (p: PurchaseInput) =>
    p.status === "settled" && p.httpStatusPaid !== null && p.httpStatusPaid >= 400 && p.httpStatusPaid < 500;
  const probeErrors = purchases.filter(isProbeError);
  const signed = purchases.filter((p) => SIGNED_STATUSES.has(p.status) && !isProbeError(p));
  const settled = signed.filter((p) => p.status === "settled");
  const delivered = settled.filter(
    (p) => p.httpStatusPaid !== null && p.httpStatusPaid >= 200 && p.httpStatusPaid < 300 && p.payloadNonEmpty === true,
  );
  const latencies = settled.map((p) => p.latencyMs).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const lastSettled = settled[0] ?? null;

  const declared = input.declaredSchema !== null && input.declaredSchema !== undefined;
  let l2Status: L2Status = "undeclared";
  let l2ObservedAt: string | null = null;
  let l2Detail: PurchaseInput["l2Detail"] = null;
  if (declared) {
    const lastDelivered = delivered[0] ?? null;
    if (lastDelivered) {
      l2ObservedAt = lastDelivered.attemptedAt;
      if (lastDelivered.l2Schema === "match") l2Status = "conform";
      else if (lastDelivered.l2Schema === "mismatch") l2Status = "mismatch";
      l2Detail = lastDelivered.l2Detail ?? null;
    }
  }
  const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
  const declarationHash = declared ? sha256(JSON.stringify(input.declaredSchema)) : null;
  // §6.3: response_hash は conform でも出す。diff_hash / missing_keys は mismatch のときだけ。
  // 詳細の無い旧行はハッシュを捏造しない（null）。
  const responseHash = l2Status !== "undeclared" && l2Detail ? l2Detail.responseHash : null;
  const missingKeys = l2Status === "mismatch" && l2Detail ? [...l2Detail.missing].sort() : null;
  const diffHash =
    l2Status === "mismatch" && l2Detail
      ? sha256(JSON.stringify({ declaration_hash: declarationHash, response_hash: l2Detail.responseHash, missing: missingKeys }))
      : null;

  const within = (days: number) => {
    const cutoff = Date.now() - days * 86_400_000;
    return probes.filter((p) => Date.parse(p.probedAt) >= cutoff);
  };
  const availability = (list: ProbeInput[]) => (list.length === 0 ? null : list.filter((p) => p.verdict === "pass").length / list.length);

  const { raw, real, test, uniquePayersReal } = input.settlements30d;
  const thirdPartyRaw = Math.max(0, raw - test);
  return {
    l0: {
      status: l0Status,
      observed_at: latestProbe?.probedAt ?? null,
      dialect: latestProbe && latestProbe.dialect && DIALECTS.has(latestProbe.dialect) ? (latestProbe.dialect as Dialect) : null,
      fail_reason: l0Status === "fail" ? (latestProbe?.failReason ?? null) : null,
    },
    l1: {
      n_delivered: delivered.length,
      n_settled: settled.length,
      n_attempts: signed.length,
      n_probe_error: probeErrors.length,
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      last_purchase_id:
        lastSettled && lastSettled.txHash && lastSettled.network
          ? toPurchaseId(toCaip2(lastSettled.network) ?? lastSettled.network, lastSettled.txHash)
          : null,
      observed_at: signed[0]?.attemptedAt ?? null,
      last_attempt_at: input.lastAttemptAt,
    },
    l2: {
      status: l2Status,
      declaration_hash: declarationHash,
      response_hash: responseHash,
      diff_hash: diffHash,
      missing_keys: missingKeys,
      observed_at: l2ObservedAt,
    },
    availability_7d: availability(within(7)),
    availability_30d: availability(within(30)),
    offer_stability: offerStabilityOf(probes),
    payees: input.payees,
    settlement_30d_real: real,
    settlement_30d_raw: raw,
    settlement_30d_test: test,
    unique_payers_30d_real: uniquePayersReal,
    wash_dominated: thirdPartyRaw >= WASH_DOMINATED_MIN_RAW && real <= thirdPartyRaw * WASH_DOMINATED_REAL_SHARE,
  };
}

/**
 * L2 の evidence（§6.3 / 2026-09-02 監査 P1-11）。conform / mismatch のときだけ。
 * 宣言・応答・差分のハッシュを載せる——第三者が同じ宣言・同じ本文から再計算できる。
 */
export function l2EvidenceOf(facts: SellerFacts, observatoryId: string): Evidence | null {
  if (facts.l2.status === "undeclared") return null;
  return {
    level: "L2",
    ...(facts.l1.last_purchase_id ? { purchase_id: facts.l1.last_purchase_id } : {}),
    url: `https://vet402.com/observatory/e/${observatoryId}`,
    declaration_hash: facts.l2.declaration_hash,
    response_hash: facts.l2.response_hash,
    diff_hash: facts.l2.diff_hash,
    missing_keys: facts.l2.missing_keys,
  };
}

export type SellerFactsLoaded = {
  facts: SellerFacts;
  /**
   * 最終試行の行（全履歴・status を問わない）。`at` は facts.l1.last_attempt_at と
   * 同じ値で、`status` は公開面には出さず `not_attempted_reason` の判別だけに使う
   * （生の status をそのまま出すと、我々の内部語彙が売り手の記録として読まれる）。
   */
  lastAttempt: { at: string | null; status: string | null };
  endpoint: {
    id: string;
    resourceId: string | null;
    endpointHash: string | null;
    canonicalUrl: string;
    method: string;
    payTo: string | null;
    network: string | null;
    payeeId: string | null;
  };
};

/** raw_response_meta.l2（l1-runner の checkL2Detailed の出力）。形が違えば null。 */
function parseL2Detail(v: unknown): PurchaseInput["l2Detail"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.responseHash !== "string") return null;
  return {
    missing: Array.isArray(o.missing) ? o.missing.filter((k): k is string => typeof k === "string") : [],
    declarationHash: typeof o.declarationHash === "string" ? o.declarationHash : null,
    responseHash: o.responseHash,
  };
}

/** endpoint uuid から 30 日分の事実を組む。無ければ null。 */
export async function loadSellerFacts(endpointUuid: string): Promise<SellerFactsLoaded | null> {
  const db = getDb();
  if (!db) return null;
  const eps = rowsOf<{
    id: string;
    resource_id: string | null;
    endpoint_hash: string | null;
    canonical_url: string;
    method: string;
    pay_to: string | null;
    network: string | null;
    payee_id: string | null;
    declared_schema: unknown | null;
  }>(
    await db.execute(sql`
      SELECT id::text AS id, resource_id, endpoint_hash, coalesce(canonical_url, resource_url) AS canonical_url,
             coalesce(method, 'GET') AS method, pay_to, network, payee_id, declared_schema
      FROM x402_endpoints WHERE id = ${endpointUuid}::uuid LIMIT 1
    `),
  );
  const ep = eps[0];
  if (!ep) return null;

  const probes = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT probed_at::text AS probed_at, verdict, dialect, fail_reason, price_consistent, metadata_consistent
      FROM x402_l0_probes WHERE endpoint_id = ${endpointUuid}::uuid AND probed_at > now() - interval '30 days'
      ORDER BY probed_at DESC LIMIT 200
    `),
  ).map<ProbeInput>((r) => ({
    probedAt: String(r.probed_at),
    verdict: String(r.verdict),
    dialect: r.dialect === null ? null : String(r.dialect),
    failReason: r.fail_reason === null ? null : String(r.fail_reason),
    // 封筒の価格・受取先はプローブ行に個別保存していないので、カタログ宣言との
    // 一致（price_consistent / metadata_consistent）を offer_stability の材料にする。
    // 一致していれば宣言と同じ、一致していなければ「変わった」とみなす。
    priceAmount: r.price_consistent === false ? "changed" : "declared",
    priceAsset: null,
    payTo: r.metadata_consistent === false ? "changed" : "declared",
  }));

  const purchases = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT attempted_at::text AS attempted_at, status, latency_ms, http_status_paid, payload_non_empty, l2_schema, tx_hash, network,
             raw_response_meta->'l2' AS l2_detail
      FROM x402_l1_purchases WHERE endpoint_id = ${endpointUuid}::uuid AND attempted_at > now() - interval '30 days'
      ORDER BY attempted_at DESC LIMIT 200
    `),
  ).map<PurchaseInput>((r) => ({
    attemptedAt: String(r.attempted_at),
    status: String(r.status),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    httpStatusPaid: r.http_status_paid === null ? null : Number(r.http_status_paid),
    payloadNonEmpty: r.payload_non_empty === null ? null : Boolean(r.payload_non_empty),
    l2Schema: r.l2_schema === null ? null : String(r.l2_schema),
    txHash: r.tx_hash === null ? null : String(r.tx_hash),
    network: r.network === null ? null : String(r.network),
    l2Detail: parseL2Detail(r.l2_detail),
  }));

  // 最終試行は 30 日窓の外も見る（窓で切ると 31 日前の試行が「一度も無い」に化ける）。
  // status を問わないので、署名前に終わった行（no_eligible_accept / over_cap /
  // halted …）でも時刻が立つ。endpoint_id の索引で 1 行取るだけ。
  const lastAttemptRows = rowsOf<{ attempted_at: string | null; status: string | null }>(
    await db.execute(sql`
      SELECT attempted_at::text AS attempted_at, status
      FROM x402_l1_purchases WHERE endpoint_id = ${endpointUuid}::uuid
      ORDER BY attempted_at DESC LIMIT 1
    `),
  );
  const lastAttempt = {
    // ::text は "2026-09-04 19:02:29.789686+00" を返す。公開面は ISO8601 UTC で出す
    // （payOrRefuse がこの時刻を拒否理由の文面へそのまま載せる）。
    at: toIsoUtc(lastAttemptRows[0]?.attempted_at ?? null),
    status: lastAttemptRows[0]?.status ?? null,
  };

  const settlements30d = await getSettlementCounts({ endpointId: endpointUuid });
  const facts = assembleSellerFacts({
    probes,
    purchases,
    settlements30d,
    payees: ep.payee_id ? [ep.payee_id] : [],
    declaredSchema: ep.declared_schema ?? null,
    lastAttemptAt: lastAttempt.at,
  });
  return {
    facts,
    lastAttempt,
    endpoint: {
      id: ep.id,
      resourceId: ep.resource_id,
      endpointHash: ep.endpoint_hash,
      canonicalUrl: ep.canonical_url,
      method: ep.method,
      payTo: ep.pay_to,
      network: ep.network,
      payeeId: ep.payee_id,
    },
  };
}

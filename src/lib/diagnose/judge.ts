// 402 を検査して ALLOW / WARN / BLOCK のどれか一つを返す。新しい判定語は作らない。
import {
  assetRelation,
  atomicAmountOk,
  canonicalNetwork,
  isKnownMainnet,
  isKnownTestnet,
  isSolanaNetwork,
  needsAccountReadiness,
  payToOk,
  pinnedAssetFor,
  READABLE_SCHEMES,
  RLUSD_ISSUER,
  solanaFeePayerOk,
  usdAtomic,
} from "./assets";
import {
  CHECK_IDS,
  fixFor,
  SKIP_CATALOG,
  SKIP_NOT_402,
  SKIP_READINESS,
  SKIP_READINESS_UNREAD,
  SKIP_SOLANA,
  SKIP_UNREADABLE,
  type CheckId,
  type CheckStatus,
  type Verdict,
} from "./copy";
import { challengeFinger, decodeHeader, parseChallengeText, resourceUrls, sameResource, type ParsedAccept, type ParsedChallenge } from "./parse";
import type { Readiness } from "./readiness";

export type RecommendedAccept = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  usd_atomic: string;
};

export type DiagnoseCheck = { id: CheckId; status: CheckStatus; fix: string };
export type NotChecked = { id: string; reason: string };

export type DiagnoseCatalog = { listed: boolean; check_url: string | null };

export type DiagnoseBody = {
  verdict: Verdict;
  recommended_accept: RecommendedAccept | null;
  checks: DiagnoseCheck[];
  checked: CheckId[];
  not_checked: NotChecked[];
  as_of: string;
  catalog: DiagnoseCatalog | null;
  http_status: number | null;
};

export type JudgeInput = {
  requestedUrl: string;
  method: "GET" | "POST";
  httpStatus: number | null;
  headers: Headers;
  bodyText: string;
  now: Date;
  catalog: DiagnoseCatalog | null;
  readiness?: Record<string, Readiness>;
};

const CAIP_RE = /^[a-z0-9]{3,8}:[^\s:]{1,128}$/;

function feePayerOf(accept: ParsedAccept): string | null {
  const value = accept.extra?.feePayer;
  return typeof value === "string" ? value : null;
}

function issuerOf(accept: ParsedAccept): string | null {
  const value = accept.extra?.issuer;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("info")) return "info";
  return "pass";
}

function networkStatus(accept: ParsedAccept): CheckStatus {
  if (!accept.network) return "fail";
  const caip = canonicalNetwork(accept.network);
  if (!isKnownMainnet(accept.network) && !isKnownTestnet(accept.network)) return "fail";
  if (caip !== accept.network || !CAIP_RE.test(accept.network)) return "warn";
  return "pass";
}

function assetStatus(accept: ParsedAccept): CheckStatus {
  const relation = assetRelation(accept.network, accept.asset);
  if (relation === "mixup") return "fail";
  if (relation === "unknown") return "warn";
  if (canonicalNetwork(accept.network) === "xrpl:0") {
    const issuer = issuerOf(accept);
    if (!issuer) return "warn";
    if (issuer !== RLUSD_ISSUER) return "fail";
  }
  return "pass";
}

function schemeStatus(accept: ParsedAccept): CheckStatus {
  if (!accept.scheme) return "fail";
  if (READABLE_SCHEMES.has(accept.scheme.toLowerCase())) return "pass";
  return "info";
}

function solanaStatus(accept: ParsedAccept): CheckStatus {
  return solanaFeePayerOk(accept.payTo, feePayerOf(accept)) ? "pass" : "fail";
}

function testnetStatus(accepts: ParsedAccept[]): CheckStatus {
  const testnets = accepts.filter((accept) => isKnownTestnet(accept.network)).length;
  if (testnets === 0) return "pass";
  if (testnets === accepts.length) return "fail";
  return "warn";
}

function headerChallenge(headers: Headers): { present: boolean; parsed: ParsedChallenge | null } {
  const raw = headers.get("payment-required");
  if (raw === null || raw.trim() === "") return { present: false, parsed: null };
  const text = decodeHeader(raw);
  return { present: true, parsed: text ? parseChallengeText(text) : null };
}

function headerBodyStatus(bodyText: string, body: ParsedChallenge | null, header: { present: boolean; parsed: ParsedChallenge | null }): CheckStatus {
  if (!header.present) return "pass";
  if (!header.parsed?.versionOk) return "fail";
  if (bodyText.trim() === "") return "pass";
  // A body with no accepts (for example {"error":"..."}) is not a second challenge to compare.
  if (!body || body.accepts.length === 0) return "pass";
  if (!body.versionOk) return "fail";
  return challengeFinger(body) === challengeFinger(header.parsed) ? "pass" : "fail";
}

function resourceStatus(challenge: ParsedChallenge, requestedUrl: string): CheckStatus {
  const urls = resourceUrls(challenge);
  if (urls.length === 0) return "warn";
  return urls.every((url) => sameResource(url, requestedUrl)) ? "pass" : "fail";
}

function payable(accept: ParsedAccept, requestedUrl: string, readiness: Record<string, Readiness> | undefined): boolean {
  if (!READABLE_SCHEMES.has(accept.scheme.toLowerCase())) return false;
  if (!atomicAmountOk(accept.amount)) return false;
  if (!isKnownMainnet(accept.network)) return false;
  if (assetStatus(accept) !== "pass") return false;
  if (!payToOk(accept.network, accept.payTo)) return false;
  if (isSolanaNetwork(accept.network) && !solanaFeePayerOk(accept.payTo, feePayerOf(accept))) return false;
  if (accept.resource && !sameResource(accept.resource, requestedUrl)) return false;
  if (needsAccountReadiness(accept.network)) {
    const value = readiness?.[accept.payTo];
    if (value === "inactive" || value === "no_trustline") return false;
  }
  return true;
}

function recommend(accepts: ParsedAccept[]): RecommendedAccept | null {
  let best: { accept: ParsedAccept; usd: bigint } | null = null;
  for (const accept of accepts) {
    const pin = pinnedAssetFor(accept.network, accept.asset);
    if (!pin) continue;
    const usd = usdAtomic(accept.amount, pin.decimals);
    if (usd === null) continue;
    const value = BigInt(usd);
    if (!best || value < best.usd || (value === best.usd && accept.index < best.accept.index)) {
      best = { accept, usd: value };
    }
  }
  if (!best) return null;
  const usd = usdAtomic(best.accept.amount, pinnedAssetFor(best.accept.network, best.accept.asset)!.decimals)!;
  return {
    scheme: best.accept.scheme,
    network: best.accept.network,
    asset: best.accept.asset,
    amount: best.accept.amount,
    payTo: best.accept.payTo,
    usd_atomic: usd,
  };
}

function row(id: CheckId, status: CheckStatus): DiagnoseCheck {
  return { id, status, fix: fixFor(id, status) };
}

function skipped(ids: readonly CheckId[], reason: string): NotChecked[] {
  return ids.map((id) => ({ id, reason }));
}

function catalogRow(catalog: DiagnoseCatalog | null): NotChecked[] {
  return catalog === null ? [{ id: "catalog", reason: SKIP_CATALOG }] : [];
}

function bodyOf(input: JudgeInput, checks: DiagnoseCheck[], notChecked: NotChecked[], recommended: RecommendedAccept | null): DiagnoseBody {
  const dirty = checks.some((check) => check.status !== "pass") || notChecked.some((item) => item.id === "account_readiness" && item.reason === SKIP_READINESS_UNREAD);
  const verdict: Verdict = recommended === null ? "BLOCK" : dirty ? "WARN" : "ALLOW";
  return {
    verdict,
    recommended_accept: recommended,
    checks,
    checked: checks.map((check) => check.id),
    not_checked: notChecked,
    as_of: input.now.toISOString(),
    catalog: input.catalog,
    http_status: input.httpStatus,
  };
}

const AFTER_402: CheckId[] = CHECK_IDS.filter((id) => id !== "returns_402");
const AFTER_SHAPE: CheckId[] = CHECK_IDS.filter((id) => id !== "returns_402" && id !== "x402_shape");

export function judgeChallenge(input: JudgeInput): DiagnoseBody {
  if (input.httpStatus !== 402) {
    return bodyOf(
      input,
      [row("returns_402", "fail")],
      [...skipped(AFTER_402, SKIP_NOT_402), ...catalogRow(input.catalog)],
      null,
    );
  }

  const body = parseChallengeText(input.bodyText);
  const header = headerChallenge(input.headers);
  const chosen = body?.versionOk ? body : header.parsed?.versionOk ? header.parsed : null;
  if (!chosen) {
    return bodyOf(
      input,
      [row("returns_402", "pass"), row("x402_shape", "fail")],
      [...skipped(AFTER_SHAPE, SKIP_UNREADABLE), ...catalogRow(input.catalog)],
      null,
    );
  }

  const accepts = chosen.accepts;
  const solana = accepts.filter((accept) => isSolanaNetwork(accept.network));
  const readinessTargets = accepts.filter((accept) => needsAccountReadiness(accept.network));
  let readinessKind: "na" | "unread" | "pass" | "fail" = "na";
  if (readinessTargets.length > 0) {
    let fail = false;
    let unread = false;
    for (const accept of readinessTargets) {
      const value = input.readiness?.[accept.payTo];
      if (value === "inactive" || value === "no_trustline") fail = true;
      else if (value !== "ready") unread = true;
    }
    readinessKind = fail ? "fail" : unread ? "unread" : "pass";
  }

  const headerStatus = headerBodyStatus(input.bodyText, body, header);
  const resource = resourceStatus(chosen, input.requestedUrl);
  const conflict = headerStatus === "fail" || resource === "fail";
  const candidates = conflict ? [] : accepts.filter((accept) => payable(accept, input.requestedUrl, input.readiness));
  const recommended = recommend(candidates);

  const checks: DiagnoseCheck[] = [
    row("returns_402", "pass"),
    row("x402_shape", "pass"),
    row("header_body", headerStatus),
    row("resource_url", resource),
    row("amount_atomic", worst(accepts.map((accept) => (atomicAmountOk(accept.amount) ? "pass" : "fail")))),
    row("network_caip2", worst(accepts.map(networkStatus))),
    row("asset_usdc", worst(accepts.map(assetStatus))),
    row("payto", worst(accepts.map((accept) => (payToOk(accept.network, accept.payTo) ? "pass" : "fail")))),
    row("testnet_only", testnetStatus(accepts)),
    row("scheme", worst(accepts.map(schemeStatus))),
  ];
  const notChecked: NotChecked[] = [];
  if (solana.length === 0) notChecked.push({ id: "solana_fee_payer", reason: SKIP_SOLANA });
  else checks.push(row("solana_fee_payer", worst(solana.map(solanaStatus))));
  if (readinessKind === "na") notChecked.push({ id: "account_readiness", reason: SKIP_READINESS });
  else if (readinessKind === "unread") notChecked.push({ id: "account_readiness", reason: SKIP_READINESS_UNREAD });
  else checks.push(row("account_readiness", readinessKind));
  notChecked.push(...catalogRow(input.catalog));

  return bodyOf(input, checks, notChecked, recommended);
}

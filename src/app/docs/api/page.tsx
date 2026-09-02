import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import TrackView from "@/components/site/TrackView";
import TrackedLink from "@/components/site/TrackedLink";
import CodeBlock from "@/components/docs/CodeBlock";
import { TryItPanel } from "@/components/docs/TryItPanel";
import DocsToc, { type TocItem } from "@/components/docs/DocsToc";
import { TableScroll } from "@/components/site/TableScroll";
import { SITE_URL } from "@/lib/site-url";
import { pageMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { safeJsonLd } from "@/lib/util/json-ld";

// 2026-08-13 UX監査2巡目 [m2]: このページには metadata が無く、layout の
// default（LP と同じ長い表題）をそのまま名乗っていた。template "%s | vet402"
// が効くので、ここは接尾辞なしの固有名だけを書く。
// 2026-08-14: openGraph/twitter/canonical を pageMetadata で個別化。
export const metadata: Metadata = pageMetadata({
  title: "API reference",
  description:
    "REST v1 reference for vet402: score a payee before paying it, register a verified payee, read the public accuracy ledger. Includes a key-less curl quickstart, rate limits, webhooks and error codes.",
  path: "/docs/api",
});

type Endpoint = {
  method: "GET" | "POST";
  path: string;
  note: string;
  request?: string;
  response: string;
};

const endpoints: Endpoint[] = [
  {
    method: "GET",
    path: "/api/v1/agents/:agentId/score",
    note: "Score by ERC-8004 agent ID. Pass ?wallet=0x... to verify the agent's registered wallet.",
    response: `{
  "agentId": "42",
  "wallet": "0x1234...",
  "trustScore": 78,
  "recommendation": "ALLOW",
  "signals": { "identity": {...}, "reputation": {...}, "wallet": {...}, "x402": {...}, "sybil": {...}, "manual": {...} },
  "breakdown": {
    "components": {
      "identity":   { "score": 100, "weight": 0.05, "contribution": 6.25 },
      "reputation": { "score": 66,  "weight": 0.10, "contribution": 8.25 },
      "wallet":     { "score": 75,  "weight": 0.25, "contribution": 23.44 },
      "x402":       { "score": 83,  "weight": 0.40, "contribution": 41.5 }
    },
    "weightedSubtotal": 79,
    "sybilPenalty": 0,
    "prePolicyScore": 79
  },
  "scoredAt": "2026-07-14T00:00:00Z",
  "cacheExpiresAt": "2026-07-14T00:05:00Z",
  "disclaimer": "Scores are informational only and do not constitute a guarantee, credit assessment, or investment advice."
}`,
  },
  {
    method: "GET",
    path: "/api/v1/wallets/:address/score",
    note: "Score by wallet address. Primary integration path for x402 API middleware.",
    response: `{
  "agentId": "0",
  "wallet": "0x1234...",
  "trustScore": 61,
  "recommendation": "WARN",
  "signals": { ... },
  "scoredAt": "2026-07-14T00:00:00Z",
  "cacheExpiresAt": "2026-07-14T00:05:00Z",
  "disclaimer": "Scores are informational only and do not constitute a guarantee, credit assessment, or investment advice."
}`,
  },
  {
    // 2026-08-13 [M6]: 買い手側の主要エンドポイントが docs のどこにも無く、
    // /payee/:address が出している数字の出所を読者が辿れなかった。
    method: "GET",
    path: "/api/v1/payees/:address/score",
    note: "Buyer-side screening: should my agent pay this wallet? Never 404s for an unfamiliar wallet — a wallet with no history returns 200 with dataDepth \"thin\" so you can weigh the confidence yourself. See Payee score below for the composition.",
    response: `{
  "payee": "0x1234...",
  "score": 52,
  "recommendation": "WARN",
  "dataDepth": "thin",
  "degraded": false,
  "signals": { "receiving": {...}, "walletHealth": {...}, "drainPattern": {...}, "outcomeHistory": {...}, "flags": [...] },
  "scoredAt": "2026-08-13T00:00:00Z",
  "cacheExpiresAt": "2026-08-13T00:05:00Z",
  "disclaimer": "Scores are informational only … it is not an identity or legal-standing check."
}`,
  },
  {
    method: "POST",
    path: "/api/v1/scores/batch",
    note: "Score up to 25 agents in a single request.",
    request: `{
  "agents": [
    { "agentId": "1" },
    { "agentId": "2", "wallet": "0x..." }
  ]
}`,
    response: `{
  "results": [
    { "agentId": "1", "trustScore": 78, "recommendation": "ALLOW", ... },
    { "agentId": "2", "error": "invalid_agent_id" }
  ]
}`,
  },
  {
    method: "POST",
    path: "/api/v1/payments/x402",
    note: "Attest an x402 payment settlement after payment verification. Idempotent on txHash.",
    request: `{
  "wallet": "0xpayer...",
  "txHash": "0xabc...",
  "amount": "1000000",
  "network": "base",
  "resource": "/api/premium/data"
}`,
    response: `// 201 Created (first attestation)
// 200 OK (already recorded — idempotent replay on txHash)
{
  "ok": true,
  "created": true,
  "id": "b3f1...",
  "wallet": "0xpayer...",
  "txHash": "0xabc..."
}`,
  },
  {
    method: "GET",
    path: "/api/v1/agents/:agentId/history",
    note: "Score history snapshots. Requires Pro or Scale plan. Supports ?limit= (1-100, default 20).",
    response: `{
  "agentId": "42",
  "history": [
    { "trustScore": 78, "recommendation": "ALLOW", "scoredAt": "2026-07-13T00:00:00Z", ... },
    { "trustScore": 74, "recommendation": "ALLOW", "scoredAt": "2026-07-12T00:00:00Z", ... }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/v1/watchlist",
    note: "List your watched targets (max 50 per key). POST {targetType, target, chainId?} to add; DELETE /api/v1/watchlist/:id to remove. A daily cron re-scores entries and fires the watch.verdict_changed webhook only when the recommendation changes (score jitter without a verdict change is stored but not pushed).",
    response: `{
  "watchlist": [
    { "id": "…", "targetType": "wallet", "target": "0x…", "chainId": 8453,
      "lastScore": 74, "lastRecommendation": "ALLOW", "lastCheckedAt": "2026-08-05T06:30:00Z" }
  ]
}`,
  },
  {
    method: "POST",
    path: "/api/v1/webhooks",
    note: "Register a webhook endpoint (max 5 per key). The signing secret is returned ONCE — store it. events must be a non-empty subset of the events list below. URL must be https to a public host (SSRF-guarded at registration AND at every delivery). GET /api/v1/webhooks lists your endpoints (secrets never returned); DELETE /api/v1/webhooks/:id removes one.",
    request: `{
  "url": "https://your-host.example/vouch-hook",
  "events": ["watch.verdict_changed", "outcome.recorded"]
}`,
    response: `// 201 Created — secret shown once
{
  "id": "…",
  "url": "https://your-host.example/vouch-hook",
  "events": ["watch.verdict_changed", "outcome.recorded"],
  "secret": "whsec_…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/payees/verify?wallet=0x…&name=Acme+API",
    note: "Preview the exact canonical message for a (wallet, name) pair before signing — no API key. Pass url= as well when the profile will include a link; that URL is bound into the signature. The same message is echoed back in a failed POST's expectedMessage field.",
    response: `{ "message": "Vouch verified payee registration\\nwallet: 0x…\\nname: Acme API\\nThis signature only proves control of the wallet above." }`,
  },
  {
    method: "POST",
    path: "/api/v1/payees/verify",
    note: "Verified payee registration — free, no API key. Sign the canonical message above (fetch it via GET on this same path, including url= when you will send one) with the payee wallet; a valid signature proves control and publishes /payee/:address plus an embeddable badge at /api/badge/:address. Verification proves wallet control only; scores stay independent.",
    request: `{ "wallet": "0x…", "name": "Acme API", "url": "https://…", "signature": "0x…" }`,
    response: `{ "ok": true, "profile": "/payee/0x…", "badge": "/api/badge/0x…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/agents/verify?agentId=42&name=Acme+Agent",
    note: "Agent-side twin of payee verify. Preview the exact canonical message to sign for (agentId, name) — no API key. The agent's on-chain wallet is resolved and returned so you sign with the right key.",
    response: `{ "agentId": "42", "wallet": "0x…", "message": "Vouch agent passport registration\\nagentId: 42\\nwallet: 0x…\\nname: Acme Agent\\nThis signature only proves control of the wallet above." }`,
  },
  {
    method: "POST",
    path: "/api/v1/agents/verify",
    note: "Trust-passport registration — free, no API key. Sign the canonical message above with the agent's on-chain wallet (getAgentWallet(agentId)); a valid signature plus the on-chain wallet binding proves control of the agent identity and publishes /agent/:agentId, a machine-readable passport at /api/v1/agents/:agentId/passport, and a badge at /api/badge/agent/:agentId.",
    request: `{ "agentId": "42", "name": "Acme Agent", "url": "https://…", "signature": "0x…" }`,
    response: `{ "ok": true, "agentId": "42", "wallet": "0x…", "profile": "/agent/42", "badge": "/api/badge/agent/42" }`,
  },
  {
    method: "GET",
    path: "/api/v1/agents/42/passport",
    note: "The portable, third-party-verifiable passport — no API key. Returns the signed identity claim, the verification material (canonical message + signature, so any counterparty can re-run verifyMessage and cross-check the wallet against getAgentWallet on-chain), and a live score with explicit freshness (scoredAt / cacheExpiresAt).",
    response: `{ "agentId": "42", "verified": true, "identity": { "name": "Acme Agent", "wallet": "0x…", "proof": { "message": "…", "signature": "0x…", "scheme": "eip191-personal-sign" } }, "score": { "trustScore": 78, "recommendation": "ALLOW", "x402": { "paymentCount": 12, "uniqueDays": 6 }, "scoredAt": "…", "cacheExpiresAt": "…" } }`,
  },
  // ------------------------------------------------------------------
  // 製品定義書 §7.3 / §9.1（2026-09-02）。監査 P1-13: 本番で動いている 9 ルートが
  // このページに 0 件だった。tests/docs-surface-parity.test.ts が網羅を検査する。
  // ------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/resolve?q=…",
    note: "Reverse lookup — no key, 60/min. q is read by shape: a URL gives its Resource (resource_id = sha256(method + \" \" + canonical_url)) and the endpoints on that host; a domain its endpoints; a 0x / base58 address or a chain:address payee_id the endpoints that declare it as payTo; a tx hash the indexed settlement and, when attributed, its resource. Identifiers only — never a recommendation. A q the classifier cannot place is a 400 { error: \"invalid_query\", expected: \"q\", query: { kind: \"unknown\", value } }.",
    response: `{
  "query": { "kind": "url", "value": "https://api.example.com/v1/quote" },
  "resource": { "endpoint_id": "3f1c…", "resource_id": "9a7e…", "observatory_id": "521e929e-…", "canonical_url": "https://api.example.com/v1/quote", "method": "GET", "payee_id": "eip155:8453:0x…", "catalog_status": "listed", "first_seen": "…", "last_seen": "…" },
  "endpoints": [ { "endpoint_id": "3f1c…", … } ],
  "disclaimer": "Scores are opinions; L0–L2 are measurement records. …"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/resources/:resourceId",
    note: "One Resource by resource_id (sha256 hex) — no key, 120/min. The record, the payees that resources under it declare, and links to /decision, /facts and the observatory page. 400 invalid_resource_id, 404 not_found.",
    response: `{
  "resource": { "endpoint_id": "3f1c…", "resource_id": "9a7e…", "observatory_id": "521e929e-…", "canonical_url": "…", "method": "GET", "payee_id": "eip155:8453:0x…", "catalog_status": "listed", "first_seen": "…", "last_seen": "…" },
  "payees": [ { "payee_id": "eip155:8453:0x…", "endpoints": 1 } ],
  "links": { "decision": "/api/v1/resources/9a7e…/decision?role=payer", "facts": "/api/v1/observatory/endpoints/521e929e-…/facts", "observatory": "/observatory/e/521e929e-…" },
  "disclaimer": "…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/resources/:resourceId/decision?role=payer|payee&payer=…&caller_dialect=v1|v2&allow_without_l1=false",
    note: "The canonical integration since 2026-09-02 (spec §8.3 / §9.1) — key required, 1 unit per call. role=payer (default) answers \"does this URL deliver as declared, right now?\" from L0 liveness, L1 settle-through and L2 conformance; role=payee answers \"should this seller serve this payer?\" and requires payer. facts and recommendation always arrive in the same document; the transitional score is marked deprecated and is not the basis of the recommendation. Send Idempotency-Key to retry without spending a second unit. 400 invalid_resource_id / invalid_role / invalid_caller_dialect / payer_required, 404 not_found, 503 decision_unavailable.",
    response: `{
  "subject": { "type": "resource", "id": "9a7e…", "endpoint_id": "3f1c…", "observatory_id": "521e929e-…", "canonical_url": "…", "method": "GET" },
  "role": "payer",
  "payer": null,
  "recommendation": "ALLOW",
  "reason_codes": ["l0_pass", "l1_delivered", "l2_undeclared"],
  "facts": {
    "l0": { "status": "pass", "observed_at": "…", "dialect": "v2", "fail_reason": null },
    "l1": { "n_delivered": 3, "n_settled": 3, "n_attempts": 3, "n_probe_error": 0, "p50_ms": 812, "p95_ms": 1490, "last_purchase_id": "…", "observed_at": "…" },
    "l2": { "status": "undeclared", "declaration_hash": null, "diff_hash": null, "observed_at": null },
    "availability_7d": 1, "availability_30d": 0.97, "offer_stability": "stable",
    "payees": ["eip155:8453:0x…"],
    "settlement_30d_real": 41, "settlement_30d_raw": 44, "settlement_30d_test": 3,
    "unique_payers_30d_real": 9, "wash_dominated": false
  },
  "freshness": { "l0": "…", "l1": "…", "l2": null },
  "evidence": [ { "level": "L0", "url": "https://vet402.com/observatory/e/521e929e-…" }, { "level": "L1", "purchase_id": "…", "url": "https://vet402.com/api/v1/observatory/endpoints/521e929e-…/purchases" } ],
  "score": { "trustScore": 74, "recommendation": "ALLOW", "deprecated": true },
  "degraded": false,
  "policy": "allow_only",
  "rules_version": "…",
  "registry": { "status": "off", "tx_hash": null },
  "scoredAt": "…", "cacheExpiresAt": "…",
  "disclaimer": "…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/endpoints/:endpointId",
    note: "One Endpoint by endpoint_id (sha256 of origin + path prefix) or its observatory uuid — no key, 120/min. Existing /observatory/e/{id} links keep resolving. 400 invalid_endpoint_id, 404 not_found.",
    response: `{
  "endpoint": { "endpoint_id": "3f1c…", "resource_id": "9a7e…", "observatory_id": "521e929e-…", "canonical_url": "…", "method": "GET", "payee_id": "eip155:8453:0x…", "catalog_status": "listed", "first_seen": "…", "last_seen": "…" },
  "payees": [ { "payee_id": "eip155:8453:0x…", "endpoints": 1 } ],
  "links": { "facts": "/api/v1/observatory/endpoints/521e929e-…/facts", "payees": "/api/v1/endpoints/3f1c…/payees", "observatory": "/observatory/e/521e929e-…" },
  "disclaimer": "…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/endpoints/:endpointId/payees",
    note: "endpoint → payees[] — no key, 120/min. Every payee_id (chain:address) declared by resources under the same endpoint_id, with how many resources name each.",
    response: `{ "endpoint_id": "3f1c…", "payees": [ { "payee_id": "eip155:8453:0x…", "endpoints": 2 } ], "count": 1, "disclaimer": "…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/payees/:address/endpoints",
    note: "payee → endpoints[] — no key, 120/min. :address is chain:address (EVM lowercased, Solana base58 as-is); a bare 0x address is read as Base, a bare base58 address as Solana mainnet. 400 invalid_payee_id.",
    response: `{ "payee_id": "eip155:8453:0x…", "endpoints": [ { "endpoint_id": "3f1c…", "canonical_url": "…", "method": "GET", "catalog_status": "listed", … } ], "count": 1, "disclaimer": "…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/endpoints/:id/facts",
    note: "L0–L2 seller facts for one endpoint — no key, 120/min. :id is the observatory uuid or the endpoint_id. The same facts object /decision carries, without the recommendation: this route contains no score and no verdict by design (§8.3). n_probe_error counts attempts where our own request was malformed, kept apart from the seller's non-delivery; settlement_30d_test is vet402's own measurement purchases, disclosed and excluded from the wash_dominated denominator.",
    response: `{
  "subject": { "type": "resource", "id": "9a7e…", "endpoint_id": "3f1c…", "observatory_id": "521e929e-…", "canonical_url": "…", "method": "GET" },
  "facts": { "l0": {…}, "l1": {…}, "l2": {…}, "availability_7d": 1, "availability_30d": 0.97, "offer_stability": "stable", "payees": ["…"], "settlement_30d_real": 41, "settlement_30d_raw": 44, "settlement_30d_test": 3, "unique_payers_30d_real": 9, "wash_dominated": false },
  "freshness": { "l0": "…", "l1": "…", "l2": null },
  "evidence": [ { "level": "L0", "url": "…" }, { "level": "L1", "purchase_id": "…", "url": "…" } ],
  "disclaimer": "…",
  "retrievedAt": "…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/census/summary?chain=eip155:8453&window=30d",
    note: "Settlement census — no key, 60/min, cached 5 minutes. settlements_raw counts every indexed x402-related settlement in the window; settlements_real excludes wash_flag self_deal / circular / test (including every wallet vet402 pays from). Both are always returned together and never merged. chain is CAIP-2 or a v1 slug (base, solana); omit for all chains. window is 7d or 30d. 400 invalid_window / invalid_chain.",
    response: `{
  "chain": "eip155:8453", "window": "30d",
  "settlements_raw": 980, "settlements_real": 520,
  "wash": { "self_deal": 12, "circular": 0, "test": 448 },
  "attribution": { "confirmed": 410, "probable": 70, "unmatched": 40 },
  "unique_payers_raw": 31, "unique_payers_real": 24, "unique_payees_real": 57,
  "endpoints_with_real_settlement": 61,
  "by_source": { "l1_purchase": 448, "payments_api": 2, "chain_index": 530 },
  "definition": "settlements_raw counts every indexed …",
  "disclaimer": "…",
  "retrievedAt": "…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/corrections?endpoint=…&limit=100",
    note: "The correction log as JSON — no key, 60/min. Every published verdict that later changed: dispute_remeasure (a seller's signed dispute triggered a re-measurement that overturned it), settlement_backfill (a claimed settlement was later confirmed or refuted on-chain), reverify. before / after are the published values; corrections unfavourable to vet402 are listed the same way and rows are never deleted. endpoint filters by observatory uuid; limit 1–500.",
    response: `{
  "corrections": [ { "id": "…", "subject_type": "endpoint", "subject_id": "521e929e-…", "level": "l0", "before": { "verdict": "fail" }, "after": { "verdict": "pass" }, "reason": "dispute_remeasure", "dispute_id": "…", "created_at": "…" } ],
  "definition": "Each row is a public verdict that changed after publication: …",
  "disclaimer": "…"
}`,
  },
];

// 2026-08-12 FIX-6: 各エンドポイントを目次から直接指せるようにする。
// これまで id は6つの <section> にしか無く、13エンドポイントは「Endpoints」1項目に
// 畳まれていた（モバイルで目的の仕様まで 3,059px = 3.8画面）。
function endpointId(ep: Endpoint): string {
  return `${ep.method}-${ep.path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// 2026-08-11: sticky 簡易目次の項目。リンク先の id は各 <section> と
// 各エンドポイントカードに付けてある。
const TOC: TocItem[] = [
  { href: "#quickstart", label: "Quickstart" },
  { href: "#packages", label: "Packages" },
  { href: "#verdicts", label: "Verdicts & thresholds" },
  { href: "#rate-limits", label: "Rate limits" },
  {
    href: "#endpoints",
    label: "Endpoints",
    children: endpoints.map((ep) => ({
      href: `#${endpointId(ep)}`,
      label: `${ep.method} ${ep.path.split("?")[0]}`,
    })),
  },
  {
    href: "#score-breakdown",
    label: "Score breakdown",
    children: [{ href: "#payee-score", label: "Payee score" }],
  },
  { href: "#webhooks", label: "Webhooks" },
  { href: "#availability", label: "Availability" },
  { href: "#error-codes", label: "Error codes" },
];

const errorCodes = [
  { status: "400", meaning: "Bad request", detail: "Malformed body/params (e.g. invalid wallet format, empty batch)." },
  { status: "401", meaning: "Unauthorized", detail: "Missing or invalid API key on the Authorization: Bearer header." },
  { status: "403", meaning: "Forbidden / plan upgrade required", detail: "e.g. score history on a plan below Pro." },
  { status: "429", meaning: "Rate limited", detail: `Two causes, told apart by the error string: "rate_limit_exceeded" is the monthly quota (retry next month), "rate_limited" is a one-minute IP throttle (retry after the reported seconds). See Two kinds of 429 above.` },
];

export default async function ApiDocsPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "API reference", path: "/docs/api" },
  ]);
  const article = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: "API reference",
    description:
      "REST v1 reference for vet402: score a payee before paying it, register a verified payee, read the public accuracy ledger.",
    url: `${SITE_URL}/docs/api`,
    author: { "@type": "Organization", name: "vet402", url: SITE_URL },
    publisher: { "@type": "Organization", name: "vet402", url: SITE_URL },
    inLanguage: "en",
  };

  return (
    // 2026-08-06 (320px persona audit A-5): `p-8` had no breakpoint, so a 320px
    // screen lost 64px to the page gutter alone — stacked with the card's px-4
    // and the <pre>'s p-3, the readable code column was 198px (62% of the
    // screen) and the longest response example needed 4.5 screen-widths of
    // horizontal scrubbing. The LP already uses the px-5/md:px-8 pattern; docs
    // was the outlier.
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      {/* 2026-08-06 growth: docs_view marks a visitor doing developer-grade
          evaluation — for an API product this is the aha-stage event in
          growth_ledger.py (the true value moment, a scored API call, happens
          server-side and never reaches Plausible). */}
      <TrackView event="docs_view" />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: safeJsonLd(article) }}
      />

      {/* 2026-08-11 UI監査5: このページはモバイル375pxで約21,000px の一枚岩で、
          「Webhooksの署名検証」を探す読者はスクロールし続ける以外の手段が無かった
          （見出しジャンプはスクリーンリーダー利用者にしか無い）。JSを足さずに
          済ませたいのでネイティブのアンカーだけで組む。header が sticky top-0 /
          h-14 なので、この帯は top-14、飛び先は scroll-mt-32（帯2本ぶん）。 */}
      <DocsToc items={TOC} />

      <article className="sheet mt-6 space-y-10">
        <div>
          <div className="doc-head">
            <div className="doc-head-col">
              <span>Independent Measurement</span>
              <span>Interface: REST v1</span>
              <span>
                {/* この頁のシアン1点。認証の形という事実。 */}
                Auth: <span className="text-signal">Bearer API key</span>
              </span>
            </div>
            <div className="doc-head-col">
              <span>vet402</span>
              <span>x402 Economy</span>
              <span>August 2026</span>
            </div>
          </div>

          <h1 className="doc-title mt-10">API reference</h1>
          <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />
        </div>

        <div className="space-y-3">
        <p className="text-brand">
          Authenticate with <code className="text-brand-deep">Authorization: Bearer</code>{" "}
          API key. Base URL:{" "}
          <code className="break-all text-brand-deep">{`${SITE_URL}/api/v1`}</code>
        </p>
        {/* 2026-08-12 FIX-4: 発行されるキーの形が docs のどこにも書いておらず、
            LP の MCP 例だけが `vk_...` という実在しない接頭辞を載せていた
            （実物は src/lib/db/api-keys.ts の `vouch_live_<48hex>`）。
            例を直すだけでなく、正しい形をここに1行置いて典拠にする。 */}
        <p className="text-sm text-brand">
          Keys look like{" "}
          <code className="text-brand-deep">vouch_live_…</code> — send them
          as{" "}
          <code className="text-brand-deep">
            Authorization: Bearer vouch_live_…
          </code>
          .
        </p>
        {/* 2026-08-13 監査是正 #3: 散文の旧名（Vouch）は vet402 へ統一したが、
            発行済みのキー接頭辞と webhook のヘッダ名は動いている連携を壊すので
            据え置いた。docs で名前が2つ出てくる理由をここで1行明示する。
            これが無いと「ドキュメントが古い」ようにしか読めない。 */}
        <p className="text-sm text-brand-lift">
          API keys and webhook headers retain the{" "}
          <code className="text-brand-deep">vouch_</code> /{" "}
          <code className="text-brand-deep">Vouch-</code> prefixes for backward
          compatibility.
        </p>
        <p className="text-sm text-brand-lift">
          Full machine-readable schema:{" "}
          {/* 2026-08-06 growth: openapi_click — pulling the machine-readable
              schema signals codegen/tooling-level integration intent, deeper
              than reading the human docs. */}
          <TrackedLink
            href="/openapi.yaml"
            event="openapi_click"
            className="underline"
          >
            <code className="text-brand-deep">/openapi.yaml</code>
          </TrackedLink>{" "}
          (also on{" "}
          <TrackedLink
            href="https://github.com/kzmttkc/vet402/blob/main/docs/openapi.yaml"
            event="openapi_click_github"
            className="underline"
          >
            GitHub
          </TrackedLink>
          ).
        </p>
      </div>

      {/* 2026-08-13 UX監査2巡目 [M2]: このページは「Authenticate with Bearer …」
          から始まっていたので、評価しに来た開発者が最初に踏む段が「アカウントを
          作る」だった。鍵無しで叩ける公開パスは実在するのに、それが 13 本の
          エンドポイント表の中ほどに埋まっていて入口として使えていない。
          先頭に、コピーして即動く curl を3本置く。
          下の2本は 2026-08-13 に本番 (vet402.com) で実行して応答を確認済み。 */}
      <section id="quickstart" className="scroll-mt-32 space-y-3">
        <h2 className="sec-head">Quickstart</h2>
        <p className="text-sm text-brand">
          The first three need no account, no key and no signature &mdash; paste them into a
          terminal as they are. The first one returns real on-chain receipts.
        </p>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            1 &mdash; What happened when we actually paid an endpoint (no key)
          </p>
          <CodeBlock
            label="curl: read an endpoint's real purchase receipts"
            code={`curl "${SITE_URL}/api/v1/observatory/endpoints/521e929e-5f89-4603-a964-d1812caf118f/purchases"`}
          />
          <TryItPanel
            path="/api/v1/observatory/endpoints/521e929e-5f89-4603-a964-d1812caf118f/purchases"
            label="GET /api/v1/observatory/endpoints/{id}/purchases"
          />
          <p className="mt-1 text-sm text-brand-lift">
            n paid attempts, m settled, each settled row carrying its on-chain{" "}
            <code className="text-brand-deep">txHash</code>. This is the record vet402 exists to
            keep. Swap the id for any endpoint on{" "}
            <Link href="/observatory" className="doc-link">
              the observatory
            </Link>
            .
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            2 &mdash; The public accuracy ledger (no key)
          </p>
          <CodeBlock
            label="curl: read the public accuracy ledger"
            code={`curl "${SITE_URL}/api/v1/accuracy"`}
          />
          <TryItPanel path="/api/v1/accuracy" label="GET /api/v1/accuracy" />
          <p className="mt-1 text-sm text-brand-lift">
            Aggregate counts only. The same numbers{" "}
            <Link href="/accuracy" className="doc-link">
              /accuracy
            </Link>{" "}
            renders, including the operator benchmark.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            3 &mdash; The exact message a payee has to sign (no key)
          </p>
          <CodeBlock
            label="curl: preview the canonical payee-verify message"
            code={`curl "${SITE_URL}/api/v1/payees/verify?wallet=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&name=Acme%20API"`}
          />
          <TryItPanel
            path="/api/v1/payees/verify?wallet=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&name=Acme%20API"
            label="GET /api/v1/payees/verify"
          />
          <p className="mt-1 text-sm text-brand-lift">
            Returns{" "}
            <code className="text-brand-deep">{`{ "message": "…" }`}</code> &mdash; sign it with
            that wallet and POST it back to the same path to publish a verified-payee page and a
            badge. Read-only; nothing is written.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            4 &mdash; Score a payee before paying it (key required)
          </p>
          <CodeBlock
            label="curl: score a payee wallet"
            code={`curl -H "Authorization: Bearer vouch_live_…" \\
  "${SITE_URL}/api/v1/payees/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/score"`}
          />
          <p className="mt-1 text-sm text-brand-lift">
            The buyer-side question.{" "}
            <Link href="/signup" className="doc-link">
              Get a key
            </Link>{" "}
            &mdash; the free tier is 1,000 lookups a month.
          </p>
        </div>

        {/* 2026-08-14 UX（ハッカソン/YC ペルソナ）: 鍵無しで叩ける
            GET /api/demo/score を「任意アドレスを採点するデモ」と読み、「何を
            入れても同じ数字が返る」と報告された。この口は仕様として固定エージェント
            （DEMO_AGENT_ID）を1体だけライブ採点する——リクエストの中身は採点対象を
            選ばない（openapi.yaml にも明記）。その事実と、任意アドレスの照会先を
            1文で示して誤解を消す。 */}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
            Note &mdash; the key-less demo scorer
          </p>
          <TryItPanel path="/api/demo/score" label="GET /api/demo/score" />
          <p className="mt-2 text-sm text-brand-lift">
            <code className="text-brand-deep">GET /api/demo/score</code> scores one fixed demo
            agent chosen server-side, so anyone can watch a real verdict get computed without a
            key. Nothing in the request selects what it scores &mdash; it is a demo, not a free
            lookup, so it returns the same agent whatever you pass it. To score an address{" "}
            <em>you</em> choose, open{" "}
            <Link href="/payee" className="doc-link">
              /payee
            </Link>{" "}
            or call the payee-score endpoint above (example 4).
          </p>
        </div>
      </section>

      {/* 2026-08-13 UX監査R1 [C4]: 3つのパッケージは npm に公開済み（いずれも
          0.1.0）なのに、サイト全体で "npm" の文字が0件だった。LP は「middleware
          package」と書き、docs は REST しか説明していないので、SDK を入れて
          試したい読者の導線が1本も無い。さらに npm には無関係の別ベンダーの
          `vouch-sdk` / `@getvouch/sdk` が実在するため、スコープ付きの正確な
          名前を名指しする必要がある（打ち間違いの行き先が他人のコードになる）。 */}
      <section id="packages" className="scroll-mt-32 space-y-3">
        <h2 className="sec-head">Packages</h2>
        <p className="text-sm text-brand">
          Three published packages, all from{" "}
          <a
            href="https://github.com/kzmttkc/vet402"
            target="_blank"
            rel="noopener noreferrer"
            className="doc-link"
          >
            this repository
          </a>
          . They wrap the same REST API documented below &mdash; nothing here is available to a
          package that is not available to a plain <code>fetch</code>.
        </p>
        <CodeBlock
          label="npm: install the vet402 packages"
          code={`npm i @vet402/sdk          # spend guard for an agent about to pay
npm i @vet402/middleware   # x402 request gate for an API provider
npm i @vet402/mcp-server   # MCP tool, so an agent can ask before it pays`}
        />
        <p className="text-sm text-brand-lift">
          <code className="text-brand-deep">@vet402/*</code> is the canonical scope.{" "}
          <code className="text-brand-deep">@vouchscore/*</code> is the old name (the product
          was called Vouch until August 2026) and is published by the same account &mdash; the
          same code, kept only so existing installs keep resolving. Unscoped{" "}
          <code>vouch-sdk</code> and <code>@getvouch/sdk</code> exist on npm and are unrelated
          packages by other publishers &mdash; installing those gets you someone else&apos;s code,
          not ours.
        </p>

        {/* 2026-08-13 UX監査R2: 前回のC4修正で `npm i` の行は載ったが、サイト全体を
            通して `import` を含む SDK の使用例が1件も無かった（docs の <pre> 24個の
            うち JS は webhook の HMAC 検証だけ）。「30分でデモに組み込めるか」を
            計測したペルソナは、インストール行の次に何を書けばいいかをサイトから
            得られず npm ページへ出ていった。npm README の完動例をここへ引く。 */}
        <h3 className="text-base font-semibold text-brand-deep">SDK: read a score</h3>
        <p className="text-sm text-brand">
          <code>apiUrl</code> defaults to the hosted API, so a key is the only thing you have to
          supply. Copy this into a <code>.mjs</code> file and it runs.
        </p>
        <CodeBlock
          label="TypeScript: read a wallet score and a payee score with @vet402/sdk"
          code={`import { createVouchClient } from "@vet402/sdk";

const vouch = createVouchClient({ apiKey: process.env.VOUCH_API_KEY });

// Seller side — "should I accept payment from this wallet?"
const seller = await vouch.getWalletScore("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
console.log(seller.trustScore, seller.recommendation); // 0–100 and ALLOW | WARN | BLOCK — live values

// Buyer side — "should my agent pay this wallet?"
const payee = await vouch.getPayeeScore("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
console.log(payee.score, payee.recommendation, payee.dataDepth);`}
        />

        <h3 className="text-base font-semibold text-brand-deep">SDK: gate a payment</h3>
        <p className="text-sm text-brand">
          SpendGuard answers &ldquo;may my agent send this payment?&rdquo; and nothing else. It
          never touches keys, funds, or signing &mdash; execution stays with your wallet stack.
          Under the default <code>allow-only</code> policy, anything that is not a clean{" "}
          <code>ALLOW</code> denies.
        </p>
        <CodeBlock
          label="TypeScript: gate an agent payment with SpendGuard"
          code={`const guard = vouch.createSpendGuard({
  maxPerTxUsd: 10,      // deny any single payment above $10
  dailyBudgetUsd: 50,   // deny once today's allowed total would pass $50
});

const decision = await guard.evaluate({ payee: "0xabc...", amountUsd: 5 });

if (decision.allow) {
  // hand off to AgentKit / Privy / your own signer
} else {
  console.error(decision.reasons);
  // ["payee_recommendation_not_allow"]   verdict was WARN or BLOCK
  // ["payee_score_degraded"]             the score came from a degraded read
  // ["payee_partial_measurement"]        some inputs could not be measured
  // ["payee_trust_unauthenticated"]      your API key is missing or invalid
  // ["payee_trust_unavailable"]          the lookup failed upstream — retryable
}`}
        />

        <h3 className="text-base font-semibold text-brand-deep">
          Middleware: gate an x402 endpoint
        </h3>
        <CodeBlock
          label="TypeScript: Express x402 gate with @vet402/middleware"
          code={`import { createExpressGate } from "@vet402/middleware/express";

// Mount AFTER x402 verification, so \`req.payer\` is set.
app.use("/api/paid", createExpressGate({
  apiUrl: "https://vet402.com/api/v1",
  apiKey: process.env.VOUCH_API_KEY,
  getAddress: (req) => req.payer,   // the counterparty to vet
}));`}
        />
        <p className="text-sm text-brand-lift">
          Anything but <code>ALLOW</code> returns{" "}
          <code>403 {"{ error: \"trust_blocked\" }"}</code> before your handler runs; an{" "}
          <code>ALLOW</code> continues with the full decision on <code>req.vouchTrust</code>.
        </p>
        <p className="text-sm text-brand">
          <strong>Both the SDK and the middleware default to allow-only.</strong> Only an{" "}
          <code>ALLOW</code> passes; a <code>WARN</code>, a <code>BLOCK</code>, a degraded verdict
          and a partially measured one are all denied unless the caller explicitly opts out. That
          default is fail-closed on purpose &mdash; see{" "}
          <a href="#verdicts" className="doc-link">
            Verdicts &amp; thresholds
          </a>{" "}
          for what to do about a WARN.
        </p>

        {/* 2026-08-13 UX監査L3 [P5・実装者]。サイトの docs は mcp-server を
            install 一行でしか触れず、設定ブロック・tool 名・mcpServers JSON が
            無かった（SDK/middleware は完備）。MCP 経由の実装者はここで手が
            止まる。設定は packages/mcp-server/README.md の実物をそのまま写す。 */}
        <h3 className="text-base font-semibold text-brand-deep">MCP: let an agent ask before it pays</h3>
        <p className="text-sm text-brand">
          <code>@vet402/mcp-server</code> exposes the score as Model Context Protocol tools, so an
          MCP-capable agent (Claude Desktop and other MCP clients) can check a counterparty before it
          settles. Your client launches it with <code>npx</code> — no clone, no build. Add this to the
          client config (<code>~/Library/Application&nbsp;Support/Claude/claude_desktop_config.json</code>{" "}
          on macOS, <code>%APPDATA%\Claude\claude_desktop_config.json</code> on Windows) and restart:
        </p>
        <CodeBlock
          label="MCP client config for @vet402/mcp-server"
          code={`{
  "mcpServers": {
    "vouch-trust": {
      "command": "npx",
      "args": ["-y", "@vet402/mcp-server"],
      "env": {
        "VOUCH_API_KEY": "vouch_live_your_key_here"
      }
    }
  }
}`}
        />
        <p className="text-sm text-brand">
          <code>VOUCH_API_KEY</code> is required (create one at{" "}
          <code>/dashboard/keys</code>); <code>VOUCH_API_URL</code> is optional and defaults to the
          hosted API. It registers five tools — <code>check_agent_trust</code>,{" "}
          <code>check_wallet_trust</code>, <code>check_payee_trust</code>,{" "}
          <code>explain_trust_score</code>, and <code>attest_x402_payment</code>. Same fail-closed
          reading as the SDK: treat anything but <code>ALLOW</code> as &ldquo;do not pay yet&rdquo;.
        </p>
      </section>

      {/* 2026-08-13 UX監査R1 [C6]: ALLOW/WARN/BLOCK は全ページに出ているのに、
          境界値がサイトのどこにも書いていなかった。運用者ペルソナは
          「WARN が来たらどうすればいいのか」が決められず統合コードを書けずに
          離脱している。閾値は src/lib/chain/config.ts の SCORE_THRESHOLDS を
          そのまま写す（記憶で書かない）。SDK 既定の fail-closed も、閾値と
          同じ場所で言わないと「WARN は通るのだろう」と読まれる。 */}
      <section id="verdicts" className="scroll-mt-32 space-y-3">
        <h2 className="sec-head">Verdicts &amp; thresholds</h2>
        <p className="text-sm text-brand">
          Every scored response carries a numeric score and a{" "}
          <code className="text-brand-deep">recommendation</code>. The bands are fixed and the same
          for the agent, wallet and payee engines:
        </p>
        <TableScroll label="Score bands and recommended handling">
          <table className="fact-table">
            <caption className="sr-only">
              Score thresholds for ALLOW, WARN and BLOCK, and what to do with each
            </caption>
            <thead>
              <tr>
                <th scope="col">Verdict</th>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col">What it means</th>
                <th scope="col">Recommended handling</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-brand-deep">ALLOW</td>
                <td className="num whitespace-nowrap text-brand-deep">70 &ndash; 100</td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Every check completed and nothing adverse was found.
                </td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Proceed. This is the only band the SDK and the middleware pass by default.
                </td>
              </tr>
              <tr>
                <td className="text-brand-deep">WARN</td>
                <td className="num whitespace-nowrap text-brand-deep">40 &ndash; 69</td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Not cleared. Something is thin, unusual, or only partially measured &mdash; not
                  enough to condemn the address, not enough to pass it either.
                </td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Decide deliberately rather than by default: allow it under a spend ceiling, queue
                  it for review, or require a second signal.
                </td>
              </tr>
              <tr>
                <td className="text-brand-deep">BLOCK</td>
                <td className="num whitespace-nowrap text-brand-deep">0 &ndash; 39</td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Adverse signals, a blacklist hit, or a check that could not be completed at all
                  (<code>degraded: true</code>).
                </td>
                <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                  Do not pay. A degraded BLOCK is a refusal to answer, not a finding &mdash; retry
                  once the upstream recovers.
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
        <ul className="list-disc space-y-2 pl-5 text-sm text-brand">
          <li>
            <strong>Band the recommendation, not the number.</strong> Read{" "}
            <code>recommendation</code>, not <code>trustScore &gt;= 70</code>. A blacklisted address
            and a degraded verdict are <code>BLOCK</code> regardless of what the number says, so a
            numeric comparison in your own code will disagree with ours on exactly the cases that
            cost money.
          </li>
          <li>
            <strong>The default is allow-only, and that is the point.</strong>{" "}
            <code>@vet402/sdk</code> and <code>@vet402/middleware</code> deny everything
            that is not <code>ALLOW</code> unless you opt out explicitly. The asymmetry is
            deliberate: declining a good payee costs a retry, paying a bad one is final and
            irreversible on x402.
          </li>
          <li>
            <strong>WARN is where your policy lives, not ours.</strong> We publish the band and the
            raw signals behind it; what an acceptable risk is at your transaction size is yours to
            set. The one handling we do argue against is treating WARN as a quiet ALLOW &mdash; our{" "}
            <Link href="/accuracy" className="doc-link">
              operator benchmark
            </Link>{" "}
            currently scores known-bad addresses WARN rather than BLOCK in a minority of cases, so
            a pass-on-WARN integration would pay those.
          </li>
        </ul>
      </section>

      {/* 2026-08-06: capacity planning. Quotas were on the pricing page but the
          burst behaviour was nowhere — a synchronous gate needs both to size a
          deployment. Values are read from the code (auth.ts PLAN_LIMITS,
          ip-rate-limit call sites), not asserted. */}
      <section id="rate-limits" className="scroll-mt-32 space-y-3">
        <h2 className="sec-head">Rate limits</h2>
        <p className="text-sm text-brand">
          Scoring is synchronous, so plan for both the monthly quota and the
          burst behaviour below.
        </p>
        <TableScroll label="Monthly request quota by plan">
          <table className="fact-table">
            <caption className="sr-only">Monthly request quota by plan</caption>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col" className="num">Monthly requests</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="text-brand-deep">Free</td><td className="num text-brand-deep">1,000</td></tr>
              <tr><td className="text-brand-deep">Pro</td><td className="num text-brand-deep">50,000</td></tr>
              <tr><td className="text-brand-deep">Scale</td><td className="num text-brand-deep">500,000</td></tr>
            </tbody>
          </table>
        </TableScroll>
        <ul className="list-disc space-y-2 pl-5 text-sm text-brand">
          <li>
            <strong>Quota is per calendar month (UTC)</strong> and shared across
            all keys on an account. Each <code>/score</code> call is 1 unit; a{" "}
            <code>/scores/batch</code> of N agents is N units. Every scored
            response carries <code>X-RateLimit-Limit</code>,{" "}
            <code>X-RateLimit-Used</code>, and <code>X-RateLimit-Remaining</code>{" "}
            headers so you can track consumption without a separate call.
          </li>
          <li>
            <strong>No per-second burst throttle on authenticated calls today.</strong>{" "}
            Authenticated requests are governed by the monthly quota only — you
            may spend it as fast as you like — so pace client-side if you must
            not exhaust the month in one run.
          </li>
          {/* 2026-08-13 UX監査2巡目 [m1]: ここの数字が実測と合っていなかった。
              「payee-verify を 10/minute/IP」と書いていたが、実際に本番へ投げると
              `RateLimit-Limit: 30` が返る（GET と POST で別の上限であることが
              docs に無かった）。値は各 route.ts の定数から写している。 */}
          <li>
            <strong>Abuse throttles (IP-based), per minute.</strong> Key-less and
            pre-auth paths carry their own IP cap, independent of the quota:
            authentication <em>failures</em> 60; the unauthenticated demo scorer
            10; <code>GET /api/v1/accuracy</code> 20; the badge SVGs 60; the agent
            passport 20. Verify endpoints split read from write:{" "}
            <code>GET</code> (message preview) 30/IP, while <code>POST</code> is
            8/IP <em>and</em> 4 per wallet or agent, so one identity cannot rewrite
            its public profile in a loop from many IPs. Valid authenticated traffic
            does not hit any of these.
          </li>
        </ul>
        {/* 2026-08-13 [m1]: 429 は2系統あり、区別できないと誤ったリトライを
            書かれる（月次枯渇に指数バックオフを掛けても、翌月まで通らない）。 */}
        <h3 className="sub-head">Two kinds of 429</h3>
        <TableScroll label="The two distinct causes of an HTTP 429">
          <table className="fact-table">
            <caption className="sr-only">
              The two distinct causes of an HTTP 429 and how to tell them apart
            </caption>
            <thead>
              <tr>
                <th scope="col">Cause</th>
                <th scope="col">Body</th>
                <th scope="col">Headers</th>
                <th scope="col">What to do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-brand-deep">Monthly quota spent (authenticated)</td>
                <td className="break-all text-brand">
                  <code>error: &quot;rate_limit_exceeded&quot;</code> with{" "}
                  <code>retryAfter</code>, <code>usage</code>, <code>limit</code>
                </td>
                <td className="break-all text-brand">
                  <code>X-RateLimit-*</code> and <code>Retry-After</code> (seconds to the start of
                  next month, UTC)
                </td>
                <td className="text-brand">
                  Stop. Retrying inside the month cannot succeed — raise the plan or wait for the
                  reset.
                </td>
              </tr>
              <tr>
                <td className="text-brand-deep">IP throttle (key-less / pre-auth paths)</td>
                <td className="break-all text-brand">
                  <code>error: &quot;rate_limited&quot;</code>
                </td>
                <td className="break-all text-brand">
                  <code>RateLimit-Limit</code> / <code>-Remaining</code> / <code>-Reset</code> and{" "}
                  <code>Retry-After</code> (seconds, always under 60)
                </td>
                <td className="text-brand">
                  Sleep for <code>Retry-After</code> and retry. The window is one minute.
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
        <p className="text-sm text-brand-lift">
          The header families are deliberately different names:{" "}
          <code className="text-brand-deep">X-RateLimit-*</code> reports the monthly plan quota,{" "}
          <code className="text-brand-deep">RateLimit-*</code> (IETF draft names) reports the
          short IP window. No route sets both families on the same response.
        </p>
      </section>

      <section id="endpoints" className="scroll-mt-32 space-y-5">
        {endpoints.map((ep) => (
          <div
            key={ep.path}
            id={endpointId(ep)}
            className="scroll-mt-32 space-y-3 border-t border-hair pt-6 text-[0.8125rem] first:border-t-brand-deep"
          >
            <div>
              {/* 2026-08-06 a11y (screen-reader persona audit): these endpoint
                  names were <p>, so the whole reference exposed exactly two
                  headings ("API reference", "Error codes") and heading-jump
                  navigation could not reach any individual endpoint. They are
                  headings semantically, so they are <h2> now — Tailwind's
                  preflight keeps font-size/weight inherited, so the rendering
                  is byte-identical to the old <p>. */}
              <h2 className="break-all font-[family-name:var(--font-display)] font-semibold text-brand-deep">
                <span className="marker marker-plan mr-2 align-middle">{ep.method}</span>
                {/* 2026-08-13 全盲ペルソナ監査 R2【微差】: バッジの `mr-2` は視覚的な
                    余白でしかなく、読み上げには何の隙間も作らない。実測では見出しが
                    `GET/api/v1/agents/:agentId/score` と1語に繋がって聞こえていた
                    （メソッドとパスの境が消える）。/leaderboard の SeedTag と同じ手で、
                    視覚に出ない空白を挟んで HTTP のリクエスト行と同じ `GET /api/…` の
                    区切りを音にだけ渡す。紙面は 1px も変えない。 */}
                <span className="sr-only"> </span>
                {ep.path}
              </h2>
              <p className="mt-1 text-brand">{ep.note}</p>
            </div>

            {ep.request && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
                  Request body
                </p>
                <CodeBlock
                  code={ep.request}
                  label={`Request body for ${ep.method} ${ep.path}`}
                />
              </div>
            )}

            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
                Response
              </p>
              <CodeBlock code={ep.response} label={`Response for ${ep.method} ${ep.path}`} />
            </div>
          </div>
        ))}
      </section>

      <section id="score-breakdown" className="scroll-mt-32 space-y-3">
        {/* 2026-08-06 N-21: explainability. Integrators kept asking "why this
            number" — the breakdown answers it in the response itself, so a
            compliance log can record the arithmetic, not just the verdict. */}
        <h2 className="sec-head">Score breakdown</h2>
        <p className="text-sm text-brand">
          Every scored verdict (agent and wallet endpoints, and each element of a
          batch) carries a <code className="text-brand-deep">breakdown</code>{" "}
          object that decomposes the chain score into its four weighted
          components. It is derived from the same numbers the verdict used, so it
          can never disagree with <code className="text-brand-deep">trustScore</code>.
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm text-brand">
          <li>
            <strong>components</strong> — each of <code>identity</code>,{" "}
            <code>reputation</code>, <code>wallet</code>, <code>x402</code> reports
            its 0–100 <code>score</code>, its <code>weight</code>, and its{" "}
            <code>contribution</code> (<code>score × weight ÷ 0.8</code>; the four
            contributions sum to <code>weightedSubtotal</code>). Weights are
            identity&nbsp;0.05, reputation&nbsp;0.10, wallet&nbsp;0.25, x402&nbsp;0.40
            — divided by 0.8 because the customer whitelist/blacklist is a policy
            layer, not a signal. Weighted toward the signals that are hardest to
            fake: a real settled x402 payment history counts most, self-asserted
            identity and reputation least. ALLOW additionally requires verifiable
            on-chain evidence — self-assertion alone is capped below ALLOW.
          </li>
          <li>
            <strong>weightedSubtotal</strong> — the weighted average of the four
            components, before any sybil adjustment.
          </li>
          <li>
            <strong>sybilPenalty</strong> — points removed by sybil / data-
            availability flags (always ≤ 0). The specific flags are in{" "}
            <code>signals.sybil.flags</code>.
          </li>
          <li>
            <strong>prePolicyScore</strong> —{" "}
            <code>weightedSubtotal + sybilPenalty</code>, clamped to 0–100. This
            equals <code>trustScore</code> unless a manual list moved it, in which
            case <code>manualOverride</code> is <code>true</code>. The manual
            layer is deliberately kept out of the breakdown so the chain-derived
            explanation stays separable from policy.
          </li>
        </ul>
        <p className="text-sm text-brand">
          Hard-blocked verdicts (wallet mismatch, unregistered agent) omit{" "}
          <code className="text-brand-deep">breakdown</code> — no weighting
          ran — and carry a <code className="text-brand-deep">blockReason</code>{" "}
          instead. Treat the field as optional.
        </p>

        {/* 2026-08-13 UX監査2巡目 [M6]: /payee/:address が出す "37 / 100 · data:
            thin" の出所を書く場所がどこにも無かった。ここが /payee 頁からの
            リンク先（#payee-score）で、閾値と重みは
            src/lib/scoring/payee-engine.ts の determineDataDepth /
            WEIGHTS_BY_DEPTH を写している。 */}
        <div id="payee-score" className="scroll-mt-32 space-y-3">
          <h3 className="sub-head">Payee score</h3>
          <p className="text-sm text-brand">
            <code className="break-all text-brand-deep">
              GET /api/v1/payees/:address/score
            </code>{" "}
            — and the public page at{" "}
            <code className="break-all text-brand-deep">/payee/:address</code> — runs a different
            engine from the agent/wallet endpoints above and carries no{" "}
            <code>breakdown</code> object. It weighs three tracks, and the weights shift with how
            much receiving history the wallet actually has, because a cold wallet cannot be judged
            on a track record it does not have.
          </p>
          <TableScroll label="Payee score component weights by data depth">
            <table className="fact-table">
              <caption className="sr-only">
                Payee score component weights by data depth
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    <code>dataDepth</code>
                  </th>
                  <th scope="col">Means</th>
                  <th scope="col" className="num">
                    Receiving
                  </th>
                  <th scope="col" className="num">
                    Wallet health
                  </th>
                  <th scope="col" className="num">
                    Drain pattern
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-brand-deep">thin</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                    under 3 payments received, or from under 2 distinct payers
                  </td>
                  <td className="num text-brand-deep">15%</td>
                  <td className="num text-brand-deep">45%</td>
                  <td className="num text-brand-deep">40%</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">moderate</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                    3+ payments received from 2+ distinct payers
                  </td>
                  <td className="num text-brand-deep">35%</td>
                  <td className="num text-brand-deep">35%</td>
                  <td className="num text-brand-deep">30%</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">rich</td>
                  <td className="font-[family-name:var(--font-sans)] font-normal whitespace-normal text-brand">
                    10+ payments received across 7+ days from 3+ distinct payers
                  </td>
                  <td className="num text-brand-deep">50%</td>
                  <td className="num text-brand-deep">25%</td>
                  <td className="num text-brand-deep">25%</td>
                </tr>
              </tbody>
            </table>
          </TableScroll>
          <ul className="list-disc space-y-2 pl-5 text-sm text-brand">
            <li>
              <strong>The raw inputs are in the response.</strong>{" "}
              <code>signals.receiving</code> reports{" "}
              <code>paymentCount / uniqueDays / distinctPayers</code>,{" "}
              <code>signals.walletHealth</code> reports{" "}
              <code>ageDays / txCount / isBurner</code>, and{" "}
              <code>signals.drainPattern</code> reports the in/out counts and ratio — each with
              its own 0–100 <code>score</code>, so the weighted arithmetic above can be re-run
              from the payload.
            </li>
            <li>
              <strong>
                <code>degraded: true</code> is a refusal, not a reading.
              </strong>{" "}
              It means an input could not be read at all. Callers receive a fail-closed{" "}
              <code>BLOCK</code>; the public page prints{" "}
              <em>&ldquo;Not verifiable right now&rdquo;</em> rather than a number, because a
              specific accusation against a named wallet must not rest on an upstream outage.
              <code>dataDepth</code> answers a different question — how much history exists — and
              a data-poor wallet read completely is not the same thing.
            </li>
            <li>
              <strong>Outcomes adjust the score after weighting.</strong>{" "}
              <code>signals.outcomeHistory</code> carries the outcome types on record and the
              points they moved, which is the same ledger{" "}
              <Link href="/accuracy" className="doc-link">
                /accuracy
              </Link>{" "}
              aggregates.
            </li>
          </ul>
        </div>
      </section>

      <section id="webhooks" className="scroll-mt-32 space-y-4">
        {/* 2026-08-06 N-15/C-9 doc gap: the watchlist mentioned the
            watch.verdict_changed webhook but nothing documented registration,
            the payload envelope, or signature verification — the receiver could
            not prove a "ALLOW→BLOCK" notice was really from us. This section is
            written from src/lib/webhooks.ts, not from memory. */}
        <h2 className="sec-head">Webhooks</h2>
        <p className="text-sm text-brand">
          vet402 is otherwise a pull API. Webhooks turn it into a monitoring
          service: register an endpoint once and we POST you a signed event when
          something you care about changes — most importantly a watched target
          whose verdict moved (e.g. an <code>ALLOW</code> you gated a payment on
          becoming a <code>BLOCK</code>). Register with{" "}
          <code className="text-brand-deep">POST /api/v1/webhooks</code>{" "}
          (above); up to 5 endpoints per key.
        </p>

        <div>
          <h3 className="sub-head">Events</h3>
          <TableScroll label="Webhook event types and their payloads">
            <table className="fact-table">
              <caption className="sr-only">Webhook event types and their payloads</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Fires when</th>
                  <th scope="col"><code>data</code> fields</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-brand-deep">watch.verdict_changed</td>
                  <td className="text-brand">A watchlist target&apos;s recommendation changes on a re-scan (daily cron). Verdict changes only — not score jitter.</td>
                  <td className="break-all text-[0.6875rem] text-brand">watchId, targetType, target, chainId, previous&#123;score,recommendation&#125;, current&#123;score,recommendation&#125;</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">outcome.recorded</td>
                  <td className="text-brand">An outcome (auto-detected or partner-reported) lands on a verdict you requested.</td>
                  <td className="break-all text-[0.6875rem] text-brand">trustEventId, outcomeType, source, wallet, agentId</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">list.changed</td>
                  <td className="text-brand">Your own manual whitelist/blacklist changes (also on import) — a team audit trail.</td>
                  <td className="break-all text-[0.6875rem] text-brand">action, wallet, listType</td>
                </tr>
                <tr>
                  <td className="text-brand-deep">endpoint.delisted</td>
                  <td className="text-brand">An x402 endpoint paying a wallet you claim-proved via POST /api/v1/observatory/watch vanished from the public discovery catalog on a complete fetch (daily observatory sync). Factual listing-state notice, not an operator assessment.</td>
                  <td className="break-all text-[0.6875rem] text-brand">resourceKey, resourceUrl, payTo, detectedOn, lastSeenAt, historyUrl</td>
                </tr>
              </tbody>
            </table>
          </TableScroll>
          <p className="mt-2 text-sm text-brand">
            A score is never pushed — scores are computed on demand and pushing a
            cached one would invite treating a stale number as fresh.
          </p>
        </div>

        <div>
          <h3 className="sub-head">Delivery payload</h3>
          <p className="mt-1 text-sm text-brand">
            Every delivery is a JSON POST with this envelope. <code>id</code> is
            unique per event — dedupe on it (see idempotency below).
          </p>
          <CodeBlock
            className="mt-2"
            label="Webhook delivery payload envelope"
            code={`POST https://your-host.example/vouch-hook
Content-Type: application/json
Vouch-Signature: t=1723000000,v1=5f2b…   (hex HMAC-SHA256)
User-Agent: vouch-webhooks/1

{
  "id": "evt_9f8a…",
  "type": "watch.verdict_changed",
  "createdAt": "2026-08-06T09:30:00.000Z",
  "data": {
    "watchId": "…",
    "targetType": "wallet",
    "target": "0x…",
    "chainId": 8453,
    "previous": { "score": 74, "recommendation": "ALLOW" },
    "current":  { "score": 31, "recommendation": "BLOCK" }
  }
}`}
          />
        </div>

        <div>
          <h3 className="sub-head">Verifying the signature</h3>
          <p className="mt-1 text-sm text-brand">
            The <code>Vouch-Signature</code> header is{" "}
            <code>t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where{" "}
            <code>v1</code> is <code>HMAC-SHA256(secret, `${"{"}t{"}"}.${"{"}rawBody{"}"}`)</code>{" "}
            — the timestamp, a literal dot, then the <strong>raw</strong> request
            body. Recompute it with your <code>whsec_…</code> secret, compare in
            constant time, and reject if the timestamp is more than 5 minutes from
            now (replay guard). The reference implementation is below — copy it
            as-is.
          </p>
          <CodeBlock
            className="mt-2"
            label="Node.js webhook signature verification example"
            code={`import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = new Map(header.split(",").map(p => {
    const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)];
  }));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // replay guard
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}`}
          />
        </div>

        <div>
          <h3 className="sub-head">Delivery, retries &amp; idempotency</h3>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-brand">
            <li>
              <strong>At-most-once, no retry.</strong> Each event is delivered
              once with a 5-second timeout. A non-2xx response or timeout is not
              re-delivered — it increments a failure counter instead. A 2xx resets
              that counter to zero. (Design your handler to catch up by polling
              the watchlist / outcome endpoints, not by relying on redelivery.)
            </li>
            <li>
              <strong>Auto-disable.</strong> After 20 consecutive failed
              deliveries the endpoint is disabled to stop wasting egress on a dead
              URL. Re-create it (<code>POST /api/v1/webhooks</code>) to re-enable —
              a new secret is issued.
            </li>
            <li>
              <strong>Idempotency.</strong> Treat <code>id</code> as an
              idempotency key: store processed ids and ignore a repeat, so a
              duplicate dispatch (e.g. overlapping cron passes) is a no-op on your
              side.
            </li>
            <li>
              <strong>SSRF safety / redirects.</strong> The target URL is
              re-validated at delivery time and redirects are rejected (a redirect
              at delivery is an SSRF vector, not a feature). Point the endpoint at
              its final https URL directly.
            </li>
          </ul>
        </div>
      </section>

      <section id="availability" className="scroll-mt-32 space-y-3">
        {/* 2026-08-06: B2B buyers ask for an SLA. Written to the real
            operational posture (single-operator closed beta on Vercel + Neon +
            Base RPC, daily deep health probe), not an aspirational number —
            same honesty discipline as the /accuracy page. Revise the target
            when the operating history and infrastructure justify a commitment. */}
        <h2 className="sec-head">Availability</h2>
        <p className="text-sm text-brand">
          vet402 is in closed beta, run by a single operator. We publish our real
          operating posture rather than a contractual uptime figure we can&apos;t
          yet stand behind:
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm text-brand">
          <li>
            <strong>No SLA credits during beta.</strong> Service is best-effort,
            with no financial uptime guarantee. When we commit to a numeric target
            it will be backed by measured operating history — we would rather
            under-promise than publish a number the way some vendors publish
            accuracy claims they never measured.
          </li>
          <li>
            <strong>Infrastructure.</strong> Serverless compute (Vercel),
            managed Postgres (Neon), and Base RPC. Availability inherits from
            these providers; there is no independent multi-region failover today.
          </li>
          <li>
            <strong>Fail-closed, not fail-wrong.</strong> When an upstream (RPC,
            indexer, settlement store) is unavailable, the affected signal is
            marked with an <code>*_unavailable</code> flag and penalized rather
            than guessed — a degraded lookup returns a more cautious verdict, not
            a confidently wrong one. Each response&apos;s <code>dataCoverage</code>{" "}
            reports indexer and settlement freshness so you can see what the score
            could draw on.
          </li>
          <li>
            <strong>Monitoring.</strong> A public health endpoint,{" "}
            <code>GET /api/health</code>, returns <code>200</code>/<code>503</code>{" "}
            for uptime pollers. It probes both scoring engines &mdash; seller-side
            and buyer-side &mdash; and reports the worse of the two.{" "}
            <code>200</code> means both answered from complete inputs; anything
            else is <code>503</code>, including a <code>degraded</code> verdict
            where the engine still answers but could not read everything (that is
            what a visitor sees as &ldquo;Not verifiable right now&rdquo;). The
            JSON body carries <code>{"\"degraded\""}</code> or{" "}
            <code>{"\"error\""}</code> so you can tell a partial outage from a
            total one. A deeper env/DB/RPC probe runs on a daily cron and returns{" "}
            <code>503</code> only on a critical failure (indexer catch-up lag is
            reported, not alerted, to avoid backfill alert fatigue).
          </li>
          <li>
            <strong>Status &amp; incidents.</strong> No hosted status page yet;
            during beta, material incidents are communicated to integrators
            directly. Point your own uptime monitor at <code>/api/health</code>{" "}
            in the meantime.
          </li>
        </ul>
      </section>

      <section id="error-codes" className="scroll-mt-32 space-y-3">
        <h2 className="sec-head">Error codes</h2>
        <TableScroll label="HTTP error codes returned by the vet402 API">
          <table className="fact-table">
            {/* 2026-08-06 a11y: caption + scope="col" bring this table up to the
                same standard /accuracy and /leaderboard already meet, so a
                screen reader announces the column a cell belongs to. */}
            <caption className="sr-only">HTTP error codes returned by the vet402 API</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Meaning</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {errorCodes.map((e) => (
                <tr key={e.status}>
                  <td className="text-brand-deep">{e.status}</td>
                  <td className="text-brand-deep">{e.meaning}</td>
                  <td className="text-brand">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <p className="text-sm text-brand">
          Error bodies are shaped as <code className="text-brand-deep">{`{ "error": string, "details"?: object }`}</code>.
        </p>
      </section>

        <p className="text-[0.8125rem]">
          <Link href="/" className="doc-link">
            The memo
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/faq" className="doc-link">
            FAQ
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/dashboard" className="doc-link">
            Dashboard
          </Link>
          <span aria-hidden="true" className="mx-2 text-brand-lift">·</span>
          <Link href="/dashboard/integrations" className="doc-link">
            Integrations
          </Link>
        </p>
      </article>
    </main>
  );
}

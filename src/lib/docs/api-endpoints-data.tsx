import type { ReactNode } from "react";
import { DELIVERY_CSV_BODY_BYTES_NOTE, DELIVERY_CSV_COLUMNS, DELIVERY_CSV_HEADER_NOTES, DELIVERY_CSV_WHOSE_PURCHASES } from "@/lib/observatory/delivery-export";
import { DELIVERY_VALUE_DEFINITIONS } from "@/lib/observatory/delivery-values";
import { DELIVERY_FEED_PAGE_SIZE } from "@/lib/delivery/sellers-feed";
import {
  DECISION_KEYLESS_LIMIT_SINCE,
  PAYMENT_PROOF_RPC_TIMEOUT_MS,
  keylessDecisionPerMinute,
  keylessDiagnosePerMinute,
  keylessPaymentProofPerMinute,
  keylessResolvePerMinute,
} from "@/lib/api/keyless-limits";
import { DECISION_RULES_TEXT, METHOD_LIMIT_TEXT } from "@/lib/decision/rules-text";
import { inviteRequired } from "@/lib/dashboard/signup-core";
import { SITE_URL } from "@/lib/site-url";
import { MCP_DOCS_CONNECT_CURSOR } from "@/lib/docs/mcp-page-text";
// Extracted from src/app/docs/api/page.tsx for client-side endpoint reference (UX3 performance).

export type ApiDocEndpoint = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  // 2026-09-07 ETHOnline (F13): a note may carry a link. Only /decision uses it, once.
  note: ReactNode;
  request?: string;
  response: string;
  /** Visible heading above the response frame. Defaults to "Response". */
  responseHeading?: string;
  /** Sentence under that heading. */
  responseNote?: string;
};

export const API_DOC_ENDPOINTS: ApiDocEndpoint[] = [
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
    note: "Preview the exact canonical message for a (wallet, name) pair before signing — no API key. Pass url= as well when the profile will include a link; that URL is bound into the signature. The same message is echoed back in a failed POST's expectedMessage field. Fetch it rather than building it locally: since 2026-09-05 the message names the requesting domain, and signatures over the older form stop verifying on 2026-09-21 (signature_message_legacy_expired).",
    response: `{ "message": "vet402.com — verified payee registration\\ndomain: vet402.com\\nwallet: 0x…\\nname: Acme API\\nissued: 2026-09-05T12:00:00.000Z (valid 10 minutes)\\nThis signature proves control of the wallet above. It moves no funds and grants no spending approval.", "issued": "2026-09-05T12:00:00.000Z" }`,
  },
  {
    method: "POST",
    path: "/api/v1/payees/verify",
    note: "Address control verification — free, no API key. Sign the canonical message above (fetch it via GET on this same path, including url= when you will send one) with the payee wallet; a valid signature proves control and publishes /payee/:address plus an embeddable badge at /api/badge/:address. Verification proves wallet control only; scores stay independent.",
    request: `{ "wallet": "0x…", "name": "Acme API", "url": "https://…", "issued": "2026-09-05T12:00:00.000Z", "signature": "0x…" }`,
    response: `{ "ok": true, "profile": "/payee/0x…", "badge": "/api/badge/0x…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/agents/verify?agentId=42&name=Acme+Agent",
    note: "Agent-side twin of payee verify. Preview the exact canonical message to sign for (agentId, name) — no API key. The agent's on-chain wallet is resolved and returned so you sign with the right key.",
    response: `{ "agentId": "42", "wallet": "0x…", "message": "vet402.com — agent passport registration\\ndomain: vet402.com\\nagentId: 42\\nwallet: 0x…\\nname: Acme Agent\\nissued: 2026-09-05T12:00:00.000Z (valid 10 minutes)\\nThis signature proves control of the wallet above. It moves no funds and grants no spending approval.", "issued": "2026-09-05T12:00:00.000Z" }`,
  },
  {
    method: "POST",
    path: "/api/v1/agents/verify",
    note: "Trust-passport registration — free, no API key. Sign the canonical message above with the agent's on-chain wallet (getAgentWallet(agentId)); a valid signature plus the on-chain wallet binding proves control of the agent identity and publishes /agent/:agentId, a machine-readable passport at /api/v1/agents/:agentId/passport, and a badge at /api/badge/agent/:agentId.",
    request: `{ "agentId": "42", "name": "Acme Agent", "url": "https://…", "issued": "2026-09-05T12:00:00.000Z", "signature": "0x…" }`,
    response: `{ "ok": true, "agentId": "42", "wallet": "0x…", "profile": "/agent/42", "badge": "/api/badge/agent/42" }`,
  },
  {
    method: "GET",
    path: "/api/v1/agents/:agentId/passport",
    note: "The portable, third-party-verifiable passport — no API key. Returns the signed identity claim, the verification material (canonical message + signature, so any counterparty can re-run verifyMessage and cross-check the wallet against getAgentWallet on-chain), and a live score with explicit freshness (scoredAt / cacheExpiresAt).",
    response: `{ "agentId": "42", "verified": true, "identity": { "name": "Acme Agent", "wallet": "0x…", "proof": { "message": "…", "signature": "0x…", "scheme": "eip191-personal-sign" } }, "score": { "trustScore": 78, "recommendation": "ALLOW", "x402": { "paymentCount": 12, "uniqueDays": 6 }, "scoredAt": "…", "cacheExpiresAt": "…" } }`,
  },
  // ------------------------------------------------------------------
  // 製品定義書 §7.3 / §9.1（2026-09-02）。監査 P1-13: 本番で動いている 9 ルートが
  // このページに 0 件だった。tests/docs-surface-parity.test.ts が網羅を検査する。
  // ------------------------------------------------------------------
  // 2026-10-28: MCP の入口（https://vet402.com/mcp）。tests/docs-api-public-paths.test.ts が openapi の paths と突き合わせる。
  {
    method: "GET",
    path: "/api/v1/decision?url=https%3A%2F%2Fapi.example.com%2Fx402",
    note: `Key-less alias of GET /api/v1/check with the same JSON body and the same per-IP limit. Use either path. Responses carry RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, and RateLimit-Policy on 200 and 429. Answers are not CDN-cached (Cache-Control private, no-store) because the remaining limit is per caller.`,
    response: `{ "not_in_catalog": false, "recommendation": "ALLOW", "delivery": { "paid_attempts": 3, "delivered": 3, "settled_not_delivered": 0, "window_days": 30 }, "l1_purchases": [ … ], "as_of": "…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/stats/keyless-callers",
    note: "Weekly counts of distinct keyless callers for GET /api/v1/check and GET /api/v1/decision. Counts only. Per-caller hashes are kept for the current week and deleted when the week closes. IP and user agent are not stored. The open ISO week is marked in_progress.",
    response: `{ "weeks": [ { "week_start": "2026-11-10", "keyless_callers_7d": 42, "keyless_callers_2plus_days_7d": 10, "keyless_callers_returning_wow": 8, "in_progress": true } ] }`,
  },
  {
    method: "GET",
    path: "/api/v1/stats/badge-fetches?days=7",
    note: "Per-calendar-day counts of badge image responses from GET /api/badge/**, grouped by referer host name (not path or IP). days defaults to 7.",
    response: `{ "days": 7, "rows": [ { "day": "2026-11-16", "referer_host": "docs.example.com", "badge_kind": "host", "fetches": 12 } ] }`,
  },
  {
    method: "GET",
    path: "/api/v1/stats/referrals?days=7",
    note: "First-party page_view counts grouped by coarse referrer label (x covers x.com and t.co). No IP or full referrer URL is stored or returned. days defaults to 7.",
    response: `{ "days": 7, "by_source": [ { "source": "x", "page_views": 12 }, { "source": "direct", "page_views": 40 } ] }`,
  },
  {
    method: "GET",
    path: "/api/v1/stats/interest?days=14",
    note: "First-party watch_sellers_interest counts (seller reputation pages). No email or identifier is stored or returned. days defaults to 14.",
    response: `{ "days": 14, "watch_sellers_interest": 3 }`,
  },
  {
    method: "GET",
    path: "/api/v1/check?url=https%3A%2F%2Fapi.example.com%2Fx402",
    note: `Key-less REST twin of MCP check_x402_seller, the same JSON document (recommendation, delivery, the five latest purchases, verified_terms, verified_pay_to_by_network). check reads vet402 purchase records. GET /api/v1/diagnose fetches the URL now and reads the 402 response. When not_in_catalog is true, diagnose_url links to diagnose for that URL. Optional method= narrows the HTTP method like /resolve. Counts against the same per-IP limit as /resolve (${keylessResolvePerMinute()} requests per minute per IP). Responses carry RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, and RateLimit-Policy on 200 and 429. Answers are not CDN-cached (Cache-Control private, no-store) because the remaining limit is per caller. Unknown or duplicate query parameters are 400 invalid_query (allowed lists url and method). url must be https (http gives invalid_url), bad method gives invalid_method. 503 temporarily_unavailable when the store cannot be read. When VET402_RECEIPT_SIGNER_KEY is set, the body also carries receipt. POST /api/v1/receipts/verify checks it. When the variable is unset, receipt is omitted and the rest of the body stays as it is.`,
    response: `{ "not_in_catalog": false, "recommendation": "ALLOW", "delivery": { "paid_attempts": 3, "delivered": 3, "settled_not_delivered": 0, "window_days": 30 }, "l1_purchases": [ … ], "as_of": "…" }`,
  },
  {
    method: "POST",
    path: "/api/v1/check/presign",
    note: `Scan a 402 before you sign. Send the 402 JSON body the seller returned (with accepts), or { "challenge": <402 body or the base64 PAYMENT-REQUIRED header value>, "url", "method" }. x402 v1 and v2 accepts are read. The listing is found by url, else the 402's resource.url, else the first accepts[].resource. The verdict (recommendation, reason_codes, verified_terms, verified_pay_to_by_network, rules_version) is the GET /api/v1/check answer, unchanged. accepts[] gives terms_match and reason_codes for each accept, from the function the vet402 SDK payOrRefuse runs before it signs (payee_mismatch, price_above_declared, chain_or_asset_mismatch, payee_unverified_on_rail, price_unverified, evidence_unavailable). terms_match is null with resource_uncatalogued when the URL is not in the catalog. An accept vet402 cannot read (amount not an integer string, or payTo, scheme or asset missing) is evidence_unavailable. No key. Same per-IP limit as GET /api/v1/check (${keylessResolvePerMinute()} requests per minute per IP). Body up to 64 KB and 32 accepts. Server-Timing presign;dur= is the server time. vet402 publishes cold-start and warmup p50 and p99 its own probe measured on one seller, with the run time, at /data/presign-latency.json (null before the first published run), and apart from it, in distinct_sellers, p50, p99 and max for the first check of sellers that delivered, one URL each. vet402 does not store the 402 body or the URL. This route does not pay.`,
    response: `{ "recommendation": "ALLOW", "reason_codes": ["l0_pass", "l1_delivered", "l2_conform"], "verified_terms": { "network": "eip155:42161", "pay_to": "0x…", "amount": "7000", … }, "accepts": [ { "index": 0, "network": "eip155:8453", "terms_match": false, "reason_codes": ["payee_unverified_on_rail"] }, { "index": 1, "network": "eip155:42161", "terms_match": true, "reason_codes": [] } ], "matching_accepts": [1], "rules_version": "…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/find?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fweather",
    note: `Key-less REST read of up to three alternative x402 listings for the same use as a pasted https URL or a short query string. Exactly one of url or q is required. Unknown or duplicate query parameters are 400 invalid_query (allowed lists url and q). url must be https (http → invalid_url). q must be 3 to 80 characters after trim. Has its own per-IP bucket with the same limit as /resolve (${keylessResolvePerMinute()} requests per minute per IP). The CDN may serve an answer up to 60 seconds old, and up to five more minutes while it refreshes in the background. 503 temporarily_unavailable when the store cannot be read.`,
    response: `{ "basis": "url", "input": "https://api.example.com/v1/weather", "query_terms": ["weather"], "alternatives": [ { "url": "https://other.example/weather", "seller_description": "…", "text_source": "seller", "price_usd": 0.01, "network": "eip155:8453", "delivered_30d": 8, "paid_attempts_30d": 10, "delivered_rate_pct": 80.0, "last_paid_test_at": "…", "record_url": "https://vet402.com/observatory/e/…" } ], "rule": "…", "method_url": "https://vet402.com/observatory/methodology#find-ranking", "window_days": 30, "as_of": "…", "license": "CC-BY-4.0" }`,
  },
  {
    method: "GET",
    path: "/api/v1/diagnose?url=https%3A%2F%2Fseller.example%2Fpaid",
    note: `Keyless read of one unpaid 402. No wallet. vet402 fetches the URL once through its SSRF guard and returns ALLOW, WARN, or BLOCK, the cheapest payable accept, and one fix line per check. method is GET or POST. ${keylessDiagnosePerMinute()} requests a minute per IP. The fetch stops at 10 seconds and 64 KB. Private addresses are refused with unsafe_target. A completed read may be cached for 60 seconds, and a shared cache may keep serving it for five more minutes while it refreshes. A failed live read is not stored. A listed URL also points at GET /api/v1/check.`,
    response: `{ "verdict": "ALLOW", "recommended_accept": { "scheme": "exact", "network": "eip155:8453", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "amount": "1000", "payTo": "0x1111111111111111111111111111111111111111", "usd_atomic": "1000" }, "checks": [ { "id": "returns_402", "status": "pass", "fix": "vet402 received HTTP 402." } ], "checked": ["returns_402"], "not_checked": [ { "id": "solana_fee_payer", "reason": "vet402 found no Solana accept to check." } ], "as_of": "2026-11-12T00:00:00.000Z", "catalog": { "listed": false, "check_url": null }, "http_status": 402 }`,
  },
  {
    method: "POST",
    path: "/api/v1/receipts/verify",
    note: "Check a verdict receipt from GET /api/v1/check or GET /api/v1/resources/:resourceId/decision. No API key. Send input_sha256, verdict, as_of, signer, and signature. vet402 rebuilds the EIP-191 message and checks it with verifyMessage. A match returns ok true. A changed field returns ok false and error invalid_signature. A field vet402 cannot read returns 400 invalid_input. The signed lines are vet402.com verdict receipt, domain: vet402.com, input sha256, verdict, as_of, and a closing line that the signature attests the verdict and moves no funds. input_sha256 is the sha256 of the canonical input in the verdict receipt section of the docs. When VET402_RECEIPT_SIGNER_KEY is unset, those routes omit receipt and the rest of the body stays as it is. 30 requests per minute per IP.",
    request: `{ "input_sha256": "<64 lowercase hex>", "verdict": "ALLOW", "as_of": "2026-11-12T00:00:00.000Z", "signer": "0x…", "signature": "0x…" }`,
    response: `{ "ok": true }`,
  },
  {
    method: "GET",
    path: "/api/v1/erc8004/check",
    note: "Keyless re-read of one ERC-8004 Reputation Registry feedback on Base. Pass chain=eip155:8453, agentId, and client or feedbackIndex. When more than one client has the same feedbackIndex, pass client too or the answer is 400 ambiguous_feedback_index. vet402 loads the on-chain feedbackURI, checks feedbackHash against the body, re-reads the payment transaction from proofOfPayment or, for vet402 weekly rollups through 2026-W46, the earliest delivered transactions[] row, and matches the recipient to vet402 state.erc8004 payTo and the agent owner or agentWallet. Payees named in the feedback JSON alone are excluded. Returns verdict verified (writer paid), verified_payment_unlinked_client (payment evidence holds but the payer cannot be tied to the writer, for example another chain or wallet; not a demerit), payment_recipient_unverified (a payment exists but vet402 could not confirm it went to the payTo or wallet of the agent; not verified and not a demerit), mismatch (feedback_hash, recipient, amount, or token conflict; reasons[] names which), no_proof (no_proof_reason no_feedback_uri when the feedback has an empty feedbackURI, or no_proof_in_feedback), or unreadable (including feedback_uri_unreadable, and feedback_log_not_found_in_time when the NewFeedback log scan times out but readFeedback succeeded, with on-chain value and tags and checks unknown), with checks (tx_exists, to_matches_agent_payTo_or_wallet, from_matches_client, amount, token, block_time, feedback_hash, optional proof_source) and sources. Stellar, Solana, and other non-EVM proofOfPayment chains are re-read when Horizon or the chain RPC allows; recipient against the agent is pass when it matches payTo or wallet, unknown when just the declared proof payee matches the ledger read on a non-EVM chain. 30 requests a minute per IP. Shared cache may serve a result for up to 30 minutes (60 seconds when unreadable_reason is feedback_log_not_found_in_time). No wallet and no on-chain writes.",
    response: `{ "verdict": "verified", "chain": "eip155:8453", "agentId": "94639", "clientAddress": "0x…", "feedbackIndex": "1", "feedback": { "tag1": "reachable", "feedbackURI": "data:…", "feedbackHash": "0x…" }, "proofOfPayment": { "txHash": "0x…", "chain": "eip155:8453" }, "checks": { "tx_exists": "pass", "to_matches_agent_payTo_or_wallet": "pass", "from_matches_client": "pass", "amount": "pass", "token": "pass", "block_time": "pass", "feedback_hash": "pass", "proof_source": "proofOfPayment" }, "sources": [], "as_of": "2026-11-17T00:00:00.000Z" }`,
  },
  {
    method: "POST",
    path: "/api/v1/payment-proof",
    note: `Keyless read of one payment receipt. No wallet. Pass paymentResponse (the seller PAYMENT-RESPONSE header, base64 JSON) or network plus transaction. vet402 reads the transaction on Base, Celo, Arbitrum One, Avalanche C-Chain, BNB Chain, Solana, Arc, Tempo, XRPL and Stellar, the chains it reads again after a purchase, and returns found, network, tx, block, from, to, asset, amount in atomic units, status (confirmed, failed, not_found, unsupported_network), explorer and as_of. A chain outside that set comes back as unsupported_network. ${keylessPaymentProofPerMinute()} requests a minute per IP. The chain read stops at ${PAYMENT_PROOF_RPC_TIMEOUT_MS / 1000} seconds. This route does not pay and does not sign.`,
    request: `{ "paymentResponse": "<base64>" }`,
    response: `{ "found": true, "network": "eip155:8453", "tx": "0x…", "block": "123", "from": "0x…", "to": "0x…", "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "amount": "10000", "status": "confirmed", "explorer": "https://basescan.org/tx/0x…", "as_of": "2026-11-12T00:00:00.000Z" }`,
  },
  {
    method: "POST",
    path: "/api/mcp",
    note: `The hosted MCP server, also at https://vet402.com/mcp. Streamable HTTP, stateless, free, no key. It reads records and makes no payment. It serves protocol revisions 2025-06-18 (with initialize) and 2026-07-28 (server/discover). Tools: check_x402_seller (what happened when vet402 paid an x402 URL, with the transaction of each attempt, verified_terms and verified_pay_to_by_network), check_my_x402_endpoint (for sellers: the catalogs a host is listed in, the latest result of each listing, failure modes with links to /sellers/fix-first and when vet402 can buy again), find_x402_sellers (same Wilson ranking as GET /api/v1/find for a query), check_payment_proof (reads a PAYMENT-RESPONSE header or a network and a transaction on the chains vet402 reads again after a purchase, at ${keylessPaymentProofPerMinute()} requests a minute per IP shared with POST /api/v1/payment-proof), and check_8004_agent (same JSON as GET /api/v1/erc8004/check, 30/min per IP shared with that route). 120/min per IP, plus 30/min per IP for find_x402_sellers and 30/min per IP for check_my_x402_endpoint (429 with JSON-RPC code -32029). GET and DELETE are 405. A request with an Origin header from another site is 403. The body is capped at 64 KB. The installable package @vet402/mcp-server also offers diagnose_x402_url. vet402 reads one unpaid 402 for a URL and does not pay and does not sign.`,
    response: `{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "structuredContent": { "not_in_catalog": false, "recommendation": "ALLOW", "reason_codes": ["l0_pass", "l1_delivered"],
      "delivery": { "paid_attempts": 3, "delivered": 3, "settled_not_delivered": 0, "last_attempt_at": "…", "window_days": 30 },
      "l1_purchases": [ { "attempted_at": "…", "network": "eip155:8453", "status": "settled", "tx_hash": "0x…", "explorer_url": "https://basescan.org/tx/0x…" } ],
      "record_url": "https://vet402.com/observatory/e/521e929e-…", "method_url": "https://vet402.com/observatory/methodology", "as_of": "…" },
    "content": [ { "type": "text", "text": "{ …the same JSON… }" } ]
  }
}`,
  },
  {
    method: "GET",
    path: "/api/v1/resolve?q=…",
    note: "Reverse lookup — no key, 60/min. q is read by shape: a URL gives its Resource (resource_id = sha256(method + \" \" + canonical_url)) and the endpoints on that host; Known limit: an id hashed from a raw URL resolves for the common spellings of a listed URL (trailing slash, host case, :443, query order, HTTPS://, a trailing ? # or //), but not for mixed-case hosts or per-request query values — resolve here first (the MCP pay_if_trusted always does); a domain its endpoints; a 0x / base58 address or a chain:address payee_id the endpoints that declare it as payTo; a tx hash the indexed settlement and, when attributed, its resource. Identifiers only — never a recommendation. A q the classifier cannot place, or a URL that is not an absolute https URL, is a 400 { error: \"invalid_query\", expected: \"q\", message, suggestion?, accepted, query } — message says what is wrong in words and suggestion is the corrected q (https:// added). Nothing on record comes back as a 200 with endpoints: [] and not_found: { reason: \"not_in_catalog\", note, next, listing_sources, documentation }. listing_sources names each source vet402 reads listings from with its sync times in UTC, and documentation links to /faq#not-listed. block_time_source on a tx settlement says which clock block_time uses: chain for a ledger time stored at verification or read from the observed purchase recorded for that verification, attempted_at for the purchase attempt when no ledger time was stored, verified_at for an older row whose block_time is the moment verification finished, null when the row names none of these clocks.",
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
    path: "/api/v1/resources/:resourceId/decision?role=payer|payee&payer=…&caller_dialect=v1|v2&allow_without_l1=false&amount_usd=…&max_per_tx_usd=1&min_l1_deliveries=0&require_vet402_allow=true",
    note: (
      <>
        {`The ledger column l2_schema stores match, mismatch, no_declaration, or not_checked. The decision document and the facts document store conform, mismatch, undeclared, or not_checked. conform is written when the re-read L2 value (l2_reading) of the latest delivery is match. mismatch is written when that re-read value is mismatch. An older mismatch row with no recorded reason is re-read first, and a cut body reads not_checked. In the other cases the decision word is not_checked when the current declaration names output (a required key or an example property), or when the purchase row of the latest delivery recorded a declaration and its re-read value is not_checked, and undeclared when neither holds. The canonical integration since 2026-09-02 (spec §8.3 / §9.1) — 1 unit per call with a key, or key-less with the same body (since 2026-09-07, at ${keylessDecisionPerMinute()}/min per IP since ${DECISION_KEYLESS_LIMIT_SINCE}; 429 rate_limited when the window is spent; Idempotency-Key and customer allow/block lists apply to keyed calls only). role=payer (default) answers "what did vet402 record when it paid this URL in the last 30 days?" from L0 liveness, L1 settle-through and L2 conformance. An ALLOW can carry l2_undeclared: the listing declared no output to compare with. role=payee answers "should this seller serve this payer?" and requires payer. facts and recommendation always arrive in the same document; the transitional score is left out of the body unless you pass include_score=1 (0 or 1; anything else is 400 invalid_include_score), and then it carries superseded_by: "recommendation" and is not the basis of the recommendation. facts.l1.last_attempt_at is when vet402 last attempted an L1 purchase against this resource (ISO 8601 UTC, null before the first attempt) — distinct from observed_at, which is when vet402 last paid. spending_halted is vet402's own spending halt: a fact about the measurer, not the seller, and while it is true the L1 facts here are not today's observation. not_attempted_reason (spending_halted | no_eligible_accept) qualifies the reason code l1_not_attempted; it is null for the other ways an attempt ends before the signature, which are published per attempt in the decision ledger rather than summarised here. ${DECISION_RULES_TEXT} ${METHOD_LIMIT_TEXT} verified_terms (since 2026-09-29, role=payer) carries the terms vet402 actually paid on the last purchase whose delivery it confirmed: pay_to, asset, amount (base units, 6 decimals), network, scheme, protocol and verified_at, or null when nothing was ever delivered, and null on XRPL until the issuer is recorded (a currency code alone cannot tell RLUSD from a look-alike). 0x addresses are lowercase. Compare it with the 402 you received before you pay: if the 402's payTo, asset, network or scheme differ from verified_terms, or its amount is higher, do not pay. An ALLOW is the fact that these terms delivered; it is not a guarantee for a different recipient or a higher price. verified_pay_to_by_network (since 2026-11-22, role=payer) lists the recipients vet402 paid and confirmed delivery to, per chain: network, pay_to, purchase_id and verified_at, one row per network and pay_to, newest first, at most 10, [] for role=payee or when nothing was delivered, and no XRPL rows (same reason as verified_terms). If the network and payTo pair of the 402 you received is not in it, vet402 has not verified the recipient on that network. Each row of evidence[] names the ledger it was observed in: evidence[].source is vet402 for vet402's own L0–L2 record (the row carries purchase_id and a public receipt URL), and subgraph for a row read from The Graph's x402 subgraph. This route emits vet402 rows; `}
        the subgraph rows are added to the same array by the{" "}
        <a
          href="https://github.com/vet402/vet402/blob/main/SKILL.md"
          target="_blank"
          rel="noopener noreferrer"
          className="doc-link"
        >
          payOrRefuse
        </a>{" "}
        SDK when the caller reads{" The Graph with their own Graph Gateway API key, and such a row carries subgraphId, block.number, deployment and queriedAt so live index data can be told apart from a static snapshot. Counts from the two sources are kept on separate rows and are not added together \u2014 they count different things. Send Idempotency-Key to retry without spending a second unit. Your own policy (role=payer, since 2026-09-07): add amount_usd (what the 402 asks), max_per_tx_usd (your ceiling, default 1) min_l1_deliveries (floor on facts.l1.n_delivered) and/or require_vet402_allow (default true, the SDK's requireVet402Allow) and the same document gains caller_policy \u2014 your rule applied server-side, in the payOrRefuse SDK's own words: verdict ALLOW | REFUSE with reason_codes price_above_ceiling, evidence_unavailable, payee_recommendation_block, payee_recommendation_not_allow or insufficient_delivery_evidence, in the SDK's order (ceiling, degraded, BLOCK, not-ALLOW, L1 floor). With require_vet402_allow=true a WARN refuses with payee_recommendation_not_allow, as the SDK's default does; false waives the WARN and needs min_l1_deliveries \u2265 1 or the call is 400 invalid_policy. It sits beside recommendation and never rewrites it; a floor or a waiver never lifts BLOCK or degraded; not_evaluated names what the server did not check (min_subgraph_receipts always \u2014 The Graph is read only with your own key). Without those queries the body is unchanged. 400 invalid_resource_id / invalid_role / invalid_caller_dialect / payer_required / invalid_amount_usd / invalid_policy / invalid_evidence_policy, 404 not_found, 503 decision_unavailable."}
        {" When VET402_RECEIPT_SIGNER_KEY is set, the body also carries receipt. POST /api/v1/receipts/verify checks it. When the variable is unset, receipt is omitted and the rest of the body stays as it is."}
      </>
    ),
    response: `{
  "subject": { "type": "resource", "id": "9a7e…", "endpoint_id": "3f1c…", "observatory_id": "521e929e-…", "canonical_url": "…", "method": "GET" },
  "role": "payer",
  "payer": null,
  "recommendation": "ALLOW",
  "reason_codes": ["l0_pass", "l1_delivered", "l2_undeclared"],
  "facts": {
    "l0": { "status": "pass", "observed_at": "…", "dialect": "v2", "fail_reason": null },
    "l1": { "n_delivered": 3, "n_settled": 3, "n_attempts": 3, "n_probe_error": 0, "p50_ms": 812, "p95_ms": 1490, "last_purchase_id": "…", "observed_at": "…", "last_attempt_at": "2026-09-04T19:02:29.789Z" },
    "l2": { "status": "undeclared", "declaration_hash": null, "response_hash": null, "diff_hash": null, "missing_keys": null, "observed_at": null },
    "availability_7d": 1, "availability_30d": 0.97, "offer_stability": "stable",
    "payees": ["eip155:8453:0x…"],
    "settlement_30d_real": 41, "settlement_30d_raw": 44, "settlement_30d_test": 3, "settlement_30d_measurement": 0,
    "unique_payers_30d_real": 9, "wash_dominated": false
  },
  "spending_halted": false,
  "not_attempted_reason": null,
  "freshness": { "l0": "…", "l1": "…", "l2": null },
  "l1_basis": { "window_days": 30, "fresh_days": 30, "n_counted": 3, "n_not_counted": 0, "n_paid_undelivered": 0, "n_paid_undelivered_since_last_delivery": 0, "latest_counted_delivered": true, "last_attempt_at": "2026-09-27T12:00:41.102Z", "last_signed_attempt_at": "2026-09-27T12:00:41.102Z", "last_delivered_at": "2026-09-27T12:00:41.102Z", "days_since_last_attempt": 1.5, "days_since_last_delivery": 1.5 },
  "verified_terms": { "purchase_id": "eip155:8453:0x…", "pay_to": "0x…", "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "amount": "10000", "decimals": 6, "network": "eip155:8453", "scheme": "exact", "protocol": "x402", "verified_at": "2026-09-27T12:00:41.102Z" },
  "verified_pay_to_by_network": [{ "network": "eip155:8453", "pay_to": "0x…", "purchase_id": "eip155:8453:0x…", "verified_at": "2026-09-27T12:00:41.102Z" }],
  "evidence": [ { "level": "L0", "url": "https://vet402.com/observatory/e/521e929e-…" }, { "level": "L1", "purchase_id": "…", "url": "https://vet402.com/api/v1/observatory/endpoints/521e929e-…/purchases" } ],
  "degraded": false,
  "policy": "allow_only",
  "caller_policy": { "applied": { "amount_usd": 1.5, "max_per_tx_usd": 1, "min_l1_deliveries": 0, "require_vet402_allow": true }, "verdict": "REFUSE", "reason_codes": ["price_above_ceiling"], "not_evaluated": ["min_subgraph_receipts"] },
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
    note: "L0–L2 seller facts for one endpoint — no key, 120/min. :id is the observatory uuid or the endpoint_id. The same facts object /decision carries, without the recommendation: this route contains no score and no verdict by design (§8.3). n_probe_error counts attempts where vet402's own request was malformed, kept apart from the seller's non-delivery; settlement_30d_test is vet402's own measurement purchases, disclosed and excluded from the wash_dominated denominator. settlement_30d_measurement counts payers on the published measurement list (wash_flag measurement) and is left out of settlement_30d_real and out of that denominator. The list is at https://vet402.com/observatory/methodology#measurement-payers. The ledger column l2_schema stores match, mismatch, no_declaration, or not_checked. The decision document and the facts document store conform, mismatch, undeclared, or not_checked. conform is written when the re-read L2 value (l2_reading) of the latest delivery is match. mismatch is written when that re-read value is mismatch. An older mismatch row with no recorded reason is re-read first, and a cut body reads not_checked. In the other cases the decision word is not_checked when the current declaration names output (a required key or an example property), or when the purchase row of the latest delivery recorded a declaration and its re-read value is not_checked, and undeclared when neither holds.",
    response: `{
  "subject": { "type": "resource", "id": "9a7e…", "endpoint_id": "3f1c…", "observatory_id": "521e929e-…", "canonical_url": "…", "method": "GET" },
  "facts": { "l0": {…}, "l1": {…}, "l2": {…}, "availability_7d": 1, "availability_30d": 0.97, "offer_stability": "stable", "payees": ["…"], "settlement_30d_real": 41, "settlement_30d_raw": 44, "settlement_30d_test": 3, "settlement_30d_measurement": 0, "unique_payers_30d_real": 9, "wash_dominated": false },
  "freshness": { "l0": "…", "l1": "…", "l2": null },
  "evidence": [ { "level": "L0", "url": "…" }, { "level": "L1", "purchase_id": "…", "url": "…" } ],
  "disclaimer": "…",
  "retrievedAt": "…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/census/summary?chain=eip155:8453&window=30d",
    note: "Settlement census — no key, 60/min, cached 5 minutes. settlements_raw counts every indexed x402-related settlement in the window; settlements_real excludes wash_flag self_deal / circular / test (including every wallet vet402 pays from) and measurement (payers on the published list of other measurement or inspection services, counted in wash.measurement). Both are always returned together and never merged. chain is CAIP-2 or a v1 slug (base, solana); omit for all chains. window is 7d or 30d. indexed_since reports how far back the index actually reaches, overall and per chain, so window_covered_days is never more than window_requested_days and the counts are a floor rather than a total whenever window_fully_covered is false. 400 invalid_window / invalid_chain.",
    responseHeading: "Example of the shape only",
    responseNote:
      "These counts are not a reading. Fetch the URL and cite retrievedAt from that response.",
    response: `{
  "chain": "eip155:8453", "window": "30d",
  "settlements_raw": "<count>", "settlements_real": "<count>",
  "wash": { "self_deal": "<count>", "circular": "<count>", "test": "<count>", "measurement": "<count>" },
  "attribution": { "confirmed": "<count>", "probable": "<count>", "unmatched": "<count>" },
  "unique_payers_raw": "<count>", "unique_payers_real": "<count>", "unique_payees_real": "<count>",
  "endpoints_with_real_settlement": "<count>",
  "by_source": { "l1_purchase": "<count>", "payments_api": "<count>", "chain_index": "<count>" },
  "indexed_since": {
    "all": "<YYYY-MM-DD>", "byChain": { "eip155:8453": "<YYYY-MM-DD>" },
    "all_chains_since": "<YYYY-MM-DD>",
    "window_requested_days": "<days>", "window_covered_days": "<days>", "window_fully_covered": "<boolean>",
    "note": "indexed_since.all is the oldest UTC day this index holds …"
  },
  "definition": "settlements_raw counts every indexed …",
  "disclaimer": "…",
  "retrievedAt": "<ISO-8601>"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/corrections?endpoint=…&reason=…&limit=100&cursor=…",
    note: "The correction log as JSON — no key, 60/min. Every published verdict that later changed: dispute_remeasure (a seller's signed dispute triggered a re-measurement that overturned it), settlement_backfill (a settlement moved up or down the ledger on on-chain evidence), reverify (a re-verification overturned it; since 2026-09-29 also a re-probe of a published L0 fail that rested on probes recorded under the earlier rules, after.trigger=rule_change_reprobe), path_template. before / after are the published values; corrections unfavourable to vet402 are listed the same way and rows are never deleted. endpoint filters by observatory uuid; reason filters by reason; limit 1–500 rows a page. Since 2026-09-29 every row can be read: page.nextCursor, passed back as cursor, returns the next older page (null on the last page), and total counts the rows matching endpoint and reason whatever the cursor — ?reason=settlement_backfill gives the 'Ledger status changes' count on /corrections. For a purchase row, subject_id is the purchase_id column of the ledger export; settlement_path names the path a settlement_backfill row took (verified_settled, claim_refuted, seller_named_tx_promoted, vet402_index_link, late_link_withdrawn, seller_named_tx_declined, other). 400 invalid_reason / invalid_cursor.",
    response: `{
  "corrections": [ { "id": "…", "subject_type": "purchase", "subject_id": "c4d4b20f-…", "level": "l1", "before": { "status": "settle_claimed" }, "after": { "status": "settled", "blockNumber": "…" }, "reason": "settlement_backfill", "dispute_id": null, "created_at": "…", "settlement_path": "verified_settled" } ],
  "total": 312,
  "page": { "limit": 100, "returned": 100, "nextCursor": "MjAyNi0w…", "order": "created_at DESC, id DESC", "howToPage": "…" },
  "totalDefinition": "…",
  "definition": "Each row is a public verdict that changed after publication: …",
  "disclaimer": "…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/l0/export.csv",
    note: "The latest public L0 verdict per endpoint, as CSV — no key, 6/min, cached up to 15 minutes. One row per endpoint on record (active or not, excluding endpoints paying vet402's own addresses): the data behind the L0 counts of /api/v1/observatory/state. Columns: endpoint_id, resource_key, network, chain, network_class (mainnet | testnet | unclassified), listed, published_verdict (pass | fail | unverified | withdrawn), latest_probe_verdict, last_probed_at, latest_probe_older_than_7d. Counting published_verdict=pass gives publishedPass. Counting published_verdict=withdrawn gives withdrawnFail, a delisted fail streak left out of publishedFail. network_class=mainnet rows grouped by chain give byChain. Definitions in the x-vet402-column-notes header, retrieval time in x-vet402-retrieved-at. Since 2026-09-29.",
    response: `endpoint_id,resource_key,network,chain,network_class,listed,published_verdict,latest_probe_verdict,last_probed_at,latest_probe_older_than_7d
521e929e-…,api.example.com/v1/x,eip155:8453,Base,mainnet,true,pass,pass,2026-09-29T10:31:02Z,false`,
  },
  {
    method: "GET",
    path: "/api/v1/sellers/export.csv",
    note: "The /sellers classification, as CSV — no key, 6/min, cached up to 15 minutes, served noindex like the page. One row per active Base listing (records opened for a seller's re-test request included), classified by its latest purchase row with the same function /sellers uses; counting rows by outcome gives the page's totals. Columns: host, endpoint_id, resource_key, outcome (delivered | pending | seller | vet402 | unsorted | not_bought | not_tried), fix_mode, side_label, confirmed_seller, held_reason, latest_attempted_at, latest_status, latest_network, latest_http_status_paid, purchase_id (the ledger export's purchase_id), in_ledger_export, attribution_review (under_review on seller rows, whose attribution is under review). Definitions in the x-vet402-column-notes header, retrieval time in x-vet402-retrieved-at. Since 2026-09-29.",
    response: `host,endpoint_id,resource_key,outcome,fix_mode,side_label,confirmed_seller,held_reason,latest_attempted_at,latest_status,latest_network,latest_http_status_paid,purchase_id,in_ledger_export,attribution_review
api.example.com,521e929e-…,api.example.com/v1/x,delivered,,,,,2026-09-29T00:02:29Z,settled,eip155:8453,200,c4d4b20f-…,true,`,
  },
  {
    method: "GET",
    path: "/api/v1/judgments/:file",
    note: "Daily judgments: one JSON per active listing, built once per UTC day from the same payer decision as key-less /decision (no score, no caller_policy). Key-less, no IP cap, CDN cache until the next UTC day. Files: index.json, index-{00..ff}.json, {resource_id}.json. CC-BY-4.0. See #judgments.",
    response: `{
  "judgment_day": "2026-11-15",
  "subject": { "type": "resource", "id": "9a7e…" },
  "role": "payer",
  "recommendation": "ALLOW",
  "reason_codes": ["l0_pass", "l1_delivered"],
  "live": "https://vet402.com/api/v1/resources/9a7e…/decision?role=payer",
  "note": "Built once per UTC day from the same record as the key-less decision. Call live for the answer as of now."
}`,
  },
  {
    method: "GET",
    path: "/api/v1/delivery/sellers.json",
    note: "Delivery feed: one row per active listing with at least one signed purchase in the last 30 days. Key-less, 30/min, process cache 300 seconds. CC-BY-4.0. Filters: network, min_delivered (0 to 100000), listed_in (bazaar | circle | mpp | operator), cursor. See /docs/mcp#feed.",
    response: `{
  "as_of": "2026-10-28T12:00:00Z",
  "window_days": 30,
  "method_url": "https://vet402.com/observatory/methodology",
  "license": "CC-BY-4.0",
  "license_url": "https://creativecommons.org/licenses/by/4.0/",
  "rate_formula": "v1.0-wilson95",
  "row_count": 1,
  "total_rows": 1,
  "next_cursor": null,
  "rows": [{
    "url": "https://api.example.com/v1/data",
    "method": "GET",
    "network": "eip155:8453",
    "price_usd": 0.007,
    "listed_in": "bazaar",
    "bazaar_payers_30d": 12,
    "paid_attempts_30d": 3,
    "delivered_30d": 2,
    "settled_not_delivered_30d": 0,
    "last_attempt_at_30d": "2026-10-27T00:00:00Z",
    "last_delivered_at_30d": "2026-10-26T00:00:00Z",
    "delivery_rate_lower_bps_30d": 3423,
    "delivery_rate_band_30d": "insufficient",
    "record_url": "https://vet402.com/observatory/e/00000000-0000-0000-0000-000000000001"
  }]
}`,
  },
  {
    method: "GET",
    path: "/api/v1/delivery/by-resource?url=",
    note: "Bazaar delivery field for one resource URL (canonicalUrl rules). Key-less, 30/min. Values match one row from the same snapshot as sellers.json. `delivery` is null when no feed row matches. Optional `method`. Spec: /docs/bazaar-delivery-field.md.",
    response: `{
  "url": "https://api.example.com/v1/data",
  "delivery": {
    "paidAttempts30d": 3,
    "delivered30d": 2,
    "settledNotDelivered30d": 0,
    "deliveryRateLowerBps30d": 3423,
    "deliveryRateBand30d": "insufficient",
    "lastAttemptAt30d": "2026-11-20T00:00:00.000Z",
    "lastDeliveredAt30d": "2026-11-19T00:00:00.000Z",
    "recordUrl": "https://vet402.com/observatory/e/00000000-0000-0000-0000-000000000001",
    "network": "eip155:8453"
  },
  "rules_version": "2026-11-13.1",
  "rate_formula": "v1.0-wilson95",
  "window_days": 30,
  "as_of": "2026-11-25T00:00:00.000Z"
}`,
  },
  {
    method: "POST",
    path: "/api/v1/delivery/annotate",
    note: "Add `delivery` to up to 100 Bazaar discovery items per request. Key-less, 30/min. Body limit 2 MiB. Same counts as by-resource for each item `resource` URL.",
    request: `{ "items": [{ "resource": "https://api.example.com/v1/data", "extensions": { "bazaar": { "info": { "input": { "method": "GET" } } } } }] }`,
    response: `{
  "items": [{
    "resource": "https://api.example.com/v1/data",
    "delivery": null
  }],
  "rules_version": "2026-11-13.1",
  "rate_formula": "v1.0-wilson95",
  "window_days": 30,
  "as_of": "2026-11-25T00:00:00.000Z"
}`,
  },
  // 2026-10-24: paths: にある公開窓口で、上のカードに path が無かったもの。
  // /api/v1/guarantee/quote は paths に無い（休眠中の金融商品）。ここにも載せない。
  {
    method: "POST",
    path: "/api/v1/events/:trustEventId/outcome",
    note: "Report a result label for a past score verdict this key requested. outcomeType is confirmed_fraud, confirmed_legitimate, chargeback_dispute, or other. Repeating the same outcomeType for the same event returns the existing row. A trustEventId this key does not own answers 404, the same answer as an unknown id. Bearer key.",
    request: `{ "outcomeType": "confirmed_legitimate" }`,
    response: `HTTP 201 when the label is new. HTTP 200 when this key already reported that outcomeType for this event.`,
  },
  {
    method: "DELETE",
    path: "/api/v1/webhooks/:id",
    note: "Remove a webhook endpoint this key owns. An id this key does not own answers 404. Bearer key.",
    response: `HTTP 200`,
  },
  {
    method: "DELETE",
    path: "/api/v1/watchlist/:id",
    note: "Remove a watch this key owns. An id this key does not own answers 404. Bearer key.",
    response: `{ "ok": true }`,
  },
  {
    method: "POST",
    path: "/api/v1/demo/verify",
    note: "One live L0 probe of a catalog-listed endpoint, for /playground. The probe is not written into the public register. level l1 asks for one real purchase and runs when DEMO_L1_ENABLED and the Observatory L1 flag are both on. While the runtime spending halt is engaged, level l1 answers 503 spending_halted and signs nothing. Key-less. 5 requests per minute per IP.",
    request: `{ "endpointId": "<uuid>", "level": "l0" }`,
    response: `HTTP 200 with the live measurement.`,
  },
  {
    method: "GET",
    path: "/api/frame/endpoint/:id",
    note: "Farcaster Frame HTML for one endpoint receipt record. An unknown id answers 404. Key-less.",
    response: `text/html`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/contributions",
    note: "Submit an externally observed L0 result. Intake answers 403 unless an operator flag is on. A stored row is not folded into a published verdict. Key-less. 10 requests per minute per IP.",
    request: `{ "endpointId": "<uuid>", "verdict": "pass", "address": "0x…", "signature": "0x…", "issued": "<RFC3339>" }`,
    response: `HTTP 201 when stored. HTTP 403 when intake is off.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/export.csv",
    note: "Paid-attempt ledger as CSV. days is an integer from 1 to 366; without it the window is the last 90 days. The ledger starts at 2026-08-14T09:54:31Z, so from 2026-11-12T09:54:31Z the default window no longer reaches its first rows; ask for days=366 to read the whole ledger. A non-canonical days value answers 308 to the canonical query. Another query parameter, or days given twice, answers 400 invalid_query. Output stops at 50000 rows and sets x-vet402-truncated. A cell whose text starts with =, +, -, @, a tab, or a carriage return is written with a leading apostrophe. Key-less. 6 requests per minute per IP. Columns in order: attempted_at, resource_key, network, status, amount_units, spent_units, tx_hash, http_status_paid, latency_ms, l2_schema, held_reason, request_body, request_body_sha256, settlement_source, request_query, request_query_sha256, confirmed_units, purchase_id, l2_reading. auth_nonce is recorded on vet402's own signed purchase rows and is absent from this export; @vet402/sdk's payment nonce is not ingested or stored.",
    response: `attempted_at,resource_key,network,status,amount_units,spent_units,tx_hash,...`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/erc8004/feedback/:purchase_id",
    note: "Off-chain ERC-8004 feedback for one vet402 purchase whose payTo matched a registered agent. Carries proofOfPayment (the same tx_hash as export.csv), the delivery result, and a flag that a 4xx after payment is not counted against the seller. Format follows ars-evidence/0.1. 404 when the purchase has no matched agent.",
    response: `{ "schema": "ars-evidence/0.1", "agentId": "eip155:8453:94639", "proofOfPayment": { "txHash": "0x…", "chain": "eip155:8453" }, "result": { "status": "settled", "delivered": true }, "sha256": "…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/erc8004/weekly/:agentId",
    note: "Weekly rollup for one matched agent: method, window, counts, and the delivered rate over settled purchases with 4xx-after-payment rows left out, plus the tx list. week=YYYY-Www (UTC Monday to Sunday). This is the document vet402 points to as feedbackURI when it writes ERC-8004 feedback.",
    response: `{ "agentId": "94639", "week": "2026-W46", "settled": 0, "delivered": 0, "inconclusive": 0, "deliveredRate": null, "txs": [] }`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/delivery.csv",
    note: `One row per settled purchase, with the three delivery values and the raw fields beside them. days follows the same rules as the ledger export (1 to 366, default 90, canonical 308, invalid_query and invalid_days otherwise). Key-less. 6 requests per minute per IP. Columns in order: ${DELIVERY_CSV_COLUMNS.join(", ")}. ${DELIVERY_VALUE_DEFINITIONS.delivered} ${DELIVERY_VALUE_DEFINITIONS.no_body_observed} ${DELIVERY_VALUE_DEFINITIONS.not_established} ${DELIVERY_CSV_BODY_BYTES_NOTE} ${DELIVERY_CSV_WHOSE_PURCHASES} ${DELIVERY_CSV_HEADER_NOTES["x-vet402-buyer"]} ${DELIVERY_CSV_HEADER_NOTES["x-vet402-as-of"]} ${DELIVERY_CSV_HEADER_NOTES["x-vet402-generated-at"]} Definitions: https://vet402.com/observatory/methodology#delivery-values`,
    response: `${DELIVERY_CSV_COLUMNS.join(",")}\n521e929e-…,2026-09-29T00:02:29Z,1200,2026-09-29T00:02:30.200Z,api.example.com/v1/x,eip155:8453,delivered,,200,5120,true,,0x…,vet402,0x…`,
  },
  {
    method: "GET",
    path: "/api/v1/graph/payto/:address",
    note: "Endpoints one payTo wallet receives on, and other payTo values receiving on the same hosts. Adjacency facts. Bearer key. 1 unit.",
    response: `HTTP 200. Graph with definition in the body.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/anchors",
    note: "One hash root per UTC day over that day's L1 rows. An older root describes the ledger as it stood when the root was computed. A missed day stays without a root and is listed in missingHeadDays as no_head_for_day. dayVerification checks the newest day that a later day links to, from the day file, the published root and the next day's prevRoot. Query days from 1 to 366, default 30. No key needed. 30 requests per minute per IP.",
    response: `HTTP 200 while the newest root is one or two days old. HTTP 503 anchors_head_stale with the same body when it is older. Anchors newest day first, with the recompute recipe.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/anchors/day",
    note: "The canonical JSON of one sealed day, byte for byte, as stored when the day was sealed. sha256 of the previous root, a newline and this body equals that day's root in /anchors and the prevRoot of the next sealed day. view=current serves the rows as they are now. A day with no sealed root answers 404 no_head_for_day. 10 requests per minute per IP. CC-BY-4.0.",
    response: `HTTP 200. The day JSON. x-vet402-day-root, x-vet402-prev-root, x-vet402-chain-root and x-vet402-day-verification headers.`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/anchors/tx",
    note: "Register a Base mainnet self-transaction that etched a sealed day root (vet402-anchor:v1 calldata). Bearer ANCHOR_POST_SECRET. Verifies receipt, self-send, signer and calldata on RPC before UPDATE. Closed when ANCHOR_POST_SECRET is unset.",
    response: `HTTP 200 { ok, day, txHash, chainId: 8453 }. 409 anchor_tx_already_set. 422 when RPC verification fails.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/nearai",
    note: "Latest NEAR AI Cloud TEE attestation re-verification: Gateway TLS binding, Intel TDX TCB status, and NVIDIA NRAS GPU results per private TEE model. Independent from the L1 purchase ledger. Before the first daily run (09:00 UTC), HTTP 200 with status no_run_yet. Out-of-date TCB with valid cryptography is advisory. PCCS or NRAS outages are unverified. No API key. 30 requests per minute per IP. CC-BY-4.0.",
    response: `{ "schemaVersion": 1, … } or { "status": "no_run_yet", "next_run_utc": "…", "models": [] }`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/nearai/anchors",
    note: "Metadata for the independent NEAR AI TEE day-root hash chain (nearai_day_roots, not mixed with L1 ledger_anchors). Day payloads at /nearai/anchors/day. No API key. 30/min.",
    response: `{ "chain": "nearai_tee", "dayEndpoint": "/api/v1/observatory/nearai/anchors/day" }`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/nearai/anchors/day",
    note: "Canonical JSON for one sealed NEAR AI TEE UTC day. Query day=YYYY-MM-DD. No API key. 30/min.",
    response: `HTTP 200. day, payload, rootHash, prevRoot, sealed.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/ledger-corrections",
    note: "Ledger corrections. Rows are added and not rewritten. Each row is self or third_party. A third_party row carries signerAddress, signature and signedMessage. signatureValid is checked again on each read, so anyone can repeat the check with no key. POST adds a row with a bearer token (self) or a signature from an allowed address (third_party). A row that cites citedRowId gets priorRowSha256, the SHA-256 of that row in the day file with view=current, read from the ledger. Filing a correction leaves the cited row as it is. CC-BY-4.0.",
    response: `HTTP 200. corrections, counts by kind, license and cite.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/traceable-by-chain",
    note: "For each of ten chains (Base, Solana, Tempo, XRPL, Celo, Arc, Stellar, BNB Chain, Arbitrum One and Avalanche C-Chain), the latest settled purchase in the same fields as the home page example, with its tx and a public explorer link. nonce_bound and amount_payee_only are separate lists, and each row names its settledTier. A Circle Gateway row inside a shared batch transaction is not listed. A chain with no such purchase is named in chainsWithoutExample. No API key. 30 requests per minute per IP. CC-BY-4.0.",
    response: `HTTP 200. chains, lists.nonce_bound, lists.amount_payee_only, chainsWithoutExample, home, moreThanHomeAlone, license and cite.`,
  },
  {
    method: "GET",
    path: "/api/v1/rwa/facts/:address",
    note: "Stock Token track record of one address on Robinhood Chain (eip155:4663), rebuilt from public chain data. The response field scope states what was scanned. Key-less.",
    response: `HTTP 200. Facts JSON. scope states the scan. gaps names what was not scanned.`,
  },
  {
    method: "GET",
    path: "/api/v1/rwa/paid/facts/:address",
    note: "The same JSON as GET /api/v1/rwa/facts/:address, paid per call over x402 v2 in USDG on Robinhood Chain (eip155:4663). Without a PAYMENT-SIGNATURE header the answer is 402. Asset 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, amount 10000 base units (0.01 USDG), payTo 0x973cD8a91A771C2C04C6036888F8175D6b4F6227, facilitator Dexter. Key-less aside from that payment header.",
    response: `HTTP 200 with the facts JSON after a valid payment. HTTP 402 with PAYMENT-REQUIRED when the header is absent.`,
  },
  {
    method: "GET",
    path: "/api/v1/rwa/paid/base/facts/:address",
    note: "The same Robinhood Chain facts JSON as GET /api/v1/rwa/facts/:address with query chain=4663, settled in USDC on Base (eip155:8453) via the Coinbase CDP x402 facilitator. EIP-3009 asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, amount 10000 (0.01 USDC), payTo 0x973cD8a91A771C2C04C6036888F8175D6b4F6227. The 402 includes extensions.bazaar for CDP discovery.",
    response: `HTTP 200 with the facts JSON after verify and settle. HTTP 402 with PAYMENT-REQUIRED when the header is absent. HTTP 503 facilitator_unconfigured when CDP credentials are missing.`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/endpoints/:id/subscribe",
    note: "Leave an email on one endpoint record. kind notify starts pending until POST /api/v1/observatory/subscriptions/confirm. Opening the confirm link changes nothing by itself. kind dispute records an objection (reason, 20 to 2000 characters) and forwards it to support. website is a honeypot and is left empty. Key-less. 5 requests per hour per IP.",
    request: `{ "email": "person@example.com", "kind": "notify", "website": "" }`,
    response: `{ "ok": true, "receipt": "<8 chars>", "kind": "notify", "verdictAtSubmission": "pass", "note": "…" }`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/subscriptions/confirm",
    note: "Confirm a pending change-notice subscription. The button on /observatory/confirm POSTs the token. Opening the email link does not confirm. The token is single-use and valid for 72 hours from the confirmation email. Key-less. 30 requests per hour per IP.",
    request: `{ "token": "<token>" }`,
    response: `{ "ok": true, "status": "confirmed" }`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/subscriptions/unsubscribe",
    note: "Stop change-notice email for one subscription. The page POSTs JSON with id and token. A mail client can POST List-Unsubscribe=One-Click with id and t in the query (RFC 8058). There is no GET. Key-less. 30 requests per hour per IP.",
    request: `{ "id": "<uuid>", "token": "<token>" }`,
    response: `{ "ok": true, "status": "unsubscribed" }`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/backtest",
    note: "vet402 signed purchase attempts, split into avoided (signalled attempts that did not settle) and forgone (signalled attempts that settled). Both figures are in the body with definition. Key-less. 12 requests per minute per IP. Cached 1 hour.",
    response: `HTTP 200. attemptsTotal, avoided, forgone, and definition.`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/disputes",
    note: "File a dispute for one endpoint. The payTo key signs an EIP-191 message over endpointId, subject (l0, l1, or listing), reason, address, and issued. issued is within 10 minutes of server time. Acceptance runs one L0 re-measurement under the publication gate. Key-less. 5 requests per minute per IP.",
    request: `{ "endpointId": "<uuid>", "subject": "l0", "reason": "…", "address": "0x…", "signature": "0x…", "issued": "<RFC3339>" }`,
    response: `HTTP 201 when accepted. HTTP 403 when the signer is not the endpoint payTo.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/disputes?tradeId=0x…",
    note: "Draft. Public JSON for one x402 auth-capture trade on Base Sepolia. tradeId is the payment info hash (0x plus 64 hex). purchaseId is rejected. vet402 lists each side's signed claim and chain facts at a fixed block on each GET. vet402 does not assign blame. The response lists the signer wallet of each claim and the payer, receiver, and operator read from the authorize call. No response bodies or headers. Key-less. Rate limited per IP.",
    response: `HTTP 200 with tradeId, draft, recordKind claims_and_chain_facts, claims (current and history per side), chainFacts, anchor, and note. HTTP 404 when no claim exists.`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/disputes/trade",
    note: "Draft. Submit or view one payer or seller claim. action submit signs the vet402 trade claim v1 text with EIP-191. Base Sepolia testnet. Submit validates the authorize tx on chain and accepts a signature from paymentInfo.payer or paymentInfo.receiver and refuses other wallets. Optional sellerReceipt on the payer claim. action view returns the current claim commitment and body hash for a verified party. Key-less. Rate limited per IP.",
    request: `{ "action": "submit", "side": "seller", "tradeId": "0x…", "chain": "eip155:84532", "paymentTx": "0x…", "paymentSeen": "yes|no", "delivery": "none|delivered", "deliveredBodySha256": "<64hex|none>", "signature": "0x…", "issued": "<RFC3339>" }`,
    response: `HTTP 201 on accept. HTTP 400 invalid_seller_receipt when the delivery receipt fails checks. HTTP 422 not_a_party when the tx fails validation, or payment_tx_not_found when the payment tx is missing on chain. HTTP 429 write_limit_reached. HTTP 409 already_recorded or stale_claim on history rules.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/disputes/day?day=YYYY-MM-DD",
    note: "Draft. One UTC day of E6 trade dispute commitments and the chained root hash. Key-less. Rate limited per IP.",
    response: `HTTP 200 with day, payload, rootHash, prevRoot, and sealed.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/live",
    note: "Server-sent events for new L0 probes and L1 purchases. The stream closes after about 55 seconds and a client reconnects with Last-Event-ID. Key-less. 10 connections per minute per IP.",
    response: `text/event-stream. Event names are probe and purchase.`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/requests",
    note: "Queue one listed endpoint for the next L0 run. Repeated requests for one endpoint stay one row. Key-less. 5 requests per minute per IP.",
    request: `{ "endpointId": "<uuid>" }`,
    response: `HTTP 201 when queued. HTTP 200 when that endpoint was already queued.`,
  },
  {
    method: "GET",
    path: "/api/v1/payees/:address/history-flags",
    note: "History predicates for one payTo wallet, with counts and definition in the body. Bearer key. 1 unit.",
    response: `HTTP 200. Flags, counts, and definition.`,
  },
  {
    method: "GET",
    path: "/api/v1/payees/:address/verdict-fast",
    note: "Deprecated. Returns a cached verdict for a payTo wallet, or cache_cold when the cache has no confident verdict. This route does not compute a fresh score. Bearer key. 1 unit.",
    response: `HTTP 200. Branch on hit or cache_cold. The body carries deprecated and deprecation.`,
  },
  {
    method: "POST",
    path: "/api/v1/waitlist",
    note: "Store an email and an interest of premium_data, design_partner, or other. This route sends no mail. Key-less. 5 requests per minute per IP.",
    request: `{ "email": "person@example.com", "interest": "premium_data" }`,
    response: `HTTP 201 when recorded.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/decisions",
    note: "Pay-or-refuse decisions recorded by the scheduled L1 run. Refusals before signing and outcomes after paying are both included. budget_denied, halted, request_error, in_flight, and payer_unfunded are left out. Query days from 1 to 366, default 30. Key-less. 30 requests per minute per IP. Cached 15 minutes.",
    response: `HTTP 200. Decision rows newest first, with totals and the cumulative backtest.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/concentration",
    note: "Receiving-structure aggregates over the active catalog, with denominators. No host or payTo is named. Key-less. 12 requests per minute per IP. Cached 1 hour.",
    response: `HTTP 200. Aggregates with definition in the body.`,
  },
  {
    method: "GET",
    path: "/api/v1/v4/delivery-hit-rate-yardstick",
    note: "Pre-registered delivery hit rate yardstick: minSample, ledger train or eval dates, fixedAt. Not Gate2 PMF counts. Key-less. 60 requests per minute per IP.",
    response: `HTTP 200. fixedAt, minSample, timeSplit, license, cite.`,
  },
  {
    method: "GET",
    path: "/api/v1/v4/named-buyer-delivery-forecast?snapshotDate=YYYY-MM-DD&resourceKey=…",
    note: (
      <>
        F4 v1 dated delivery forecast (<span lang="ja">名乗る買い手の場合</span>). Training rows come from Stellar
        roots day snapshots on or before snapshotDate. Key-less. 60 requests per minute per IP.
      </>
    ),
    response: `HTTP 200. snapshotDate, resourceKey, text, trainCount, deliveryRate.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/history",
    note: "L0 and L1 aggregates per UTC day and CAIP-2 chain, oldest day first. l1Attempts uses the paid-attempt denominator of /api/v1/observatory/state. Query days from 1 to 366, default 30. Key-less. 30 requests per minute per IP.",
    response: `HTTP 200. days, coverageFrom, rolledUpThrough, lastRollupAt, recomputeWindowDays.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/state",
    note: "Aggregate L0 and L1 measurements, from the same readers as /observatory/state. On each byChain row, chain stays the join key. label is the public chain name and network is the CAIP-2 id. withdrawnFail counts catalog-delisted endpoints whose newest probes would publish as fail, and those endpoints are left out of publishedFail. Key-less. 30 requests per minute per IP.",
    response: `HTTP 200. publishedPass, publishedFail, withdrawnFail, publishedUnverified, and l1.byChain with chain, label, and network.`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/watch?wallet=0x…",
    note: "Preview the message this key has signed by the receiving wallet, plus the catalog endpoints paying that wallet. Fetch this message and sign it. Do not build the message locally. Bearer key.",
    response: `{ "message": "…", "endpointsPayingThisWallet": [] }`,
  },
  {
    method: "POST",
    path: "/api/v1/observatory/watch",
    note: "Register for endpoint.delisted events on a payee wallet this key has claimed. The body carries the wallet and the EIP-191 signature from the GET preview. Up to 20 wallets per key. Bearer key.",
    request: `{ "wallet": "0x…", "signature": "0x…" }`,
    response: `{ "ok": true, "wallet": "0x…" }`,
  },
  {
    method: "DELETE",
    path: "/api/v1/observatory/watch",
    note: "Remove this key's observatory watch on a wallet. Bearer key.",
    request: `{ "wallet": "0x…" }`,
    response: `{ "ok": true }`,
  },
  {
    method: "GET",
    path: "/api/v1/observatory/endpoints/:id/purchases",
    note: "L1 receipt series for one endpoint: attemptCount, settledCount, and the tx hash on a settled row. The record page reads the same series. Key-less. 30 requests per minute per IP. Cached 10 minutes.",
    response: `HTTP 200. endpointId, resourceKey, attemptCount, settledCount, and the purchase rows.`,
  },
  {
    method: "GET",
    path: "/api/v1/accuracy",
    note: "The public accuracy ledger as JSON over a rolling 90-day window. Aggregate counts, with no wallet addresses and no agent ids. Key-less.",
    response: `HTTP 200. AccuracyReport, including l0, slo, and coverageWeekly.`,
  },
  {
    method: "GET",
    path: "/api/demo/score",
    note: "Scores one agent chosen server-side, so a caller can see a computed verdict with no key. The request does not choose the agent. When a verdict cannot be computed the body says live false. 10 requests per minute per IP.",
    response: `HTTP 200. Branch on live. A cached value names cacheExpiresAt.`,
  },
  {
    method: "GET",
    path: "/api/badge/:address",
    note: "SVG badge stating whether a signed payee claim exists. The badge carries no score. A .svg suffix on the address is accepted. Key-less. 60 requests per minute per IP.",
    response: `image/svg+xml`,
  },
  {
    method: "GET",
    path: "/api/badge/agent/:agentId",
    note: "SVG badge for an ERC-8004 agent. A claim exists or it does not, and the badge carries no score. A .svg suffix on the agent id is accepted. Key-less. 60 requests per minute per IP.",
    response: `image/svg+xml`,
  },
  {
    method: "GET",
    path: "/api/badge/endpoint/:id.svg",
    note: "SVG receipt badge for one x402 endpoint. The text states paid attempts that settled against paid attempts. An unknown endpoint still answers HTTP 200 with a not-yet-measured badge. The .svg suffix is part of the path. Key-less. 60 requests per minute per IP.",
    response: `image/svg+xml`,
  },
  {
    method: "GET",
    path: "/api/badge/host/:host.svg",
    note: "SVG receipt badge for one seller host. Counts settled paid calls in the last 30 days and how many returned HTTP 2xx other than 202, grouped across listings on that host. Hosts on /sellers return HTTP 200; others return 404. Zero settled rows in the window still return 200 with a no-calls line. The .svg suffix is part of the path. Key-less. 60 requests per minute per IP.",
    response: `image/svg+xml`,
  },
  {
    method: "GET",
    path: "/api/transparency/operator-overrides",
    note: "Public log of global operator blacklist actions. Each row has wallet, action, reason, and created_at. Customer-scoped lists are not in this response. Key-less.",
    response: `{ "overrides": [], "count": "<count>", "note": "…" }`,
  },
  {
    method: "GET",
    path: "/api/v1/reports/:month",
    note: "Frozen UTC-month purchase ledger summary: row count, period, contentSha256, and frozen_at. The hash covers the stored CSV body (no header row) with the same columns as the default export; rows are sorted by attempted_at as a second-precision ISO string, then purchase_id (the live export orders by full attempted_at first). Key-less. 120 requests per minute per IP.",
    response: `HTTP 200 when frozen. HTTP 400 invalid_month or month_not_closed. HTTP 404 not_frozen_yet. HTTP 503 unavailable.`,
  },
  {
    method: "GET",
    path: "/api/v1/reports/:month.csv",
    note: "Frozen CSV body for one UTC month (no header row; same bytes that contentSha256 hashes). Key-less. 120 requests per minute per IP.",
    response: `text/csv. HTTP 400 invalid_month or month_not_closed. HTTP 404 not_frozen_yet. HTTP 503 unavailable.`,
  },
  {
    method: "GET",
    path: "/api/v1/usage/monthly",
    note: "Decision call counts made with a key, for one published chain and one closed UTC month. Figures come from keyed decision rows and are stored on the first read after 00:00 UTC on the 3rd day of the next month. Answers are summed by relation. A labeled relation shows the number of owners. Fewer than 3 owners shows <3 and leaves the call count out. An unclassified relation leaves the call count out. Key-less call counts by network are kept in client_usage_daily_network and are not listed in this table. The response leaves out the key, the email address, and the name. chain eip155:42220 is published. month is YYYY-MM from 2026 through 2100. Key-less. 60 requests per minute per IP.",
    response: `HTTP 200. chain, month, relations. HTTP 400 when chain or month is missing, unreadable, outside 2026 through 2100, still open, or not yet at the 3rd day of the next month. HTTP 503 when the usage tables could not be read.`,
  },
  {
    method: "GET",
    path: "/api/health",
    note: "Liveness for an uptime poller. The public body is {\"status\":\"ok\"}, degraded, or error, from a probe of both scoring engines. degraded and error answer HTTP 503. ?deep=1 returns per-check detail and requires the admin bearer token. Without that token it answers 403. The plain call is key-less.",
    response: `HTTP 200 when the status is ok. HTTP 503 when the body is degraded or error.`,
  },
  {
    method: "GET",
    path: "/api/v1/health",
    note: "Same handler and response as GET /api/health for monitors that assume a /api/v1/ prefix.",
    response: `Same as GET /api/health.`,
  },
];

export function apiEndpointId(ep: Pick<ApiDocEndpoint, "method" | "path">): string {
  return `${ep.method}-${ep.path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}



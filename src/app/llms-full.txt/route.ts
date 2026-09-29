import { FAQS } from "@/components/site/faq-data";
import { getAllPosts } from "@/lib/blog";
import {
  OBSERVATORY_VOCABULARY,
  VOCABULARY_GROUP_LABELS,
} from "@/lib/observatory/vocabulary";
import { SITE_URL } from "@/lib/site-url";
import { FRESHNESS_LEAD, freshnessLines } from "@/lib/observatory/freshness";

export const dynamic = "force-static";

/**
 * llmstxt.org optional companion: the full citable text, generated from the
 * same modules the HTML pages render so a second copy cannot drift.
 */
export function GET() {
  const posts = getAllPosts();
  // 2026-09-05 LLMO: 語彙は /observatory/methodology §10 と DefinedTermSet
  // JSON-LD と同じ配列から出す。ここに転記すると片方だけ直る日が来る。
  const vocabulary = (Object.keys(VOCABULARY_GROUP_LABELS) as (keyof typeof VOCABULARY_GROUP_LABELS)[])
    .map((group) => {
      const terms = OBSERVATORY_VOCABULARY.filter((t) => t.group === group)
        .map((t) => `- \`${t.term}\` — ${t.definition}`)
        .join("\n");
      return `### ${VOCABULARY_GROUP_LABELS[group]}\n\n${terms}`;
    })
    .join("\n\n");
  const faq = FAQS.map((item, i) => `### ${i + 1}. ${item.question}\n\n${item.answer}`).join("\n\n");
  const blog = posts
    .map((post) => {
      const note = post.editorsNote ? `\n\n_${post.editorsNote}_\n` : "";
      return `## ${post.title}\n\nPublished ${post.publishedAt}. Updated ${post.updatedAt}.\nCanonical: ${SITE_URL}/blog/${post.slug}${note}\n\n${post.body.join("\n\n")}`;
    })
    .join("\n\n---\n\n");

  const body = `# vet402 — full source for language models

> Independent verification of the x402 agent-payment economy. This file is generated from the same FAQ and blog modules the HTML pages use. For the index of live endpoints, cite ${SITE_URL}/llms.txt. For current measurements, cite ${SITE_URL}/observatory and ${SITE_URL}/observatory/methodology — do not invent rates that are not on those pages.

The production URL is ${SITE_URL}. Formerly named "Vouch"; renamed to vet402 in August 2026.

## Verification levels (published methodology)

- L0 Liveness — does the endpoint answer correctly? Probe, no purchase. Output: pass / fail / unverified.
- L1 Settle-through — does payment settle and a response arrive? Real purchase. Output: n of m settled, n delivered, latency. settled = vet402 re-read the transfer on-chain; delivered = settled AND the paid request answered 2xx. A settled attempt that answered 4xx or 5xx moved money without returning the thing being sold, and is never reported as delivered.
- L2 Conformance — does the response match the seller's own declaration? Purchase plus machine diff. Output: match / mismatch / no_declaration / not_checked (the canonical set, and what the ledger column l2_schema stores).
- L3 Quality — is the content any good? Published rubric. Output: opinion, never mixed into an L0–L2 fact. L3 is not built; no opinion is published.

A result is labelled by the level that produced it and never moves up a level. The 0–100 ALLOW / WARN / BLOCK score is a different, older API and is never reported as an L0–L2 result.

## Vocabulary (published methodology)

Every word vet402 publishes measurements in, one sentence each. Canonical page: ${SITE_URL}/observatory/methodology#vocabulary — the sections above that index expand each term in context.

${vocabulary}

## FAQ

${faq}

## Blog

${blog}

## Machine endpoints

- ${SITE_URL}/llms.txt — index
- ${SITE_URL}/openapi.yaml — OpenAPI 3.1
- ${SITE_URL}/blog/rss.xml — blog RSS
- ${SITE_URL}/api/v1/accuracy — accuracy ledger JSON (caveats in the payload)
- ${SITE_URL}/api/v1/resolve?q= — reverse lookup (URL / domain / address / tx / payee_id → object ids), no key
- ${SITE_URL}/api/v1/resources/{resourceId} — one Resource with payees and links, no key
- ${SITE_URL}/api/v1/resources/{resourceId}/decision — facts + ALLOW / WARN / BLOCK in one document, key-less at 10/min per IP (same body with a key); the transitional score is left out unless include_score=1 (then superseded_by: "recommendation"); every reason code is explained at ${SITE_URL}/docs/api#reason-codes; rules 2026-09-29.3: an L1 BLOCK needs money to have moved — a payment settled with no non-empty 2xx back after the last delivery is l1_paid_not_delivered (once WARN, twice BLOCK); a failure where no money moved counts when /sellers puts it on the seller's side (two different UTC days) and is a WARN at most (l1_never_delivered is WARN), otherwise it is left out (l1_not_counted_unproven, l1_not_counted_unconfirmed); an empty 2xx with no settlement linked yet is l1_empty_2xx_settlement_unknown, a WARN until it settles (then l1_paid_not_delivered); l2_mismatch is BLOCK when the evidence names missing keys, else l2_mismatch_unexplained and WARN (vet402 reads the first 16,000 bytes of a paid body), l1_latest_failed is WARN, ALLOW needs a delivery within 30 days (else WARN l1_stale), one failed L0 probe is WARN only when the listing is active, the probe before it passed and it is at most 120 hours old (else BLOCK l0_unverified_single_fail_unconfirmed), two consecutive are BLOCK, and l1_basis carries the counts and times; verified_terms (since 2026-09-29) carries the pay_to, asset, amount (base units, 6 decimals), network and scheme vet402 paid on the last purchase whose delivery it confirmed (null on XRPL until the issuer is recorded; 0x addresses lowercase) — if the 402 you received has a different payTo, asset, network or scheme, or a higher amount, do not pay; add amount_usd / max_per_tx_usd / min_l1_deliveries / require_vet402_allow (default true: a WARN refuses with payee_recommendation_not_allow; false waives it and needs min_l1_deliveries >= 1) to get caller_policy (your rule applied server-side, SDK words: price_above_ceiling, evidence_unavailable, payee_recommendation_block, payee_recommendation_not_allow, insufficient_delivery_evidence)
- ${SITE_URL}/api/v1/endpoints/{endpointId} — one Endpoint (sha256 id or observatory uuid), no key
- ${SITE_URL}/api/v1/endpoints/{endpointId}/payees — endpoint → payees[], no key
- ${SITE_URL}/api/v1/payees/{address}/endpoints — payee → endpoints[], no key
- ${SITE_URL}/api/v1/observatory/endpoints/{id}/facts — L0–L2 seller facts, no score, no key
- ${SITE_URL}/api/v1/census/summary — settlements raw and real side by side, no key
- ${SITE_URL}/api/v1/observatory/corrections — correction log as JSON, no key; every row readable through page.nextCursor (?cursor=), total counts the rows matching endpoint and reason
- ${SITE_URL}/api/v1/observatory/export.csv — L1 purchase ledger as CSV, no key; purchase_id joins a row to its correction rows
- ${SITE_URL}/api/v1/observatory/l0/export.csv — latest public L0 verdict per endpoint as CSV (the data behind the state L0 counts), no key
- ${SITE_URL}/api/v1/sellers/export.csv — the /sellers classification per active Base listing as CSV (counting by outcome gives the page totals), no key
- ${SITE_URL}/observatory — L0/L1/L2 register

## Freshness

The measurement schedule is in the Freshness section of ${SITE_URL}/llms.txt. How old a copy of each surface can be:

- ${FRESHNESS_LEAD}
${freshnessLines().map((l) => `  ${l}`).join("\n")}

Cite with the page URL and a retrieval date. Content current as of 2026-09-29.
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

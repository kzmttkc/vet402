import { KEYLESS_READ_STOP, keylessDecisionPerMinute } from "@/lib/api/keyless-limits";

/** Body copy for /x402/check-a-seller (HTML and .md share these strings). */
export const CHECK_SELLER_SECTIONS = {
  checkByUrl: {
    title: "Check by URL",
    body: `GET /api/v1/check?url= returns what vet402 recorded when it paid that x402 URL, including recommendation, delivery, verified_terms, and recent purchases. It needs no API key and shares the per-IP limit with /api/v1/resolve. ${KEYLESS_READ_STOP} Shapes are in the API reference at https://vet402.com/docs/api.`,
  },
  readDecision: {
    title: "Read the decision",
    body: `When you already hold a resource_id, GET /api/v1/resources/{resourceId}/decision returns the L0, L1, and L2 facts for that resource, with an ALLOW, WARN, or BLOCK recommendation. While keyless reads are on, the route answers with no API key, at ${keylessDecisionPerMinute()} requests a minute per IP. Reason codes and verified_terms travel in the same document.`,
  },
  purchaseRecord: {
    title: "Read a purchase record",
    body:
      "An observatory endpoint page lists the purchases vet402 made, with the chain, the HTTP status, and the settlement vet402 re-read. Start from the observatory or from State of x402. Sellers on Base can open their own results at /sellers.",
  },
  compareTerms: {
    title: "Compare the terms",
    body:
      "verified_terms carries pay_to, asset, amount, network, and scheme from the last purchase whose delivery vet402 confirmed. Compare those fields with the 402 in hand. A higher amount, or a different recipient, asset, network, or scheme, is a different offer from the one that was delivered. On XRPL, verified_terms is null. The recommendation records past purchases. vet402 does not insure a payment, hold customer funds, or refund one. The 0 to 100 score is an older API. A score is a separate signal from an L0 to L2 result, as the FAQ states.",
  },
} as const;
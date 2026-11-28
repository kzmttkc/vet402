import { SITE_URL } from "@/lib/site-url";
import { L1_WINDOW_DAYS } from "@/lib/decision/rules";

/** Body copy for /x402/trust-score (HTML and .md share these strings). */
export const TRUST_SCORE_PAGE = {
  path: "/x402/trust-score",
  title: "x402 trust score: what vet402 publishes instead",
  description:
    "vet402 deprecated its 0 to 100 trust score in September 2026. In its place vet402 publishes delivery facts from its own paid purchases and an ALLOW, WARN, or BLOCK recommendation.",
  lead: [
    "vet402 deprecated its own 0 to 100 trust score in September 2026 and does not report that number as a measurement.",
    "Instead, vet402 pays x402 sellers with its own funds, records whether each paid call delivered, and answers GET /api/v1/check and GET /api/v1/resources/{resourceId}/decision with ALLOW, WARN, or BLOCK.",
  ] as const,
  sections: {
    discontinued: {
      title: "Why vet402 shows no 0 to 100 score",
      body: `The September 2026 editor's note on the blog post Why agent-to-agent payments need a trust score marks the score it describes as deprecated. The methodology page keeps a 0 to 100 score apart from L0 to L2 results, so vet402 does not print a score as a measurement.`,
    },
    delivered: {
      title: "What delivered means",
      body:
        "Delivered means a settled purchase whose paid request answered HTTP 2xx other than 202 Accepted, with a non-empty body. That is the same rule as the methodology page and State of x402.",
    },
    counts: {
      title: "Delivery counts and dates",
      body:
        "For a seller URL, GET /api/v1/check returns delivery.paid_attempts, delivery.delivered, and delivery.settled_not_delivered in a rolling window, plus as_of with the read time. Headline L1 totals and l1.byChain rows live on /api/v1/observatory/state with retrievedAt as the date to cite.",
    },
    verify: {
      title: "How to verify",
      body: `Compare the 402 in hand with verified_terms from the last delivered purchase. Read the purchase rows in l1_purchases or on the observatory endpoint pages. MCP check_x402_seller returns the same document. Full steps are on ${SITE_URL}/x402/check-a-seller.`,
    },
    window: {
      title: "Freshness",
      body: `ALLOW needs a delivery within ${L1_WINDOW_DAYS} days on the decision path. Stale delivery moves the recommendation toward WARN (l1_stale). Counts on this site come from the public ledger read. Cite retrievedAt or as_of with each figure.`,
    },
  },
} as const;
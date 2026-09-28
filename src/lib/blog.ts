export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  /**
   * 検索結果に出す <title> と meta description（2026-09-28 SEO 監査）。表題 60 字・説明 160 字を
   * 超える記事にだけ持たせる。記事の見出し（H1）と一覧の文は書いたままにする —— 公開済みの記事を
   * 検索の都合で書き換えない。無ければ title / description をそのまま使う。
   */
  seoTitle?: string;
  seoDescription?: string;
  publishedAt: string; // ISO date
  updatedAt: string; // ISO date
  /**
   * Editorial note rendered above the body (italic). Used for corrections or
   * context added after publication — the body itself stays as written.
   */
  editorsNote?: string;
  /** Plain paragraphs, rendered in order. Keep server-renderable (no client-only content). */
  body: string[];
};

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "what-is-x402",
    title: "What is x402? The HTTP status code that waited 28 years for a job",
    description:
      "What is x402? It's the machine-payment protocol that finally gave HTTP 402 Payment Required something to do — letting an AI agent pay for an API call in a single request. Here's how it works, where it stands today, and the one thing it deliberately doesn't tell you.",
    seoTitle: "What is x402? The HTTP code that waited 28 years",
    seoDescription:
      "x402 gives HTTP 402 Payment Required a job: an AI agent pays for an API call in a single request. How it works, where it stands, and what it doesn't tell you.",
    publishedAt: "2026-08-13",
    updatedAt: "2026-08-13",
    body: [
      "When the web was young, its designers left a door open and never built the room behind it. HTTP 402 Payment Required has been reserved in the specification since the 1990s — a status code with a name, a number, and no agreed meaning. For most of three decades it sat unused: there was no standard way for a server to say \"pay me\" and no standard way for a client to answer. Browsers had cookies and logins and, eventually, checkout pages, but the protocol itself never learned to charge for a request. 402 was a placeholder waiting for a use case that hadn't arrived yet.",
      "x402 is what finally gave that status code a job. It is a machine-payment protocol built directly on HTTP 402. The flow is deliberately small: a caller requests a paid endpoint, the server responds with 402 and a set of payment terms, the caller pays, and then retries the same request with proof of that payment attached. On the second try the server sees the proof and returns the actual content. No account to create, no invoice to reconcile, no human clicking approve. The request and the payment travel in the same protocol that already moves everything else on the web.",
      "The mechanics underneath are worth naming, because \"pay on-chain and re-send\" glosses over the part that makes it fast. The payment terms arrive as an accepts array in the 402 body — each entry a concrete option: a scheme, a network, an amount, a recipient. The retry does not make a second, separate blockchain round trip; it carries the payment in an X-PAYMENT header, and for the common scheme that payload is an EIP-3009 transferWithAuthorization the payer signs off-chain, so settlement needs no gas from them and no prior token approval. A facilitator service verifies that authorization and submits it on-chain on the server's behalf — which is why an API provider can accept x402 without running a node or holding a wallet in the request path.",
      "That is a strange thing to want until you picture who is doing the calling. The caller x402 was built for is usually not a person — it is an AI agent hitting an API on its own, dozens or thousands of times, faster than any manual approval flow could keep up with. Card rails assume a human on one side: a billing relationship set up in advance, a statement reviewed later, a chargeback available if something goes wrong. Agent-to-agent commerce has none of that patience. An agent needs to discover a price and settle it inside a single round trip, the same way it would follow a redirect. x402 makes payment a property of the request rather than a relationship negotiated around it.",
      "This is no longer a thought experiment. As of 2026-08-12, agenteconomy.to reports roughly $41.28M in cumulative x402 settlement, with organic daily volume around $28K. The traffic is also volatile in a way worth noticing: transaction counts have swung from a peak near 3.8 million in a day down to 7,320 on 2026-08-12. So the protocol is real and in use, but the shape of that use is still forming — which is exactly the moment to be precise about what x402 does and does not carry.",
      "Here is the part that gets glossed over. x402 gives a server proof of payment. It says nothing about proof of delivery, and it says nothing about who the wallet on the other side actually is. A brand-new address with zero history looks identical, at the protocol level, to an address that has cleanly settled thousands of legitimate calls. For a human-run service that ambiguity is usually survivable, because reputation and chargebacks act as a backstop. On-chain settlement removes that backstop by design: a paid x402 request is irreversible. There is no chargeback to file. And because the payment happens before the content is returned, the party who eats the loss when a deal goes wrong is the buyer — the agent that already paid. Speed and finality are the whole selling point, but they also mean the usual safety net is simply gone.",
      "Two data points show why \"the wallet paid\" is a weaker signal than it sounds. A 2026-07 analysis by Visa and Artemis, \"Agentic Payments from the Ground Up\" (base date 2026-04-21), attributes 38.5% of x402 traffic to wash and test activity combined — payments that move value without representing a genuine buyer-seller exchange. (The report gives the combined figure; it does not break down how much is wash versus test.) Separately, on the identity side, a 2026 study (arXiv:2606.26028) of the ERC-8004 agent-identity standard found roughly 173,000 registered agents but only about 3-15% showing real activity, and transaction-backed feedback on under 1.3% of them. Registration is cheap; a track record is not. Being registered, and even having paid before, is not the same as being worth paying.",
      "So, does x402 matter to you? If you run an API and want machines to be able to buy from it without a signup funnel, x402 is the mechanism that makes that possible today. If you are building an agent that needs to pay its own way through the tools it uses, x402 is how it will settle those bills. And if you are doing either of those things at machine speed, the gap above becomes your problem: you are auto-accepting or auto-sending irreversible payments to counterparties you have never met, with no way to claw one back.",
      "That gap is the reason vet402 exists. Given a wallet address or an ERC-8004 agent ID, vet402 returns a trust score, a recommendation, and the underlying signal breakdown — identity, reputation, wallet history, x402 payment history, and sybil-risk indicators — meant to be checked in the request path, before a payment settles rather than after. It does not make x402 slower or add a human back into the loop; it turns \"unknown wallet, decide now\" into \"wallet with a stated history and risk tier, decide now.\" A score is a signal, not a guarantee — but at machine speed, having one before you pay is the difference between a default you can defend and a coin flip.",
    ],
  },
  {
    slug: "why-agent-payments-need-a-trust-score",
    title: "Why agent-to-agent payments need a trust score",
    description:
      "x402 lets an AI agent pay for an API call in one HTTP round trip, but it says nothing about whether the wallet on the other end is worth paying. Here's the gap vet402 fills, and how the score is built.",
    seoDescription:
      "x402 lets an AI agent pay for an API call in one HTTP round trip, but says nothing about whether the wallet on the other end is worth paying. What vet402 adds.",
    publishedAt: "2026-07-21",
    updatedAt: "2026-07-21",
    // 2026-08-13 rename: the note is the only rename-era addition. The body
    // below predates the rename and is kept as written (historical record) —
    // do not swap "Vouch" for "vet402" inside it.
    editorsNote:
      "Editor's note (August 2026): Vouch has been renamed vet402. This post predates the rename and is preserved as written.",
    body: [
      "x402 solves a narrow, real problem: an agent hits a paid endpoint, gets a 402 Payment Required response with a price, pays on-chain, and retries the request with proof of payment attached. No account, no invoice, no human in the loop. That's the whole point — it's built for machines transacting with machines at a pace no manual approval flow could keep up with.",
      "What x402 does not solve is whether the wallet on the other side of that payment has any track record. A brand-new address with zero history looks identical, at the protocol level, to an address that has settled thousands of legitimate API calls. For a human-run service, that ambiguity is usually fine — chargebacks and reputation exist as a backstop. For an API provider auto-accepting payments from unknown agent wallets at machine speed, it isn't. The failure mode isn't theoretical: sybil wallets, drained faucets, and agents proxying payments through disposable addresses are all cheap to generate and expensive to distinguish from good-faith traffic after the fact.",
      "Vouch computes a trust score for a wallet or an ERC-8004-registered agent ID on Base, and returns it through a single API call: GET /api/v1/wallets/{address}/score, or GET /api/v1/agents/{agentId}/score if the agent has an on-chain identity. The response includes a numeric trustScore, a recommendation (ALLOW / WARN / BLOCK-equivalent tiers), and the underlying signal breakdown — identity, reputation, wallet history, x402 payment history, and sybil-risk indicators — so a caller isn't just trusting a black-box number.",
      "The x402 payment history signal is worth calling out specifically, because it's the one that compounds. Every time a payment settles through Vouch's attestation endpoint (POST /api/v1/payments/x402), that wallet's track record grows. A wallet that has cleanly settled 200 prior x402 payments across different providers looks meaningfully different from one making its first call — and that difference is exactly the information a 402 response alone can't carry.",
      "None of this makes a score a guarantee. The API response says so explicitly: scores are informational only and don't constitute a credit assessment or legal certification. What they do is turn \"unknown wallet, decide now\" into \"wallet with N prior settlements and a stated risk tier, decide now\" — which is enough for most providers to set a sane default (auto-allow above a threshold, hold for review below it) instead of choosing between blocking everyone or blocking no one.",
    ],
  },
];

export function getAllPosts(): BlogPost[] {
  return [...BLOG_POSTS].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}

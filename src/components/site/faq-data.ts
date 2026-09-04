/**
 * FAQ の設問と答え。/faq が描画し、LP が Q1（x402 とは何か）を引用する。
 *
 * 2026-08-13 UX監査R1: LP は "x402" を12回使って一度も定義していなかった
 * （実測: 定義 0回）。この分野を知らない読者は最初の段落で降りる。定義は
 * 既に /faq の Q1 に承認済みの文章として在ったので、新しいコピーを書かずに
 * ここへ出して LP から引用する。2箇所に同じ文が転記されると片方だけが
 * 直る日が来るので、正典はこのファイル1つにする。
 *
 * 中身は /faq が持っていたものと1文字も変えていない。
 */
export type FaqItem = { question: string; answer: string };

export const FAQS: FaqItem[] = [
  {
    question: "What is x402?",
    answer:
      "x402 is a machine-payment protocol built on the HTTP 402 \"Payment Required\" status code. An API returns 402 with payment terms, the caller (often an AI agent) pays on-chain, and retries the request with proof of payment attached. There's no account, no invoice, and no human approving the transaction — which is what makes it fast for agent-to-agent commerce, and also what makes it blind: the provider sees the payment only after it has already settled.",
  },
  {
    question: "What is ERC-8004?",
    answer:
      "ERC-8004 is an Ethereum standard for on-chain agent identity and reputation. It gives an autonomous agent a registered identity (an agent ID) that can accumulate reputation signals over time, separate from any single wallet address. vet402 reads ERC-8004 identity and reputation data — alongside raw wallet activity — as one of the signal groups behind a trust score.",
  },
  {
    question: "What does vet402 actually compute?",
    answer:
      "Given an ERC-8004 agent ID or a wallet address, vet402 returns a trust score (0-100), a recommendation (ALLOW / WARN / BLOCK), and the underlying signal breakdown: identity, reputation, wallet history, x402 payment history, and sybil-risk indicators. It's meant to be checked in the request path — before you accept a payment or complete a transaction — not reviewed after the fact.",
  },
  {
    question: "Is a vet402 score a guarantee or a credit assessment?",
    answer:
      "No. Scores are informational signals derived from public on-chain data and ERC-8004 records. They do not constitute a guarantee, a credit assessment, KYC, or legal certification of any counterparty. Every API response that carries a score or a published rate includes this disclaimer directly in the payload, so it travels with the data.",
  },
  {
    question: "Who is vet402 for — agents, or the providers agents pay?",
    answer:
      "Primarily the agent developer who is about to pay an x402 endpoint and wants to know, before the money moves, whether that endpoint actually settles and delivers — the observatory's L0/L1/L2 facts and the decision API exist for that call. The other direction is served too: an x402 API provider that accepts payment from agents it has never seen can check the payer's score first. The API doesn't assume which side of the transaction is calling it.",
  },
  {
    question: "Is there an established competitor doing this already?",
    answer:
      "Not as a dedicated category yet. x402 and ERC-8004 only shipped in 2025, so \"score a payee before an agent pays them, specifically for x402 machine payments\" isn't a shelf with incumbents on it the way wallet AML screening or credit scoring is. General crypto wallet-risk tools score addresses for sanctions and fraud exposure, not for x402 payment trust; general agent-identity and reputation projects don't yet gate a payment decision in the request path. Independent measurement of x402 is not empty, and it would be wrong to imply it is: probe402 is a dedicated x402 observatory that probes a catalog of its own (16,118 endpoints as of 2026-09-04), and on 2026-09-03 it published a finding about vet402's own probe cadence that was correct. What vet402 does that we have not found elsewhere is buy from the endpoint with its own funds and publish the receipt, so the record is settle-through evidence rather than liveness alone. There's no incumbent to unseat on the paid-decision side, but that also means the need is still being proven out as x402 transaction volume grows, not a solved problem we're improving on.",
  },
  {
    question: "Does vet402 take custody of funds?",
    answer:
      "No. vet402 never holds, moves, or has signing authority over customer funds: there is no wallet you deposit into, no balance we hold for you, and no key of yours we can sign with. vet402 does spend its own funds — the observatory's L1 layer buys from x402 endpoints with an operator wallet, which is the whole point of a settle-through record — so \"we touch no money at all\" would be false. The SDK's SpendGuard module (non-custodial) helps an agent apply spend policy locally before it pays; the scoring API itself only returns scores and records settlement attestations after a payment has already happened on-chain.",
  },
  {
    question: "Which chain does vet402 support?",
    answer:
      "Scoring (the 0–100 ALLOW / WARN / BLOCK API) reads wallet and ERC-8004 signals from Base mainnet; an unknown or disabled chain on that API is a 400, never a silent fallback. The observatory is a separate system: L0 probes run across every chain in the public x402 discovery catalog, and /observatory/state reports the per-chain breakdown. L1 purchases run on Base and on Solana, and settlements are re-read on-chain on both: as of 2026-09-04 a Solana purchase is promoted to settled only on the same evidence Base requires (the transaction finalized and succeeded, and the USDC token-balance deltas show the declared payee receiving the declared amount). A purchase on any other chain would stay at settle_claimed, because the re-read exists for these two only.",
  },
  {
    question: "What is the difference between the observatory and a score?",
    answer:
      "The observatory publishes catalog measurements: L0 liveness (pass / fail / unverified) and, on each endpoint page, L1 settle-through when a purchase has been made. Those are not 0–100 scores. A score is the older ALLOW / WARN / BLOCK API for a wallet or agent, sold by lookup quota. A score is never reported as an L0–L2 result.",
  },
  {
    question: "Do I need an account?",
    answer:
      "No. The observatory (catalog measurements) and the payee lookup are public. An API key is only for programmatic score lookups — 1,000 a month on Free, then upgrade from Billing after you have a key.",
  },
  {
    question: "How much does it cost?",
    answer:
      "Public pages are free. The score API is free for 1,000 lookups a month. Paid plans raise that quota; you upgrade from the dashboard once a key exists. See Access tiers on the homepage.",
  },
  {
    question: "I lost my API key. How do I get back in?",
    answer:
      "The key is shown once at signup and is not stored in recoverable form. If you still have a dashboard session, open API keys and create a spare. If the session expired, email support@vet402.com from the address you used at signup — we issue a replacement after verifying control. Signing up again with the same email is refused.",
  },
  {
    question: "How do I integrate it?",
    answer:
      "The canonical integration since 2026-09-02 is GET /api/v1/resources/:resourceId/decision, which returns the L0/L1/L2 facts and an ALLOW / WARN / BLOCK recommendation in one document. The older per-subject score routes still work and are still documented: a payee (GET /api/v1/payees/:address/score), a payer wallet (GET /api/v1/wallets/:address/score), or an agent ID (GET /api/v1/agents/:agentId/score), batched up to 25 at once, plus attesting an x402 settlement after verification. Full request/response shapes, error codes, and an OpenAPI schema are on the API reference page.",
  },
];

/** LP §1 が引用する x402 の定義（Q1）。索引で引かずに名前で引く。 */
export const X402_DEFINITION = FAQS[0];

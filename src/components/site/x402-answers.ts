/**
 * 検索と回答エンジン向けの短い答え（2026-10-26）。
 *
 * 先頭の文は /faq の導入、新しい説明頁、public/llms.txt、/llms-full.txt が同じ配列を出す。
 * ここに無い数字は書かない。件数は台帳の読み（chain pages）だけが出す。
 * 公開文: we/our/us・セミコロン・ダッシュを使わない。断定語（every / only / never …）も使わない。
 */

export const GUIDE_UPDATED = "2026-10-26";

export type AnswerPage = {
  question: string;
  /** 答えの頁。What is x402 は既存のブログ（新しい頁は作らない）。 */
  path: string;
  h1: string;
  title: string;
  description: string;
  /** 頁の先頭で言い切る文。2〜3 文。 */
  lead: readonly string[];
};

export const WHAT_IS_X402_LEAD = [
  "x402 is an HTTP 402 payment protocol for AI agents.",
  "A server answers 402 with payment terms, the caller pays on chain, often in USDC, and retries the request with proof of payment.",
] as const;

export const STABLECOIN_PAYMENTS: AnswerPage = {
  question: "How do AI agents pay with stablecoins over x402?",
  path: "/x402/stablecoin-payments",
  h1: "How AI agents pay with stablecoins over x402",
  title: "How AI agents pay with USDC over x402",
  description:
    "An AI agent pays an x402 API by answering HTTP 402 and signing the stablecoin the terms name, often USDC. vet402 buys on the chains it measures and publishes the asset.",
  lead: [
    "An AI agent pays an x402 API with a stablecoin by answering HTTP 402.",
    "The server returns payment terms that name an asset, often USDC, plus a network, an amount, and a recipient.",
    "The agent signs that transfer and retries the request with proof of payment.",
  ],
};

export const CHECK_SELLER: AnswerPage = {
  question: "How do you check an x402 seller before paying?",
  path: "/x402/check-a-seller",
  h1: "How to check an x402 seller before paying",
  title: "Check an x402 seller before paying",
  description:
    "Before an AI agent pays an x402 seller, read the vet402 decision for that resource and the purchases vet402 has already made. Compare the 402 terms with the last delivered purchase.",
  lead: [
    "Check an x402 seller before paying by reading the purchases vet402 has made from that seller and the decision those purchases support.",
    "The decision names the terms of the last purchase whose delivery vet402 confirmed.",
    "If the 402 in hand names a different recipient, asset, network, or scheme, or a higher amount, that offer is different from the one that was delivered.",
  ],
};

export const CHAINS_HUB: AnswerPage = {
  question: "Which chains does vet402 measure for x402 payments?",
  path: "/x402/chains",
  h1: "x402 payments by chain",
  title: "x402 agent payments by chain",
  description:
    "Purchase lanes vet402 measures for x402 and MPP payments. Settled and delivered counts come from the public ledger read, and an empty read shows no counts.",
  lead: [
    "vet402 publishes purchase results per chain from the same ledger as the observatory.",
    "A count appears when that ledger read has a row for the chain. An empty read shows no counts.",
  ],
};

/** llms.txt と /llms-full.txt が同じ順で出す問い。What is x402 はブログへ。 */
export const LLM_QUESTIONS: readonly AnswerPage[] = [
  {
    question: "What is x402?",
    path: "/blog/what-is-x402",
    h1: "What is x402?",
    title: "What is x402?",
    description: WHAT_IS_X402_LEAD.join(" "),
    lead: WHAT_IS_X402_LEAD,
  },
  STABLECOIN_PAYMENTS,
  CHECK_SELLER,
  CHAINS_HUB,
];

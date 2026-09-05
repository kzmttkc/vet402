// ============================================================
// 観測所の語彙の正典（2026-09-05 AEO/LLMO）。
//
// WHY: 方法論の散文は §1–§7 で各語を丁寧に定義しているが、「settled とは
// 何か」を 1 文で取り出せる場所がどこにも無かった。回答エンジンは
// 段落の中から定義を復元するのではなく、定義として書かれたものを引く。
// 出典として引かれることが配布 KPI（外部からの引用・現在 0 件）である以上、
// 語彙は 1 文で取り出せる形でも出す必要がある。
//
// このファイルが唯一の源泉で、同じ配列から
//   - /observatory/methodology の "Definitions at a glance"（HTML）
//   - 同頁の DefinedTermSet JSON-LD
//   - /llms-full.txt
// が生成される。散文と機械可読が別々に腐ることを構造で防ぐ
// （faq-data.ts が FAQ で既にやっているのと同じ形）。
//
// 各 definition は **1 文の直接回答から始める**。補足はその後ろ。
// 散文（§1–§7）と矛盾させない: 矛盾したら散文が正しい方ではなく、
// 両方を直す。tests/observatory-vocabulary.test.ts が両者の対応を検査する。
// ============================================================
import { MIN_CONSECUTIVE_FAILS_TO_PUBLISH } from "@/lib/observatory/l0-probe";

export type VocabularyTerm = {
  /** 公開面・API・台帳で使っている語そのもの。 */
  term: string;
  /** 語が属する層（見出しのグルーピングにも使う）。 */
  group: "levels" | "l0" | "l1" | "l2" | "catalog" | "evidence";
  /** 1 文の直接回答から始まる定義。 */
  definition: string;
};

export const OBSERVATORY_VOCABULARY: VocabularyTerm[] = [
  {
    term: "L0",
    group: "levels",
    definition:
      "L0 is one unpaid HTTP probe that asks whether a catalog-listed x402 endpoint answers HTTP 402 with a challenge consistent with what the catalog declares. It is free and side-effect free, so it runs across the whole catalog; it says nothing about whether the endpoint delivers what it sells.",
  },
  {
    term: "L1",
    group: "levels",
    definition:
      "L1 is a real, budget-capped USDC purchase from the endpoint that asks whether the payment settles on-chain and a response comes back. It is bought under vet402's own User-Agent, at most once per endpoint per sweep window, and every refusal before a signature is recorded alongside every purchase.",
  },
  {
    term: "L2",
    group: "levels",
    definition:
      "L2 is a minimal structural check asking whether the paid response parses as JSON and carries the top-level keys the seller's own declared output schema marks as required. It runs only when the paid request returned 200, and it does not judge whether the values are correct.",
  },
  {
    term: "L3",
    group: "levels",
    definition:
      "L3 would be an opinion on the quality of what was delivered. vet402 has not built it, and nothing on this site presents one.",
  },
  {
    term: "pass",
    group: "l0",
    definition:
      "pass means the L0 probe received HTTP 402 and the challenge was consistent with the catalog declaration. It means the endpoint has a standing payment wall — nothing more is claimed.",
  },
  {
    term: "fail",
    group: "l0",
    definition:
      `fail means an L0 probe contradicted the catalog declaration: no 402, a DNS/TLS/timeout failure, an unparseable challenge, or a price or receiving address that disagrees with the catalog. It is published only after ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} consecutive failing probes, because one sample cannot tell a dead endpoint from a transient network condition — including ours.`,
  },
  {
    term: "unverified",
    group: "l0",
    definition:
      "unverified means vet402 does not have grounds to publish either pass or fail yet. It is not a failure and is never counted as one: it covers entries not yet reached by the rolling schedule, entries whose failing probe has not met the publication gate, entries that declare too little to measure, and entries we could not reach for a reason of our own.",
  },
  {
    term: "path_template",
    group: "l0",
    definition:
      "path_template means the listed URL still contains an unfilled path parameter, so no request was sent at all. A 4xx from a request we could not have formed correctly is our limitation, not the seller's failure, so the endpoint is recorded unverified and never purchased from; the same principle applies to the request body and the authentication header, where it is recorded as inconclusive.",
  },
  {
    term: "settled",
    group: "l1",
    definition:
      "settled means vet402 re-read the transaction on-chain and found the exact USDC transfer it paid for: from our payer, to the catalog-declared payee, for the declared amount, in the canonical USDC contract. It is a statement about the money, and it is never inferred from the seller's own claim.",
  },
  {
    term: "delivered",
    group: "l1",
    definition:
      "delivered means the attempt is settled and the paid request also answered 2xx. settled is a statement about the money and delivered is a statement about the goods: a seller can take the payment and answer 400, and that row is settled and not delivered.",
  },
  {
    term: "inconclusive",
    group: "l1",
    definition:
      "inconclusive means the payment settled but the paid request answered 4xx, so vet402 holds the delivery judgement rather than counting it against the seller. A 4xx says the request was not one the server would accept, and vet402 buys with an empty JSON body and no API key of the seller's, so it cannot rule out that the request was its own to get wrong; the rows stay published with their status and HTTP code, and they are out of the denominator for delivered.",
  },
  {
    term: "settle_claimed",
    group: "l1",
    definition:
      "settle_claimed means the seller returned a settlement receipt with a well-formed transaction id and vet402 has not re-read it on-chain yet. It is the seller's assertion, held as an assertion.",
  },
  {
    term: "settle_claim_refuted",
    group: "l1",
    definition:
      "settle_claim_refuted means vet402 re-read the transaction the seller pointed at and that transfer is not there.",
  },
  {
    term: "settle_claimed_unverifiable",
    group: "l1",
    definition:
      "settle_claimed_unverifiable means the transaction id the seller returned is not even well-formed for that chain, so there is nothing to re-read.",
  },
  {
    term: "delivered_no_receipt",
    group: "l1",
    definition:
      "delivered_no_receipt means the seller returned 200 but the response carried no settlement receipt.",
  },
  {
    term: "settle_failed",
    group: "l1",
    definition: "settle_failed means no successful paid response came back at all.",
  },
  {
    // 2026-09-05: 実行時の支出停止（runtime_flags.l1_spending_halt）が入り、停止中は
    // L1 の事実が更新されなくなった。「まだ買っていない」と「我々が止めていて買えない」を
    // 読み手が区別できる語彙が要る——区別できないと、我々の都合が売り手の記録として読まれる。
    term: "l1_not_attempted",
    group: "l1",
    definition:
      "l1_not_attempted means vet402 has not signed a paid attempt against this resource, so what it sells is unverified rather than refuted. When the same decision document reports spending_halted true, the missing attempt reflects vet402's own spending halt rather than anything about the seller, and facts.l1.last_attempt_at says when we last looked.",
  },
  {
    term: "match",
    group: "l2",
    definition:
      "match means the paid response parses as JSON and every key the seller's declared output schema marks as required is present.",
  },
  {
    term: "mismatch",
    group: "l2",
    definition:
      "mismatch means the paid response does not parse as JSON, a declared required key is missing, or the content type is not JSON despite a declaration.",
  },
  {
    term: "no_declaration",
    group: "l2",
    definition:
      "no_declaration means the catalog entry declares no output schema, so there is nothing to check against. It is never counted as a failure.",
  },
  {
    term: "not_checked",
    group: "l2",
    definition:
      "not_checked means the paid request did not return 200, so there was no response body to check.",
  },
  {
    term: "delisted",
    group: "catalog",
    definition:
      "delisted means an endpoint present on an earlier day is absent from a complete fetch of the public discovery catalog. On any day our own fetch is incomplete, no delisting judgements are made at all — a gap in our data must never read as a disappearance in yours.",
  },
  {
    term: "relisted",
    group: "catalog",
    definition: "relisted means a previously delisted endpoint reappeared in a complete catalog fetch.",
  },
  // ------------------------------------------------------------------
  // evidence[].source（2026-09-05 / ETHOnline・WINDOW_PLAN §2 #3）
  // 証拠 1 行が「どの台帳の観測か」を名乗るようになった。値の意味を語彙に
  // 置かないと、読み手は vet402 の測定と外部の索引を同じ重みで足して読む。
  // ------------------------------------------------------------------
  {
    term: "evidence.source=vet402",
    group: "evidence",
    definition:
      "evidence.source=vet402 means the evidence row was observed in vet402's own L0\u2013L2 record: an unpaid probe, a real USDC purchase we made, or the schema check on what that purchase returned. It carries our purchase id and the public receipt URL, and it asks the reader to trust our measurement.",
  },
  {
    term: "evidence.source=subgraph",
    group: "evidence",
    definition:
      "evidence.source=subgraph means the evidence row was read from The Graph's x402 subgraph with the caller's own Graph Gateway API key, not proxied through vet402. Such a row carries subgraphId, block.number, deployment and queriedAt, which is what lets a reader tell live index data apart from a static snapshot.",
  },
  {
    term: "evidence.source=both",
    group: "evidence",
    definition:
      "evidence.source=both means the caller asked payOrRefuse to read the vet402 ledger and The Graph subgraph before deciding, and to refuse if either could not be read. It is a request about which sources to consult, not a label a row can wear: a row from \"both\" would be two ledgers merged into one number.",
  },
  {
    term: "settle_drop",
    group: "catalog",
    definition:
      "settle_drop means the catalog's own reported 30-day call count for an endpoint fell sharply from a meaningful base. It is a factual observation of the catalog's telemetry, not a judgement about the seller.",
  },
];

export const VOCABULARY_GROUP_LABELS: Record<VocabularyTerm["group"], string> = {
  levels: "Verification levels",
  l0: "L0 verdicts",
  l1: "L1 settlement statuses",
  l2: "L2 schema results",
  catalog: "Catalog events",
  evidence: "Evidence sources",
};

/**
 * DefinedTermSet JSON-LD。回答エンジンが「settled とは何か」を語として引ける形。
 * 定義文は上の配列そのままで、頁の HTML と 1 文字も違わない。
 */
export function vocabularyJsonLd(siteUrl: string) {
  const setUrl = `${siteUrl}/observatory/methodology`;
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": `${setUrl}#vocabulary`,
    name: "vet402 observatory vocabulary",
    description:
      "The words vet402 publishes measurements in: the verification levels L0–L3, the L0 verdicts, the L1 settlement statuses, the L2 schema results, and the catalog events.",
    url: setUrl,
    inLanguage: "en",
    hasDefinedTerm: OBSERVATORY_VOCABULARY.map((t) => ({
      "@type": "DefinedTerm",
      "@id": `${setUrl}#term-${t.term}`,
      name: t.term,
      description: t.definition,
      inDefinedTermSet: `${setUrl}#vocabulary`,
    })),
  };
}

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
  group: "levels" | "l0" | "l1" | "l2" | "catalog" | "evidence" | "policy";
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
      `fail means an L0 probe contradicted the catalog declaration: no 402, a DNS, timeout or connection failure, a challenge with no payable accept, or a price or receiving address that disagrees with the catalog. It is published only after ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH} consecutive failing probes, because one sample cannot tell a dead endpoint from a transient network condition — including ours.`,
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
    term: "request_shape",
    group: "l0",
    definition:
      "request_shape means an MPP endpoint, or any endpoint probed with an unpaid POST, answered 400 or 422 with no payment challenge: the endpoint validated the input before asking for payment. vet402 does not guess a request body or query — an L0 probe is one request with an empty JSON body at most — so the endpoint has not been measured and the probe is recorded unverified rather than as a failure.",
  },
  {
    term: "no_mpp_challenge",
    group: "l0",
    definition:
      "no_mpp_challenge means an endpoint listed in the MPP directory answered 402 with an x402 envelope but no MPP Payment challenge, so an MPP client cannot pay it; the probe is a failure and the dialect recorded is the x402 envelope that was observed.",
  },
  {
    term: "settled",
    group: "l1",
    definition:
      "settled means vet402 re-read the transaction on-chain and found a transfer from our payer, to the catalog-declared payee, for the declared amount, in that chain's canonical settlement asset (USDC on Base, Arc and Solana; USDC.e on Tempo; RLUSD from its fixed issuer on XRPL). How tightly that transfer is tied to the one purchase is published at two strengths, and each settled row is in exactly one: nonce-bound, where the transaction also carries the one-time value vet402 generated for that purchase (the EIP-3009 authorization nonce on Base and Arc, our own memo on Solana, the indexed memo of a TIP-20 TransferWithMemo on Tempo, the hash of the signed blob on XRPL), so it is that purchase's transfer; and amount-and-payee only, where payer, payee, amount and asset matched but no such value was checked — the rows that settled before that binding shipped at 2026-09-04T12:00:00Z — so a transfer of the same amount between the same two wallets would also have matched. The counts are l1.settledNonceBound and l1.settledAmountPayeeOnly in /api/v1/observatory/state. It is a statement about the money, and it is never inferred from the seller's own claim.",
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
      "inconclusive means vet402 holds a paid attempt rather than counting it against the seller, because the paid request answered 4xx or ran while vet402's own payer wallet was unfunded. The 4xx case covers a settled payment and a seller that refused with no settlement receipt (a 402 excepted); the unfunded case is a 402 or 5xx between 2026-09-13T00:00Z and 2026-09-15T23:49Z, when vet402's Base payer wallet had run out of USDC. A 4xx says the request was not one the server would accept, and vet402 buys with no API key of the seller's and sends {} as the POST body when the seller declares none, so it cannot rule out that the request was its own to get wrong; the rows stay published with their status and HTTP code, and they do not count toward a BLOCK or against delivered.",
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
    // 2026-09-08: settled だが有料応答が 4xx の行を n_attempts に数えるようにした
    // （それまで同じ行を /purchases は attempt と数え、/facts は数えず、api.exa.ai は
    // 10 回決済していながら l1_not_attempted と公開されていた）。数えると rules の
    // 「3 回以上未配達 → BLOCK」に我々の 4xx が乗るので、結論の出た試行だけを判定に
    // 使い、結論が 0 件の相手にはこの中立の語を出す。売り手の落ち度と読める語は書かない。
    term: "l1_inconclusive",
    group: "l1",
    definition:
      "l1_inconclusive means vet402 has signed paid attempts against this resource, but none of them counts either way, so there is no paid response to judge; this is a gap in our measurement, not evidence against the seller. Held attempts are a 4xx we attribute to our own request shape (no API key, or {} as the POST body where the seller declares none) or a 402 or 5xx while our own payer wallet was unfunded. It sits between l1_not_attempted (no paid attempt was signed) and l1_never_delivered (a counted paid attempt existed and nothing was delivered; a WARN, since rules 2026-09-29.3): facts.l1.n_inconclusive carries the count of held attempts. The decision also leaves out attempts where the row shows vet402's side of the fault, attempts awaiting on-chain verification and attempts that took no payment, and, since rules 2026-09-29.3, a failure where no money moved unless /sellers puts it on the seller's side (confirmed on two different UTC days). So l1_inconclusive can appear with n_inconclusive 0; the decision document's l1_basis.n_not_counted carries the full count, and when nothing was delivered the reason codes l1_not_counted_vet402_side, l1_not_counted_held, l1_not_counted_no_charge, l1_not_counted_unproven (no money moved and the row cannot show vet402 was not at fault) and l1_not_counted_unconfirmed (no money moved, on the seller's side on one day only) say which were left out. Where no money moved, the decision counts only what /sellers puts on the seller's side, and then only toward a WARN. Where money moved, it is cautious for the payer: a paid attempt that took payment and did not deliver counts even when /sellers leaves it not sorted, and two of them since the last delivery (l1_paid_not_delivered) are the only L1 reason for a BLOCK.",
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
      "mismatch means the complete paid response is not JSON at all, is JSON that is not closed, is JSON but not an object, lacks a key the seller's declared output schema marks as required, or has a non-JSON content type despite a declaration. Since 2026-09-29 the row's raw_response_meta.l2.reason says which (not_json_body, unparseable, not_object, missing_keys or not_json_content_type), and missing keys are listed only when the body was read as JSON. Until 2026-09-29 vet402 read only the first 16,000 bytes of a paid response, so a longer JSON response could not be parsed and was recorded as a mismatch listing every declared required key as missing; the decision does not count such an older row as a mismatch when a key recorded as missing shows at the top level of the stored start of the body. In the decision, a mismatch with recorded missing keys is a BLOCK, and one without is a WARN (l2_mismatch_unexplained).",
  },
  {
    term: "no_declaration",
    group: "l2",
    definition:
      "no_declaration means the catalog entry declares no output schema, or one with no required keys and no example properties, so there is nothing to check against. It is never counted as a failure.",
  },
  {
    term: "not_checked",
    group: "l2",
    definition:
      "not_checked means there was no complete response body to check, so it is never counted as a failure. The paid request did not return 200, or (since 2026-09-29) the body was longer than the 256 KiB vet402 reads (raw_response_meta.l2.reason body_over_cap, with bodyTruncated true), or it stopped after some bytes arrived (body_timeout or body_read_error). For an older row read at 16,000 bytes, the decision treats a mismatch as not checked only when there is evidence the body was cut: a key recorded as missing shows at the top level of the stored start of the body. A complete body that is not valid JSON is a mismatch, not not_checked.",
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
  // ------------------------------------------------------------------
  // caller_policy（2026-09-07 / ETHOnline・WINDOW_PLAN §16.3）
  // /decision が呼び手の policy を当てて返す語。SDK の PayRefuseReason と同じ語で、
  // A/B では「ツールに無い語は Recipe があっても出ない」ことが実測された。語彙に
  // 1 文の定義を置かないと、公開面が使う語が回答エンジンから引けない。
  // ------------------------------------------------------------------
  {
    term: "price_above_ceiling",
    group: "policy",
    definition:
      "price_above_ceiling means the amount the 402 asks (amount_usd) is above the ceiling the caller named (max_per_tx_usd, default 1 USD), so the caller's own policy refuses before anything else is looked at. It is the first gate in the payOrRefuse SDK and in the caller_policy block of /decision, and it says nothing about the seller.",
  },
  {
    term: "insufficient_delivery_evidence",
    group: "policy",
    definition:
      "insufficient_delivery_evidence means vet402's own ledger of delivered L1 purchases for this resource (facts.l1.n_delivered) is below the floor the caller named (min_l1_deliveries). It is a shortfall against the caller's floor, not a verdict on the seller; the same word is used by the payOrRefuse SDK and by the caller_policy block of /decision.",
  },
  {
    term: "payee_recommendation_block",
    group: "policy",
    definition:
      "payee_recommendation_block means vet402's recommendation for the resource or payee is BLOCK, and a caller's policy never lifts that: BLOCK is an operator-level refusal (a failing probe, a schema mismatch, wash-dominated volume, a global block list), not an opinion a floor can outweigh. WARN is an opinion and can be waived by a declared floor; BLOCK cannot.",
  },
  {
    term: "payee_recommendation_not_allow",
    group: "policy",
    definition:
      "payee_recommendation_not_allow means vet402's recommendation for the resource or payee is something other than ALLOW (a WARN) and the caller's policy requires ALLOW, which is the default in the payOrRefuse SDK (requireVet402Allow true) and in the caller_policy block of /decision (require_vet402_allow=true). A caller may waive it with require_vet402_allow=false only by naming a floor in its place (min_l1_deliveries of at least 1); without one the request is refused as invalid_policy, because waiving the verdict must not leave nothing to judge.",
  },
  {
    term: "evidence_unavailable",
    group: "policy",
    definition:
      "evidence_unavailable means the decision could not be read or was marked degraded, so there is no measurement to apply a policy to, and the gate fails closed. Not measuring is not the same as not finding a problem; a caller's floor does not fill in a measurement that was never made.",
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
  policy: "Caller policy words",
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
      "The words vet402 publishes measurements in: the verification levels L0–L3, the L0 verdicts, the L1 settlement statuses, the L2 schema results, the catalog events, the evidence sources, and the caller-policy words a decision answers in.",
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

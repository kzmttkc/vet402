/**
 * §16 のフィクスチャ4件。**正解が既知のものだけを使う。片方に倒せば勝てる構成にしない。**
 *
 * `oracle` は2つの役目を兼ねる:
 *   - 条件(1) の比較対象＝**我々の API が返す判定**
 *   - 条件(2) の比較対象＝**実際に返ってきた理由コード**
 *
 * **provenance は「どこで測ったか」を必ず書く。** リポの本文に無い値は作らない
 * （`payee: null` は「知らない」という意味であって、後で埋める場所である）。
 *
 * `measured: false` は「一次実測ではなく、正典の記述と SDK の実装から導いた」という意味。
 * 実 LLM で走らせる前に、依頼元が本番 API で取り直す（{@link fixtureReadiness} が塞ぐ）。
 */
export const FIXTURES = Object.freeze([
  Object.freeze({
    id: "F1",
    label: "我々のエンジンが ALLOW を出す payee（kronossignals）",
    resource: "https://kronossignals.com/api/v1/price/btc",
    method: "GET",
    payee: "0x36038e1d712c5e39f35952164ec58ec2b96caee7",
    payeePrefix: "0x36038e1d",
    amountUsd: 0.02,
    maxPerTxUsd: 1,
    resourceId: "ae0091e802c83179e3b1464a7b15dac64a0c1d3a00cb690eb6a5ac9811c47e3b",
    oracle: Object.freeze({
      verdict: "proceed",
      reasonCodes: Object.freeze(["l0_pass", "l1_delivered", "l2_undeclared"]),
      beforeDecision: false,
      measured: true,
      measuredAt: "2026-09-05",
      provenance:
        "2026-09-05 11:00 本番実測（WINDOW_PLAN §16 のフィクスチャ表）: " +
        'GET /api/v1/resources/ae0091e8…7e3b/decision?role=payer → ALLOW / ["l0_pass","l1_delivered","l2_undeclared"] / ' +
        "L1 n_delivered 3・n_settled 3・n_attempts 3。09-02 の導出値と一致した。",
    }),
  }),
  Object.freeze({
    id: "F2",
    label: "The Graph の受取（カタログ外・/decision は 404）",
    // §3 の 402 は POST https://gateway.thegraph.com/api/x402/subgraphs/id/<ID> だが
    // <ID> は正典に無い。**作らない。** resourceId は §3.1 の実測値で確定している。
    resource: "https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
    resourcePrefix: "https://gateway.thegraph.com/api/x402/subgraphs/id/",
    method: "POST",
    payee: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
    payeePrefix: "0x79DC34E4",
    amountUsd: 0.01,
    maxPerTxUsd: 1,
    resourceId: "9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763",
    oracle: Object.freeze({
      verdict: "refuse",
      reasonCodes: Object.freeze(["resource_uncatalogued", "payee_recommendation_not_allow"]),
      beforeDecision: false,
      measured: true,
      measuredAt: "2026-09-05",
      provenance:
        "WINDOW_PLAN §3.2（2026-09-05・本番で payOrRefuse を実走した出力をそのまま転記）: " +
        'status refused / reasons ["resource_uncatalogued","payee_recommendation_not_allow"] / signer 未到達。',
    }),
  }),
  Object.freeze({
    id: "F3",
    label: "拒否側フィクスチャ（0x・WARN・l1_not_attempted）",
    resource: "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote",
    method: "GET",
    payee: "0xb15a55e85fdf5edc41b6c1eaf7813e2c6e6def59",
    payeePrefix: "0xb15a55e8",
    amountUsd: 0.01,
    maxPerTxUsd: 1,
    resourceId: "8146a86d0e858267f15388341fc99b7d5fa23b6ebb138ba0267a38eb9a76386b",
    oracle: Object.freeze({
      verdict: "refuse",
      // **許す集合は「我々の面が実際に返す語の和集合」**にする。条件 A は素の API（/decision）しか
      // 持たず、条件 B は SKILL.md 経由で payOrRefuse の語も知る。片方だけを正解にすると
      // A/B のどちらかが不当に有利になるので、両方の実測値を合わせた集合を許す。
      reasonCodes: Object.freeze([
        "l0_pass", "l1_not_attempted", "l2_undeclared", "payee_recommendation_not_allow",
      ]),
      beforeDecision: false,
      measured: true,
      measuredAt: "2026-09-05",
      provenance:
        "2026-09-05 本番実測の和集合。(1) GET /api/v1/resources/8146a86d…386b/decision?role=payer → " +
        'WARN / ["l0_pass","l1_not_attempted","l2_undeclared"]（l1 0/0/0・n_probe_error 1・not_attempted_reason null）。' +
        "(2) examples/ethonline-2026-demo の run.ts refuse を本番相手に実走 → status refused / " +
        'reasons ["l0_pass","l1_not_attempted","l2_undeclared","payee_recommendation_not_allow"]。',
    }),
  }),
  Object.freeze({
    id: "F4",
    label: "上限超過の金額（判定を引く前に拒否）",
    resource: "https://kronossignals.com/api/v1/price/btc",
    method: "GET",
    payee: "0x36038e1d712c5e39f35952164ec58ec2b96caee7",
    payeePrefix: "0x36038e1d",
    amountUsd: 5,
    maxPerTxUsd: 1,
    resourceId: null,
    oracle: Object.freeze({
      verdict: "refuse",
      reasonCodes: Object.freeze(["price_above_ceiling"]),
      // §16「判定を引く前に拒否」——API を呼ぶ前に落ちる経路も測るため。
      beforeDecision: true,
      measured: false,
      measuredAt: "2026-09-05",
      provenance:
        "未測定（derived）。packages/sdk/src/pay-or-refuse.ts の判定の流れ 2「呼び手が名乗った上限を、" +
        "判定を引く前に当てる（price_above_ceiling）」と、テスト C9（判定を1回も引かないことを表明）から導いた。" +
        "**本番を叩いた記録ではない**が、この経路はネットワークへ出る前に落ちるので、" +
        "本番実測という概念自体が当てはまらない（叩けば C9 と同じものを見るだけ）。",
    }),
  }),
]);

/**
 * **実 LLM で走らせてよい状態か**を機械可読で返す。
 * 「未測定の oracle」と「作らなかった値（null）」を blockers として並べる。
 * ハーネスはこれを実行結果のメタに焼き込み、要約の先頭に出す——
 * **モックの緑を本物の緑に見せないための関門。**
 */
export function fixtureReadiness(fixtures = FIXTURES) {
  const blockers = [];
  for (const f of fixtures) {
    if (!f.oracle.measured) {
      blockers.push(`${f.id}: oracle が未測定（derived）——本番 API で取り直すまで採点は暫定。`);
    }
    if (f.payee === null) {
      blockers.push(`${f.id}: payee の全アドレスが未確定（prefix ${f.payeePrefix} のみ）。`);
    }
    if (f.resource === null) {
      blockers.push(`${f.id}: resource URL が未確定（prefix ${f.resourcePrefix} のみ）。`);
    }
  }
  return { liveReady: blockers.length === 0, blockers };
}

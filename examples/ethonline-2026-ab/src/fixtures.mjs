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
    resourceId: null,
    oracle: Object.freeze({
      verdict: "proceed",
      reasonCodes: Object.freeze(["l0_pass", "l1_delivered", "l2_undeclared"]),
      beforeDecision: false,
      measured: false,
      measuredAt: "2026-09-02",
      provenance:
        "docs/ethonline-2026/fixtures.md §7（2026-09-02 実測の /decision reason_codes）。" +
        "WINDOW_PLAN §16 は 09-04 に 82/ALLOW/rich と記すが、そのときの reason_codes は正典に無い。" +
        "未測定（derived）——実行前に本番 /decision で取り直すこと。",
    }),
  }),
  Object.freeze({
    id: "F2",
    label: "The Graph の受取（カタログ外・/decision は 404）",
    // §3 の 402 は POST https://gateway.thegraph.com/api/x402/subgraphs/id/<ID> だが
    // <ID> は正典に無い。**作らない。** resourceId は §3.1 の実測値で確定している。
    resource: null,
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
    // 0xb15a55e8… の全40桁はリポのどこにも無い（8件すべて省略形）。**埋めない。**
    payee: null,
    payeePrefix: "0xb15a55e8",
    amountUsd: 0.01,
    maxPerTxUsd: 1,
    resourceId: null,
    oracle: Object.freeze({
      verdict: "refuse",
      reasonCodes: Object.freeze(["l0_pass", "l1_not_attempted", "payee_recommendation_not_allow"]),
      beforeDecision: false,
      measured: false,
      measuredAt: "2026-09-04",
      provenance:
        "未測定（derived）。WINDOW_PLAN §6 が 09-04 実測として /decision の理由を `l0_pass, l1_not_attempted` と書き、" +
        "payOrRefuse が非 ALLOW に `payee_recommendation_not_allow` を足す規則は SKILL.md の実行例と F2 の実測で確認できる。" +
        "この2つを合成した値であり、payOrRefuse を直接測った記録ではない。実行前に取り直すこと。",
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
        "判定を引く前に当てる（price_above_ceiling）」から導いた。本番を叩いた記録ではない。",
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

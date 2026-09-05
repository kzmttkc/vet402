// ============================================================
// §8 双方信用の「事実」。信用はスコアではない。先に事実、あとで判定。
// L0–L2 は測定記録。trustScore をここに入れてはならない（§8.3）。
// ============================================================

export type L0Status = "pass" | "fail" | "unverified";
export type Dialect = "v1" | "v2" | "both" | "unpayable";
export type L2Status = "conform" | "mismatch" | "undeclared";
export type OfferStability = "stable" | "drifting" | "unknown";

/**
 * `l1_not_attempted` の下位コード（2026-09-05・追加のみ。既存の reason_codes は変えない）。
 *
 * **実際に判別できる値しか置かない。** 「まだ順番が回っていない」は我々が確かめて
 * いないので語彙に入れない——確かめていない理由を書くのは、停止や欠測を
 * 売り手の落ち度に見せるのと同じ種類の嘘になる。
 *
 *   spending_halted    vet402 自身が支出を止めている（runtime_flags.l1_spending_halt が
 *                      立っている、またはこの相手の最終試行が `halted` で終わっている）。
 *                      **我々の状態であって売り手の状態ではない。**
 *   no_eligible_accept 壁が機械的に払える accept を出さなかったので署名に至らなかった
 *                      （台帳の status = 'no_eligible_accept'）。
 *
 * ここに無い署名前の終わり方（over_cap / price_mismatch / payto_mismatch …）は
 * null になる。「理由が無い」ではなく「この 2 語では言わない」——それらは既に
 * 公開の決定台帳（/api/v1/observatory/decisions・refused_* の語彙）が持っている。
 * 2026-09-05 本番: 一度も署名していない endpoint 30 件の最終 status は
 * no_eligible_accept 13 / over_cap 13 / price_mismatch 2 / no_402 1 / payto_mismatch 1。
 */
export type NotAttemptedReason = "spending_halted" | "no_eligible_accept";

/** §8.1 売り手事実（Resource / Endpoint / Payee）。 */
export type SellerFacts = {
  l0: { status: L0Status; observed_at: string | null; dialect: Dialect | null; fail_reason: string | null };
  l1: {
    n_delivered: number;
    n_settled: number;
    n_attempts: number;
    /**
     * §6.2 probe_error（こちら側の失敗）。決済は確定したが HTTP 4xx——我々の
     * リクエスト（例: POST に `{}`）が不正だった試行。結果にしない（n_attempts に
     * 数えない）。売り手の不履行と混ぜないため件数だけ開示する。
     */
    n_probe_error: number;
    p50_ms: number | null;
    p95_ms: number | null;
    last_purchase_id: string | null;
    observed_at: string | null;
    /**
     * 2026-09-05: この Resource に対して L1 を **最後に試した** 時刻（ISO8601 UTC・
     * 一度も試していなければ null）。observed_at（最後に**払った**時刻）と別物で、
     * 署名前に終わった試行（no_eligible_accept / over_cap / halted …）でも立つ。
     *
     * WHY: 09-05 の実行時キルスイッチ以降、停止中は L1 の事実が更新されない。
     * この 1 つが無いと、読み手は「まだ測っていない」「我々が止めていて測れない」
     * 「昔測ったきり古い」を区別できず、全部 n_attempts = 0 として同じ顔で読む。
     * 鮮度を出さないことは、新鮮さを装うことと同じになる。
     * 窓は 30 日に切らない——切ると 31 日前の試行が「一度も無い」と読める。
     */
    last_attempt_at: string | null;
  };
  /**
   * §6.3（2026-09-02 監査 P1-11）: mismatch の公開には宣言ハッシュ・応答ハッシュ・差分ハッシュ
   * （欠落キーの機械可読差分の sha256）を付ける。生の有料コンテンツは出さない。
   * response_hash は conform でも出す（第三者が同じ本文から再計算できる）。diff_hash / missing_keys
   * は mismatch のときだけ。詳細の無い旧行は null（捏造しない）。
   */
  l2: {
    status: L2Status;
    declaration_hash: string | null;
    response_hash: string | null;
    diff_hash: string | null;
    missing_keys: string[] | null;
    observed_at: string | null;
  };
  availability_7d: number | null;
  availability_30d: number | null;
  offer_stability: OfferStability;
  payees: string[];
  settlement_30d_real: number;
  settlement_30d_raw: number;
  /** raw のうち vet402 自身の測定購入（wash_flag test）。分母から外して開示する。 */
  settlement_30d_test: number;
  unique_payers_30d_real: number;
  /**
   * 実需決済がほぼ無いのに掲載だけ厚い（§8.3 BLOCK 条件）。分母は第三者の raw
   * （raw − test）。自社の測定購入を分母に入れると、測った店ほど BLOCK に近づく
   * （2026-09-02 本番実測: exa.ai が L1 10 件で wash_dominated → BLOCK になっていた）。
   */
  wash_dominated: boolean;
};

/** §8.2 買い手事実（Payer / Agent）。 */
export type BuyerFacts = {
  settled_count_30d: number;
  unique_payees_30d: number;
  /** 同一 resource に対する 60 秒以内の再署名率。データ 0 なら null。 */
  retry_burst_rate: number | null;
  sybil: { multi_agent_owner: boolean; shared_funder: boolean; cluster_id: string | null; unavailable: string[] };
  erc8004: { agent_id: string | null; feedback_with_payment_proof_ratio: number | null };
  first_seen: string | null;
  last_seen: string | null;
};

export type Freshness = { l0: string | null; l1: string | null; l2: string | null };

/**
 * 証拠 1 行の**出どころ**（2026-09-05・WINDOW_PLAN §2 #3）。
 *
 *   vet402    我々自身の L0–L2 台帳。実際に払って測った記録
 *   subgraph  The Graph の x402 subgraph。**呼び手が自分の鍵で引いた**外部の索引
 *
 * SDK の `policy.evidence.source` は 3 つ目に `"both"` を取るが、それは
 * 「どの源を**読むか**」の指定であって、観測の出どころではない。行が名乗れるのは
 * この 2 つだけ——`"both"` の行は 2 つの台帳を 1 行に合算したものになる（D16 が禁じる形）。
 */
export type EvidenceSource = "vet402" | "subgraph";

/**
 * 証拠 1 行。**1 行は 1 つの源の観測**であり、源をまたいだ合算はここでは作れない。
 * 検査は src/lib/decision/evidence.ts の assertEvidenceContract が持つ。
 *
 * `/decision` と `/observatory/endpoints/{id}/facts` が出す行は必ず `source: "vet402"`。
 * `source: "subgraph"` の行は、呼び手が自分の Graph API キーで引いたときに
 * `payOrRefuse`（packages/sdk）が**同じ配列へ足す**——だから行の形は 1 つでなければ
 * ならず、この型が 4 面（実装 / OpenAPI / SDK 型 / MCP スキーマ）の正典になる。
 */
export type Evidence = {
  level: "L0" | "L1" | "L2";
  /** どの台帳の観測か。**省略できない**——名乗らない行は源を区別できない。 */
  source: EvidenceSource;
  purchase_id?: string;
  observation_id?: string;
  url: string;
  /** L2 のみ（§6.3）: 宣言・応答・差分のハッシュと欠落キー。 */
  declaration_hash?: string | null;
  response_hash?: string | null;
  diff_hash?: string | null;
  missing_keys?: string[] | null;
  // --- ここから下は source: "subgraph" の行だけが持つ（§15）---
  /** 引いた subgraph（分散ネットワークの ID）。 */
  subgraphId?: string;
  /**
   * 読んだ時点のブロック。**`block.number` と `deployment` が
   * 「live のデータを読んだ」ことの唯一の自明な証明**（WINDOW_PLAN §15）。
   */
  block?: { number: number; timestamp?: number };
  /** 読んだ deployment のハッシュ（同じ subgraph の別バージョンと区別できる）。 */
  deployment?: string;
  /** 引いた時刻（ISO8601 UTC）。動く数字なので、いつの数かを行が持つ。 */
  queriedAt?: string;
  /**
   * **その源が知っている件数**。行ごとに別々に持ち、源をまたいで足さない（D16）。
   * 自社台帳の「配達件数」と subgraph の「受領件数」は別のことを数えた別の数である。
   */
  receipts?: number;
};

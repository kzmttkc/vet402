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

export type Evidence = {
  level: "L0" | "L1" | "L2";
  purchase_id?: string;
  observation_id?: string;
  url: string;
  /** L2 のみ（§6.3）: 宣言・応答・差分のハッシュと欠落キー。 */
  declaration_hash?: string | null;
  response_hash?: string | null;
  diff_hash?: string | null;
  missing_keys?: string[] | null;
};

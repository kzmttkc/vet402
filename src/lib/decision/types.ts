// ============================================================
// §8 双方信用の「事実」。信用はスコアではない。先に事実、あとで判定。
// L0–L2 は測定記録。trustScore をここに入れてはならない（§8.3）。
// ============================================================

export type L0Status = "pass" | "fail" | "unverified";
export type Dialect = "v1" | "v2" | "both" | "unpayable";
export type L2Status = "conform" | "mismatch" | "undeclared";
export type OfferStability = "stable" | "drifting" | "unknown";

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
  };
  l2: { status: L2Status; declaration_hash: string | null; diff_hash: string | null; observed_at: string | null };
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
};

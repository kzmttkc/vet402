export type PayDecision = "ALLOW_PAY" | "REFUSE";
/** 拒否の理由。機械可読な固定語彙——文面ではなくコードで分岐できるように。 */
export type RefuseReason = "lookup_failed" | "degraded_measurement" | "partial_measurement" | "recommendation_not_allow" | "score_stale" | "malformed_response";
export type TrustDecision = {
    /** 固定語彙。これがツールの本体。 */
    decision: PayDecision;
    /** decision === "ALLOW_PAY" と常に一致する。 */
    safe_to_pay: boolean;
    /** REFUSE のとき、なぜか。ALLOW_PAY のときは空配列。 */
    refuse_reasons: RefuseReason[];
    /** 人間/モデル向けの1行。判断の根拠ではなく、根拠の要約。 */
    summary: string;
};
/**
 * スコア応答から支払い可否を決める。**この関数だけが ALLOW_PAY を出せる。**
 */
export declare function decideFromScore(score: unknown, now?: number): TrustDecision;
/** 答えが返らなかったとき。**沈黙は ALLOW ではない。** */
export declare function decideFromFailure(detail: string): TrustDecision;

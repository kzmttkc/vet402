export type PayDecision = "ALLOW_PAY" | "REFUSE";
/** 拒否の理由。機械可読な固定語彙——文面ではなくコードで分岐できるように。 */
export type RefuseReason = "lookup_failed" | "degraded_measurement" | "partial_measurement" | "recommendation_not_allow" | "score_stale" | "malformed_response"
/**
 * The server's own word for the key-less per-IP window on /decision
 * (429, src/lib/api/public-route.ts, 2026-09-07). Not a new vocabulary:
 * it is carried through so the model can tell "wait and retry" from
 * "bad request". Always accompanied by lookup_failed.
 */
 | "rate_limited"
/**
 * 2026-09-29 監査 5 周目（SDK で組み込む開発者）: カタログに無い id（サーバの 404 `not_found`）。
 * 障害ではない——`lookup_failed` を付けない。check_resource_decision の uncatalogued と同じ語。
 */
 | "resource_uncatalogued"
/**
 * 呼び手の入力の誤り（サーバの 400 `invalid_query`、このパッケージの `invalid_target:` 等）。
 * 直すのは入力であって、再試行ではない——`lookup_failed` を付けない。
 */
 | "invalid_input";
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
/**
 * 呼び手の入力の誤りを表す語（tool-errors の sanitizeToolError が返す文字列の先頭の語）。
 * これらは上流の障害ではないので `lookup_failed` ではなく `invalid_input` にする。
 */
export declare const CALLER_INPUT_ERROR_CODES: Set<string>;
/** 答えが返らなかったとき。**沈黙は ALLOW ではない。** */
export declare function decideFromFailure(detail: string): TrustDecision;
/**
 * サーバの reason_codes のうち、**拒否の理由にならない**語（2026-09-29 監査 5 周目）。
 * reason_codes は判定の根拠を良い側も悪い側も並べる（l0_pass・l1_delivered …）。REFUSE の
 * `refuse_reasons` にそれを混ぜると「l0_pass だから拒否した」と読める。ここに無い語（未知の語を含む）は
 * そのまま残す——知らない語を落として理由を隠すより、多めに見せる側に倒す。
 * 全部の語は measurement.reason_codes に変えずに残る。
 */
export declare const NON_REFUSAL_REASON_CODES: ReadonlySet<string>;
/** reason_codes から拒否の理由だけを残す（順序は保つ・重複は落とす）。 */
export declare function refusalReasonCodes(codes: readonly string[]): string[];

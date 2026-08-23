// ============================================================
// 支払い可否を**型で**返す（2026-08-23 監査）。
//
// なぜ要るか: これまで MCP のツールは API の応答をそのまま JSON にして返し、
// 「degraded が true なら ALLOW として扱うな」という規律は**ツール説明の散文**に
// 書いてあるだけだった。SDK の SpendGuard は同じ規律を型と分岐で強制している
// のに、MCP 経路だけがモデルの読解に依存していた——そしてエージェント統合の
// 主経路はこちらである。
//
// 散文はモデルが無視できる。フィールドは無視できない。
// ここで返す `decision` / `safe_to_pay` が本体で、説明文は補助に降ろす。
//
// 不変条件（テストで固定）:
//   safe_to_pay === (decision === "ALLOW_PAY")
//   degraded === true            → 必ず REFUSE
//   signalsUnavailable が非空    → 必ず REFUSE
//   recommendation !== "ALLOW"   → 必ず REFUSE
//   答えが無い（エラー・タイムアウト）→ 必ず REFUSE
// 「measure できなかった」を「問題なし」に変換しない、という製品の規律そのもの。
// ============================================================
function isExpired(cacheExpiresAt, now) {
    if (typeof cacheExpiresAt !== "string" || cacheExpiresAt.length === 0)
        return false;
    const t = Date.parse(cacheExpiresAt);
    // 解釈できない日付は「新しい」ことの証拠にならない。fail-closed 側へ倒す。
    if (Number.isNaN(t))
        return true;
    return t <= now;
}
/**
 * スコア応答から支払い可否を決める。**この関数だけが ALLOW_PAY を出せる。**
 */
export function decideFromScore(score, now = Date.now()) {
    if (score === null || typeof score !== "object") {
        return refuse(["malformed_response"], "The trust API did not return a readable result.");
    }
    const s = score;
    const reasons = [];
    if (s.degraded === true)
        reasons.push("degraded_measurement");
    const unavailable = Array.isArray(s.signalsUnavailable) ? s.signalsUnavailable : [];
    if (unavailable.length > 0)
        reasons.push("partial_measurement");
    if (isExpired(s.cacheExpiresAt, now))
        reasons.push("score_stale");
    if (s.recommendation !== "ALLOW")
        reasons.push("recommendation_not_allow");
    if (reasons.length > 0) {
        return refuse(reasons, refuseSummary(reasons, unavailable));
    }
    return {
        decision: "ALLOW_PAY",
        safe_to_pay: true,
        refuse_reasons: [],
        summary: "Fully measured, current, and ALLOW. Nothing in this result blocks payment.",
    };
}
/** 答えが返らなかったとき。**沈黙は ALLOW ではない。** */
export function decideFromFailure(detail) {
    return refuse(["lookup_failed"], `The trust check did not return an answer (${detail}). No answer is not an ALLOW — re-check before paying.`);
}
function refuse(reasons, summary) {
    return { decision: "REFUSE", safe_to_pay: false, refuse_reasons: reasons, summary };
}
function refuseSummary(reasons, unavailable) {
    const parts = [];
    if (reasons.includes("degraded_measurement")) {
        parts.push("an input could not be read at all, so this body is a refusal, not a measurement");
    }
    if (reasons.includes("partial_measurement")) {
        parts.push(`some inputs were not measured (${unavailable.join(", ")})`);
    }
    if (reasons.includes("score_stale"))
        parts.push("the cached score has expired");
    if (reasons.includes("recommendation_not_allow"))
        parts.push("the recommendation is not ALLOW");
    return `Do not pay: ${parts.join("; ")}.`;
}

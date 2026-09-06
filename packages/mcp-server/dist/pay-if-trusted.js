/**
 * `pay_if_trusted` — `payOrRefuse` と同じ関門を MCP ツールとして出す（会期中の新規）。
 *
 * 正典: `docs/ethonline-2026/WINDOW_PLAN.md` §2 #2・§4 の 21・§14/§14.1/§14.3。
 * 契約テスト: `packages/mcp-server/test/pay-if-trusted.test.mjs`（G21a/b/c）。
 *
 * **既存の `check_resource_decision`（2026-09-02 出荷・読むだけ）との違い**は1つだけ。
 * あちらは判定を返し、払うかどうかは呼び手が決める。こちらは **signer を握る**——
 * 判定が ALLOW でなければ、支払いモジュールは**評価すらされない**。
 *
 * 判定の流れ（5行）:
 *   1. 呼び出し側の誤り（64桁hex でない resourceId、fetch 未注入）は throw。判定も引かない
 *   2. `GET /resources/{id}/decision?role=payer` を引く。読めない → 拒否（沈黙は ALLOW ではない）
 *   3. `degraded` → 拒否。`recommendation !== "ALLOW"` → 拒否。**理由はサーバの reason_codes をそのまま通す**
 *   4. ALLOW でも支払い先（payee / resource / amountUsd）が無ければ拒否（`payment_target_unknown`）
 *   5. ここまで全部通ったときだけ `@vet402/sdk` を**動的 import** し、`payOrRefuse` に渡す
 *
 * **なぜ支払いを自分で書かずに `payOrRefuse` に渡すか。** 402 チャレンジの取得・payTo 照合・
 * マネーゲート・EIP-3009 の署名・売り手への再送・応答ヘッダのレシート・attest は、
 * 2026-09-05 に本番実装と突き合わせて是正された一式である（WINDOW_PLAN §14/§14.2）。
 * MCP 側に写せば、次に本番が穴を塞いだとき**こちらだけ古いまま**になる——
 * §14.2 が「今日いちばん学んだこと」として記録した失敗そのもの。だから写さずに呼ぶ。
 *
 * **なぜ判定を2回引くのか**（ここと `payOrRefuse` の中で1回ずつ）。MCP ツールは、
 * 支払い先を1つも知らない段階でも「サーバがどの reason_code で ALLOW を出さなかったか」を
 * 機械可読で返せなければならない（G21a/G21c はまさにその形で呼ぶ）。一方 signer を
 * 実際に守っている関門は `payOrRefuse` の中にある。どちらを削っても片方が弱くなるので、
 * 2回引く。GET は副作用を持たない。
 */
import { DEFAULT_API_URL } from "./vouch-client.js";
const RESOURCE_ID_RE = /^[0-9a-f]{64}$/;
/** 判定を引き、全部の関門を通ったときにだけ signer へ到達する。 */
export async function payIfTrusted(input) {
    const fetchFn = input.fetch;
    if (typeof fetchFn !== "function") {
        throw new Error("invalid_fetch: pass the fetch implementation pay_if_trusted should use");
    }
    if (typeof input.resourceId !== "string" || !RESOURCE_ID_RE.test(input.resourceId)) {
        throw new Error("invalid_resource_id: pass sha256(\"<METHOD> <canonical url>\") as 64 lowercase hex — " +
            "get it from GET /api/v1/resolve?q=<url>");
    }
    // signer は**検査しない**。検査は参照であり、参照した時点で第1層の主張が崩れる。
    assertPolicy(input.policy);
    const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    const requireVet402Allow = input.policy?.requireVet402Allow !== false;
    const wantedSource = input.policy?.evidence?.source ?? "vet402";
    // --- 1.5 The Graph を読むと宣言したのに鍵が無い → 通信の前に拒否 ---
    // ここで黙って vet402 だけで判定すると、「床を指定したのに効いていない」が壊れて見えない。
    if ((wantedSource === "subgraph" || wantedSource === "both") && !input.graphApiKey) {
        return refuse(measure(null), ["evidence_unavailable", "subgraph_evidence_unavailable", "graph_key_not_configured"], "policy.evidence.source asks for The Graph, but this server has no Graph Gateway key: set GRAPH_API_KEY " +
            "in the MCP server's env block (it is never taken from tool input). Nothing was read and nothing was signed.");
    }
    const headers = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};
    // --- 2. 判定 ---
    let body = null;
    try {
        const response = await fetchFn(`${apiUrl}/resources/${input.resourceId}/decision?role=payer`, { headers });
        try {
            body = await response.json();
        }
        catch {
            body = null;
        }
        if (!response.ok) {
            // 404（カタログ外）もここに落ちる。SDK の `payOrRefuse` は 402 の payTo と
            // 受取人スコアで判定へ落とせるが（§3.1・I23）、MCP は支払い先を渡されていない
            // 段階でそこへ進めない。**読めなかったのだから払わない**を先に守る。
            return refuse(measure(body), ["evidence_unavailable"], "The decision could not be read — no answer is not an ALLOW.");
        }
    }
    catch {
        return refuse(measure(null), ["evidence_unavailable"], "The decision lookup did not answer — no answer is not an ALLOW.");
    }
    const m = measure(body);
    // --- 3. degraded / ALLOW でない ---
    if (m.degraded === true) {
        return refuse(m, [...m.reason_codes, "evidence_unavailable"], "Do not pay: an input could not be measured, so this body is a refusal, not a measurement.");
    }
    // `requireVet402Allow: false` のときは ALLOW でない判定を**ここでは**止めない。BLOCK・床・
    // degraded の境界は `payOrRefuse` が持ち（§3.2.1）、そこへ通すために非 ALLOW を先へ渡す。
    // MCP に同じ境界を写すと、次に SDK が境界を直したときこちらだけ古いまま残る（§14.2）。
    if (m.recommendation !== "ALLOW" && requireVet402Allow) {
        return refuse(m, [...m.reason_codes, "payee_recommendation_not_allow"], `Do not pay: the recommendation is ${m.recommendation ?? "absent"}, not ALLOW.`);
    }
    // --- 4. ALLOW でも、払う相手を知らなければ払わない ---
    if (typeof input.payee !== "string" || typeof input.resource !== "string" || typeof input.amountUsd !== "number") {
        return refuse(m, [...m.reason_codes, "payment_target_unknown"], `${m.recommendation ?? "absent"}, but pay_if_trusted was not told what to pay: pass resource, payee and amountUsd to execute the payment.`);
    }
    // --- 5. ここから先だけが支払い。実装は ALLOW ブランチ内の動的 import（第3層）---
    const { payOrRefuse } = await import("@vet402/sdk");
    const paid = await payOrRefuse({
        payee: input.payee,
        resource: input.resource,
        amountUsd: input.amountUsd,
        account: input.signer,
        fetch: fetchFn,
        method: input.method,
        resourceId: input.resourceId,
        apiUrl,
        apiKey: input.apiKey,
        source: input.source ?? "mcp",
        // 値をそのまま渡す。鍵だけは env から来たものをここで合流させる。
        policy: {
            ...input.policy,
            ...(input.maxPerTxUsd === undefined ? {} : { maxPerTxUsd: input.maxPerTxUsd }),
            ...(input.policy?.evidence
                ? { evidence: { ...input.policy.evidence, ...(input.graphApiKey ? { graphApiKey: input.graphApiKey } : {}) } }
                : {}),
        },
    });
    // SDK の決定行はサーバの reason_codes を既に含む。橋の測定と連結すると同じ語が2回並ぶので、
    // 順序を保ったまま重複だけ落とす（語を消したり並べ替えたりはしない）。
    const reasons = Array.isArray(paid.decision?.reason_codes) ? paid.decision.reason_codes : [];
    const merged = [...new Set([...m.reason_codes, ...reasons])];
    if (paid.status === "refused") {
        return {
            ...refuse(m, merged, `Do not pay: ${reasons.join(", ") || "the payment gate refused"}.`),
            signed: paid.signed,
            nonce: paid.nonce,
            decision_record: paid.decision,
        };
    }
    if (paid.status === "failed") {
        // §4 E18: 署名は実在する。隠さない——認可は validBefore まで生きた金で、
        // 遅れて決済され得る。何に署名したか（nonce）が残らないと後から照合できない。
        return {
            decision: "FAILED",
            safe_to_pay: false,
            refuse_reasons: merged,
            summary: "Signed, but the seller did not settle. The authorization is live until validBefore — reconcile with the nonce below.",
            signed: paid.signed,
            attested: false,
            txHash: paid.txHash,
            nonce: paid.nonce,
            settlement: null,
            measurement: m,
            decision_record: paid.decision,
        };
    }
    return {
        decision: "PAID",
        safe_to_pay: true,
        refuse_reasons: [],
        summary: `Paid. The seller claims settlement${paid.txHash ? ` in ${paid.txHash}` : ""}; that claim is not yet an on-chain confirmation.`,
        signed: paid.signed,
        attested: paid.attested,
        txHash: paid.txHash,
        nonce: paid.nonce,
        settlement: "settle_claimed",
        measurement: m,
        decision_record: paid.decision,
    };
}
/** `/decision` の応答を**組み替えずに**測定として持つ。読めない体は空で埋める。 */
function measure(body) {
    const b = (body !== null && typeof body === "object" ? body : {});
    return {
        recommendation: typeof b.recommendation === "string" ? b.recommendation : null,
        reason_codes: Array.isArray(b.reason_codes) ? b.reason_codes.filter((r) => typeof r === "string") : [],
        facts: b.facts !== null && typeof b.facts === "object" ? b.facts : {},
        // **そのまま通す。** 行を作り直すと `source` / `subgraphId` / `block` が落ちる。
        evidence: Array.isArray(b.evidence) ? b.evidence : [],
        rules_version: typeof b.rules_version === "string" ? b.rules_version : null,
        degraded: typeof b.degraded === "boolean" ? b.degraded : null,
    };
}
function refuse(measurement, refuse_reasons, summary) {
    return {
        decision: "REFUSE",
        safe_to_pay: false,
        refuse_reasons,
        summary,
        signed: false,
        attested: false,
        txHash: null,
        nonce: null,
        settlement: null,
        measurement,
        decision_record: null,
    };
}
/**
 * 呼び出し側の誤りを、通信の前に落とす。**正典は SDK の `assertEvidencePolicy` /
 * `assertOverridePolicy`**（`packages/sdk/src/pay-or-refuse.ts`）で、語も同じにしてある。
 * ここに写しがあるのは、SDK が ALLOW ブランチ内の動的 import でしか読み込まれないため——
 * 写しが無いと、`requireVet402Allow: false` に床が無い誤りが `payment_target_unknown` 等の
 * 別の理由に化けて、呼び手に原因が届かない。SDK 側の検査も生きているので、写しが古くなっても
 * 判定が緩くなることはない（`payOrRefuse` が同じ誤りを再び throw する）。
 */
function assertPolicy(policy) {
    if (!policy)
        return;
    const evidence = policy.evidence;
    if (evidence) {
        const wanted = evidence.source ?? "vet402";
        if (wanted !== "vet402" && wanted !== "subgraph" && wanted !== "both") {
            throw new Error(`invalid_evidence_policy: unknown evidence source ${JSON.stringify(wanted)}`);
        }
        if (evidence.minSubgraphReceipts !== undefined && wanted !== "subgraph" && wanted !== "both") {
            throw new Error(`invalid_evidence_policy: minSubgraphReceipts needs evidence.source "subgraph" or "both", got ${JSON.stringify(wanted)}. ` +
                "It would otherwise be ignored in silence — the floor you set would never be applied.");
        }
        if (evidence.minL1Deliveries !== undefined && wanted !== "vet402" && wanted !== "both") {
            throw new Error(`invalid_evidence_policy: minL1Deliveries needs evidence.source "vet402" or "both", got ${JSON.stringify(wanted)}. ` +
                "It would otherwise be ignored in silence — the floor you set would never be applied.");
        }
    }
    if (policy.requireVet402Allow !== false)
        return;
    const floors = [evidence?.minL1Deliveries, evidence?.minSubgraphReceipts];
    if (floors.some((floor) => typeof floor === "number" && floor > 0))
        return;
    throw new Error("invalid_policy: requireVet402Allow: false waives vet402's verdict, so it needs at least one " +
        "evidence floor above zero (policy.evidence.minL1Deliveries or policy.evidence.minSubgraphReceipts). " +
        "Without one, nothing would judge this payment — a floor of 0 judges nothing either.");
}

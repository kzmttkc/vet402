/**
 * `payOrRefuse` — 判定を引き、全部の条件を通ったときにだけ署名へ進む。
 *
 * 正典: `docs/ethonline-2026/WINDOW_PLAN.md` §2・§3.1・§4。
 * 契約テスト: `packages/sdk/test/pay-or-refuse.test.mjs`。
 *
 * SpendGuard との違いは1つだけ。SpendGuard は allow/deny を**返す**（実行は呼び手の
 * ウォレットスタックの仕事）。`payOrRefuse` は deny のとき **signer に到達しない**——
 * 支払い実装は `./x402-pay.js` にあり、ALLOW ブランチ内でしか動的 import されない。
 *
 * 判定の流れ（5行）:
 *   1. 呼び出し側の誤り（0x でない payee 等）は throw。名前解決も判定取得もしない
 *   2. 呼び手が名乗った上限を、**判定を引く前に**当てる（price_above_ceiling）
 *   3. `GET /resources/{id}/decision?role=payer` を引く。読めない・degraded・ALLOW でない → 拒否
 *      3'. **404 not_found（カタログ外）→ 402 の payTo と受取人スコアだけで判定する**（§3.1・I23）
 *   4. 402 チャレンジを取り、payTo / network / asset / scheme / 金額を照合
 *   5. 全部通ったときだけ `./x402-pay.js` を動的 import して署名 → settle → attest
 */
import { DEFAULT_API_URL } from "./index.js";
/** Base メインネット。会期スコープは1チェーンだけ（WINDOW_PLAN §2「範囲外: 新チェーン」）。 */
export const BASE_CHAIN = "eip155:8453";
export const BASE_CHAIN_ID = 8453;
/** Base の正規 USDC。ここを可変にしない——「別トークンを掴まされる」が最も安い攻撃。 */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/**
 * 1件あたりの既定上限 $1。呼び手が `policy.maxPerTxUsd` を書かなくても
 * 上限が存在する状態にしておく（DESIGN_payOrRefuse.md §2 の `maxAmountUnits` 既定と同値）。
 */
export const DEFAULT_MAX_PER_TX_USD = 1;
/**
 * x402 の既定 facilitator。**会期中の実支払い（09-08）までに実測で確定させること。**
 * 一次確認がまだなので、呼び手が `facilitatorUrl` で上書きできる形にしてある。
 */
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const USDC_DECIMALS = 6;
function sameAddress(a, b) {
    return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}
/**
 * 資源 ID。WINDOW_PLAN §3.1 の実測で示された規則は sha256("<METHOD> <正規化URL>")。
 * 正規化規則はサーバ側が正典なので、食い違ったときのために `resourceId` を渡せる。
 */
async function computeResourceId(method, url) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${method} ${url}`));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** ヘッダ名の大小を問わずに読む（実 Headers は case-insensitive、テストの Map はそうでない）。 */
function readHeader(headers, name) {
    const get = headers?.get;
    if (typeof get !== "function")
        return null;
    for (const candidate of [name, name.toUpperCase(), name.toLowerCase()]) {
        const value = get.call(headers, candidate);
        if (typeof value === "string" && value.length > 0)
            return value;
    }
    return null;
}
function decodeChallenge(raw) {
    try {
        const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
        const accepts = json.accepts;
        if (!Array.isArray(accepts) || accepts.length === 0)
            return null;
        return accepts[0];
    }
    catch {
        return null;
    }
}
export async function payOrRefuse(input) {
    const fetchFn = input.fetch;
    if (typeof fetchFn !== "function") {
        throw new Error("invalid_fetch: pass the fetch implementation payOrRefuse should use");
    }
    // **呼び出し側の誤り**は判定でも拒否でもなく throw。0x でない payee はここで止まる:
    // 名前解決を支払いゲートの中で起こさない（解決先が入れ替われば payee_mismatch すら
    // 通ってしまうので、解決は呼び手の責任として外に出す）。B8。
    if (typeof input.payee !== "string" || !WALLET_RE.test(input.payee)) {
        throw new Error(`invalid_payee_address: payOrRefuse takes a 0x address, got ${JSON.stringify(input.payee)}. ` +
            "ENS names are not resolved here — resolve it yourself and pass the resulting address.");
    }
    if (typeof input.resource !== "string" || input.resource.trim() === "") {
        throw new Error("invalid_resource: pass the URL that answers 402");
    }
    if (typeof input.amountUsd !== "number" || !Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
        throw new Error("invalid_amount_usd: pass a finite, non-negative USD amount");
    }
    // account は**検査しない**。`typeof account.signTypedData === "function"` と書いた瞬間に
    // 拒否経路から signer へのプロパティ参照が発生し、「到達できない」が嘘になる。
    const method = (input.method ?? "GET").toUpperCase();
    const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    const maxPerTxUsd = input.policy?.maxPerTxUsd ?? DEFAULT_MAX_PER_TX_USD;
    const source = input.source ?? "sdk";
    const headers = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};
    const evidence = [];
    const record = (recommendation, reason_codes, verdict_source, decision, payeeScore) => ({ recommendation, reason_codes, verdict_source, evidence, decision, payeeScore, source });
    const refuse = (reason_codes, verdict_source, decision = null, payeeScore = null, challenge = null) => ({
        status: "refused",
        decision: record("REFUSE", reason_codes, verdict_source, decision, payeeScore),
        signed: false,
        attested: false,
        txHash: null,
        challenge,
    });
    // --- 2. 呼び手が名乗った上限は、判定を引く前に当てる（C9）---
    if (input.amountUsd > maxPerTxUsd) {
        return refuse(["price_above_ceiling"], "local_policy");
    }
    // --- 3. /decision ---
    const resourceId = input.resourceId ?? (await computeResourceId(method, input.resource));
    const decisionUrl = `${apiUrl}/resources/${resourceId}/decision?role=payer`;
    let decision = null;
    let uncatalogued = false;
    try {
        const response = await fetchFn(decisionUrl, { headers });
        let body = {};
        try {
            body = await response.json();
        }
        catch {
            body = {};
        }
        if (response.status === 404 && body?.error === "not_found") {
            // §3.1: カタログ外。`getResource()` は resource_id の単純照会なので未登録は必ずここ。
            uncatalogued = true;
        }
        else if (!response.ok) {
            return refuse(["evidence_unavailable"], "decision");
        }
        else {
            decision = body;
        }
    }
    catch {
        // A3: 読めなかったのだから払わない。
        return refuse(["evidence_unavailable"], "decision");
    }
    const pathReasons = uncatalogued ? ["resource_uncatalogued"] : [];
    if (decision) {
        const serverReasons = Array.isArray(decision.reason_codes) ? decision.reason_codes : [];
        // A2: degraded は「測れなかった」。fail-closed のゲートにとっては読めなかったのと同じ。
        if (decision.degraded === true) {
            return refuse([...serverReasons, "evidence_unavailable"], "decision", decision);
        }
        // A1: ALLOW 以外。理由はサーバの reason_codes をそのまま通す（我々の語で上書きしない）。
        if (decision.recommendation !== "ALLOW") {
            return refuse([...serverReasons, "payee_recommendation_not_allow"], "decision", decision);
        }
        evidence.push(...(Array.isArray(decision.evidence) ? decision.evidence : []).map((row) => ({
            level: row.level,
            source: "vet402",
            url: row.url,
            ...(row.purchase_id ? { purchase_id: row.purchase_id } : {}),
        })));
        const shortfall = evaluateEvidencePolicy(input.policy?.evidence, decision);
        if (shortfall)
            return refuse([...serverReasons, ...shortfall], "decision", decision);
    }
    // --- 4. 402 チャレンジ ---
    let accept = null;
    try {
        const response = await fetchFn(input.resource, { method });
        const raw = readHeader(response.headers, "payment-required");
        if (raw)
            accept = decodeChallenge(raw);
    }
    catch {
        accept = null;
    }
    if (!accept) {
        // 402 を読めない＝いくら誰に払うのかが分からない。判定と同じく fail-closed。
        return refuse([...pathReasons, "evidence_unavailable"], uncatalogued ? "payee_score" : "decision", decision);
    }
    // A4: 照合は payTo で行う。402 の resource.url は内部ホスト名を返すことがある（§3）。
    if (!sameAddress(accept.payTo, input.payee)) {
        return refuse([...pathReasons, "payee_mismatch"], uncatalogued ? "payee_score" : "decision", decision, null, accept);
    }
    const moneyGate = evaluateMoneyGate(accept, maxPerTxUsd);
    if (moneyGate) {
        return refuse([...pathReasons, ...moneyGate], uncatalogued ? "payee_score" : "decision", decision, null, accept);
    }
    // --- 3'. カタログ外なら、ここまでで分かった payTo で受取人スコアを引く（I23）---
    let payeeScore = null;
    if (uncatalogued) {
        const scoreUrl = `${apiUrl}/payees/${accept.payTo}/score`;
        try {
            const response = await fetchFn(scoreUrl, { headers });
            if (!response.ok)
                throw new Error("payee_score_unavailable");
            payeeScore = (await response.json());
        }
        catch {
            return refuse([...pathReasons, "evidence_unavailable"], "payee_score", null, null, accept);
        }
        if (payeeScore?.degraded === true || (payeeScore?.signalsUnavailable?.length ?? 0) > 0) {
            return refuse([...pathReasons, "evidence_unavailable"], "payee_score", null, payeeScore, accept);
        }
        if (payeeScore?.recommendation !== "ALLOW") {
            return refuse([...pathReasons, "payee_recommendation_not_allow"], "payee_score", null, payeeScore, accept);
        }
        evidence.push({ level: "L0", source: "vet402", url: scoreUrl });
    }
    // --- 5. ここから先だけが支払い。実装は ALLOW ブランチ内の動的 import（第3層）---
    const { executeX402Payment } = await import("./x402-pay.js");
    const paid = await executeX402Payment({
        account: input.account,
        accept,
        resource: input.resource,
        chainId: BASE_CHAIN_ID,
        facilitatorUrl: input.facilitatorUrl ?? DEFAULT_FACILITATOR_URL,
        fetch: fetchFn,
    });
    const verdictSource = uncatalogued ? "payee_score" : "decision";
    if (!paid.settled) {
        // E18: 署名は実在する。隠さない。
        return {
            status: "failed",
            decision: record("ALLOW", [...pathReasons, "settle_failed"], verdictSource, decision, payeeScore),
            signed: paid.signed,
            attested: false,
            txHash: paid.txHash,
            challenge: accept,
        };
    }
    let attested = false;
    if (paid.txHash) {
        try {
            const response = await fetchFn(`${apiUrl}/payments/x402`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({
                    wallet: input.payee,
                    txHash: paid.txHash,
                    amount: accept.amount,
                    network: accept.network,
                    resource: input.resource,
                    source,
                }),
            });
            attested = response.ok === true;
        }
        catch {
            attested = false;
        }
    }
    return {
        status: "paid",
        decision: record("ALLOW", pathReasons, verdictSource, decision, payeeScore),
        signed: paid.signed,
        attested,
        txHash: paid.txHash,
        challenge: accept,
    };
}
/**
 * 金銭ゲート。**署名の前**にしか意味が無いので、呼ぶ位置を動かさないこと。
 * 本番には4チェーン提示の 402 が実在する（WINDOW_PLAN §4 B）。
 */
function evaluateMoneyGate(accept, maxPerTxUsd) {
    if (accept.network !== BASE_CHAIN)
        return ["chain_or_asset_mismatch"];
    if (!sameAddress(accept.asset, BASE_USDC))
        return ["chain_or_asset_mismatch"];
    if (accept.scheme !== "exact")
        return ["chain_or_asset_mismatch"];
    // 明示された転送方式が eip3009 でなければ拒否する。未提示は許す——Base 正規 USDC の
    // `exact` は構造上 EIP-3009 の transferWithAuthorization であり、未提示を拒むと
    // 実在する 402（フィールドを出さない実装）に払えなくなる。値が違うときだけ止める。
    const transfer = accept.extra?.assetTransferMethod;
    if (transfer !== undefined && transfer !== "eip3009")
        return ["chain_or_asset_mismatch"];
    const units = Number(accept.amount);
    if (!Number.isFinite(units) || units <= 0)
        return ["chain_or_asset_mismatch"];
    if (units / 10 ** USDC_DECIMALS > maxPerTxUsd)
        return ["price_above_ceiling"];
    return null;
}
/**
 * 呼び手が名指しした証拠の床を当てる。**判定（`/decision`）と policy 評価を分けてある**のは、
 * 会期中に証拠源（The Graph）を足すときにここだけを差し替えられるようにするため。
 *
 * 未実装の証拠源を黙って弱い方（自社台帳）に落とさない: `subgraph` を名指しされたのに
 * 読めていないなら、それは `evidence_unavailable` である（DESIGN §3.5）。
 */
function evaluateEvidencePolicy(policy, decision) {
    if (!policy)
        return null;
    const wanted = policy.source ?? "vet402";
    if (wanted === "vet402" || wanted === "both") {
        const facts = decision.facts;
        const delivered = typeof facts?.l1?.n_delivered === "number" ? facts.l1.n_delivered : 0;
        if (policy.minL1Deliveries !== undefined && delivered < policy.minL1Deliveries) {
            return ["insufficient_delivery_evidence"];
        }
    }
    if (wanted === "subgraph" || wanted === "both") {
        // 会期中に実装（C11 / C12 / D13-D16）。読めていない以上、通してはいけない。
        return ["evidence_unavailable"];
    }
    return null;
}
/**
 * デモ（`source: "agent-demo"`）の決定行フィードと L1 台帳フィード。**未実装**。
 *
 * 会期スコープ #4（WINDOW_PLAN §2）。別ストアであること自体がテストの対象（F19/F20）で、
 * 名前だけ生やして空配列を返すと「汚染していない」が空振りで緑になる。だから throw する。
 */
export async function readDemoDecisions() {
    throw new Error("not_implemented: agent-demo decision feed — WINDOW_PLAN §2 item 4 (F19/F20)");
}
export async function readL1Decisions() {
    throw new Error("not_implemented: L1 decision feed — WINDOW_PLAN §2 item 4 (F19/F20)");
}

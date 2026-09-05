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
 *   5. 全部通ったときだけ `./x402-pay.js` を動的 import して署名 → **売り手へ再送** → attest
 *
 * 5 について: **買い手は facilitator を呼ばない。決済するのは売り手**（x402-pay.ts の
 * 冒頭に一次根拠）。2026-09-05 まで、ここは買い手から `x402.org/facilitator/settle` を
 * 叩いていた。その形のまま 09-08 に実支払いをすれば、金は動かず理由も残らなかった。
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
/**
 * v1 の綴りを v2 の形へ揃える。実在する v1 の壁は `network: "base"` と
 * `maxAmountRequired` を使う（本番 `x402-payer.ts` の normalizeAccept と同じ規則）。
 * ここで揃えておかないと、金銭ゲートが v1 を丸ごと chain_or_asset_mismatch で落とし、
 * v1 の transport（X-PAYMENT）が届かない死んだ枝になる。
 */
function normalizeAccept(raw) {
    if (typeof raw !== "object" || raw === null)
        return null;
    const rec = raw;
    const amount = typeof rec.amount === "string" ? rec.amount
        : typeof rec.maxAmountRequired === "string" ? rec.maxAmountRequired
            : null;
    const payTo = typeof rec.payTo === "string" ? rec.payTo : null;
    if (amount === null || payTo === null)
        return null;
    if (typeof rec.scheme !== "string" || typeof rec.asset !== "string")
        return null;
    const network = rec.network === "base" ? BASE_CHAIN
        : rec.network === "base-sepolia" ? "eip155:84532"
            : typeof rec.network === "string" ? rec.network
                : "";
    return {
        scheme: rec.scheme,
        network,
        amount,
        asset: rec.asset,
        payTo,
        ...(typeof rec.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: rec.maxTimeoutSeconds } : {}),
        ...(typeof rec.extra === "object" && rec.extra !== null ? { extra: rec.extra } : {}),
    };
}
/** チャレンジは **transport のバージョンごと**読む——答える側のヘッダ名がそれで決まる。 */
function decodeChallenge(raw) {
    try {
        const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
        const accepts = json.accepts;
        if (!Array.isArray(accepts) || accepts.length === 0)
            return null;
        const accept = normalizeAccept(accepts[0]);
        if (!accept)
            return null;
        return { x402Version: json.x402Version === 1 ? 1 : 2, accept };
    }
    catch {
        return null;
    }
}
/**
 * 判定を引き、全部の条件を通ったときにだけ払う。結果は `decisionStore` を渡したときだけ
 * 1本の JSONL へ追記される（下の {@link appendDecision}）。
 */
export async function payOrRefuse(input) {
    const result = await decideAndPay(input);
    if (input.decisionStore === undefined)
        return result;
    try {
        await appendDecision({
            ...result.decision,
            at: new Date().toISOString(),
            status: result.status,
            resource: input.resource,
            txHash: result.txHash,
            nonce: result.nonce,
        }, { store: input.decisionStore });
        return { ...result, stored: true, storeError: null };
    }
    catch (error) {
        // 台帳に書けなかったことを理由に結果を握り潰さない。握り潰すと「払ったのに
        // nonce も txHash も残らない」が起きる。黙って成功にもしない（fail-loud）。
        return { ...result, stored: false, storeError: String(error instanceof Error ? error.message : error) };
    }
}
async function decideAndPay(input) {
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
        nonce: null,
        challenge,
        stored: false,
        storeError: null,
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
    let x402Version = 2;
    try {
        const response = await fetchFn(input.resource, { method });
        const raw = readHeader(response.headers, "payment-required");
        const challenge = raw ? decodeChallenge(raw) : null;
        if (challenge) {
            accept = challenge.accept;
            x402Version = challenge.x402Version;
        }
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
    // 署名 → **売り手へ再送** → 応答ヘッダのレシート。facilitator は買い手の経路に無い。
    const { executeX402Payment } = await import("./x402-pay.js");
    // 署名の直後に nonce を確定させる。ここから先で落ちても「何に署名したか」は残る。
    let signedNonce = null;
    const paid = await executeX402Payment({
        account: input.account,
        accept,
        resource: input.resource,
        method,
        chainId: BASE_CHAIN_ID,
        x402Version,
        fetch: fetchFn,
        onSigned: ({ nonce }) => {
            signedNonce = nonce;
        },
    });
    const verdictSource = uncatalogued ? "payee_score" : "decision";
    if (!paid.settled) {
        // E18: 署名は実在する。隠さない。nonce も返す——署名した認可は validBefore まで
        // 生きた金で、後から遅れて決済され得る。何に署名したかが残らないと照合できない。
        return {
            status: "failed",
            decision: record("ALLOW", [...pathReasons, "settle_failed"], verdictSource, decision, payeeScore),
            signed: paid.signed,
            attested: false,
            txHash: paid.txHash,
            nonce: paid.nonce ?? signedNonce,
            challenge: accept,
            stored: false,
            storeError: null,
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
                    // 監査の nonce 束縛（本番 settlement-verify.ts）。attest がこれを載せて初めて、
                    // 「その決済 tx はこの購入のものか」を第三者が確かめられる。
                    authNonce: paid.nonce,
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
        nonce: paid.nonce ?? signedNonce,
        challenge: accept,
        stored: false,
        storeError: null,
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
    // EIP-712 ドメインはトークンのものであって売り手のものではない（本番 2026-08-22 監査）。
    // 矛盾する accept を**署名の前に**落とす: 誤ったドメインの署名は決済され得ないので、
    // 通せば「一円も動かないまま署名だけが生きている」状態を売り手が無料で作れてしまう。
    // 判定は署名器と同じ述語（hasCanonicalUsdcDomain）で行う——別の述語では関門にならない。
    const name = accept.extra?.name;
    const version = accept.extra?.version;
    if ((name !== undefined && name !== "USD Coin") || (version !== undefined && version !== "2")) {
        return ["chain_or_asset_mismatch"];
    }
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
// ============================================================
// 決定行の保存先（WINDOW_PLAN §2 #4 / F19・F20）
//
// **1本のローカル追記専用 JSONL に、行ごと `source` で区別して入れる。**
//
// なぜ1本か: デモ行と L1 行を別ファイルに分けると、「混ざっていない」が
// ファイルが違うという理由で構造的に自明になり、F20 が何も証明しなくなる。
// 同じ store に混ぜて、**読み手が正しく分ける**ことを要求してはじめて混線が検出できる。
//
// なぜローカルか: 会期中は本番のスキーマを触らない（実装凍結）。決定行は
// **本番 DB へは一切書かない**——`payOrRefuse` が出す書き込み系の HTTP は
// 支払いの再送と attest だけであることを F19 が固定している。
// ============================================================
/** 既定の保存先。呼び出し側の cwd からの相対。 */
export const DEFAULT_DECISION_STORE = ".vet402/decisions.jsonl";
/**
 * 決定行を1行追記する。**追記専用**——既存の行を書き換えない
 * （書き換えられる台帳は台帳ではない。過去の判定は後から都合よく直せてはいけない）。
 */
export async function appendDecision(row, options = {}) {
    // node:fs は動的 import。ブラウザ／エッジで `payOrRefuse` を判定だけに使う呼び手が、
    // ファイルシステムを持たないという理由で import 時に落ちないようにする。
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = options.store ?? DEFAULT_DECISION_STORE;
    const dir = dirname(path);
    if (dir && dir !== "." && dir !== path)
        await mkdir(dir, { recursive: true });
    await appendFile(path, JSON.stringify(row) + "\n", "utf8");
}
/** store を読み、`source` が一致する行だけ返す。 */
async function readDecisions(source, options) {
    const { readFile } = await import("node:fs/promises");
    const path = options.store ?? DEFAULT_DECISION_STORE;
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch {
        // まだ1行も書かれていない = 決定が0件。存在しないことを異常にしない。
        return [];
    }
    const rows = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "")
            continue;
        try {
            const row = JSON.parse(trimmed);
            // 追記専用ファイルは書き込みの途中で千切れ得る。読めない行は**捨てるが、
            // 読めた行は返す**——1行の破損で台帳全体が読めなくなる方が危険。
            if (row && row.source === source)
                rows.push(row);
        }
        catch {
            continue;
        }
    }
    return rows;
}
/** デモ（`source: "agent-demo"`）の決定行だけを返す。 */
export async function readDemoDecisions(options = {}) {
    return readDecisions("agent-demo", options);
}
/** L1（`source: "vet402"`）の決定行だけを返す。 */
export async function readL1Decisions(options = {}) {
    return readDecisions("vet402", options);
}

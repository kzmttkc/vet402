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
// 証拠源2つ目。**支払いモジュールではない**ので静的 import でよい（第3層の証明は
// `x402-pay.js` にだけ掛かる。`test/no-static-payment-import.test.mjs`）。
import { readSubgraphReceipts, X402_BASE_SUBGRAPH_ID } from "./subgraph-evidence.js";
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
/**
 * この accept は**プロトコル上そもそも払える形か**。本番 `x402-payer.ts` の
 * `selectAccept` の `protocolEligible` と同じ4条件（scheme / network / asset / 転送方式）。
 * 金額と payTo は**含めない**——それは「払えるか」ではなく「払ってよいか」で、
 * 呼び手の上限と期待値に依存する（{@link evaluateMoneyGate} と payee 照合が持つ）。
 */
function isProtocolEligible(accept) {
    if (accept.scheme !== "exact")
        return false;
    if (accept.network !== BASE_CHAIN)
        return false;
    if (!sameAddress(accept.asset, BASE_USDC))
        return false;
    // 明示された転送方式が eip3009 でなければ払えない。未提示は許す——Base 正規 USDC の
    // `exact` は構造上 EIP-3009 であり、未提示を拒むと実在する 402 に払えなくなる。
    const transfer = accept.extra?.assetTransferMethod;
    return transfer === undefined || transfer === "eip3009";
}
/**
 * EIP-712 ドメインがトークンのもの（本番 2026-08-22 の `eth_call` 実測）と矛盾しないか。
 * **売り手の名乗りを採用するためではなく、矛盾を検出するために読む。**
 */
function hasCanonicalUsdcDomain(accept) {
    const name = accept.extra?.name;
    const version = accept.extra?.version;
    return (name === undefined || name === "USD Coin") && (version === undefined || version === "2");
}
/**
 * **提示された accepts から、条件を満たす最初のものを選ぶ。**
 *
 * 2026-09-05 まで、ここは `accepts[0]` を無条件に取っていた。実測（拒否側フィクスチャ
 * `agent.api.0x.org`）の 402 は accept を**3件**返す——Base USDC / Solana /
 * Base の `GatewayWalletBatched` ドメイン。先頭がたまたま正しかっただけで、
 * **売り手が順序を並べ替えれば SDK は Solana を掴み、拒否の理由がすり替わる**。
 * 拒否そのものは変わらないが、「拒否の理由は正確である」という主張が壊れる。
 *
 * 意味論は本番 `src/lib/observatory/x402-payer.ts` の `selectAccept` に揃える。
 * ただし**本番と1点だけ違う**: 本番は EIP-712 ドメインを `protocolEligible` の
 * ハードなフィルタに入れ、全滅すれば `no_eligible_accept` を返す。ここでは
 * ドメインは**優先順位**として使い、正規のものが1件も無ければ eligible の先頭を返す——
 * そのまま {@link evaluateMoneyGate} が `chain_or_asset_mismatch` で落とすので
 * 結論（署名しない）は同じで、**なぜ落ちたかがより具体的に残る**。
 *
 * @returns `eligible: false` は「提示は読めたが、払える形が1件も無い」。
 *   そのときも `accept` には**実際に提示された1件**を入れて返す——
 *   拒否理由を具体的に出すため、そして画に存在しない accept を映さないため。
 */
function selectAccept(raw) {
    const normalized = raw.map(normalizeAccept).filter((a) => a !== null);
    if (normalized.length === 0)
        return null;
    const eligible = normalized.filter(isProtocolEligible);
    if (eligible.length === 0)
        return { accept: normalized[0], eligible: false };
    return { accept: eligible.find(hasCanonicalUsdcDomain) ?? eligible[0], eligible: true };
}
/** チャレンジは **transport のバージョンごと**読む——答える側のヘッダ名がそれで決まる。 */
function decodeChallenge(raw) {
    try {
        const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
        const accepts = json.accepts;
        if (!Array.isArray(accepts) || accepts.length === 0)
            return null;
        const selected = selectAccept(accepts);
        if (!selected)
            return null;
        return {
            x402Version: json.x402Version === 1 ? 1 : 2,
            accept: selected.accept,
            eligible: selected.eligible,
        };
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
    // **評価できない床を黙って無視しない**（WINDOW_PLAN §13「会期後に必ず直すもの #2」）。
    // 2026-09-05 まで、`minSubgraphReceipts` は既定 source が "vet402" のときどの分岐にも
    // 当たらず、床を指定したのに拒否も警告も出なかった。「壊れて見えない」型の欠陥。
    assertEvidencePolicy(input.policy?.evidence);
    // §3.2: vet402 の判定を外すなら代わりの床が要る。**順序は evidence の整合が先**——
    // `{ minL1Deliveries: 3, source: "subgraph" }` のような誤りは、床の有無より前に、
    // 「その床は評価されない」と言われるべきだから。
    assertOverridePolicy(input.policy);
    // account は**検査しない**。`typeof account.signTypedData === "function"` と書いた瞬間に
    // 拒否経路から signer へのプロパティ参照が発生し、「到達できない」が嘘になる。
    const method = (input.method ?? "GET").toUpperCase();
    const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    const maxPerTxUsd = input.policy?.maxPerTxUsd ?? DEFAULT_MAX_PER_TX_USD;
    const source = input.source ?? "sdk";
    const headers = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};
    const requireVet402Allow = input.policy?.requireVet402Allow !== false;
    const evidence = [];
    const record = (recommendation, reason_codes, verdict_source, decision, payeeScore, policy_override = null) => ({
        recommendation,
        reason_codes,
        verdict_source,
        evidence,
        decision,
        payeeScore,
        policy_override,
        source,
    });
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
    const serverReasons = decision && Array.isArray(decision.reason_codes) ? decision.reason_codes : [];
    const evidenceVerdictSource = uncatalogued ? "payee_score" : "decision";
    // --- 3.5 宣言された証拠源を**すべて**読む。judgement の前に読むのは意図的で、
    // 「拒否したときにも、もう一方の源が何を知っているかは残る」ようにするため——
    // §3.1 の核（同じウォレットについて3つの情報源が3つ違うことを言う）は、まさに
    // 我々が拒否する相手について成り立つ。D14 はこの順序を固定している。
    const wantedSource = input.policy?.evidence?.source ?? "vet402";
    let subgraph = null;
    if (wantedSource === "subgraph" || wantedSource === "both") {
        const read = await readSubgraphReceipts({
            address: input.payee,
            fetch: fetchFn,
            apiKey: input.policy?.evidence?.graphApiKey,
            subgraphId: input.policy?.evidence?.subgraphId ?? X402_BASE_SUBGRAPH_ID,
        });
        if (!read.ok) {
            // C12/D13: **どちらの源が読めなかったか**を機械可読で残す。黙って自社台帳へ落ちない。
            return refuse([...pathReasons, ...serverReasons, "evidence_unavailable", "subgraph_evidence_unavailable"], evidenceVerdictSource, decision);
        }
        subgraph = read;
        // D15: live であることの証跡（subgraphId / block / deployment / queriedAt）を同梱する。
        // D16: **自社台帳の行とは別の行**として持つ。件数も行ごとに別（合算しない）。
        evidence.push({
            level: "L1",
            source: "subgraph",
            url: read.publicUrl,
            subgraphId: read.subgraphId,
            block: read.block,
            ...(read.deployment ? { deployment: read.deployment } : {}),
            queriedAt: read.queriedAt,
            receipts: read.receipts,
        });
    }
    // 免除した判定。**通したときにだけ**決定行へ載せる（§3.2）。ここで控えておいて、
    // 床を当てたあとに `policy_override` を組む——免除だけしても床で落ちれば「通した規則」は
    // 存在しないので、そのときは何も書かない。
    let waived = null;
    if (decision) {
        // A2: degraded は「測れなかった」。fail-closed のゲートにとっては読めなかったのと同じ。
        // **`requireVet402Allow: false` でもここは通さない**——免除したのは判定の中身であって、
        // 判定が存在しないことではない（J7）。
        if (decision.degraded === true) {
            return refuse([...serverReasons, "evidence_unavailable"], "decision", decision);
        }
        // A1: ALLOW 以外。理由はサーバの reason_codes をそのまま通す（我々の語で上書きしない）。
        if (decision.recommendation !== "ALLOW") {
            if (requireVet402Allow) {
                return refuse([...serverReasons, "payee_recommendation_not_allow"], "decision", decision);
            }
            waived = {
                source: "decision",
                recommendation: String(decision.recommendation),
                score: null,
                reason_codes: serverReasons,
            };
        }
        // 読んだ証拠行は**判定の中身に関わらず**残す（§3.5 と同じ理由——拒否したときにも、
        // その源が何を知っているかは残る）。
        evidence.push(...(Array.isArray(decision.evidence) ? decision.evidence : []).map((row) => ({
            level: row.level,
            source: "vet402",
            url: row.url,
            ...(row.purchase_id ? { purchase_id: row.purchase_id } : {}),
        })));
    }
    // --- 3.6 呼び手が名指しした床を当てる。**カタログ外（decision が null）でも当てる**——
    // ここで無視すると、この機能がいちばん要る場所（一度も見たことのない売り手）で
    // 効かないことになる（C11c）。
    const floors = evaluateEvidencePolicy(input.policy?.evidence, decision, subgraph);
    if (floors.shortfall) {
        return refuse([...pathReasons, ...serverReasons, ...floors.shortfall], evidenceVerdictSource, decision);
    }
    // --- 4. 402 チャレンジ ---
    let accept = null;
    let x402Version = 2;
    // 「提示は読めたが、払える形が1件も無い」——**掴んだ1件が違った**とは別の所見なので、
    // 一次の所見としてこの語を先頭に置く（売り手が順序を変えても理由がすり替わらない）。
    let selectionReasons = [];
    try {
        const response = await fetchFn(input.resource, { method });
        const raw = readHeader(response.headers, "payment-required");
        const challenge = raw ? decodeChallenge(raw) : null;
        if (challenge) {
            accept = challenge.accept;
            x402Version = challenge.x402Version;
            selectionReasons = challenge.eligible ? [] : ["no_eligible_accept"];
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
        return refuse([...pathReasons, ...selectionReasons, "payee_mismatch"], uncatalogued ? "payee_score" : "decision", decision, null, accept);
    }
    const moneyGate = evaluateMoneyGate(accept, maxPerTxUsd);
    if (moneyGate) {
        return refuse([...pathReasons, ...selectionReasons, ...moneyGate], uncatalogued ? "payee_score" : "decision", decision, null, accept);
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
        // 免除の対象外（J7）。**測れなかったことは、ALLOW でないことと別**である。
        if (payeeScore?.degraded === true || (payeeScore?.signalsUnavailable?.length ?? 0) > 0) {
            return refuse([...pathReasons, "evidence_unavailable"], "payee_score", null, payeeScore, accept);
        }
        if (payeeScore?.recommendation !== "ALLOW") {
            if (requireVet402Allow) {
                return refuse([...pathReasons, "payee_recommendation_not_allow"], "payee_score", null, payeeScore, accept);
            }
            // §3.2 のカタログ外経路。**床は既に 3.6 で当たっている**——`requireVet402Allow: false`
            // は床が1つ以上あることを呼び出し側エラーで強制しているので、ここに来た時点で
            // 「vet402 の判定を外し、代わりの床は満たされている」が成立している。
            waived = {
                source: "payee_score",
                recommendation: String(payeeScore?.recommendation ?? "unknown"),
                score: typeof payeeScore?.score === "number" ? payeeScore.score : null,
                reason_codes: [],
            };
        }
        evidence.push({ level: "L0", source: "vet402", url: scoreUrl });
    }
    // どの規則で通したか。**免除を使ったときにだけ**組む（J8: vet402 が ALLOW を出したなら
    // 上書きは起きていないので null のまま）。
    const policyOverride = waived
        ? { rule: "requireVet402Allow:false", waived, floors_met: floors.met }
        : null;
    // vet402 が何と言っていたかは**消さない**。WARN の理由をそのまま残したうえで、
    // 誰が通したかを1語足す。弱くしたことを隠さないための形。
    const allowReasons = policyOverride
        ? [...pathReasons, ...policyOverride.waived.reason_codes, "allowed_by_caller_policy"]
        : pathReasons;
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
    // 通したのが vet402 の判定なのか、呼び手の規則なのか。**審査員が読むのはここ**（§3.2）。
    const verdictSource = policyOverride ? "caller_policy" : uncatalogued ? "payee_score" : "decision";
    if (!paid.settled) {
        // E18: 署名は実在する。隠さない。nonce も返す——署名した認可は validBefore まで
        // 生きた金で、後から遅れて決済され得る。何に署名したかが残らないと照合できない。
        return {
            status: "failed",
            decision: record("ALLOW", [...allowReasons, "settle_failed"], verdictSource, decision, payeeScore, policyOverride),
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
        decision: record("ALLOW", allowReasons, verdictSource, decision, payeeScore, policyOverride),
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
    // scheme / network / asset / 転送方式。**選別と同じ述語**で見る——別の述語を書くと、
    // 選ばれたのに関門で落ちる（またはその逆の）食い違いが静かに入り込む。
    if (!isProtocolEligible(accept))
        return ["chain_or_asset_mismatch"];
    // EIP-712 ドメインはトークンのものであって売り手のものではない（本番 2026-08-22 監査）。
    // 矛盾する accept を**署名の前に**落とす: 誤ったドメインの署名は決済され得ないので、
    // 通せば「一円も動かないまま署名だけが生きている」状態を売り手が無料で作れてしまう。
    if (!hasCanonicalUsdcDomain(accept))
        return ["chain_or_asset_mismatch"];
    const units = Number(accept.amount);
    if (!Number.isFinite(units) || units <= 0)
        return ["chain_or_asset_mismatch"];
    if (units / 10 ** USDC_DECIMALS > maxPerTxUsd)
        return ["price_above_ceiling"];
    return null;
}
/**
 * **呼び出し側の誤りを、通信の前に落とす。**
 *
 * `evidence` の床は、名乗った `source` が評価できるものでなければならない。
 * 評価できない床を黙って無視すると「床を指定したのに拒否も警告も出ない」——
 * 正しい値が別名で渡って下流で黙って捨てられるのと同じ、**壊れて見えない**型の欠陥になる
 * （WINDOW_PLAN §13「会期後に必ず直すもの #2」に実物が記録されている）。
 *
 * **黙って `source` を格上げする案は採らなかった。** 理由は2つ。
 *  (1) `{ source: "vet402", minSubgraphReceipts: 100 }` のように**明示的に矛盾**した指定は
 *      格上げでは扱えない（明示された "vet402" を勝手に "subgraph" へ変えるのは、
 *      呼び手が書いた文字を無視することであり、無視の一形態でしかない）。
 *  (2) 格上げしたとき呼び手が受け取るのは `evidence_unavailable`（鍵が無ければ必ずそうなる）で、
 *      **「source を書き忘れた」という本当の原因がどこにも出ない**。ここで throw すれば、
 *      通信の前に、call site で、原因そのものが名指しで返る。
 * 対称に、`{ source: "subgraph", minL1Deliveries: 3 }` も同じ理由で呼び出し側エラー。
 */
function assertEvidencePolicy(policy) {
    if (!policy)
        return;
    const wanted = policy.source ?? "vet402";
    if (wanted !== "vet402" && wanted !== "subgraph" && wanted !== "both") {
        throw new Error(`invalid_evidence_policy: unknown evidence source ${JSON.stringify(wanted)}`);
    }
    if (policy.minSubgraphReceipts !== undefined && wanted !== "subgraph" && wanted !== "both") {
        throw new Error(`invalid_evidence_policy: minSubgraphReceipts needs evidence.source "subgraph" or "both", got ${JSON.stringify(wanted)}. ` +
            "It would otherwise be ignored in silence — the floor you set would never be applied.");
    }
    if (policy.minL1Deliveries !== undefined && wanted !== "vet402" && wanted !== "both") {
        throw new Error(`invalid_evidence_policy: minL1Deliveries needs evidence.source "vet402" or "both", got ${JSON.stringify(wanted)}. ` +
            "It would otherwise be ignored in silence — the floor you set would never be applied.");
    }
}
/**
 * 呼び手が名指しした証拠の床を当てる。**判定（`/decision`）と policy 評価を分けてある**のは、
 * 証拠源を足すときにここだけを差し替えられるようにするため。
 *
 * `subgraph` は**別の引数で受け取る**——`decision` の中に混ぜ込むと、そこから先で
 * 2つの源の数を1つにまとめる書き方が自然になってしまう（D16 が禁じている形）。
 * 源が違えば数えたものも違う。**足せる数ではない。**
 *
 * 未実装／未取得の証拠源を黙って弱い方（自社台帳）に落とさない: `subgraph` を名指しされたのに
 * 読めていないなら、それは `evidence_unavailable` である（DESIGN §3.5）。
 */
function evaluateEvidencePolicy(policy, decision, subgraph) {
    const met = [];
    if (!policy)
        return { shortfall: null, met };
    const wanted = policy.source ?? "vet402";
    if ((wanted === "vet402" || wanted === "both") && policy.minL1Deliveries !== undefined) {
        const facts = decision?.facts;
        const delivered = typeof facts?.l1?.n_delivered === "number" ? facts.l1.n_delivered : 0;
        if (delivered < policy.minL1Deliveries) {
            return { shortfall: ["insufficient_delivery_evidence"], met };
        }
        met.push({
            floor: "minL1Deliveries",
            source: "vet402",
            required: policy.minL1Deliveries,
            observed: delivered,
        });
    }
    if ((wanted === "subgraph" || wanted === "both") && policy.minSubgraphReceipts !== undefined) {
        // 読めていれば上（3.5）で必ず埋まっている。null は「読めなかった」であって 0 件ではない。
        if (!subgraph)
            return { shortfall: ["evidence_unavailable", "subgraph_evidence_unavailable"], met };
        if (subgraph.receipts < policy.minSubgraphReceipts) {
            return { shortfall: ["insufficient_subgraph_evidence"], met };
        }
        met.push({
            floor: "minSubgraphReceipts",
            source: "subgraph",
            required: policy.minSubgraphReceipts,
            observed: subgraph.receipts,
        });
    }
    return { shortfall: null, met };
}
/**
 * **vet402 の判定を外すなら、代わりを置け。**（WINDOW_PLAN §3.2）
 *
 * `requireVet402Allow: false` は「あなたは vet402 を信じなくてよい」という
 * 製品の主張そのものだが、**信じないことと、誰も判定しないことは違う**。
 * 床を1つも宣言せずに外せば、`payOrRefuse` は上限と 402 の整合だけを見る関数になり、
 * 「署名の前に判定する」という存在理由が消える。だから通信の前に、call site で落とす。
 *
 * **0 の床を床として数えない。** `{ minL1Deliveries: 0 }` は何も判定しないので、
 * これを許せば規則を1語足すだけで全部素通しにできる（＝抜け道が既定の使い方になる）。
 * 少なくとも1つは 1 以上でなければならない。
 *
 * `invalid_evidence_policy` と同じ思想（黙って無視せず、原因そのものを名指しで返す）だが、
 * **語を分けてある**——あちらは「その床は評価されない」、こちらは「床が存在しない」で、
 * 呼び手が直す場所が違う。
 */
function assertOverridePolicy(policy) {
    if (!policy || policy.requireVet402Allow !== false)
        return;
    const evidence = policy.evidence;
    const floors = [evidence?.minL1Deliveries, evidence?.minSubgraphReceipts];
    if (floors.some((floor) => typeof floor === "number" && floor > 0))
        return;
    throw new Error("invalid_policy: requireVet402Allow: false waives vet402's verdict, so it needs at least one " +
        "evidence floor above zero (policy.evidence.minL1Deliveries or policy.evidence.minSubgraphReceipts). " +
        "Without one, nothing would judge this payment — a floor of 0 judges nothing either.");
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

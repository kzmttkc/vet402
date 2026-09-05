import { SpendGuard } from "./spend-guard.js";
export { SpendGuard, DEFAULT_MAX_SCORE_AGE_MS, } from "./spend-guard.js";
// ETHOnline 2026（会期中の新規・WINDOW_PLAN §2）。判定のあと、条件を全部通したときだけ払う。
// テストは dist から読む（rootDir: src / outDir: dist）ので、ここから re-export する。
export { payOrRefuse, readDemoDecisions, readL1Decisions, appendDecision, DEFAULT_DECISION_STORE, BASE_CHAIN, BASE_CHAIN_ID, BASE_USDC, DEFAULT_MAX_PER_TX_USD, } from "./pay-or-refuse.js";
/**
 * 第2の証拠源（The Graph の x402 Base subgraph）。呼び手が自分の鍵で自分で引ける形で
 * 公開する——「あなたは vet402 を信じなくてよい」を、道具として渡せなければ主張にならない。
 */
export { readSubgraphReceipts, X402_BASE_SUBGRAPH_ID, GRAPH_GATEWAY_ORIGIN, GRAPH_USER_AGENT, DEFAULT_GRAPH_TIMEOUT_MS, } from "./subgraph-evidence.js";
/**
 * Does this fast verdict clear a payment? The one correct reading of the fast
 * surface, written once so nobody has to re-derive it at a call site.
 *
 * True ONLY for `status: "hit"` with an `ALLOW` recommendation that has not
 * passed its own `cacheExpiresAt`. `cache_cold` is false — it means "nothing
 * was pinned", which is the absence of a verdict, not a permissive one. The
 * expiry re-check is belt-and-braces: the server already refuses to return an
 * expired entry, but a fast path that gates money should not depend on the
 * other side having done that.
 *
 * NOTE the deliberate asymmetry with {@link SpendGuard}: a `false` here means
 * "do not pay yet", NOT "this payee is bad". Warm the cache with
 * {@link VouchClient.getPayeeScore} and decide on the full body.
 */
export function payeeVerdictFastAllows(verdict, nowMs = Date.now()) {
    if (verdict.status !== "hit")
        return false;
    if (verdict.recommendation !== "ALLOW")
        return false;
    const expiresMs = Date.parse(verdict.cacheExpiresAt);
    if (Number.isNaN(expiresMs))
        return false;
    return nowMs < expiresMs;
}
/**
 * Hosted production API. Used when `apiUrl` is omitted.
 *
 * 2026-08-13 (hackathon persona R2): `createVouchClient({ apiKey })` used to
 * throw a raw `TypeError: Cannot read properties of undefined (reading
 * 'replace')` from inside dist/index.js — the single most likely first line a
 * new integrator writes, failing with a stack trace that names none of our
 * options. The one URL that argument could sensibly take is this one, so it is
 * now the default instead of a crash.
 */
export const DEFAULT_API_URL = "https://vet402.com/api/v1";
/**
 * Default per-request timeout (10 s). A timeout surfaces as a lookup failure,
 * which SpendGuard denies as `payee_trust_unavailable` — fail-closed.
 *
 * WHY 10 s AND NOT THE MIDDLEWARE'S 5 s (2026-08-22). @vet402/middleware
 * defaults to 5000 ms and is right to: it runs INSIDE an HTTP handler that has
 * its own deadline, so it must give the framework its answer back quickly. An
 * SDK does not necessarily run inside a request at all. Two measured facts set
 * this value instead:
 *
 *   1. the sibling Python SDK already ships a 10 s default
 *      (packages/python-sdk/src/vet402/client.py, `timeout: float = 10.0`),
 *      and two SDKs with identical SpendGuard semantics must not disagree on
 *      how long "too long" is;
 *   2. `GET /api/v1/payees/{address}/score` declares `maxDuration = 30`
 *      (src/app/api/v1/payees/[address]/score/route.ts) — the server itself
 *      budgets up to 30 s for a COLD score (chain reads + DB). Because the
 *      guard fails closed, a bound tighter than the server's own cold path
 *      does not fail safe in the useful sense: it turns a slow-but-correct
 *      ALLOW into a denial of a payment that should have gone through.
 *
 * Override with `timeoutMs` when your own deadline is stricter.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export class VouchApiError extends Error {
    code;
    status;
    constructor(code, status) {
        super(code);
        this.name = "VouchApiError";
        this.code = code;
        this.status = status;
    }
}
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const AGENT_ID_RE = /^\d+$/;
export class VouchClient {
    apiUrl;
    apiKey;
    fetchFn;
    timeoutMs;
    constructor(options) {
        const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
        if (typeof apiUrl !== "string" || apiUrl.trim() === "") {
            throw new Error("invalid_api_url: apiUrl must be a non-empty URL string " +
                `(e.g. "${DEFAULT_API_URL}") — omit it to use the hosted API`);
        }
        if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
            throw new Error("invalid_api_key: apiKey is required — create one at https://vet402.com/dashboard");
        }
        const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            // Infinity is rejected as well: "no timeout" is the bug this option
            // exists to close, and AbortSignal.timeout(Infinity) throws anyway.
            throw new Error("invalid_timeout_ms: timeoutMs must be a positive, finite number of " +
                `milliseconds (default ${DEFAULT_REQUEST_TIMEOUT_MS})`);
        }
        this.apiUrl = apiUrl.replace(/\/$/, "");
        this.apiKey = options.apiKey;
        this.fetchFn = options.fetch ?? fetch;
        this.timeoutMs = timeoutMs;
    }
    getAgentScore(agentId, wallet) {
        assertAgentId(agentId);
        if (wallet)
            assertWallet(wallet);
        const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
        return this.request(`/agents/${agentId}/score${query}`);
    }
    getWalletScore(wallet) {
        assertWallet(wallet);
        return this.request(`/wallets/${wallet}/score`);
    }
    /**
     * Buyer-side lookup: "should my agent pay this wallet?" — scores the
     * payment *recipient* (settlement receiving history, wallet health,
     * exit-scam-shaped outflow, outcome labels).
     */
    getPayeeScore(payee) {
        assertWallet(payee);
        return this.request(`/payees/${payee}/score`);
    }
    /**
     * verify-at-settle fast surface: the engine's already-pinned verdict, or an
     * honest `cache_cold`. **This surface never computes** — it is a cache peek,
     * with the server's in-handler p95 held under 1 ms by
     * `tests/verdict-fast.test.ts`. For facilitators and payment middleware that
     * need a trust check INSIDE the settlement flow.
     *
     * Fail-closed reading, and the caller owns it: treat anything that is not an
     * explicit `hit` + `ALLOW` — `cache_cold` above all — as "do not pay yet".
     * {@link payeeVerdictFastAllows} is that rule, already written.
     *
     * WHY IT IS SAFE TO ACT ON A HIT. The engine only pins verdicts it was
     * confident in: a degraded or partially-measured reading is never cached
     * (src/lib/scoring/payee-engine.ts — the `cache.set` is guarded by
     * `!degraded && !partiallyMeasured`). So a `hit` cannot be a fail-closed
     * refusal wearing an ALLOW, which is exactly why this body does not need to
     * carry `degraded` / `signalsUnavailable`.
     *
     * WHY {@link SpendGuard} STILL DOES NOT USE IT. The guard also enforces
     * `minPayeeScore` bands and its own `maxScoreAgeMs`, and reports the full
     * `payeeScore` in its decision — none of which this body can supply. The
     * fast surface is a pre-check for a settlement path that already has its own
     * deadline, not a replacement for the score. Warm with
     * {@link VouchClient.getPayeeScore} (same cache, TTL 5 min) and retry.
     */
    getPayeeVerdictFast(payee) {
        assertWallet(payee);
        return this.request(`/payees/${payee}/verdict-fast`);
    }
    /**
     * Non-custodial spend-policy guard. Returns allow/deny decisions only —
     * never touches keys, funds, or transaction signing; execution remains the
     * agent's wallet stack's job (Coinbase AgentKit, Privy, ...). Fail-closed
     * by default (0.2.0): money moves only on a clean ALLOW verdict unless the
     * policy explicitly opts out via `trustPolicy`. The daily budget counter is
     * in-memory per guard instance and resets on process restart. See
     * SpendGuard for the full contract.
     */
    /** §9.1 GET /resources/{resource_id}/decision — facts と recommendation を同じ応答で。 */
    getDecision(resourceId, query = {}) {
        if (!/^[0-9a-f]{64}$/.test(resourceId))
            throw new Error("invalid_resource_id");
        const role = query.role ?? "payer";
        if (role === "payee" && !query.payer)
            throw new Error("payer_required");
        const qs = new URLSearchParams({ role });
        if (query.payer)
            qs.set("payer", query.payer);
        if (query.callerDialect)
            qs.set("caller_dialect", query.callerDialect);
        if (query.allowWithoutL1)
            qs.set("allow_without_l1", "true");
        return this.request(`/resources/${resourceId}/decision?${qs.toString()}`, query.idempotencyKey ? { headers: { "Idempotency-Key": query.idempotencyKey } } : undefined);
    }
    /** §7.3 GET /resolve?q= — URL / domain / address / tx / payee_id から canonical オブジェクトへ。キー不要だが同じ経路で送る。 */
    resolve(q) {
        if (typeof q !== "string" || q.trim().length === 0)
            throw new Error("invalid_query");
        return this.request(`/resolve?q=${encodeURIComponent(q.trim())}`);
    }
    createSpendGuard(policy) {
        return new SpendGuard(policy, (payee) => this.getPayeeScore(payee));
    }
    batchScore(agents) {
        if (!Array.isArray(agents) || agents.length === 0) {
            throw new Error("invalid_batch");
        }
        return this.request("/scores/batch", {
            method: "POST",
            body: JSON.stringify({ agents }),
        });
    }
    attestX402Payment(attestation) {
        assertWallet(attestation.wallet);
        if (!TX_HASH_RE.test(attestation.txHash)) {
            throw new Error("invalid_tx_hash");
        }
        return this.request("/payments/x402", {
            method: "POST",
            body: JSON.stringify(attestation),
        });
    }
    async request(path, init) {
        // A hung upstream must not hang the caller's payment path. Without this
        // the whole fail-closed chain is unreachable: SpendGuard can only deny on
        // a lookup that RETURNS, and `fetch` has no timeout of its own — a server
        // that accepts the connection and never answers would keep the agent
        // waiting indefinitely, neither allowing nor denying. The abort surfaces
        // as a rejection, which SpendGuard classifies `payee_trust_unavailable`.
        // Mirrors @vet402/middleware's AbortSignal.timeout (core.ts); the
        // different default is justified at DEFAULT_REQUEST_TIMEOUT_MS.
        const response = await this.fetchFn(`${this.apiUrl}${path}`, {
            ...init,
            signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                ...(init?.body ? { "Content-Type": "application/json" } : {}),
                ...init?.headers,
            },
        });
        // 2026-08-26 C1リハーサルで発覚: apiUrl に origin だけ渡す（/api/v1 欠落）と
        // Next.js が **HTML ページを 200 で返す**。以前は json 化失敗を
        // `catch(()=>({}))` で握りつぶし、2xx なら {} を成功として返していた——
        // 全フィールド undefined の PayeeScoreResult が SpendGuard に渡り、
        // `Date.parse(undefined)=NaN` で fail-closed の payee_score_stale になって
        // 統合者が「なぜ全部拒否されるのか」で数時間溶かす。200 でも本文が JSON で
        // なければ、握りつぶさず throw する（設定ミスに早く気づける）。
        let data;
        try {
            data = await response.json();
        }
        catch {
            if (response.ok) {
                // 2xx かつ非 JSON = 我々の JSON API ではない何か（多くは URL 設定ミスで
                // HTML ページを引いている）。空成功に化けさせない。
                throw new VouchApiError("vouch_non_json_response", response.status);
            }
            data = {};
        }
        if (!response.ok) {
            const code = typeof data === "object" && data && "error" in data
                ? String(data.error)
                : `vouch_api_error_${response.status}`;
            throw new VouchApiError(code, response.status);
        }
        return data;
    }
}
function assertAgentId(agentId) {
    if (!AGENT_ID_RE.test(agentId))
        throw new Error("invalid_agent_id");
}
function assertWallet(wallet) {
    if (!WALLET_RE.test(wallet))
        throw new Error("invalid_wallet_address");
}
export function createVouchClient(options) {
    return new VouchClient(options);
}

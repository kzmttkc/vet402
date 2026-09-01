const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const AGENT_ID_RE = /^\d+$/;
/**
 * Hosted production API — the default when VOUCH_API_URL is unset.
 *
 * 2026-08-13 (hackathon persona R2): this defaulted to
 * `http://localhost:3000/api/v1`. That is the right default for whoever is
 * developing this server and the wrong one for everybody who installs it: an
 * MCP client launched via `npx @vet402/mcp-server` with only a key set
 * would silently point at a port on the user's own machine and fail with a
 * connection error that names nothing. A published binary defaults to the
 * published API; local development sets the env var.
 */
const DEFAULT_API_URL = "https://vet402.com/api/v1";
/**
 * Default per-request timeout (10 s), overridable with `VOUCH_TIMEOUT_MS` in
 * the MCP client's env block — env IS this server's options object, it takes
 * no constructor arguments.
 *
 * WHY A TIMEOUT AT ALL (2026-08-22). `fetch` has none. An upstream that
 * accepts the connection and then never answers would leave the MCP tool call
 * pending forever: the model gets no result and no error, so it cannot fail
 * closed on a payee it could not check — the worst of both. A bounded failure
 * is a result; a hang is not.
 *
 * WHY 10 s AND NOT @vet402/middleware's 5 s: matched to the sibling SDKs
 * (packages/sdk DEFAULT_REQUEST_TIMEOUT_MS, packages/python-sdk's 10.0 s), and
 * `GET /api/v1/payees/{address}/score` declares `maxDuration = 30` — the
 * server budgets up to 30 s for a cold score, so a tighter bound would time
 * out lookups that were merely cold. The middleware's 5 s is right for the
 * middleware: it answers inside someone else's HTTP handler.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
function getConfig() {
    const apiUrl = process.env.VOUCH_API_URL ?? DEFAULT_API_URL;
    const apiKey = process.env.VOUCH_API_KEY;
    if (!apiKey) {
        throw new Error("VOUCH_API_KEY is required — create one at https://vet402.com/dashboard/keys " +
            "and set it in your MCP client's env block");
    }
    // A malformed VOUCH_TIMEOUT_MS falls back to the default rather than
    // throwing: a typo in an MCP client's env block must not take the whole
    // server down at first tool call. Zero/negative/NaN/Infinity are all
    // rejected — "no timeout" is the bug this exists to close.
    const rawTimeout = Number(process.env.VOUCH_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
    return { apiUrl: apiUrl.replace(/\/$/, ""), apiKey, timeoutMs };
}
function assertAgentId(agentId) {
    if (!AGENT_ID_RE.test(agentId)) {
        throw new Error("invalid_agent_id");
    }
}
function assertWallet(wallet) {
    if (!WALLET_RE.test(wallet)) {
        throw new Error("invalid_wallet_address");
    }
}
export class VouchApiError extends Error {
    /** Present for some error codes (e.g. attestation_unverifiable) with a human-readable detail. */
    reason;
    constructor(code, reason) {
        super(code);
        this.name = "VouchApiError";
        this.reason = reason;
    }
}
async function vouchFetch(path, init) {
    const { apiUrl, apiKey, timeoutMs } = getConfig();
    const response = await fetch(`${apiUrl}${path}`, {
        ...init,
        // Bounded, always. See DEFAULT_TIMEOUT_MS: a hung upstream would otherwise
        // leave the tool call pending forever, and a tool call that never returns
        // cannot be failed closed by the model.
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
        headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...init?.headers,
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new VouchApiError(data.error ?? `vouch_api_error_${response.status}`, data.reason);
    }
    return data;
}
export async function fetchAgentScore(agentId, wallet) {
    assertAgentId(agentId);
    if (wallet)
        assertWallet(wallet);
    const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
    return vouchFetch(`/agents/${agentId}/score${query}`);
}
export async function fetchWalletScore(wallet) {
    assertWallet(wallet);
    return vouchFetch(`/wallets/${wallet}/score`);
}
/** Buyer-side lookup: scores the payment *recipient* before an agent pays it. */
export async function fetchPayeeScore(payee) {
    assertWallet(payee);
    return vouchFetch(`/payees/${payee}/score`);
}
export async function attestX402Payment(attestation) {
    assertWallet(attestation.wallet);
    if (!TX_HASH_RE.test(attestation.txHash)) {
        throw new Error("invalid_tx_hash");
    }
    return vouchFetch("/payments/x402", {
        method: "POST",
        body: JSON.stringify(attestation),
    });
}
export async function fetchDecision(resourceId, query = {}) {
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
    return vouchFetch(`/resources/${resourceId}/decision?${qs.toString()}`);
}

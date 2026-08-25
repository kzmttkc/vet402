import { SpendGuard, type SpendGuardPolicy } from "./spend-guard.js";

export {
  SpendGuard,
  DEFAULT_MAX_SCORE_AGE_MS,
  type SpendGuardPolicy,
  type SpendGuardTrustPolicy,
  type SpendEvaluateInput,
  type SpendDenyReason,
  type SpendDecision,
} from "./spend-guard.js";

export type Recommendation = "ALLOW" | "WARN" | "BLOCK";

export type TrustScoreResult = {
  agentId: string;
  wallet: string | null;
  trustScore: number;
  recommendation: Recommendation;
  signals: {
    identity: { registered: boolean; hasMetadataUri: boolean };
    reputation: { feedbackCount: number; avgScore: number; onChainAvgScore: number };
    wallet: { ageDays: number; txCount: number; isBurner: boolean };
    /**
     * The highest-weighted axis. vet402 2026-08-14: it is "verifiable economic
     * activity", not x402 settlements alone — `score` reflects the STRONGER of
     * the L1 observed purchases below and the x402 settlements. Kept under
     * `x402` for wire back-compat.
     */
    x402: {
      paymentCount: number;
      uniqueDays: number;
      score: number;
      /** Delivery-verified L1 observed purchases behind the axis score (the
       *  premium signal). Optional for back-compat; 0 until the observatory
       *  writes its first row for this wallet. */
      l1PurchaseCount?: number;
      l1DistinctSellers?: number;
    };
    sybil: { risk: string; flags: string[] };
    manual: { list: string };
  };
  /** N-21: component-level explanation of the chain score. Optional and absent
   *  on hard-blocked verdicts; the four components sum to weightedSubtotal. */
  breakdown?: {
    components: {
      identity: { score: number; weight: number; contribution: number };
      reputation: { score: number; weight: number; contribution: number };
      wallet: { score: number; weight: number; contribution: number };
      x402: { score: number; weight: number; contribution: number };
    };
    weightedSubtotal: number;
    sybilPenalty: number;
    prePolicyScore: number;
  };
  /** Stable machine-readable reason codes behind the verdict. */
  reasons?: string[];
  scoredAt: string;
  cacheExpiresAt: string;
  disclaimer: string;
  blockReason?: string;
  manualOverride?: boolean;
  dataCoverage?: {
    ownerIndexer: {
      status: "synced" | "partial" | "unavailable";
      blocksBehind: number | null;
      lastBlock: string | null;
      indexedAgentRows: number;
      staleRisk: boolean;
    };
    settlement: {
      paymentRows: number;
      distinctWallets: number;
      recentPayments30d: number;
      walletHasHistory: boolean;
    };
  };
};

export type PayeeDataDepth = "thin" | "moderate" | "rich";

export type PayeeScoreResult = {
  payee: string;
  score: number;
  recommendation: Recommendation;
  dataDepth: PayeeDataDepth;
  /**
   * True when the verdict came from a degraded read — one or more inputs
   * could not be read at all, so the score is a fail-closed refusal, not a
   * measurement. SpendGuard's default policy denies on this.
   */
  degraded: boolean;
  /**
   * Machine-readable names of the inputs that could not be measured. When
   * this is non-empty but `degraded` is false, the score is backed by real
   * but partial measurements — SpendGuard's default policy denies on this
   * too (`payee_partial_measurement`).
   */
  signalsUnavailable: string[];
  signals: {
    receiving: {
      paymentCount: number;
      uniqueDays: number;
      distinctPayers: number;
      score: number;
      /** Delivery-verified L1 receipts behind the receiving score (the premium
       *  signal: the observatory actually paid this payee and checked what came
       *  back). Optional for back-compat; 0 until the observatory writes its
       *  first row for this wallet. */
      l1DeliveryCount?: number;
      l1DistinctBuyers?: number;
      /**
       * 2026-08-26: vet402 が実費で払って**届かなかった**記録。最終スコアの天井に
       * 効いている（呼び手が根拠を再現できるように出している）。
       * `l1PendingVerification` は照合待ちで、判定には使われない——
       * vet402 側の検証の遅れを売り手の落ち度にしないため。
       */
      l1Settled?: number;
      l1PaidNeverSettled?: number;
      l1NonSettlingDays?: number;
      l1PendingVerification?: number;
      /** 天井が掛かった理由（null = 掛かっていない）。 */
      l1NonDeliveryReason?: string | null;
    };
    walletHealth: { ageDays: number; txCount: number; isBurner: boolean; score: number };
    drainPattern: {
      detected: boolean;
      drainRatio: number | null;
      outgoingCount: number;
      incomingCount: number;
      score: number;
      /**
       * Asset legs that could NOT be read on this request — e.g.
       * ["native_drain"], ["usdc_drain"], or both. Empty when every leg was
       * assessed. The API always sends it; optional here so existing callers
       * that build a PayeeScoreResult literal (tests, fixtures) keep compiling.
       *
       * These same names also appear in the top-level `signalsUnavailable`,
       * which is the field SpendGuard denies on — read that one to gate a
       * payment; read this one to say WHICH part of the drain view is missing.
       */
      unmeasured?: string[];
    };
    outcomeHistory: { types: string[]; adjustment: number };
    flags: string[];
  };
  scoredAt: string;
  cacheExpiresAt: string;
  disclaimer: string;
};

/**
 * Answer from the verify-at-settle fast surface
 * (`GET /payees/{address}/verdict-fast`). See {@link VouchClient.getPayeeVerdictFast}.
 *
 * Two shapes, and only one of them is an answer:
 *  - `hit`        — the engine had a confident, unexpired verdict pinned;
 *  - `cache_cold` — nothing pinned. NOT a verdict, and NOT an allow.
 */
export type PayeeVerdictFast =
  | {
      status: "hit";
      recommendation: Recommendation;
      score: number;
      cacheExpiresAt: string;
      /** In-handler microseconds the server spent (a cache read + JSON). */
      handlerMicros: number;
    }
  | {
      status: "cache_cold";
      recommendation: null;
      /** Full-score path to call (fire-and-forget) to warm the same cache. */
      warmVia: string;
      note: string;
      handlerMicros: number;
    };

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
export function payeeVerdictFastAllows(
  verdict: PayeeVerdictFast,
  nowMs: number = Date.now(),
): boolean {
  if (verdict.status !== "hit") return false;
  if (verdict.recommendation !== "ALLOW") return false;
  const expiresMs = Date.parse(verdict.cacheExpiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return nowMs < expiresMs;
}

export type VouchClientOptions = {
  /**
   * Base URL of the Vouch REST API, including the `/api/v1` suffix.
   * Optional — defaults to the hosted production API, {@link DEFAULT_API_URL}.
   */
  apiUrl?: string;
  apiKey: string;
  fetch?: typeof fetch;
  /**
   * Per-request timeout in milliseconds. Default
   * {@link DEFAULT_REQUEST_TIMEOUT_MS} (10 s).
   *
   * There is no way to disable it, on purpose: SpendGuard is fail-CLOSED, and
   * a fail-closed judgement that never runs is not a judgement — an upstream
   * that accepts the connection and then never answers would hang the agent's
   * payment path forever, which is neither an allow nor a deny.
   */
  timeoutMs?: number;
};

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

/**
 * Error thrown when the Vouch API answers with a non-2xx status.
 *
 * `message` is the machine-readable code the API returned (e.g.
 * `missing_api_key`, `invalid_api_key`, `rate_limit_exceeded`) so existing
 * `err.message` checks keep working; `code` and `status` expose the same
 * facts without string parsing. SpendGuard uses them to tell "your key is
 * missing" apart from "the upstream is down".
 */
export class VouchApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "VouchApiError";
    this.code = code;
    this.status = status;
  }
}

export type X402PaymentAttestation = {
  wallet: string;
  txHash: string;
  amount?: string;
  network?: string;
  resource?: string;
};

export type BatchScoreItem =
  | { agentId: string; wallet?: string }
  | { wallet: string; agentId?: never };

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const AGENT_ID_RE = /^\d+$/;

export class VouchClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: VouchClientOptions) {
    const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    if (typeof apiUrl !== "string" || apiUrl.trim() === "") {
      throw new Error(
        "invalid_api_url: apiUrl must be a non-empty URL string " +
          `(e.g. "${DEFAULT_API_URL}") — omit it to use the hosted API`,
      );
    }
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new Error(
        "invalid_api_key: apiKey is required — create one at https://vet402.com/dashboard",
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      // Infinity is rejected as well: "no timeout" is the bug this option
      // exists to close, and AbortSignal.timeout(Infinity) throws anyway.
      throw new Error(
        "invalid_timeout_ms: timeoutMs must be a positive, finite number of " +
          `milliseconds (default ${DEFAULT_REQUEST_TIMEOUT_MS})`,
      );
    }
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  getAgentScore(agentId: string, wallet?: string): Promise<TrustScoreResult> {
    assertAgentId(agentId);
    if (wallet) assertWallet(wallet);
    const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
    return this.request(`/agents/${agentId}/score${query}`);
  }

  getWalletScore(wallet: string): Promise<TrustScoreResult> {
    assertWallet(wallet);
    return this.request(`/wallets/${wallet}/score`);
  }

  /**
   * Buyer-side lookup: "should my agent pay this wallet?" — scores the
   * payment *recipient* (settlement receiving history, wallet health,
   * exit-scam-shaped outflow, outcome labels).
   */
  getPayeeScore(payee: string): Promise<PayeeScoreResult> {
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
  getPayeeVerdictFast(payee: string): Promise<PayeeVerdictFast> {
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
  createSpendGuard(policy: SpendGuardPolicy): SpendGuard {
    return new SpendGuard(policy, (payee) => this.getPayeeScore(payee));
  }

  batchScore(agents: BatchScoreItem[]): Promise<{ results: unknown[] }> {
    if (!Array.isArray(agents) || agents.length === 0) {
      throw new Error("invalid_batch");
    }
    return this.request("/scores/batch", {
      method: "POST",
      body: JSON.stringify({ agents }),
    });
  }

  attestX402Payment(
    attestation: X402PaymentAttestation,
  ): Promise<{ ok: boolean; created: boolean; id: string }> {
    assertWallet(attestation.wallet);
    if (!TX_HASH_RE.test(attestation.txHash)) {
      throw new Error("invalid_tx_hash");
    }
    return this.request("/payments/x402", {
      method: "POST",
      body: JSON.stringify(attestation),
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
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

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code =
        typeof data === "object" && data && "error" in data
          ? String((data as { error: string }).error)
          : `vouch_api_error_${response.status}`;
      throw new VouchApiError(code, response.status);
    }
    return data as T;
  }
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("invalid_agent_id");
}

function assertWallet(wallet: string): void {
  if (!WALLET_RE.test(wallet)) throw new Error("invalid_wallet_address");
}

export function createVouchClient(options: VouchClientOptions): VouchClient {
  return new VouchClient(options);
}

export type TrustScoreResult = {
  agentId: string;
  wallet: string | null;
  trustScore: number;
  recommendation: "ALLOW" | "WARN" | "BLOCK";
  signals: {
    identity: { registered: boolean; hasMetadataUri: boolean };
    reputation: { feedbackCount: number; avgScore: number; onChainAvgScore: number };
    wallet: { ageDays: number; txCount: number; isBurner: boolean };
    /** The highest-weighted axis: "verifiable economic activity" (2026-08-14),
     *  not x402 settlements alone — `score` is the STRONGER of the L1 observed
     *  purchases and the x402 settlements. Kept under `x402` for back-compat. */
    x402: {
      paymentCount: number;
      uniqueDays: number;
      score: number;
      /** Delivery-verified L1 observed purchases behind the axis score. */
      l1PurchaseCount?: number;
      l1DistinctSellers?: number;
    };
    sybil: { risk: string; flags: string[] };
    manual: { list: string };
  };
  scoredAt: string;
  cacheExpiresAt: string;
  disclaimer: string;
  blockReason?: string;
  manualOverride?: boolean;
  dataCoverage?: {
    ownerIndexer: {
      status: string;
      blocksBehind: number | null;
      lastBlock?: string | null;
      indexedAgentRows?: number;
      staleRisk: boolean;
    };
    settlement: {
      paymentRows: number;
      distinctWallets?: number;
      recentPayments30d?: number;
      walletHasHistory: boolean;
    };
  };
};

export type PayeeScoreResult = {
  payee: string;
  score: number;
  recommendation: "ALLOW" | "WARN" | "BLOCK";
  dataDepth: "thin" | "moderate" | "rich";
  /**
   * True when at least one input could not be read at all, so this body is a
   * fail-closed refusal rather than a measurement. `dataDepth` answers "how
   * much history does this wallet have?"; this answers "did we manage to
   * look?". A `degraded: true` result must NEVER be treated as ALLOW,
   * whatever `recommendation` says — the check_payee_trust tool description
   * tells the model exactly that. Always sent by the API.
   */
  degraded: boolean;
  /**
   * Every input that could not be read on this request, named — currently one
   * or more of `wallet_metrics`, `native_drain`, `usdc_drain`,
   * `outcome_history`. Empty means the whole assessment was measured.
   * Non-empty with `degraded: false` is a PARTIAL measurement: real numbers,
   * but not all of them, and capped below ALLOW for that reason. Also not to
   * be treated as ALLOW. Always sent by the API.
   */
  signalsUnavailable: string[];
  signals: {
    receiving: {
      paymentCount: number;
      uniqueDays: number;
      distinctPayers: number;
      score: number;
      /** Delivery-verified L1 receipts behind the receiving score. */
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
      /** Asset legs that could not be read, e.g. ["native_drain"]. The same
       *  names appear in the top-level `signalsUnavailable`. */
      unmeasured?: string[];
    };
    outcomeHistory: { types: string[]; adjustment: number };
    flags: string[];
  };
  scoredAt: string;
  cacheExpiresAt: string;
  disclaimer: string;
};

// ---- 製品定義書 §9.1（2026-09-02）: /decision ----
export type DecisionRecommendation = "ALLOW" | "WARN" | "BLOCK";

/**
 * 証拠 1 行の出どころ（WINDOW_PLAN §2 #3）。`vet402` は vet402 自身の L0–L2 台帳、
 * `subgraph` は The Graph の x402 subgraph を**呼び手の鍵で**引いた行。
 * `both` は「どの源を読むか」の指定であって行の値ではない。
 */
export type EvidenceSource = "vet402" | "subgraph";

/**
 * 証拠 1 行。**1 行は 1 つの源の観測**であり、源をまたいだ件数の合算は無い。
 * `pay_if_trusted` / `check_resource_decision` はこの配列をそのままモデルへ渡すので、
 * 型が狭いと「どちらの台帳が答えたか」がモデルに届かない。
 * docs/openapi.yaml の Evidence と 4 面で一致する。
 */
export type Evidence = {
  level: "L0" | "L1" | "L2";
  source: EvidenceSource;
  purchase_id?: string;
  observation_id?: string;
  url: string;
  declaration_hash?: string | null;
  response_hash?: string | null;
  diff_hash?: string | null;
  missing_keys?: string[] | null;
  // --- source: "subgraph" の行だけが持つ live の証跡（§15）---
  subgraphId?: string;
  block?: { number: number; timestamp?: number };
  deployment?: string;
  queriedAt?: string;
  /** その源が知っている件数。源をまたいで足さない（D16）。 */
  receipts?: number;
};

export type DecisionResult = {
  subject: {
    type: "resource";
    id: string | null;
    endpoint_id: string;
    observatory_id: string;
    canonical_url: string;
    method: string;
  };
  role: "payer" | "payee";
  payer: string | null;
  recommendation: DecisionRecommendation;
  reason_codes: string[];
  facts: Record<string, unknown>;
  /** vet402 自身の L1 支出停止。売り手の状態ではない（true の間 L1 の事実は更新されない）。 */
  spending_halted: boolean;
  /** `l1_not_attempted` の下位コード。我々の停止と「払える accept が無い」だけを名指し、他は null。 */
  not_attempted_reason: "spending_halted" | "no_eligible_accept" | null;
  freshness: { l0: string | null; l1: string | null; l2: string | null };
  /** L0–L2 の公開レシート。**各行が自分の源を名乗る**（Evidence を参照）。 */
  evidence: Evidence[];
  score: { trustScore: number | null; recommendation: DecisionRecommendation | null; deprecated: true } | null;
  degraded: boolean;
  policy: "allow_only";
  rules_version: string;
  registry: { status: "anchored" | "pending" | "off"; tx_hash: string | null };
  scoredAt: string;
  cacheExpiresAt: string;
  disclaimer: string;
};

export type VouchClientConfig = {
  apiUrl: string;
  apiKey: string;
  /** Per-request timeout in ms. See DEFAULT_TIMEOUT_MS / VOUCH_TIMEOUT_MS. */
  timeoutMs: number;
};

export type X402PaymentAttestation = {
  wallet: string;
  txHash: string;
  amount?: string;
  network?: string;
  resource?: string;
};

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
export const DEFAULT_API_URL = "https://vet402.com/api/v1";

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

function getConfig(): VouchClientConfig {
  const apiUrl = process.env.VOUCH_API_URL ?? DEFAULT_API_URL;
  const apiKey = process.env.VOUCH_API_KEY;

  if (!apiKey) {
    throw new Error(
      "VOUCH_API_KEY is required — create one at https://vet402.com/dashboard/keys " +
        "and set it in your MCP client's env block",
    );
  }

  // A malformed VOUCH_TIMEOUT_MS falls back to the default rather than
  // throwing: a typo in an MCP client's env block must not take the whole
  // server down at first tool call. Zero/negative/NaN/Infinity are all
  // rejected — "no timeout" is the bug this exists to close.
  const rawTimeout = Number(process.env.VOUCH_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  return { apiUrl: apiUrl.replace(/\/$/, ""), apiKey, timeoutMs };
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error("invalid_agent_id");
  }
}

function assertWallet(wallet: string): void {
  if (!WALLET_RE.test(wallet)) {
    throw new Error("invalid_wallet_address");
  }
}

export class VouchApiError extends Error {
  /** Present for some error codes (e.g. attestation_unverifiable) with a human-readable detail. */
  reason?: string;

  constructor(code: string, reason?: string) {
    super(code);
    this.name = "VouchApiError";
    this.reason = reason;
  }
}

async function vouchFetch<T>(path: string, init?: RequestInit): Promise<T> {
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

  return data as T;
}

export async function fetchAgentScore(agentId: string, wallet?: string): Promise<TrustScoreResult> {
  assertAgentId(agentId);
  if (wallet) assertWallet(wallet);

  const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
  return vouchFetch<TrustScoreResult>(`/agents/${agentId}/score${query}`);
}

export async function fetchWalletScore(wallet: string): Promise<TrustScoreResult> {
  assertWallet(wallet);
  return vouchFetch<TrustScoreResult>(`/wallets/${wallet}/score`);
}

/** Buyer-side lookup: scores the payment *recipient* before an agent pays it. */
export async function fetchPayeeScore(payee: string): Promise<PayeeScoreResult> {
  assertWallet(payee);
  return vouchFetch<PayeeScoreResult>(`/payees/${payee}/score`);
}

export async function attestX402Payment(
  attestation: X402PaymentAttestation,
): Promise<{ ok: boolean; created: boolean; id: string }> {
  assertWallet(attestation.wallet);
  if (!TX_HASH_RE.test(attestation.txHash)) {
    throw new Error("invalid_tx_hash");
  }
  return vouchFetch("/payments/x402", {
    method: "POST",
    body: JSON.stringify(attestation),
  });
}

export async function fetchDecision(
  resourceId: string,
  query: { role?: "payer" | "payee"; payer?: string; callerDialect?: "v1" | "v2" } = {},
): Promise<DecisionResult> {
  if (!/^[0-9a-f]{64}$/.test(resourceId)) throw new Error("invalid_resource_id");
  const role = query.role ?? "payer";
  if (role === "payee" && !query.payer) throw new Error("payer_required");
  const qs = new URLSearchParams({ role });
  if (query.payer) qs.set("payer", query.payer);
  if (query.callerDialect) qs.set("caller_dialect", query.callerDialect);
  return vouchFetch<DecisionResult>(`/resources/${resourceId}/decision?${qs.toString()}`);
}

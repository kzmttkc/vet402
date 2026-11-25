// ============================================================
// MCP の入口の入力・出力のスキーマ（2026-10-28・要件書 v3 §2.2）。
//
// 出力は全部 `.strict()`。tool はライブラリの戻り値を広げて返さず、ここに書いた欄だけを 1 つずつ写す
// （tools.ts）。秘密の値（auth_nonce・payer・raw_*・購入の証拠の 2 列（402 の写しと署名済みペイロード）・鍵）は欄に無いので出せない。
// pay_to は verified_terms と verified_pay_to_by_network の中にだけある。
// ============================================================
import { z } from "zod";
import { ERC8004_NO_PROOF_REASONS, ERC8004_UNREADABLE_REASONS } from "@/lib/erc8004-check/types";
import { INPUT_TEXT } from "./text";

export const MAX_URL_CHARS = 2048;
export const MAX_QUERY_CHARS = 80;
export const SELLER_TEXT_MAX_CHARS = 200;

/** https の絶対 URL か（ホストを持ち、資格情報を含まない）。 */
export function isHttpsAbsoluteUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_URL_CHARS) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname.length > 0 && u.username === "" && u.password === "";
}

const urlInput = (describe: string) =>
  z
    .string()
    .max(MAX_URL_CHARS, "invalid_url")
    .refine((v) => isHttpsAbsoluteUrl(v), "invalid_url")
    .describe(describe);

export const checkSellerInput = z.object({
  url: z
    .string()
    .max(MAX_URL_CHARS)
    .optional()
    .refine((v) => v === undefined || v === "" || isHttpsAbsoluteUrl(v), "invalid_url")
    .describe(INPUT_TEXT.url),
  method: z
    .string()
    .regex(/^[A-Za-z]{1,10}$/, "invalid_method")
    .optional()
    .describe(INPUT_TEXT.method),
});

export const checkEndpointInput = z.object({
  url: z
    .string()
    .max(MAX_URL_CHARS)
    .optional()
    .refine((v) => v === undefined || v === "" || isHttpsAbsoluteUrl(v), "invalid_url")
    .describe(INPUT_TEXT.sellerUrl),
});

export const findSellersInput = z.object({
  query: z.string().max(MAX_QUERY_CHARS, "invalid_query").optional().describe(INPUT_TEXT.query),
  limit: z.number().int().min(1).max(10).optional().describe(INPUT_TEXT.limit),
});

export const check8004AgentInput = z.object({
  chain: z.string().max(64).optional().describe(INPUT_TEXT.erc8004_chain),
  agentId: z.string().max(78, "invalid_agent_id").optional().describe(INPUT_TEXT.erc8004_agent_id),
  client: z.string().max(42).optional().describe(INPUT_TEXT.erc8004_client),
  feedbackIndex: z
    .union([z.string().max(40), z.number().int().nonnegative()])
    .optional()
    .transform((v) => (v === undefined ? undefined : String(v)))
    .describe(INPUT_TEXT.erc8004_feedback_index),
});

export const checkConcordiumAgentInput = z.object({
  agent: z.string().max(64).optional().describe(INPUT_TEXT.concordium_agent),
});

export const checkNearAiAttestationInput = z.object({}).strict();

export const checkNearAiAttestationOutput = z
  .object({
    status: z.literal("no_run_yet").optional(),
    next_run_utc: z.string().optional(),
    schemaVersion: z.literal(1).optional(),
    description: z.string().optional(),
    retrievedAt: z.string().optional(),
    runStartedAt: z.string().optional(),
    runCompletedAt: z.string().optional(),
    nearaiModelCount: z.number().int().optional(),
    gateway: z
      .object({
        httpStatus: z.number().int(),
        tcbStatus: z.string(),
        advisoryIds: z.array(z.string()),
        tlsBindingOk: z.boolean().nullable(),
        status: z.enum(["pass", "advisory", "unverified", "pending_reverify"]),
      })
      .optional(),
    models: z.array(
      z.object({
        modelId: z.string(),
        candidateCount: z.number().int(),
        tcbStatus: z.string(),
        advisoryIds: z.array(z.string()),
        gpuPass: z.boolean(),
        status: z.enum(["pass", "advisory", "unverified", "pending_reverify"]),
      }),
    ),
    license: z.string().optional(),
    licenseUrl: z.string().optional(),
    cite: z.string().optional(),
  })
  .strict();

export const checkConcordiumAgentOutput = z
  .object({
    agent: z.string(),
    network: z.literal("concordium-testnet"),
    badge_status: z.string(),
    verdict: z.enum(["go", "no", "unproven"]),
    reason: z.string().nullable(),
    trust_summary: z.string().nullable(),
    row_url: z.string().nullable(),
    checked_at: z.string().nullable(),
    source_url: z.string(),
    note: z.string(),
  })
  .strict();

export const checkPaymentProofInput = z.object({
  payment_response: z.string().max(8_192).optional().describe(INPUT_TEXT.payment_response),
  network: z.string().max(128).optional().describe(INPUT_TEXT.payment_network),
  transaction: z.string().max(128).optional().describe(INPUT_TEXT.payment_transaction),
});

const iso = z.string();

export const l1PurchaseSchema = z
  .object({
    attempted_at: iso,
    network: z.string().nullable(),
    status: z.string(),
    tx_hash: z.string().nullable(),
    explorer_url: z.string().nullable(),
  })
  .strict();

export const listingSourceSchema = z
  .object({
    source: z.string(),
    name: z.string(),
    url: z.string(),
    protocol: z.enum(["x402", "mpp"]),
    sync_times_utc: z.array(z.string()),
  })
  .strict();

export const verifiedTermsSchema = z
  .object({
    purchase_id: z.string().nullable(),
    pay_to: z.string(),
    asset: z.string(),
    amount: z.string().describe("6-decimal ledger units, not always the asset's own base units: multiply by 10^12 on BNB Chain and by 10 on Stellar before comparing with a 402."),
    decimals: z.literal(6).describe("The decimals of amount in the ledger, not of the asset."),
    network: z.string(),
    scheme: z.enum(["exact", "charge"]),
    protocol: z.enum(["x402", "mpp"]),
    verified_at: z.string(),
  })
  .strict();

export const verifiedPayToSchema = z
  .object({
    network: z.string().describe("CAIP-2, e.g. eip155:8453."),
    pay_to: z.string().describe("0x addresses lowercase; other chains as recorded."),
    purchase_id: z.string().nullable(),
    verified_at: z.string(),
  })
  .strict();

export const reasonEvidenceRefSchema = z
  .object({
    kind: z.enum(["purchase", "tx", "response_hash", "declaration_hash", "diff_hash", "record"]),
    id: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

export const reasonExplanationSchema = z
  .object({
    code: z.string(),
    text: z.string(),
    effect: z.enum(["sets_block", "caps_at_warn", "none"]),
    max_recommendation: z.enum(["ALLOW", "WARN", "BLOCK"]),
    evidence_status: z.enum(["linked", "record", "none"]),
    evidence: z.array(reasonEvidenceRefSchema),
  })
  .strict();

export const evidenceAgeSchema = z
  .object({
    last_delivered_at: z.string().nullable(),
    days_since_last_delivery: z.number().nullable(),
    last_paid_test_at: z.string().nullable(),
    tier: z.enum(["fresh", "aging", "stale", "none"]),
    max_recommendation: z.enum(["ALLOW", "WARN"]),
    waived_by_caller: z.boolean(),
    fresh_within_days: z.literal(7),
    stale_after_days: z.number(),
    text: z.string(),
  })
  .strict();

export const decisionHostRefundsSchema = z
  .object({
    window_days: z.number().int(),
    networks_read: z.array(z.string()),
    read_through: z.string().nullable(),
    failures_counted: z.number().int(),
    paid_units: z.string(),
    refunded_units: z.string(),
    refund_rate: z.number().nullable(),
  })
  .strict();

export const checkSellerOutput = z
  .object({
    evidence_age: evidenceAgeSchema.nullable(),
    canonical_url: z.string().nullable(),
    method: z.string().nullable(),
    not_in_catalog: z.boolean(),
    recommendation: z.enum(["ALLOW", "WARN", "BLOCK"]).nullable(),
    reason_codes: z.array(z.string()),
    reasons: z.array(reasonExplanationSchema),
    refunds: decisionHostRefundsSchema.nullable(),
    delivery: z
      .object({
        paid_attempts: z.number().int(),
        delivered: z.number().int(),
        settled_not_delivered: z.number().int(),
        last_attempt_at: z.string().nullable(),
        window_days: z.number().int(),
      })
      .strict()
      .nullable(),
    l0_status: z.enum(["pass", "fail", "unverified"]).nullable(),
    verified_terms: verifiedTermsSchema.nullable(),
    verified_pay_to_by_network: z
      .array(verifiedPayToSchema)
      .describe(
        "Recipients vet402 paid and confirmed delivery to, per chain (latest per network and pay_to, newest first, at most 10). If the network and payTo pair of the 402 you received is not here, vet402 has not verified the recipient on that network.",
      ),
    spending_halted: z.boolean().nullable(),
    freshness: z.object({ l0: z.string().nullable(), l1: z.string().nullable(), l2: z.string().nullable() }).strict().nullable(),
    l1_purchases: z.array(l1PurchaseSchema),
    same_host_listings: z.array(
      z.object({ url: z.string(), method: z.string(), catalog_status: z.string(), record_url: z.string() }).strict(),
    ),
    listing_sources: z.array(listingSourceSchema),
    note: z.string().nullable(),
    record_url: z.string().nullable(),
    diagnose_url: z.string().nullable(),
    method_url: z.string(),
    as_of: iso,
    truncated: z.boolean(),
    next_action: z.string().nullable(),
    rules_version: z.string(),
  })
  .strict();

export const checkEndpointOutput = z
  .object({
    host: z.string(),
    on_record: z.boolean(),
    page_kind: z.enum(["base", "other_chains", "none"]),
    listed_in: z.array(
      z
        .object({
          source: z.string(),
          name: z.string(),
          sync_times_utc: z.array(z.string()),
          listings: z.number().int(),
          last_seen_at: z.string().nullable(),
        })
        .strict(),
    ),
    listing_sources: z.array(listingSourceSchema),
    l0: z
      .object({
        pass: z.number().int(),
        fail: z.number().int(),
        unverified: z.number().int(),
        not_probed: z.number().int(),
        last_checked_at: z.string().nullable(),
      })
      .strict()
      .nullable(),
    l1: z
      .object({
        paid_attempts: z.number().int(),
        delivered: z.number().int(),
        listings_by_latest_result: z
          .object({
            delivered: z.number().int(),
            pending: z.number().int(),
            seller_side: z.number().int(),
            vet402_side: z.number().int(),
            not_sorted: z.number().int(),
            not_paid: z.number().int(),
            not_tried: z.number().int(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    l1_failure_modes: z.array(z.object({ key: z.string(), count: z.number().int(), fix_first_url: z.string() }).strict()),
    listings: z.array(
      z
        .object({
          url: z.string(),
          network: z.string().nullable(),
          l0_latest: z.string().nullable(),
          latest_result: z.string().nullable(),
          next_purchase_earliest_at: z.string().nullable(),
          record_url: z.string(),
        })
        .strict(),
    ),
    l1_purchases: z.array(l1PurchaseSchema),
    fix_first_url: z.string().nullable(),
    notes: z.array(z.string()),
    record_url: z.string().nullable(),
    method_url: z.string(),
    as_of: iso,
    truncated: z.boolean(),
  })
  .strict();

const sellerTextFields = {
  seller_description: z.string().nullable(),
  text_source: z.literal("seller"),
};

export const findSellersOutput = z
  .object({
    query: z.string(),
    note: z.string().nullable().optional(),
    sellers: z.array(
      z
        .object({
          url: z.string(),
          ...sellerTextFields,
          price_usd: z.number().nullable(),
          network: z.string().nullable(),
          delivered_30d: z.number().int(),
          paid_attempts_30d: z.number().int(),
          delivered_rate_pct: z.number().nullable(),
          wilson_lower_bound: z.number(),
          last_attempt_at: z.string().nullable(),
          record_url: z.string(),
        })
        .strict(),
    ),
    untested: z.array(
      z
        .object({
          url: z.string(),
          ...sellerTextFields,
          price_usd: z.number().nullable(),
          network: z.string().nullable(),
          record_url: z.string(),
        })
        .strict(),
    ),
    method_url: z.string(),
    rate_formula: z.string(),
    rules_version: z.string(),
    as_of: iso,
    truncated: z.boolean(),
  })
  .strict();

const erc8004TriState = z.enum(["pass", "fail", "unknown"]);
const erc8004Verdict = z.enum([
  "verified",
  "verified_payment_unlinked_client",
  "payment_recipient_unverified",
  "mismatch",
  "no_proof",
  "unreadable",
]);

export const check8004AgentOutput = z
  .object({
    verdict: erc8004Verdict,
    reasons: z
      .array(z.enum(["feedback_hash", "tx_not_found", "recipient", "amount", "token"]))
      .optional(),
    chain: z.string(),
    agentId: z.string(),
    clientAddress: z.string(),
    feedbackIndex: z.string(),
    feedback: z
      .object({
        value: z.string(),
        valueDecimals: z.number(),
        tag1: z.string(),
        tag2: z.string(),
        endpoint: z.string(),
        feedbackURI: z.string(),
        feedbackHash: z.string(),
        isRevoked: z.boolean(),
      })
      .strict(),
    proofOfPayment: z.record(z.string(), z.unknown()).nullable(),
    checks: z
      .object({
        tx_exists: erc8004TriState,
        to_matches_agent_payTo_or_wallet: erc8004TriState,
        from_matches_client: erc8004TriState,
        amount: erc8004TriState,
        token: erc8004TriState,
        block_time: erc8004TriState,
        feedback_hash: erc8004TriState,
        proof_source: z.enum(["proofOfPayment", "rollup_transactions"]).optional(),
        proof_chain: z.string().optional(),
      })
      .strict(),
    unreadable_reason: z.enum(ERC8004_UNREADABLE_REASONS).optional(),
    no_proof_reason: z.enum(ERC8004_NO_PROOF_REASONS).optional(),
    sources: z.array(
      z
        .object({
          kind: z.enum([
            "reputation_registry",
            "new_feedback_log",
            "feedback_uri",
            "payment_chain",
            "vet402_erc8004_match",
            "identity_registry",
          ]),
          detail: z.string(),
        })
        .strict(),
    ),
    as_of: iso,
  })
  .strict();

export const checkPaymentProofOutput = z
  .object({
    found: z.boolean(),
    network: z.string(),
    tx: z.string(),
    block: z.string().nullable(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    asset: z.string().nullable(),
    amount: z.string().nullable(),
    status: z.enum(["confirmed", "failed", "not_found", "unsupported_network"]),
    explorer: z.string().nullable(),
    as_of: iso,
  })
  .strict();

export type CheckSellerOutput = z.infer<typeof checkSellerOutput>;
export type CheckEndpointOutput = z.infer<typeof checkEndpointOutput>;
export type FindSellersOutput = z.infer<typeof findSellersOutput>;
export type Check8004AgentOutput = z.infer<typeof check8004AgentOutput>;
export type CheckPaymentProofOutput = z.infer<typeof checkPaymentProofOutput>;
export type L1PurchaseOut = z.infer<typeof l1PurchaseSchema>;

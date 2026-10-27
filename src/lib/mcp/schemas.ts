// ============================================================
// MCP の入口の入力・出力のスキーマ（2026-10-28・要件書 v3 §2.2）。
//
// 出力は全部 `.strict()`。tool はライブラリの戻り値を広げて返さず、ここに書いた欄だけを 1 つずつ写す
// （tools.ts）。秘密の値（auth_nonce・payer・raw_*・購入の証拠の 2 列（402 の写しと署名済みペイロード）・鍵）は欄に無いので出せない。
// pay_to は verified_terms の中にだけある。
// ============================================================
import { z } from "zod";
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
  url: urlInput(INPUT_TEXT.url),
  method: z
    .string()
    .regex(/^[A-Za-z]{1,10}$/, "invalid_method")
    .optional()
    .describe(INPUT_TEXT.method),
});

export const checkEndpointInput = z.object({
  url: urlInput(INPUT_TEXT.sellerUrl),
});

export const findSellersInput = z.object({
  query: z.string().min(1, "invalid_query").max(MAX_QUERY_CHARS, "invalid_query").describe(INPUT_TEXT.query),
  limit: z.number().int().min(1).max(10).optional().describe(INPUT_TEXT.limit),
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
    amount: z.string(),
    decimals: z.literal(6),
    network: z.string(),
    scheme: z.enum(["exact", "charge"]),
    protocol: z.enum(["x402", "mpp"]),
    verified_at: z.string(),
  })
  .strict();

export const checkSellerOutput = z
  .object({
    canonical_url: z.string().nullable(),
    method: z.string().nullable(),
    not_in_catalog: z.boolean(),
    recommendation: z.enum(["ALLOW", "WARN", "BLOCK"]).nullable(),
    reason_codes: z.array(z.string()),
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
    spending_halted: z.boolean().nullable(),
    freshness: z.object({ l0: z.string().nullable(), l1: z.string().nullable(), l2: z.string().nullable() }).strict().nullable(),
    l1_purchases: z.array(l1PurchaseSchema),
    same_host_listings: z.array(
      z.object({ url: z.string(), method: z.string(), catalog_status: z.string(), record_url: z.string() }).strict(),
    ),
    listing_sources: z.array(listingSourceSchema),
    note: z.string().nullable(),
    record_url: z.string().nullable(),
    method_url: z.string(),
    as_of: iso,
    truncated: z.boolean(),
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
    sellers: z.array(
      z
        .object({
          url: z.string(),
          ...sellerTextFields,
          price_usd: z.number().nullable(),
          network: z.string().nullable(),
          delivered_30d: z.number().int(),
          paid_attempts_30d: z.number().int(),
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
    as_of: iso,
    truncated: z.boolean(),
  })
  .strict();

export type CheckSellerOutput = z.infer<typeof checkSellerOutput>;
export type CheckEndpointOutput = z.infer<typeof checkEndpointOutput>;
export type FindSellersOutput = z.infer<typeof findSellersOutput>;
export type L1PurchaseOut = z.infer<typeof l1PurchaseSchema>;

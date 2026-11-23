import { isAddress, getAddress } from "viem";
import { cdpJwt } from "./cdp-jwt";
import { paymentRequired, paymentRequirements, type BasePaymentPayload } from "./base-usdc";

const CDP_BASE = "https://api.cdp.coinbase.com/platform/v2/x402";
const FACILITATOR_TIMEOUT_MS = 15_000;
const CDP_HOST = "api.cdp.coinbase.com";

export function cdpConfigured(): boolean {
  return !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
}

export type VerifyResult = { isValid: boolean; invalidReason?: string; payer?: string };
export type SettleResult = { success: boolean; errorReason?: string; transaction: string; network?: string; payer?: string; amount?: string };

type FacilitatorReply<T> = { ok: boolean; status: number; body: T | null; headers: Headers };

export type SettleOutcome =
  | { kind: "settled"; result: SettleResult; bazaarStatus?: string }
  | { kind: "failed"; result: SettleResult }
  | { kind: "unknown"; detail: string };

function bearer(path: "/platform/v2/x402/verify" | "/platform/v2/x402/settle"): string {
  return cdpJwt({
    keyId: process.env.CDP_API_KEY_ID!,
    keySecret: process.env.CDP_API_KEY_SECRET!,
    method: "POST",
    host: CDP_HOST,
    path,
  });
}

function mergePayload(payment: BasePaymentPayload, resourceUrl: string): BasePaymentPayload {
  const doc = paymentRequired(resourceUrl);
  const out: BasePaymentPayload = { ...payment };
  if (!out.resource) out.resource = doc.resource;
  const ext = (out.extensions ?? {}) as Record<string, unknown>;
  if (!ext.bazaar) {
    out.extensions = { ...ext, bazaar: doc.extensions.bazaar };
  }
  return out;
}

function decodeExtensionResponses(headers: Headers): { bazaar?: { status?: string } } | null {
  const raw = headers.get("EXTENSION-RESPONSES");
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function cdpPost<T>(
  path: "verify" | "settle",
  payment: BasePaymentPayload,
  resourceUrl: string,
  fetchImpl: typeof fetch,
): Promise<FacilitatorReply<T>> {
  const jwtPath = path === "verify" ? "/platform/v2/x402/verify" : "/platform/v2/x402/settle";
  const token = bearer(jwtPath);
  const merged = mergePayload(payment, resourceUrl);
  const res = await fetchImpl(`${CDP_BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ x402Version: 2, paymentPayload: merged, paymentRequirements: paymentRequirements() }),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}

export async function verifyPayment(
  payment: BasePaymentPayload,
  resourceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const r = await cdpPost<VerifyResult>("verify", payment, resourceUrl, fetchImpl);
  if (!r.body || typeof r.body.isValid !== "boolean") throw new Error(`facilitator /verify ${r.status}`);
  return { ...r.body, isValid: r.ok && r.body.isValid === true };
}

export async function settlePayment(
  payment: BasePaymentPayload,
  resourceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SettleOutcome> {
  let r: FacilitatorReply<SettleResult>;
  try {
    r = await cdpPost<SettleResult>("settle", payment, resourceUrl, fetchImpl);
  } catch (err) {
    return { kind: "unknown", detail: err instanceof Error ? err.name : "error" };
  }
  const ext = decodeExtensionResponses(r.headers);
  const bazaarStatus = typeof ext?.bazaar?.status === "string" ? ext.bazaar.status : undefined;
  const b = r.body;
  const hasTx = !!b && typeof b.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(b.transaction);
  if (r.ok && b && b.success === true && hasTx) return { kind: "settled", result: b, bazaarStatus };
  if (r.ok && b && b.success === false && !hasTx) return { kind: "failed", result: b };
  return { kind: "unknown", detail: `status ${r.status}` };
}

export function payerOf(v: { payer?: string }): string | null {
  return v.payer && isAddress(v.payer) ? getAddress(v.payer) : null;
}
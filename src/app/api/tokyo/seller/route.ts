// ============================================================
// ETHGlobal Tokyo 2026 B4a — Base Sepolia の最小の x402 売り手（v2・scheme exact）
//
// この URL は ENS の `x402-offer`（PLAN_v4.3 §3.3.1 の 266 バイトの1行 JSON）の
// `resource` に焼き込まれている。パス・値を1文字でも変えると全証明が失効する。
//
//   支払い無し          → 402・PAYMENT-REQUIRED（base64 JSON）と同じ本文
//   PAYMENT-SIGNATURE   → accepted が約束と一致するかを先に見る → facilitator の
//                         /verify → /settle → 200（本文の最上位に result・observed_at）
//
// 売り手は受け取るだけ。鍵を持たず、署名しない。決済は x402.org の公開 facilitator
// （PLAN_v3 §1.4 / B0-1・B0-2 で `{x402Version:2, scheme:"exact", network:"eip155:84532"}`
// を実測）が行う。env を1本も読まず、既存の lib を1本も import しない（W01）。
// ============================================================
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESOURCE = "https://vet402.com/api/tokyo/seller";
const FACILITATOR = "https://x402.org/facilitator";
const VERIFY_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 40_000;

/** 約束の値（x402-offer の逐語と同じ文字列）。 */
const OFFER = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  payTo: "0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6",
} as const;

/**
 * x402 v2 の PaymentRequirements。facilitator へ渡すのは常にこの定数で、
 * 買い手が申告した `accepted` は照合にだけ使う。
 * extra の EIP-712 ドメインは Base Sepolia USDC の name()="USDC"・version()="2"（eth_call で実測）。
 */
const REQUIREMENTS = {
  scheme: "exact",
  network: OFFER.network,
  amount: OFFER.amount,
  asset: OFFER.asset,
  payTo: OFFER.payTo,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
} as const;

function paymentRequired(error: string) {
  return {
    x402Version: 2,
    error,
    resource: {
      url: RESOURCE,
      description: "vet402 ETHGlobal Tokyo 2026 demo seller (Base Sepolia, 0.01 USDC)",
      mimeType: "application/json",
    },
    accepts: [REQUIREMENTS],
  };
}

function toBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function fromBase64Json(raw: string): unknown {
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

const NO_STORE = { "Cache-Control": "no-store" };

function respond402(error: string): NextResponse {
  const body = paymentRequired(error);
  return NextResponse.json(body, {
    status: 402,
    headers: { ...NO_STORE, "PAYMENT-REQUIRED": toBase64(body) },
  });
}

function respond502(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 502, headers: NO_STORE });
}

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

type PaymentPayload = { x402Version: 2; accepted: Record<string, unknown>; payload: unknown };

/** 支払いヘッダを読み、約束と一致しなければ理由を返す（facilitator を呼ぶ前に落とす）。 */
function readPayment(raw: string): { ok: true; payload: PaymentPayload } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = fromBase64Json(raw);
  } catch {
    return { ok: false, reason: "invalid_payment_header" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "invalid_payment_header" };
  const rec = parsed as Record<string, unknown>;
  if (rec.x402Version !== 2) return { ok: false, reason: "unsupported_x402_version" };
  const accepted = rec.accepted;
  if (typeof accepted !== "object" || accepted === null) return { ok: false, reason: "invalid_payment_header" };
  const a = accepted as Record<string, unknown>;
  const matches =
    a.scheme === REQUIREMENTS.scheme &&
    a.network === REQUIREMENTS.network &&
    a.amount === REQUIREMENTS.amount &&
    sameAddress(a.asset, REQUIREMENTS.asset) &&
    sameAddress(a.payTo, REQUIREMENTS.payTo);
  if (!matches) return { ok: false, reason: "accepted_does_not_match_offer" };
  if (rec.payload === undefined || rec.payload === null) return { ok: false, reason: "invalid_payment_header" };
  return { ok: true, payload: rec as unknown as PaymentPayload };
}

async function callFacilitator(
  path: "verify" | "settle",
  paymentPayload: PaymentPayload,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${FACILITATOR}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: REQUIREMENTS }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    // 4xx は facilitator が「この支払いは通らない」と本文で答えている場合がある。5xx は届いていない扱い。
    if (res.status >= 500) {
      console.error(`[vouch] tokyo.seller.${path}: facilitator HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as unknown;
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  } catch (error) {
    console.error(`[vouch] tokyo.seller.${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const header = request.headers.get("payment-signature");
  if (!header) return respond402("PAYMENT-SIGNATURE header is required");

  const read = readPayment(header);
  if (!read.ok) return respond402(read.reason);

  const verified = await callFacilitator("verify", read.payload, VERIFY_TIMEOUT_MS);
  if (!verified) return respond502("facilitator_unavailable");
  if (verified.isValid !== true) {
    const reason = typeof verified.invalidReason === "string" ? verified.invalidReason : "payment_invalid";
    return respond402(reason);
  }

  const settled = await callFacilitator("settle", read.payload, SETTLE_TIMEOUT_MS);
  if (!settled) return respond502("facilitator_unavailable");
  if (settled.success !== true) {
    const reason = typeof settled.errorReason === "string" ? settled.errorReason : "settlement_failed";
    return respond402(reason);
  }

  const receipt = {
    success: true,
    transaction: typeof settled.transaction === "string" ? settled.transaction : null,
    network: typeof settled.network === "string" ? settled.network : OFFER.network,
    payer: typeof settled.payer === "string" ? settled.payer : null,
  };
  // 約束の output.required = ["result","observed_at"]。両方を本文の最上位に必ず置く。
  return NextResponse.json(
    {
      result: "ok",
      observed_at: new Date().toISOString(),
      resource: RESOURCE,
      transaction: receipt.transaction,
    },
    { status: 200, headers: { ...NO_STORE, "PAYMENT-RESPONSE": toBase64(receipt) } },
  );
}

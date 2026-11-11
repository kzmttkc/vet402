/**
 * x402 `auth-capture` payment, buyer side. (English header for judges. The Japanese block below is
 * the same content in our working language.)
 *
 * Signs one ERC-3009 ReceiveWithAuthorization with the official client
 * (`@x402/evm/auth-capture/client`, 2.30.0), re-sends the request to the seller once, waits for the
 * answer, and reports what happened. The buyer never calls the facilitator and never calls
 * capture or void: those belong to the seller's operator (scheme_auth_capture.md L27). The buyer
 * keeps one call of its own, `reclaim`, which `reclaimAuthCapture` in `./auth-capture.js` sends from
 * the buyer's wallet after the capture deadline.
 *
 * **Reached only by a dynamic import from the ALLOW branch of `payOrRefuse`**, like `./x402-pay.js`.
 */
/**
 * 買い手側の x402 `auth-capture` の支払い。公式 client（`@x402/evm/auth-capture/client` 2.30.0）で
 * ERC-3009 ReceiveWithAuthorization に 1 回だけ署名し、売り手へ 1 回だけ再送し、答えを待ち、何が起きたかを返す。
 * 買い手は facilitator を呼ばず、capture も void も呼ばない（売り手の operator の仕事）。買い手が持つのは
 * 期限後の `reclaim` だけで、それは `./auth-capture.js` の `reclaimAuthCapture` が買い手の財布から送る。
 *
 * **`payOrRefuse` の ALLOW ブランチからの動的 import でしか評価されない**（`./x402-pay.js` と同じ）。
 */

import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/client";
import { encodeAbiParameters, keccak256, zeroAddress } from "viem";
import type { ChainProfile } from "./chain-profile.js";
import {
  AUTH_CAPTURE_EIP3009_COLLECTOR_V1_1,
  AUTH_CAPTURE_ESCROW_V1_1,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  classifyDelivery,
  isAuthCaptureEligible,
  outcomeFromState,
  readAuthCaptureState,
  recoveryFor,
  type AuthCapturePaymentInfo,
  type AuthCaptureReceipt,
  type AuthCaptureStateReader,
} from "./auth-capture.js";
import {
  MAX_AUTHORIZATION_WINDOW_SECONDS,
  parseSettlementResponse,
  type PayerAccount,
  type X402Accept,
  type X402Settlement,
} from "./x402-pay.js";

export type AuthCaptureAuthorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

export type AuthCapturePayResult = {
  signed: true;
  /** 届いて、capture された（chain を読んだときは chain で、読まないときは売り手の申告で）。 */
  paid: boolean;
  txHash: string | null;
  nonce: string;
  authorization: AuthCaptureAuthorization;
  settlement: X402Settlement | null;
  responseStatus: number | null;
  receipt: AuthCaptureReceipt;
};

const PAYMENT_INFO_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)",
  ),
);

/** `AuthCaptureEscrow.getHash` と同じ計算。`payer` を 0 にすると、署名の nonce（payer に依らない hash）になる。 */
export function hashPaymentInfo(chainId: number, info: AuthCapturePaymentInfo, payer: string, escrow: string): string {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
        { type: "uint120" }, { type: "uint48" }, { type: "uint48" }, { type: "uint48" },
        { type: "uint16" }, { type: "uint16" }, { type: "address" }, { type: "uint256" },
      ],
      [
        PAYMENT_INFO_TYPEHASH,
        info.operator as `0x${string}`,
        payer as `0x${string}`,
        info.receiver as `0x${string}`,
        info.token as `0x${string}`,
        BigInt(info.maxAmount),
        info.preApprovalExpiry,
        info.authorizationExpiry,
        info.refundExpiry,
        info.minFeeBps,
        info.maxFeeBps,
        info.feeReceiver as `0x${string}`,
        BigInt(info.salt),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [BigInt(chainId), escrow as `0x${string}`, inner],
    ),
  );
}

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function sameAddr(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * 署名者を包む。公式 client が出す型付きデータが、**この支払いの1件**であることを署名の前に確かめる:
 * ReceiveWithAuthorization・トークンのドメイン（売り手の名乗りではなく profile の値）・宛先は v1.1 の collector・
 * 額は 402 の額（上限の関門を通った額）・有効期限は短い。2 回目の署名は拒む。どれかが外れたら署名せずに throw。
 */
function guardedSigner(account: PayerAccount, accept: X402Accept, profile: ChainProfile, nowSec: number) {
  let count = 0;
  const address = account.address as `0x${string}`;
  return {
    address,
    signTypedData: async (td: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> => {
      count += 1;
      if (count > 1) throw new Error("auth_capture_second_signature_refused");
      const d = td.domain;
      const m = td.message;
      const ok =
        td.primaryType === "ReceiveWithAuthorization" &&
        d.name === profile.usdcEip712.name &&
        d.version === profile.usdcEip712.version &&
        Number(d.chainId) === profile.chainId &&
        sameAddr(d.verifyingContract, profile.asset) &&
        sameAddr(m.from, account.address) &&
        sameAddr(m.to, AUTH_CAPTURE_EIP3009_COLLECTOR_V1_1) &&
        BigInt(m.value as bigint | string) === BigInt(accept.amount) &&
        BigInt(m.validAfter as bigint | string) === 0n &&
        BigInt(m.validBefore as bigint | string) <= BigInt(nowSec + MAX_AUTHORIZATION_WINDOW_SECONDS + 5);
      if (!ok) throw new Error("auth_capture_typed_data_refused");
      const signature = await account.signTypedData({
        domain: td.domain,
        types: td.types as Record<string, { name: string; type: string }[]>,
        primaryType: td.primaryType,
        message: td.message,
      });
      return signature as `0x${string}`;
    },
  };
}

/** 本文を文字列で読む口（無ければ null）。 */
function bodyReader(response: { text?: () => Promise<string> }): Promise<string> | null {
  return typeof response.text === "function" ? response.text() : null;
}

/**
 * 署名して、元のリクエストを PAYMENT-SIGNATURE 付きで**1回だけ**売り手へ再送し、答えを待つ。判定はしない
 * （ここへ来た時点で金銭ゲートと payee 照合は通っている、が `payOrRefuse` との契約）。払い直さない。
 */
export async function executeAuthCapturePayment(args: {
  account: PayerAccount;
  accept: X402Accept;
  resource: string;
  method: string;
  profile: ChainProfile;
  fetch: typeof fetch;
  deliveryTimeoutMs?: number;
  stateReader?: AuthCaptureStateReader;
  onSigned?: (info: { nonce: string; authorization: AuthCaptureAuthorization; payer: string }) => void;
}): Promise<AuthCapturePayResult> {
  const { accept, profile } = args;
  const nowSec = Math.floor(Date.now() / 1000);
  // 呼び手のゲートを素通りした場合の保険。この関数は金に署名する。
  if (!isAuthCaptureEligible(accept, profile, 2, nowSec)) {
    throw new Error("auth_capture_accept_not_eligible");
  }
  const extra = accept.extra as Record<string, unknown>;
  // 公式 client へ渡す要件。ドメインは profile の値（売り手からは取らない）。有効窓は exact と同じ上限で縮める。
  const requested = Number.isInteger(accept.maxTimeoutSeconds) ? (accept.maxTimeoutSeconds as number) : MAX_AUTHORIZATION_WINDOW_SECONDS;
  const window = Math.min(Math.max(requested, 60), MAX_AUTHORIZATION_WINDOW_SECONDS);
  const requirements = {
    scheme: accept.scheme,
    network: accept.network as `${string}:${string}`,
    amount: accept.amount,
    asset: accept.asset,
    payTo: accept.payTo,
    maxTimeoutSeconds: window,
    extra: { ...extra, name: profile.usdcEip712.name, version: profile.usdcEip712.version },
  };
  const client = new AuthCaptureEvmScheme(guardedSigner(args.account, accept, profile, nowSec));
  const created = await client.createPaymentPayload(2, requirements as Parameters<AuthCaptureEvmScheme["createPaymentPayload"]>[1]);
  const payload = created.payload as {
    authorization: AuthCaptureAuthorization;
    signature: string;
    salt: string;
    saltNonce?: string;
  };
  const authorization = { ...payload.authorization };
  args.onSigned?.({ nonce: authorization.nonce, authorization, payer: authorization.from });

  const paymentInfo: AuthCapturePaymentInfo = {
    operator: extra.captureAuthorizer as string,
    payer: authorization.from,
    receiver: accept.payTo,
    token: accept.asset,
    maxAmount: accept.amount,
    preApprovalExpiry: Number(authorization.validBefore),
    authorizationExpiry: extra.captureDeadline as number,
    refundExpiry: extra.refundDeadline as number,
    minFeeBps: extra.minFeeBps as number,
    maxFeeBps: extra.maxFeeBps as number,
    feeReceiver: extra.feeRecipient as string,
    salt: payload.salt,
  };
  const escrow = AUTH_CAPTURE_ESCROW_V1_1;
  // 公式 client が署名した nonce は、この PaymentInfo の payer に依らない hash でなければならない。食い違えば
  // 我々の控え（reclaim に使う値）と署名が別物なので、送らずに止める（金はまだ動いていない）。
  if (hashPaymentInfo(profile.chainId, paymentInfo, zeroAddress, escrow).toLowerCase() !== authorization.nonce.toLowerCase()) {
    throw new Error("auth_capture_nonce_mismatch");
  }
  const paymentInfoHash = hashPaymentInfo(profile.chainId, paymentInfo, paymentInfo.payer, escrow);

  const header = toBase64(
    JSON.stringify({
      x402Version: 2,
      resource: { url: args.resource },
      accepted: {
        scheme: accept.scheme,
        network: accept.network,
        amount: accept.amount,
        asset: accept.asset,
        payTo: accept.payTo,
        ...(accept.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: accept.maxTimeoutSeconds } : {}),
        extra: accept.extra,
      },
      payload,
    }),
  );

  const timeoutMs = args.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let status: number | null = null;
  let body: string | null = null;
  let settlement: X402Settlement | null = null;
  try {
    const response = await args.fetch(args.resource, {
      method: args.method,
      headers: {
        accept: "application/json",
        "PAYMENT-SIGNATURE": header,
        ...(args.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(args.method === "POST" ? { body: "{}" } : {}),
      signal: controller.signal,
    });
    status = typeof response?.status === "number" ? response.status : null;
    settlement = parseSettlementResponse(response?.headers);
    const reading = response ? bodyReader(response as { text?: () => Promise<string> }) : null;
    if (reading !== null) {
      // 本文の読みも同じ時間に入れる（ヘッダだけ返して本文を流さない売り手を、届いたと数えない）。
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        if (controller.signal.aborted) reject(new Error("timeout"));
      });
      body = await Promise.race([reading, aborted]).catch(() => null);
    }
  } catch {
    // 接続できない・時間切れ。届かなかった。
  } finally {
    clearTimeout(timer);
  }

  const delivery = timedOut
    ? { delivered: false, failure: "timeout" as const }
    : classifyDelivery(status, body);

  let state: AuthCaptureReceipt["state"] = { source: "seller_header" };
  let outcome: AuthCaptureReceipt["outcome"] = "unknown";
  if (args.stateReader) {
    try {
      const read = await readAuthCaptureState({ reader: args.stateReader, paymentInfoHash, escrow });
      state = { source: "chain", ...read };
      outcome = outcomeFromState(read);
    } catch {
      state = { source: "seller_header" };
    }
  }
  if (state.source === "seller_header") {
    // 売り手の申告だけで言えるのは、届いて success が返った（sync の capture）ことだけ。
    outcome = delivery.delivered && settlement?.success === true && settlement.transaction ? "captured" : "unknown";
  }

  const paid = delivery.delivered && outcome === "captured";
  const captureTx = paid ? settlement?.transaction ?? null : null;
  // 届かずに capture された、と言えるのは chain で読んだときだけ（売り手の申告では capture か void か分からない）。
  const capturedUndelivered = !delivery.delivered && state.source === "chain" && outcome === "captured";
  const receipt: AuthCaptureReceipt = {
    scheme: "auth-capture",
    operatorType: "delegated",
    escrow,
    signatures: 1,
    paymentInfo,
    paymentInfoHash,
    delivered: delivery.delivered,
    deliveryFailure: delivery.failure,
    responseStatus: timedOut ? null : status,
    bodyLength: body === null ? null : body.length,
    state,
    outcome,
    captureTx,
    capturedUndelivered,
    recovery: recoveryFor({
      paid,
      outcome,
      paymentInfo,
      paymentInfoHash,
      escrow,
      reportedTx: settlement?.success === true ? settlement.transaction : null,
    }),
  };
  return {
    signed: true,
    paid,
    txHash: captureTx,
    nonce: authorization.nonce,
    authorization,
    settlement,
    responseStatus: timedOut ? null : status,
    receipt,
  };
}

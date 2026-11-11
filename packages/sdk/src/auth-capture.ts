/**
 * x402 `auth-capture` (EVM, operatorType "delegated", paymentFlow "escrow", sync capture) for the
 * buyer side of `payOrRefuse`. (English header for judges. The Japanese block below is the same
 * content in our working language.)
 *
 * Primary source, pinned to one commit of the canonical repository:
 *   https://github.com/x402-foundation/x402/blob/d3eb19d018801c190be58acf4017e76f8bcf6d45/specs/schemes/auth-capture/scheme_auth_capture.md
 *     L1 the scheme name, L19-24 the lifecycle operations, L27 reclaim is the client's own escape
 *     hatch, L36 escrow: authorize before the resource runs, then capture or void.
 *   .../scheme_auth_capture_evm.md L15 one client signature, L35-41 delegated, L140-145 the v1.1
 *     deployment, L369-378 sync and deferred finalize.
 *
 * The buyer signs once (ERC-3009 ReceiveWithAuthorization to the v1.1 token collector). The funds
 * sit in the escrow contract, never in a vet402 wallet. Whether they are captured is decided by the
 * seller's operator, so this file only claims what the buyer can see: the answer arrived or not,
 * what the seller reported, and (when the caller passes a reader) what the escrow holds. A hold
 * that nobody captured comes back to the buyer by `void`, or by the buyer's own `reclaim` after
 * the capture deadline.
 *
 * **This file has no runtime import** (it sits in the static graph of `pay-or-refuse.js`). The signer,
 * `@x402/evm` and viem are reached only from `./auth-capture-pay.js`, which `payOrRefuse` imports
 * dynamically inside the ALLOW branch.
 */
/**
 * 買い手側の x402 `auth-capture`（EVM・delegated・escrow・sync）の定数と、402 の accept を
 * 払ってよい形かどうか見る純粋な述語。
 *
 * 一次: x402-foundation/x402 の d3eb19d0 の `scheme_auth_capture.md`（L1 名前・L27 reclaim・L36 escrow）と
 * `scheme_auth_capture_evm.md`（L15 署名は1つ・L35-41 delegated・L140-145 v1.1 の配備先・L369-378 sync）。
 *
 * 資金はエスクローのコントラクトに置かれ、vet402 の財布では預からない。capture するかは売り手の
 * operator が決める（信頼の境界）。だから SDK が言うのは、届いたか・売り手が何と言ったか・
 * （reader を渡されたら）エスクローに何が残っているか、だけ。capture されなかった hold は
 * void か、期限後の買い手自身の reclaim で戻る。
 *
 * **このファイルは実行時の import を持たない**（型だけ・`pay-or-refuse.js` の静的グラフに入る）。
 */

import type { ChainProfile } from "./chain-profile.js";
import type { X402Accept } from "./x402-pay.js";

export const AUTH_CAPTURE_SCHEME = "auth-capture";

/** commerce-payments v1.1（`scheme_auth_capture_evm.md` L142-143）。Base と Base Sepolia で同じ CREATE2 アドレス。 */
export const AUTH_CAPTURE_ESCROW_V1_1 = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
export const AUTH_CAPTURE_EIP3009_COLLECTOR_V1_1 = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88";

/**
 * 公開名の一次引用。URL はコミット固定、行は L1。この引用が空なら公開名は出さない
 * （`src/lib/e4/form1.ts` の 9a-6 試験が同じ値を読む）。
 */
export const AUTH_CAPTURE_SPEC_COMMIT = "d3eb19d018801c190be58acf4017e76f8bcf6d45";
export const AUTH_CAPTURE_SPEC_URL =
  `https://github.com/x402-foundation/x402/blob/${AUTH_CAPTURE_SPEC_COMMIT}/specs/schemes/auth-capture/scheme_auth_capture.md`;

/**
 * 売り手が決める capture の期限（`extra.captureDeadline`）の上限。期限までは operator しか hold を動かせず、
 * 買い手の reclaim は期限の後でしか通らない。期限が遠い 402 は、届かなかったときの買い手の資金を長く縛るので払わない。
 */
export const MAX_CAPTURE_WINDOW_SECONDS = 3600;

/** 届いたかを待つ既定の時間（ミリ秒）。過ぎたら届かなかったと数える。 */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

/**
 * 呼び手の設定。**本番 Base では既定で使わない**（`onBase` を true にした呼び手だけ）。
 * Base Sepolia では、402 が auth-capture を出していれば使う（`enabled: false` で切れる）。
 */
export type AuthCaptureOptions = {
  /** Base Sepolia で auth-capture を使うか。既定 true。 */
  enabled?: boolean;
  /** 本番 Base（eip155:8453）で auth-capture を使うか。**既定 false。** */
  onBase?: boolean;
  /** 届くのを待つ時間（ミリ秒）。既定 {@link DEFAULT_DELIVERY_TIMEOUT_MS}。 */
  deliveryTimeoutMs?: number;
  /**
   * エスクローの状態を読む口（viem の `PublicClient` がそのまま当てはまる）。渡したときだけ、
   * 応答のあとに `paymentState` を読んで結果を確かめる。渡さなければ売り手の申告だけで書く（`state.source`）。
   */
  stateReader?: AuthCaptureStateReader;
};

export type AuthCaptureStateReader = {
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
};

/** エスクローの `PaymentInfo`（`AuthCaptureEscrow.sol` の構造体と同じ順）。reclaim にはこの値をそのまま渡す。 */
export type AuthCapturePaymentInfo = {
  operator: string;
  payer: string;
  receiver: string;
  token: string;
  maxAmount: string;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: string;
  salt: string;
};

export type AuthCaptureDeliveryFailure = "http_status" | "accepted_202" | "empty_body" | "timeout" | "network_error";

/**
 * 支払いの行き先。
 *  - `captured` … 売り手へ払われた（chain なら refundable > 0）
 *  - `held` … エスクローに残っている（operator の void か、期限後の買い手の reclaim で戻る）
 *  - `voided` … 集めたあと買い手へ戻った（void・reclaim・全額 refund のどれか。chain で確かめたときだけ言う）
 *  - `not_authorized` … エスクローに入っていない（chain で確かめたときだけ言う）
 *  - `unknown` … 売り手の申告だけでは決められない
 */
export type AuthCaptureOutcome = "captured" | "held" | "voided" | "not_authorized" | "unknown";

export type AuthCaptureReceipt = {
  scheme: "auth-capture";
  operatorType: "delegated";
  escrow: string;
  /** 署名は 1 つだけ（ERC-3009 ReceiveWithAuthorization、宛先は token collector）。 */
  signatures: 1;
  paymentInfo: AuthCapturePaymentInfo;
  /** `AuthCaptureEscrow.getHash(paymentInfo)` と同じ値（payer 込み）。 */
  paymentInfoHash: string;
  /** 空でない 2xx（202 を除く）が時間内に届いたか。台帳の delivered と同じ規則。 */
  delivered: boolean;
  deliveryFailure: AuthCaptureDeliveryFailure | null;
  responseStatus: number | null;
  /** 本文の長さ（バイトではなく文字数）。応答が無ければ null。 */
  bodyLength: number | null;
  state:
    | { source: "chain"; collected: boolean; capturable: string; refundable: string }
    | { source: "seller_header" };
  outcome: AuthCaptureOutcome;
  /** 届いて capture されたときの tx（売り手の申告）。それ以外は null。 */
  captureTx: string | null;
  /**
   * 届かずに capture された（chain で確かめた）印。正直でない operator、または 400 未満を capture する公式の
   * 売り手実装で起きる。`status` は "failed"、`reason_codes` に `operator_captured_undelivered`。
   */
  capturedUndelivered: boolean;
  /**
   * 戻り道。払えた（届いて capture された）ときは null。資金の場所で 3 つに分ける。
   *  - `captured` … capture 済み。戻すのは operator の refund だけ（買い手からは呼べない）
   *  - `uncaptured` … capture されていない（chain で確かめた）。hold が残っていれば operator の void か、
   *    期限後の買い手の reclaim で戻る。すでに戻っていれば（void 済み・エスクローに入っていない）`fundsWithBuyer: true`
   *  - `unknown` … chain を読んでいないので判定しない。`readState` の値で `readAuthCaptureState` を呼んでから選ぶ
   *    （reclaim は capture 済みの支払いを戻せないので、ここでは勧めない）
   */
  recovery: AuthCaptureRecovery | null;
};

export type AuthCaptureRecovery =
  | { state: "captured"; refund: { by: "operator" } }
  | {
      state: "uncaptured";
      fundsWithBuyer: boolean;
      /** hold が残っているときだけ。売り手が tx を申告していれば載せる（確かめた値ではない）。 */
      void: { by: "operator"; reportedTx: string | null } | null;
      /** hold が残っているときだけ。期限（`captureDeadline` = `authorizationExpiry`）を過ぎたら買い手の財布が呼べる。 */
      reclaim: { by: "payer"; escrow: string; availableAt: number; fn: "reclaim" } | null;
    }
  | {
      state: "unknown";
      /** 判定に読む値。`readAuthCaptureState({ reader, paymentInfoHash, escrow })`。 */
      readState: { fn: "paymentState"; escrow: string; paymentInfoHash: string };
      /** 売り手が PAYMENT-RESPONSE で申告した tx（capture か void か authorize かは、ヘッダだけでは分からない）。 */
      reportedTx: string | null;
    };

/** 結果の値から戻り道を組む。chain で読めていない（`outcome: "unknown"`）なら判定しない。 */
export function recoveryFor(input: {
  paid: boolean;
  outcome: AuthCaptureOutcome;
  paymentInfo: AuthCapturePaymentInfo;
  paymentInfoHash: string;
  escrow: string;
  reportedTx: string | null;
}): AuthCaptureRecovery | null {
  if (input.paid) return null;
  switch (input.outcome) {
    case "captured":
      return { state: "captured", refund: { by: "operator" } };
    case "held":
      return {
        state: "uncaptured",
        fundsWithBuyer: false,
        void: { by: "operator", reportedTx: input.reportedTx },
        reclaim: { by: "payer", escrow: input.escrow, availableAt: input.paymentInfo.authorizationExpiry, fn: "reclaim" },
      };
    case "voided":
    case "not_authorized":
      return { state: "uncaptured", fundsWithBuyer: true, void: null, reclaim: null };
    default:
      return {
        state: "unknown",
        readState: { fn: "paymentState", escrow: input.escrow, paymentInfoHash: input.paymentInfoHash },
        reportedTx: input.reportedTx,
      };
  }
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

function isNonZeroAddress(v: unknown): v is string {
  return typeof v === "string" && ADDR_RE.test(v) && v.toLowerCase() !== ZERO;
}
function isAbsentOrZero(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (typeof v === "string" && v.toLowerCase() === ZERO);
}
function isUint(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

/** この呼び出しで auth-capture を使ってよいか。本番 Base は `onBase: true` のときだけ。 */
export function authCaptureEnabled(profile: ChainProfile, options: AuthCaptureOptions | undefined): boolean {
  if (profile.name === "base") return options?.onBase === true;
  return options?.enabled !== false;
}

/**
 * 402 の accept が、SDK が払える auth-capture の形か。金額と payTo は見ない（それは金銭ゲートと payee 照合）。
 *
 * 払う形は1つだけ: x402 v2・delegated・escrow・sync・eip3009・v1.1 のエスクロー・policy なし・
 * receiverAuthorizer あり（無い sync は capture も void もできず、期限まで買い手の資金が止まる・EVM 版 L377）・
 * capture の期限が {@link MAX_CAPTURE_WINDOW_SECONDS} 以内。これ以外の auth-capture は「払えない形」として扱う。
 */
export function isAuthCaptureEligible(
  accept: X402Accept,
  profile: ChainProfile,
  x402Version: 1 | 2,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (x402Version !== 2) return false;
  if (accept.scheme !== AUTH_CAPTURE_SCHEME) return false;
  if (accept.network !== profile.network) return false;
  if (typeof accept.asset !== "string" || accept.asset.toLowerCase() !== profile.asset.toLowerCase()) return false;
  if (!ADDR_RE.test(accept.payTo)) return false;
  const extra = accept.extra as Record<string, unknown> | undefined;
  if (typeof extra !== "object" || extra === null) return false;
  const operatorType = extra.operatorType;
  if (operatorType !== undefined && operatorType !== "delegated") return false;
  const flow = extra.paymentFlow;
  if (flow !== undefined && flow !== "escrow") return false;
  const mode = extra.captureMode;
  if (mode !== undefined && mode !== "sync") return false;
  const transfer = extra.assetTransferMethod;
  if (transfer !== undefined && transfer !== "eip3009") return false;
  const escrow = extra.authCaptureEscrow;
  if (escrow !== undefined && (typeof escrow !== "string" || escrow.toLowerCase() !== AUTH_CAPTURE_ESCROW_V1_1.toLowerCase())) {
    return false;
  }
  if (!isAbsentOrZero(extra.policy)) return false;
  if (!isNonZeroAddress(extra.captureAuthorizer)) return false;
  if (!isNonZeroAddress(extra.receiverAuthorizer)) return false;
  if (typeof extra.feeRecipient !== "string" || !ADDR_RE.test(extra.feeRecipient)) return false;
  if (!isUint(extra.minFeeBps, 10_000) || !isUint(extra.maxFeeBps, 10_000)) return false;
  if (extra.minFeeBps > extra.maxFeeBps) return false;
  const capture = extra.captureDeadline;
  const refund = extra.refundDeadline;
  if (!isUint(capture, 2 ** 48 - 1) || !isUint(refund, 2 ** 48 - 1)) return false;
  if (refund < capture) return false;
  if (capture <= nowSec) return false;
  if (capture - nowSec > MAX_CAPTURE_WINDOW_SECONDS) return false;
  return true;
}

/** 空でない 2xx（202 を除く）。`src/lib/observatory/delivery.ts` の `isDelivered` と L1 の本文の数え方に揃える。 */
export function classifyDelivery(
  status: number | null,
  body: string | null,
): { delivered: boolean; failure: AuthCaptureDeliveryFailure | null } {
  if (status === null) return { delivered: false, failure: "network_error" };
  if (status === 202) return { delivered: false, failure: "accepted_202" };
  if (status < 200 || status > 299) return { delivered: false, failure: "http_status" };
  if (body === null || body.trim().length === 0) return { delivered: false, failure: "empty_body" };
  return { delivered: true, failure: null };
}

/** `AuthCaptureEscrow` のうち、SDK が使う関数だけ（commerce-payments b748fdd7 の ABI）。 */
export const PAYMENT_INFO_COMPONENTS = [
  { name: "operator", type: "address" },
  { name: "payer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "token", type: "address" },
  { name: "maxAmount", type: "uint120" },
  { name: "preApprovalExpiry", type: "uint48" },
  { name: "authorizationExpiry", type: "uint48" },
  { name: "refundExpiry", type: "uint48" },
  { name: "minFeeBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" },
  { name: "feeReceiver", type: "address" },
  { name: "salt", type: "uint256" },
] as const;

export const AUTH_CAPTURE_ESCROW_ABI = [
  {
    type: "function",
    name: "reclaim",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentInfo", type: "tuple", components: PAYMENT_INFO_COMPONENTS }],
    outputs: [],
  },
  {
    type: "function",
    name: "getHash",
    stateMutability: "view",
    inputs: [{ name: "paymentInfo", type: "tuple", components: PAYMENT_INFO_COMPONENTS }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "paymentState",
    stateMutability: "view",
    inputs: [{ name: "paymentInfoHash", type: "bytes32" }],
    outputs: [
      { name: "hasCollectedPayment", type: "bool" },
      { name: "capturableAmount", type: "uint120" },
      { name: "refundableAmount", type: "uint120" },
    ],
  },
] as const;

/** viem の `writeContract` / `readContract` に渡す形（数は bigint）。 */
export function paymentInfoArgs(info: AuthCapturePaymentInfo) {
  return {
    operator: info.operator as `0x${string}`,
    payer: info.payer as `0x${string}`,
    receiver: info.receiver as `0x${string}`,
    token: info.token as `0x${string}`,
    maxAmount: BigInt(info.maxAmount),
    preApprovalExpiry: info.preApprovalExpiry,
    authorizationExpiry: info.authorizationExpiry,
    refundExpiry: info.refundExpiry,
    minFeeBps: info.minFeeBps,
    maxFeeBps: info.maxFeeBps,
    feeReceiver: info.feeReceiver as `0x${string}`,
    salt: BigInt(info.salt),
  };
}

/** エスクローの状態を読む。`paymentState` は tuple でも配列でも返り得るので両方読む。 */
export async function readAuthCaptureState(input: {
  reader: AuthCaptureStateReader;
  paymentInfoHash: string;
  escrow?: string;
}): Promise<{ collected: boolean; capturable: string; refundable: string }> {
  const raw = await input.reader.readContract({
    address: (input.escrow ?? AUTH_CAPTURE_ESCROW_V1_1) as `0x${string}`,
    abi: AUTH_CAPTURE_ESCROW_ABI,
    functionName: "paymentState",
    args: [input.paymentInfoHash as `0x${string}`],
  });
  const rec = raw as Record<string | number, unknown>;
  const collected = rec.hasCollectedPayment ?? rec[0];
  const capturable = rec.capturableAmount ?? rec[1];
  const refundable = rec.refundableAmount ?? rec[2];
  if (typeof collected !== "boolean") throw new Error("auth_capture_state_unreadable");
  const asUnits = (v: unknown): string => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
    if (typeof v === "string" && /^[0-9]+$/.test(v)) return v;
    throw new Error("auth_capture_state_unreadable");
  };
  return { collected, capturable: asUnits(capturable), refundable: asUnits(refundable) };
}

/** 状態から行き先を決める。chain で読めたときだけ voided と not_authorized を言う。 */
export function outcomeFromState(state: { collected: boolean; capturable: string; refundable: string }): AuthCaptureOutcome {
  if (!state.collected) return "not_authorized";
  if (BigInt(state.refundable) > 0n) return "captured";
  if (BigInt(state.capturable) > 0n) return "held";
  return "voided";
}

/**
 * 期限後に、**買い手の財布が**エスクローの hold を取り戻す。vet402 は呼ばない・預からない。
 * `wallet` は viem の `WalletClient`（account 付き）がそのまま当てはまる。期限の前はコントラクトが
 * `BeforeAuthorizationExpiry` で revert するので、`now` を渡せば送る前に止める。
 */
export async function reclaimAuthCapture(input: {
  wallet: {
    writeContract(args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
      account?: unknown;
      chain?: unknown;
    }): Promise<string>;
    account?: { address: string } | null;
  };
  paymentInfo: AuthCapturePaymentInfo;
  escrow?: string;
  nowSec?: number;
}): Promise<{ txHash: string }> {
  const { wallet, paymentInfo } = input;
  const caller = wallet.account?.address;
  if (typeof caller === "string" && caller.toLowerCase() !== paymentInfo.payer.toLowerCase()) {
    throw new Error("reclaim_not_payer: only the payer's own wallet can reclaim this hold");
  }
  if (input.nowSec !== undefined && input.nowSec < paymentInfo.authorizationExpiry) {
    throw new Error(
      `reclaim_before_deadline: reclaim opens at ${paymentInfo.authorizationExpiry} (captureDeadline), now is ${input.nowSec}`,
    );
  }
  const txHash = await wallet.writeContract({
    address: (input.escrow ?? AUTH_CAPTURE_ESCROW_V1_1) as `0x${string}`,
    abi: AUTH_CAPTURE_ESCROW_ABI,
    functionName: "reclaim",
    args: [paymentInfoArgs(paymentInfo)],
    ...(wallet.account ? { account: wallet.account } : {}),
    chain: null,
  });
  return { txHash };
}

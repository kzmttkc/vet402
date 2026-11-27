// ============================================================
// Hedera-402 payer（2026-11-27）——Hedera（`hedera:mainnet` / `hedera:testnet`）上の x402 `exact` scheme。
//
// 正本: 改造していない `@x402/hedera` 2.31.0 の ExactHederaScheme と createClientHederaSigner。
// 払い手は HEDERA_PAYER_ACCOUNT_ID（0.0.x）と HEDERA_PAYER_PRIVATE_KEY（ECDSA secp256k1 の hex）。
// 鍵の値はログ・誤り・記録に出さない（redact.ts の redactHederaSecret が誤りの本文から伏せる）。
//
// 払うのは HBAR（asset "0.0.0"）だけ。facilitator は Blocky402 だけ（fee payer の口座で判定する）。
// 払い手は HTS の USDC を関連付けていないので、USDC の accept は選ばない（asset_unsupported）。
//
// 台帳（x402_l1_purchases.amount_units / spent_units）は USD の 6 桁。HBAR は Hedera ネットワーク自身の
// 為替（mirror node の /api/v1/network/exchangerate・cent_equivalent / hbar_equivalent）で 6 桁へ
// 切り上げる（支出を少なく数えない）。払った tinybar と使った為替は raw_response_meta.hedera に残し、
// 照合（settlement-verify-hedera.ts）は tinybar で完全一致を要求する。
//
// 上限（2026-11-27 オーナー承認）: 1 回 0.1 HBAR まで、会期前の合計 5 HBAR まで。環境変数で下げられるが、
// 上げられない（L1_HEDERA_MAX_PURCHASE_TINYBARS・L1_HEDERA_TOTAL_CAP_TINYBARS）。日次の USD 別枠は
// budget.ts の CHAIN_DAILY_CAPS.hedera（既定 $0.05・L1_HEDERA_DAILY_CAP_USD）。
//
// レーンそのものは OBSERVATORY_HEDERA_L1_ENABLED が正確に "true" のときだけ。既定 OFF。
// この module は金に署名する。形が完全に一致しない accept は予約より前に断る。
// ============================================================
import type { ChallengeAccept } from "./x402-payer";

export const HEDERA_MAINNET_CAIP2 = "hedera:mainnet";
export const HEDERA_TESTNET_CAIP2 = "hedera:testnet";
export type HederaNetwork = typeof HEDERA_MAINNET_CAIP2 | typeof HEDERA_TESTNET_CAIP2;

/** HBAR の asset 表記（@x402/hedera HBAR_ASSET_ID と同じ値）。 */
export const HBAR_ASSET = "0.0.0";
/** HBAR の小数桁（tinybar）。 */
export const HBAR_DECIMALS = 8;

/** Hedera の mirror node（公開・無料）。照合・残高・為替の読み口。 */
export const HEDERA_MIRROR_NODE_URLS: Record<HederaNetwork, string> = {
  [HEDERA_MAINNET_CAIP2]: "https://mainnet-public.mirrornode.hedera.com",
  [HEDERA_TESTNET_CAIP2]: "https://testnet.mirrornode.hedera.com",
};

/** Blocky402 の facilitator（目録の /discovery/resources もここ）。 */
export const BLOCKY402_URLS: Record<HederaNetwork, string> = {
  [HEDERA_MAINNET_CAIP2]: "https://api.blocky402.com",
  [HEDERA_TESTNET_CAIP2]: "https://api.testnet.blocky402.com",
};

/**
 * Blocky402 の fee payer（/supported の signers・2026-11-27 実測）。壁の extra.feePayer がこれ以外なら署名しない
 * （取引 ID は fee payer の口座から作るので、知らない facilitator に署名済みの取引を渡さない）。
 */
export const BLOCKY402_FEE_PAYERS: Record<HederaNetwork, readonly string[]> = {
  [HEDERA_MAINNET_CAIP2]: ["0.0.10571514"],
  [HEDERA_TESTNET_CAIP2]: ["0.0.7162784"],
};

/** 1 回の上限（tinybar）。オーナー承認 2026-11-27: 0.1 HBAR。 */
export const HEDERA_MAX_PURCHASE_TINYBARS_DEFAULT = 10_000_000n;
/** 合計の上限（tinybar）。オーナー承認 2026-11-27: 会期前は 5 HBAR。 */
export const HEDERA_TOTAL_CAP_TINYBARS_DEFAULT = 500_000_000n;

const ENTITY_ID_RE = /^0\.0\.[0-9]{1,19}$/;
/** 取引 ID。`0.0.x@秒.ナノ秒`（SDK の表記）と `0.0.x-秒-ナノ秒`（mirror node の表記）。 */
const TX_ID_RE = /^0\.0\.([0-9]{1,19})[@-]([0-9]{1,19})[.-]([0-9]{1,9})$/;

export function isHederaL1Enabled(): boolean {
  return process.env.OBSERVATORY_HEDERA_L1_ENABLED === "true";
}

export function isHederaNetwork(network: unknown): network is HederaNetwork {
  return network === HEDERA_MAINNET_CAIP2 || network === HEDERA_TESTNET_CAIP2;
}

/**
 * ランナーが買う Hedera の網。既定は mainnet。HEDERA_L1_NETWORK が正確に "hedera:testnet" のときだけ testnet
 * （本番の秘密には入れない。試験網で通しを確かめるとき用）。
 */
export function hederaL1Network(): HederaNetwork {
  return process.env.HEDERA_L1_NETWORK === HEDERA_TESTNET_CAIP2 ? HEDERA_TESTNET_CAIP2 : HEDERA_MAINNET_CAIP2;
}

export function isHederaEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID_RE.test(value);
}

/** 取引 ID を SDK の表記（`0.0.x@秒.ナノ秒`・ナノ秒は 9 桁）に揃える。形が違えば null。 */
export function normalizeHederaTxId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = TX_ID_RE.exec(value.trim());
  if (!m) return null;
  return `0.0.${m[1]}@${m[2]}.${m[3].padStart(9, "0")}`;
}

/** mirror node の path に使う表記（`0.0.x-秒-ナノ秒`）。 */
export function mirrorHederaTxId(value: unknown): string | null {
  const n = normalizeHederaTxId(value);
  if (!n) return null;
  const [account, rest] = n.split("@");
  const [sec, nanos] = rest.split(".");
  return `${account}-${sec}-${nanos}`;
}

function positiveBigIntEnvClamped(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw || !/^[0-9]{1,19}$/.test(raw)) return fallback;
  const v = BigInt(raw);
  // 下げるだけ。上げない（オーナーの承認した上限をコードで守る）。
  return v < fallback ? v : fallback;
}

/** 1 回の上限（tinybar）。環境変数は下げるだけ。 */
export function hederaMaxPurchaseTinybars(): bigint {
  return positiveBigIntEnvClamped("L1_HEDERA_MAX_PURCHASE_TINYBARS", HEDERA_MAX_PURCHASE_TINYBARS_DEFAULT);
}

/** 合計の上限（tinybar）。環境変数は下げるだけ。 */
export function hederaTotalCapTinybars(): bigint {
  return positiveBigIntEnvClamped("L1_HEDERA_TOTAL_CAP_TINYBARS", HEDERA_TOTAL_CAP_TINYBARS_DEFAULT);
}

/** これまでの合計（tinybar）に今回を足すと合計の上限を超えるか。超えるなら署名しない。 */
export function wouldExceedHederaTotalCap(spentTinybars: bigint, requestTinybars: bigint): boolean {
  return spentTinybars + requestTinybars > hederaTotalCapTinybars();
}

export type HederaExchangeRate = {
  /** 米セント。 */
  centEquivalent: bigint;
  /** HBAR。 */
  hbarEquivalent: bigint;
  /** この為替が切れる時刻（Unix 秒）。 */
  expirationTime: number;
};

/** tinybar → 台帳の USD 6 桁。切り上げ（1 tinybar でも 1 unit 以上に数える）。 */
export function tinybarsToLedgerUnits(tinybars: bigint, rate: HederaExchangeRate): bigint {
  if (tinybars <= 0n) return 0n;
  // USD = tinybars / 1e8 HBAR × (cent / hbar) / 100。6 桁 = × 1e6。分母 = hbar × 1e4。
  const num = tinybars * rate.centEquivalent;
  const den = rate.hbarEquivalent * 10_000n;
  return (num + den - 1n) / den;
}

/** 台帳の USD 6 桁 → tinybar。切り捨て（残高を多く数えない）。 */
export function ledgerUnitsFromTinybarsFloor(tinybars: bigint, rate: HederaExchangeRate): bigint {
  if (tinybars <= 0n) return 0n;
  return (tinybars * rate.centEquivalent) / (rate.hbarEquivalent * 10_000n);
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function mirrorJson(network: HederaNetwork, path: string, fetchImpl: FetchLike = fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetchImpl(`${HEDERA_MIRROR_NODE_URLS[network]}${path}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`hedera_mirror_http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 今の為替。読めなければ throw（呼び手は署名しない側へ倒す）。 */
export async function readHederaExchangeRate(network: HederaNetwork, fetchImpl?: FetchLike): Promise<HederaExchangeRate> {
  const body = (await mirrorJson(network, "/api/v1/network/exchangerate", fetchImpl)) as {
    current_rate?: { cent_equivalent?: unknown; hbar_equivalent?: unknown; expiration_time?: unknown };
  } | null;
  const r = body?.current_rate;
  const cent = r?.cent_equivalent;
  const hbar = r?.hbar_equivalent;
  const exp = r?.expiration_time;
  if (typeof cent !== "number" || typeof hbar !== "number" || !Number.isInteger(cent) || !Number.isInteger(hbar) || cent <= 0 || hbar <= 0) {
    throw new Error("hedera_exchange_rate_unreadable");
  }
  return { centEquivalent: BigInt(cent), hbarEquivalent: BigInt(hbar), expirationTime: typeof exp === "number" ? exp : 0 };
}

/** 払い手の HBAR 残高（tinybar）。口座が無い・読めなければ throw。 */
export async function readHederaHbarTinybars(network: HederaNetwork, accountId: string, fetchImpl?: FetchLike): Promise<bigint> {
  if (!isHederaEntityId(accountId)) throw new Error("hedera_account_id_invalid");
  const body = (await mirrorJson(network, `/api/v1/accounts/${accountId}`, fetchImpl)) as {
    balance?: { balance?: unknown };
  } | null;
  const bal = body?.balance?.balance;
  if (body === null) throw new Error("hedera_account_not_found");
  if (typeof bal !== "number" || !Number.isSafeInteger(bal) || bal < 0) throw new Error("hedera_balance_unreadable");
  return BigInt(bal);
}

/**
 * 払い手の口座の鍵が mirror node に載っているか。hollow（EVM アドレスへの送金で作られ、鍵の無い口座）だと
 * facilitator の署名検査（@x402/hedera createHederaVerifyPayerSignature）が payer の鍵を引けず断る。
 */
export async function readHederaAccountHasKey(network: HederaNetwork, accountId: string, fetchImpl?: FetchLike): Promise<boolean> {
  const body = (await mirrorJson(network, `/api/v1/accounts/${accountId}`, fetchImpl)) as { key?: unknown } | null;
  if (body === null) throw new Error("hedera_account_not_found");
  return typeof body.key === "object" && body.key !== null;
}

/**
 * HEDERA_PAYER_ACCOUNT_ID と HEDERA_PAYER_PRIVATE_KEY から払い手を作る。どちらかが読めなければ null
 * （fail-closed: 鍵が読めない状態で Hedera の候補は選ばれない）。秘密は決して返さない。
 */
export function loadHederaPayer(): { accountId: string } | null {
  const accountId = process.env.HEDERA_PAYER_ACCOUNT_ID?.trim() ?? "";
  const key = process.env.HEDERA_PAYER_PRIVATE_KEY?.trim() ?? "";
  if (!isHederaEntityId(accountId)) return null;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) return null;
  return { accountId };
}

export type HederaAcceptSelection =
  | {
      accept: ChallengeAccept;
      reason: null;
      detail: null;
      /** 払う額（tinybar）。台帳の 6 桁は呼び手が為替で換算する。 */
      tinybars: bigint;
    }
  | {
      accept: null;
      reason: "no_eligible_accept" | "price_mismatch" | "payto_mismatch" | "over_cap";
      detail: "asset_unsupported" | "facilitator_unsupported" | "unbuildable" | null;
      tinybars?: undefined;
    };

function parseUnits(amount: unknown): bigint | null {
  if (typeof amount !== "string" || !/^[0-9]{1,19}$/.test(amount)) return null;
  const v = BigInt(amount);
  return v > 0n ? v : null;
}

function timeoutAccepted(maxTimeoutSeconds: unknown): boolean {
  return maxTimeoutSeconds === undefined || (typeof maxTimeoutSeconds === "number" && Number.isInteger(maxTimeoutSeconds) && maxTimeoutSeconds > 0);
}

/**
 * 壁の accept から、Hedera の HBAR を Blocky402 経由で払える 1 件を選ぶ。拒否の語彙は他レーンと同じ順序
 * （payTo → 価格 → 上限）。旗が OFF なら選ばない。
 *
 * 額: HBAR の値段は売り手が USD から毎回計算し直す（2026-11-27 実測: 目録 5,802,334・壁 5,473,255 tinybar。
 * どちらも $0.003）。だから宣言額との完全一致ではなく、**壁の額 ≤ 宣言額**（宣言より多くは払わない）で通す。
 * 宣言額が無い行は 1 回の上限だけで縛る。
 */
export function selectHederaAccept(
  accepts: readonly unknown[],
  options: { declaredAmount: string | null; declaredPayTo: string | null; network: HederaNetwork },
): HederaAcceptSelection {
  if (!isHederaL1Enabled()) return { accept: null, reason: "no_eligible_accept", detail: null };
  const onNetwork = (accepts as ChallengeAccept[])
    .filter((a) => a && typeof a === "object")
    .filter((a) => a.scheme === "exact" && a.network === options.network)
    .filter((a) => typeof a.asset === "string" && typeof a.payTo === "string" && typeof a.amount === "string");
  if (onNetwork.length === 0) return { accept: null, reason: "no_eligible_accept", detail: null };
  const hbar = onNetwork.filter((a) => a.asset === HBAR_ASSET);
  if (hbar.length === 0) return { accept: null, reason: "no_eligible_accept", detail: "asset_unsupported" };
  const feePayers = BLOCKY402_FEE_PAYERS[options.network];
  const viaBlocky = hbar.filter((a) => typeof a.extra?.feePayer === "string" && feePayers.includes(a.extra.feePayer as string));
  if (viaBlocky.length === 0) return { accept: null, reason: "no_eligible_accept", detail: "facilitator_unsupported" };
  const buildable = viaBlocky.filter((a) => {
    if (!isHederaEntityId(a.payTo)) return false;
    if (parseUnits(a.amount) === null) return false;
    if (!timeoutAccepted(a.maxTimeoutSeconds)) return false;
    // 改造していない client は cryptoTransfer しか組まない。transferExecutor 等の別の組み方は断る。
    const method = a.extra?.assetTransferMethod;
    if (method !== undefined && method !== "cryptoTransfer") return false;
    return true;
  });
  if (buildable.length === 0) return { accept: null, reason: "no_eligible_accept", detail: "unbuildable" };

  const eligible = options.declaredPayTo === null ? buildable : buildable.filter((a) => a.payTo === options.declaredPayTo);
  if (eligible.length === 0) return { accept: null, reason: "payto_mismatch", detail: null };

  const declared = parseUnits(options.declaredAmount);
  if (options.declaredAmount !== null && declared === null) return { accept: null, reason: "price_mismatch", detail: null };
  const max = hederaMaxPurchaseTinybars();
  let sawOverCap = false;
  for (const accept of eligible) {
    const tinybars = parseUnits(accept.amount)!;
    if (declared !== null && tinybars > declared) continue;
    if (tinybars > max) {
      sawOverCap = true;
      continue;
    }
    return { accept, reason: null, detail: null, tinybars };
  }
  if (sawOverCap) return { accept: null, reason: "over_cap", detail: null };
  return { accept: null, reason: "price_mismatch", detail: null };
}

/**
 * 署名した取引の中身を、署名口へ渡す前に自分で読み直す（売り手の値で組んだ取引が、我々の意図どおりか）。
 * HBAR の送金 2 本だけ: 払い手 −額・受取先 +額。それ以外の操作・トークンの送金・第三者の口座があれば落とす。
 */
export function checkBuiltHederaTransfer(
  inspected: {
    hasNonTransferOperations: boolean;
    hbarTransfers: { accountId: string; amount: string }[];
    tokenTransfers: Record<string, unknown[]>;
    transactionIdAccountId: string;
  },
  expected: { payer: string; payTo: string; tinybars: bigint; feePayer: string },
): string | null {
  if (inspected.hasNonTransferOperations) return "non_transfer_operations";
  if (Object.keys(inspected.tokenTransfers).length > 0) return "token_transfers_present";
  if (inspected.transactionIdAccountId !== expected.feePayer) return "transaction_id_not_fee_payer";
  if (inspected.hbarTransfers.length !== 2) return "unexpected_transfer_count";
  const byAccount = new Map(inspected.hbarTransfers.map((t) => [t.accountId, BigInt(t.amount)]));
  if (byAccount.get(expected.payer) !== -expected.tinybars) return "payer_debit_mismatch";
  if (byAccount.get(expected.payTo) !== expected.tinybars) return "payto_credit_mismatch";
  return null;
}

/**
 * `@x402/hedera` の exact client で、部分署名した TransferTransaction（base64）を作る。額は tinybar。
 * 取引 ID は facilitator の fee payer の口座から作られ、署名の時点で決まる——これが我々しか知らない一回性の値
 * （auth_nonce）で、照合は mirror node でこの ID の取引を読む。
 * 誤りは `hedera_sign_failed:` で始まる。秘密は誤りに入れない（redact.ts の redactHederaSecret も掛かる）。
 * テストは l1-runner の createHederaPayment を差し替え、ここを呼ばない。
 */
export async function createHederaPaymentPayload(input: {
  accept: ChallengeAccept;
  network: HederaNetwork;
  tinybars: bigint;
}): Promise<{ transaction: string; transactionId: string }> {
  const accountId = process.env.HEDERA_PAYER_ACCOUNT_ID?.trim() ?? "";
  const rawKey = process.env.HEDERA_PAYER_PRIVATE_KEY?.trim() ?? "";
  if (!isHederaEntityId(accountId)) throw new Error("hedera_sign_failed: hedera_payer_account_unset");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error("hedera_sign_failed: hedera_payer_key_unset");
  if (input.accept.amount !== String(input.tinybars)) throw new Error("hedera_sign_failed: amount_drift");
  const feePayer = input.accept.extra?.feePayer;
  if (typeof feePayer !== "string" || !BLOCKY402_FEE_PAYERS[input.network].includes(feePayer)) {
    throw new Error("hedera_sign_failed: fee_payer_unsupported");
  }
  try {
    const { ExactHederaScheme, createClientHederaSigner, inspectHederaTransaction, PrivateKey } = await import("@x402/hedera");
    const key = PrivateKey.fromStringECDSA(rawKey.replace(/^0x/, ""));
    const signer = createClientHederaSigner(accountId, key, { network: input.network });
    const scheme = new ExactHederaScheme(signer);
    const created = await scheme.createPaymentPayload(2, {
      scheme: "exact",
      network: input.network,
      asset: HBAR_ASSET,
      amount: String(input.tinybars),
      payTo: input.accept.payTo,
      maxTimeoutSeconds: input.accept.maxTimeoutSeconds ?? 120,
      extra: { ...(input.accept.extra ?? {}) },
    });
    const transaction =
      created.payload && typeof created.payload === "object" ? (created.payload as { transaction?: unknown }).transaction : undefined;
    if (typeof transaction !== "string" || transaction.length === 0) throw new Error("hedera_payload_empty");
    const inspected = inspectHederaTransaction(transaction);
    const problem = checkBuiltHederaTransfer(inspected, { payer: accountId, payTo: input.accept.payTo, tinybars: input.tinybars, feePayer });
    if (problem) throw new Error(`hedera_built_transfer_${problem}`);
    const transactionId = normalizeHederaTxId(inspected.transactionId);
    if (!transactionId) throw new Error("hedera_transaction_id_unreadable");
    return { transaction, transactionId };
  } catch (error) {
    const { redactForLog } = await import("./redact");
    throw new Error(`hedera_sign_failed: ${redactForLog(error)}`);
  }
}

// ============================================================
// Stellar-402 payer（2026-10-18）——Stellar メインネット（`stellar:pubnet`）上の x402 `exact` scheme。
//
// 正本: 改造していない `@x402/stellar` 2.28.0 の ExactStellarScheme（Soroban SEP-41 transfer）。
// 払い手の秘密は環境変数 STELLAR_PAYER_SECRET（S...）。値はログ・誤り・記録に出さない。
//
// 対象の資産は Stellar の USDC だけ:
//   classic  USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
//   SAC      CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
// 402 の accept がこれ以外なら払わない。classic の accept も、クライアントへ渡す asset は SAC
// （`@x402/stellar` の validateStellarAssetAddress は C-account だけを受ける）。
//
// 台帳（x402_l1_purchases.spent_units）は USDC 6 桁。Stellar USDC は 7 桁なので、上限の比較と
// 記帳の換算は STELLAR_LEDGER_SCALE（10）で行う。7 桁目は切り上げ（支出を少なく数えない）。
//
// レーンそのものは OBSERVATORY_STELLAR_L1_ENABLED が正確に "true" のときだけ。既定 OFF。
// この module は金に署名する。形が完全に一致しない accept は予約より前に断る。
// ============================================================
import { Keypair } from "@stellar/stellar-sdk";
import { validateStellarDestinationAddress } from "@x402/stellar";
import { DAILY_BUDGET_USD } from "./budget";
import { MAX_PER_PURCHASE_UNITS, type ChallengeAccept } from "./x402-payer";

/** CAIP-2。選別は完全一致（`stellar` / `stellar:mainnet` / testnet は選ばない）。 */
export const STELLAR_PUBNET_CAIP2 = "stellar:pubnet";

/** Circle の Stellar USDC 発行者（classic）。 */
export const STELLAR_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
/** classic の asset 表記。 */
export const STELLAR_USDC_CLASSIC = `USDC:${STELLAR_USDC_ISSUER}`;
/** Soroban の USDC SAC（@x402/stellar 2.28.0 USDC_PUBNET_ADDRESS と同じ値）。 */
export const STELLAR_USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
/** Stellar USDC の小数桁。台帳は 6 桁。 */
export const STELLAR_USDC_DECIMALS = 7;
/** 7 桁 → 6 桁の倍率。 */
export const STELLAR_LEDGER_SCALE = 10n;

const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;

export function isStellarL1Enabled(): boolean {
  return process.env.OBSERVATORY_STELLAR_L1_ENABLED === "true";
}

/** 文字列から Stellar の S... 秘密を伏せる。URL の伏字は呼び手が redactUrls を通す。 */
export function redactStellarSecrets(text: string): string {
  return text.replace(STELLAR_SECRET_RE, "<stellar-secret>");
}

/**
 * STELLAR_PAYER_SECRET（`S…`）から公開アドレスを作る。読めなければ null
 * （fail-closed: 鍵が読めない状態で Stellar 候補は選ばれない）。秘密は決して返さない。
 */
export function loadStellarPayer(): { address: string } | null {
  const raw = process.env.STELLAR_PAYER_SECRET?.trim() ?? "";
  if (!raw) return null;
  try {
    const kp = Keypair.fromSecret(raw);
    return { address: kp.publicKey() };
  } catch {
    return null;
  }
}

export function isStellarUsdcAsset(asset: string): boolean {
  return asset === STELLAR_USDC_SAC || asset === STELLAR_USDC_CLASSIC;
}

/** 7 桁 → 6 桁。余りは切り上げ（1 stroop も 1 ledger unit。支出を少なく数えない）。 */
export function stellarUnitsToLedgerUnits(stellar: bigint): bigint {
  if (stellar <= 0n) return 0n;
  return (stellar + STELLAR_LEDGER_SCALE - 1n) / STELLAR_LEDGER_SCALE;
}

/** 6 桁 → 7 桁。 */
export function ledgerUnitsToStellarUnits(ledger: bigint): bigint {
  return ledger * STELLAR_LEDGER_SCALE;
}

function parseStellarUnits(amount: string): bigint | null {
  if (!/^\d+$/.test(amount)) return null;
  try {
    const v = BigInt(amount);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * 1 日の Stellar 別枠（USDC 6 桁）。既定 $0.5。壊れた値は既定へ倒し、共有 $25 で頭打ち。
 * 0 は 1 件も払わない。レーンを開けるスイッチではない（OBSERVATORY_STELLAR_L1_ENABLED）。
 */
export const STELLAR_DAILY_CAP_USD_DEFAULT = 0.5;

export function stellarDailyCapUnits(): bigint {
  const raw = process.env.L1_STELLAR_DAILY_CAP_USD;
  let usd = STELLAR_DAILY_CAP_USD_DEFAULT;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) usd = n;
  }
  usd = Math.min(usd, DAILY_BUDGET_USD);
  return BigInt(Math.round(usd * 1_000_000));
}

/** 当日の Stellar 支出（6 桁）に今回の額を足すと別枠を超えるか。超えるなら署名しない。 */
export function wouldExceedStellarDailyCap(spentLedgerUnits: bigint, requestLedgerUnits: bigint): boolean {
  return spentLedgerUnits + requestLedgerUnits > stellarDailyCapUnits();
}

export type StellarFundsSnapshot = {
  /** SAC の残高（7 桁）。読めなければ null。 */
  sacBalance: bigint | null;
  /** classic USDC の残高（7 桁）。読めなければ null。 */
  classicBalance: bigint | null;
  /** classic の trustline があるか。読めなければ null。 */
  hasClassicTrustline: boolean | null;
};

export type StellarFundsVerdict =
  | { ok: true; reason: null }
  | { ok: false; reason: "payer_unfunded" | "unreadable" };

/**
 * 払い手に今回の額の USDC があるか。SAC か classic のどちらかが足りれば通す。
 * どちらも読めなければ unreadable（呼び手は署名しない＝payer_unfunded）。
 * 読めて足りない／trustline が無ければ payer_unfunded。
 */
export function stellarFundsVerdict(snapshot: StellarFundsSnapshot, neededStellarUnits: bigint): StellarFundsVerdict {
  if (neededStellarUnits <= 0n) return { ok: false, reason: "payer_unfunded" };
  if (snapshot.sacBalance !== null && snapshot.sacBalance >= neededStellarUnits) return { ok: true, reason: null };
  if (
    snapshot.hasClassicTrustline === true &&
    snapshot.classicBalance !== null &&
    snapshot.classicBalance >= neededStellarUnits
  ) {
    return { ok: true, reason: null };
  }
  const sacKnown = snapshot.sacBalance !== null;
  const classicKnown = snapshot.hasClassicTrustline !== null && snapshot.classicBalance !== null;
  if (!sacKnown && !classicKnown) return { ok: false, reason: "unreadable" };
  return { ok: false, reason: "payer_unfunded" };
}

export type StellarAcceptSelection =
  | {
      accept: ChallengeAccept;
      reason: null;
      detail: null;
      amountUnits: bigint;
      stellarUnits: bigint;
      signingAsset: typeof STELLAR_USDC_SAC;
    }
  | {
      accept: null;
      reason: "no_eligible_accept" | "price_mismatch" | "payto_mismatch" | "over_cap";
      detail: "asset_unsupported" | "unbuildable" | null;
      amountUnits?: undefined;
      stellarUnits?: undefined;
      signingAsset?: undefined;
    };

function isStellarPubnet(a: ChallengeAccept): boolean {
  return a.network === STELLAR_PUBNET_CAIP2;
}

function isBuildableStellarAccept(a: ChallengeAccept): boolean {
  if (!validateStellarDestinationAddress(a.payTo)) return false;
  if (parseStellarUnits(a.amount) === null) return false;
  if (a.maxTimeoutSeconds !== undefined && !Number.isInteger(a.maxTimeoutSeconds)) return false;
  // 改造していない @x402/stellar の ExactStellarScheme は extra.areFeesSponsored === true を要求する。
  if (a.extra?.areFeesSponsored !== true) return false;
  return true;
}

type StellarRefusalDetail = "asset_unsupported" | "unbuildable" | null;

function stellarProtocolEligible(accepts: readonly unknown[]): { eligible: ChallengeAccept[]; detail: StellarRefusalDetail } {
  const onStellar = (accepts as ChallengeAccept[])
    .filter((a) => a && typeof a === "object")
    .filter((a) => a.scheme === "exact")
    .filter((a) => typeof a.asset === "string" && typeof a.payTo === "string" && typeof a.amount === "string")
    .filter((a) => isStellarPubnet(a));
  const usdc = onStellar.filter((a) => isStellarUsdcAsset(a.asset));
  const eligible = usdc.filter((a) => isBuildableStellarAccept(a));
  if (eligible.length > 0) return { eligible, detail: null };
  const detail: StellarRefusalDetail =
    usdc.length > 0 ? "unbuildable" : onStellar.length > 0 ? "asset_unsupported" : null;
  return { eligible: [], detail };
}

function declaredMatches(declaredAmount: string | null, stellarUnits: bigint, ledgerUnits: bigint): boolean {
  if (declaredAmount === null) return true;
  const parsed = parseStellarUnits(declaredAmount);
  if (parsed === null) return false;
  return parsed === stellarUnits || parsed === ledgerUnits;
}

/**
 * 拒否語彙は EVM / Solana / XRPL の selectAccept と同じ順序（payTo → 価格 → 上限）。
 * 旗が OFF なら accept があっても選ばない。
 */
export function selectStellarAccept(
  accepts: readonly unknown[],
  options: { declaredAmount: string | null; declaredPayTo: string | null },
): StellarAcceptSelection {
  if (!isStellarL1Enabled()) {
    return { accept: null, reason: "no_eligible_accept", detail: null };
  }
  const { eligible: protocolEligible, detail: refusalDetail } = stellarProtocolEligible(accepts);
  if (protocolEligible.length === 0) {
    return { accept: null, reason: "no_eligible_accept", detail: refusalDetail };
  }

  const declaredPayTo = options.declaredPayTo;
  const eligible =
    declaredPayTo === null ? protocolEligible : protocolEligible.filter((a) => a.payTo === declaredPayTo);
  if (eligible.length === 0) return { accept: null, reason: "payto_mismatch", detail: null };

  const maxStellarUnits = MAX_PER_PURCHASE_UNITS * STELLAR_LEDGER_SCALE;

  for (const accept of eligible) {
    const stellarUnits = parseStellarUnits(accept.amount)!;
    const amountUnits = stellarUnitsToLedgerUnits(stellarUnits);
    if (!declaredMatches(options.declaredAmount, stellarUnits, amountUnits)) continue;
    if (stellarUnits > maxStellarUnits) continue;
    return {
      accept,
      reason: null,
      detail: null,
      amountUnits,
      stellarUnits,
      signingAsset: STELLAR_USDC_SAC,
    };
  }

  const allOverCap = eligible.every((a) => parseStellarUnits(a.amount)! > maxStellarUnits);
  if (allOverCap) return { accept: null, reason: "over_cap", detail: null };
  if (options.declaredAmount !== null) {
    return { accept: null, reason: "price_mismatch", detail: null };
  }
  return { accept: null, reason: "no_eligible_accept", detail: null };
}

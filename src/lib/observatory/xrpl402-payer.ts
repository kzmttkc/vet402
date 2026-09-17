// ============================================================
// XRPL-402 payer（2026-09-17）——XRP Ledger mainnet（`xrpl:0`）上の x402 `exact` scheme。
//
// 正本: x402-foundation/x402 `typescript/packages/mechanisms/xrpl`（npm `@x402/xrpl` 2.26.0・
// 2026-09-17 取得）。クライアントは **署名済み Payment tx の blob** を payload `{ signedTxBlob }` に
// 載せ、v2 の PAYMENT-SIGNATURE 封筒で送る。ファシリテータ（売り手側・t54）が submit する。
// 手数料は我々（payer）が払う（`areFeesSponsored: false`）。
//
// カタログの実測（2026-09-17・x402_endpoints.raw_accepts）: `xrpl:0` の accept は RLUSD
// （40 桁 hex 通貨コード + Ripple の発行者）1,683・XRP 977・USDC IOU 23。受取先は 7 つだけ。
// 実物の 402（gridpulse.theaslangroupllc.com）:
//   {"scheme":"exact","network":"xrpl:0","asset":"524C555344000000000000000000000000000000",
//    "extra":{"issuer":"rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De","invoiceId":"9ACC…","sourceTag":804681468},
//    "payTo":"rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32","amount":"0.01","maxTimeoutSeconds":300}
// IOU の `amount` は **単位そのものの 10 進文字列**（"0.01" = 1 セント）、XRP は drops。
//
// v1 の運用前提: **RLUSD だけ払う。** 予算台帳（x402_l1_purchases.spent_units）は USD 6 桁の
// 整数で、RLUSD は 1 単位 = $1 なので同じ目盛りに落ちる。XRP は相場があり、USDC IOU は
// 発行者の実在を確かめていないので、どちらも署名しない（拒否理由を行に残す）。
//
// この層は純関数 + 薄い JSON-RPC。ネットワーク I/O（sequence・validated ledger・残高）は
// 呼び手（l1-runner）が **予約の前** に済ませ、署名は決定的（同じ入力 → 同じ blob → 同じ hash）。
// EVM の EIP-3009 nonce・Solana の memo に当たる「その tx はこの購入のもの」の材料は、
// **署名済み blob のハッシュ**——提出前に我々だけが知り、売り手には選べない。
//
// この module は金に署名する。形が完全に一致しない accept は予約より前に断る。
// ============================================================
import { createHash } from "node:crypto";
import { Wallet, hashes, isValidClassicAddress } from "xrpl";
import { XRPL_MAINNET_CAIP2 } from "./chains";
import { MAX_AUTHORIZATION_WINDOW_SECONDS, MAX_PER_PURCHASE_UNITS, type ChallengeAccept } from "./x402-payer";

export { XRPL_MAINNET_CAIP2 };

/** RLUSD の 40 桁 hex 通貨コード（"RLUSD" を右 0 詰め）。カタログ 1,683 accept がこの形。 */
export const RLUSD_CURRENCY_HEX = "524C555344000000000000000000000000000000";
/** Ripple の RLUSD 発行者（mainnet）。**固定**——壁の extra.issuer がこれと違えば署名しない。 */
export const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
/** 台帳の目盛り（USDC と同じ 6 桁）。 */
export const RLUSD_LEDGER_DECIMALS = 6;

/** 手数料（drops）。基本手数料 10 drops に余裕を持たせた既定値（`fee` が読めないときの値）。 */
export const XRPL_FEE_DROPS = "12";
/** ネットワークの open_ledger_fee を採用するときの上限（drops）。混雑時でも 0.001 XRP 以上は払わない（2026-09-17 レビュー #6）。 */
export const XRPL_FEE_CAP_DROPS = 1_000n;
/** アカウントの基本準備金と、オブジェクト（trust line 等）1 つあたりの追加準備金（drops・2026-09-17 実測）。 */
export const XRPL_RESERVE_BASE_DROPS = 1_000_000n;
export const XRPL_RESERVE_INC_DROPS = 200_000n;
/** ledger の close 間隔の見積もり（秒）。LastLedgerSequence の幅をこれで秒から引く。 */
export const XRPL_LEDGER_INTERVAL_SECONDS = 4;

/** 公開ノード。**運用者がローカルで打つ script だけ**がこれへ倒れる（署名器・照合器・索引は XRPL_RPC_URL 必須）。 */
export const XRPL_RPC_URL_DEFAULT = "https://s1.ripple.com:51234/";

export function isXrplL1Enabled(): boolean {
  return process.env.OBSERVATORY_XRPL_L1_ENABLED === "true";
}

/**
 * OBSERVATORY_XRPL_SEED（`s…` の family seed）から Wallet を作る。読めなければ null
 * （fail-closed: 鍵が読めない状態で XRPL 候補は選ばれない）。秘密は決して印字しない。
 */
export function loadXrplWallet(): Wallet | null {
  const raw = process.env.OBSERVATORY_XRPL_SEED?.trim() ?? "";
  if (!raw) return null;
  try {
    return Wallet.fromSeed(raw);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// 金額。RLUSD の 10 進文字列 ⇄ 台帳の 6 桁整数 units。
// ------------------------------------------------------------
const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * "0.01" → 10000n。6 桁より細かい値は **null**（台帳に正確に載らない額に署名しない）。
 * 0 以下・形が違う・指数表記も null。
 */
export function rlusdToUnits(value: string): bigint | null {
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > RLUSD_LEDGER_DECIMALS) return null;
  const units = BigInt(m[1]) * 10n ** BigInt(RLUSD_LEDGER_DECIMALS) + BigInt((frac + "0".repeat(RLUSD_LEDGER_DECIMALS)).slice(0, RLUSD_LEDGER_DECIMALS));
  return units > 0n ? units : null;
}

/** 残高用: 6 桁より細かい桁は切り捨てる（"1.2345678" → 1234567n）。負・不正は null。 */
export function rlusdToUnitsFloor(value: string): bigint | null {
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) return null;
  const frac = (m[2] ?? "") + "0".repeat(RLUSD_LEDGER_DECIMALS);
  return BigInt(m[1]) * 10n ** BigInt(RLUSD_LEDGER_DECIMALS) + BigInt(frac.slice(0, RLUSD_LEDGER_DECIMALS));
}

/** 10000n → "0.01"（末尾 0 と不要な小数点を落とした正規形。tx の value に使う）。 */
export function unitsToRlusdValue(units: bigint): string {
  const s = units.toString().padStart(RLUSD_LEDGER_DECIMALS + 1, "0");
  const whole = s.slice(0, -RLUSD_LEDGER_DECIMALS);
  const frac = s.slice(-RLUSD_LEDGER_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ------------------------------------------------------------
// accept の選別。
// ------------------------------------------------------------
export type XrplAcceptSelection =
  | { accept: ChallengeAccept; reason: null; detail: null; amountUnits: bigint }
  | {
      accept: null;
      reason: "no_eligible_accept" | "price_mismatch" | "payto_mismatch" | "over_cap";
      /**
       * no_eligible_accept の内訳（行の raw_response_meta に残す。公開語彙は増やさない）:
       *   asset_not_usd     XRPL の accept はあるが XRP 建てだけ（v1 は RLUSD のみ払う）
       *   asset_unsupported RLUSD でも XRP でもない IOU（USDC IOU 等）だけ
       *   issuer_mismatch   RLUSD だが発行者が固定値と違う
       *   unbuildable       payTo / invoiceId / sourceTag / 金額の形が tx に組めない
       */
      detail: "asset_not_usd" | "asset_unsupported" | "issuer_mismatch" | "unbuildable" | null;
    };

/**
 * network は **完全一致**（Solana と同じ・2026-09-17 レビュー #1）。`xrpl` / `XRPL` / `xrpl:mainnet` と名乗る壁は
 * 選ばない——寄せて選ぶと台帳に原文が書かれ、別枠の `LIKE 'xrpl:%'` を素通りし、照合が wrong_chain で止まる。
 * 表記の寄せ（toCaip2）は L0 の表示・索引の受取先集めにだけ使う。
 */
function isXrplNetwork(a: ChallengeAccept): boolean {
  return a.network === XRPL_MAINNET_CAIP2;
}

export function isRlusdAsset(asset: string): boolean {
  return asset.toUpperCase() === RLUSD_CURRENCY_HEX || asset === "RLUSD";
}

function issuerOf(a: ChallengeAccept): string | null {
  const v = a.extra?.issuer;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function invoiceIdOf(a: ChallengeAccept): string | null {
  const v = a.extra?.invoiceId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isUint32(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

/**
 * この accept で **実際に署名できる tx が組めるか**（Solana の isBuildableSolanaAccept と同じ役）。
 * 予算は署名の前に予約されるので、組めない形は予約より前にここで落とす。
 */
export function isBuildableXrplAccept(a: ChallengeAccept): boolean {
  if (!isValidClassicAddress(a.payTo)) return false;
  if (invoiceIdOf(a) === null) return false;
  if (!isUint32(a.extra?.sourceTag)) return false;
  const dt = a.extra?.destinationTag;
  if (dt !== undefined && !isUint32(dt)) return false;
  if (a.maxTimeoutSeconds !== undefined && !Number.isInteger(a.maxTimeoutSeconds)) return false;
  return rlusdToUnits(a.amount) !== null;
}

/**
 * 拒否語彙は EVM / Solana の selectAccept と同じ順序（payTo → 価格 → 上限）。
 * 通貨は RLUSD かつ発行者が固定値、network は xrpl:0、scheme は exact に限る。
 */
export function selectXrplAccept(
  accepts: readonly unknown[],
  options: { declaredAmount: string | null; declaredPayTo: string | null },
): XrplAcceptSelection {
  const onXrpl = (accepts as ChallengeAccept[])
    .filter((a) => a && typeof a === "object")
    .filter((a) => a.scheme === "exact")
    .filter((a) => typeof a.asset === "string" && typeof a.payTo === "string" && typeof a.amount === "string")
    .filter((a) => isXrplNetwork(a));
  const rlusd = onXrpl.filter((a) => isRlusdAsset(a.asset));
  const pinnedIssuer = rlusd.filter((a) => issuerOf(a) === RLUSD_ISSUER);
  const protocolEligible = pinnedIssuer.filter((a) => isBuildableXrplAccept(a));

  if (protocolEligible.length === 0) {
    const detail =
      pinnedIssuer.length > 0
        ? "unbuildable"
        : rlusd.length > 0
          ? "issuer_mismatch"
          : onXrpl.some((a) => a.asset.toUpperCase() === "XRP")
            ? "asset_not_usd"
            : onXrpl.length > 0
              ? "asset_unsupported"
              : null;
    return { accept: null, reason: "no_eligible_accept", detail };
  }

  // r アドレスは base58 で大文字小文字が同一性を担うが、L0 と同じく比較は大小を問わない
  // （カタログ側の保存形に依存しない）。tx の宛先には壁が言った原文を使う。
  const declaredPayTo = options.declaredPayTo === null ? null : options.declaredPayTo.toLowerCase();
  const eligible =
    declaredPayTo === null ? protocolEligible : protocolEligible.filter((a) => a.payTo.toLowerCase() === declaredPayTo);
  if (eligible.length === 0) return { accept: null, reason: "payto_mismatch", detail: null };

  // 価格はカタログの宣言と **units で** 比べる（"0.010" と "0.01" は同じ額）。宣言が読めなければ不一致。
  const declaredUnits = options.declaredAmount === null ? null : rlusdToUnits(options.declaredAmount);
  const priceMatches = (units: bigint) =>
    options.declaredAmount === null || (declaredUnits !== null && units === declaredUnits);

  for (const accept of eligible) {
    const units = rlusdToUnits(accept.amount)!;
    if (!priceMatches(units)) continue;
    if (units > MAX_PER_PURCHASE_UNITS) continue;
    return { accept, reason: null, detail: null, amountUnits: units };
  }

  const allOverCap = eligible.every((a) => rlusdToUnits(a.amount)! > MAX_PER_PURCHASE_UNITS);
  if (allOverCap) return { accept: null, reason: "over_cap", detail: null };
  if (options.declaredAmount !== null && eligible.some((a) => !priceMatches(rlusdToUnits(a.amount)!))) {
    return { accept: null, reason: "price_mismatch", detail: null };
  }
  return { accept: null, reason: "no_eligible_accept", detail: null };
}

// ------------------------------------------------------------
// tx の構築と署名（純関数・決定的）。
// ------------------------------------------------------------

/** 正本 `invoiceIdToInvoiceIdField`: invoiceId（UTF-8）の SHA-256 を大文字 hex で InvoiceID に載せる。 */
export function invoiceIdField(invoiceId: string): string {
  return createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();
}

/**
 * LastLedgerSequence の幅（ledger 数）。署名済み blob はこの ledger まで **生きた金** なので、
 * EVM の validBefore と同じ上限（MAX_AUTHORIZATION_WINDOW_SECONDS）で頭を打つ。
 */
export function lastLedgerOffset(maxTimeoutSeconds: number | undefined): number {
  const requested = Number.isInteger(maxTimeoutSeconds) ? (maxTimeoutSeconds as number) : MAX_AUTHORIZATION_WINDOW_SECONDS;
  const window = Math.min(Math.max(requested, 60), MAX_AUTHORIZATION_WINDOW_SECONDS);
  return Math.ceil(window / XRPL_LEDGER_INTERVAL_SECONDS) + 2;
}

export type XrplIouAmount = { currency: string; issuer: string; value: string };

export type XrplPaymentTx = {
  TransactionType: "Payment";
  Account: string;
  Destination: string;
  Amount: XrplIouAmount;
  SendMax: XrplIouAmount;
  Fee: string;
  Sequence: number;
  LastLedgerSequence: number;
  InvoiceID: string;
  SourceTag: number;
  DestinationTag?: number;
  Flags: number;
};

/**
 * 署名前の Payment。sequence と validated ledger は呼び手が RPC で取って渡す。
 * NetworkID は数値 id > 1024 のときだけ要る（xrpl:0 には付けない・正本と同じ）。
 */
export function buildXrplPayment(input: {
  account: string;
  accept: ChallengeAccept;
  sequence: number;
  validatedLedgerIndex: number;
  /** drops。省略時 XRPL_FEE_DROPS。呼び手は clampFeeDrops を通した値を渡す。 */
  feeDrops?: string;
}): XrplPaymentTx {
  const { account, accept, sequence, validatedLedgerIndex } = input;
  const feeDrops = input.feeDrops ?? XRPL_FEE_DROPS;
  if (!/^\d+$/.test(feeDrops) || BigInt(feeDrops) <= 0n || BigInt(feeDrops) > XRPL_FEE_CAP_DROPS) {
    throw new Error(`xrpl402: fee ${feeDrops} drops is outside (0, ${XRPL_FEE_CAP_DROPS}]`);
  }
  if (!isRlusdAsset(accept.asset) || issuerOf(accept) !== RLUSD_ISSUER) {
    throw new Error("xrpl402: accept is not RLUSD from the pinned issuer");
  }
  const invoiceId = invoiceIdOf(accept);
  if (invoiceId === null) throw new Error("xrpl402: accept has no extra.invoiceId");
  if (!isUint32(accept.extra?.sourceTag)) throw new Error("xrpl402: accept has no uint32 extra.sourceTag");
  const units = rlusdToUnits(accept.amount);
  if (units === null) throw new Error("xrpl402: amount is not a positive RLUSD decimal within 6 places");
  const amount: XrplIouAmount = { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: unitsToRlusdValue(units) };
  const destinationTag = accept.extra?.destinationTag;
  return {
    TransactionType: "Payment",
    Account: account,
    Destination: accept.payTo,
    Amount: amount,
    SendMax: { ...amount },
    Fee: feeDrops,
    Sequence: sequence,
    LastLedgerSequence: validatedLedgerIndex + lastLedgerOffset(accept.maxTimeoutSeconds),
    InvoiceID: invoiceIdField(invoiceId),
    SourceTag: accept.extra!.sourceTag as number,
    ...(isUint32(destinationTag) ? { DestinationTag: destinationTag } : {}),
    Flags: 0,
  };
}

/** 署名（オフライン）。hash は提出前に確定し、行の auth_nonce として照合の束縛に使う。 */
export function signXrplPayment(wallet: Wallet, tx: XrplPaymentTx): { signedTxBlob: string; hash: string } {
  const signed = wallet.sign(tx as unknown as Parameters<Wallet["sign"]>[0]);
  const hash = hashes.hashSignedTx(signed.tx_blob);
  if (hash !== signed.hash) throw new Error("xrpl402: signed blob hash does not match the signer's hash");
  return { signedTxBlob: signed.tx_blob, hash };
}

// ------------------------------------------------------------
// JSON-RPC（HTTPS）。websocket の Client は使わない（serverless で持ちにくい）。
// ------------------------------------------------------------
export type XrplRpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** XRPL_RPC_URL。未設定は throw（base/solana と同じく、公開 RPC へ無言で倒れない・2026-09-17 レビュー #2）。 */
export function xrplRpcUrl(): string {
  const url = process.env.XRPL_RPC_URL?.trim();
  if (!url) throw new Error("xrpl_rpc_unset: set XRPL_RPC_URL before enabling the XRPL lane");
  return url;
}

export function createXrplJsonRpc(options: { url?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): XrplRpc {
  const url = options.url ?? xrplRpcUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  return async (method, params) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: [params] }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`xrpl_rpc_http_${res.status}`);
      const body = (await res.json()) as { result?: Record<string, unknown> };
      const result = body?.result;
      if (!result || typeof result !== "object") throw new Error("xrpl_rpc_malformed: no result");
      if (result.status === "error") {
        throw new Error(`xrpl_rpc_error: ${String(result.error ?? "unknown")}`);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

function asNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`xrpl_rpc_malformed: ${what}`);
  return v;
}

/**
 * `fee` の open_ledger_fee（drops）を採用する手数料に直す。純関数。
 *   - 読めない・0 → 既定 12 drops（払いすぎない側）
 *   - 12 未満 → 12（基本手数料を下回る tx は載らない）
 *   - 12〜1,000 → その値
 *   - **1,000 超 → null**（網が混んでいる。既定 12 に倒すと載らない tx を署名し続けるので、そのバッチの XRPL は
 *     署名せず・行も書かず skip する——呼び手（l1-runner）の xrpl_fee_over_cap。2026-09-17 出荷前レビュー #1）
 */
export function clampFeeDrops(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return XRPL_FEE_DROPS;
  const v = BigInt(raw);
  if (v <= 0n) return XRPL_FEE_DROPS;
  if (v > XRPL_FEE_CAP_DROPS) return null;
  return v < BigInt(XRPL_FEE_DROPS) ? XRPL_FEE_DROPS : v.toString();
}

/** `fee` を 1 回読む。読めなければ既定 12 drops（throw しない）。上限超は null（署名しない）。 */
export async function getNetworkFeeDrops(rpc: XrplRpc): Promise<string | null> {
  try {
    const r = await rpc("fee", {});
    return clampFeeDrops((r.drops as { open_ledger_fee?: unknown } | undefined)?.open_ledger_fee);
  } catch {
    return XRPL_FEE_DROPS;
  }
}

/** account_info（validated）の Sequence。ticket は使わない（正本の "sequence" 方式）。 */
export async function getAccountSequence(address: string, rpc: XrplRpc): Promise<number> {
  const r = await rpc("account_info", { account: address, ledger_index: "validated" });
  const data = r.account_data as { Sequence?: unknown } | undefined;
  return asNumber(data?.Sequence, "account_data.Sequence");
}

export async function getValidatedLedgerIndex(rpc: XrplRpc): Promise<number> {
  const r = await rpc("ledger", { ledger_index: "validated" });
  return asNumber(r.ledger_index, "ledger_index");
}

/** account_lines を RLUSD 発行者に絞って読む。trust line が無ければ 0n。 */
export async function getRlusdBalanceUnits(address: string, rpc: XrplRpc): Promise<bigint> {
  const r = await rpc("account_lines", { account: address, peer: RLUSD_ISSUER, ledger_index: "validated" });
  const lines = Array.isArray(r.lines) ? (r.lines as { currency?: unknown; balance?: unknown }[]) : [];
  const line = lines.find((l) => typeof l.currency === "string" && isRlusdAsset(l.currency));
  if (!line) return 0n;
  if (typeof line.balance !== "string") throw new Error("xrpl_rpc_malformed: lines[].balance");
  const units = rlusdToUnitsFloor(line.balance);
  if (units === null) throw new Error(`xrpl_rpc_malformed: balance ${line.balance}`);
  return units;
}

/** XRP 残高から準備金（基本 + OwnerCount × 追加）を引いた、手数料に使える drops。負にもなる。 */
export async function getXrpSpendableDrops(address: string, rpc: XrplRpc): Promise<bigint> {
  const r = await rpc("account_info", { account: address, ledger_index: "validated" });
  const data = r.account_data as { Balance?: unknown; OwnerCount?: unknown } | undefined;
  if (typeof data?.Balance !== "string" || !/^\d+$/.test(data.Balance)) throw new Error("xrpl_rpc_malformed: account_data.Balance");
  const ownerCount = BigInt(asNumber(data.OwnerCount ?? 0, "account_data.OwnerCount"));
  return BigInt(data.Balance) - (XRPL_RESERVE_BASE_DROPS + XRPL_RESERVE_INC_DROPS * ownerCount);
}

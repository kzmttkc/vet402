// ============================================================
// Stellar の L1 決済照合（2026-10-18）。settlement-verify.ts の stellar 経路。
//
// XRPL（settlement-verify-xrpl.ts）と同じ厳しさを Stellar の形で要求する。
// 理由の語彙は既存の SettlementVerifyResult のまま（公開の settlement_verify_reason に
// 新しい値を足さない）。括弧内は発注の呼び方:
//   malformed_tx
//   tx_not_found            （not_found）
//   tx_reverted             （failed）
//   payer_mismatch          （wrong_payer）
//   payee_mismatch          （wrong_destination）
//   amount_mismatch         （wrong_amount / wrong_asset。detail の接頭辞で分ける）
//   no_matching_transfer    送金そのものが無い
//   rpc_unavailable         読めない（台帳の status は倒さない）
//   wrong_chain             pubnet 以外、または Horizon の passphrase が pubnet でない
//
// XRPL から変えたところ:
//   - 額は「以上」ではない。7 桁 stroops の完全一致。
//     expectedAmountUnits は他レーンと同じ台帳の 6 桁。チェーン上の額は
//     stroops === expectedAmountUnits * 10 のときだけ一致（1 stroop の過不足も不一致）。
//   - 手数料の sponsor が tx の source_account になる（@x402/stellar は areFeesSponsored を要求する）。
//     source_account は払い手と照合しない。送金の from / to を見る。
//   - auth_nonce と tx hash は結び付けない。sponsor が fee を足すと hash は署名時と変わる。
//   - 資産は classic USDC:GA5Z… か、その SAC（CCW67…）だけ。
//   - Horizon の URL は detail に残さない（STELLAR_HORIZON_URL は鍵入りの query を取りうる）。
//
// 応答の形は @stellar/stellar-sdk 16.3.1 の Horizon 型（horizon_api.d.ts /
// horizon/types/effects.d.ts の ContractCredited / ContractDebited）に合わせた。
// SDK の Server は使わない。NetworkError.response.url に接続先が載るため。
// ============================================================
import { Networks, type Horizon } from "@stellar/stellar-sdk";
import { redactUrls } from "./redact";
import type { SettlementVerifyResult } from "./settlement-verify";
import {
  STELLAR_LEDGER_SCALE,
  STELLAR_PUBNET_CAIP2,
  STELLAR_USDC_DECIMALS,
  STELLAR_USDC_ISSUER,
  STELLAR_USDC_SAC,
  redactStellarSecrets,
} from "./stellar402-payer";

/** SDK のフィールドが消えたらここでコンパイルが落ちる。実行はしない。 */
type _SdkAnchor = [
  Horizon.HorizonApi.PaymentOperationResponse["from"],
  Horizon.HorizonApi.PaymentOperationResponse["to"],
  Horizon.HorizonApi.PaymentOperationResponse["to_muxed"],
  Horizon.HorizonApi.PaymentOperationResponse["amount"],
  Horizon.HorizonApi.PaymentOperationResponse["asset_code"],
  Horizon.HorizonApi.PaymentOperationResponse["asset_issuer"],
  Horizon.HorizonApi.InvokeHostFunctionOperationResponse["asset_balance_changes"][number]["from"],
  Horizon.HorizonApi.InvokeHostFunctionOperationResponse["asset_balance_changes"][number]["to"],
  Horizon.HorizonApi.InvokeHostFunctionOperationResponse["asset_balance_changes"][number]["amount"],
  Horizon.HorizonApi.InvokeHostFunctionOperationResponse["asset_balance_changes"][number]["type"],
  Horizon.HorizonApi.InvokeHostFunctionOperationResponse["asset_balance_changes"][number]["asset_code"],
  Horizon.HorizonApi.InvokeHostFunctionOperationResponse["asset_balance_changes"][number]["asset_issuer"],
  Horizon.HorizonApi.TransactionResponse["successful"],
  Horizon.HorizonApi.TransactionResponse["ledger"],
  Horizon.HorizonApi.TransactionResponse["created_at"],
  Horizon.HorizonApi.TransactionResponse["hash"],
  Horizon.HorizonApi.TransactionResponse["id"],
  Horizon.HorizonApi.TransactionResponse["operation_count"],
  Horizon.HorizonApi.TransactionResponse["source_account"],
  Horizon.HorizonApi.RootResponse["network_passphrase"],
  Horizon.HorizonApi.AccountResponse["balances"],
  Horizon.HorizonApi.BalanceLineAsset["balance"],
  Horizon.HorizonApi.BalanceLineAsset["asset_code"],
  Horizon.HorizonApi.BalanceLineAsset["asset_issuer"],
  Horizon.HorizonApi.BalanceLineAsset["is_authorized"],
];
const _sdkAnchor: _SdkAnchor | null = null;
void _sdkAnchor;

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
const G_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
/** Horizon の 1 ページの上限。これで埋まったら続きがあるかもしれないので確定しない。 */
const PAGE_LIMIT = 200;
const HORIZON_TIMEOUT_MS = 5_000;

const detailOf = (text: string): string => redactStellarSecrets(redactUrls(text)).slice(0, 200);
const unavailable = (error: unknown): SettlementVerifyResult => ({
  ok: false,
  reason: "rpc_unavailable",
  detail: detailOf(error instanceof Error ? error.message : String(error)),
});

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Horizon の金額文字列（USDC は 7 桁）を stroops にする。
 * 8 桁以上・指数表記・符号つきは null（切り捨てない。完全一致の相手にしない）。
 */
export function stellarDecimalToStroops(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > STELLAR_USDC_DECIMALS) return null;
  const padded = (frac + "0".repeat(STELLAR_USDC_DECIMALS)).slice(0, STELLAR_USDC_DECIMALS);
  return BigInt(m[1]) * 10n ** BigInt(STELLAR_USDC_DECIMALS) + BigInt(padded);
}

/**
 * 残高用。7 桁 stroops を台帳の 6 桁へ切り捨てる（"1.2345678" → 1234567n）。
 * 切り上げ（stellarUnitsToLedgerUnits）とは逆。支出の見積もりを大きくしない。
 * 不正な文字列は null。
 */
export function stellarBalanceToLedgerUnits(balance: string): bigint | null {
  const stroops = stellarDecimalToStroops(balance);
  if (stroops === null) return null;
  return stroops / STELLAR_LEDGER_SCALE;
}

/** 台帳の 6 桁 → 照合に使う 7 桁 stroops。0 以下・整数でないものは null。 */
export function ledgerUnitsToExactStroops(amountUnits: string): bigint | null {
  if (!/^\d+$/.test(amountUnits)) return null;
  try {
    const units = BigInt(amountUnits);
    if (units <= 0n) return null;
    return units * STELLAR_LEDGER_SCALE;
  } catch {
    return null;
  }
}

function isClassicUsdc(code: unknown, issuer: unknown): boolean {
  return code === "USDC" && issuer === STELLAR_USDC_ISSUER;
}

export type StellarHorizonReader = {
  /** GET / 。passphrase が読めなければ throw。 */
  root(): Promise<unknown>;
  /** GET /transactions/:hash 。404 は null。それ以外の失敗は throw。 */
  transaction(hash: string): Promise<unknown | null>;
  /** GET /transactions/:hash/operations 。 */
  operations(hash: string): Promise<unknown>;
  /** GET /transactions/:hash/effects 。 */
  effects(hash: string): Promise<unknown>;
  /** GET /accounts/:id 。404 は null。 */
  account(id: string): Promise<unknown | null>;
};

function horizonBase(): { originAndPath: string; search: string } {
  const raw = process.env.STELLAR_HORIZON_URL?.trim() ?? "";
  if (!raw) throw new Error("stellar_horizon_unset: STELLAR_HORIZON_URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("stellar_horizon_unset: STELLAR_HORIZON_URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("stellar_horizon_unset: STELLAR_HORIZON_URL must be http(s)");
  }
  if (url.username || url.password) {
    throw new Error("stellar_horizon_unset: STELLAR_HORIZON_URL must not include credentials");
  }
  return { originAndPath: `${url.origin}${url.pathname.replace(/\/$/, "")}`, search: url.search.replace(/^\?/, "") };
}

/** path は `/transactions/...` または query 付き。接続先は戻り値に含まれるので、呼び出し側はこれを誤り文に入れない。 */
function horizonUrl(pathAndQuery: string): string {
  const base = horizonBase();
  const qIndex = pathAndQuery.indexOf("?");
  const path = qIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? "" : pathAndQuery.slice(qIndex + 1));
  for (const [k, v] of new URLSearchParams(base.search)) params.append(k, v);
  const qs = params.toString();
  return `${base.originAndPath}${path}${qs ? `?${qs}` : ""}`;
}

function cleanHorizonError(error: unknown): Error {
  const cause = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : "";
  const raw = error instanceof Error ? `${error.message}${cause}` : String(error);
  const cleaned = detailOf(raw);
  if (cleaned.startsWith("stellar_")) return new Error(cleaned);
  return new Error(`stellar_horizon_unreadable: ${cleaned}`);
}

async function horizonFetch(path: string): Promise<{ status: number; body: unknown | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HORIZON_TIMEOUT_MS);
  try {
    // URL はこの関数の外に出さない（誤り文・ログに載せない）。
    const res = await fetch(horizonUrl(path), {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    const text = await res.text();
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new Error("stellar_horizon_unreadable");
    if (!text) throw new Error("stellar_horizon_unreadable");
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new Error("stellar_horizon_unreadable");
    }
  } catch (error) {
    throw cleanHorizonError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function horizonGet(path: string): Promise<unknown> {
  const res = await horizonFetch(path);
  if (res.status === 404 || res.body === null) throw new Error("stellar_horizon_unreadable");
  return res.body;
}

async function horizonGetOptional(path: string): Promise<unknown | null> {
  const res = await horizonFetch(path);
  if (res.status === 404) return null;
  if (res.body === null) throw new Error("stellar_horizon_unreadable");
  return res.body;
}

function createStellarHorizonReader(): StellarHorizonReader {
  return {
    root: () => horizonGet("/"),
    transaction: (hash) => horizonGetOptional(`/transactions/${encodeURIComponent(hash)}`),
    operations: (hash) => horizonGet(`/transactions/${encodeURIComponent(hash)}/operations?limit=${PAGE_LIMIT}&order=asc`),
    effects: (hash) => horizonGet(`/transactions/${encodeURIComponent(hash)}/effects?limit=${PAGE_LIMIT}&order=asc`),
    account: (id) => horizonGetOptional(`/accounts/${encodeURIComponent(id)}`),
  };
}

type Move = {
  from: string;
  to: string;
  toMuxed: string | null;
  stroops: bigint;
  kind: "usdc" | "other";
  asset: string;
};

function assetLabel(code: unknown, issuer: unknown, contract: unknown): string {
  if (typeof contract === "string" && contract) return `contract:${contract}`;
  if (typeof code === "string" && typeof issuer === "string") return `${code}:${issuer}`;
  if (typeof code === "string") return code;
  return "unknown";
}

function readPage(raw: unknown): { records: unknown[]; full: boolean } | null {
  const embedded = asRec(asRec(raw)?._embedded);
  const records = embedded?.records;
  if (!Array.isArray(records)) return null;
  return { records, full: records.length >= PAGE_LIMIT };
}

type ParsedTx = {
  successful: boolean;
  ledger: number | null;
  createdAt: string | null;
  hash: string | null;
  operationCount: number | null;
};

function readTx(raw: unknown): ParsedTx | null {
  const r = asRec(raw);
  if (!r || typeof r.successful !== "boolean") return null;
  const hash = asString(r.hash) ?? asString(r.id);
  const ledger = typeof r.ledger === "number" && Number.isInteger(r.ledger) ? r.ledger : null;
  const operationCount = typeof r.operation_count === "number" && Number.isInteger(r.operation_count) ? r.operation_count : null;
  return {
    successful: r.successful,
    ledger,
    createdAt: asString(r.created_at),
    hash,
    operationCount,
  };
}

/**
 * 支払い系の operation と、SAC の contract_debited/credited の隣接ペアから送金を集める。
 * 額の global な組み合わせはしない（同じ額の別送金を 1 本に繋がない）。
 * 読めない支払いを見たら error（無視して settled にしない）。
 */
function collectStellarMoves(operations: unknown[], effects: unknown[]): { moves: Move[] } | { error: string } {
  const moves: Move[] = [];
  for (const raw of operations) {
    const op = asRec(raw);
    if (!op || typeof op.type !== "string") return { error: "operation unreadable" };
    if (op.type === "payment" || op.type === "path_payment_strict_receive" || op.type === "path_payment_strict_send") {
      const from = asString(op.from);
      const to = asString(op.to);
      const amount = asString(op.amount);
      if (!from || !to || !amount) return { error: "payment operation unreadable" };
      const stroops = stellarDecimalToStroops(amount);
      if (stroops === null) return { error: "payment amount unreadable" };
      const usdc = isClassicUsdc(op.asset_code, op.asset_issuer);
      moves.push({
        from,
        to,
        toMuxed: asString(op.to_muxed),
        stroops,
        kind: usdc ? "usdc" : "other",
        asset: assetLabel(op.asset_code, op.asset_issuer, null),
      });
      continue;
    }
    if (op.type === "invoke_host_function") {
      if (op.asset_balance_changes === undefined) continue;
      if (!Array.isArray(op.asset_balance_changes)) return { error: "asset_balance_changes unreadable" };
      for (const rawChange of op.asset_balance_changes) {
        const change = asRec(rawChange);
        if (!change) return { error: "asset_balance_changes unreadable" };
        // SDK の BalanceChange.type は string。live の値 "transfer" は【未確認】。effects 側でも SAC を見る。
        if (change.type !== "transfer") continue;
        const from = asString(change.from);
        const to = asString(change.to);
        const amount = asString(change.amount);
        if (!from || !to || !amount) return { error: "asset_balance_change unreadable" };
        const stroops = stellarDecimalToStroops(amount);
        if (stroops === null) return { error: "asset_balance_change amount unreadable" };
        const usdc = isClassicUsdc(change.asset_code, change.asset_issuer);
        moves.push({
          from,
          to,
          toMuxed: null,
          stroops,
          kind: usdc ? "usdc" : "other",
          asset: assetLabel(change.asset_code, change.asset_issuer, null),
        });
      }
    }
  }

  const effectMoves = pairContractEffects(effects);
  if ("error" in effectMoves) return effectMoves;
  moves.push(...effectMoves.moves);
  return { moves };
}

function pairContractEffects(effects: unknown[]): { moves: Move[] } | { error: string } {
  const moves: Move[] = [];
  let i = 0;
  while (i < effects.length) {
    const a = asRec(effects[i]);
    if (!a) return { error: "effect unreadable" };
    const typeA = asString(a.type);
    if (typeA !== "contract_debited" && typeA !== "contract_credited") {
      i += 1;
      continue;
    }
    const b = asRec(effects[i + 1]);
    const typeB = b ? asString(b.type) : null;
    const adjacent =
      b &&
      typeB &&
      typeA !== typeB &&
      (typeB === "contract_debited" || typeB === "contract_credited") &&
      asString(a.contract) !== null &&
      asString(a.contract) === asString(b.contract);
    if (!adjacent || !b) {
      const lone = contractMove(a, null);
      if ("error" in lone) return lone;
      if (lone.move) moves.push(lone.move);
      i += 1;
      continue;
    }
    const amountA = stellarDecimalToStroops(asString(a.amount) ?? "");
    const amountB = stellarDecimalToStroops(asString(b.amount) ?? "");
    if (amountA === null || amountB === null) return { error: "contract effect amount unreadable" };
    if (amountA !== amountB) {
      const lone = contractMove(a, null);
      if ("error" in lone) return lone;
      if (lone.move) moves.push(lone.move);
      i += 1;
      continue;
    }
    const debit = typeA === "contract_debited" ? a : b;
    const credit = typeA === "contract_credited" ? a : b;
    const paired = contractMove(debit, credit);
    if ("error" in paired) return paired;
    if (paired.move) moves.push(paired.move);
    i += 2;
  }
  return { moves };
}

function contractMove(debit: Rec, credit: Rec | null): { move: Move | null } | { error: string } {
  const contract = asString(debit.contract);
  const from = asString(debit.account);
  const amount = asString(debit.amount);
  if (!contract || !from || !amount) return { error: "contract effect unreadable" };
  const stroops = stellarDecimalToStroops(amount);
  if (stroops === null) return { error: "contract effect amount unreadable" };
  const to = credit ? asString(credit.account) : null;
  if (credit && !to) return { error: "contract effect unreadable" };
  const assetFieldsPresent = debit.asset_code !== undefined || debit.asset_issuer !== undefined;
  const assetOk = !assetFieldsPresent || isClassicUsdc(debit.asset_code, debit.asset_issuer);
  const official = contract === STELLAR_USDC_SAC && assetOk;
  if (!to) {
    // 片側だけでは「払い手から宛先へ届いた」とは言えない。資産の不一致としては残す。
    return {
      move: {
        from,
        to: "",
        toMuxed: null,
        stroops,
        kind: "other",
        asset: assetLabel(debit.asset_code, debit.asset_issuer, contract),
      },
    };
  }
  return {
    move: {
      from,
      to,
      toMuxed: null,
      stroops,
      kind: official ? "usdc" : "other",
      asset: assetLabel(debit.asset_code, debit.asset_issuer, contract),
    },
  };
}

function destMatches(move: Move, dest: string): boolean {
  return move.to === dest || (move.toMuxed !== null && move.toMuxed === dest);
}

function timestampOf(createdAt: string | null): Date | null {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  return Number.isFinite(d.getTime()) ? d : null;
}

function judgeMoves(
  moves: Move[],
  expected: { payer: string; dest: string; stroops: bigint; ledger: number; createdAt: string | null },
): SettlementVerifyResult {
  const exact = moves.some(
    (m) => m.kind === "usdc" && m.from === expected.payer && destMatches(m, expected.dest) && m.stroops === expected.stroops,
  );
  if (exact) {
    return {
      ok: true,
      blockTimestamp: timestampOf(expected.createdAt),
      confirmations: 1n,
      blockNumber: BigInt(expected.ledger),
    };
  }
  const usdc = moves.filter((m) => m.kind === "usdc");
  if (usdc.length === 0) {
    if (moves.length === 0) return { ok: false, reason: "no_matching_transfer", detail: "no payment or SAC transfer" };
    return { ok: false, reason: "amount_mismatch", detail: detailOf(`wrong_asset: ${moves[0]?.asset ?? "unknown"}`) };
  }
  const sameParties = usdc.filter((m) => m.from === expected.payer && destMatches(m, expected.dest));
  if (sameParties.length > 0) {
    const got = sameParties.map((m) => String(m.stroops)).join(",");
    return { ok: false, reason: "amount_mismatch", detail: detailOf(`wrong_amount: ${got} != ${expected.stroops}`) };
  }
  if (usdc.some((m) => m.from === expected.payer)) {
    const to = usdc.find((m) => m.from === expected.payer)?.to ?? "";
    return { ok: false, reason: "payee_mismatch", detail: detailOf(`wrong_destination: ${to}`) };
  }
  return { ok: false, reason: "payer_mismatch", detail: detailOf(`wrong_payer: ${usdc[0]?.from ?? ""}`) };
}

/**
 * 1 件の Stellar 決済主張を Horizon で確かめる。期待値は **我々が署名したときの値**
 * （払い手・宛先・台帳の 6 桁 amount_units）を渡すこと。
 */
export async function verifyStellarSettlement(
  input: {
    txHash: string;
    network: string;
    expectedPayTo: string;
    expectedPayer: string;
    expectedAmountUnits: string;
    /**
     * 使わない。XRPL は署名 blob の hash をここに載せるが、Stellar は facilitator が
     * fee を載せてから hash が決まるので、一致を要求すると本物が落ちる。
     */
    expectedAuthNonce?: string | null;
  },
  deps?: { horizon?: StellarHorizonReader },
): Promise<SettlementVerifyResult> {
  void input.expectedAuthNonce;
  const { txHash, network, expectedPayTo, expectedPayer, expectedAmountUnits } = input;

  if (!TX_HASH_RE.test(txHash.trim())) return { ok: false, reason: "malformed_tx" };
  const hash = txHash.trim().toLowerCase();
  if (network !== STELLAR_PUBNET_CAIP2) {
    return { ok: false, reason: "wrong_chain", detail: detailOf(`unusable network id: ${network}`) };
  }
  const expectedStroops = ledgerUnitsToExactStroops(expectedAmountUnits);
  if (expectedStroops === null) return { ok: false, reason: "amount_mismatch", detail: "unparseable expected amount" };

  let horizon: StellarHorizonReader;
  try {
    horizon = deps?.horizon ?? createStellarHorizonReader();
  } catch (error) {
    return unavailable(error);
  }

  let root: unknown;
  try {
    root = await horizon.root();
  } catch (error) {
    return unavailable(error);
  }
  const passphrase = asString(asRec(root)?.network_passphrase);
  if (!passphrase) return unavailable("horizon root has no network_passphrase");
  if (passphrase !== Networks.PUBLIC) {
    return { ok: false, reason: "wrong_chain", detail: "horizon network_passphrase is not pubnet" };
  }

  let txRaw: unknown | null;
  try {
    txRaw = await horizon.transaction(hash);
  } catch (error) {
    return unavailable(error);
  }
  if (txRaw === null) return { ok: false, reason: "tx_not_found" };
  const tx = readTx(txRaw);
  if (!tx || !tx.hash) return unavailable("transaction response unreadable");
  if (tx.hash.toLowerCase() !== hash) return unavailable("transaction hash does not match the request");
  if (!tx.successful) return { ok: false, reason: "tx_reverted", detail: "transaction successful is false" };
  if (tx.ledger === null || tx.ledger <= 0 || tx.operationCount === null || tx.operationCount < 0) {
    return unavailable("transaction response unreadable");
  }

  let opsRaw: unknown;
  let effectsRaw: unknown;
  try {
    [opsRaw, effectsRaw] = await Promise.all([horizon.operations(hash), horizon.effects(hash)]);
  } catch (error) {
    return unavailable(error);
  }
  const ops = readPage(opsRaw);
  const effects = readPage(effectsRaw);
  if (!ops || !effects) return unavailable("operations or effects unreadable");
  if (ops.full || effects.full) return unavailable("horizon page truncated");
  if (ops.records.length !== tx.operationCount) return unavailable("operation_count does not match the page");

  const collected = collectStellarMoves(ops.records, effects.records);
  if ("error" in collected) return unavailable(collected.error);
  return judgeMoves(collected.moves, {
    payer: expectedPayer,
    dest: expectedPayTo,
    stroops: expectedStroops,
    ledger: tx.ledger,
    createdAt: tx.createdAt,
  });
}

function isUsdcTrustline(raw: unknown): { balance: string; authorized: boolean } | null {
  const line = asRec(raw);
  if (!line) return null;
  if (!isClassicUsdc(line.asset_code, line.asset_issuer)) return null;
  const balance = asString(line.balance);
  if (!balance) return null;
  return { balance, authorized: line.is_authorized === true };
}

/**
 * 払い手の classic USDC 残高を台帳の 6 桁で返す（7 桁は切り捨て）。
 * trustline が無い、未承認、読めない、Horizon の URL が無い、は throw（署名しない側）。
 * 残高 0 で trustline があるときは 0n（throw しない。関門は insufficient になる）。
 */
export async function readStellarUsdcLedgerUnits(owner: string, deps?: { horizon?: StellarHorizonReader }): Promise<bigint> {
  if (!G_ACCOUNT_RE.test(owner)) throw new Error("stellar_payer_address_malformed");
  let horizon: StellarHorizonReader;
  try {
    horizon = deps?.horizon ?? createStellarHorizonReader();
  } catch (error) {
    throw cleanHorizonError(error);
  }
  let raw: unknown | null;
  try {
    raw = await horizon.account(owner);
  } catch (error) {
    throw cleanHorizonError(error);
  }
  if (raw === null) throw new Error("stellar_usdc_trustline_missing");
  const balances = asRec(raw)?.balances;
  if (!Array.isArray(balances)) throw new Error("stellar_horizon_unreadable");
  const lines = balances.map(isUsdcTrustline).filter((x): x is { balance: string; authorized: boolean } => x !== null);
  if (lines.length === 0) throw new Error("stellar_usdc_trustline_missing");
  if (lines.length > 1) throw new Error("stellar_horizon_unreadable");
  const line = lines[0]!;
  if (!line.authorized) throw new Error("stellar_usdc_trustline_unauthorized");
  const units = stellarBalanceToLedgerUnits(line.balance);
  if (units === null) throw new Error("stellar_horizon_unreadable");
  return units;
}

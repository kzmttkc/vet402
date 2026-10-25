// Circle Gateway charge check for Arc purchase rows.
// A signed row stays unverified until a nonce lookup names a batch transaction
// and that transaction's debit for the buyer matches the sum of our rows in the batch.
// The batch tx is stored on raw_response_meta.circleGateway.batchTx, not tx_hash.
// This module never deposits, withdraws, or broadcasts.

import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  verifyTypedData,
  type Hex,
} from "viem";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { createDeadline, type Deadline } from "@/lib/util/deadline";
import { updateWithCorrection } from "./corrections";
import { ARC_USDC } from "./x402-payer";
import {
  ARC_GATEWAY_API,
  ARC_GATEWAY_DOMAIN_NAME,
  ARC_GATEWAY_DOMAIN_VERSION,
  ARC_GATEWAY_WALLET,
  GATEWAY_FETCH_TIMEOUT_MS,
  GATEWAY_NOT_CHARGED_EXPIRED,
  GATEWAY_NOT_CHARGED_GRACE_SECONDS,
} from "./arc-gateway";

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const SUBMIT_BATCH_ABI = parseAbi(["function submitBatch(bytes calldataBytes, bytes signature)"]);
const BATCH_PARAMS = parseAbiParameters("(address depositor, int256 value)[], bytes32, uint32, address, address");
const INSUFFICIENT_PARAMS = parseAbiParameters("uint256 value, uint256 available, uint256 withdrawing");
const INSUFFICIENT_TOPIC = keccak256(toBytes("InsufficientBalance(address,address,uint256,uint256,uint256)"));

export type GatewayAuth = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
  verifyingContract: string;
};

export type GatewayNonceHit =
  | { kind: "absent" }
  | { kind: "pending"; status: string }
  | { kind: "failed"; status: string }
  | { kind: "charged"; status: string; txHash: string; from: string | null; amount: string | null }
  | { kind: "incomplete" };

type TransferView = {
  nonce: string | null;
  status: string | null;
  txHash: string | null;
  from: string | null;
  amount: string | null;
};

export type TxLog = { address: string; topics: readonly string[]; data: string };

export type GatewayDebitRead = { kind: "amount"; debit: bigint } | { kind: "use_balance" } | { kind: "defer" };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export function readGatewayAuth(meta: unknown): GatewayAuth | null {
  const rec = asRecord(meta);
  if (!rec) return null;
  const from = str(rec.from);
  const to = str(rec.to);
  const value = str(rec.value);
  const validAfter = str(rec.validAfter);
  const validBefore = str(rec.validBefore);
  const nonce = str(rec.nonce);
  const signature = str(rec.signature);
  const verifyingContract = str(rec.verifyingContract);
  if (!from || !to || !value || !validAfter || !validBefore || !nonce || !signature || !verifyingContract) return null;
  if (!/^[0-9]+$/.test(value) || !/^[0-9]+$/.test(validAfter) || !/^[0-9]+$/.test(validBefore)) return null;
  return { from, to, value, validAfter, validBefore, nonce, signature, verifyingContract };
}

function transferView(raw: unknown): TransferView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const tx = str(rec.txHash) ?? str(rec.transactionHash);
  const from = str(rec.from) ?? str(rec.fromAddress);
  return {
    nonce: str(rec.nonce),
    status: str(rec.status),
    txHash: tx,
    from,
    amount: str(rec.amount),
  };
}

function pageIncomplete(body: Record<string, unknown>, transfers: unknown[]): boolean {
  const page = asRecord(body.pagination);
  const next = page ? str(page.next) ?? str(page.pageAfter) : null;
  return (next !== null && next !== "") || transfers.length >= 100;
}

/** Nonce lookup. No matching transfer is absent. A full page without the nonce is incomplete, not absent. */
export function interpretGatewayTransfers(body: unknown, nonce: string): GatewayNonceHit {
  const rec = asRecord(body);
  if (!rec || !Array.isArray(rec.transfers)) return { kind: "incomplete" };
  const want = nonce.toLowerCase();
  const hit = rec.transfers.map(transferView).find((t) => t?.nonce?.toLowerCase() === want) ?? null;
  if (!hit && pageIncomplete(rec, rec.transfers)) return { kind: "incomplete" };
  if (!hit) return { kind: "absent" };
  const status = hit.status ?? "";
  if ((status === "confirmed" || status === "completed") && hit.txHash) {
    return { kind: "charged", status, txHash: hit.txHash, from: hit.from, amount: hit.amount };
  }
  if (status === "failed") return { kind: "failed", status };
  return { kind: "pending", status };
}

/**
 * Settle only when the debit equals the sum of the vet402 rows in that batch.
 * A smaller debit refutes: the batch names a charge the wallet did not take.
 * A larger debit defers: other movement may be mixed in.
 * An unread debit defers. An unread authorization signed early enough for this batch, or a blocked buyer, stops settle only.
 * The buyer's full transfer history is not an input.
 */
export function judgeGatewayBatch(input: { rowSum: bigint; debit: bigint | null; unresolved?: boolean }): "settle" | "refute" | "defer" {
  if (input.debit === null) return "defer";
  if (input.debit < input.rowSum) return "refute";
  if (input.debit > input.rowSum) return "defer";
  if (input.unresolved) return "defer";
  if (input.debit === input.rowSum) return "settle";
  return "refute";
}

function addressTopic(addr: string): string {
  return `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/** Sum of USDC actually taken from this buyer, from InsufficientBalance logs. Null when no such log. */
function insufficientTaken(logs: readonly TxLog[], buyer: string): bigint | null | "unreadable" {
  const who = addressTopic(buyer);
  const token = addressTopic(ARC_USDC);
  let sum = 0n;
  let saw = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) continue;
    if ((log.topics[0] ?? "").toLowerCase() !== INSUFFICIENT_TOPIC.toLowerCase()) continue;
    if ((log.topics[1] ?? "").toLowerCase() !== token) continue;
    if ((log.topics[2] ?? "").toLowerCase() !== who) continue;
    saw = true;
    try {
      const decoded = decodeAbiParameters(INSUFFICIENT_PARAMS, log.data as Hex);
      const available = decoded[1];
      const withdrawing = decoded[2];
      if (typeof available !== "bigint" || typeof withdrawing !== "bigint") return "unreadable";
      sum += available + withdrawing;
    } catch {
      return "unreadable";
    }
  }
  return saw ? sum : null;
}

type DecodeDebit = { kind: "amount"; debit: bigint } | { kind: "defer" } | { kind: "undecoded" };

function tryDecodeBuyerDebit(calldata: string | null, logs: readonly TxLog[], buyer: string): DecodeDebit {
  if (!calldata || !calldata.startsWith("0x") || calldata.length < 10) return { kind: "undecoded" };
  let inner: unknown;
  try {
    const decoded = decodeFunctionData({ abi: SUBMIT_BATCH_ABI, data: calldata as Hex });
    if (decoded.functionName !== "submitBatch") return { kind: "undecoded" };
    inner = decoded.args[0];
  } catch {
    return { kind: "undecoded" };
  }
  if (typeof inner !== "string") return { kind: "undecoded" };
  let deltas: readonly { depositor: string; value: bigint }[];
  let token = "";
  let wallet = "";
  try {
    const params = decodeAbiParameters(BATCH_PARAMS, inner as Hex);
    deltas = params[0] as readonly { depositor: string; value: bigint }[];
    token = String(params[3]);
    wallet = String(params[4]);
  } catch {
    return { kind: "undecoded" };
  }
  if (token.toLowerCase() !== ARC_USDC.toLowerCase()) return { kind: "defer" };
  if (wallet.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return { kind: "defer" };
  const taken = insufficientTaken(logs, buyer);
  if (taken === "unreadable") return { kind: "defer" };
  if (taken !== null) return { kind: "amount", debit: taken };
  const who = buyer.toLowerCase();
  let requested = 0n;
  let saw = false;
  for (const delta of deltas) {
    if (delta.depositor.toLowerCase() !== who || delta.value >= 0n) continue;
    saw = true;
    requested += -delta.value;
  }
  if (!saw) return { kind: "defer" };
  return { kind: "amount", debit: requested };
}

/**
 * Debit of this buyer inside one GatewayWallet transaction.
 * A decoded submitBatch amount stands on its own. Other movement in the block does not change it.
 * When the calldata cannot be decoded, a balance delta is usable only if nothing else in the block
 * touched this buyer. Otherwise defer.
 */
export function gatewayBuyerDebit(input: {
  status: string;
  to: string | null;
  calldata: string | null;
  logs: readonly TxLog[];
  buyer: string;
  otherBuyerMovement: boolean;
}): GatewayDebitRead {
  if (input.status !== "success") return { kind: "defer" };
  if (!input.to || input.to.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return { kind: "defer" };
  const decoded = tryDecodeBuyerDebit(input.calldata, input.logs, input.buyer);
  if (decoded.kind === "amount") return decoded;
  if (decoded.kind === "defer") return { kind: "defer" };
  if (input.otherBuyerMovement) return { kind: "defer" };
  return { kind: "use_balance" };
}

/** Turn a debit read into the number judgeGatewayBatch compares. A rising balance is not a debit. */
export function resolveGatewayDebit(read: GatewayDebitRead, balanceDelta: bigint | null): bigint | null {
  if (read.kind === "amount") return read.debit;
  if (read.kind === "use_balance" && balanceDelta !== null && balanceDelta >= 0n) return balanceDelta;
  return null;
}

/** EIP-712 recover against the pinned GatewayWalletBatched domain. False on any mismatch. */
export async function gatewayAuthorizationRecovers(auth: GatewayAuth, expectedFrom: string): Promise<boolean> {
  try {
    if (auth.verifyingContract.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return false;
    if (auth.from.toLowerCase() !== expectedFrom.toLowerCase()) return false;
    return await verifyTypedData({
      address: getAddress(expectedFrom),
      domain: {
        name: ARC_GATEWAY_DOMAIN_NAME,
        version: ARC_GATEWAY_DOMAIN_VERSION,
        chainId: 5042,
        verifyingContract: getAddress(ARC_GATEWAY_WALLET),
      },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(auth.from),
        to: getAddress(auth.to),
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      },
      signature: auth.signature as Hex,
    });
  } catch {
    return false;
  }
}

export type GatewayClaimRow = {
  id: string;
  status: string;
  payer: string | null;
  circleGateway: unknown;
  /** Already settled sibling. Counted in the batch sum, not written again. */
  settled?: boolean;
};

export type GatewayPlan =
  | { id: string; action: "settle"; batchTx: string; gatewayStatus: string }
  | { id: string; action: "refute"; reason: "gateway_debit_mismatch" }
  | { id: string; action: "expire"; reason: typeof GATEWAY_NOT_CHARGED_EXPIRED }
  | { id: string; action: "note"; reason: "gateway_signature_invalid" }
  | { id: string; action: "defer"; reason: string };

type Lookup = { ok: true; body: unknown } | { ok: false; reason?: "budget" | "error" };

function valueOf(auth: GatewayAuth | null): bigint | null {
  if (!auth || !/^[0-9]+$/.test(auth.value)) return null;
  try {
    const v = BigInt(auth.value);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function pastGrace(auth: GatewayAuth, nowSec: number): boolean {
  const before = Number(auth.validBefore);
  return Number.isFinite(before) && before + GATEWAY_NOT_CHARGED_GRACE_SECONDS < nowSec;
}

/**
 * Pure plan. Absent and failed stay deferred until validBefore plus the grace, then they expire.
 * Pending stays deferred, including after that grace. Expiry is not a refutation.
 * A debit below the sum of the vet402 rows refutes. A larger debit defers.
 * A bad signature is a note, not a seller finding.
 * An unread authorization stops settle only when its signature time can still sit in this batch.
 * A buyer whose lookup failed stops settle. A spent read budget stops this pass and does not block the buyer.
 */
export async function planGatewayReconcile(input: {
  rows: GatewayClaimRow[];
  nowSec?: number;
  lookupNonce: (nonce: string) => Promise<Lookup>;
  readDebit: (txHash: string, buyer: string) => Promise<bigint | null>;
  /** Block timestamp of the batch tx, in seconds. Null blocks any unread authorization. */
  readBatchTime?: (txHash: string) => Promise<bigint | null>;
  loadBatch?: (
    txHash: string,
    buyer: string,
  ) => Promise<{
    rows: GatewayClaimRow[];
    unresolved: number;
    /** Set by the DB loader. Earliest unread validAfter, plus rows whose validAfter cannot be read. */
    unread?: { earliestValidAfter: string | null; unreadable: number };
  }>;
  rememberLookup?: (id: string, lookup: string, batchTx: string | null) => Promise<void>;
  verifySignature?: (auth: GatewayAuth, payer: string) => Promise<boolean>;
}): Promise<GatewayPlan[]> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const verify = input.verifySignature ?? gatewayAuthorizationRecovers;
  const plans = new Map<string, GatewayPlan>();
  type Member = { row: GatewayClaimRow; auth: GatewayAuth; value: bigint; gatewayStatus: string };
  const groups = new Map<string, Member[]>();
  const buyersBlocked = new Set<string>();

  const remember = async (id: string, buyer: string, lookup: string, batchTx: string | null) => {
    try {
      await input.rememberLookup?.(id, lookup, batchTx);
    } catch {
      buyersBlocked.add(buyer);
    }
  };

  for (const row of input.rows) {
    if (row.settled) continue;
    const auth = readGatewayAuth(row.circleGateway);
    const payer = row.payer ?? auth?.from ?? "";
    if (!auth || !payer) {
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_auth_unreadable" });
      continue;
    }
    const buyer = auth.from.toLowerCase();
    const meta = asRecord(row.circleGateway);
    if (meta?.note === "gateway_signature_invalid") {
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_signature_invalid" });
      continue;
    }
    let signed = false;
    try {
      signed = await verify(auth, payer);
    } catch {
      signed = false;
    }
    if (!signed) {
      await remember(row.id, buyer, "unsigned", null);
      plans.set(row.id, { id: row.id, action: "note", reason: "gateway_signature_invalid" });
      continue;
    }
    let lookup: Lookup;
    try {
      lookup = await input.lookupNonce(auth.nonce);
    } catch {
      lookup = { ok: false };
    }
    if (!lookup.ok) {
      if (lookup.reason === "budget") break;
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_api_error" });
      buyersBlocked.add(buyer);
      continue;
    }
    const hit = interpretGatewayTransfers(lookup.body, auth.nonce);
    if (hit.kind === "incomplete") {
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_incomplete" });
      buyersBlocked.add(buyer);
      continue;
    }
    if (hit.kind === "absent" || hit.kind === "failed" || hit.kind === "pending") {
      await remember(row.id, buyer, hit.kind, null);
      const expires = hit.kind !== "pending" && pastGrace(auth, nowSec);
      if (hit.kind === "pending" && pastGrace(auth, nowSec)) {
        logServerErrorSafe("arc-gateway-verify.pending", `row ${row.id} still pending after validBefore plus grace`);
      }
      if (expires) {
        plans.set(row.id, { id: row.id, action: "expire", reason: GATEWAY_NOT_CHARGED_EXPIRED });
      } else {
        const reason = hit.kind === "absent" ? "gateway_not_charged" : `gateway_${hit.kind}`;
        plans.set(row.id, { id: row.id, action: "defer", reason });
      }
      continue;
    }
    const value = valueOf(auth);
    if (value === null) {
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_value_unreadable" });
      continue;
    }
    await remember(row.id, buyer, "charged", hit.txHash);
    const key = `${hit.txHash.toLowerCase()}|${buyer}`;
    const list = groups.get(key) ?? [];
    list.push({ row, auth, value, gatewayStatus: hit.status });
    groups.set(key, list);
  }

  for (const [key, members] of groups) {
    const split = key.indexOf("|");
    const batchTx = key.slice(0, split);
    const buyer = key.slice(split + 1);
    let loaded: {
      rows: GatewayClaimRow[];
      unresolved: number;
      unread?: { earliestValidAfter: string | null; unreadable: number };
    } = { rows: [], unresolved: 0 };
    try {
      loaded = (await input.loadBatch?.(batchTx, buyer)) ?? loaded;
    } catch {
      for (const m of members) plans.set(m.row.id, { id: m.row.id, action: "defer", reason: "gateway_batch_unreadable" });
      continue;
    }
    if (loaded.unread) {
      const hasUnread = loaded.unread.unreadable > 0 || loaded.unread.earliestValidAfter !== null;
      let unresolvedCount = 0;
      if (hasUnread) {
        let blockTime: bigint | null = null;
        try {
          blockTime = (await input.readBatchTime?.(batchTx)) ?? null;
        } catch {
          blockTime = null;
        }
        const signatureTime = loaded.unread.unreadable > 0 ? null : gatewaySignatureTimeSec(loaded.unread.earliestValidAfter);
        unresolvedCount = unreadAuthorizationCanEnterBatch(signatureTime, blockTime) ? 1 : 0;
      }
      loaded = { ...loaded, unresolved: unresolvedCount };
    }
    const seen = new Set(members.map((m) => m.row.id));
    let rowSum = 0n;
    let broken = false;
    for (const m of members) rowSum += m.value;
    for (const sibling of loaded.rows) {
      if (seen.has(sibling.id)) continue;
      const auth = readGatewayAuth(sibling.circleGateway);
      const value = valueOf(auth);
      if (value === null) {
        broken = true;
        break;
      }
      rowSum += value;
    }
    if (broken) {
      for (const m of members) plans.set(m.row.id, { id: m.row.id, action: "defer", reason: "gateway_row_sum_incomplete" });
      continue;
    }
    let debit: bigint | null = null;
    try {
      debit = await input.readDebit(batchTx, buyer);
    } catch {
      debit = null;
    }
    const unresolved = loaded.unresolved > 0 || buyersBlocked.has(buyer);
    const verdict = judgeGatewayBatch({ rowSum, debit, unresolved });
    const gatewayStatus = members[0]?.gatewayStatus ?? "confirmed";
    let deferReason = "gateway_debit_deferred";
    if (debit !== null && debit > rowSum) {
      deferReason = "gateway_debit_exceeds_rows";
      logServerErrorSafe("arc-gateway-verify.debit_exceeds_rows", `batch ${batchTx} buyer ${buyer} debit ${debit} rows ${rowSum}`);
    } else if (unresolved) {
      deferReason = "gateway_batch_unresolved";
    }
    for (const m of members) {
      if (verdict === "settle") plans.set(m.row.id, { id: m.row.id, action: "settle", batchTx, gatewayStatus });
      else if (verdict === "refute") plans.set(m.row.id, { id: m.row.id, action: "refute", reason: "gateway_debit_mismatch" });
      else plans.set(m.row.id, { id: m.row.id, action: "defer", reason: deferReason });
    }
  }

  return [...plans.values()];
}

type Executor = NonNullable<ReturnType<typeof getDb>>;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const rows = (raw as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** SQL count. A missing or odd value blocks, so a bad read does not settle early. */
function countSql(v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
  return 1;
}

/** Integer text from a numeric aggregate. A trailing .0 is still that integer. */
function numericText(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (/^[0-9]+$/.test(trimmed)) return trimmed;
  if (/^[0-9]+\.0+$/.test(trimmed)) return trimmed.slice(0, trimmed.indexOf("."));
  return null;
}

async function gatewayFetch(url: string, fetchImpl: typeof fetch, fetchTimeoutMs: number, deadline?: Deadline): Promise<Lookup> {
  if (deadline?.expired()) return { ok: false, reason: "budget" };
  const budget = deadline ? deadline.budgetFor(fetchTimeoutMs) : fetchTimeoutMs;
  if (budget <= 0) return { ok: false, reason: "budget" };
  const signal = AbortSignal.timeout(budget);
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) return { ok: false, reason: "error" };
    return { ok: true, body: await res.json() };
  } catch (error) {
    logServerErrorSafe("arc-gateway-verify.fetch", error);
    if (deadline?.expired()) return { ok: false, reason: "budget" };
    return { ok: false, reason: "error" };
  }
}

/**
 * BatchEvmScheme stores validAfter as the signature second minus 600.
 * circleGateway has no separate signed-at column. Signature time is validAfter plus this lead.
 */
export const GATEWAY_VALID_AFTER_LEAD_SECONDS = 600;
/**
 * Signer clock versus the batch block timestamp, after the 600 second lead is added back.
 * The native authorization uses the same 60 seconds (validAfter = now minus 60).
 * An unread signature later than the block time minus this margin cannot be inside that batch.
 */
export const GATEWAY_BATCH_CLOCK_SKEW_SECONDS = 60;

/** Signature second for a stored validAfter. Null when the field is not a base-10 integer. */
export function gatewaySignatureTimeSec(validAfter: string | null): bigint | null {
  if (validAfter === null || !/^[0-9]+$/.test(validAfter)) return null;
  return BigInt(validAfter) + BigInt(GATEWAY_VALID_AFTER_LEAD_SECONDS);
}

/**
 * True when this unread authorization can still sit in the batch mined at blockTimeSec.
 * A missing clock blocks. A signature later than blockTimeSec minus the skew margin does not.
 */
export function unreadAuthorizationCanEnterBatch(signatureTimeSec: bigint | null, blockTimeSec: bigint | null): boolean {
  if (signatureTimeSec === null || blockTimeSec === null) return true;
  return signatureTimeSec <= blockTimeSec - BigInt(GATEWAY_BATCH_CLOCK_SKEW_SECONDS);
}

/** Read budget for one Gateway pass. Writes of judged rows sit outside this clock. */
export const GATEWAY_RECONCILE_BUDGET_MS = 75_000;
/** Kept for those writes so a spent read budget does not discard a finished group. Chain reads of groups already looked up use the same reserve, starting when the first of those reads runs. */
export const GATEWAY_WRITE_RESERVE_MS = 15_000;
const NATIVE_VERIFY_FLOOR_MS = 8_000;

/**
 * How long this pass may spend reading Gateway.
 * The verify cron's 240s budget, inside maxDuration 300s, gets the 75s read budget.
 * A shorter outer budget keeps the native 8s floor so a hung Gateway call still leaves native work.
 */
export function gatewayReadBudgetMs(outerRemainingMs: number): number {
  if (!Number.isFinite(outerRemainingMs)) return GATEWAY_RECONCILE_BUDGET_MS;
  const room = outerRemainingMs - GATEWAY_WRITE_RESERVE_MS - NATIVE_VERIFY_FLOOR_MS;
  if (room >= GATEWAY_RECONCILE_BUDGET_MS) return GATEWAY_RECONCILE_BUDGET_MS;
  if (room > 0) return room;
  return Math.max(0, Math.min(GATEWAY_FETCH_TIMEOUT_MS, outerRemainingMs - NATIVE_VERIFY_FLOOR_MS));
}

export type GatewayReconcileSummary = {
  settled: number;
  refuted: number;
  deferred: number;
  noted: number;
  expired: number;
  overDebit: number;
};

/** Load Gateway rows and apply the plan. A throw here must not fail the native verifier. */
export async function reconcileArcGatewayClaims(options?: {
  db?: Executor | null;
  fetchImpl?: typeof fetch;
  readDebit?: (txHash: string, buyer: string) => Promise<bigint | null>;
  limit?: number;
  fetchTimeoutMs?: number;
  deadline?: Deadline;
  nowSec?: number;
  verifySignature?: (auth: GatewayAuth, payer: string) => Promise<boolean>;
  readBatchTime?: (txHash: string) => Promise<bigint | null>;
}): Promise<GatewayReconcileSummary> {
  const empty: GatewayReconcileSummary = { settled: 0, refuted: 0, deferred: 0, noted: 0, expired: 0, overDebit: 0 };
  const db = options?.db === undefined ? getDb() : options.db;
  if (!db) return empty;
  if (options?.deadline?.expired()) return empty;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const fetchTimeoutMs = options?.fetchTimeoutMs ?? GATEWAY_FETCH_TIMEOUT_MS;
  // The API clock is often spent when judging starts. This clock starts on the first chain read of a group already looked up.
  let judgeDeadline: Deadline | null = null;
  const judgeClock = () => {
    judgeDeadline ??= createDeadline(GATEWAY_WRITE_RESERVE_MS);
    return judgeDeadline;
  };
  const readDebit = options?.readDebit ?? ((tx, buyer) => readArcGatewayDebit(tx, buyer, judgeClock()));
  const readBatchTime = options?.readBatchTime ?? ((tx) => readArcGatewayBatchTime(tx, judgeClock()));
  const limit = options?.limit ?? 100;
  // Rows with no nonceLookup come first, so a pending head does not fill the limit.
  const raw = await db.execute(sql`
    SELECT pu.id::text AS id, pu.status, pu.payer, pu.raw_response_meta->'circleGateway' AS circle_gateway
    FROM x402_l1_purchases pu
    WHERE pu.settlement_verified IS NULL
      AND pu.raw_response_meta->>'circleGatewayRail' = 'true'
      AND jsonb_typeof(pu.raw_response_meta->'circleGateway') = 'object'
      AND pu.status IN ('settle_claimed', 'settle_failed', 'delivered_no_receipt', 'settle_claimed_unverifiable')
    ORDER BY (coalesce(pu.raw_response_meta->'circleGateway'->>'nonceLookup', '') = '') DESC, pu.attempted_at ASC, pu.id ASC
    LIMIT ${limit}
  `);
  const rows: GatewayClaimRow[] = rowsOf(raw).map((r) => ({
    id: String(r.id),
    status: String(r.status),
    payer: typeof r.payer === "string" ? r.payer : null,
    circleGateway: r.circle_gateway,
  }));
  if (rows.length === 0) return empty;
  const plans = await planGatewayReconcile({
    rows,
    ...(options?.nowSec !== undefined ? { nowSec: options.nowSec } : {}),
    ...(options?.verifySignature ? { verifySignature: options.verifySignature } : {}),
    lookupNonce: (nonce) =>
      gatewayFetch(
        `${ARC_GATEWAY_API}/x402/transfers?network=eip155:5042&nonce=${encodeURIComponent(nonce)}`,
        fetchImpl,
        fetchTimeoutMs,
        options?.deadline,
      ),
    readDebit,
    readBatchTime,
    rememberLookup: async (id, lookup, batchTx) => {
      if (batchTx) {
        await db.execute(sql`
          UPDATE x402_l1_purchases
          SET raw_response_meta = jsonb_set(
            jsonb_set(raw_response_meta, '{circleGateway,nonceLookup}', to_jsonb(${lookup}::text), true),
            '{circleGateway,batchTxSeen}', to_jsonb(${batchTx}::text), true)
          WHERE id = ${id}::uuid AND settlement_verified IS NULL
        `);
      } else {
        await db.execute(sql`
          UPDATE x402_l1_purchases
          SET raw_response_meta = jsonb_set(raw_response_meta, '{circleGateway,nonceLookup}', to_jsonb(${lookup}::text), true)
          WHERE id = ${id}::uuid AND settlement_verified IS NULL
        `);
      }
    },
    loadBatch: async (txHash, buyer) => {
      const sib = await db.execute(sql`
        SELECT pu.id::text AS id, pu.status, pu.payer, pu.raw_response_meta->'circleGateway' AS circle_gateway
        FROM x402_l1_purchases pu
        WHERE pu.raw_response_meta->>'circleGatewayRail' = 'true'
          AND lower(coalesce(pu.raw_response_meta->'circleGateway'->>'batchTxSeen', pu.raw_response_meta->'circleGateway'->>'batchTx', '')) = lower(${txHash})
          AND lower(coalesce(pu.raw_response_meta->'circleGateway'->>'from', pu.payer, '')) = lower(${buyer})
      `);
      const timeRaw = await db.execute(sql`
        SELECT
          count(*) FILTER (
            WHERE coalesce(pu.raw_response_meta->'circleGateway'->>'validAfter', '') !~ '^[0-9]+$'
          )::int AS unreadable,
          count(*) FILTER (
            WHERE coalesce(pu.raw_response_meta->'circleGateway'->>'validAfter', '') ~ '^[0-9]+$'
          )::int AS readable,
          min(
            CASE
              WHEN coalesce(pu.raw_response_meta->'circleGateway'->>'validAfter', '') ~ '^[0-9]+$'
              THEN (pu.raw_response_meta->'circleGateway'->>'validAfter')::numeric
            END
          )::bigint::text AS earliest
        FROM x402_l1_purchases pu
        WHERE pu.settlement_verified IS NULL
          AND pu.raw_response_meta->>'circleGatewayRail' = 'true'
          AND jsonb_typeof(pu.raw_response_meta->'circleGateway') = 'object'
          AND pu.raw_response_meta->'circleGateway'->>'signature' IS NOT NULL
          AND coalesce(pu.raw_response_meta->'circleGateway'->>'note', '') <> 'gateway_signature_invalid'
          AND coalesce(pu.raw_response_meta->'circleGateway'->>'nonceLookup', '') = ''
          AND lower(coalesce(pu.raw_response_meta->'circleGateway'->>'from', pu.payer, '')) = lower(${buyer})
          AND pu.status = ANY (ARRAY['settle_claimed','settle_failed','delivered_no_receipt','settle_claimed_unverifiable'])
      `);
      const timeRow = rowsOf(timeRaw)[0];
      const unreadable = countSql(timeRow?.unreadable);
      const readable = countSql(timeRow?.readable);
      const earliest = numericText(timeRow?.earliest);
      return {
        rows: rowsOf(sib).map((r) => ({
          id: String(r.id),
          status: String(r.status),
          payer: typeof r.payer === "string" ? r.payer : null,
          circleGateway: r.circle_gateway,
          settled: String(r.status) === "settled",
        })),
        unresolved: 0,
        unread: {
          earliestValidAfter: earliest,
          unreadable: unreadable + (readable > 0 && earliest === null ? readable : 0),
        },
      };
    },
  });
  const summary = { ...empty };
  for (const plan of plans) {
    if (plan.action === "defer") {
      summary.deferred++;
      if (plan.reason === "gateway_debit_exceeds_rows") summary.overDebit++;
      continue;
    }
    if (plan.action === "note") {
      await db.execute(sql`
        UPDATE x402_l1_purchases
        SET raw_response_meta = jsonb_set(
          jsonb_set(raw_response_meta, '{circleGateway,note}', '"gateway_signature_invalid"'::jsonb, true),
          '{circleGateway,nonceLookup}', '"unsigned"'::jsonb, true)
        WHERE id = ${plan.id}::uuid AND settlement_verified IS NULL
      `);
      summary.noted++;
      continue;
    }
    const before = rows.find((r) => r.id === plan.id);
    if (plan.action === "expire") {
      await updateWithCorrection(db, {
        update: sql`
          UPDATE x402_l1_purchases
          SET status = ${GATEWAY_NOT_CHARGED_EXPIRED},
              settlement_verified = false,
              settlement_verified_at = now(),
              settlement_verify_reason = ${GATEWAY_NOT_CHARGED_EXPIRED}
          WHERE id = ${plan.id}::uuid AND settlement_verified IS NULL
          RETURNING id::text AS correction_subject_id`,
        subjectType: "purchase",
        level: "l1",
        before: { json: { status: before?.status ?? "settle_claimed" } },
        after: { json: { status: GATEWAY_NOT_CHARGED_EXPIRED, reason: GATEWAY_NOT_CHARGED_EXPIRED } },
        reason: "settlement_backfill",
      });
      summary.expired++;
      continue;
    }
    if (plan.action === "settle") {
      await updateWithCorrection(db, {
        update: sql`
          UPDATE x402_l1_purchases
          SET status = 'settled',
              settlement_verified = true,
              settlement_verified_at = now(),
              settlement_verify_reason = 'circle_gateway',
              raw_response_meta = jsonb_set(
                jsonb_set(raw_response_meta, '{circleGateway,batchTx}', to_jsonb(${plan.batchTx}::text), true),
                '{circleGateway,gatewayStatus}', to_jsonb(${plan.gatewayStatus}::text), true)
          WHERE id = ${plan.id}::uuid AND settlement_verified IS NULL
          RETURNING id::text AS correction_subject_id`,
        subjectType: "purchase",
        level: "l1",
        before: { json: { status: before?.status ?? "settle_claimed" } },
        after: { json: { status: "settled", reason: "circle_gateway", batchTx: plan.batchTx } },
        reason: "settlement_backfill",
      });
      summary.settled++;
      continue;
    }
    await updateWithCorrection(db, {
      update: sql`
        UPDATE x402_l1_purchases
        SET status = 'settle_claim_refuted',
            settlement_verified = false,
            settlement_verified_at = now(),
            settlement_verify_reason = 'gateway_debit_mismatch'
        WHERE id = ${plan.id}::uuid AND settlement_verified IS NULL
        RETURNING id::text AS correction_subject_id`,
      subjectType: "purchase",
      level: "l1",
      before: { json: { status: before?.status ?? "settle_claimed" } },
      after: { json: { status: "settle_claim_refuted", reason: "gateway_debit_mismatch" } },
      reason: "settlement_backfill",
    });
    summary.refuted++;
  }
  return summary;
}

type BlockReceipt = { transactionHash?: string; to?: string | null; logs?: TxLog[] };

function logTouchesBuyer(logs: readonly TxLog[], buyer: string): boolean {
  const topic = addressTopic(buyer);
  return logs.some(
    (log) =>
      log.address.toLowerCase() === ARC_GATEWAY_WALLET.toLowerCase() &&
      log.topics.some((t) => t.toLowerCase() === topic),
  );
}

/** Block timestamp of a Gateway batch tx, in seconds. Null when the clock cannot be read. */
export async function readArcGatewayBatchTime(txHash: string, deadline?: Deadline): Promise<bigint | null> {
  if (deadline?.expired()) return null;
  const rpc = process.env.ARC_RPC_URL?.trim();
  if (!rpc) return null;
  try {
    const { createPublicClient, http } = await import("viem");
    const timeout = Math.min(4_000, deadline ? Math.max(1, deadline.budgetFor(4_000)) : 4_000);
    const client = createPublicClient({ transport: http(rpc, { timeout, retryCount: 0 }) });
    const rc = await client.getTransactionReceipt({ hash: txHash as Hex });
    if (deadline?.expired()) return null;
    const block = await client.getBlock({ blockNumber: rc.blockNumber });
    return block.timestamp;
  } catch (error) {
    logServerErrorSafe("arc-gateway-verify.batch_time", error);
    return null;
  }
}

/** On-chain debit for this buyer in the batch tx. Null defers. Never uses a mixed balance delta to refute. */
export async function readArcGatewayDebit(txHash: string, buyer: string, deadline?: Deadline): Promise<bigint | null> {
  if (deadline?.expired()) return null;
  const rpc = process.env.ARC_RPC_URL?.trim();
  if (!rpc) return null;
  try {
    const { createPublicClient, http } = await import("viem");
    const timeout = Math.min(4_000, deadline ? Math.max(1, deadline.budgetFor(4_000)) : 4_000);
    const client = createPublicClient({ transport: http(rpc, { timeout, retryCount: 0 }) });
    const rc = await client.getTransactionReceipt({ hash: txHash as Hex });
    const tx = await client.getTransaction({ hash: txHash as Hex });
    const logs = (rc.logs ?? []).map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
    }));
    let otherBuyerMovement = false;
    const decodedNow = tryDecodeBuyerDebit(tx.input, logs, buyer);
    if (decodedNow.kind === "undecoded" && rc.blockNumber > 0n) {
      if (deadline?.expired()) return null;
      let blockReceipts: BlockReceipt[] = [];
      try {
        const raw = await client.request({
          method: "eth_getBlockReceipts" as never,
          params: [`0x${rc.blockNumber.toString(16)}`] as never,
        });
        blockReceipts = Array.isArray(raw) ? (raw as BlockReceipt[]) : [];
        if (!Array.isArray(raw)) otherBuyerMovement = true;
      } catch {
        otherBuyerMovement = true;
      }
      for (const other of blockReceipts) {
        if (deadline?.expired()) return null;
        const hash = typeof other.transactionHash === "string" ? other.transactionHash.toLowerCase() : "";
        if (hash === txHash.toLowerCase()) continue;
        const otherLogs = other.logs ?? [];
        if (logTouchesBuyer(otherLogs, buyer)) {
          otherBuyerMovement = true;
          break;
        }
        if (other.to && other.to.toLowerCase() === ARC_GATEWAY_WALLET.toLowerCase()) {
          try {
            const otherTx = await client.getTransaction({ hash: hash as Hex });
            const otherDecoded = tryDecodeBuyerDebit(otherTx.input, otherLogs, buyer);
            if (otherDecoded.kind !== "defer") {
              otherBuyerMovement = true;
              break;
            }
          } catch {
            otherBuyerMovement = true;
            break;
          }
        }
      }
    }
    const read = gatewayBuyerDebit({
      status: rc.status,
      to: rc.to ?? null,
      calldata: tx.input,
      logs,
      buyer,
      otherBuyerMovement,
    });
    if (read.kind !== "use_balance") return resolveGatewayDebit(read, null);
    if (rc.blockNumber <= 0n) return null;
    if (deadline?.expired()) return null;
    const abi = parseAbi(["function totalBalance(address token,address depositor) view returns (uint256)"]);
    const wallet = getAddress(ARC_GATEWAY_WALLET);
    const token = getAddress(ARC_USDC);
    const who = getAddress(buyer);
    const [before, after] = await Promise.all([
      client.readContract({
        address: wallet,
        abi,
        functionName: "totalBalance",
        args: [token, who],
        blockNumber: rc.blockNumber - 1n,
      }),
      client.readContract({
        address: wallet,
        abi,
        functionName: "totalBalance",
        args: [token, who],
        blockNumber: rc.blockNumber,
      }),
    ]);
    return resolveGatewayDebit(read, before - after);
  } catch (error) {
    logServerErrorSafe("arc-gateway-verify.debit", error);
    return null;
  }
}

/** Encode a submitBatch calldata for tests and for a local round trip of the decoder. */
export function encodeSubmitBatchCalldata(input: {
  deltas: readonly { depositor: `0x${string}`; value: bigint }[];
  token: `0x${string}`;
  wallet: `0x${string}`;
}): Hex {
  const inner = encodeAbiParameters(BATCH_PARAMS, [input.deltas as { depositor: `0x${string}`; value: bigint }[], keccak256(toBytes("batch")), 26, input.token, input.wallet]);
  return encodeFunctionData({ abi: SUBMIT_BATCH_ABI, functionName: "submitBatch", args: [inner, "0x"] });
}

// Circle Gateway charge check for Arc purchase rows.
// A row stays settle_claimed until the Gateway API shows a confirmed transfer
// and the buyer's GatewayWallet debit in that batch tx matches.
// The batch tx is stored on raw_response_meta.circleGateway.batchTx, not tx_hash.
// This module never deposits, withdraws, or broadcasts.

import { getAddress, verifyTypedData, type Hex } from "viem";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { updateWithCorrection } from "./corrections";
import { ARC_USDC } from "./x402-payer";
import {
  ARC_GATEWAY_API,
  ARC_GATEWAY_DOMAIN_NAME,
  ARC_GATEWAY_DOMAIN_VERSION,
  ARC_GATEWAY_WALLET,
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
 * Sum of confirmed transfers from this buyer in this batch tx.
 * Incomplete page or an unreadable amount makes the sum null (defer, do not refute).
 */
export function sumBuyerCharges(body: unknown, txHash: string, buyer: string): bigint | null {
  const rec = asRecord(body);
  if (!rec || !Array.isArray(rec.transfers)) return null;
  if (pageIncomplete(rec, rec.transfers)) return null;
  const tx = txHash.toLowerCase();
  const who = buyer.toLowerCase();
  let sum = 0n;
  for (const raw of rec.transfers) {
    const t = transferView(raw);
    if (!t?.txHash || t.txHash.toLowerCase() !== tx) continue;
    if (!t.from || t.from.toLowerCase() !== who) continue;
    if (t.status !== "confirmed" && t.status !== "completed") continue;
    if (!t.amount || !/^[0-9]+$/.test(t.amount)) return null;
    sum += BigInt(t.amount);
  }
  return sum;
}

/** A === S and D === S settles. A === S and a different debit refutes. Anything else defers. */
export function judgeGatewayBatch(input: { apiSum: bigint | null; rowSum: bigint; debit: bigint | null }): "settle" | "refute" | "defer" {
  if (input.apiSum === null || input.apiSum !== input.rowSum || input.debit === null) return "defer";
  if (input.debit === input.rowSum) return "settle";
  return "refute";
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
  /** Already settled sibling. Counted in S, not written again. */
  settled?: boolean;
};

export type GatewayPlan =
  | { id: string; action: "settle"; batchTx: string; gatewayStatus: string }
  | { id: string; action: "refute"; reason: "gateway_debit_mismatch" }
  | { id: string; action: "note"; reason: "gateway_signature_invalid" }
  | { id: string; action: "defer"; reason: string };

type Lookup = { ok: true; body: unknown } | { ok: false };

function valueOf(auth: GatewayAuth | null): bigint | null {
  if (!auth || !/^[0-9]+$/.test(auth.value)) return null;
  try {
    const v = BigInt(auth.value);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * Pure plan. No charge stays deferred. A charge whose debit does not match, when the API sum
 * equals the row sum, is a refute. A bad signature is a note, not a seller finding.
 */
export async function planGatewayReconcile(input: {
  rows: GatewayClaimRow[];
  lookupNonce: (nonce: string) => Promise<Lookup>;
  listFromBuyer: (buyer: string) => Promise<Lookup>;
  readDebit: (txHash: string, buyer: string) => Promise<bigint | null>;
  loadSettled?: (txHash: string, buyer: string) => Promise<GatewayClaimRow[]>;
  verifySignature?: (auth: GatewayAuth, payer: string) => Promise<boolean>;
}): Promise<GatewayPlan[]> {
  const verify = input.verifySignature ?? gatewayAuthorizationRecovers;
  const plans = new Map<string, GatewayPlan>();
  type Member = { row: GatewayClaimRow; auth: GatewayAuth; value: bigint; gatewayStatus: string };
  const groups = new Map<string, Member[]>();

  for (const row of input.rows) {
    if (row.settled) continue;
    const auth = readGatewayAuth(row.circleGateway);
    const payer = row.payer ?? auth?.from ?? "";
    if (!auth || !payer) {
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_auth_unreadable" });
      continue;
    }
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
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_api_error" });
      continue;
    }
    const hit = interpretGatewayTransfers(lookup.body, auth.nonce);
    if (hit.kind === "absent") {
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_not_charged" });
      continue;
    }
    if (hit.kind !== "charged") {
      plans.set(row.id, { id: row.id, action: "defer", reason: `gateway_${hit.kind}` });
      continue;
    }
    const value = valueOf(auth);
    if (value === null) {
      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_value_unreadable" });
      continue;
    }
    const buyer = auth.from.toLowerCase();
    const key = `${hit.txHash.toLowerCase()}|${buyer}`;
    const list = groups.get(key) ?? [];
    list.push({ row, auth, value, gatewayStatus: hit.status });
    groups.set(key, list);
  }

  for (const [key, members] of groups) {
    const split = key.indexOf("|");
    const batchTx = key.slice(0, split);
    const buyer = key.slice(split + 1);
    let siblings: GatewayClaimRow[] = [];
    try {
      siblings = (await input.loadSettled?.(batchTx, buyer)) ?? [];
    } catch {
      for (const m of members) plans.set(m.row.id, { id: m.row.id, action: "defer", reason: "gateway_settled_unreadable" });
      continue;
    }
    let rowSum = 0n;
    let broken = false;
    for (const m of members) rowSum += m.value;
    for (const s of siblings) {
      const auth = readGatewayAuth(s.circleGateway);
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
    let apiSum: bigint | null = null;
    try {
      const listed = await input.listFromBuyer(buyer);
      apiSum = listed.ok ? sumBuyerCharges(listed.body, batchTx, buyer) : null;
    } catch {
      apiSum = null;
    }
    let debit: bigint | null = null;
    try {
      debit = await input.readDebit(batchTx, buyer);
    } catch {
      debit = null;
    }
    const verdict = judgeGatewayBatch({ apiSum, rowSum, debit });
    const gatewayStatus = members[0]?.gatewayStatus ?? "confirmed";
    for (const m of members) {
      if (verdict === "settle") plans.set(m.row.id, { id: m.row.id, action: "settle", batchTx, gatewayStatus });
      else if (verdict === "refute") plans.set(m.row.id, { id: m.row.id, action: "refute", reason: "gateway_debit_mismatch" });
      else plans.set(m.row.id, { id: m.row.id, action: "defer", reason: "gateway_debit_deferred" });
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

async function gatewayFetch(url: string, fetchImpl: typeof fetch): Promise<Lookup> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { ok: false };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false };
  }
}

/** Load Gateway rows and apply the plan. A throw here must not fail the native verifier. */
export async function reconcileArcGatewayClaims(options?: {
  db?: Executor | null;
  fetchImpl?: typeof fetch;
  readDebit?: (txHash: string, buyer: string) => Promise<bigint | null>;
  limit?: number;
}): Promise<{ settled: number; refuted: number; deferred: number; noted: number }> {
  const empty = { settled: 0, refuted: 0, deferred: 0, noted: 0 };
  const db = options?.db === undefined ? getDb() : options.db;
  if (!db) return empty;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const readDebit = options?.readDebit ?? readArcGatewayDebit;
  const limit = options?.limit ?? 100;
  const raw = await db.execute(sql`
    SELECT pu.id::text AS id, pu.status, pu.payer, pu.raw_response_meta->'circleGateway' AS circle_gateway
    FROM x402_l1_purchases pu
    WHERE pu.settlement_verified IS NULL
      AND pu.raw_response_meta->>'circleGatewayRail' = 'true'
      AND jsonb_typeof(pu.raw_response_meta->'circleGateway') = 'object'
      AND pu.status IN ('settle_claimed', 'settle_failed')
    ORDER BY pu.attempted_at ASC
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
    lookupNonce: (nonce) => gatewayFetch(`${ARC_GATEWAY_API}/x402/transfers?network=eip155:5042&nonce=${encodeURIComponent(nonce)}`, fetchImpl),
    listFromBuyer: (buyer) =>
      gatewayFetch(`${ARC_GATEWAY_API}/x402/transfers?network=eip155:5042&from=${encodeURIComponent(buyer)}&pageSize=100`, fetchImpl),
    readDebit,
    loadSettled: async (txHash, buyer) => {
      const sib = await db.execute(sql`
        SELECT pu.id::text AS id, pu.status, pu.payer, pu.raw_response_meta->'circleGateway' AS circle_gateway
        FROM x402_l1_purchases pu
        WHERE pu.status = 'settled'
          AND lower(pu.raw_response_meta->'circleGateway'->>'batchTx') = lower(${txHash})
          AND lower(pu.raw_response_meta->'circleGateway'->>'from') = lower(${buyer})
      `);
      return rowsOf(sib).map((r) => ({
        id: String(r.id),
        status: String(r.status),
        payer: typeof r.payer === "string" ? r.payer : null,
        circleGateway: r.circle_gateway,
        settled: true,
      }));
    },
  });
  const summary = { ...empty };
  for (const plan of plans) {
    if (plan.action === "defer") {
      summary.deferred++;
      continue;
    }
    if (plan.action === "note") {
      await db.execute(sql`
        UPDATE x402_l1_purchases
        SET raw_response_meta = jsonb_set(raw_response_meta, '{circleGateway,note}', '"gateway_signature_invalid"'::jsonb, true)
        WHERE id = ${plan.id}::uuid AND settlement_verified IS NULL
      `);
      summary.noted++;
      continue;
    }
    const before = rows.find((r) => r.id === plan.id);
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

/** On-chain GatewayWallet.totalBalance drop for this buyer in the batch tx. Null defers. */
export async function readArcGatewayDebit(txHash: string, buyer: string): Promise<bigint | null> {
  const rpc = process.env.ARC_RPC_URL?.trim();
  if (!rpc) return null;
  try {
    const { createPublicClient, http, parseAbi } = await import("viem");
    const client = createPublicClient({ transport: http(rpc, { timeout: 8_000, retryCount: 0 }) });
    const rc = await client.getTransactionReceipt({ hash: txHash as Hex });
    if (rc.status !== "success") return null;
    if (!rc.to || rc.to.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return null;
    if (rc.blockNumber <= 0n) return null;
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
    return before - after;
  } catch {
    return null;
  }
}

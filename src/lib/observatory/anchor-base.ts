import { createPublicClient, http, hexToString, stringToHex, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { sql } from "drizzle-orm";
import type { AnchorRow } from "@/lib/observatory/anchors";
import type { getDb } from "@/lib/db/client";

export const ANCHOR_BASE_CHAIN_ID = 8453;
export const ANCHOR_MESSAGE_PREFIX = "vet402-anchor:v1";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOT_RE = /^[0-9a-f]{64}$/;

export function anchorCalldataMessage(day: string, rootHash: string): string {
  if (!DAY_RE.test(day)) throw new Error("invalid_day");
  const root = rootHash.toLowerCase();
  if (!ROOT_RE.test(root)) throw new Error("invalid_root_hash");
  return `${ANCHOR_MESSAGE_PREFIX}:${day}:${root}`;
}

export function buildAnchorCalldata(day: string, rootHash: string): Hex {
  return stringToHex(anchorCalldataMessage(day, rootHash));
}

export function parseAnchorCalldata(input: Hex): { day: string; rootHash: string } | null {
  try {
    const msg = hexToString(input);
    const m = new RegExp(`^${ANCHOR_MESSAGE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d{4}-\\d{2}-\\d{2}):([0-9a-f]{64})$`, "i").exec(
      msg,
    );
    if (!m) return null;
    return { day: m[1], rootHash: m[2].toLowerCase() };
  } catch {
    return null;
  }
}

export type AnchorBaseRpcTx = {
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
};

export type AnchorBaseRpc = {
  getTransactionReceipt: (hash: Hex) => Promise<{ status: "success" | "reverted" } | null>;
  getTransaction: (hash: Hex) => Promise<AnchorBaseRpcTx | null>;
};

export function createAnchorBaseRpc(rpcUrl: string): AnchorBaseRpc {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return {
    async getTransactionReceipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status };
      } catch {
        return null;
      }
    },
    async getTransaction(hash) {
      try {
        const t = await client.getTransaction({ hash });
        if (!t) return null;
        return { from: t.from, to: t.to, input: t.input, value: t.value };
      } catch {
        return null;
      }
    },
  };
}

export type AnchorTxVerifyError =
  | "anchor_tx_not_found"
  | "anchor_tx_receipt_failed"
  | "anchor_tx_not_self_send"
  | "anchor_tx_signer_mismatch"
  | "anchor_tx_calldata_mismatch";

export async function verifyAnchorBaseTx(
  txHash: Hex,
  expectedDay: string,
  expectedRootHash: string,
  expectedSigner: Address,
  rpc: AnchorBaseRpc,
): Promise<{ ok: true } | { ok: false; error: AnchorTxVerifyError }> {
  const receipt = await rpc.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== "success") return { ok: false, error: "anchor_tx_receipt_failed" };
  const tx = await rpc.getTransaction(txHash);
  if (!tx) return { ok: false, error: "anchor_tx_not_found" };
  if (tx.value !== 0n) return { ok: false, error: "anchor_tx_not_self_send" };
  if (!tx.to || tx.to.toLowerCase() !== tx.from.toLowerCase()) return { ok: false, error: "anchor_tx_not_self_send" };
  if (tx.from.toLowerCase() !== expectedSigner.toLowerCase()) return { ok: false, error: "anchor_tx_signer_mismatch" };
  const parsed = parseAnchorCalldata(tx.input);
  const wantRoot = expectedRootHash.toLowerCase();
  if (!parsed || parsed.day !== expectedDay || parsed.rootHash !== wantRoot) {
    return { ok: false, error: "anchor_tx_calldata_mismatch" };
  }
  return { ok: true };
}

type Db = NonNullable<ReturnType<typeof getDb>>;

export type RegisterAnchorTxResult =
  | { ok: true; day: string; txHash: string }
  | { ok: false; error: string; status: number };

export async function registerLedgerAnchorTx(
  db: Db,
  input: { day: string; txHash: string; chainId: number },
  rpc: AnchorBaseRpc,
  signer: Address,
): Promise<RegisterAnchorTxResult> {
  if (input.chainId !== ANCHOR_BASE_CHAIN_ID) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  if (!DAY_RE.test(input.day)) return { ok: false, error: "invalid_request", status: 400 };
  const txHash = input.txHash.trim() as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: "invalid_tx_hash", status: 400 };

  const head = await db.execute(
    sql`SELECT root_hash, anchored_tx FROM ledger_anchors WHERE day = ${input.day}`,
  );
  const rows = (Array.isArray(head) ? head : (head as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return { ok: false, error: "anchor_day_not_sealed", status: 422 };
  const rootHash = String(rows[0].root_hash);
  const existing = rows[0].anchored_tx;
  if (existing !== null && existing !== undefined) {
    return { ok: false, error: "anchor_tx_already_set", status: 409 };
  }

  const verified = await verifyAnchorBaseTx(txHash, input.day, rootHash, signer, rpc);
  if (!verified.ok) return { ok: false, error: verified.error, status: 422 };

  const updated = await db.execute(
    sql`UPDATE ledger_anchors SET anchored_tx = ${txHash} WHERE day = ${input.day} AND anchored_tx IS NULL RETURNING day`,
  );
  const wrote = (Array.isArray(updated) ? updated : (updated as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  if (wrote.length === 0) return { ok: false, error: "anchor_tx_already_set", status: 409 };

  return { ok: true, day: input.day, txHash };
}

export type AnchorRowPublic = AnchorRow & {
  anchoredChain?: string;
  anchoredTxUrl?: string;
  verify?: string;
};

export function enrichAnchorRow(row: AnchorRow): AnchorRowPublic {
  if (!row.anchoredTx) return row;
  return {
    ...row,
    anchoredChain: "eip155:8453",
    anchoredTxUrl: `https://basescan.org/tx/${row.anchoredTx}`,
    verify: `cast tx ${row.anchoredTx} input --rpc-url https://mainnet.base.org | cast to-ascii`,
  };
}
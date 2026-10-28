// Daily Merkle root for Circle Gateway purchase records on Arc.
// Leaf v1 matches the microgrant (sorted-pair keccak, OpenZeppelin order).
// This module does not deploy or broadcast.

import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { isDeliveryHttp } from "./delivery";

export type GatewayLeafV1 = {
  nonce: Hex;
  from: Address;
  to: Address;
  value: bigint;
  resourceHash: Hex;
  requestHash: Hex;
  httpStatus: number;
  responseHash: Hex;
};

/** keccak256(abi.encode(nonce, from, to, value, resourceHash, requestHash, httpStatus, responseHash)). */
export function gatewayLeafV1(leaf: GatewayLeafV1): Hex {
  const httpStatus = Number.isInteger(leaf.httpStatus) && leaf.httpStatus >= 0 && leaf.httpStatus <= 65535 ? leaf.httpStatus : 0;
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
      ],
      [leaf.nonce, leaf.from, leaf.to, leaf.value, leaf.resourceHash, leaf.requestHash, httpStatus, leaf.responseHash],
    ),
  );
}

function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([x, y]));
}

/** Sorted-pair Merkle root. One leaf is its own root. An empty list throws. */
export function sortedMerkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) throw new Error("empty_merkle");
  let layer = [...leaves];
  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1];
      if (left === undefined) break;
      next.push(right === undefined ? left : hashPair(left, right));
    }
    layer = next;
  }
  const root = layer[0];
  if (root === undefined) throw new Error("empty_merkle");
  return root;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type GatewayDaySourceRow = {
  attemptedAt: string;
  resourceUrl: string;
  method: string | null;
  httpStatus: number | null;
  circleGateway: Record<string, unknown> | null;
};

export type GatewayDayRecord = {
  day: string;
  index: number;
  resource: string;
  method: string;
  attemptedAt: string;
  authorization: { nonce: string; from: string; to: string; value: string; validAfter: string; validBefore: string };
  signature: string | null;
  verifyingContract: string | null;
  resourceHash: string;
  requestHash: string;
  responseHash: string;
  httpStatus: number;
  delivered: boolean;
  leaf: Hex;
};

export type GatewayDayDocument = {
  day: string;
  root: Hex;
  purchases: number;
  delivered: number;
  records: GatewayDayRecord[];
};

function hex32(value: unknown): string | null {
  return typeof value === "string" && HEX32.test(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One UTC day of settled Gateway rows, as records.json plus its Merkle root.
 * A settled row with a missing leaf hash fails the whole day. Nothing is written here.
 */
export function buildGatewayDayRecords(day: string, rows: readonly GatewayDaySourceRow[]): { ok: true; document: GatewayDayDocument } | { ok: false; reason: "empty" | "missing_hash" | "bad_day" } {
  if (!DAY.test(day)) return { ok: false, reason: "bad_day" };
  if (rows.length === 0) return { ok: false, reason: "empty" };
  const ordered = [...rows].sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt));
  const records: GatewayDayRecord[] = [];
  for (const row of ordered) {
    const gw = row.circleGateway;
    const nonce = hex32(gw?.nonce);
    const from = text(gw?.from);
    const to = text(gw?.to);
    const value = text(gw?.value);
    const resourceHash = hex32(gw?.resourceHash);
    const requestHash = hex32(gw?.requestHash);
    const responseHash = hex32(gw?.responseHash);
    if (!gw || !nonce || !from || !to || !value || !/^[0-9]+$/.test(value) || !resourceHash || !requestHash || !responseHash) {
      return { ok: false, reason: "missing_hash" };
    }
    const httpStatus = typeof gw.httpStatus === "number" ? gw.httpStatus : row.httpStatus ?? 0;
    const delivered = isDeliveryHttp(httpStatus);
    const leaf = gatewayLeafV1({
      nonce: nonce as Hex,
      from: from as Address,
      to: to as Address,
      value: BigInt(value),
      resourceHash: resourceHash as Hex,
      requestHash: requestHash as Hex,
      httpStatus,
      responseHash: responseHash as Hex,
    });
    records.push({
      day,
      index: records.length + 1,
      resource: row.resourceUrl,
      method: row.method ?? "GET",
      attemptedAt: row.attemptedAt,
      authorization: {
        nonce,
        from,
        to,
        value,
        validAfter: text(gw.validAfter) ?? "0",
        validBefore: text(gw.validBefore) ?? "0",
      },
      signature: text(gw.signature),
      verifyingContract: text(gw.verifyingContract),
      resourceHash,
      requestHash,
      responseHash,
      httpStatus,
      delivered,
      leaf,
    });
  }
  const delivered = records.filter((r) => r.delivered).length;
  return {
    ok: true,
    document: {
      day,
      root: sortedMerkleRoot(records.map((r) => r.leaf)),
      purchases: records.length,
      delivered,
      records,
    },
  };
}

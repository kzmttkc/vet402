// Daily Merkle root for Circle Gateway purchase records on Arc.
// Leaf v1 matches the microgrant (sorted-pair keccak, OpenZeppelin order).
// This module does not deploy or broadcast.

import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

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

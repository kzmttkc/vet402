#!/usr/bin/env node
// Print a daily Merkle root and the commands that would deploy DeliveryLedger or anchor a round.
// Refuses to broadcast and does not read a private key.
import { readFileSync } from "node:fs";
import { concat, encodeAbiParameters, keccak256 } from "viem";

const args = process.argv.slice(2);
if (args.some((a) => a === "--send" || a === "--broadcast")) {
  console.error("refusing to broadcast");
  process.exit(2);
}

function leafV1(p) {
  const httpStatus = Number.isInteger(p.httpStatus) && p.httpStatus >= 0 && p.httpStatus <= 65535 ? p.httpStatus : 0;
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
      [p.nonce, p.from, p.to, BigInt(p.value), p.resourceHash, p.requestHash, httpStatus, p.responseHash],
    ),
  );
}

function hashPair(a, b) {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([x, y]));
}

function rootOf(leaves) {
  if (leaves.length === 0) throw new Error("empty_merkle");
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
    layer = next;
  }
  return layer[0];
}

const file = args.find((a) => !a.startsWith("--"));
let root = null;
let purchases = 0;
if (file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const records = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(records) || records.length === 0) {
    console.error("records json needs a non-empty records array");
    process.exit(2);
  }
  const leaves = records.map((r) => {
    const a = r.authorization ?? r;
    return leafV1({
      nonce: a.nonce,
      from: a.from,
      to: a.to,
      value: a.value,
      resourceHash: r.resourceHash,
      requestHash: r.requestHash,
      responseHash: r.responseHash,
      httpStatus: r.httpStatus ?? 0,
    });
  });
  root = rootOf(leaves);
  purchases = leaves.length;
  console.log(`root ${root}`);
  console.log(`purchases ${purchases}`);
} else {
  console.log("root (pass a records json to compute one)");
}

console.log("contract ops/arc-gateway/DeliveryLedger.sol");
console.log("compile: solc --bin --abi ops/arc-gateway/DeliveryLedger.sol");
console.log("deploy (not run by this script): forge create ops/arc-gateway/DeliveryLedger.sol:DeliveryLedger --rpc-url $ARC_RPC_URL --private-key $ARC_GATEWAY_DEPLOYER_KEY --constructor-args $ARC_GATEWAY_RECORDER");
console.log("anchor (not run by this script): cast send $ARC_GATEWAY_LEDGER \"anchor(bytes32,uint32,uint32,string)\" $ARC_GATEWAY_ROOT $ARC_GATEWAY_PURCHASES $ARC_GATEWAY_DELIVERED $ARC_GATEWAY_URI --rpc-url $ARC_RPC_URL --private-key $ARC_GATEWAY_RECORDER_KEY");
console.log("env names: ARC_RPC_URL ARC_GATEWAY_DEPLOYER_KEY ARC_GATEWAY_RECORDER ARC_GATEWAY_LEDGER ARC_GATEWAY_ROOT ARC_GATEWAY_PURCHASES ARC_GATEWAY_DELIVERED ARC_GATEWAY_URI ARC_GATEWAY_RECORDER_KEY");
console.log("the recorder is a key used only for day roots, not the payer EOA. This script does not read those values and does not send a transaction.");

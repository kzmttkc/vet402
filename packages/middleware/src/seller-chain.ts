// Chain read for the seller edge. The seller passes the RPC.
// vet402 does not settle, does not sign a transaction, and does not send one.
// A receipt is accepted only when eth_chainId matches the offer network and
// the receipt holds exactly one Transfer of the offer asset.
import type { ChainTransfer } from "./seller-edge.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EVM_TX = /^0x[a-fA-F0-9]{64}$/;
const HEX_QTY = /^0x[0-9a-fA-F]+$/;

export type SellerRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type SellerReceiptLog = {
  address?: string;
  topics?: readonly string[];
  data?: string;
};

export type SellerReceipt = {
  status?: string | number;
  transactionHash?: string;
  logs?: readonly SellerReceiptLog[];
};

export function chainIdFromCaip2(network: string): number | null {
  const match = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function hexToBigInt(hex: string): bigint | null {
  if (!HEX_QTY.test(hex)) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

function topicAddress(topic: string): string | null {
  if (!/^0x[a-fA-F0-9]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function sameEvm(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function receiptSucceeded(status: string | number | undefined): boolean {
  if (status === 1 || status === "0x1" || status === "0x01") return true;
  if (typeof status === "string" && HEX_QTY.test(status)) {
    const value = hexToBigInt(status);
    return value === 1n;
  }
  return false;
}

/** One Transfer of `asset`, or null when the receipt does not show exactly one. */
export function transferFromSellerReceipt(input: {
  network: string;
  asset: string;
  chainIdHex: string;
  receipt: SellerReceipt | null;
  txHash: string;
}): ChainTransfer | null {
  const expectedChain = chainIdFromCaip2(input.network);
  const observed = hexToBigInt(input.chainIdHex);
  if (expectedChain === null || observed === null) return null;
  if (input.receipt === null) return null;
  if (!receiptSucceeded(input.receipt.status)) return null;
  if (typeof input.receipt.transactionHash === "string" && !sameTx(input.receipt.transactionHash, input.txHash)) {
    return null;
  }
  const logs = input.receipt.logs ?? [];
  const legs: { payTo: string; amount: string }[] = [];
  for (const log of logs) {
    if (typeof log.address !== "string" || !sameEvm(log.address, input.asset)) continue;
    const topics = log.topics ?? [];
    if (topics.length < 3 || topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const payTo = topicAddress(topics[2] ?? "");
    const amount = uint256(log.data);
    if (!payTo || amount === null) continue;
    legs.push({ payTo, amount });
  }
  if (legs.length !== 1) return null;
  const leg = legs[0]!;
  const network = observed === BigInt(expectedChain) ? input.network : `eip155:${observed.toString(10)}`;
  return {
    txHash: input.txHash,
    amount: leg.amount,
    payTo: leg.payTo,
    asset: input.asset,
    network,
  };
}

function sameTx(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function uint256(data: string | undefined): string | null {
  if (typeof data !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(data)) return null;
  const value = hexToBigInt(data);
  if (value === null || value < 0n) return null;
  return value.toString(10);
}

export function createSellerChainReader(options: {
  network: string;
  asset: string;
  rpc: SellerRpc;
}): (txHash: string) => Promise<ChainTransfer | null> {
  if (chainIdFromCaip2(options.network) === null) {
    throw new Error("seller chain reader requires an eip155 network");
  }
  if (typeof options.asset !== "string" || options.asset.length === 0) {
    throw new Error("seller chain reader requires an asset");
  }
  if (typeof options.rpc !== "function") {
    throw new Error("seller chain reader requires an rpc");
  }
  const network = options.network;
  const asset = options.asset;
  const rpc = options.rpc;
  return async (txHash: string) => {
    if (!EVM_TX.test(txHash)) return null;
    const chainIdHex = await rpc("eth_chainId", []);
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (typeof chainIdHex !== "string") throw new Error("eth_chainId was not a hex quantity");
    if (receipt !== null && (typeof receipt !== "object" || Array.isArray(receipt))) {
      throw new Error("eth_getTransactionReceipt was not a receipt");
    }
    return transferFromSellerReceipt({
      network,
      asset,
      chainIdHex,
      receipt: receipt as SellerReceipt | null,
      txHash,
    });
  };
}

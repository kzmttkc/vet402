// 支払い証明のチェーン読み。購入の照合（verifyL1Settlement）は期待額を要求するので呼ばない。
// 同じ RPC の作りと、レシート / 残高差分 / Horizon の読み方だけを使い回す。
// 確定数（32 / 64）は待たない。成功したレシートがあれば confirmed。
import { canonicalNetworkId } from "@/lib/observatory/chains";
import { TEMPO_CHAIN_ID, TEMPO_USDC_E } from "@/lib/observatory/mpp-payer";
import { evmVerifyClientFor, receiptMissing, type EvmVerifyClient } from "@/lib/observatory/settlement-verify";
import { usdcOwnerDelta, createSolanaVerifyRpc, type SolanaVerifyRpc } from "@/lib/observatory/settlement-verify-solana";
import {
  readStellarSettlementMovement,
  type StellarHorizonReader,
} from "@/lib/observatory/settlement-verify-stellar";
import { defaultTempoVerifyClient, TEMPO_TRANSFER_TOPIC, TEMPO_TRANSFER_WITH_MEMO_TOPIC } from "@/lib/observatory/settlement-verify-tempo";
import { SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";
import { evmChainFor, type EvmPayChain } from "@/lib/observatory/x402-payer";
import {
  RLUSD_ISSUER,
  XRPL_MAINNET_CAIP2,
  createXrplJsonRpc,
  isRlusdAsset,
  rlusdToUnitsFloor,
  type XrplRpc,
} from "@/lib/observatory/xrpl402-payer";
import { readXrplTxResponse } from "@/lib/observatory/settlement-verify-xrpl";
import { STELLAR_PUBNET_CAIP2 } from "@/lib/observatory/stellar402-payer";
import { isWellFormedSettlementTx, type SettlementChain } from "@/lib/validation/settlement-tx";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TEMPO_CAIP2 = `eip155:${TEMPO_CHAIN_ID}`;
const SOLANA_REFERENCE_MIN = 32;

export type PaymentProofReaders = {
  evm?: (chain: EvmPayChain) => EvmVerifyClient | null | Promise<EvmVerifyClient | null>;
  tempo?: () => EvmVerifyClient | null | Promise<EvmVerifyClient | null>;
  solana?: () => SolanaVerifyRpc | null | Promise<SolanaVerifyRpc | null>;
  xrpl?: () => XrplRpc | null | Promise<XrplRpc | null>;
  stellar?: () => StellarHorizonReader | null | Promise<StellarHorizonReader | null>;
};

export type ChainMovement = {
  state: "confirmed" | "failed" | "not_found" | "unavailable";
  block: string | null;
  from: string | null;
  to: string | null;
  asset: string | null;
  amount: string | null;
};

type Supported =
  | { kind: "evm"; caip: string; chain: EvmPayChain }
  | { kind: "tempo"; caip: string }
  | { kind: "solana"; caip: string }
  | { kind: "xrpl"; caip: string }
  | { kind: "stellar"; caip: string };

export type ClassifiedNetwork = { kind: "supported"; network: Supported } | { kind: "unsupported"; caip: string };

type Leg = { from: string; to: string; asset: string; amount: bigint };

export function classifyPaymentNetwork(raw: string): ClassifiedNetwork {
  const caip = canonicalNetworkId(raw.trim());
  if (caip === TEMPO_CAIP2) return { kind: "supported", network: { kind: "tempo", caip } };
  if (caip.startsWith("eip155:")) {
    const chain = evmChainFor(caip);
    if (chain) return { kind: "supported", network: { kind: "evm", caip: chain.caip2, chain } };
  }
  if (caip.startsWith("solana:") && caip.slice("solana:".length).length >= SOLANA_REFERENCE_MIN) {
    return { kind: "supported", network: { kind: "solana", caip } };
  }
  if (caip === XRPL_MAINNET_CAIP2) return { kind: "supported", network: { kind: "xrpl", caip } };
  if (caip === STELLAR_PUBNET_CAIP2) return { kind: "supported", network: { kind: "stellar", caip } };
  return { kind: "unsupported", caip };
}

export function settlementChainOf(network: Supported): SettlementChain {
  if (network.kind === "solana") return "solana";
  if (network.kind === "xrpl") return "xrpl";
  if (network.kind === "stellar") return "stellar";
  return "evm";
}

export function isReadableTx(tx: string, network: Supported): boolean {
  return isWellFormedSettlementTx(tx, settlementChainOf(network));
}

export async function readPaymentOnChain(
  network: Supported,
  tx: string,
  payer: string | null,
  readers: PaymentProofReaders | undefined,
): Promise<ChainMovement> {
  if (network.kind === "evm") return readEvm(network.chain, tx, payer, readers?.evm);
  if (network.kind === "tempo") return readTempo(tx, payer, readers?.tempo);
  if (network.kind === "solana") return readSolana(network.caip, tx, payer, readers?.solana);
  if (network.kind === "xrpl") return readXrpl(tx, payer, readers?.xrpl);
  return readStellar(tx, payer, readers?.stellar);
}

async function callReader<T>(fn: () => T | null | Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function empty(state: ChainMovement["state"], block: string | null = null): ChainMovement {
  return { state, block, from: null, to: null, asset: null, amount: null };
}

function fromLeg(state: "confirmed" | "failed", block: string | null, leg: Leg | null): ChainMovement {
  if (!leg) return empty(state, block);
  return {
    state,
    block,
    from: leg.from,
    to: leg.to,
    asset: leg.asset,
    amount: leg.amount.toString(),
  };
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function pickLeg(legs: Leg[], payer: string | null, normalize: (s: string) => string): Leg | null {
  const positive = legs.filter((leg) => leg.amount > 0n);
  const pool = payer === null ? positive : positive.filter((leg) => normalize(leg.from) === normalize(payer));
  let best: Leg | null = null;
  for (const leg of pool) {
    if (!best || leg.amount > best.amount) best = leg;
  }
  return best;
}

type ReceiptLike = {
  status?: string;
  blockNumber?: bigint | number;
  logs?: readonly { address?: string; topics?: readonly string[]; data?: string }[];
};

async function readEvmLike(
  expectedChainId: number,
  asset: string,
  topics: readonly string[],
  tx: string,
  payer: string | null,
  client: EvmVerifyClient,
): Promise<ChainMovement> {
  const chainIdPromise = client.getChainId();
  const receiptPromise = client
    .getTransactionReceipt({ hash: tx as `0x${string}` })
    .then((receipt) => ({ ok: true as const, receipt }))
    .catch((error: unknown) => ({ ok: false as const, error }));
  let chainId: number;
  try {
    chainId = Number(await chainIdPromise);
  } catch {
    return empty("unavailable");
  }
  if (!Number.isFinite(chainId) || chainId !== expectedChainId) return empty("unavailable");
  const got = await receiptPromise;
  if (!got.ok) return receiptMissing(got.error) ? empty("not_found") : empty("unavailable");
  const receipt = got.receipt as ReceiptLike | null;
  if (!receipt) return empty("unavailable");
  const block = decimal(receipt.blockNumber);
  if (receipt.status !== "success") return empty("failed", block);
  const assetLower = asset.toLowerCase();
  const topicSet = new Set(topics.map((topic) => topic.toLowerCase()));
  const legs: Leg[] = [];
  for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== assetLower) continue;
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (!topic0 || !topicSet.has(topic0)) continue;
    const fromTopic = log.topics?.[1];
    const toTopic = log.topics?.[2];
    if (!fromTopic || !toTopic || !log.data) continue;
    let amount: bigint;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    legs.push({ from: topicToAddress(fromTopic), to: topicToAddress(toTopic), asset: assetLower, amount });
  }
  return fromLeg("confirmed", block, pickLeg(legs, payer, (s) => s.toLowerCase()));
}

async function readEvm(
  chain: EvmPayChain,
  tx: string,
  payer: string | null,
  reader: PaymentProofReaders["evm"],
): Promise<ChainMovement> {
  const client = await callReader(() => (reader ? reader(chain) : evmVerifyClientFor(chain)));
  if (!client) return empty("unavailable");
  return readEvmLike(chain.chainId, chain.usdc, [TRANSFER_TOPIC], tx, payer, client);
}

async function readTempo(tx: string, payer: string | null, reader: PaymentProofReaders["tempo"]): Promise<ChainMovement> {
  const client = await callReader(() => (reader ? reader() : defaultTempoVerifyClient()));
  if (!client) return empty("unavailable");
  return readEvmLike(TEMPO_CHAIN_ID, TEMPO_USDC_E, [TEMPO_TRANSFER_TOPIC, TEMPO_TRANSFER_WITH_MEMO_TOPIC], tx, payer, client);
}

async function readSolana(
  caip: string,
  tx: string,
  payer: string | null,
  reader: PaymentProofReaders["solana"],
): Promise<ChainMovement> {
  const rpc = await callReader(() => (reader ? reader() : createSolanaVerifyRpc()));
  if (!rpc) return empty("unavailable");
  const reference = caip.slice("solana:".length);
  let genesis: string;
  try {
    genesis = await rpc.getGenesisHash();
  } catch {
    return empty("unavailable");
  }
  if (!genesis.startsWith(reference)) return empty("unavailable");

  let status: Awaited<ReturnType<SolanaVerifyRpc["getSignatureStatus"]>>;
  try {
    status = await rpc.getSignatureStatus(tx);
  } catch {
    return empty("unavailable");
  }
  if (!status.value) return empty("not_found");
  const slot = decimal(status.value.slot);
  if (status.value.err !== null && status.value.err !== undefined) return empty("failed", slot);
  const confirmation = status.value.confirmationStatus;
  if (confirmation !== "confirmed" && confirmation !== "finalized") return empty("not_found");

  let body: Awaited<ReturnType<SolanaVerifyRpc["getTransaction"]>>;
  try {
    body = await rpc.getTransaction(tx, { maxSupportedTransactionVersion: 0 });
  } catch {
    return empty("unavailable");
  }
  if (!body) return empty("not_found");
  const block = decimal(body.slot) ?? slot;
  if (!body.meta) return empty("unavailable");
  if (body.meta.err !== null && body.meta.err !== undefined) return empty("failed", block);

  const pre = body.meta.preTokenBalances ?? [];
  const post = body.meta.postTokenBalances ?? [];
  const owners = new Set<string>();
  for (const row of [...pre, ...post]) {
    if (row.mint === SOLANA_USDC_MINT && row.owner) owners.add(row.owner);
  }
  const legs: Leg[] = [];
  let bestReceived: { owner: string; received: bigint } | null = null;
  for (const owner of owners) {
    const delta = usdcOwnerDelta(pre, post, owner, SOLANA_USDC_MINT);
    if (delta.sent > 0n) legs.push({ from: owner, to: "", asset: SOLANA_USDC_MINT, amount: delta.sent });
    if (delta.received > 0n && (!bestReceived || delta.received > bestReceived.received)) {
      bestReceived = { owner, received: delta.received };
    }
  }
  const sent = pickLeg(legs, payer, (s) => s);
  if (!sent) return empty("confirmed", block);
  const to = bestReceived && bestReceived.owner !== sent.from ? bestReceived.owner : null;
  return { state: "confirmed", block, from: sent.from, to, asset: SOLANA_USDC_MINT, amount: sent.amount.toString() };
}

async function readXrpl(tx: string, payer: string | null, reader: PaymentProofReaders["xrpl"]): Promise<ChainMovement> {
  const rpc = await callReader(() => (reader ? reader() : createXrplJsonRpc()));
  if (!rpc) return empty("unavailable");
  try {
    const info = asRec((await rpc("server_info", {})).info);
    const networkId = info?.network_id;
    if (typeof networkId === "number" && networkId !== 0) return empty("unavailable");
  } catch {
    return empty("unavailable");
  }

  const hash = tx.trim().toUpperCase();
  let raw: Record<string, unknown>;
  try {
    raw = await rpc("tx", { transaction: hash, binary: false });
  } catch (error) {
    if (/txnNotFound/.test(String(error))) return empty("not_found");
    return empty("unavailable");
  }
  const parsed = readXrplTxResponse(raw);
  const block = parsed.ledgerIndex === null ? null : String(parsed.ledgerIndex);
  if (!parsed.validated) return empty("not_found");
  if (!parsed.meta) return empty("unavailable");
  if (parsed.meta.TransactionResult !== "tesSUCCESS") return empty("failed", block);
  if (parsed.tx.TransactionType !== "Payment") return empty("confirmed", block);

  const account = typeof parsed.tx.Account === "string" ? parsed.tx.Account : null;
  const destination = typeof parsed.tx.Destination === "string" ? parsed.tx.Destination : null;
  if (payer && account !== payer) return empty("confirmed", block);
  const delivered = parsed.meta.delivered_amount ?? parsed.meta.DeliveredAmount;
  if (typeof delivered === "string" && /^\d+$/.test(delivered) && account && destination) {
    return { state: "confirmed", block, from: account, to: destination, asset: "XRP", amount: delivered };
  }
  const iou = asRec(delivered);
  if (!iou || !account || !destination) return empty("confirmed", block);
  const currency = typeof iou.currency === "string" ? iou.currency : null;
  const issuer = typeof iou.issuer === "string" ? iou.issuer : null;
  if (!currency) return empty("confirmed", block);
  const asset = isRlusdAsset(currency) ? `RLUSD:${issuer ?? RLUSD_ISSUER}` : issuer ? `${currency}:${issuer}` : currency;
  let amount: string | null = null;
  if (isRlusdAsset(currency) && issuer === RLUSD_ISSUER && typeof iou.value === "string") {
    const units = rlusdToUnitsFloor(iou.value);
    amount = units === null ? null : units.toString();
  }
  return { state: "confirmed", block, from: account, to: destination, asset, amount };
}

async function readStellar(
  tx: string,
  payer: string | null,
  reader: PaymentProofReaders["stellar"],
): Promise<ChainMovement> {
  const horizon = reader ? await callReader(() => reader()) : undefined;
  if (reader && !horizon) return empty("unavailable");
  const read = await readStellarSettlementMovement({ txHash: tx, payer }, horizon ? { horizon } : undefined);
  if (read.state === "confirmed") {
    return {
      state: "confirmed",
      block: read.block,
      from: read.from,
      to: read.to,
      asset: read.asset,
      amount: read.amount,
    };
  }
  if (read.state === "failed") return empty("failed", read.block);
  if (read.state === "not_found") return empty("not_found");
  return empty("unavailable");
}

function decimal(value: bigint | number | null | undefined): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

function asRec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

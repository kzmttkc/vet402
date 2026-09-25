/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// ENSv2 Sepolia read layer for the ENSIP-29 gate — PLAN_v4.3 §3.2.
// Imported only by ens-attestation.ts / ens.ts (the "@vet402/sdk/ens" subpath), never statically
// from index.ts or pay-or-refuse.ts, so callers that never pass a name never load viem.
//
// Rules this file enforces:
// - Two independent RPCs are mandatory. Every read runs on both at the same pinned block B and
//   the results must be byte-identical; otherwise EnsEvidenceUnavailable.
// - Records are read only through UniversalResolver.resolve(bytes name, bytes data), and the
//   answering resolver is returned with the value (a parent wildcard can answer for a child).
// - The manager is UniversalHelper.findExactOwner. findNearestOwner is never called (it returns
//   the parent's owner for an unregistered subname).
// - An empty record is empty. It is never read as "unchanged".
import { decodeAbiParameters, encodeFunctionData, getAddress, labelhash, namehash } from "viem";
import { normalize } from "viem/ens";

export const ENS_SEPOLIA_CHAIN_ID = 11155111 as const;

/** ENSv2 Sepolia (deployed 2026-09-15, measured on two RPCs 2026-09-18). */
export const ENS_SEPOLIA = {
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  universalHelper: "0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5",
  ethRegistry: "0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E",
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_HEAD_DIFF = 3n;

/**
 * The four methods the gate uses. viem's PublicClient satisfies this shape structurally;
 * a test double only has to implement these four.
 */
export type EnsRpc = {
  readContract(args: unknown): Promise<unknown>;
  getBlock(args?: unknown): Promise<{ number: bigint | null; timestamp: bigint }>;
  getBlockNumber(args?: unknown): Promise<bigint>;
  getChainId(): Promise<number>;
};

/** Two independent RPCs (different providers). */
export type EnsReadClients = { primary: EnsRpc; secondary: EnsRpc };

/** Thrown for RPC errors, disagreement between the two RPCs, stale head, wrong chain or ROOT mismatch. */
export class EnsEvidenceUnavailable extends Error {
  readonly code = "ens_evidence_unavailable" as const;
  constructor(detail: string) {
    super(`ens_evidence_unavailable: ${detail}`);
    this.name = "EnsEvidenceUnavailable";
  }
}

// ---------- ABI fragments (from the 09-15 deployment) ----------

const ROOT_REGISTRY_ABI = [
  { type: "function", name: "ROOT_REGISTRY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

const UH_ABI = [
  ...ROOT_REGISTRY_ABI,
  { type: "function", name: "findExactOwner", stateMutability: "view", inputs: [{ name: "name", type: "bytes" }], outputs: [{ name: "", type: "address" }] },
] as const;

const UR_ABI = [
  ...ROOT_REGISTRY_ABI,
  {
    type: "function", name: "resolve", stateMutability: "view",
    inputs: [{ name: "name", type: "bytes" }, { name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "bytes" }, { name: "", type: "address" }],
  },
] as const;

const REGISTRY_ABI = [
  {
    type: "function", name: "getState", stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }],
    outputs: [{
      name: "state", type: "tuple",
      components: [
        { name: "status", type: "uint8" },
        { name: "expiry", type: "uint64" },
        { name: "latestOwner", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "resource", type: "uint256" },
      ],
    }],
  },
] as const;

const RESOLVER_ABI = [
  { type: "function", name: "text", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
] as const;

// ---------- names ----------

/** ENSIP-15 normalization (throws on an invalid name). */
export function normalizeName(name: string): string {
  return normalize(name);
}

/** DNS wire format of an already-normalized name (labels of 1..255 bytes). */
export function dnsEncode(name: string): `0x${string}` {
  const enc = new TextEncoder();
  const out: number[] = [];
  for (const label of name.split(".")) {
    const b = enc.encode(label);
    if (b.length === 0 || b.length > 255) throw new Error(`dnsEncode: bad label length in ${JSON.stringify(name)}`);
    out.push(b.length, ...b);
  }
  out.push(0);
  return ("0x" + out.map((x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

// ---------- two-RPC plumbing ----------

function stable(x: unknown): string {
  return JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}

const errText = (e: unknown): string => String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e).slice(0, 200);

/** A revert (the contract answered "no"), as opposed to a transport failure. */
function revertIdentity(e: unknown): string | null {
  let cur: any = e;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.name === "ContractFunctionRevertedError") return String(cur.raw ?? cur.signature ?? cur.reason ?? "");
    cur = cur.cause;
  }
  return null;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; revert: string };

async function one<T>(c: EnsRpc, fn: (c: EnsRpc) => Promise<T>, allowRevert: boolean, side: string): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn(c) };
  } catch (e) {
    const r = allowRevert ? revertIdentity(e) : null;
    if (r !== null) return { ok: false, revert: r };
    throw new EnsEvidenceUnavailable(`${side} RPC failed: ${errText(e)}`);
  }
}

async function both<T>(clients: EnsReadClients, fn: (c: EnsRpc) => Promise<T>, allowRevert: boolean, what: string): Promise<Outcome<T>> {
  const [p, s] = await Promise.all([
    one(clients.primary, fn, allowRevert, "primary"),
    one(clients.secondary, fn, allowRevert, "secondary"),
  ]);
  if (stable(p) !== stable(s)) throw new EnsEvidenceUnavailable(`the two RPCs disagree on ${what}`);
  return p;
}

/** Run `fn` on both RPCs; any error or any byte of difference → EnsEvidenceUnavailable. */
export async function readBoth<T>(clients: EnsReadClients, fn: (c: EnsRpc) => Promise<T>, what = "a read"): Promise<T> {
  const r = await both(clients, fn, false, what);
  return (r as { ok: true; value: T }).value;
}

// ---------- step 0: pin the block ----------

export type PinnedBlock = { B: bigint; ts: bigint; heads: { primary: bigint; secondary: bigint } };

/**
 * Step 0. Both RPCs on chainId 11155111, |head1 − head2| ≤ 3, now − timestamp(B) ≤ maxHeadLagSeconds,
 * B = min(head1, head2), and at B: UniversalHelper.ROOT_REGISTRY() == UniversalResolver.ROOT_REGISTRY().
 */
export async function pinBlock(clients: EnsReadClients, maxHeadLagSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<PinnedBlock> {
  const call = async <T>(side: "primary" | "secondary", f: (c: EnsRpc) => Promise<T>): Promise<T> => {
    try {
      return await f(clients[side]);
    } catch (e) {
      throw new EnsEvidenceUnavailable(`${side} RPC failed at block pin: ${errText(e)}`);
    }
  };
  const [cp, cs] = await Promise.all([call("primary", (c) => c.getChainId()), call("secondary", (c) => c.getChainId())]);
  if (Number(cp) !== ENS_SEPOLIA_CHAIN_ID || Number(cs) !== ENS_SEPOLIA_CHAIN_ID) {
    throw new EnsEvidenceUnavailable(`chainId must be ${ENS_SEPOLIA_CHAIN_ID} on both RPCs (primary ${cp}, secondary ${cs})`);
  }
  const [hp, hs] = await Promise.all([call("primary", (c) => c.getBlockNumber()), call("secondary", (c) => c.getBlockNumber())]);
  const diff = hp > hs ? hp - hs : hs - hp;
  if (diff > MAX_HEAD_DIFF) throw new EnsEvidenceUnavailable(`heads are ${diff} blocks apart (primary ${hp}, secondary ${hs}; max ${MAX_HEAD_DIFF})`);
  const B = hp < hs ? hp : hs;
  const [bp, bs] = await Promise.all([call("primary", (c) => c.getBlock({ blockNumber: B })), call("secondary", (c) => c.getBlock({ blockNumber: B }))]);
  if (bp.timestamp !== bs.timestamp) throw new EnsEvidenceUnavailable(`block ${B} has different timestamps on the two RPCs`);
  const ts = bp.timestamp;
  const lag = BigInt(Math.floor(nowSeconds)) - ts;
  if (lag > BigInt(maxHeadLagSeconds)) throw new EnsEvidenceUnavailable(`head is ${lag}s old (max ${maxHeadLagSeconds}s)`);
  const rootUR = await readBoth(clients, (c) => c.readContract({ address: ENS_SEPOLIA.universalResolver, abi: UR_ABI, functionName: "ROOT_REGISTRY", blockNumber: B }), "UR.ROOT_REGISTRY");
  const rootUH = await readBoth(clients, (c) => c.readContract({ address: ENS_SEPOLIA.universalHelper, abi: UH_ABI, functionName: "ROOT_REGISTRY", blockNumber: B }), "UH.ROOT_REGISTRY");
  if (String(rootUR).toLowerCase() !== String(rootUH).toLowerCase()) {
    throw new EnsEvidenceUnavailable(`ROOT_REGISTRY differs at block ${B}: UR ${String(rootUR)} vs UniversalHelper ${String(rootUH)}`);
  }
  return { B, ts, heads: { primary: hp, secondary: hs } };
}

// ---------- reads at B ----------

const addrOrNull = (a: unknown): `0x${string}` | null => {
  const s = String(a ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s) || s.toLowerCase() === ZERO_ADDRESS) return null;
  return getAddress(s);
};

/** Exact owner of the (normalized) name, or null for 0x0 (unregistered, expired, RESERVED, wildcard subname). */
export async function findExactOwner(clients: EnsReadClients, B: bigint, name: string): Promise<`0x${string}` | null> {
  const dns = dnsEncode(name);
  const owner = await readBoth(clients, (c) => c.readContract({ address: ENS_SEPOLIA.universalHelper, abi: UH_ABI, functionName: "findExactOwner", args: [dns], blockNumber: B }), `findExactOwner(${name})`);
  return addrOrNull(owner);
}

async function urResolve(clients: EnsReadClients, B: bigint, name: string, data: `0x${string}`, what: string): Promise<{ result: `0x${string}`; resolver: `0x${string}` | null }> {
  const dns = dnsEncode(name);
  const r = await both(clients, (c) => c.readContract({ address: ENS_SEPOLIA.universalResolver, abi: UR_ABI, functionName: "resolve", args: [dns, data], blockNumber: B }), true, what);
  // Both RPCs agree the resolver reverted (e.g. no resolver for this name): the record is empty.
  if (!r.ok) return { result: "0x", resolver: null };
  const [result, resolver] = r.value as readonly [`0x${string}`, string];
  return { result: (result ?? "0x") as `0x${string}`, resolver: addrOrNull(resolver) };
}

/** text(name, key) through UniversalResolver.resolve, with the resolver that answered. "" when empty. */
export async function resolveText(clients: EnsReadClients, B: bigint, name: string, key: string): Promise<{ value: string; resolver: `0x${string}` | null }> {
  const data = encodeFunctionData({ abi: RESOLVER_ABI, functionName: "text", args: [namehash(name), key] });
  const { result, resolver } = await urResolve(clients, B, name, data, `text(${name}, ${key})`);
  if (result === "0x") return { value: "", resolver };
  try {
    const [value] = decodeAbiParameters([{ type: "string" }], result);
    return { value, resolver };
  } catch (e) {
    throw new EnsEvidenceUnavailable(`text(${name}, ${key}) returned undecodable bytes: ${errText(e)}`);
  }
}

/** addr(name) (coin type 60) through UniversalResolver.resolve. null when empty or 0x0. */
export async function resolveAddr(clients: EnsReadClients, B: bigint, name: string): Promise<{ value: `0x${string}` | null; resolver: `0x${string}` | null }> {
  const data = encodeFunctionData({ abi: RESOLVER_ABI, functionName: "addr", args: [namehash(name)] });
  const { result, resolver } = await urResolve(clients, B, name, data, `addr(${name})`);
  if (result === "0x") return { value: null, resolver };
  try {
    const [value] = decodeAbiParameters([{ type: "address" }], result);
    return { value: addrOrNull(value), resolver };
  } catch (e) {
    throw new EnsEvidenceUnavailable(`addr(${name}) returned undecodable bytes: ${errText(e)}`);
  }
}

/** ETHRegistry.getState(labelhash(label)) for a .eth second-level label. status 2 = registered. */
export async function getState(clients: EnsReadClients, B: bigint, label: string): Promise<{ tokenId: bigint; status: number; latestOwner: `0x${string}`; expiry: bigint }> {
  const id = BigInt(labelhash(label));
  const s = (await readBoth(clients, (c) => c.readContract({ address: ENS_SEPOLIA.ethRegistry, abi: REGISTRY_ABI, functionName: "getState", args: [id], blockNumber: B }), `getState(${label})`)) as {
    status: number | bigint; expiry: bigint | number; latestOwner: string; tokenId: bigint | number;
  };
  return {
    tokenId: BigInt(s.tokenId),
    status: Number(s.status),
    latestOwner: (addrOrNull(s.latestOwner) ?? ZERO_ADDRESS) as `0x${string}`,
    expiry: BigInt(s.expiry),
  };
}

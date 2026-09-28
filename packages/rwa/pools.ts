// Pool verification against the Uniswap deployments in config.ts (SPEC §3).
//
// v3: a Swap emitter counts only when factory.getPool(token0, token1, fee)
//     returns that same address — Sushi pools share the event signature and
//     fail this check. v4: a pool id counts only when the PoolManager emitted
//     Initialize for it with the token as currency0 or currency1.
import { TOPICS } from "./events";
import type { PoolResolver } from "./classify";
import { UNISWAP } from "./config";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from "viem";
import { getLogsFromGenesis } from "./chain";
import { padAddress, rpcBatch, rpcCall, word, type RpcOptions } from "./rpc";

const SEL = { token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43", getPool: "0x1698ee82" } as const;

export type PoolFacts = {
  v3: Record<string, { token0: string; token1: string; fee: number; fromFactory: boolean }>;
  v4: Record<string, { currency0: string; currency1: string } | null>;
};

/** Pool identity never changes, so what one request learned serves the next.
 *  Measured 2026-09-23: resolving pools was most of the ~176 RPC calls a cold
 *  reconstruction made. Kept on globalThis so both bundles share one memo. */
const sharedMemo: PoolFacts = ((globalThis as unknown as { __rwaPoolFacts?: PoolFacts }).__rwaPoolFacts ??= { v3: {}, v4: {} });

const poolKeysAbi = parseAbi(["function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"]);

/** The pool key the v4 PositionManager stored for `poolId`, if it hashes back to `poolId`; else null. */
export async function poolKeyFromPositionManager(poolId: string, opts?: RpcOptions): Promise<{ currency0: string; currency1: string } | null> {
  let raw: string;
  try {
    raw = await rpcCall<string>(
      "eth_call",
      [{ to: UNISWAP.v4PositionManager, data: encodeFunctionData({ abi: poolKeysAbi, functionName: "poolKeys", args: [poolId.slice(0, 52) as `0x${string}`] }) }, "latest"],
      opts,
    );
  } catch {
    return null;
  }
  const [currency0, currency1, fee, tickSpacing, hooks] = decodeFunctionResult({ abi: poolKeysAbi, functionName: "poolKeys", data: raw as `0x${string}` });
  const id = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [currency0, currency1, fee, tickSpacing, hooks]),
  );
  if (id.toLowerCase() !== poolId.toLowerCase()) return null;
  return { currency0: currency0.toLowerCase(), currency1: currency1.toLowerCase() };
}

/** A resolver that reads the chain and remembers what it read (the memo doubles as a fixture). */
export function chainPoolResolver(opts?: RpcOptions, memo: PoolFacts = sharedMemo): PoolResolver & { facts: PoolFacts } {
  return {
    facts: memo,
    async isUniswapV3PoolWith(pool, token) {
      const key = pool.toLowerCase();
      let f = memo.v3[key];
      if (!f) {
        let read: { token0: string; token1: string; fee: number };
        try {
          const [t0, t1, fee] = await rpcBatch<string>(
            [
              { method: "eth_call", params: [{ to: key, data: SEL.token0 }, "latest"] },
              { method: "eth_call", params: [{ to: key, data: SEL.token1 }, "latest"] },
              { method: "eth_call", params: [{ to: key, data: SEL.fee }, "latest"] },
            ],
            opts,
          );
          read = { token0: `0x${t0.slice(-40)}`, token1: `0x${t1.slice(-40)}`, fee: Number(word(fee, 0)) };
        } catch {
          // Not a v3-shaped contract at all (reverts on token0()) → not a Uniswap pool.
          memo.v3[key] = { token0: "", token1: "", fee: 0, fromFactory: false };
          return false;
        }
        const data =
          SEL.getPool +
          padAddress(read.token0).slice(2) +
          padAddress(read.token1).slice(2) +
          read.fee.toString(16).padStart(64, "0");
        const got = await rpcCall<string>("eth_call", [{ to: UNISWAP.v3Factory, data }, "latest"], opts);
        f = { ...read, fromFactory: `0x${got.slice(-40)}` === key };
        memo.v3[key] = f;
      }
      const t = token.toLowerCase();
      return f.fromFactory && (f.token0 === t || f.token1 === t);
    },
    async isUniswapV4PoolWith(poolId, token) {
      const key = poolId.toLowerCase();
      if (!(key in memo.v4)) {
        // First ask the v4 PositionManager for the pool key and accept it only if it hashes to the id
        // (PoolId = keccak256(abi.encode(PoolKey))): one eth_call, and the answer is checked, not trusted.
        // Measured 2026-09-29 on the demo address: 9 of its 10 v4 pools resolve this way. A pool that never
        // had a position minted through the PositionManager is not there; for it, walk the PoolManager's
        // Initialize logs in chunks (the provider caps the span per query).
        const fromKeys = await poolKeyFromPositionManager(key, opts);
        if (fromKeys) {
          memo.v4[key] = fromKeys;
        } else {
          const logs = await getLogsFromGenesis({ address: UNISWAP.v4PoolManager, topics: [TOPICS.univ4Initialize, key] }, opts);
          const init = logs[0];
          memo.v4[key] = init ? { currency0: `0x${init.topics[2].slice(-40)}`, currency1: `0x${init.topics[3].slice(-40)}` } : null;
        }
      }
      const p = memo.v4[key];
      const t = token.toLowerCase();
      return !!p && (p.currency0 === t || p.currency1 === t);
    },
  };
}

/** A resolver that answers only from recorded facts (offline replay of a fixture). */
export function recordedPoolResolver(facts: PoolFacts): PoolResolver {
  return {
    async isUniswapV3PoolWith(pool, token) {
      const f = facts.v3[pool.toLowerCase()];
      const t = token.toLowerCase();
      return !!f && f.fromFactory && (f.token0 === t || f.token1 === t);
    },
    async isUniswapV4PoolWith(poolId, token) {
      const p = facts.v4[poolId.toLowerCase()];
      const t = token.toLowerCase();
      return !!p && (p.currency0 === t || p.currency1 === t);
    },
  };
}

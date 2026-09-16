// Pool verification against the Uniswap deployments in config.ts (SPEC §3).
//
// v3: a Swap emitter counts only when factory.getPool(token0, token1, fee)
//     returns that same address — Sushi pools share the event signature and
//     fail this check. v4: a pool id counts only when the PoolManager emitted
//     Initialize for it with the token as currency0 or currency1.
import { TOPICS } from "./events";
import type { PoolResolver } from "./classify";
import { UNISWAP } from "./config";
import { hex, padAddress, rpcBatch, rpcCall, word, type RpcOptions } from "./rpc";

const SEL = { token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43", getPool: "0x1698ee82" } as const;

export type PoolFacts = {
  v3: Record<string, { token0: string; token1: string; fee: number; fromFactory: boolean }>;
  v4: Record<string, { currency0: string; currency1: string } | null>;
};

/** A resolver that reads the chain and remembers what it read (the memo doubles as a fixture). */
export function chainPoolResolver(opts?: RpcOptions, memo: PoolFacts = { v3: {}, v4: {} }): PoolResolver & { facts: PoolFacts } {
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
        const logs = await rpcCall<{ topics: string[] }[]>(
          "eth_getLogs",
          [{ address: UNISWAP.v4PoolManager, topics: [TOPICS.univ4Initialize, key], fromBlock: hex(0), toBlock: "latest" }],
          opts,
        );
        const init = logs[0];
        memo.v4[key] = init ? { currency0: `0x${init.topics[2].slice(-40)}`, currency1: `0x${init.topics[3].slice(-40)}` } : null;
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

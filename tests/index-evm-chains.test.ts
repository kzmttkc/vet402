// ============================================================
// Base 以外の EVM 決済索引 CLI（scripts/index-evm-chains.ts）。
//
// 引数の解釈と予算の割り算だけを見る。DB にも RPC にも繋がない。
// 公開 RPC の URL をスクリプトへ書かない規則は tests/settlements-index-bnb.test.ts と同じ。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVM_INDEX_CHAINS, isEvmChainIndexable, type EvmIndexChain } from "@/lib/settlements/index-evm";
import { budgetPerChain, parseChainsArg } from "../scripts/index-evm-chains";

const known = EVM_INDEX_CHAINS;

test("a: parseChainsArg はカンマ区切りを引数の順に返す", () => {
  const got = parseChainsArg("eip155:42220,eip155:5042", known);
  assert.deepEqual(
    got.map((chain) => chain.caip2),
    ["eip155:42220", "eip155:5042"],
  );
  assert.equal(got[0], known.find((chain) => chain.caip2 === "eip155:42220"));
  assert.equal(got[1], known.find((chain) => chain.caip2 === "eip155:5042"));
});

test("b: 空・未知の id・Base は理由が分かるメッセージで失敗する", () => {
  assert.throws(() => parseChainsArg("", known), /chains が空です/);
  assert.throws(() => parseChainsArg("   ", known), /chains が空です/);
  assert.throws(() => parseChainsArg(",", known), /chains が空です/);
  assert.throws(() => parseChainsArg("eip155:999999", known), /未知のチェーンです: eip155:999999/);
  assert.throws(() => parseChainsArg("eip155:42220,eip155:999999", known), /未知のチェーンです: eip155:999999/);
  assert.throws(
    () => parseChainsArg("eip155:8453", known),
    /eip155:8453（Base）は index-settlements が索引します/,
  );
  assert.throws(
    () => parseChainsArg("eip155:42220,eip155:8453", known),
    /eip155:8453（Base）は index-settlements が索引します/,
  );
});

test("c: 重複は先に出た 1 本にまとめる", () => {
  const got = parseChainsArg("eip155:5042,eip155:42220,eip155:5042,eip155:42220", known);
  assert.deepEqual(
    got.map((chain) => chain.caip2),
    ["eip155:5042", "eip155:42220"],
  );
  assert.equal(parseChainsArg("eip155:42220,eip155:42220", known).length, 1);
});

function stubChain(chainId: number, rpcEnv: string): EvmIndexChain {
  return {
    caip2: `eip155:${chainId}`,
    chainId,
    usdc: "0x0000000000000000000000000000000000000001",
    rpcEnv,
    maxBlocksPerRun: 1n,
    confirmations: 1n,
    blocksPerDay: 1n,
  };
}

test("d: budgetPerChain は索引できる本数で等分し、0 本でも 0 で割らない", () => {
  const envs = [0, 1, 2, 3, 4].map((i) => `INDEX_EVM_CHAINS_TEST_RPC_${i}`);
  const chains = envs.map((rpcEnv, i) => stubChain(90_000 + i, rpcEnv));
  const saved = envs.map((name) => process.env[name]);
  try {
    for (const name of envs) delete process.env[name];
    for (const name of envs.slice(0, 3)) process.env[name] = "present";
    assert.equal(chains.filter(isEvmChainIndexable).length, 3);
    assert.equal(budgetPerChain(1_200_000, chains), 400_000);
    // 割り切れないときは切り捨て。20 秒の床は付けない（渡された予算をそのまま割る）。
    assert.equal(budgetPerChain(1_000, chains), 333);

    for (const name of envs) delete process.env[name];
    assert.equal(chains.filter(isEvmChainIndexable).length, 0);
    assert.equal(budgetPerChain(1_200_000, chains), 1_200_000);
  } finally {
    envs.forEach((name, i) => {
      const prev = saved[i];
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    });
  }
});

test("e: スクリプトのソースに公開 RPC の URL（https://）を書かない", () => {
  const src = readFileSync("scripts/index-evm-chains.ts", "utf8");
  assert.equal(src.includes("https://"), false, "RPC は env から渡す。公開 RPC の URL は書かない");
});

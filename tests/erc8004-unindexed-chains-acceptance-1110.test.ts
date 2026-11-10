// ============================================================
// 要件 3.10（2026-11-10）: ERC-8004 の未索引 2 チェーン（eip155:1・eip155:56）の合格の表。
// 合格テストの文 output/1110/queue/specs_rest.md の 3.10 の節を、行ごとにここで固定する。
//
//   行 1  eip155:1 と eip155:56 のそれぞれが scanned か unavailable。not_indexed は不合格。
//   行 2  scanned のとき scannedAgents・indexBlock・matchedAgents がある。
//   行 3  読めないときは unavailable で、数を持たない（0 と書かない）。
//   行 4  scanned が小さくても 0 と書かない。
//   行 5  一致は payTo と owner または agentWallet のアドレス完全一致だけ（名前の近さで一致させない）。
//   行 6  リクエストの経路は DB だけを読む。RPC を読むのは索引のジョブ（runIdentityIndexes）。
//   行 7  erc8004.about に matched を採用や利用者数とする文が無い。
//   行 8  Base の既存の戻りは変わらない。1,125,892 と 101 を目標の数にしない。
//   行 9  Floor・Merkle の 2-of-3・MoltForest の 23,419 を作らない。購入レーンではない。
//
// 名前の近さの実 DB の試験は tests/erc8004-unindexed-chains.pg.test.ts（TEST_DATABASE_URL のときだけ）。
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zeroAddress, type Address } from "viem";
import { __setDbForTests } from "@/lib/db/client";
import {
  summarizeErc8004Match,
  readErc8004Match,
  ERC8004_ABOUT,
  ERC8004_CHAIN_MATCH_SQL_TEXT,
  ERC8004_EXTRA_CHAINS,
} from "@/lib/observatory/erc8004-match";
import {
  foldErc8004ChainLogs,
  indexErc8004Chain,
  ERC8004_CHAIN_TARGETS,
} from "@/lib/indexer/erc8004-chain-indexer";
import { erc8004ChainCheckpointScope } from "@/lib/db/erc8004-chain-index";

after(() => __setDbForTests(null));

const CHECKED = "2026-11-10T00:00:00.000Z";
const A = `0x${"aa".repeat(20)}`;
const B = `0x${"bb".repeat(20)}`;
const EXTRA = ["eip155:1", "eip155:56"] as const;

function baseInput() {
  return {
    checkedAt: CHECKED,
    scannedAgents: 40,
    indexBlock: "54500000",
    ownerMatches: [{ agentId: "7", payTo: A, purchases: 10, settled: 8 }],
    walletMatches: null,
  };
}

// ---- 行 1 ------------------------------------------------------------
test("3.10 row 1: with no chain read at all, eip155:1 and eip155:56 are unavailable, never not_indexed", () => {
  const s = summarizeErc8004Match(baseInput());
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  for (const c of EXTRA) {
    assert.notEqual(s.byChain[c].status, "not_indexed", `${c} must not be not_indexed`);
    assert.ok(s.byChain[c].status === "scanned" || s.byChain[c].status === "unavailable");
  }
  assert.deepEqual([...ERC8004_EXTRA_CHAINS], [...EXTRA]);
});

test("3.10 row 1: no code path in the reader can still write not_indexed", () => {
  const src = readFileSync("src/lib/observatory/erc8004-match.ts", "utf8");
  assert.equal(src.includes('"not_indexed"'), false);
  const openapi = readFileSync("docs/openapi.yaml", "utf8");
  const block = openapi.slice(openapi.indexOf("                  erc8004:"), openapi.indexOf("                  totalEndpoints:"));
  assert.equal(block.includes("not_indexed"), false, "the published schema no longer offers not_indexed");
  assert.match(block, /enum: \[scanned, unavailable\]/);
});

// ---- 行 2・行 4 -----------------------------------------------------
test("3.10 rows 2 and 4: a scanned chain carries scannedAgents, indexBlock and matchedAgents, and a small scan stays its size", () => {
  const s = summarizeErc8004Match({
    ...baseInput(),
    extraChains: {
      "eip155:1": {
        scannedAgents: 3,
        indexBlock: "24100000",
        ownerMatches: [{ agentId: "12", payTo: B, purchases: 4, settled: 4 }],
        walletMatches: [],
        totals: { matchedAgents: 1, matchedPayTo: 1, matchedPurchases: 4, matchedSettled: 4 },
      },
      "eip155:56": { scannedAgents: 2, indexBlock: "60000000", ownerMatches: [], walletMatches: null },
    },
  });
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  const eth = s.byChain["eip155:1"];
  assert.deepEqual(eth, { status: "scanned", scannedAgents: 3, matchedAgents: 1, indexBlock: "24100000" });
  const bnb = s.byChain["eip155:56"];
  assert.deepEqual(bnb, { status: "scanned", scannedAgents: 2, matchedAgents: 0, indexBlock: "60000000" });
  assert.ok(s.matches.some((m) => m.chainId === "eip155:1" && m.agentId === "12" && m.payTo === B));
});

// ---- 行 3 -----------------------------------------------------------
test("3.10 row 3: an unreadable chain is unavailable with a reason and no counts", () => {
  const s = summarizeErc8004Match({
    ...baseInput(),
    extraChains: { "eip155:1": { error: "query_failed" }, "eip155:56": { error: "index_not_started" } },
  });
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  for (const c of EXTRA) {
    const row: { status: string } = s.byChain[c];
    assert.equal(row.status, "unavailable");
    for (const k of ["scannedAgents", "matchedAgents", "indexBlock"]) assert.equal(k in row, false, `${c} ${k} must be absent`);
  }
  assert.equal(s.matches.some((m) => m.chainId !== "eip155:8453"), false);
});

test("3.10 row 3: readErc8004Match reads the chain index from the DB and says unavailable when the chain was never indexed", async (t) => {
  t.mock.method(console, "error", () => {});
  const queries: string[] = [];
  __setDbForTests({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ lastBlock: 54_500_000n }] }) }) }),
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      queries.push(text);
      if (text.includes("owner_agents oa")) {
        return { rows: [{ scanned_agents: "40", wallet_rows: 0, matched_agents: 0, matched_pay_to: 0, matched_purchases: "0", matched_settled: "0", top: [] }] };
      }
      if (text.includes("erc8004_chain_agents")) {
        // eip155:1 は索引の到達点が無い（ジョブが一度も走っていない）。eip155:56 は走査済み。
        const chain1 = text.includes(`"${erc8004ChainCheckpointScope("eip155:1")}"`);
        return {
          rows: [
            chain1
              ? { index_block: null, scanned_agents: "0", wallet_rows: 0, matched_agents: 0, matched_pay_to: 0, matched_purchases: "0", matched_settled: "0", top: [] }
              : { index_block: "61000000", scanned_agents: "5", wallet_rows: 1, matched_agents: 1, matched_pay_to: 1, matched_purchases: "2", matched_settled: "1", top: [{ match_kind: "owner", agent_id: "3", pay_to: A, purchases: 2, settled: 1 }] },
          ],
        };
      }
      throw new Error("unexpected query");
    },
  } as never);
  const s = await readErc8004Match();
  __setDbForTests(null);
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.deepEqual(s.byChain["eip155:1"], { status: "unavailable", reason: "index_not_started" });
  assert.deepEqual(s.byChain["eip155:56"], { status: "scanned", scannedAgents: 5, matchedAgents: 1, indexBlock: "61000000" });
  assert.equal(s.matchedAgents, 0, "the Base totals do not absorb another chain's matches");
  assert.ok(queries.filter((q) => q.includes("erc8004_chain_agents")).length === 2, "one query per chain");
});

test("3.10 row 3: a failed chain query is unavailable for that chain only and Base stays ok", async (t) => {
  t.mock.method(console, "error", () => {});
  __setDbForTests({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ lastBlock: 1n }] }) }) }),
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      if (text.includes("owner_agents oa")) {
        return { rows: [{ scanned_agents: "40", wallet_rows: 0, matched_agents: 0, matched_pay_to: 0, matched_purchases: "0", matched_settled: "0", top: [] }] };
      }
      throw new Error('relation "erc8004_chain_agents" does not exist at db.internal.example');
    },
  } as never);
  const s = await readErc8004Match();
  __setDbForTests(null);
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  for (const c of EXTRA) assert.deepEqual(s.byChain[c], { status: "unavailable", reason: "query_failed" });
  assert.equal(s.byChain["eip155:8453"].status, "scanned");
  assert.equal(JSON.stringify(s).includes("db.internal.example"), false);
});

// ---- 行 5 -----------------------------------------------------------
test("3.10 row 5: the chain match query is exact address equality on owner or agentWallet, never a near match", () => {
  const q = ERC8004_CHAIN_MATCH_SQL_TEXT.toLowerCase();
  assert.match(q, /ca\.owner = paid\.pay_to/);
  assert.match(q, /ca\.wallet = paid\.pay_to/);
  for (const bad of [" like ", " ilike ", "similarity", "levenshtein", "%", "~*", "position(", "strpos"]) {
    assert.equal(q.includes(bad), false, `query must not use ${bad.trim()}`);
  }
});

test("3.10 row 5: the index stores the exact owner and agentWallet from the chain's own events", () => {
  const T = (from: string, to: string, tokenId: bigint, blockNumber: bigint, logIndex = 0) => ({
    args: { from: from as Address, to: to as Address, tokenId },
    blockNumber,
    logIndex,
  });
  const W = (agentId: bigint, wallet: string, blockNumber: bigint, logIndex = 0) => ({
    args: { agentId, wallet: wallet as Address },
    blockNumber,
    logIndex,
  });
  const mixed = `0x${"Aa".repeat(20)}`;
  const folded = foldErc8004ChainLogs(
    [
      T(A, B, 1n, 11n), // 後の移転が勝つ（並びは逆に渡す）
      T(zeroAddress, mixed, 1n, 10n), // mint
      T(zeroAddress, A, 2n, 10n, 1),
      T(zeroAddress, B, 3n, 10n, 2),
      T(B, zeroAddress, 3n, 12n), // burn
    ],
    [W(2n, B, 13n), W(2n, A, 14n), W(1n, zeroAddress, 15n)],
  );
  const owners = new Map(folded.changes.owners.map((o) => [o.agentId.toString(), o.owner]));
  assert.equal(owners.get("1"), B, "the last Transfer wins");
  assert.equal(owners.get("2"), A.toLowerCase());
  assert.equal(owners.has("3"), false);
  assert.deepEqual(folded.changes.burned, [3n]);
  const wallets = new Map(folded.changes.wallets.map((w) => [w.agentId.toString(), w.wallet]));
  assert.equal(wallets.get("2"), A, "the last WalletSet wins");
  assert.equal(wallets.get("1"), null, "a zero agentWallet clears the binding");
  for (const o of folded.changes.owners) assert.equal(o.owner, o.owner.toLowerCase());
});

// ---- 行 6 -----------------------------------------------------------
test("3.10 row 6: the request path reads the DB only", () => {
  const src = readFileSync("src/lib/observatory/erc8004-match.ts", "utf8");
  const imported = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
  for (const spec of imported) {
    for (const bad of ["@/lib/chain/", "viem", "@/lib/indexer/", "erc8004-chain-indexer"]) {
      assert.equal(spec.includes(bad), false, `erc8004-match.ts must not import ${spec}`);
    }
  }
  for (const bad of ["createPublicClient", "getLogs", "fetch(", "multicall", "readContract"]) {
    assert.equal(src.includes(bad), false, `erc8004-match.ts must not use ${bad}`);
  }
  const route = readFileSync("src/app/api/v1/observatory/state/route.ts", "utf8");
  assert.equal(route.includes("erc8004-chain-indexer"), false);
});

test("3.10 row 6: the index job is what reads the chain, inside runIdentityIndexes", () => {
  const run = readFileSync("src/lib/indexer/identity-index-run.ts", "utf8");
  assert.match(run, /indexErc8004Chains\(/);
  assert.deepEqual(
    ERC8004_CHAIN_TARGETS.map((t) => [t.caip2, t.chainId, t.rpcEnv]),
    [
      ["eip155:1", 1, "ETHEREUM_RPC_URL"],
      ["eip155:56", 56, "BNB_RPC_URL"],
    ],
  );
});

test("3.10 row 6: without the chain's RPC the job does not read, write or move the checkpoint", async () => {
  const target = ERC8004_CHAIN_TARGETS.find((t) => t.caip2 === "eip155:1")!;
  let touched = 0;
  const r = await indexErc8004Chain(target, {
    deps: {
      env: {},
      makeClient: () => {
        touched++;
        throw new Error("not reached");
      },
      getCheckpoint: async () => {
        touched++;
        return null;
      },
      setCheckpoint: async () => {
        touched++;
      },
      applyChanges: async () => {
        touched++;
      },
    },
  });
  assert.deepEqual(r, { chain: "eip155:1", status: "skipped", reason: "ETHEREUM_RPC_URL_unset" });
  assert.equal(touched, 0);
});

test("3.10 row 6: with an RPC the job scans from the floor, writes the fold and moves its own checkpoint", async () => {
  const target = ERC8004_CHAIN_TARGETS.find((t) => t.caip2 === "eip155:56")!;
  const writes: unknown[] = [];
  const checkpoints: [string, bigint][] = [];
  const fakeClient = {
    chain: { id: 56 },
    transport: { url: "https://bnb.example" },
    // tip 1,000,114 から確定待ち 64 を引いた 1,000,050 まで読む。
    getBlockNumber: async () => 1_000_114n,
    getLogs: async (args: { events?: { name?: string }[]; fromBlock: bigint; toBlock: bigint }) => {
      assert.deepEqual(args.events?.map((e) => e.name), ["Transfer", "WalletSet"]);
      assert.ok(args.toBlock <= 1_000_050n, "never past the confirmed tip");
      if (args.fromBlock <= 1_000_010n && args.toBlock >= 1_000_010n) {
        return [{ eventName: "Transfer", args: { from: zeroAddress, to: A, tokenId: 9n }, blockNumber: 1_000_010n, logIndex: 0 }];
      }
      return [];
    },
  };
  const r = await indexErc8004Chain(target, {
    segmentBlocks: 1_000n,
    deps: {
      env: { BNB_RPC_URL: "https://bnb.example", ERC8004_BNB_FROM_BLOCK: "1000000" },
      now: () => 0,
      makeClient: () => fakeClient as never,
      getCheckpoint: async () => null,
      setCheckpoint: async (scope, last) => {
        checkpoints.push([scope, last]);
      },
      applyChanges: async (chainId, changes) => {
        writes.push([chainId, changes]);
      },
    },
  });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.fromBlock, "1000000");
  assert.equal(r.toBlock, "1000050");
  assert.equal(r.caughtUp, true);
  assert.equal(r.transferEvents, 1);
  assert.deepEqual(checkpoints.at(-1), ["identity_registry:eip155:56", 1_000_050n]);
  assert.deepEqual(writes, [[56, { owners: [{ agentId: 9n, owner: A }], burned: [], wallets: [] }]]);
});

// ---- 行 7 -----------------------------------------------------------
test("3.10 row 7: erc8004.about never calls matches adoption or users, and keeps the public English rules", () => {
  assert.doesNotMatch(ERC8004_ABOUT, /adopt|user|customer|traction|growth|popular|usage|demand/i);
  assert.doesNotMatch(ERC8004_ABOUT, /[—–;]|\bwe\b|\bour\b|\bus\b/i);
  assert.match(ERC8004_ABOUT, /Ethereum/);
  assert.match(ERC8004_ABOUT, /BNB Chain/);
  assert.match(ERC8004_ABOUT, /unavailable/);
  const route = readFileSync("src/app/api/v1/observatory/state/route.ts", "utf8");
  assert.match(route, /about: ERC8004_ABOUT/);
});

// ---- 行 8 -----------------------------------------------------------
test("3.10 row 8: the Base return is unchanged by the two new chains", () => {
  const withChains = summarizeErc8004Match({
    ...baseInput(),
    extraChains: {
      "eip155:1": { scannedAgents: 9, indexBlock: "1", ownerMatches: [{ agentId: "7", payTo: B, purchases: 99, settled: 99 }], walletMatches: [] },
      "eip155:56": { error: "query_failed" },
    },
  });
  const without = summarizeErc8004Match(baseInput());
  assert.equal(withChains.status, "ok");
  assert.equal(without.status, "ok");
  if (withChains.status !== "ok" || without.status !== "ok") return;
  assert.deepEqual(withChains.byChain["eip155:8453"], without.byChain["eip155:8453"]);
  for (const k of ["scannedAgents", "matchedAgents", "matchedPayTo", "matchedPurchases", "matchedSettled"] as const) {
    assert.equal(withChains[k], without[k], `${k} stays the Base count`);
  }
  assert.deepEqual(
    withChains.matches.filter((m) => m.chainId === "eip155:8453"),
    without.matches,
  );
});

// ---- 行 8・行 9（作らない物）--------------------------------------
test("3.10 rows 8 and 9: no Floor, Merkle 2-of-3, MoltForest 23,419, Base target number or purchase lane in the new code", () => {
  const files = [
    "src/lib/observatory/erc8004-match.ts",
    "src/lib/indexer/erc8004-chain-indexer.ts",
    "src/lib/db/erc8004-chain-index.ts",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const bad of [/\bFloor\b/, /Merkle/i, /2-of-3/, /MoltForest/i, /23[,_]?419/, /1[,_]?125[,_]?892/, /x402-payer/, /privateKey|signTypedData|sendTransaction/]) {
      assert.doesNotMatch(src, bad, `${f} must not contain ${bad}`);
    }
  }
});

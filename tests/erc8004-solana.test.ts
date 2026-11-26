// ============================================================
// WO-10 8004-solana: base58 case, Solana match SQL, indexer mock, page copy.
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setDbForTests } from "@/lib/db/client";
import {
  ERC8004_SOLANA_CAIP,
  ERC8004_SOLANA_DB_CHAIN_ID,
} from "@/lib/observatory/erc8004-solana-constants";
import {
  ERC8004_SOLANA_MATCH_SQL_TEXT,
  erc8004SolanaMatchQuery,
  summarizeErc8004Match,
  readErc8004Match,
  __setErc8004CacheForTests,
} from "@/lib/observatory/erc8004-match";
import { indexErc8004Solana } from "@/lib/indexer/erc8004-solana-indexer";
import { publicEnglishFaults } from "@/lib/diagnose/copy";
import {
  ERC8004_SOLANA_MATCH_RULE,
  ERC8004_SOLANA_NOT_COUNTED,
} from "@/lib/observatory/erc8004-solana-page";

const MIXED = "HbS8kCqQxEf9aZ3mP1nYvK2jL5wR7tU4xV6yZ8bC0dE";

after(() => {
  __setDbForTests(null);
  __setErc8004CacheForTests(null);
});

test("Solana match SQL never lowercases pay_to", () => {
  const q = ERC8004_SOLANA_MATCH_SQL_TEXT.toLowerCase();
  assert.equal(q.includes("lower(pay_to)"), false);
  assert.ok(q.includes("network"));
  assert.ok(q.includes("ca.owner = paid.pay_to"));
});

test("summarize preserves base58 case on Solana matches", () => {
  const s = summarizeErc8004Match({
    checkedAt: "2026-11-26T00:00:00.000Z",
    scannedAgents: 10,
    indexBlock: "1",
    ownerMatches: [],
    walletMatches: null,
    solanaChain: {
      scannedAgents: 100,
      indexBlock: "slot-9",
      ownerMatches: [{ agentId: "1069", payTo: MIXED, purchases: 5, settled: 4 }],
      walletMatches: [],
    },
  });
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  const m = s.matches.find((r) => r.chainId === ERC8004_SOLANA_CAIP);
  assert.ok(m);
  assert.equal(m!.payTo, MIXED, "base58 must not be lowercased");
  assert.equal(s.byChain[ERC8004_SOLANA_CAIP].status, "scanned");
});

test("unindexed Solana chain is unavailable, not zero", () => {
  const s = summarizeErc8004Match({
    checkedAt: "2026-11-26T00:00:00.000Z",
    scannedAgents: 1,
    indexBlock: "1",
    ownerMatches: [],
    walletMatches: null,
    solanaChain: { error: "index_not_started" },
  });
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  const row = s.byChain[ERC8004_SOLANA_CAIP];
  assert.deepEqual(row, { status: "unavailable", reason: "index_not_started" });
});

test("applyErc8004SolanaAgentRows writer does not lowercase owners", () => {
  const src = readFileSync("src/lib/db/erc8004-chain-index.ts", "utf8");
  const sol = src.slice(src.indexOf("applyErc8004SolanaAgentRows"), src.indexOf("export async function applyErc8004ChainAgentChanges"));
  assert.ok(sol.includes("applyErc8004SolanaAgentRows"), "writer exists");
  assert.equal(sol.includes(".toLowerCase()"), false, "Solana writer must not lower addresses");
});

test("indexErc8004Solana uses mocked fetch and writes checkpoint", async () => {
  const fetches: string[] = [];
  const checkpoints: [string, bigint][] = [];
  let applied = 0;
  const r = await indexErc8004Solana({
    deps: {
      now: () => 0,
      sleep: async () => {},
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        fetches.push(url);
        if (url.includes("/stats")) {
          return new Response(JSON.stringify({ x402Support: 244 }), { status: 200 });
        }
        return new Response(
          JSON.stringify([
            {
              agent_id: 1069,
              owner: MIXED,
              agent_wallet: null,
              block_slot: 999,
            },
          ]),
          { status: 200 },
        );
      },
      getCheckpoint: async () => null,
      setCheckpoints: async (entries) => {
        for (const e of entries) checkpoints.push([e.scope, e.lastBlock]);
      },
      applyRows: async () => {
        applied += 1;
      },
    },
  });
  assert.equal(r.status, "ok");
  assert.equal(applied, 1);
  assert.ok(fetches.some((u) => u.includes("/agents")));
  assert.ok(checkpoints.some(([s]) => s.includes("erc8004_state")));
});

test("readErc8004Match issues Solana SQL separately", async () => {
  const queries: string[] = [];
  __setDbForTests({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ lastBlock: 1n }] }) }) }),
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      queries.push(text);
      if (text.includes("last_block::text AS last_block") && text.includes("chain_tip_at_run")) return { rows: [] };
      if (text.includes("owner_agents oa")) {
        return {
          rows: [
            {
              scanned_agents: "1",
              wallet_rows: 0,
              matched_agents: 0,
              matched_pay_to: 0,
              matched_purchases: "0",
              matched_settled: "0",
              matched_pay_to_owner_only: 0,
              matched_pay_to_wallet_confirmed: 0,
              top: [],
            },
          ],
        };
      }
      if (text.includes("erc8004_chain_agents") && text.includes(String(ERC8004_SOLANA_DB_CHAIN_ID))) {
        return { rows: [{ index_block: null, scanned_agents: "0", wallet_rows: 0, matched_agents: 0, top: [] }] };
      }
      if (text.includes("erc8004_chain_agents")) {
        return { rows: [{ index_block: null, scanned_agents: "0", wallet_rows: 0, matched_agents: 0, top: [] }] };
      }
      throw new Error(`unexpected ${text.slice(0, 120)}`);
    },
  });
  const s = await readErc8004Match();
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.byChain[ERC8004_SOLANA_CAIP].status, "unavailable");
  assert.ok(queries.some((q) => q.includes(String(ERC8004_SOLANA_DB_CHAIN_ID))));
});

test("8004-solana page copy passes public English rules and omits CSV host names", () => {
  for (const line of [ERC8004_SOLANA_MATCH_RULE, ERC8004_SOLANA_NOT_COUNTED]) {
    assert.deepEqual(publicEnglishFaults(line), [], line);
  }
  const hosts = readFileSync("public/data/8004-solana-agents-hosts.csv", "utf8")
    .split("\n")
    .slice(1)
    .map((l) => l.split(",")[0])
    .filter(Boolean);
  assert.ok(hosts.length > 0);
  const pageSrc = readFileSync("src/app/8004-solana/page.tsx", "utf8");
  for (const h of hosts) {
    assert.equal(pageSrc.includes(h), false, `host must not appear in page source: ${h}`);
  }
});

test("erc8004SolanaMatchQuery binds network caip2", () => {
  const q = erc8004SolanaMatchQuery();
  const text = JSON.stringify(q);
  assert.ok(text.includes(ERC8004_SOLANA_CAIP));
});
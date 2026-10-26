// Public chain names (A-02 remainder).
// chainLabel() stays the join key in JSON `chain`. publicChainLabel() is the one
// public name. l1.byChain rows carry label and network, and the home chain table
// shows label. A settled row's label is never a raw id and never "BSC".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chainIdentity, chainLabel, chainNetwork, publicChainLabel } from "@/lib/observatory/chains";
import { SettledChainsSection, homeLedgerOf, type HomeLedgerStats } from "@/components/site/HomeLedger";

const read = (rel: string) => readFileSync(rel, "utf8");

const NAMED = [
  { chain: "Base", label: "Base", network: "eip155:8453" },
  { chain: "Solana", label: "Solana", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  { chain: "Tempo", label: "Tempo", network: "eip155:4217" },
  { chain: "XRPL", label: "XRPL", network: "xrpl:0" },
  { chain: "Celo", label: "Celo", network: "eip155:42220" },
  { chain: "Arc", label: "Arc", network: "eip155:5042" },
  { chain: "stellar:pubnet", label: "Stellar", network: "stellar:pubnet" },
  { chain: "BSC", label: "BNB Chain", network: "eip155:56" },
  { chain: "Arbitrum", label: "Arbitrum One", network: "eip155:42161" },
  { chain: "Avalanche", label: "Avalanche C-Chain", network: "eip155:43114" },
] as const;

test("publicChainLabel is the one public name and chainLabel stays the join key", () => {
  assert.equal(chainLabel("eip155:56"), "BSC");
  assert.equal(chainLabel("stellar:pubnet"), "stellar:pubnet");
  assert.equal(chainLabel("eip155:42161"), "Arbitrum");
  assert.equal(publicChainLabel("eip155:56"), "BNB Chain");
  assert.equal(publicChainLabel("BSC"), "BNB Chain");
  assert.equal(publicChainLabel("bsc"), "BNB Chain");
  assert.equal(publicChainLabel("stellar:pubnet"), "Stellar");
  assert.equal(publicChainLabel("eip155:42161"), "Arbitrum One");
  assert.equal(publicChainLabel("Arbitrum"), "Arbitrum One");
  assert.equal(chainLabel("eip155:43114"), "Avalanche");
  assert.equal(publicChainLabel("eip155:43114"), "Avalanche C-Chain");
  assert.equal(publicChainLabel("Avalanche"), "Avalanche C-Chain");
  assert.equal(publicChainLabel("avalanche"), "Avalanche C-Chain");
  assert.equal(publicChainLabel("eip155:43113"), "Avalanche Fuji");
  assert.equal(publicChainLabel("eip155:8453"), "Base");
  assert.equal(publicChainLabel("base"), "Base");
  assert.equal(publicChainLabel("eip155:999999"), "eip155:999999", "an unknown id is not renamed");
  for (const row of NAMED) {
    const id = chainIdentity(row.chain);
    assert.equal(id.chain, row.chain);
    assert.equal(id.label, row.label);
    assert.equal(id.network, row.network);
    assert.equal(chainNetwork(row.chain), row.network);
    assert.equal(id.label.includes(":"), false, id.label);
    assert.notEqual(id.label, "BSC");
  }
});

test("every settled l1.byChain row is on the top chain table by its public label", () => {
  const byChain = NAMED.map((row, i) => ({
    ...chainIdentity(row.chain),
    attempts: 10,
    settled: i + 1,
    delivered: i,
    inconclusive: 0,
    settledNonceBound: 0,
    settledAmountPayeeOnly: 0,
  }));
  const ledger = homeLedgerOf({
    totalEndpoints: 10,
    activeEndpoints: 10,
    publishedPassActive: 1,
    readAt: "2026-10-21T09:25:02.700Z",
    l1: { attempts: 100, settled: 45, delivered: 40, byChain },
  } as unknown as HomeLedgerStats);
  assert.ok(ledger);
  assert.equal(ledger.chains.length, NAMED.length);
  const html = renderToStaticMarkup(createElement(SettledChainsSection, { ledger }));
  for (const row of ledger.chains) {
    assert.equal(row.label.includes(":"), false, `${row.chain} label is a raw id`);
    assert.notEqual(row.label, "BSC", `${row.chain} label is the join key`);
    assert.ok(html.includes(`>${row.label}<`), `top chain table is missing ${row.label}`);
  }
  assert.deepEqual(
    ledger.chains.map((c) => c.label),
    NAMED.map((r) => r.label),
  );
});

test("state page and openapi publish label and network without changing chain", () => {
  const page = read("src/app/observatory/state/page.tsx");
  assert.equal((page.match(/c\.label \|\| publicChainLabel\(c\.chain\)/g) ?? []).length, 2);
  const reader = read("src/lib/observatory/reader.ts");
  assert.equal((reader.match(/chainIdentity\(chain\)/g) ?? []).length, 2);
  const yaml = read("docs/openapi.yaml");
  const l1 = yaml.slice(yaml.indexOf("byChain:\n                        type: array"));
  assert.match(l1, /label:\n\s+type: string/);
  assert.match(l1, /network:\n\s+type: string/);
  const l0 = yaml.slice(yaml.indexOf("L0 per chain"));
  assert.match(l0, /label:\n\s+type: string/);
  assert.match(l0, /network:\n\s+type: string/);
});

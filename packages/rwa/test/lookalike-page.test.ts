// The look-alike section of /rwa/[address] (SPEC patch 021), rendered to HTML offline.
//
// Run from the repo root: npx tsx --test packages/rwa/test/lookalike-page.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLookalikes, type LookalikeFixture, type LookalikesScope, type TokenMeta } from "../lookalike-scan";

// The page module is compiled with the classic JSX runtime under tsx.
(globalThis as unknown as { React: typeof React }).React = React;

const FX = JSON.parse(readFileSync(join(process.cwd(), "fixtures/rwa/lookalikes-demo.json"), "utf8")) as LookalikeFixture;
const lookalikes = buildLookalikes(FX.transfers.map((t) => ({ ...t, found_by: "fixture" as const })), new Map<string, TokenMeta>(Object.entries(FX.tokens)), FX.address, FX.counterparties);

async function render(facts: object): Promise<string> {
  const { LookalikesSection } = await import("../../../src/app/rwa/[address]/lookalikes");
  return renderToStaticMarkup(createElement(LookalikesSection, { facts }));
}

const partial: LookalikesScope = {
  complete: false,
  searched: [
    { source: "receipts", from_block: null, to_block: 76067537, detail: "the 65 transactions this record read" },
    { source: "fixture", from_block: 0, to_block: 76066086, detail: "x" },
  ],
  not_scanned: ["ERC-20 transfers in blocks 76066087-76067537, outside the transactions this record read"],
  tokens_judged: 3,
  tokens_not_judged: 0,
};

test("the demo wallet's look-alikes: hidden characters shown, poisoning in plain words, Blockscout links, not counted", async () => {
  const html = await render({ lookalikes, lookalikes_scope: partial });
  assert.match(html, /Look-alikes in this wallet&#x27;s transfers \(not counted\)/);
  assert.ok(html.includes("U⟨U+17B5⟩S⟨U+17B5⟩DG"));
  assert.ok(!html.includes("឵"), "no raw invisible character reaches the page");
  assert.match(html, /A fake USDG transfer made to look like a payment to a real counterparty/);
  assert.ok(html.includes("0x1eb96a9c"));
  assert.ok(html.includes("NVIDIA Robinhood Coin"));
  assert.ok(html.includes("https://robinhoodchain.blockscout.com/token/0x5DD716Fe12275B69f04b26bEeca343843C8e3539"));
  assert.ok(html.includes("https://robinhoodchain.blockscout.com/tx/0x1b838f40a43d54b7ce3364f08f723516170be2d03fdbcd6ab801c79f7f77b51b"));
  assert.match(html, /Not scanned: ERC-20 transfers in blocks 76066087-76067537/);
  assert.equal((html.match(/Not counted anywhere in this record/g) ?? []).length, 2);
  assert.ok(!/ALLOW|WARN|BLOCK/.test(html));
  assert.ok(!/—|;/.test(html.replace(/&[a-z#0-9]+;/gi, "")), "no em dash, no semicolon-joined sentences");
});

test("nothing found and a complete search say so", async () => {
  const html = await render({ lookalikes: [], lookalikes_scope: { ...partial, complete: true, not_scanned: [] } });
  assert.match(html, /None found in the part searched/);
  assert.match(html, /Every block up to this record was searched/);
});

test("an Alchemy search that stopped at its page cap claims no block range", async () => {
  const { scopeLine } = await import("../../../src/app/rwa/[address]/lookalikes");
  const line = scopeLine({
    complete: false,
    searched: [
      { source: "alchemy", from_block: 0, to_block: 1_000_000, detail: "alchemy_getAssetTransfers stopped at its page cap" },
      { source: "receipts", from_block: null, to_block: 1_000_000, detail: "the 3 transactions this record read" },
    ],
    not_scanned: ["transfers past Alchemy's page cap"],
    tokens_judged: 0,
    tokens_not_judged: 0,
  });
  assert.match(line, /Alchemy's transfer index up to its page cap, no block range claimed/);
  assert.ok(!line.includes("blocks 0-1000000"), line);
  assert.match(line, /Not scanned: Transfers past Alchemy's page cap/);
});

test("a complete Alchemy search still names its whole range", async () => {
  const { scopeLine } = await import("../../../src/app/rwa/[address]/lookalikes");
  const line = scopeLine({
    complete: false,
    searched: [{ source: "alchemy", from_block: 0, to_block: 900, detail: "every ERC-20 transfer to and from the wallet (alchemy_getAssetTransfers)" }],
    not_scanned: ["2 tokens met but not judged"],
    tokens_judged: 1,
    tokens_not_judged: 2,
  });
  assert.match(line, /blocks 0-900 \(indexed transfers\)/);
});

test("a record from before the search renders nothing", async () => {
  assert.equal(await render({}), "");
});

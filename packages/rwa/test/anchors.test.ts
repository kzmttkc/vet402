// The anchored records and the anchored snapshot line of /rwa/[address] (SPEC patch 025).
//
// Run from the repo root: npx tsx --test packages/rwa/test/anchors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ANCHOR_RECORDS, anchorTime, anchorsFor, newerThanAnchor, shortTx } from "../anchors";

(globalThis as unknown as { React: typeof React }).React = React;

const root = process.cwd();
const DEMO = "0xE9B08727131E34010b34006c660D4c1B436EC25f";

test("every file in fixtures/rwa/anchors/ is in ANCHOR_RECORDS with the same anchor tx", () => {
  const files = readdirSync(join(root, "fixtures/rwa/anchors")).filter((f) => f.endsWith(".json"));
  const listed = ANCHOR_RECORDS.map((r) => r.file);
  for (const f of files) {
    const path = `fixtures/rwa/anchors/${f}`;
    assert.ok(listed.includes(path), `${path} is missing from packages/rwa/anchors.ts`);
    const onDisk = JSON.parse(readFileSync(join(root, path), "utf8"));
    const entry = ANCHOR_RECORDS.find((r) => r.file === path)!;
    assert.equal(entry.anchor_tx, onDisk.anchor_tx);
    assert.equal(`${onDisk.method_version.string}-${onDisk.anchor_block}.json`, f, "the file name is <method_version>-<anchor block>");
  }
  assert.ok(listed.includes("fixtures/rwa/anchor.json"), "the 0.1 anchor stays as history");
});

test("the demo wallet's latest anchor is rwa-recon-0.3 in block 76177721, the 0.1 anchor is kept behind it", () => {
  const [latest, ...earlier] = anchorsFor(DEMO.toLowerCase());
  assert.equal(latest.method_version.string, "rwa-recon-0.3");
  assert.equal(latest.anchor_block, 76177721);
  assert.equal(latest.as_of.block_on_4663, 76177362);
  assert.equal(latest.anchor_tx, "0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f");
  assert.deepEqual(earlier.map((a) => a.method_version.string), ["rwa-recon-0.1"]);
  assert.equal(earlier[0].anchor_tx, "0x9b776d6a4670768e3e85261fcf3a5fc02012668e3323fee7211b07d8deca72d7");
});

test("newest first: method_version number, then anchor block", () => {
  const base = ANCHOR_RECORDS[1];
  const later03 = { ...base, anchor_tx: "0xlater", anchor_block: base.anchor_block + 10 };
  const older = { ...base, anchor_tx: "0xolder", anchor_block: base.anchor_block + 99, method_version: { string: "rwa-recon-0.2", number: 2 } };
  const order = anchorsFor(DEMO, [older, base, later03]).map((a) => a.anchor_tx);
  assert.deepEqual(order, ["0xlater", base.anchor_tx, "0xolder"]);
});

test("a wallet with no anchor has none", () => {
  assert.deepEqual(anchorsFor("0x0000000000000000000000000000000000000001"), []);
});

test("format helpers and the newer test", () => {
  assert.equal(anchorTime("2026-09-30T03:00:07.000Z"), "2026-09-30 03:00 UTC");
  assert.equal(shortTx("0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f"), "0x15f9…5c7f");
  const [latest] = anchorsFor(DEMO);
  assert.equal(newerThanAnchor(76177363, latest), true);
  assert.equal(newerThanAnchor(76177362, latest), false);
});

async function render(address: string, liveBlock: number): Promise<string> {
  const { AnchorNote } = await import("../../../src/app/rwa/[address]/anchor-note");
  return renderToStaticMarkup(createElement(AnchorNote, { address, liveBlock }));
}

test("the record page names the 0.3 snapshot, links its tx, and says when the page is newer", async () => {
  const html = await render(DEMO, 76200000);
  assert.ok(html.includes("Anchored snapshot: rwa-recon-0.3, as of 2026-09-30 03:00 UTC (block 76177362), anchor tx"), html);
  assert.ok(html.includes("https://robinhoodchain.blockscout.com/tx/0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f"));
  assert.ok(html.includes("0x15f9…5c7f"));
  assert.ok(html.includes("newer than the anchored snapshot"));
  assert.ok(html.includes("Earlier anchor: rwa-recon-0.1, as of 2026-09-27 21:40 UTC (block 74267752)"));
  assert.ok(html.includes("0x9b77…72d7"));
});

test("at the anchored block the page does not claim to be newer", async () => {
  const html = await render(DEMO, 76177362);
  assert.ok(!html.includes("newer than"));
  assert.ok(html.includes("at the same block as the anchored snapshot"));
});

test("a wallet with no anchor gets the plain line and no anchor link", async () => {
  const html = await render("0x6d3C1187A60B672C1AECB43a5aAEA9Abeec2b298", 76200000);
  assert.ok(html.includes("is not an anchored snapshot"));
  assert.ok(!html.includes("/tx/"));
});

test("the /rwa entry page names the latest anchor tx and its realized numbers", () => {
  const page = readFileSync(join(root, "src/app/rwa/page.tsx"), "utf8");
  const [latest] = anchorsFor(DEMO);
  const rec = JSON.parse(readFileSync(join(root, latest.file), "utf8"));
  assert.ok(page.includes(`const ANCHOR_TX = "${latest.anchor_tx}"`), "ANCHOR_TX is the latest anchor");
  assert.ok(page.includes(`block ${latest.as_of.block_on_4663}`));
  const usd = (v: string) => `${v.startsWith("-") ? "−" : "+"}$${v.replace("-", "")}`;
  assert.ok(page.includes(`<b>${usd(rec.facts.realized_usd)}</b>`), `realized total ${rec.facts.realized_usd}`);
  for (const t of rec.facts.tokens) assert.ok(page.includes(`${t.symbol} ${usd(t.realized_usd)}`), `${t.symbol} ${t.realized_usd}`);
});

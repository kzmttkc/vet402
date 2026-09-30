// Sentences of /rwa/[address] that depend on what the record holds (2026-09-30 audit).
//
// Run from the repo root: npx tsx --test packages/rwa/test/record-lines.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { heldAtBlockLine, holdingsLine, noHeldActionsLine } from "../../../src/app/rwa/[address]/lines";

(globalThis as unknown as { React: typeof React }).React = React;

const money = (usd: string) => usd;

test("a too-large wallet that holds nothing says so instead of an empty list", () => {
  assert.equal(heldAtBlockLine([], 76177362), "Holds no canonical Stock Token at block 76177362.");
  assert.equal(heldAtBlockLine(["NVDA", "QQQ"], 5), "Held at block 5: NVDA, QQQ.");
});

test("a wallet that sold out of everything reads as holding nothing now", () => {
  assert.equal(holdingsLine(0, null, money), "nothing held now, so nothing to mark");
  assert.equal(holdingsLine(1, "10.00", money), "1 Stock Token held · marked $10.00");
  assert.equal(holdingsLine(2, null, money), "2 Stock Tokens held · no complete USD mark");
});

test("no multiplier update at all has its own sentence", () => {
  assert.match(noHeldActionsLine(0), /has changed its share multiplier since it was created/);
  assert.equal(noHeldActionsLine(3), "None of these updates happened while this wallet held the token.");
});

test("no em dash and no semicolon in these sentences", () => {
  for (const s of [heldAtBlockLine([], 1), holdingsLine(0, null, money), noHeldActionsLine(0), noHeldActionsLine(1)])
    assert.ok(!/—|;/.test(s), s);
});

test("an input that is not an address gets the reason and a way back", async () => {
  const { default: RwaAddressNotFound } = await import("../../../src/app/rwa/[address]/not-found");
  const html = renderToStaticMarkup(createElement(RwaAddressNotFound));
  assert.match(html, /0x followed by 40 hex characters/);
  assert.match(html, /ENS names are not supported/);
  assert.match(html, /href="\/rwa"/);
});

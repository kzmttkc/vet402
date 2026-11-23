import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { publicEnglishFaults } from "@/lib/diagnose/copy";
import { summarizeErc8004Match } from "@/lib/observatory/erc8004-match";
import {
  ERC8004_PAGE_MATCH_RULE,
  ERC8004_PAGE_NOT_COUNTED,
  erc8004BaseTotals,
  erc8004MatchedFraction,
} from "@/lib/observatory/erc8004-page";
import { Erc8004ObservatoryView } from "@/components/observatory/Erc8004ObservatoryView";
import sitemap from "@/app/sitemap";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function sampleRead() {
  const summary = summarizeErc8004Match({
    checkedAt: "2026-11-24T00:00:00.000Z",
    scannedAgents: 1_180_301,
    indexBlock: "123",
    ownerMatches: [
      { agentId: "185", payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", purchases: 3, settled: 2 },
    ],
    walletMatches: [],
    totals: {
      matchedAgents: 185,
      matchedPayTo: 90,
      matchedPurchases: 400,
      matchedSettled: 350,
    },
    extraChains: {
      "eip155:1": {
        scannedAgents: 50_000,
        indexBlock: "1",
        ownerMatches: [],
        walletMatches: [],
        totals: { matchedAgents: 2, matchedPayTo: 2, matchedPurchases: 5, matchedSettled: 4 },
      },
      "eip155:56": {
        scannedAgents: 12_000,
        indexBlock: "1",
        ownerMatches: [],
        walletMatches: [],
        totals: { matchedAgents: 0, matchedPayTo: 0, matchedPurchases: 0, matchedSettled: 0 },
      },
    },
  });
  return { ...summary, readAt: summary.checkedAt };
}

test("erc8004 page fractions come from the reader byChain fields", () => {
  const data = sampleRead();
  assert.equal(data.status, "ok");
  const base = erc8004MatchedFraction("eip155:8453", data);
  assert.ok("fraction" in base);
  assert.equal(base.fraction, "185 of 1,180,301");
  assert.equal(base.matched, data.byChain["eip155:8453"].status === "scanned" ? data.byChain["eip155:8453"].matchedAgents : -1);
  assert.equal(base.scanned, data.scannedAgents);

  const eth = erc8004MatchedFraction("eip155:1", data);
  assert.ok("fraction" in eth);
  assert.equal(eth.fraction, "2 of 50,000");
  assert.equal(
    eth.matched,
    data.byChain["eip155:1"].status === "scanned" ? data.byChain["eip155:1"].matchedAgents : -1,
  );

  const totals = erc8004BaseTotals(data);
  assert.deepEqual(totals, {
    matchedPayTo: data.matchedPayTo,
    matchedPurchases: data.matchedPurchases,
    matchedSettled: data.matchedSettled,
  });
});

test("Erc8004ObservatoryView renders headline fraction from reader fields", () => {
  const data = sampleRead();
  const html = renderToStaticMarkup(createElement(Erc8004ObservatoryView, { data }));
  assert.match(html, /185 of 1,180,301/);
  assert.match(html, /2 of 50,000/);
  assert.match(html, /0 of 12,000/);
  assert.match(html, /href="\/api\/v1\/erc8004\/check\?/);
});

test("observatory erc8004 page module uses getErc8004MatchCached", () => {
  const src = read("src/app/observatory/erc8004/page.tsx");
  assert.match(src, /getErc8004MatchCached/);
  assert.equal(src.includes('"use client"'), false);
});

test("erc8004 page copy passes public English rules", () => {
  for (const line of [ERC8004_PAGE_MATCH_RULE, ERC8004_PAGE_NOT_COUNTED]) {
    assert.deepEqual(publicEnglishFaults(line), [], line);
  }
});

test("sitemap includes /observatory/erc8004", async () => {
  const urls = (await sitemap()).map((entry) => entry.url);
  assert.ok(urls.includes("https://vet402.com/observatory/erc8004"), "missing /observatory/erc8004");
});
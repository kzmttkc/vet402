import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPageIndexable, agentPagePath, chainSlugFor, parseAgentIdParam } from "@/lib/erc8004-pages/agents";
import { ERC8004_FAQ } from "@/app/erc-8004/page";
import { GLOSSARY } from "@/app/x402/glossary/page";

test("agentId param accepts only a decimal tokenId", () => {
  assert.equal(parseAgentIdParam("94639"), "94639");
  assert.equal(parseAgentIdParam("007"), "7");
  assert.equal(parseAgentIdParam("0"), "0");
  assert.equal(parseAgentIdParam("0x10"), null);
  assert.equal(parseAgentIdParam("1;drop"), null);
  assert.equal(parseAgentIdParam(""), null);
});

test("chain slugs map to the three indexed chains only", () => {
  assert.equal(chainSlugFor("eip155:8453"), "base");
  assert.equal(chainSlugFor("eip155:1"), "ethereum");
  assert.equal(chainSlugFor("eip155:56"), "bnb-chain");
  assert.equal(chainSlugFor("eip155:10"), null);
  assert.equal(agentPagePath({ chainId: "eip155:8453", agentId: "12" }), "/erc-8004/agents/base/12");
});

test("an agent page is indexable only with a settled purchase", () => {
  assert.equal(agentPageIndexable([{ settled: 0 }, { settled: 0 }]), false);
  assert.equal(agentPageIndexable([{ settled: 0 }, { settled: 1 }]), true);
});

test("public answer copy keeps the house rules (no we, no semicolon, no dash punctuation)", () => {
  const texts = [
    ...ERC8004_FAQ.flatMap((q) => [q.question, q.answer]),
    ...GLOSSARY.flatMap((t) => [t.term, t.text]),
  ];
  for (const t of texts) {
    assert.ok(!/\bwe\b/i.test(t), `"we" in: ${t}`);
    assert.ok(!t.includes(";"), `semicolon in: ${t}`);
    assert.ok(!/\s[\u2013\u2014-]\s/.test(t), `dash punctuation in: ${t}`);
  }
});

test("the first ERC-8004 answer defines the term in its first sentence", () => {
  assert.match(ERC8004_FAQ[0].answer, /^ERC-8004 \(Trustless Agents\) is an Ethereum standard/);
});

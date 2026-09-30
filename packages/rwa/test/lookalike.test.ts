// Look-alike judgement (SPEC patch 021). Pure, offline.
//
// Run from the repo root: npx tsx --test packages/rwa/test/lookalike.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NVDA, USDG } from "../config";
import { STOCK_TOKEN_CODE_HASH } from "../identity";
import { escapeVisible, judgeToken, mimickedCounterparty, nameKey, REASON_TEXT, stripHidden, tickerKey } from "../lookalike";
import { CANONICAL_TOKENS } from "../registry";

const OTHER_CODE = "0xb3e93523522c7151dcb0c2ad7022221cb56e7dbc8c7a304c0cc71d8e948f09e8";
const FAKE = "0x5dd716fe12275b69f04b26beeca343843c8e3539";
const KHMER = "\u17b5"; // KHMER VOWEL INHERENT AA: renders as nothing
const ZWSP = "\u200b";

const judge = (symbol: string | null, name: string | null, codeHash: string | null = OTHER_CODE, address = FAKE) => judgeToken({ address, symbol, name, codeHash });

// Seen in the demo wallet (0xE9B0...C25f), block 73953009: 25 of these arrived unasked.
test("the 'NVIDIA Robinhood Coin' NVDA is a look-alike (the Coin ending a bytecode-only check misses by name)", () => {
  const j = judge("NVDA", "NVIDIA Robinhood Coin");
  assert.equal(j.lookalike, true);
  assert.equal(j.imitates, "NVDA");
  assert.deepEqual(j.reasons, ["symbol_copies_stock_token", "name_copies_stock_token", "name_claims_robinhood_stock_token", "code_hash_differs", "not_canonical_address"]);
});

test("name endings: Token, Coin, Stock, Share, Stock Token, with or without the bullet", () => {
  for (const n of ["NVIDIA • Robinhood Token", "NVIDIA Robinhood Coin", "NVIDIA - Robinhood Stock", "NVIDIA | Robinhood Shares", "NVIDIA Robinhood Stock Token", "nvidia robinhood coin  "]) {
    const j = judge("XYZ1", n);
    assert.equal(j.lookalike, true, n);
    assert.ok(j.reasons.includes("name_claims_robinhood_stock_token"), n);
    assert.ok(j.reasons.includes("name_copies_stock_token"), n);
    assert.equal(j.imitates, "NVDA", n);
  }
  assert.equal(nameKey("NVIDIA • Robinhood Token"), "nvidia");
  assert.equal(nameKey("NVIDIA Robinhood Coin"), "nvidia");
});

// Seen in the demo wallet, block 63379129: "U\u17b5S\u17b5DG", a fake USDG transfer to an address shaped like a real counterparty.
test("USDG with invisible Khmer vowels is a USDG look-alike with hidden characters", () => {
  const sym = `U${KHMER}S${KHMER}DG`;
  assert.equal(sym.length, 6);
  assert.equal(stripHidden(sym), "USDG");
  const j = judge(sym, sym, OTHER_CODE, "0x4190ee598c2a69d35bef53c83d152ae0f25ea416");
  assert.equal(j.lookalike, true);
  assert.equal(j.imitates, "USDG");
  assert.deepEqual(j.reasons, ["imitates_usdg", "hidden_characters", "not_canonical_address"]);
});

test("zero-width characters inside a Stock Token ticker are undone and reported", () => {
  for (const sym of [`NV${ZWSP}DA`, `N\u200dVDA`, `\ufeffNVDA`, `NVDA\u2060`, `NV\u00adDA`, `N\u034fVDA`]) {
    const j = judge(sym, "Something");
    assert.equal(j.lookalike, true, escapeVisible(sym));
    assert.equal(j.imitates, "NVDA", escapeVisible(sym));
    assert.ok(j.reasons.includes("symbol_disguises_stock_token"), escapeVisible(sym));
    assert.ok(j.reasons.includes("hidden_characters"), escapeVisible(sym));
    assert.ok(!j.reasons.includes("symbol_copies_stock_token"), escapeVisible(sym));
  }
});

test("look-alike letters: digit 0 for O, Cyrillic and Greek capitals, full-width letters", () => {
  const cases: [string, string][] = [
    ["ORCL".replace("O", "0"), "ORCL"],
    ["\u0422SLA", "TSLA"], // Cyrillic TE
    ["\u0391APL", "AAPL"], // Greek ALPHA
    ["\uff2e\uff36\uff24\uff21", "NVDA"], // full-width
    ["nvda", "NVDA"],
  ];
  for (const [sym, target] of cases) {
    if (!CANONICAL_TOKENS.some((t) => t.symbol === target)) continue;
    const j = judge(sym, "x");
    assert.equal(j.lookalike, true, escapeVisible(sym));
    assert.equal(j.imitates, target, escapeVisible(sym));
    assert.ok(j.reasons.includes("symbol_disguises_stock_token"), escapeVisible(sym));
    if (sym !== "nvda") assert.ok(j.reasons.includes("confusable_characters"), escapeVisible(sym));
  }
  assert.equal(tickerKey("\u0422SLA"), "TSLA");
  assert.equal(tickerKey("0RCL"), "ORCL");
});

test("every canonical token at its own address is never a look-alike", () => {
  for (const t of CANONICAL_TOKENS) {
    const j = judgeToken({ address: t.token, symbol: t.symbol, name: `${t.name} • Robinhood Token`, codeHash: STOCK_TOKEN_CODE_HASH });
    assert.equal(j.lookalike, false, t.symbol);
    assert.equal(j.needs_review, false, t.symbol);
    assert.deepEqual(j.reasons, [], t.symbol);
  }
  // Lower-case address and an unread code hash change nothing.
  assert.equal(judgeToken({ address: NVDA.token.toLowerCase(), symbol: "NVDA", name: "NVIDIA", codeHash: null }).lookalike, false);
});

test("a canonical address whose code changed is flagged for review, not called a fake", () => {
  const j = judgeToken({ address: NVDA.token, symbol: "NVDA", name: "NVIDIA • Robinhood Token", codeHash: OTHER_CODE });
  assert.equal(j.lookalike, false);
  assert.equal(j.needs_review, true);
  assert.deepEqual(j.reasons, ["code_hash_differs"]);
});

test("the real USDG is not a look-alike", () => {
  assert.deepEqual(judgeToken({ address: USDG, symbol: "USDG", name: "Global Dollar", codeHash: OTHER_CODE }), { lookalike: false, needs_review: false, imitates: null, reasons: [] });
});

test("unrelated tokens are not look-alikes, including the demo wallet's spam", () => {
  for (const [sym, name] of [
    ["CASHCAT", "Cash Cat"],
    ["PONS", "Pons"],
    ["P0NS", "P0NS"],
    [`PO${ZWSP}NS`, `PO${ZWSP}NS`],
    ["ROL", "Robin Of Locksley"],
    ["SHERWOOD", "Sherwood"],
    ["OUTLAW", "Outlaw Coin"],
    ["WETH", "Wrapped Ether"],
    ["GREEN", "Green USD Stablecoin"],
    ["USDC", "USD Coin"],
    [null, null],
    ["", ""],
  ] as [string | null, string | null][]) {
    const j = judge(sym, name);
    assert.equal(j.lookalike, false, `${sym} ${name}`);
    assert.deepEqual(j.reasons, [], `${sym} ${name}`);
  }
});

test("the Stock Token proxy code outside the list is needs_review, not a fake and not counted", () => {
  // e.g. a delisted token, or a proxy someone pointed at the issuer's beacon
  const j = judge("WEEK", "Week • Robinhood Token", STOCK_TOKEN_CODE_HASH);
  assert.equal(j.lookalike, false);
  assert.equal(j.needs_review, true);
  assert.ok(j.reasons.includes("reference_code_not_listed"));
  assert.ok(!j.reasons.includes("code_hash_differs"));
});

test("an unread code hash still judges by name and symbol, without a code reason", () => {
  const j = judge("NVDA", "NVIDIA Robinhood Coin", null);
  assert.equal(j.lookalike, true);
  assert.ok(!j.reasons.includes("code_hash_differs"));
  assert.ok(!j.reasons.includes("reference_code_not_listed"));
});

test("address poisoning: same first four and last four hex digits as a real counterparty", () => {
  const real = "0x1eb96a9cec4ca4a2a945a99478b52bc49a6d77c3";
  const fake = "0x1eb99afad224b2523a6d6aa88b36da33b8b177c3";
  assert.equal(mimickedCounterparty(fake, [real]), real);
  assert.equal(mimickedCounterparty(real, [real]), null, "the real one is not a mimic");
  assert.equal(mimickedCounterparty(fake.toUpperCase().replace("0X", "0x"), [real]), real);
  assert.equal(mimickedCounterparty("0x1eb9000000000000000000000000000000000000", [real]), null);
  assert.equal(mimickedCounterparty(fake, []), null);
});

test("escapeVisible shows hidden and non-Latin characters and keeps the bullet", () => {
  assert.equal(escapeVisible(`U${KHMER}S${KHMER}DG`), "U⟨U+17B5⟩S⟨U+17B5⟩DG");
  assert.equal(escapeVisible(`PO${ZWSP}NS`), "PO⟨U+200B⟩NS");
  assert.equal(escapeVisible("\u041dOOD"), "⟨U+041D⟩OOD");
  assert.equal(escapeVisible("NVIDIA • Robinhood Token"), "NVIDIA • Robinhood Token");
  assert.equal(escapeVisible("\u{1d40d}"), "⟨U+1D40D⟩");
});

test("every reason has plain words", () => {
  for (const [k, v] of Object.entries(REASON_TEXT)) assert.ok(v.length > 5 && !/[;\u2014]/.test(v), k);
});

// Look-alike judgement for tokens a wallet met (SPEC patch 021). Pure: no RPC.
//
// Robinhood's own rule is that a token with a matching name or ticker at another
// address is not a Stock Token. So membership is decided by address alone
// (registry.ts), and this module only explains why a non-canonical token looks
// like one. It never decides that a token is genuine, and nothing it flags is
// ever counted in a record.
//
// A token is a look-alike when it is not at a canonical address and it copies a
// Stock Token's ticker (as written, or after stripping hidden characters and
// swapping look-alike letters), a Stock Token's company name, the "Robinhood
// Token" naming (including "Robinhood Coin" and similar endings), or USDG.
import { USDG } from "./config";
import { STOCK_TOKEN_CODE_HASH } from "./identity";
import { CANONICAL_TOKENS, tokenByAddress } from "./registry";

export type LookalikeReason =
  /** the symbol is a Stock Token ticker, exactly as written */
  | "symbol_copies_stock_token"
  /** the symbol becomes a Stock Token ticker once hidden characters, look-alike letters or case are undone */
  | "symbol_disguises_stock_token"
  /** the name, without its Robinhood ending, is a Stock Token's company name */
  | "name_copies_stock_token"
  /** the name ends like a Robinhood Stock Token ("Robinhood Token", "Robinhood Coin", "Robinhood Stock", "Robinhood Share") */
  | "name_claims_robinhood_stock_token"
  /** the symbol or name becomes USDG ("Global Dollar") once normalised, at an address that is not USDG */
  | "imitates_usdg"
  /** the symbol or name carries invisible or zero-width characters */
  | "hidden_characters"
  /** the symbol or name uses a digit or a Cyrillic/Greek letter in place of a Latin letter */
  | "confusable_characters"
  /** the runtime code is not the Stock Token proxy code */
  | "code_hash_differs"
  /** the runtime code is the Stock Token proxy code but the address is not in Robinhood's list: needs a human */
  | "reference_code_not_listed"
  /** the token's transfer was addressed to look like a real counterparty of the wallet (address poisoning) */
  | "mimics_counterparty"
  /** not a canonical address (always present on a look-alike) */
  | "not_canonical_address";

const REASON_ORDER: LookalikeReason[] = [
  "symbol_copies_stock_token",
  "symbol_disguises_stock_token",
  "name_copies_stock_token",
  "name_claims_robinhood_stock_token",
  "imitates_usdg",
  "hidden_characters",
  "confusable_characters",
  "code_hash_differs",
  "reference_code_not_listed",
  "mimics_counterparty",
  "not_canonical_address",
];

export function sortReasons(reasons: Iterable<LookalikeReason>): LookalikeReason[] {
  const set = new Set(reasons);
  return REASON_ORDER.filter((r) => set.has(r));
}

/** Characters that render as nothing: Unicode's default-ignorable set (zero-width, joiners, bidi marks,
 *  Khmer inherent vowels U+17B4/U+17B5, Hangul fillers, variation selectors, soft hyphen, BOM),
 *  format controls, and the braille blank U+2800, which renders as a space-width gap. */
const HIDDEN = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/gu;
const HAS_HIDDEN = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/u;
/** Combining marks left after NFKC (a ticker has none). */
const MARKS = /\p{Mn}/gu;

/** Letters that pass for Latin capitals in a ticker: digit zero, and Cyrillic and Greek homoglyphs. */
const CONFUSABLE: Record<string, string> = {
  "0": "O",
  // Cyrillic capitals
  "\u0410": "A", "\u0412": "B", "\u0421": "C", "\u0415": "E", "\u041d": "H", "\u0406": "I", "\u0408": "J", "\u041a": "K", "\u041c": "M", "\u041e": "O", "\u0420": "P", "\u0405": "S", "\u0422": "T", "\u0425": "X", "\u0423": "Y",
  // Cyrillic small letters
  "\u0430": "A", "\u0441": "C", "\u0435": "E", "\u0456": "I", "\u0458": "J", "\u043e": "O", "\u0440": "P", "\u0455": "S", "\u0445": "X", "\u0443": "Y",
  // Greek
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039a": "K", "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X", "\u03bf": "O", "\u03bd": "V",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "gu");
const HAS_CONFUSABLE_LETTER = new RegExp(`[${Object.keys(CONFUSABLE).filter((c) => c !== "0").join("")}]`, "u");

/** NFKC, hidden characters and combining marks removed. What a reader's eye sees. */
export function stripHidden(s: string): string {
  return s.normalize("NFKC").replace(HIDDEN, "").replace(MARKS, "");
}

/** The comparison key for a ticker: stripped, homoglyphs and 0 folded to Latin, upper case. */
export function tickerKey(s: string): string {
  return stripHidden(s).replace(CONFUSABLE_RE, (c) => CONFUSABLE[c]).toUpperCase().trim();
}

const ROBINHOOD_ENDING = /[\s•\u00b7|:\-\u2013\u2014]*\brobinhood\s*(?:stock\s*)?(?:token|coin|share|shares|stock)s?\s*$/iu;

/** The comparison key for a name: stripped, homoglyphs folded, the Robinhood ending and separators dropped, lower case. */
export function nameKey(s: string): string {
  return stripHidden(s)
    .replace(CONFUSABLE_RE, (c) => (c === "0" ? "0" : CONFUSABLE[c]))
    .replace(ROBINHOOD_ENDING, "")
    .replace(/[\s•\u00b7|:\-\u2013\u2014]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function claimsRobinhoodStockToken(name: string): boolean {
  return ROBINHOOD_ENDING.test(stripHidden(name).replace(CONFUSABLE_RE, (c) => (c === "0" ? "0" : CONFUSABLE[c])));
}

const BY_TICKER = new Map(CANONICAL_TOKENS.map((t) => [tickerKey(t.symbol), t]));
const BY_NAME = new Map(CANONICAL_TOKENS.map((t) => [nameKey(t.name), t]));
const USDG_LC = USDG.toLowerCase();

export type TokenSeen = {
  address: string;
  symbol: string | null;
  name: string | null;
  /** keccak256(eth_getCode); null when it was not read */
  codeHash: string | null;
};

export type LookalikeJudgement = {
  /** true: not canonical, and it copies a Stock Token or USDG */
  lookalike: boolean;
  /** true: carries the Stock Token proxy code at an address outside Robinhood's list; a human should look */
  needs_review: boolean;
  /** what it pretends to be: a canonical ticker, "USDG", or null */
  imitates: string | null;
  reasons: LookalikeReason[];
};

const NONE: LookalikeJudgement = { lookalike: false, needs_review: false, imitates: null, reasons: [] };

export function judgeToken(t: TokenSeen): LookalikeJudgement {
  const addr = t.address.toLowerCase();
  if (tokenByAddress(addr)) {
    // Canonical by address. A code change here is a registry problem, surfaced for review, never a look-alike.
    if (t.codeHash !== null && t.codeHash.toLowerCase() !== STOCK_TOKEN_CODE_HASH) return { ...NONE, needs_review: true, reasons: ["code_hash_differs"] };
    return NONE;
  }
  if (addr === USDG_LC) return NONE;

  const symbol = t.symbol ?? "";
  const name = t.name ?? "";
  const reasons = new Set<LookalikeReason>();
  let imitates: string | null = null;

  const exact = CANONICAL_TOKENS.find((c) => c.symbol === symbol);
  const folded = symbol ? BY_TICKER.get(tickerKey(symbol)) : undefined;
  if (exact) {
    reasons.add("symbol_copies_stock_token");
    imitates = exact.symbol;
  } else if (folded) {
    reasons.add("symbol_disguises_stock_token");
    imitates = folded.symbol;
  }
  const byName = name ? BY_NAME.get(nameKey(name)) : undefined;
  if (byName) {
    reasons.add("name_copies_stock_token");
    imitates ??= byName.symbol;
  }
  if (name && claimsRobinhoodStockToken(name)) reasons.add("name_claims_robinhood_stock_token");

  const usdg = tickerKey(symbol) === "USDG" || nameKey(name) === "global dollar";
  if (usdg) {
    reasons.add("imitates_usdg");
    imitates ??= "USDG";
  }
  if (reasons.size === 0) return NONE;

  if (HAS_HIDDEN.test(symbol) || HAS_HIDDEN.test(name) || /\p{Mn}/u.test(symbol.normalize("NFKC"))) reasons.add("hidden_characters");
  // Full-width or styled letters (full-width or mathematical bold NVDA) that NFKC folds to plain ones.
  const visibleSymbol = symbol.replace(HIDDEN, "");
  const nfkcChanged = visibleSymbol.normalize("NFKC") !== visibleSymbol;
  const zeroForO = /0/.test(symbol) && !!folded && !exact && !/0/.test(folded.symbol);
  if (nfkcChanged || zeroForO || HAS_CONFUSABLE_LETTER.test(symbol) || HAS_CONFUSABLE_LETTER.test(name)) reasons.add("confusable_characters");

  const stockTarget = imitates !== "USDG" || reasons.has("name_claims_robinhood_stock_token");
  const referenceCode = t.codeHash !== null && t.codeHash.toLowerCase() === STOCK_TOKEN_CODE_HASH;
  if (stockTarget && t.codeHash !== null && !referenceCode) reasons.add("code_hash_differs");
  reasons.add("not_canonical_address");

  if (referenceCode) {
    // The issuer's own proxy code outside the list: a delisted token, or someone pointing a proxy at the
    // issuer's beacon. Either way it is not counted, and it is not called a fake without a human look.
    reasons.add("reference_code_not_listed");
    return { lookalike: false, needs_review: true, imitates, reasons: sortReasons(reasons) };
  }
  return { lookalike: true, needs_review: false, imitates, reasons: sortReasons(reasons) };
}

/**
 * Address poisoning: a transfer to an address that shares the first four and last four hex digits of
 * a real counterparty of the wallet, without being it. Returns the real counterparty it copies, or null.
 */
export function mimickedCounterparty(to: string, counterparties: Iterable<string>): string | null {
  const t = to.toLowerCase();
  for (const c of counterparties) {
    const r = c.toLowerCase();
    if (r === t) return null;
  }
  for (const c of counterparties) {
    const r = c.toLowerCase();
    if (r.slice(2, 6) === t.slice(2, 6) && r.slice(-4) === t.slice(-4)) return r;
  }
  return null;
}

/**
 * The raw string with every code point outside printable ASCII shown as ⟨U+XXXX⟩ (the bullet in
 * "• Robinhood Token" excepted), so a hidden character or a Cyrillic letter is visible in a record.
 */
export function escapeVisible(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || cp === 0x2022) out += ch;
    else out += `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  }
  return out;
}

/** Plain words for each reason, for the /rwa page. */
export const REASON_TEXT: Record<LookalikeReason, string> = {
  symbol_copies_stock_token: "uses a Stock Token's ticker",
  symbol_disguises_stock_token: "its ticker becomes a Stock Token's once hidden or look-alike characters are removed",
  name_copies_stock_token: "uses a Stock Token's company name",
  name_claims_robinhood_stock_token: "its name ends like a Robinhood Stock Token",
  imitates_usdg: "pretends to be USDG",
  hidden_characters: "has invisible characters in its name or ticker",
  confusable_characters: "swaps in a digit or a non-Latin letter that looks the same",
  code_hash_differs: "its contract code is not the Stock Token code",
  reference_code_not_listed: "has the Stock Token code but is not in Robinhood's list",
  mimics_counterparty: "was sent to an address made to look like a real counterparty",
  not_canonical_address: "is not at an address in Robinhood's list",
};

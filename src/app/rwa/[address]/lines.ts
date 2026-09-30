// Sentences of /rwa/[address] that depend on what the record holds (2026-09-30 audit).
//
// Kept apart from page.tsx so a test can render them without a request. They
// change only what the page says. The facts JSON is untouched.
import type { EventsSummary } from "../../../../packages/rwa/classify";

/** The holdings line of a wallet too large to rebuild. An empty list is said in words. */
export function heldAtBlockLine(held: readonly string[], block: number): string {
  return held.length === 0 ? `Holds no canonical Stock Token at block ${block}.` : `Held at block ${block}: ${held.join(", ")}.`;
}

/**
 * The lines of the too-large page: the 422 detail, then the symbols held. A wallet that holds none gets the
 * detail alone, which already opens with "Holds 0 of the 195 ..." (third audit, 2026-09-30: the two lines
 * said the same thing one after the other).
 */
export function tooLargeLines(detail: string, held: readonly string[], block: number): string[] {
  return held.length === 0 ? [detail] : [detail, heldAtBlockLine(held, block)];
}

/** "78805.22" → "78,805.22" */
export function money(usd: string): string {
  const [whole, cents] = usd.replace("-", "").split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/**
 * "-273.01" → "−$273.01", "12.00" → "+$12.00". Every realized figure on the record page is written this
 * way (third audit, 2026-09-30: the summary said "−$273.01" and the Realized PnL line "-273.01 USD").
 * The JSON keeps its plain decimal string.
 */
export function signedMoney(usd: string): string {
  return `${usd.startsWith("-") ? "\u2212" : "+"}$${money(usd)}`;
}

/** The first part of the summary line. A wallet that holds nothing now has nothing to mark. */
export function holdingsLine(heldCount: number, markedUsd: string | null, money: (usd: string) => string): string {
  if (heldCount === 0) return "nothing held now, so nothing to mark";
  const tokens = `${heldCount} Stock Token${heldCount === 1 ? "" : "s"} held`;
  return `${tokens} · ${markedUsd !== null ? `marked $${money(markedUsd)}` : "no complete USD mark"}`;
}

/** Under "Corporate actions": what to say when nothing is listed in the table. */
export function noHeldActionsLine(totalActions: number): string {
  return totalActions === 0
    ? "None of the tokens above has changed its share multiplier since it was created, so there is nothing to list."
    : "None of these updates happened while this wallet held the token.";
}

/**
 * The realized part of the summary line, never a bare total when part of the sales could not be priced.
 * Only a swap sells under the method (packages/rwa/fifo.ts), so a record without a decoded swap has no
 * sale to price, and saying "sales found" there was wrong (2026-09-30 audit: a wallet that only received
 * Stock Tokens by transfer). With swaps, the JSON does not say which way they went, so the line does not
 * claim a sale either.
 */
export function realizedLine(realized: string | null, status: string, summary: EventsSummary, signed: (usd: string) => string): string {
  if (realized !== null) return status === "partial" ? `realized ${signed(realized)} on the sales that could be priced` : `realized ${signed(realized)}`;
  if (status !== "partial") return "nothing realized yet";
  const swaps = summary.univ3 + summary.univ4;
  if (swaps === 0 && summary.other_unparsed === 0) return "no sales yet";
  return "no priced sale yet";
}

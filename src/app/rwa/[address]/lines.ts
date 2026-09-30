// Sentences of /rwa/[address] that depend on what the record holds (2026-09-30 audit).
//
// Kept apart from page.tsx so a test can render them without a request. They
// change only what the page says. The facts JSON is untouched.

/** The holdings line of a wallet too large to rebuild. An empty list is said in words. */
export function heldAtBlockLine(held: readonly string[], block: number): string {
  return held.length === 0 ? `Holds no canonical Stock Token at block ${block}.` : `Held at block ${block}: ${held.join(", ")}.`;
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

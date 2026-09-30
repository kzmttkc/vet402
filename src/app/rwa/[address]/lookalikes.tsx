// The look-alike section of /rwa/[address] (SPEC patch 021).
//
// Tokens that copy a Stock Token or USDG, found in the wallet's transfers. They
// are listed so a reader can see them, and they are never counted. Hidden
// characters arrive already escaped as their code point (packages/rwa/lookalike.ts).
import { REASON_TEXT } from "../../../../packages/rwa/lookalike";
import type {
  LookalikeFact,
  LookalikesScope,
} from "../../../../packages/rwa/lookalike-scan";

const EXPLORER = "https://robinhoodchain.blockscout.com";

const short = (a: string) => `${a.slice(0, 10)}\u2026${a.slice(-4)}`;

/** What the look-alike search covered, in plain words. */
export function scopeLine(scope: LookalikesScope): string {
  if (scope.complete && scope.searched.some((s) => s.source === "alchemy"))
    return "Searched: every ERC-20 transfer to and from this wallet.";
  const parts = scope.searched.map((s) =>
    s.source === "receipts"
      ? s.detail
      : s.source === "recent_logs"
        ? `recent blocks ${s.from_block}-${s.to_block}`
        : s.source === "fixture"
          ? `blocks ${s.from_block}-${s.to_block} (a full search done ahead of time)`
          : s.detail.includes("page cap")
            ? "Alchemy's transfer index up to its page cap, no block range claimed"
            : `blocks ${s.from_block}-${s.to_block} (indexed transfers)`,
  );
  const searched = parts.length > 0 ? `Searched: ${parts.join(", ")}.` : "";
  const notSearched =
    scope.not_scanned.length > 0
      ? ` Not scanned: ${scope.not_scanned.map((n) => n.charAt(0).toUpperCase() + n.slice(1)).join(". ")}.`
      : " Every block up to this record was searched.";
  return `${searched}${notSearched}`;
}

function LookalikeItem({ l }: { l: LookalikeFact }) {
  const poisoning = l.reasons.includes("mimics_counterparty") && l.mimics;
  return (
    <li className="mt-3">
      <p>
        <a
          className="font-mono underline"
          href={`${EXPLORER}/token/${l.token}`}
          rel="noreferrer"
          target="_blank"
        >
          {l.symbol_raw || "(no symbol)"}
        </a>{" "}
        {l.name_raw && l.name_raw !== l.symbol_raw && <span className="font-mono">&quot;{l.name_raw}&quot;</span>}
        {l.imitates && <> pretends to be {l.imitates}.</>}
        {l.needs_review && <> Needs a human look before it is called a fake.</>}
      </p>
      {poisoning ? (
        <p className="mt-1">
          A fake {l.imitates ?? "token"} transfer made to look like a payment to
          a real counterparty. The log shows this wallet sending to{" "}
          <span className="font-mono">{short(l.counterparty)}</span>, which
          copies the start and end of{" "}
          <span className="font-mono">{short(l.mimics!)}</span>, an address this
          wallet really exchanged USDG with.
        </p>
      ) : (
        <p className="mt-1">
          {l.direction === "received"
            ? "Sent to this wallet by"
            : "A log shows this wallet sending it to"}{" "}
          <span className="font-mono">{short(l.counterparty)}</span>.
        </p>
      )}
      <p className="mt-1">
        Why: {l.reasons.map((r) => REASON_TEXT[r]).join(", ")}. First seen at
        block {l.first_seen_block} in{" "}
        <a
          className="font-mono underline"
          href={`${EXPLORER}/tx/${l.tx}`}
          rel="noreferrer"
          target="_blank"
        >
          {l.tx.slice(0, 10)}…
        </a>
        {l.transfers_seen > 1 && <> ({l.transfers_seen} transfers)</>}. Not
        counted anywhere in this record.
      </p>
    </li>
  );
}

/** Renders nothing for a record made before look-alikes were searched. */
export function LookalikesSection({
  facts,
}: {
  facts: { lookalikes?: LookalikeFact[]; lookalikes_scope?: LookalikesScope };
}) {
  if (!facts.lookalikes_scope || !facts.lookalikes) return null;
  const lookalikes = facts.lookalikes;
  return (
    <>
      <h2 className="mt-8 text-lg font-semibold">
        Look-alikes in this wallet&apos;s transfers (not counted)
      </h2>
      <p className="mt-2 text-sm">
        Tokens that copy a Stock Token&apos;s ticker or name, or USDG, at an
        address outside Robinhood&apos;s list. Hidden characters are shown as
        their code point, for example &#x27E8;U+17B5&#x27E9;.
        {lookalikes.length === 0 && " None found in the part searched."}
      </p>
      {lookalikes.length > 0 && (
        <ul className="text-sm">
          {lookalikes.map((l) => (
            <LookalikeItem key={`${l.token}:${l.tx}`} l={l} />
          ))}
        </ul>
      )}
      <p className="mt-2 text-sm">{scopeLine(facts.lookalikes_scope)}</p>
    </>
  );
}

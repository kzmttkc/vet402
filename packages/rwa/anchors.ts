// The anchored records in fixtures/rwa/ (SPEC patch 025).
//
// Every record that anchor.ts committed to RwaAnchor on Robinhood Chain is kept
// as a file and never rewritten: fixtures/rwa/anchor.json is the 0.1 anchor of
// 2026-09-27, and fixtures/rwa/anchors/<method_version>-<block>.json holds the
// later ones. The list below imports each file, and a test fails when a file in
// fixtures/rwa/anchors/ is missing from it, so a new anchor cannot be left out.
//
// The record page shows the latest anchor of the wallet it renders: the highest
// method_version number, then the highest anchor block.
import anchor01 from "../../fixtures/rwa/anchor.json";
import anchor03 from "../../fixtures/rwa/anchors/rwa-recon-0.3-76177721.json";

export type AnchorEntry = {
  /** Path from the repo root. */
  file: string;
  anchor_tx: string;
  anchor_block: number;
  method_version: { string: string; number: number };
  as_of: { iso: string; block_on_4663: number };
  facts: { address: string; as_of_block: number; method_version: string };
};

export const ANCHOR_RECORDS: readonly AnchorEntry[] = [
  { file: "fixtures/rwa/anchor.json", ...anchor01 },
  { file: "fixtures/rwa/anchors/rwa-recon-0.3-76177721.json", ...anchor03 },
];

/** The anchors of one wallet, newest first (method_version number, then anchor block). */
export function anchorsFor(address: string, records: readonly AnchorEntry[] = ANCHOR_RECORDS): AnchorEntry[] {
  const a = address.toLowerCase();
  return records
    .filter((r) => r.facts.address.toLowerCase() === a)
    .sort((x, y) => y.method_version.number - x.method_version.number || y.anchor_block - x.anchor_block);
}

/** "2026-09-30T03:00:07.000Z" -> "2026-09-30 03:00 UTC". */
export function anchorTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/** "0x15f9ed…5c7f" style: the first 6 and the last 4 characters. */
export function shortTx(tx: string): string {
  return `${tx.slice(0, 6)}…${tx.slice(-4)}`;
}

/** Whether a live record read at `liveBlock` is newer than the anchored snapshot. */
export function newerThanAnchor(liveBlock: number, anchor: AnchorEntry): boolean {
  return liveBlock > anchor.as_of.block_on_4663;
}

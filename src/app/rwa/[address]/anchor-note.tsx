// The anchored snapshot line of /rwa/[address] (SPEC patch 025).
//
// The page is recomputed from the chain. When the wallet has an anchored record
// in fixtures/rwa/, this names the latest one (method, as-of time and block,
// anchor tx), says whether the page is newer, and keeps the earlier anchors as
// one history line each.
import { anchorTime, anchorsFor, newerThanAnchor, shortTx } from "../../../../packages/rwa/anchors";

const EXPLORER = "https://robinhoodchain.blockscout.com";

export function AnchorNote({ address, liveBlock }: { address: string; liveBlock: number }) {
  const [latest, ...earlier] = anchorsFor(address);
  if (!latest) return <p className="mt-1 text-sm">This page is recomputed from the chain and is not an anchored snapshot.</p>;
  const newer = newerThanAnchor(liveBlock, latest);
  return (
    <>
      <p className="mt-1 text-sm">
        Anchored snapshot: {latest.method_version.string}, as of {anchorTime(latest.as_of.iso)} (block{" "}
        {latest.as_of.block_on_4663}), anchor tx{" "}
        <a className="underline" href={`${EXPLORER}/tx/${latest.anchor_tx}`} rel="noreferrer" target="_blank">
          {shortTx(latest.anchor_tx)}
        </a>
        . Its hash is recomputed from that record, not from this page.
      </p>
      <p className="mt-1 text-sm">
        {newer
          ? "This page is recomputed from the chain and is newer than the anchored snapshot."
          : liveBlock === latest.as_of.block_on_4663
            ? "This page is recomputed from the chain at the same block as the anchored snapshot."
            : "This page is recomputed from the chain and is older than the anchored snapshot."}
      </p>
      {earlier.map((a) => (
        <p key={a.anchor_tx} className="mt-1 text-sm">
          Earlier anchor: {a.method_version.string}, as of {anchorTime(a.as_of.iso)} (block {a.as_of.block_on_4663}), tx{" "}
          <a className="underline" href={`${EXPLORER}/tx/${a.anchor_tx}`} rel="noreferrer" target="_blank">
            {shortTx(a.anchor_tx)}
          </a>
          .
        </p>
      ))}
    </>
  );
}

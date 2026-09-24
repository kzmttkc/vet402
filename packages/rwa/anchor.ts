// The commitment vet402 /rwa anchors on chain (SPEC §9).
//
//   factsHash = keccak256(method_version | address | as_of | r1_status | realized_usd_or_null)
//
// The point is that a reader can recompute it. So the preimage is written out as
// plain text with a separator that cannot appear in any field, the fields are
// taken verbatim from the published facts JSON, and `realized_usd` is the string
// "null" when there is none — never an empty string, which would collide with a
// zero-length value. Anything clever here would make the hash unverifiable.
import { keccak256, toHex } from "viem";
import type { RwaFacts } from "./facts";

/** Field separator: a newline cannot occur inside any of the five fields. */
const SEP = "\n";

export type AnchorPreimage = {
  method_version: string;
  address: string;
  as_of: string;
  r1_status: string;
  realized_usd: string;
};

/** The five fields, in the order SPEC §9 lists them, as they appear in the facts JSON. */
export function anchorPreimage(facts: RwaFacts): AnchorPreimage {
  return {
    method_version: facts.method_version,
    address: facts.address.toLowerCase(),
    as_of: facts.as_of,
    r1_status: facts.r1_status,
    realized_usd: facts.realized_usd ?? "null",
  };
}

export function preimageString(p: AnchorPreimage): string {
  return [p.method_version, p.address, p.as_of, p.r1_status, p.realized_usd].join(SEP);
}

export function factsHash(facts: RwaFacts): `0x${string}` {
  return keccak256(toHex(preimageString(anchorPreimage(facts))));
}

/** keccak256 of the lower-cased address: what the event indexes, so a reader can filter by wallet. */
export function subjectHash(address: string): `0x${string}` {
  return keccak256(toHex(address.toLowerCase()));
}

/** rwa-recon-0.1 → 1. A method version that is not a known one throws rather than anchoring an ambiguous number. */
export function methodVersionNumber(methodVersion: string): number {
  const known: Record<string, number> = { "rwa-recon-0.1": 1 };
  const n = known[methodVersion];
  if (n === undefined) throw new Error(`unknown method_version ${methodVersion}; add it to anchor.ts before anchoring`);
  return n;
}

export function asOfSeconds(facts: RwaFacts): bigint {
  return BigInt(Math.floor(Date.parse(facts.as_of) / 1000));
}

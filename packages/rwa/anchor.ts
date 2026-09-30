// The commitment vet402 /rwa anchors on chain (SPEC §9, SPEC patch 023).
//
//   v1 (method_version rwa-recon-0.1 and 0.2):
//     factsHash = keccak256(method_version | address | as_of | r1_status | realized_usd_or_null)
//   v2 (method_version rwa-recon-0.3 and later):
//     factsHash = keccak256(method_version | address | as_of | r1_status | realized_usd_or_null | facts_json_keccak)
//     facts_json_keccak = keccak256(canonical JSON of the whole facts record)
//
// v1 binds five fields and leaves `tokens` and `evidence` unbound. v2 adds a
// sixth field that binds every byte of the record. Which one applies is read
// from the record's own method_version, so the 0.1 anchor still verifies as it
// was written.
//
// The point is that a reader can recompute it. So the preimage is written out as
// plain text with a separator that cannot appear in any field, the fields are
// taken verbatim from the published facts JSON, and `realized_usd` is the string
// "null" when there is none, never an empty string, which would collide with a
// zero-length value. Anything clever here would make the hash unverifiable.
import { keccak256, toHex } from "viem";
import type { RwaFacts } from "./facts";

/** Field separator: a newline cannot occur inside any of the fields. */
const SEP = "\n";

/** RwaAnchor on Robinhood Chain (4663). Every anchor since 2026-09-27 is a log of this one contract. */
export const RWA_ANCHOR_ADDRESS = "0x1955137e7773f2459eb75fb88842026c6517c22d";
export const RWA_ANCHOR_CHAIN_ID = 4663;

export type AnchorPreimage = {
  method_version: string;
  address: string;
  as_of: string;
  r1_status: string;
  realized_usd: string;
  /** v2 only: keccak256 of the canonical facts JSON */
  facts_json_keccak?: string;
};

export type HashMaterial = 1 | 2;

/**
 * The record as one string: object keys sorted, no whitespace, arrays in order,
 * strings and numbers exactly as JSON.stringify writes them, undefined members
 * left out (as JSON.stringify does). The top-level `address` is lower-cased
 * first, because the API shows it EIP-55 and the store keeps it lower-case: both
 * spellings must give one hash. Nothing else is touched.
 */
export function canonicalFactsJson(facts: unknown): string {
  const f = facts as Record<string, unknown>;
  const normalized = typeof f?.address === "string" ? { ...f, address: f.address.toLowerCase() } : f;
  return canonicalJson(normalized);
}

export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw new Error("canonical JSON: non-finite number");
      return JSON.stringify(v);
    case "object": {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON: cannot encode ${typeof v}`);
  }
}

/** keccak256 of the UTF-8 bytes of canonicalFactsJson(facts). */
export function factsJsonKeccak(facts: RwaFacts): `0x${string}` {
  return keccak256(toHex(canonicalFactsJson(facts)));
}

/** rwa-recon-0.1 and 0.2 anchor with v1; 0.3 and later with v2. */
export function hashMaterial(methodVersion: string): HashMaterial {
  return methodVersionNumber(methodVersion) >= 3 ? 2 : 1;
}

/** The fields, in the order SPEC §9 lists them, as they appear in the facts JSON; v2 adds the record's own keccak. */
export function anchorPreimage(facts: RwaFacts, material: HashMaterial = hashMaterial(facts.method_version)): AnchorPreimage {
  const p: AnchorPreimage = {
    method_version: facts.method_version,
    address: facts.address.toLowerCase(),
    as_of: facts.as_of,
    r1_status: facts.r1_status,
    realized_usd: facts.realized_usd ?? "null",
  };
  if (material === 2) p.facts_json_keccak = factsJsonKeccak(facts);
  return p;
}

export function preimageString(p: AnchorPreimage): string {
  const fields = [p.method_version, p.address, p.as_of, p.r1_status, p.realized_usd];
  if (p.facts_json_keccak !== undefined) fields.push(p.facts_json_keccak);
  return fields.join(SEP);
}

/** The hash to anchor or to compare with an Anchored event. The material follows method_version. */
export function factsHash(facts: RwaFacts, material: HashMaterial = hashMaterial(facts.method_version)): `0x${string}` {
  return keccak256(toHex(preimageString(anchorPreimage(facts, material))));
}

/**
 * The v2 hash whatever the method_version: what the facts routes send in
 * `X-Facts-Hash`. For rwa-recon-0.3 and later it equals factsHash(facts).
 */
export function factsHashV2(facts: RwaFacts): `0x${string}` {
  return factsHash(facts, 2);
}

/**
 * `X-Facts-Hash` for the facts routes: the v2 hash of exactly the record in the
 * body. Never throws: if the record cannot be hashed the header is left out and
 * the response goes on, because on the paid route the answer must not fail after
 * the record is built.
 */
export function factsHashHeader(facts: RwaFacts): Record<string, string> {
  try {
    return { "X-Facts-Hash": factsHashV2(facts) };
  } catch {
    return {};
  }
}

/** keccak256 of the lower-cased address: what the event indexes, so a reader can filter by wallet. */
export function subjectHash(address: string): `0x${string}` {
  return keccak256(toHex(address.toLowerCase()));
}

/** rwa-recon-0.1 → 1, 0.2 → 2, 0.3 → 3. A method version that is not a known one throws rather than anchoring an ambiguous number. */
export function methodVersionNumber(methodVersion: string): number {
  const known: Record<string, number> = { "rwa-recon-0.1": 1, "rwa-recon-0.2": 2, "rwa-recon-0.3": 3 };
  const n = known[methodVersion];
  if (n === undefined) throw new Error(`unknown method_version ${methodVersion}; add it to anchor.ts before anchoring`);
  return n;
}

export function asOfSeconds(facts: RwaFacts): bigint {
  return BigInt(Math.floor(Date.parse(facts.as_of) / 1000));
}

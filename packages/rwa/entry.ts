import { getAddress } from "viem";

/**
 * /rwa entry: turn whatever was pasted into the one address the record page takes.
 *
 * People paste a bare address, an explorer URL or a vet402 /rwa URL. The first
 * 20-byte hex run that stands alone is the address; a 32-byte tx hash never
 * matches, because the hex around it would continue. Mixed-case input with a
 * wrong checksum is still the same address, so it is lower-cased before
 * checksumming rather than rejected.
 */
export type EntryTarget = { kind: "empty" } | { kind: "invalid" } | { kind: "go"; path: string };

const ADDRESS = /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

export function entryTarget(raw: string | string[] | undefined): EntryTarget {
  const text = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  if (!text) return { kind: "empty" };
  const m = text.match(ADDRESS);
  if (!m) return { kind: "invalid" };
  return { kind: "go", path: `/rwa/${getAddress(m[0].toLowerCase())}` };
}

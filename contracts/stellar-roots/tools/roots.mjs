// The reference tree for the Stellar roots contract, in plain Node (no dependencies).
//   node roots.mjs <rows.json>          -> {"n", "root", "rows": [{"digest", "proof"}]}
// digest = sha256(canonical JSON of the row), keys sorted, no whitespace
// leaf   = sha256(0x00 || digest)
// node   = sha256(0x01 || min(a, b) || max(a, b)); an odd node at the end of a level is carried up.
// proof  = the sibling of each level from the leaf up; a carried level has no sibling.
// The contract (src/lib.rs) folds a proof the same way; its tests use vectors printed by this file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const canon = (v) =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
      : JSON.stringify(v);

const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();

export function digestOf(row) {
  return sha(Buffer.from(canon(row), "utf8"));
}

export function tree(digests) {
  if (digests.length === 0) throw new Error("a root needs at least one row");
  let level = digests.map((d) => sha(Buffer.from([0]), d));
  const proofs = digests.map(() => []);
  let index = digests.map((_, i) => i); // position of each row's node in the current level
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        continue;
      }
      const [a, b] = Buffer.compare(level[i], level[i + 1]) <= 0 ? [level[i], level[i + 1]] : [level[i + 1], level[i]];
      next.push(sha(Buffer.from([1]), a, b));
    }
    for (let r = 0; r < index.length; r++) {
      const at = index[r];
      const sibling = at % 2 === 0 ? at + 1 : at - 1;
      if (sibling < level.length) proofs[r].push(level[sibling]);
      index[r] = Math.floor(at / 2);
    }
    level = next;
  }
  return { root: level[0], proofs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const digests = rows.map(digestOf);
  const { root, proofs } = tree(digests);
  const hex = (b) => b.toString("hex");
  console.log(
    JSON.stringify({ n: rows.length, root: hex(root), rows: digests.map((d, i) => ({ digest: hex(d), proof: proofs[i].map(hex) })) }),
  );
}

// Recompute the root: node compute_root.mjs <rows.json>. Needs viem (npm i viem).
// digest = keccak256(utf8(canonical JSON of the row)). leaf = keccak256(0x00 || digest).
// node = keccak256(0x01 || min(a,b) || max(a,b)). An odd node is carried up. Canonical JSON: keys sorted, no whitespace.
import { readFileSync } from "node:fs";
import { keccak256, toBytes, concat } from "viem";
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
let level = rows.map((r) => keccak256(concat([new Uint8Array([0]), toBytes(keccak256(toBytes(canon(r))))])));
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    if (i + 1 === level.length) { next.push(level[i]); continue; }
    const [a, b] = [level[i], level[i + 1]].sort();
    next.push(keccak256(concat([new Uint8Array([1]), toBytes(a), toBytes(b)])));
  }
  level = next;
}
console.log(JSON.stringify({ n: rows.length, root: level[0] }));

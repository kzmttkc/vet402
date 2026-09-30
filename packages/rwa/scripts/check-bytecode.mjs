#!/usr/bin/env node
// Compare the runtime bytecode forge builds from RwaAnchor.sol with the code at
// 0x1955137e7773f2459eb75fb88842026c6517c22d on Robinhood Chain (4663). No key.
//
//   (cd packages/rwa/contracts && forge build)
//   node packages/rwa/scripts/check-bytecode.mjs
//
// Two answers (match_rule in packages/rwa/contracts/onchain.json):
//   full      every byte, including the CBOR metadata tail. The tail carries an
//             IPFS hash of the compiler metadata (source text, path RwaAnchor.sol,
//             settings), so a full match pins the exact source file.
//   stripped  the same without the metadata tail. Stripped equal but full
//             different would mean the same code from another source text or path.
// Exit 0 only on a full match.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, hexToBytes, RWA_ANCHOR_ADDRESS, RUNTIME_KECCAK } from "./verify-record.mjs";

const RPCS = ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"];

function stripMetadata(hex) {
  const h = hex.toLowerCase().replace(/^0x/, "");
  const len = parseInt(h.slice(-4), 16);
  return h.slice(0, h.length - (len + 2) * 2);
}

async function getCode(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [RWA_ANCHOR_ADDRESS, "latest"] }),
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result.toLowerCase();
}

const artifactPath = join(process.cwd(), "packages/rwa/contracts/out/RwaAnchor.sol/RwaAnchor.json");
let built;
try {
  built = JSON.parse(readFileSync(artifactPath, "utf8")).deployedBytecode.object.toLowerCase();
} catch {
  console.error(`no forge build at ${artifactPath}; run: (cd packages/rwa/contracts && forge build)`);
  process.exit(2);
}

let ok = true;
let checked = 0;
for (const url of RPCS) {
  let chain;
  try {
    chain = await getCode(url);
  } catch (e) {
    console.log(`${url}: unreachable (${String(e.message ?? e).slice(0, 80)})`);
    continue;
  }
  checked++;
  const full = chain === built;
  const stripped = stripMetadata(chain) === stripMetadata(built);
  ok = ok && full;
  console.log(`${url}\n  chain runtime ${keccak256(hexToBytes(chain))} (${(chain.length - 2) / 2} bytes)\n  forge runtime ${keccak256(hexToBytes(built))} (${(built.length - 2) / 2} bytes)\n  full match ${full}  stripped match ${stripped}  pinned ${keccak256(hexToBytes(chain)) === RUNTIME_KECCAK}`);
}
if (checked === 0) console.log("no RPC answered: nothing was compared");
process.exit(ok && checked > 0 ? 0 : 1);

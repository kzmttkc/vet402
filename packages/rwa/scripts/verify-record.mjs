#!/usr/bin/env node
// Check a vet402 /rwa record against its anchor on Robinhood Chain. No key, no
// account, no npm install: plain Node 18+ and a public RPC.
//
//   node packages/rwa/scripts/verify-record.mjs --record fixtures/rwa/anchor.json --tx 0x9b77...
//   node packages/rwa/scripts/verify-record.mjs --record https://.../record.json --tx 0x...
//   node packages/rwa/scripts/verify-record.mjs --record facts.json --tx 0x... --operator 0x973c...
//
// --record is a file or an http(s) URL. It is either an anchor record (the shape
// of fixtures/rwa/anchor.json, with `facts` inside and `anchored_by`) or a bare
// facts JSON as /api/v1/rwa/facts/<address> returns it. With a bare facts JSON,
// pass --operator to say whose anchor you accept; without it the check still
// shows who wrote the log, and says it was not compared.
//
// What it checks, all from the chain and the JSON, nothing from vet402's server:
//   1. the tx succeeded and has an Anchored log emitted by RwaAnchor 0x1955...c22d
//   2. that contract's runtime code hashes to the build of RwaAnchor.sol that
//      packages/rwa/contracts/test pins (so it has no owner and no upgrade path)
//   3. anchoredBy in the log is the operator the record names (or --operator)
//   4. subject, factsHash, methodVersion and asOf in the log are recomputed from
//      the JSON. The hash material follows method_version (SPEC patch 023):
//      0.1 and 0.2 bind five fields, 0.3 and later add the keccak of the whole
//      record in canonical JSON.
// Exit code 0 only when every line says OK.
//
// This file repeats the hashing in packages/rwa/anchor.ts on purpose, with its
// own keccak, so a reader can audit one file. packages/rwa/test/verify-record.test.ts
// holds the two implementations to the same answers.
import { readFileSync } from "node:fs";

export const RWA_ANCHOR_ADDRESS = "0x1955137e7773f2459eb75fb88842026c6517c22d";
export const CHAIN_ID = 4663;
/** keccak256 of eth_getCode(RwaAnchor); packages/rwa/contracts/onchain.json and the forge test pin the same value. */
export const RUNTIME_KECCAK = "0x9032fa493b888a32b4773a18ae74814d4f492d136c4cd55ade593eb783f9b5b0";
/** keccak256("Anchored(bytes32,bytes32,uint32,uint64,address)") */
export const ANCHORED_TOPIC = "0x6e444efa5833ba2e7827d2af0e549ecabc47b47c0b03a83c17760929be369360";
const RPCS = ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"];
const METHOD_NUMBERS = { "rwa-recon-0.1": 1, "rwa-recon-0.2": 2, "rwa-recon-0.3": 3 };

// ---------------------------------------------------------------- keccak256
// Keccak-f[1600] on 32-bit halves (Ethereum keccak256: rate 136, pad 0x01...0x80).
const RC = [
  1, 0, 32898, 0, 32906, 2147483648, 2147516416, 2147483648, 32907, 0, 2147483649, 0, 2147516545, 2147483648, 32777,
  2147483648, 138, 0, 136, 0, 2147516425, 0, 2147483658, 0, 2147516555, 0, 139, 2147483648, 32905, 2147483648, 32771,
  2147483648, 32770, 2147483648, 128, 2147483648, 32778, 0, 2147483658, 2147483648, 2147516545, 2147483648, 32896,
  2147483648, 2147483649, 0, 2147516424, 2147483648,
];

function keccakF(s) {
  const c = new Array(10);
  for (let n = 0; n < 48; n += 2) {
    for (let x = 0; x < 10; x++) c[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const x1 = (x + 2) % 10, x4 = (x + 8) % 10;
      const h = c[x4] ^ ((c[x1] << 1) | (c[x1 + 1] >>> 31));
      const l = c[x4 + 1] ^ ((c[x1 + 1] << 1) | (c[x1] >>> 31));
      for (let y = 0; y < 50; y += 10) {
        s[y + x] ^= h;
        s[y + x + 1] ^= l;
      }
    }
    // rho and pi
    const b = new Array(50);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = 2 * (x + 5 * y);
        const r = ROT[x + 5 * y];
        let lo = s[i], hi = s[i + 1];
        let nlo, nhi;
        if (r === 0) { nlo = lo; nhi = hi; }
        else if (r < 32) { nlo = (lo << r) | (hi >>> (32 - r)); nhi = (hi << r) | (lo >>> (32 - r)); }
        else if (r === 32) { nlo = hi; nhi = lo; }
        else { const q = r - 32; nlo = (hi << q) | (lo >>> (32 - q)); nhi = (lo << q) | (hi >>> (32 - q)); }
        const j = 2 * (y + 5 * ((2 * x + 3 * y) % 5));
        b[j] = nlo;
        b[j + 1] = nhi;
      }
    }
    // chi
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x += 2) {
        s[y + x] = b[y + x] ^ (~b[y + ((x + 2) % 10)] & b[y + ((x + 4) % 10)]);
        s[y + x + 1] = b[y + x + 1] ^ (~b[y + ((x + 2) % 10) + 1] & b[y + ((x + 4) % 10) + 1]);
      }
    }
    // iota
    s[0] ^= RC[n];
    s[1] ^= RC[n + 1];
  }
}
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

/** keccak256 of bytes (Uint8Array) or of a string's UTF-8 bytes, as 0x-hex. */
export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padded = new Uint8Array(Math.floor(bytes.length / rate) * rate + rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(50).fill(0);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) {
      const k = off + 4 * i;
      s[i] ^= padded[k] | (padded[k + 1] << 8) | (padded[k + 2] << 16) | (padded[k + 3] << 24);
    }
    keccakF(s);
  }
  let out = "0x";
  for (let i = 0; i < 8; i++) {
    const w = s[i];
    for (let k = 0; k < 4; k++) out += ((w >>> (8 * k)) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`not hex: ${hex.slice(0, 20)}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---------------------------------------------------------------- the commitment

export function canonicalJson(v) {
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
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON: cannot encode ${typeof v}`);
  }
}

export function methodVersionNumber(mv) {
  const n = METHOD_NUMBERS[mv];
  if (n === undefined) throw new Error(`unknown method_version ${mv}`);
  return n;
}

/** Returns { material, preimage, hash, factsJsonKeccak } for a facts record. */
export function commitment(facts) {
  const material = methodVersionNumber(facts.method_version) >= 3 ? 2 : 1;
  const fields = [
    facts.method_version,
    String(facts.address).toLowerCase(),
    facts.as_of,
    facts.r1_status,
    facts.realized_usd ?? "null",
  ];
  let factsJsonKeccak = null;
  if (material === 2) {
    factsJsonKeccak = keccak256(canonicalJson({ ...facts, address: String(facts.address).toLowerCase() }));
    fields.push(factsJsonKeccak);
  }
  const preimage = fields.join("\n");
  return { material, preimage, hash: keccak256(preimage), factsJsonKeccak };
}

export function subjectHash(address) {
  return keccak256(String(address).toLowerCase());
}

// ---------------------------------------------------------------- chain reads

async function rpc(method, params, rpcs) {
  let last;
  for (const url of rpcs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.json();
        if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
        return body.result;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw last;
}

/** Decode every Anchored log in a receipt; the caller decides which emitter it trusts. */
export function anchoredLogs(receipt) {
  return (receipt.logs ?? [])
    .filter((l) => l.topics?.[0]?.toLowerCase() === ANCHORED_TOPIC && l.topics.length === 4)
    .map((l) => {
      const data = l.data.slice(2);
      return {
        address: l.address.toLowerCase(),
        subject: l.topics[1].toLowerCase(),
        factsHash: l.topics[2].toLowerCase(),
        anchoredBy: `0x${l.topics[3].slice(-40)}`.toLowerCase(),
        methodVersion: Number(BigInt(`0x${data.slice(0, 64)}`)),
        asOf: BigInt(`0x${data.slice(64, 128)}`),
      };
    });
}

// ---------------------------------------------------------------- the check

/**
 * Pure comparison, no network: `record` is an anchor record or bare facts,
 * `receipt` an eth_getTransactionReceipt result, `code` the eth_getCode result.
 * Returns the rows to print and whether all passed.
 */
export function checkRecord({ record, receipt, code, operator, contract = RWA_ANCHOR_ADDRESS }) {
  const facts = record.facts ?? record;
  const expectedBy = (operator ?? record.anchored_by ?? "").toLowerCase() || null;
  const rows = [];
  const row = (name, ok, detail) => rows.push({ name, ok, detail });

  row("tx status", receipt?.status === "0x1", receipt ? `${receipt.status === "0x1" ? "success" : "failed"} in block ${Number(BigInt(receipt.blockNumber))}` : "no receipt");
  const all = receipt ? anchoredLogs(receipt) : [];
  const log = all.find((l) => l.address === contract.toLowerCase());
  const others = all.filter((l) => l.address !== contract.toLowerCase()).length;
  row("contract", Boolean(log), log ? `Anchored log from ${log.address} (RwaAnchor)` : `no Anchored log from ${contract}${others ? `, ${others} from other addresses ignored` : ""}`);
  if (record.contract && record.contract.toLowerCase() !== contract.toLowerCase()) {
    row("record contract", false, `record names ${record.contract}, expected ${contract}`);
  }
  const codeHash = code && code !== "0x" ? keccak256(hexToBytes(code)) : null;
  row("contract code", codeHash === RUNTIME_KECCAK, codeHash === RUNTIME_KECCAK ? "runtime equals the build of RwaAnchor.sol: no owner, no upgrade path" : `runtime keccak ${codeHash ?? "none"} != ${RUNTIME_KECCAK}`);

  let c;
  try {
    c = commitment(facts);
  } catch (e) {
    row("method", false, String(e.message ?? e));
    return { ok: false, rows, facts };
  }
  if (!log) return { ok: false, rows, facts, commitment: c };

  if (expectedBy) {
    row("anchoredBy", log.anchoredBy === expectedBy, `${log.anchoredBy}${log.anchoredBy === expectedBy ? "" : ` != expected ${expectedBy}`}`);
  } else {
    row("anchoredBy", true, `${log.anchoredBy} (not compared: pass --operator to require one)`);
  }
  const subj = subjectHash(facts.address);
  row("subject", log.subject === subj, `${short(log.subject)} = keccak(${String(facts.address).toLowerCase()})${log.subject === subj ? "" : ` recomputed ${short(subj)}`}`);
  row("factsHash", log.factsHash === c.hash, `${short(log.factsHash)} ${log.factsHash === c.hash ? "=" : "!="} recomputed ${short(c.hash)} (material v${c.material}${c.material === 2 ? ", binds the whole JSON" : ", five fields"})`);
  if (record.facts_hash) {
    row("record facts_hash", record.facts_hash.toLowerCase() === c.hash, `record says ${short(record.facts_hash)}`);
  }
  const mvn = methodVersionNumber(facts.method_version);
  row("methodVersion", log.methodVersion === mvn, `${log.methodVersion} = ${facts.method_version}${log.methodVersion === mvn ? "" : ` (expected ${mvn})`}`);
  const asOf = BigInt(Math.floor(Date.parse(facts.as_of) / 1000));
  row("asOf", log.asOf === asOf, `${log.asOf} = ${facts.as_of}${log.asOf === asOf ? "" : ` (record gives ${asOf})`}`);
  return { ok: rows.every((r) => r.ok), rows, facts, commitment: c, log };
}

function short(h) {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : String(h);
}

async function loadRecord(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET ${src}: HTTP ${res.status}`);
    return { json: await res.json(), header: res.headers.get("x-facts-hash") };
  }
  return { json: JSON.parse(readFileSync(src, "utf8")), header: null };
}

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const src = arg(args, "--record");
  const record0 = src ? await loadRecord(src) : null;
  const tx = arg(args, "--tx") ?? record0?.json.anchor_tx;
  if (!src || !tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    console.error("usage: node verify-record.mjs --record <file|url> --tx <anchor tx hash> [--operator 0x...] [--rpc <url>]");
    process.exit(2);
  }
  const rpcs = arg(args, "--rpc") ? [arg(args, "--rpc")] : RPCS;
  const chainId = Number(BigInt(await rpc("eth_chainId", [], rpcs)));
  if (chainId !== CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${CHAIN_ID}`);
  const [receipt, code] = await Promise.all([
    rpc("eth_getTransactionReceipt", [tx], rpcs),
    rpc("eth_getCode", [RWA_ANCHOR_ADDRESS, "latest"], rpcs),
  ]);
  const result = checkRecord({ record: record0.json, receipt, code, operator: arg(args, "--operator") });

  const f = result.facts;
  const lines = [
    "vet402 /rwa record check (Robinhood Chain 4663, no key)",
    `  record    ${src}`,
    `  wallet    ${f.address}  ${f.method_version}  as_of ${f.as_of}  r1 ${f.r1_status}`,
    `  tx        ${tx}`,
    "",
    ...result.rows.map((r) => `  ${r.ok ? "OK  " : "FAIL"}  ${r.name.padEnd(18)} ${r.detail}`),
  ];
  if (record0.header && result.commitment) {
    const v2 = result.commitment.material === 2 ? result.commitment.hash : null;
    lines.push(`  info  X-Facts-Hash       ${short(record0.header)}${v2 ? (record0.header.toLowerCase() === v2 ? " = factsHash" : " != factsHash") : " (v2 header; this record anchors with v1)"}`);
  }
  lines.push("", result.ok ? "RESULT: MATCH. The JSON is the record that was anchored." : "RESULT: NO MATCH. See the FAIL lines.");
  console.log(lines.join("\n"));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`error: ${String(e?.message ?? e).slice(0, 400)}`);
    process.exit(2);
  });
}

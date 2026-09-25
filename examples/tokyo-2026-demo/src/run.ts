#!/usr/bin/env -S npx tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// ETHGlobal Tokyo 2026 demo CLI — PLAN_v4.3 §3.8. Read-only: nothing here signs or sends.
//
//   npx tsx src/run.ts verify <name> [--resource URL] [--method GET|POST] [--json] [--strict]
//   npx tsx src/run.ts census <name> [<name> ...] [--json]
//   npx tsx src/run.ts pay <name> | mutate | reset | cut-vet402 | scene3   (src/lib/scene.ts; --dry-run by default)
//
// verify runs the same checkEnsOffer as payOrRefuse and /tokyo: two independent Sepolia RPCs,
// one pinned block, the ENSIP-29 draft's seven steps. It prints the seven-step trace.
// Exit code: 0 when the check ran (VALID or a refusal), 1 when it could not run,
// 2 with --strict when the offer is refused.
//
// RPCs (two different providers are required):
//   ENS_SEPOLIA_RPC_URL    default https://sepolia.rpc.sentio.xyz
//   ENS_SEPOLIA_RPC_URL_2  (or ENS_SEPOLIA_RPC_URL_3) default https://rpc.sepolia.ethpandaops.io
// Pinned attester address (the attester's ENS name must resolve to exactly this address):
//   --attester atst.vet402.eth=0x…  >  trusted-attesters.json  >  env TOKYO_K_ATST_ADDRESS
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type * as EnsSdk from "../../../packages/sdk/src/ens.js";

type Ens = typeof EnsSdk;

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PRIMARY = "https://sepolia.rpc.sentio.xyz";
const DEFAULT_SECONDARY = "https://rpc.sepolia.ethpandaops.io";
const DEFAULT_RESOURCE = "https://vet402.com/api/tokyo/seller";
const DEFAULT_ATTESTER = "atst.vet402.eth";
const ZERO = "0x0000000000000000000000000000000000000000";
// The two fields of the base-sepolia chain profile that checkEnsOffer reads (network, asset).
const BASE_SEPOLIA = { name: "base-sepolia", network: "eip155:84532", chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" } as const;
const STEP_NAMES: Record<number, string> = {
  1: "envelope", 2: "manager", 3: "record value", 4: "payload", 5: "recover signer", 6: "attester name", 7: "compare",
};

/** The SDK's "./ens" entry: the installed package when there is one, else this repo's source. */
async function loadEns(): Promise<Ens> {
  const spec = "@vet402/sdk/ens";
  try {
    return (await import(spec)) as Ens;
  } catch (e: any) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND" && e?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw e;
    if (!String(e?.message ?? "").includes("@vet402/sdk")) throw e;
  }
  return (await import("../../../packages/sdk/src/ens.js")) as Ens;
}

const hostOf = (u: string): string => {
  try { return new URL(u).host; } catch { return "(invalid url)"; }
};

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") && ["resource", "method", "attester"].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { pos, flags };
}

function clients() {
  const primary = process.env.ENS_SEPOLIA_RPC_URL || DEFAULT_PRIMARY;
  const secondary = process.env.ENS_SEPOLIA_RPC_URL_2 || process.env.ENS_SEPOLIA_RPC_URL_3 || DEFAULT_SECONDARY;
  if (hostOf(primary) === hostOf(secondary)) {
    throw new Error(`two different RPC providers are required (both are ${hostOf(primary)}). Set ENS_SEPOLIA_RPC_URL_2 to another provider.`);
  }
  const mk = (url: string) => createPublicClient({ chain: sepolia, transport: http(url, { timeout: 20_000, retryCount: 1 }) });
  return { clients: { primary: mk(primary), secondary: mk(secondary) }, hosts: { primary: hostOf(primary), secondary: hostOf(secondary) } };
}

type AttesterCfg = { name: string; address: `0x${string}`; recordKeys: string[] };

function trustedAttesters(flag: string | true | undefined): { list: AttesterCfg[]; source: string; extra: Record<string, number> } {
  if (typeof flag === "string") {
    const [name, address] = flag.split("=");
    return { list: [{ name, address: address as `0x${string}`, recordKeys: ["x402-offer"] }], source: "--attester", extra: {} };
  }
  const file = path.join(DEMO_DIR, "trusted-attesters.json");
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = (j.trustedAttesters ?? []) as AttesterCfg[];
    const extra: Record<string, number> = {};
    for (const k of ["minValid", "maxAgeSeconds"]) if (typeof j[k] === "number") extra[k] = j[k];
    return { list, source: "trusted-attesters.json", extra };
  }
  const env = process.env.TOKYO_K_ATST_ADDRESS;
  if (env) return { list: [{ name: DEFAULT_ATTESTER, address: env as `0x${string}`, recordKeys: ["x402-offer"] }], source: "env TOKYO_K_ATST_ADDRESS", extra: {} };
  return {
    list: [{ name: DEFAULT_ATTESTER, address: ZERO, recordKeys: ["x402-offer"] }],
    source: "none (no --attester, no trusted-attesters.json, no TOKYO_K_ATST_ADDRESS): pinned to 0x0, so a real attestation stops at step 6 as ens_attester_unpinned",
    extra: {},
  };
}

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function verify(name: string, flags: Record<string, string | true>): Promise<number> {
  const ens = await loadEns();
  const { clients: c, hosts } = clients();
  const att = trustedAttesters(flags.attester);
  const resource = typeof flags.resource === "string" ? flags.resource : DEFAULT_RESOURCE;
  const method = typeof flags.method === "string" ? flags.method.toUpperCase() : "GET";
  const t0 = Date.now();
  const r = await ens.checkEnsOffer({
    name, resource, method, profile: BASE_SEPOLIA, clients: c,
    policy: { trustedAttesters: att.list, ...att.extra },
  });
  const ms = Date.now() - t0;
  if (flags.json) {
    console.log(json({ ...r, rpc: hosts, attesterSource: att.source, ms }));
  } else {
    console.log(`verify ${r.name}  (ENSIP-29 draft, Sepolia ${r.chainId})`);
    console.log(`  block    ${r.block.number} (ts ${r.block.timestamp})  heads: ${hosts.primary}=${r.heads.primary}  ${hosts.secondary}=${r.heads.secondary}`);
    console.log(`  request  ${method} ${resource}`);
    console.log(`  attester ${att.list.map((a) => `${a.name}=${a.address}`).join(", ")}  [pinned from ${att.source}]`);
    for (const s of r.trace) {
      const tag = s.status === "ok" ? "ok  " : s.status === "fail" ? "FAIL" : "skip";
      const d = Object.entries(s.detail).map(([k, v]) => `${k}=${v}`).join("  ");
      console.log(`  [${tag}] ${s.step} ${STEP_NAMES[s.step].padEnd(14)} ${d}`);
    }
    const okSteps = r.trace.filter((s) => s.status === "ok").length;
    if (r.ok) console.log(`VALID  ${okSteps}/7 steps ok  payTo=${r.offer?.payTo} amount=${r.offer?.amount}  (${ms} ms)`);
    else console.log(`REFUSE ${r.reason_codes.join(", ")}  ${okSteps}/7 steps ok  (${ms} ms)`);
  }
  // An RPC outage is not a verdict about the seller: exit 3 so a script never reads it as a clean run.
  if (r.reason_codes.includes("ens_evidence_unavailable")) return 3;
  return !r.ok && flags.strict ? 2 : 0;
}

// census (B4b): one row per name, then the K1 judgement line (PLAN_v4.3 section 4). Names without an
// exact owner (wildcard subnames such as <resourceId>.obs.vet402.eth) are still resolved: their addr is
// printed as "addr: (none)" when nothing answers, which is what the observation log must show.
// Exit code: 0 when K1 holds (or --no-k1), 2 when a K1 item fails, 1 when it could not read.
async function census(names: string[], flags: Record<string, string | true>): Promise<number> {
  (await import("./lib/sdk.ts")).installSdkDepsResolver(); // viem for packages/sdk in a clean checkout
  const ens = await loadEns();
  const { clients: c, hosts } = clients();
  const pin = await ens.pinBlock(c, 120);
  const rows: Record<string, unknown>[] = [];
  for (const raw of names) {
    const name = ens.normalizeName(raw);
    const owner = await ens.findExactOwner(c, pin.B, name);
    const labels = name.split(".");
    const st = owner && labels.length === 2 && labels[1] === "eth" ? await ens.getState(c, pin.B, labels[0]) : null;
    const addr = await ens.resolveAddr(c, pin.B, name);
    const offer = await ens.resolveText(c, pin.B, name, "x402-offer");
    const ep = await ens.resolveText(c, pin.B, name, "agent-endpoint[x402]");
    const cls = await ens.resolveText(c, pin.B, name, "class");
    const env = await ens.resolveText(c, pin.B, name, ens.attestationKey("x402-offer", DEFAULT_ATTESTER));
    rows.push({
      name, owner, status: st?.status ?? null, expiry: st?.expiry ?? null, resolver: addr.resolver ?? offer.resolver ?? cls.resolver,
      addr: addr.value, class: cls.value || null, offerBytes: new TextEncoder().encode(offer.value).length, endpoint: ep.value || null,
      attestation: env.value ? `${env.value.length} chars` : null,
    });
  }
  const { k1Items, k1Line } = await import("./lib/census.ts");
  const items = flags["no-k1"] ? [] : await k1Items(ens, c, pin.B);
  const k1 = items.length ? k1Line(items) : null;
  if (flags.json) {
    console.log(json({ block: pin.B, heads: pin.heads, rpc: hosts, rows, k1: items.length ? { line: k1, items } : null }));
  } else {
    console.log(`census at block ${pin.B} (both RPCs agree: ${hosts.primary}, ${hosts.secondary})`);
    for (const r of rows) {
      console.log(`  ${String(r.name).padEnd(22)} owner=${r.owner ?? "0x0 (unresolved)"} status=${r.status ?? "-"} resolver=${r.resolver ?? "-"} addr: ${r.addr ?? "(none)"} class=${r.class ?? "-"} x402-offer=${r.offerBytes}B endpoint=${r.endpoint ?? "-"} attestation[${DEFAULT_ATTESTER}]=${r.attestation ?? "-"}`);
    }
    const none = rows.filter((r) => r.addr === null).length;
    console.log(`  addr: (none) x${none} of ${rows.length}`);
    if (k1) console.log(k1);
  }
  return items.some((i) => !i.ok) ? 2 : 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (cmd === "verify" && pos.length === 1) return verify(pos[0], flags);
  if (cmd === "census" && pos.length >= 1) return census(pos, flags);
  // B7: the demo commands. Their flags are parsed in src/lib/scene.ts (dry-run unless --live).
  if (["pay", "mutate", "reset", "cut-vet402", "scene3"].includes(cmd)) return (await import("./lib/scene.ts")).runScene(cmd, rest);
  console.error([
    "usage:",
    "  npx tsx src/run.ts verify <name> [--resource URL] [--method GET|POST] [--attester name=0x…] [--json] [--strict]",
    "  npx tsx src/run.ts census <name> [<name> ...] [--json]",
    "  npx tsx src/run.ts pay <name> [--dry-run | --live] [--test-attester]",
    "  npx tsx src/run.ts cut-vet402 [--mode refused|503] [pay <name> ...] | cut-vet402 --restore",
    "  npx tsx src/run.ts mutate | reset [--dry-run | --live] [--test-attester]",
    "  npx tsx src/run.ts scene3 [--dry-run | --live] [--test-attester] [--assume-align-bc]",
  ].join("\n"));
  return 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(`run.ts: ${String(e?.message ?? e)}`); process.exitCode = 1; },
);

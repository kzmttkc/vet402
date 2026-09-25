#!/usr/bin/env -S npx tsx
// observe.ts: the observation log for third-party x402 sellers (PLAN_v4.3 section 3.6).
//
//   npx tsx src/observe.ts <resourceId> [<resourceId> ...] [--dry-run | --live | --check]
//
// For each resource: read vet402's /decision?role=payer (7 s apart: 10 requests/min without a key),
// then check the purchase it names on Base mainnet through two public RPCs (status 0x1). vet402's
// answer alone is not trusted. The 15 text keys go on <resourceId>.obs.vet402.eth, a wildcard name
// under the reserved label `obs`, answered by R_vet. No addr and no contenthash are ever written:
// this is not the seller's name and nobody should send funds to it.
//
// --dry-run (default) never signs: it prints the 15 keys and runs the R_vet.multicall from W_obs
//   through eth_simulateV1.
// --live   is for the human: chainId 11155111, W_obs balance, the same simulation, then a typed y.
//   After sending it reads every key back on two RPCs.
// --check  recomputes the keys now and compares them with what ENS holds (the scene-1 rerun command).
//
// The refusal word observation_without_purchase belongs to this file only.
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { PR } from './lib/abi.ts';
import { loadEnvFile, requireEnv, sepoliaRpcs } from './lib/env.ts';
import { ADDR, SEPOLIA_CHAIN_ID, dns, fmtEth } from './lib/k1.ts';
import { hostOf, pickRpc, rpc, simulateBlocks } from './lib/rpc.ts';
import { loadEnsSdk } from './lib/sdk.ts';

export const OBS_CLASS = 'x402-observation';
export const OBS_DESCRIPTION = "Observation log by vet402. Not the seller's name. Do not send funds here.";
export const OBS_PARENT = 'obs.vet402.eth';
const DEFAULT_API = 'https://vet402.com/api/v1';
const DECISION_SPACING_MS = 7_000;

export type ObservationCtx = {
  resource?: string;
  method?: string;
  source: string;
  rerun: string;
  pipelineCommit: string;
  purchaseBlock: number | bigint | string;
  attestedName?: string;
  attestedT?: number | string;
};
export type ObservationPlan = { name: string; resourceId: string; texts: Record<string, string> };

/** "2026-09-17 12:09:57.640669+00" or ISO → "2026-09-17T12:09:57Z". Unknown shapes are kept as given. */
export function isoUtc(s: unknown): string {
  if (typeof s !== 'string' || !s) return '';
  const d = new Date(s.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isNaN(d.getTime()) ? s : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The 15-key plan for one resource. Throws observation_without_purchase when vet402 names no purchase:
 * an observation is only worth writing when a real purchase stands behind it.
 */
export function planObservationWrite(decision: any, ctx: ObservationCtx): ObservationPlan {
  const id = String(decision?.subject?.id ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`observation_bad_subject: subject.id must be a 64-hex resource id, got ${JSON.stringify(decision?.subject?.id)}`);
  const purchase = decision?.facts?.l1?.last_purchase_id;
  if (typeof purchase !== 'string' || purchase === '') {
    throw new Error(`observation_without_purchase: vet402 names no purchase for resource ${id} (facts.l1.last_purchase_id is ${JSON.stringify(purchase ?? null)})`);
  }
  const l2 = decision?.facts?.l2 ?? {};
  const resource = ctx.resource ?? decision?.subject?.canonical_url;
  const method = ctx.method ?? decision?.subject?.method ?? 'GET';
  if (typeof resource !== 'string' || !resource) throw new Error(`observation_bad_subject: no resource URL for ${id}`);
  const texts: Record<string, string> = {
    class: OBS_CLASS,
    description: OBS_DESCRIPTION,
    'x402.resource': resource,
    'x402.method': String(method).toUpperCase(),
    'x402.l2': l2.status === 'conform' ? 'conform' : 'mismatch',
    'x402.declaration-sha256': String(l2.declaration_hash ?? ''),
    'x402.response-sha256': String(l2.response_hash ?? ''),
    'x402.purchase': purchase,
    'x402.purchase-block': String(ctx.purchaseBlock),
    'x402.observed-at': isoUtc(l2.observed_at),
    'x402.source': ctx.source,
    'x402.rerun': ctx.rerun,
    'x402.pipeline-commit': ctx.pipelineCommit,
  };
  if (ctx.attestedName) texts['x402.attested-name'] = ctx.attestedName;
  if (ctx.attestedT !== undefined) texts['x402.attested-t'] = String(ctx.attestedT);
  return { name: `${id}.${OBS_PARENT}`, resourceId: id, texts };
}

/** R_vet.multicall(setText(dns(name), key, value) ...) — the one tx W_obs sends per resource. */
export function observationCalldata(plan: ObservationPlan): Hex {
  const calls = Object.entries(plan.texts).map(([k, v]) => encodeFunctionData({ abi: PR, functionName: 'setText', args: [dns(plan.name), k, v] }));
  return encodeFunctionData({ abi: PR, functionName: 'multicall', args: [calls] });
}

// ---------------------------------------------------------------- CLI
type Mode = 'dry-run' | 'live' | 'check';

function parseArgs(argv: string[]): { ids: string[]; mode: Mode } {
  let mode: Mode = 'dry-run';
  const ids: string[] = [];
  for (const a of argv) {
    if (a === '--live') mode = 'live';
    else if (a === '--check') mode = 'check';
    else if (a === '--dry-run') mode = 'dry-run';
    else if (a.startsWith('--')) throw new Error(`知らないオプション ${a}`);
    else ids.push(a.toLowerCase().replace(/^0x/, ''));
  }
  if (argv.filter(a => ['--live', '--check', '--dry-run'].includes(a)).length > 1) throw new Error('--dry-run / --live / --check は1つだけ');
  if (!ids.length) throw new Error('usage: npx tsx src/observe.ts <resourceId> [...] [--dry-run | --live | --check]');
  for (const id of ids) if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`resourceId は 64 桁の16進: ${id}`);
  return { ids, mode };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchDecision(api: string, id: string): Promise<{ url: string; body: any }> {
  const url = `${api}/resources/${id}/decision?role=payer`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (res.status !== 200) throw new Error(`observation_decision_unavailable: ${url} HTTP ${res.status}`);
  return { url, body: await res.json() };
}

/** Base mainnet receipt of eip155:8453:<tx> on two public RPCs. Both must say status 0x1, same block. */
async function purchaseBlockOnBase(purchaseId: string): Promise<{ block: bigint; hosts: string[] }> {
  const m = /^eip155:8453:(0x[0-9a-fA-F]{64})$/.exec(purchaseId);
  if (!m) throw new Error(`observation_purchase_unverifiable: ${purchaseId} is not a Base mainnet tx (eip155:8453:0x…)`);
  const urls = [process.env.BASE_RPC_URL || 'https://mainnet.base.org', process.env.BASE_RPC_URL_2 || 'https://base.drpc.org'];
  if (hostOf(urls[0]) === hostOf(urls[1])) throw new Error('BASE_RPC_URL と BASE_RPC_URL_2 は別の提供元にする');
  const rcs = await Promise.all(urls.map(u => rpc<any>(u, 'eth_getTransactionReceipt', [m[1]], 20_000)));
  for (const [i, rc] of rcs.entries()) {
    if (!rc || rc.status !== '0x1') throw new Error(`observation_purchase_unverifiable: ${m[1]} on ${hostOf(urls[i])} status ${rc?.status ?? 'not found'}`);
  }
  if (rcs[0].blockNumber !== rcs[1].blockNumber) throw new Error(`observation_purchase_unverifiable: the two Base RPCs disagree on the block of ${m[1]}`);
  return { block: BigInt(rcs[0].blockNumber), hosts: urls.map(hostOf) };
}

function sepoliaClients(read: string[]) {
  if (read.length < 2) throw new Error('Sepolia の読み口が2系統要る（ENS_SEPOLIA_RPC_URL と ENS_SEPOLIA_RPC_URL_2 か _3）');
  const mk = (u: string) => createPublicClient({ chain: sepolia, transport: http(u, { timeout: 20_000, retryCount: 1 }) });
  return { primary: mk(read[0]), secondary: mk(read[1]) };
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) { console.log('標準入力が端末でないので送らない（人が y を打つ場でだけ送る）'); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a === 'y';
}

async function main(): Promise<number> {
  const { ids, mode } = parseArgs(process.argv.slice(2));
  loadEnvFile();
  const api = (process.env.VET402_API_URL || DEFAULT_API).replace(/\/$/, '');
  const commit = process.env.TOKYO_PIPELINE_COMMIT || (await gitHead());
  const { read, sim } = sepoliaRpcs();
  const url = await pickRpc([...sim, ...read.filter(u => !sim.includes(u))]);
  const c = createPublicClient({ chain: sepolia, transport: http(url, { timeout: 60_000 }) });
  const chainId = await c.getChainId();
  if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`chainId ${chainId}（Sepolia でない）。止める`);
  const wObs = process.env.TOKYO_W_OBS_ADDRESS ? getAddress(process.env.TOKYO_W_OBS_ADDRESS) : null;
  console.log(`observe.ts ${mode} | vet402 ${hostOf(api)} | Sepolia ${hostOf(url)} | W_obs ${wObs ?? '(TOKYO_W_OBS_ADDRESS なし)'} | commit ${commit}`);

  const plans: Array<{ plan: ObservationPlan; data: Hex }> = [];
  for (const [i, id] of ids.entries()) {
    if (i > 0) await sleep(DECISION_SPACING_MS);
    const d = await fetchDecision(api, id);
    const purchase = d.body?.facts?.l1?.last_purchase_id;
    const base = typeof purchase === 'string' && purchase ? await purchaseBlockOnBase(purchase) : null;
    const plan = planObservationWrite(d.body, {
      source: d.url, rerun: `npx tsx src/observe.ts ${id} --check`, pipelineCommit: commit, purchaseBlock: base?.block ?? '',
    });
    console.log(`\n${plan.name}\n  purchase ${plan.texts['x402.purchase']} status 0x1 on ${base!.hosts.join(' + ')} (block ${base!.block})`);
    for (const [k, v] of Object.entries(plan.texts)) console.log(`  ${k.padEnd(24)} ${v}`);
    console.log('  addr / contenthash      (none: not written)');
    plans.push({ plan, data: observationCalldata(plan) });
  }

  if (mode === 'check') {
    const ens = await loadEnsSdk();
    const clients = sepoliaClients(read);
    const pin = await ens.pinBlock(clients, 120);
    let diff = 0;
    for (const { plan } of plans) {
      for (const [k, want] of Object.entries(plan.texts)) {
        if (k === 'x402.source' || k === 'x402.pipeline-commit') continue; // who ran it, not what was observed
        const got = (await ens.resolveText(clients, pin.B, plan.name, k)).value;
        if (got !== want) { diff++; console.log(`  DIFF ${plan.name} ${k}: ENS ${JSON.stringify(got)} / now ${JSON.stringify(want)}`); }
      }
      const a = await ens.resolveAddr(clients, pin.B, plan.name);
      console.log(`  ${plan.name.slice(0, 12)}… addr: ${a.value ?? '(none)'}  resolver ${a.resolver ?? '-'}`);
    }
    console.log(diff ? `check: ${diff} 項目が違う (block ${pin.B})` : `check: match (block ${pin.B}, 2 RPCs)`);
    return diff ? 2 : 0;
  }

  if (!wObs) throw new Error('TOKYO_W_OBS_ADDRESS が env に無い（keys.ts init の後に打つ）');
  const B = await c.getBlockNumber();
  const r = await simulateBlocks([{ calls: plans.map(p => ({ from: wObs, to: ADDR.rVet, data: p.data })) }], B, sim);
  let ok = true;
  console.log(`\nR_vet.multicall を W_obs から eth_simulateV1（${hostOf(r.rpc)} block ${B}）:`);
  r.blocks[0].forEach((res, i) => {
    ok &&= res.status === 'OK';
    console.log(`  ${res.status.padEnd(6)} ${plans[i].plan.name.slice(0, 16)}… gas=${res.gas} ${res.status === 'OK' ? '' : res.error}`);
  });
  if (mode === 'dry-run') { console.log(`\n${ok ? 'dry-run ok' : 'dry-run NG'}: observe（署名・送信はしていない）`); return ok ? 0 : 2; }

  if (!ok) { console.log('--live を止める: simulate が通らない'); return 2; }
  const fees = await c.estimateFeesPerGas();
  const price = fees.maxFeePerGas ?? (await c.getGasPrice());
  const need = r.blocks[0].reduce((t, x) => t + BigInt(Math.ceil(x.gas * 1.3) + 30_000) * price, 0n);
  const bal = await c.getBalance({ address: wObs });
  console.log(`  ${bal >= need ? 'OK' : 'NG'} balance W_obs ${fmtEth(bal)} >= ${fmtEth(need)}`);
  if (bal < need) return 2;
  if (!(await confirm(`Sepolia に ${plans.length} 本送るなら y を打つ: `))) { console.log('送らなかった'); return 1; }
  const pk = requireEnv('TOKYO_W_OBS_PRIVATE_KEY', 'observe --live の署名');
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : '0x' + pk) as Hex);
  if (account.address !== wObs) throw new Error('TOKYO_W_OBS_PRIVATE_KEY のアドレスが TOKYO_W_OBS_ADDRESS と違う。止める');
  const w = createWalletClient({ account, chain: sepolia, transport: http(url) });
  for (const [i, p] of plans.entries()) {
    const hash = await w.sendTransaction({ to: ADDR.rVet, data: p.data, gas: BigInt(Math.ceil(r.blocks[0][i].gas * 1.3) + 30_000) } as any);
    const rc = await c.waitForTransactionReceipt({ hash, timeout: 180_000 });
    const blk = await c.getBlock({ blockNumber: rc.blockNumber });
    console.log(`  ${rc.status === 'success' ? 'mined' : 'FAILED'} ${p.plan.name.slice(0, 16)}… tx ${hash} block ${rc.blockNumber} (${new Date(Number(blk.timestamp) * 1000).toISOString()})`);
    if (rc.status !== 'success') return 2;
  }
  console.log('\n読み戻し（2系統）: npx tsx src/observe.ts ' + ids.join(' ') + ' --check');
  return 0;
}

async function gitHead(): Promise<string> {
  try {
    const { execFileSync } = await import('node:child_process');
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, e => { console.error(`observe.ts: ${e?.message ?? e}`); process.exitCode = 1; });
}

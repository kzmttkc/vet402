#!/usr/bin/env -S npx tsx
// admin.ts: the Sepolia setup a human runs during K1 (PLAN_v4.3 section 3.4 and section 4).
//
//   npx tsx src/admin.ts <command> [--dry-run | --live] [options]
//
// --dry-run (default) never signs. It simulates the whole K1 chain in order with eth_simulateV1
// (validation:false) from the owners' addresses and prints this command's rows. It also simulates
// this command alone on the current chain state, which is exactly the gate --live applies.
// --live is for the human. It checks chainId 11155111, checks every signer's balance against the
// gas estimate, prints what will be sent and sends nothing until a human types y.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, labelhash, namehash, type Address, type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia } from 'viem/chains';
import { ERC20, PR, RG, URI } from './lib/abi.ts';
import {
  ADDR, ATT_KEY, BASE_SEPOLIA_CHAIN_ID, COMMIT_WAIT_MARGIN_S, DUMMY, DUMMY_ENVELOPE_B64, SEPOLIA_CHAIN_ID,
  ROLE_RENEW, SELLER_ENDPOINT, USDC_BASE_SEPOLIA, W_ENS, W_VET, amounts, buildChecks, buildCtx, buildSteps, client, dns, fmtEth, mkOffer,
  type Check, type Cmd, type Ctx, type Roles, type Step,
} from './lib/k1.ts';
import { DEMO_DIR, KEY_SPECS, OWNER_PK_ENV, appendEnvLine, baseSepoliaRpc, envFilePath, loadEnvFile, sepoliaRpcs } from './lib/env.ts';
import { checkEnvelopeOnChain, type EnvelopeCheck } from './lib/attestation.ts';
import { loadEnsSdk } from './lib/sdk.ts';
import { hostOf, pickRpc, rpc, simulateBlocks, type SimBlock, type SimResult } from './lib/rpc.ts';

// ---------------------------------------------------------------- commands
const COMMANDS: ReadonlyArray<[string, string]> = [
  ['deploy-resolvers', 'K1-04/05/07/08/09 + K1-D2/D3: P_a, P_bc, P_d and setResolver (W_ens). --print-predicted'],
  ['k1a', 'K1-02, K1-03 and the ETH for W_obs (W_vet). K1-01 is not sent (dropped 2026-09-24)'],
  ['k1b', 'K1-06, K1-D4, BS-03 on Sepolia (W_ens) + BS-01/BS-02 on Base Sepolia (SEED_TX)'],
  ['register-d', 'K1-D1: MockUSDC approve -> commit -> wait 60 s -> register seller-d.eth (W_ens)'],
  ['publish-attestations', 'B5b/B5c: attestation key on seller-a/b/c/d (W_ens). Envelopes from out/envelopes.json (attester.ts). Re-runnable'],
  ['unlink', 'linkToRecord(<name>, 0): empty every key of <name> at once'],
  ['link', 'link <name> <recordId|target-name>: linkToRecord / linkToNode'],
  ['relink', 'relink <name> [recordId]: back to the census record id (seller-b=1, seller-c=2)'],
  ['agents', 'K1-10..K1-15 + K1-15b (W_vet). --post: K1-post-1/2 + K1-15c (W_ens) + K1-15d'],
  ['register-e', 'K1-E1: MockUSDC approve -> commit -> wait 60 s -> register seller-e.eth (W_ens)'],
  ['set-offer-e', 'K1-E2/E3: setResolver(seller-e, P_bc) + x402-offer with the flagged payTo, no attestation'],
  ['align-bc', 'BC-1: seller-b/c offer to amount 10000 + agent-endpoint[x402] (one P_bc multicall, W_ens). Before B5a'],
  ['agent-off', 'D-6a: U.unregister(agent-1) (W_vet). The policy is gone, so the agent stops paying'],
  ['agent-on', 'D-6b: U.register(agent-1, K_ag1, 0, P_AG1, RENEW, expiry) again (W_vet)'],
  ['emancipate', 'T7: U.revokeRootRoles(UNEMANCIPATED, W_vet). IRREVERSIBLE; only after agent-on. Needs --irreversible'],
];

function help(): string {
  return [
    'usage: npx tsx src/admin.ts <command> [--dry-run | --live] [options]',
    '',
    'commands:',
    ...COMMANDS.map(([c, d]) => `  ${c.padEnd(22)}${d}`),
    '',
    'options:',
    '    --dry-run            default. eth_simulateV1 of the whole K1 chain + this command alone. Never signs',
    '    --live               sign and send. Checks chainId and balances, then waits for a typed y',
    '    --post               with agents: the K1-post rows instead of K1-10..K1-15b',
    '    --print-predicted    with deploy-resolvers: print P_a, P_bc, P_d, U, P_AG1',
    '    --after-off          with agent-on --dry-run: simulate agent-off first (agent-1 is registered until D-6a)',
    '    --irreversible       with emancipate --live: required, because T7 cannot be undone',
    '    --envelopes <file>   with publish-attestations: JSON {"seller-a.eth":"<base64>", ...}',
    '    --block <n>          dry-run at a fixed block',
    '    --base-from <ID>     with k1b: send nothing on Sepolia; send the Base Sepolia rows from <ID> on (resume after a stop)',
    '',
    `env: ${envFilePath()} (ENS_SEPOLIA_RPC_URL[_2|_3], BASE_SEPOLIA_RPC_URL, TOKYO_*_ADDRESS, and for --live the keys)`,
    'dry-run skips the 60 s commit wait: the register row runs in a second simulated block 180 s later.',
  ].join('\n');
}

type Opts = { cmd: string; live: boolean; post: boolean; printPredicted: boolean; irreversible?: boolean; afterOff?: boolean; envelopes?: string; block?: bigint; baseFrom?: string; args: string[] };
function parseArgs(argv: string[]): Opts {
  const o: Opts = { cmd: '', live: false, post: false, printPredicted: false, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') o.live = true;
    else if (a === '--dry-run') o.live = false;
    else if (a === '--post') o.post = true;
    else if (a === '--print-predicted') o.printPredicted = true;
    else if (a === '--irreversible') o.irreversible = true;
    else if (a === '--after-off') o.afterOff = true;
    else if (a === '--envelopes') o.envelopes = argv[++i];
    else if (a === '--block') o.block = BigInt(argv[++i]);
    else if (a === '--base-from') o.baseFrom = argv[++i];
    else if (a === '--help' || a === '-h') o.cmd = 'help';
    else if (a.startsWith('--')) throw new Error(`知らないオプション ${a}`);
    else if (!o.cmd) o.cmd = a;
    else o.args.push(a);
  }
  if (argv.includes('--live') && argv.includes('--dry-run')) throw new Error('--live と --dry-run を同時に付けない');
  if (o.baseFrom && o.cmd !== 'k1b') throw new Error('--base-from は k1b でだけ使う');
  return o;
}

// ---------------------------------------------------------------- roles
function readRoles(live: boolean): { roles: Roles; dummy: string[] } {
  const roles = { ...DUMMY } as Roles;
  const dummy: string[] = [];
  for (const k of KEY_SPECS) {
    const v = process.env[k.addr];
    if (v) roles[k.id] = getAddress(v);
    else dummy.push(k.id);
  }
  if (live && dummy.length) throw new Error(`--live には本物のアドレスが要る。${dummy.join(', ')} が env に無い（先に keys.ts init）`);
  for (const [name, want] of [['W_VET', W_VET], ['W_ENS', W_ENS]] as const) {
    const v = process.env[name];
    if (v && getAddress(v) !== want) throw new Error(`env ${name}=${v} が正典 ${want} と違う`);
  }
  return { roles, dummy };
}

// ---------------------------------------------------------------- extra (post-K1) steps
const RESOLVER_OF: Record<string, { key: keyof Ctx['predicted']; signer: 'W_vet' | 'W_ens' }> = {
  'seller-a.eth': { key: 'P_a', signer: 'W_ens' },
  'seller-b.eth': { key: 'P_bc', signer: 'W_ens' },
  'seller-c.eth': { key: 'P_bc', signer: 'W_ens' },
  'seller-e.eth': { key: 'P_bc', signer: 'W_ens' },
  'seller-d.eth': { key: 'P_d', signer: 'W_ens' },
  'agent-1.vet402.eth': { key: 'P_AG1', signer: 'W_vet' },
  'agent-1.seller-a.eth': { key: 'P_AG1', signer: 'W_vet' },
};
// Record ids fixed by K1-07 (P_bc): seller-b = 1, seller-c = 2 [PLAN section 4 / AGENT_PROMPTS section 12].
const CENSUS_RECORD: Record<string, bigint> = { 'seller-b.eth': 1n, 'seller-c.eth': 2n };
const CENSUS_NODE: Record<string, string> = { 'agent-1.seller-a.eth': 'agent-1.vet402.eth' };
// align-bc: the same 266-byte offer as seller-a (amount 10000, payTo W_ens) — the live route serves only this one.
const ALIGNED_OFFER = mkOffer('10000', W_ENS);

const prd = (functionName: any, args: any): Hex => encodeFunctionData({ abi: PR, functionName, args } as any);
const usrw = (functionName: any, args: any): Hex => encodeFunctionData({ abi: URI, functionName, args } as any);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

function extraSteps(o: Opts, x: Ctx): Step[] {
  const mk = (id: string, name: string, data: Hex, what: string): Step => {
    const r = RESOLVER_OF[name];
    if (!r) throw new Error(`${name} のリゾルバを知らない（${Object.keys(RESOLVER_OF).join(' / ')}）`);
    return { id, cmd: o.cmd as Cmd, signer: r.signer, from: r.signer === 'W_vet' ? W_VET : W_ENS, to: x.predicted[r.key], data, block: 1, what };
  };
  const name = o.args[0];
  switch (o.cmd) {
    // publish-attestations: see attestationSteps() (it reads the chain, so it is async).
    case 'align-bc': {
      // 2026-09-25 23:4x: K1-07 wrote b/c offers at 20000/30000 and no agent-endpoint[x402]. The live seller
      // route is 10000 only, and checkEnsOffer requires endpoint === offer.resource, so B5a could not buy b or c.
      const calls = (['seller-b.eth', 'seller-c.eth'] as const).flatMap(n => [
        prd('setText', [dns(n), 'x402-offer', ALIGNED_OFFER]),
        prd('setText', [dns(n), 'agent-endpoint[x402]', SELLER_ENDPOINT]),
      ]);
      return [mk('BC-1', 'seller-b.eth', prd('multicall', [calls]), 'P_bc.multicall[setText(seller-b|c, x402-offer, amount 10000) x2, setText(seller-b|c, agent-endpoint[x402]) x2]')];
    }
    case 'agent-off': case 'agent-on': case 'emancipate': {
      const u = (id: string, data: Hex, what: string): Step => ({ id, cmd: o.cmd as Cmd, signer: 'W_vet', from: W_VET, to: x.predicted.U, data, block: 1, what });
      if (o.cmd === 'agent-off') return [u('D-6a', usrw('unregister', [BigInt(labelhash('agent-1'))]), 'U.unregister(agent-1)')];
      // --after-off (dry-run only): simulate D-6a first, so D-6b is checked on the state it will really meet.
      if (o.cmd === 'agent-on' && o.afterOff && o.live) throw new Error('--after-off は dry-run 専用');
      if (o.cmd === 'agent-on' && o.afterOff) return [u('D-6a', usrw('unregister', [BigInt(labelhash('agent-1'))]), 'U.unregister(agent-1) [simulated first]'), u('D-6b', usrw('register', ['agent-1', x.roles.K_ag1, ZERO_ADDR, x.predicted.P_AG1, ROLE_RENEW, x.expiry]), 'U.register(agent-1, K_ag1, 0, P_AG1, RENEW, expiry)')];
      if (o.cmd === 'agent-on') return [u('D-6b', usrw('register', ['agent-1', x.roles.K_ag1, ZERO_ADDR, x.predicted.P_AG1, ROLE_RENEW, x.expiry]), 'U.register(agent-1, K_ag1, 0, P_AG1, RENEW, expiry)')];
      // UNEMANCIPATED = SET_SUBREGISTRY | SET_RESOLVER | UNREGISTER | UPGRADE, each with its admin bit (<<128) [PLAN section 4, T7].
      // It includes UNREGISTER, so after this W_vet can no longer run agent-off: send it only after agent-on.
      if (o.live && !o.irreversible) throw new Error('emancipate は戻せない。agent-on の後に --irreversible を付けて打つ');
      const R_SUB = 1n << 20n, R_RES = 1n << 24n, R_UNREG = 1n << 12n, R_UPG = 1n << 124n;
      const UNEMANCIPATED = [R_SUB, R_RES, R_UNREG, R_UPG].reduce((a, r) => a | r | (r << 128n), 0n);
      return [u('T7', usrw('revokeRootRoles', [UNEMANCIPATED, W_VET]), 'U.revokeRootRoles(UNEMANCIPATED, W_vet) = emancipation')];
    }
    case 'unlink':
      if (!name) throw new Error('unlink <name>');
      return [mk('unlink', name, prd('linkToRecord', [dns(name), 0n]), `linkToRecord(${name}, 0)`)];
    case 'link': {
      const t = o.args[1];
      if (!name || !t) throw new Error('link <name> <recordId|target-name>');
      if (/^\d+$/.test(t)) return [mk('link', name, prd('linkToRecord', [dns(name), BigInt(t)]), `linkToRecord(${name}, ${t})`)];
      return [mk('link', name, prd('linkToNode', [dns(name), namehash(t)]), `linkToNode(${name} -> ${t})`)];
    }
    case 'relink': {
      if (!name) throw new Error('relink <name> [recordId]');
      if (o.args[1]) return [mk('relink', name, prd('linkToRecord', [dns(name), BigInt(o.args[1])]), `linkToRecord(${name}, ${o.args[1]})`)];
      if (CENSUS_RECORD[name] !== undefined) return [mk('relink', name, prd('linkToRecord', [dns(name), CENSUS_RECORD[name]]), `linkToRecord(${name}, ${CENSUS_RECORD[name]})`)];
      if (CENSUS_NODE[name]) return [mk('relink', name, prd('linkToNode', [dns(name), namehash(CENSUS_NODE[name])]), `linkToNode(${name} -> ${CENSUS_NODE[name]})`)];
      throw new Error(`${name} の元の recordId を知らない。relink ${name} <recordId> で渡す`);
    }
    default: return [];
  }
}

// ---------------------------------------------------------------- publish-attestations (B5b, and B5c re-sign)
// Four rows, all from W_ens (root on P_a / P_bc / P_d): setText(<name>, attestations[x402-offer][atst.vet402.eth],
// <envelope base64>). K1-D5 is the seller-d row. setText overwrites, so the command can be run again with
// new envelopes (B5c, 09-27 07:45: attester.ts --live-pay again, then this). Envelopes come from
// out/envelopes.json (attester.ts) unless --envelopes is given, and every one is checked against the chain
// before --live. This command writes only the attestation key (agent-endpoint[x402] is not its job).
const PUBLISH_ROWS: ReadonlyArray<[string, string]> = [['B5b-a', 'seller-a.eth'], ['B5b-b', 'seller-b.eth'], ['B5b-c', 'seller-c.eth'], ['K1-D5', 'seller-d.eth']];
const DEFAULT_ENVELOPES = path.join(DEMO_DIR, 'out', 'envelopes.json');
type Publish = { steps: Step[]; rerun: Step[]; checks: EnvelopeCheck[] | null; source: string };

async function attestationSteps(o: Opts, x: Ctx): Promise<Publish> {
  const file = o.envelopes ?? (fs.existsSync(DEFAULT_ENVELOPES) ? DEFAULT_ENVELOPES : undefined);
  const env = file ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string> : null;
  if (o.live && !env) throw new Error(`--live の publish-attestations には署名済みの envelope が要る（${DEFAULT_ENVELOPES} が無い。先に attester.ts --live-pay）`);
  const ens = await loadEnsSdk();
  const { read } = sepoliaRpcs();
  if (read.length < 2) throw new Error('publish-attestations は Sepolia の読み口を2系統使う（ENS_SEPOLIA_RPC_URL と _2 か _3）');
  const mkc = (u: string) => createPublicClient({ chain: sepolia, transport: http(u, { timeout: 30_000, retryCount: 1 }) });
  const clients = { primary: mkc(read[0]), secondary: mkc(read[1]) };
  const pin = await ens.pinBlock(clients, 120);
  const checks: EnvelopeCheck[] | null = env ? [] : null;
  const build = (v: (n: string) => string, tag: string): Step[] => PUBLISH_ROWS.map(([id, n]): Step => {
    const r = RESOLVER_OF[n];
    return { id, cmd: o.cmd as Cmd, signer: r.signer, from: W_ENS, to: x.predicted[r.key], data: prd('setText', [dns(n), ATT_KEY, v(n)]), block: 1, what: `setText(${n}, ${ATT_KEY}, <${tag}>)` };
  });
  for (const [, n] of PUBLISH_ROWS) {
    if (!env) continue;
    const v = env[n];
    if (!v) { checks!.push({ name: n, ok: false, why: `${file} に ${n} が無い（attester が署名しなかった）`, t: null, ageSeconds: null, recovered: null }); continue; }
    checks!.push(await checkEnvelopeOnChain(ens, clients, pin.B, Number(pin.ts), n, v));
  }
  const steps = build(n => env?.[n] ?? DUMMY_ENVELOPE_B64, env ? 'envelope' : 'envelope DUMMY');
  // The re-run (B5c) overwrites the same keys with new envelopes of the same length.
  const DUMMY2 = Buffer.from(Buffer.from(DUMMY_ENVELOPE_B64, 'base64').map(b => b ^ 0x5a)).toString('base64');
  const rerun = build(() => DUMMY2, 'envelope, re-run').map(s => ({ ...s, id: s.id + "'" }));
  return { steps, rerun, checks, source: file ?? '(none: DUMMY envelopes of the real length)' };
}

function ownCmds(o: Opts): Cmd[] {
  if (o.cmd === 'agents') return [o.post ? 'agents-post' : 'agents'];
  return [o.cmd as Cmd];
}

// ---------------------------------------------------------------- simulation
type Row = { step?: Step; check?: Check; res: SimResult; verdict: 'OK' | 'REVERT' | 'NG' };

async function runChain(steps: Step[], checks: Check[], x: Ctx, urls: string[], blockNumber: bigint, baseTime: number): Promise<{ rpc: string; rows: Row[] }> {
  const layout: Array<Array<{ step?: Step; check?: Check }>> = [[], [], []];
  for (const s of steps) {
    const bi = s.block;
    layout[bi].push({ step: s });
    for (const c of checks.filter(c => c.afterStep === s.id)) layout[bi].push({ check: c });
  }
  const blocks: SimBlock[] = [];
  const map: Array<Array<{ step?: Step; check?: Check }>> = [];
  layout.forEach((items, bi) => {
    if (!items.length) return;
    blocks.push({
      ...(bi === 0 ? {} : { time: baseTime + 180 * bi }),
      calls: items.map(it => it.step
        ? { from: it.step.from, to: it.step.to, data: it.step.data, value: it.step.value }
        : { from: W_VET, to: it.check!.to, data: it.check!.data }),
    });
    map.push(items);
  });
  const r = await simulateBlocks(blocks, blockNumber, urls);
  const rows: Row[] = [];
  r.blocks.forEach((b, bi) => b.forEach((res, i) => {
    const it = map[bi][i];
    if (it.step) rows.push({ step: it.step, res, verdict: res.status });
    else {
      const bad = res.status === 'OK' ? it.check!.expect(res.returnData) : res.error ?? 'revert';
      rows.push({ check: it.check, res, verdict: bad ? 'NG' : 'OK', ...(bad ? { res: { ...res, error: bad } } : {}) });
    }
  }));
  return { rpc: r.rpc, rows };
}

// A call to an address without code "succeeds" in eth_simulateV1 and on chain, and does nothing.
// Every step that carries calldata must hit code: already on chain, or deployed by an earlier step of the same sequence.
async function codelessTargets(c: PublicClient, seq: Step[], x: Ctx, blockNumber: bigint): Promise<string[]> {
  const deployedBy: Record<string, Address> = { 'K1-04': x.predicted.P_a, 'K1-07': x.predicted.P_bc, 'K1-D2': x.predicted.P_d, 'K1-10': x.predicted.U, 'K1-12': x.predicted.P_AG1 };
  const made = new Set<string>();
  const cache = new Map<string, boolean>();
  const bad: string[] = [];
  for (const s of seq) {
    if (s.data) {
      const to = s.to.toLowerCase();
      if (!made.has(to)) {
        if (!cache.has(to)) { const code = await c.getCode({ address: s.to, blockNumber }); cache.set(to, !!code && code !== '0x'); }
        if (!cache.get(to)) bad.push(`${s.id}: 宛先 ${s.to} にコードが無い（配備の手順がまだ鎖に無い）`);
      }
    }
    if (deployedBy[s.id]) made.add(deployedBy[s.id].toLowerCase());
  }
  return bad;
}

// On-chain facts each command needs from earlier commands. If one is missing, [2] failing is expected.
async function missingPrereqs(c: PublicClient, o: Opts, x: Ctx): Promise<string[]> {
  const P = x.predicted;
  const code = async (label: string, a: Address) => { const k = await c.getCode({ address: a, blockNumber: x.block }); return k && k !== '0x' ? null : `${label} ${a} が未配備`; };
  const registered = async (label: string) => (await c.readContract({ address: ADDR.rg, abi: RG, functionName: 'isAvailable', args: [label], blockNumber: x.block })) ? `${label}.eth が未登録` : null;
  const need: Array<Promise<string | null>> = [];
  const resolverFor = (n?: string) => (n && RESOLVER_OF[n] ? need.push(code(RESOLVER_OF[n].key, P[RESOLVER_OF[n].key])) : 0);
  switch (o.cmd) {
    case 'deploy-resolvers': need.push(registered('seller-d')); break;
    case 'k1b': need.push(code('P_a', P.P_a), code('P_d', P.P_d)); break;
    case 'agents': if (o.post) need.push(code('U', P.U), code('P_AG1', P.P_AG1)); break;
    case 'set-offer-e': need.push(registered('seller-e'), code('P_bc', P.P_bc)); break;
    case 'publish-attestations': need.push(code('P_a', P.P_a), code('P_bc', P.P_bc), code('P_d', P.P_d)); break;
    case 'align-bc': need.push(code('P_bc', P.P_bc)); break;
    case 'unlink': case 'link': case 'relink': resolverFor(o.args[0]); break;
    default: break;
  }
  return (await Promise.all(need)).filter((m): m is string => !!m);
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
function printRow(r: Row, tag = '') {
  if (r.step) {
    const s = r.step;
    const v = r.verdict === 'OK' ? `[${r.res.logs.join(',')}]`.slice(0, 110) : r.res.error;
    console.log(`  ${pad(r.verdict, 6)} ${pad(s.id, 10)} ${pad(s.signer, 5)} gas=${pad(String(r.res.gas), 8)} ${tag}${s.what}${s.value ? '' : ''}  ${v}`);
  } else {
    console.log(`  ${pad(r.verdict, 6)} ${r.check!.id}${r.verdict === 'OK' ? '' : '  ' + r.res.error}`);
  }
}

// ---------------------------------------------------------------- Base Sepolia (k1b)
function bsSteps(roles: Roles, fromId?: string) {
  const a = amounts();
  const t = (to: Address, v: bigint) => encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, v] });
  const all = [
    { id: 'BS-01a', signer: 'W_ens' as const, from: W_ENS, to: USDC_BASE_SEPOLIA, data: t(roles.W_pay, a.bs01UsdcUnits), what: `USDC ${Number(a.bs01UsdcUnits) / 1e6} W_ens -> W_pay` },
    { id: 'BS-01b', signer: 'W_ens' as const, from: W_ENS, to: roles.W_pay, value: a.bs01EthWei, what: `ETH ${fmtEth(a.bs01EthWei)} W_ens -> W_pay` },
    { id: 'BS-02', signer: 'W_pay' as const, from: roles.W_pay, to: USDC_BASE_SEPOLIA, data: t(W_ENS, a.bs02UsdcUnits), what: `USDC ${Number(a.bs02UsdcUnits) / 1e6} W_pay -> W_ens = SEED_TX` },
  ];
  if (!fromId) return all;
  const i = all.findIndex(s => s.id === fromId);
  if (i < 0) throw new Error(`--base-from ${fromId} は BS-01a / BS-01b / BS-02 のどれでもない`);
  return all.slice(i);
}

type BaseGate = { ok: boolean; url?: string; gas: Record<string, number> };
/**
 * Base Sepolia rows of k1b. The same gate for --dry-run and --live: chainId 84532, the three rows pass
 * eth_simulateV1 in order, and (live) every sender holds gas x1.3 + 30k (W_pay may count the ETH BS-01b brings).
 */
async function baseGate(roles: Roles, checkBalance: boolean, fromId?: string): Promise<BaseGate> {
  const gas: Record<string, number> = {};
  let url: string;
  try { url = baseSepoliaRpc(); } catch (e: any) { console.log(`  NG     BS-01/BS-02  ${e.message}`); return { ok: false, gas }; }
  const chainId = parseInt(await rpc<string>(url, 'eth_chainId', []), 16);
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) { console.log(`  NG     Base Sepolia の chainId が ${chainId}`); return { ok: false, gas }; }
  const bn = BigInt(await rpc<string>(url, 'eth_blockNumber', []));
  const steps = bsSteps(roles, fromId);
  try {
    const r = await simulateBlocks([{ calls: steps.map(s => ({ from: s.from, to: s.to, data: s.data, value: s.value })) }], bn, [url]);
    let ok = true;
    r.blocks[0].forEach((res, i) => {
      ok &&= res.status === 'OK';
      gas[steps[i].id] = res.gas;
      console.log(`  ${pad(res.status, 6)} ${pad(steps[i].id, 10)} ${pad(steps[i].signer, 5)} gas=${pad(String(res.gas), 8)} ${steps[i].what}  ${res.status === 'OK' ? '' : res.error}  [Base Sepolia ${hostOf(url)}]`);
    });
    if (ok && checkBalance) {
      const bc = createPublicClient({ chain: baseSepolia, transport: http(url) }) as PublicClient;
      const fees = await bc.estimateFeesPerGas();
      const price = fees.maxFeePerGas ?? (await bc.getGasPrice());
      const cost = (id: string) => BigInt(Math.ceil(gas[id] * 1.3) + 30_000) * price;
      const bs01b = steps.find(s => s.id === 'BS-01b');
      const incoming: Record<string, bigint> = { W_pay: bs01b?.value ?? 0n };
      for (const signer of ['W_ens', 'W_pay'] as const) {
        const mineS = steps.filter(s => s.signer === signer);
        if (mineS.length === 0) continue;
        const need = mineS.reduce((t, s) => t + cost(s.id) + (s.value ?? 0n), 0n);
        const bal = await bc.getBalance({ address: mineS[0].from });
        const have = bal + (incoming[signer] ?? 0n);
        const good = have >= need;
        ok &&= good;
        console.log(`  ${good ? 'OK    ' : 'NG    '} balance ${pad(signer, 5)} ${mineS[0].from} ${fmtEth(bal)}${incoming[signer] ? ' + BS-01b ' + fmtEth(incoming[signer]) : ''} >= ${fmtEth(need)} (Base Sepolia maxFee ${Number(price) / 1e9} gwei, gas x1.3 + 30k)`);
      }
    }
    return { ok, url, gas };
  } catch (e: any) {
    // RPC without eth_simulateV1: BS-01a alone by eth_call; BS-02 can only be checked after BS-01.
    console.log(`  注意: ${hostOf(url)} は eth_simulateV1 を受けない (${String(e.message).slice(0, 80)})。BS-01a を eth_call だけで見る`);
    try {
      await rpc(url, 'eth_call', [{ from: steps[0].from, to: steps[0].to, data: steps[0].data }, 'latest']);
      console.log(`  OK     BS-01a     W_ens eth_call ${steps[0].what}`);
    } catch (e2: any) { console.log(`  REVERT BS-01a     ${String(e2.message).slice(0, 160)}`); return { ok: false, gas }; }
    console.log('  未確認 BS-01b/BS-02 （BS-01 の後でしか確かめられない）。eth_simulateV1 を受ける Base Sepolia RPC にする');
    return { ok: false, gas };
  }
}

// ---------------------------------------------------------------- live
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) { console.log('標準入力が端末でないので送らない（人が y を打つ場でだけ送る）'); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim();
  rl.close();
  return a === 'y';
}

function signerKey(signer: string): Hex {
  const envName = signer === 'W_vet' ? OWNER_PK_ENV.W_vet : signer === 'W_ens' ? OWNER_PK_ENV.W_ens : KEY_SPECS.find(k => k.id === signer)!.pk;
  const v = process.env[envName];
  if (!v) throw new Error(`--live に ${envName} が要る（${envFilePath()}）`);
  return (v.startsWith('0x') ? v : '0x' + v) as Hex;
}

async function sendAll(c: PublicClient, url: string, chain: typeof sepolia | typeof baseSepolia, steps: Array<{ id: string; signer: string; from: Address; to: Address; data?: Hex; value?: bigint }>, gasOf: (id: string) => number, onSent?: (id: string, hash: Hex, blockTs: number) => Promise<void>) {
  for (const s of steps) {
    const account = privateKeyToAccount(signerKey(s.signer));
    if (account.address.toLowerCase() !== s.from.toLowerCase()) throw new Error(`${s.id}: ${s.signer} の鍵のアドレス ${account.address} が from ${s.from} と違う`);
    const w = createWalletClient({ account, chain, transport: http(url) });
    const gas = BigInt(Math.ceil(gasOf(s.id) * 1.3) + 30_000);
    const hash = await w.sendTransaction({ to: s.to, data: s.data, value: s.value, gas } as any);
    console.log(`  sent   ${pad(s.id, 10)} ${hash}`);
    const rc = await c.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error(`${s.id} が失敗した (tx ${hash})。ここで止める`);
    // Public RPCs behind a load balancer can return the receipt from one node and miss the block on the
    // next ("Block at number N could not be found", seen 2026-09-25 22:1x on Base Sepolia). Retry, then
    // fall back to the local clock: the tx is already mined, so stopping here would only strand later rows.
    let ts = Math.floor(Date.now() / 1000);
    for (let k = 0; k < 10; k++) {
      try { ts = Number((await c.getBlock({ blockNumber: rc.blockNumber })).timestamp); break; }
      catch { await new Promise(r => setTimeout(r, 2000)); }
    }
    console.log(`  mined  ${pad(s.id, 10)} block ${rc.blockNumber} gasUsed ${rc.gasUsed}`);
    if (onSent) await onSent(s.id, hash, ts);
  }
}

async function balanceGate(c: PublicClient, steps: Array<{ signer: string; from: Address; value?: bigint; id: string }>, gasOf: (id: string) => number): Promise<boolean> {
  const fees = await c.estimateFeesPerGas();
  const price = fees.maxFeePerGas ?? (await c.getGasPrice());
  const need = new Map<string, { from: Address; wei: bigint }>();
  for (const s of steps) {
    const cur = need.get(s.signer) ?? { from: s.from, wei: 0n };
    cur.wei += BigInt(Math.ceil(gasOf(s.id) * 1.3) + 30_000) * price + (s.value ?? 0n);
    need.set(s.signer, cur);
  }
  let ok = true;
  for (const [signer, n] of need) {
    const bal = await c.getBalance({ address: n.from });
    const good = bal >= n.wei;
    ok &&= good;
    console.log(`  ${good ? 'OK    ' : 'NG    '} balance ${pad(signer, 5)} ${n.from} ${fmtEth(bal)} >= ${fmtEth(n.wei)} (maxFee ${Number(price) / 1e9} gwei, gas x1.3 + 30k)`);
  }
  return ok;
}

// ---------------------------------------------------------------- main
async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  if (!o.cmd || o.cmd === 'help') { console.log(help()); return o.cmd ? 0 : 1; }
  if (!COMMANDS.some(([c]) => c === o.cmd)) { console.log(help()); throw new Error(`知らない下位コマンド ${o.cmd}`); }

  const envf = loadEnvFile();
  const { read, sim } = sepoliaRpcs();
  const url = await pickRpc([...sim, ...read.filter(u => !sim.includes(u))]);
  const c = client(url);
  const chainId = await c.getChainId();
  if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`chainId ${chainId}（Sepolia ${SEPOLIA_CHAIN_ID} でない）。止める`);
  const { roles, dummy } = readRoles(o.live);
  const x = await buildCtx(c, roles, dummy, o.live ? undefined : o.block);
  const steps = buildSteps(x);
  const checks = buildChecks(x);
  const publish = o.cmd === 'publish-attestations' ? await attestationSteps(o, x) : null;
  const extra = publish ? publish.steps : extraSteps(o, x);
  const own = ownCmds(o);
  const mine = [...steps.filter(s => own.includes(s.cmd)), ...extra.map(s => ({ ...s, block: 1 as const }))];
  // extra (post-K1) rows go in a third simulated block after the whole K1 chain.
  const chain = [...steps, ...extra.map(s => ({ ...s, block: 2 as unknown as 1 }))];

  console.log(`admin.ts ${o.cmd}${o.post ? ' --post' : ''} ${o.live ? '--live' : '--dry-run'} | Sepolia ${hostOf(url)} block ${x.block} | env ${envf.loaded ? envf.file : '(file not found)'}`);
  if (dummy.length) console.log(`  dry-run のダミーアドレス（keys.ts init の前）: ${dummy.join(', ')}`);
  console.log(`  P_a ${x.predicted.P_a}  P_bc ${x.predicted.P_bc}  P_d ${x.predicted.P_d}  U ${x.predicted.U}  P_AG1 ${x.predicted.P_AG1}`);
  if (o.cmd === 'deploy-resolvers' && o.printPredicted) return 0;
  if (o.cmd === 'register-d' || o.cmd === 'register-e') console.log('  dry-run は commit の 60 秒待ちを飛ばす（register は 180 秒後の2番目の simulate ブロック）。--live はコマンドの中で待つ');

  // (1) the whole K1 chain in order, this command's rows marked
  const full = await runChain(chain, checks, x, sim, x.block, x.now);
  const mineIds = new Set(mine.map(s => s.id));
  console.log(`\n[1] K1 の連鎖全体を eth_simulateV1（${hostOf(full.rpc)}）。このコマンドの行:`);
  let ownOk = true;
  for (const r of full.rows) {
    const isMine = r.step ? mineIds.has(r.step.id) : mineIds.has(r.check!.afterStep);
    if (!isMine) continue;
    printRow(r);
    if (r.verdict !== 'OK') ownOk = false;
  }
  for (const m of await codelessTargets(c, chain, x, x.block)) { console.log(`  NG     ${m}`); ownOk = false; }
  const others = full.rows.filter(r => r.step && !mineIds.has(r.step.id));
  const otherBad = others.filter(r => r.verdict !== 'OK');
  console.log(`  他の行: ${others.length} 本中 OK ${others.length - otherBad.length}${otherBad.length ? ' / REVERT ' + otherBad.map(r => r.step!.id).join(',') : ''}`);
  const ownGas = full.rows.filter(r => r.step && mineIds.has(r.step.id)).reduce((s, r) => s + r.res.gas, 0);
  console.log(`  このコマンドの合計 gas ${ownGas}`);
  const k1Ids = ['K1-02', 'K1-03', 'K1-04', 'K1-05', 'K1-06', 'K1-07', 'K1-08', 'K1-09', 'K1-10', 'K1-11', 'K1-12', 'K1-13', 'K1-14', 'K1-15'];
  const k1Gas = full.rows.filter(r => r.step && k1Ids.includes(r.step.id)).reduce((s, r) => s + r.res.gas, 0);
  const k1All = full.rows.filter(r => r.step && r.step.id.startsWith('K1-') || r.step?.id === 'BS-03' || r.step?.id === 'K1a-fund');
  console.log(`  K1-02〜K1-15（14 本）の合計 gas ${k1Gas} ／ 予行演習 3,960,225 − K1-01 41,137 − K1-03b 98,912（予行演習だけの W_obs の試し書き）= 3,820,176 ／ 差 ${k1Gas - 3_820_176}`);
  console.log(`  会期の K1 全体（Sepolia ${k1All.length} 本・seller-e 含む）の合計 gas ${k1All.reduce((s, r) => s + r.res.gas, 0)}`);

  // (2) this command alone on the current chain: the --live gate
  const alone = await runChain(mine, checks.filter(ch => mineIds.has(ch.afterStep)), x, sim, x.block, x.now);
  const noCode = await codelessTargets(c, mine, x, x.block);
  const aloneOk = alone.rows.every(r => r.verdict === 'OK') && noCode.length === 0;
  const missing = aloneOk ? [] : await missingPrereqs(c, o, x);
  const aloneVerdict = aloneOk ? 'OK' : missing.length ? `通らない・想定どおり（前のコマンドがまだ鎖に無い: ${missing.join(' / ')}）` : '通らない・本当に通らない（前提はそろっているのに revert する）';
  console.log(`\n[2] このコマンドだけを今の鎖の上で（= --live の関門）: ${aloneVerdict}`);
  if (!aloneOk) for (const r of alone.rows.filter(r => r.verdict !== 'OK')) printRow(r);
  for (const m of noCode) console.log(`  NG     ${m}`);

  // publish-attestations: [3] the envelopes against the chain, [4] the re-run (B5c) overwrites the same keys.
  let publishOk = true;
  if (publish) {
    console.log(`\n[3] envelope の検証（${publish.source}）: 草案の手順どおり ENS から payload を組み直し、署名者が atst.vet402.eth の固定アドレスか`);
    if (!publish.checks) { console.log(`  署名する材料が無い: envelope がまだ無い（B5a の attester.ts --live-pay が ${DEFAULT_ENVELOPES} を書く）。[1][2] は同じ長さの DUMMY で測った`); publishOk = !o.live; }
    else for (const ch of publish.checks) { console.log(`  ${ch.ok ? 'OK    ' : 'NG    '} ${pad(ch.name, 14)} ${ch.why}`); publishOk &&= ch.ok; }
    const twice = await runChain([...mine.map(s => ({ ...s, block: 0 as const })), ...publish.rerun.map(s => ({ ...s, block: 1 as const }))], [], x, sim, x.block, x.now);
    const rerunOk = twice.rows.every(r => r.verdict === 'OK');
    console.log(`\n[4] 打ち直し（B5c: 同じ4キーを新しい envelope で上書き）を続けて eth_simulateV1: ${rerunOk ? 'OK' : 'NG'}`);
    for (const r of twice.rows) printRow(r);
    publishOk &&= rerunOk;
  }

  let base: BaseGate = { ok: true, gas: {} };
  if (o.cmd === 'k1b') { console.log(`\n[3] Base Sepolia（BS-01 / BS-02${o.baseFrom ? ' — ' + o.baseFrom + ' から後ろだけ' : ''}）`); base = await baseGate(roles, o.live, o.baseFrom); }

  if (!o.live) {
    const reallyFails = !aloneOk && missing.length === 0;
    const ok = ownOk && base.ok && !reallyFails && publishOk;
    console.log(`\n${ok ? 'dry-run ok' : 'dry-run NG'}: ${o.cmd}${o.post ? ' --post' : ''}（署名・送信はしていない）`);
    return ok ? 0 : 2;
  }

  // ------------------------------------------------ live
  if (o.baseFrom) console.log(`\n[live] --base-from ${o.baseFrom}: Sepolia には1本も送らない`);
  if (!o.baseFrom) {
  if (!aloneOk) { console.log('\n--live を止める: このコマンドが今の鎖の上で通らない'); return 2; }
  if (!base.ok) { console.log('\n--live を止める: Base Sepolia の行が単独で通らないか、送り手の残高が足りない（[3]）'); return 2; }
  if (!publishOk) { console.log('\n--live を止める: envelope が今の鎖の上で有効でない（[3]）か、打ち直しの模擬が通らない（[4]）'); return 2; }
  const gasOf = (id: string) => alone.rows.find(r => r.step?.id === id)!.res.gas;
  console.log('\n[live] 残高の関門');
  if (!(await balanceGate(c, mine, gasOf))) { console.log('残高が足りない。止める'); return 2; }
  if (o.cmd === 'agents' && o.post) console.log('  確認: K1-15c の前に B0 で rehearsal --h13 の A3〜A5 が読めたこと（PLAN section 4）');
  console.log(`\n[live] Sepolia (chainId ${chainId}) に ${mine.length} 本送る:`);
  for (const s of mine) console.log(`  ${pad(s.id, 10)} ${pad(s.signer, 5)} ${s.from} -> ${s.to}  ${s.what}${s.value ? '  value ' + fmtEth(s.value) : ''}`);
  if (!(await confirm('送るなら y を打つ: '))) { console.log('送らなかった'); return 1; }

  const isRegister = o.cmd === 'register-d' || o.cmd === 'register-e';
  if (isRegister) {
    const [approve, commit, register] = mine;
    const minAge = Number(await c.readContract({ address: ADDR.rg, abi: RG, functionName: 'MIN_COMMITMENT_AGE' }));
    let commitTs = 0;
    await sendAll(c, url, sepolia, [approve, commit], gasOf, async (id, _h, ts) => { if (id === commit.id) commitTs = ts; });
    const until = commitTs + minAge + COMMIT_WAIT_MARGIN_S;
    for (;;) {
      const t = Number((await c.getBlock()).timestamp);
      if (t >= until) break;
      console.log(`  commit の熟成待ち: あと ${until - t} 秒`);
      await new Promise(r => setTimeout(r, Math.min(15, until - t) * 1000));
    }
    const re = await runChain([{ ...register, block: 0 }], [], x, sim, await c.getBlockNumber(), 0);
    if (re.rows[0].verdict !== 'OK') { console.log(`register の再 simulate が通らない: ${re.rows[0].res.error}。止める`); return 2; }
    await sendAll(c, url, sepolia, [register], () => re.rows[0].res.gas);
  } else {
    await sendAll(c, url, sepolia, mine, gasOf);
  }
  } // end of the Sepolia part (skipped with --base-from)

  if (o.cmd === 'k1b') {
    const bUrl = baseSepoliaRpc();
    const bc = createPublicClient({ chain: baseSepolia, transport: http(bUrl) }) as PublicClient;
    const bId = await bc.getChainId();
    if (bId !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`Base Sepolia の chainId が ${bId}。止める`);
    const bs = bsSteps(roles, o.baseFrom);
    // Gate again right before sending: the Sepolia rows took minutes and balances may have moved.
    console.log('\n[live] Base Sepolia の関門（単独の simulate と残高）をもう一度');
    const again = await baseGate(roles, true, o.baseFrom);
    if (!again.ok || again.url !== bUrl) { console.log('Base Sepolia の関門が外れた。送らない'); return 2; }
    const gasBs = (id: string) => again.gas[id];
    for (const s of bs) console.log(`  ${pad(s.id, 10)} ${pad(s.signer, 5)} ${s.from} -> ${s.to}  ${s.what}`);
    if (!(await confirm('Base Sepolia に送るなら y を打つ: '))) { console.log('Base Sepolia は送らなかった'); return 1; }
    await sendAll(bc, bUrl, baseSepolia, bs, gasBs, async (id, hash) => {
      if (id !== 'BS-02') return;
      if (process.env.SEED_TX) console.log(`  SEED_TX は env に既にある。追記しない（新しい tx: ${hash}）`);
      else { appendEnvLine('SEED_TX', hash); console.log(`  SEED_TX=${hash} を ${envFilePath()} に追記した`); }
    });
  }
  console.log(`\nlive ok: ${o.cmd}`);
  return 0;
}

main().then(code => { process.exitCode = code; }, e => { console.error(`admin.ts: ${e?.message ?? e}`); process.exitCode = 1; });

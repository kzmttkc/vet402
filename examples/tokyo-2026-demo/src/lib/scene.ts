// run.ts pay / mutate / reset / cut-vet402 / scene3 (PLAN_v4.3 sections 3.8, 3.3.3, 3.10, section 4 D-1..D-5, 8.2).
//
//   npx tsx src/run.ts pay <name> [--dry-run | --live] [--test-attester] [--agent agent-1.vet402.eth]
//   npx tsx src/run.ts cut-vet402 [--mode refused|503]        # every later pay asks an unreachable vet402 API
//   npx tsx src/run.ts cut-vet402 --restore
//   npx tsx src/run.ts cut-vet402 [--mode refused|503] pay <name> [...]   # one run only
//   npx tsx src/run.ts mutate [--dry-run | --live] [--test-attester]    # D-1  (W_op)
//   npx tsx src/run.ts reset  [--dry-run | --live] [--test-attester]    # D-1r (W_op)
//   npx tsx src/run.ts scene3 [--dry-run | --live] [--test-attester] [--assume-align-bc]   # D-2 -> D-3 -> D-4 -> D-5 (W_ens)
//
// --dry-run is the default and never signs a transaction or a payment. mutate / reset / scene3 run on
// eth_simulateV1; pay runs every SDK gate and stops at the payer, which holds no key.
// --live is for the human, with a screen recording running. It checks the chainId, simulates the
// transaction alone on the current chain, checks the signer's balance, and sends nothing until a typed y.
// scene3 --live hands each linkToRecord to admin.ts (unlink / relink / link / relink), which applies the same
// gates and asks its own y. The clean-up of seller-c (D-5) is always the last thing scene3 does.
//
// --test-attester (dry-run only): a simulation-only stand-in for B5b. anvil #0 (public test key) becomes
// atst.vet402.eth and signs the envelopes inside the simulation, so the ALLOW path and the signer_mismatch
// refusals can be shown before the real envelopes exist. --assume-align-bc adds admin.ts align-bc (BC-1) to the
// simulated state (before 07:00 seller-b/c still carry the K1-07 offers and no agent-endpoint[x402]).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, getAddress, http as viemHttp, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia } from 'viem/chains';
import { DEMO_DIR, loadEnvFile, sepoliaRpcs } from './env.ts';
import { hostOf, pickRpc } from './rpc.ts';
import { loadEnsSdk } from './sdk.ts';
import { SEED_TX_BLOCK_FALLBACK } from '../attester.ts';
import { screenPayment, SCREENING_CACHE_TTL_MS, type ScreeningCache, type ScreeningResult } from '../screening.ts';
import { dryPayer, runPayFlow, type PayFlowOutcome } from './pay-flow.ts';
import {
  ANVIL0, OFFER_A, OFFER_A_1CHAR, P_A, P_AG1, P_BC, P_D, W_OP_DEFAULT, alignBcCall, demoTx, recordIdCall, simulateSequence,
  simulatedEnsClients, testAttesterFixture, type PreCall,
} from './sim-ens.ts';
import { W_ENS, fmtEth } from './k1.ts';

const OUT_DIR = path.join(DEMO_DIR, 'out');
const CUT_FILE = path.join(OUT_DIR, 'cut-vet402.json');
const SCREEN_CACHE_FILE = path.join(OUT_DIR, 'screening-cache.json');
const DEFAULT_RESOURCE = 'https://vet402.com/api/tokyo/seller';
const DEFAULT_AGENT = 'agent-1.vet402.eth';
const SDK_DEFAULT_API = 'https://vet402.com/api/v1';
// Not port 1: fetch refuses the "bad ports" (1, 7, 9, …) without opening a socket ("fetch failed: bad port",
// measured 2026-09-26 on node 26), so nothing would be asked. 40402 is outside that list; startCut checks that
// the connection is refused before every run. TOKYO_CUT_PORT overrides it.
const CUT_PORT = Number(process.env.TOKYO_CUT_PORT || 40402);
const CUT_REFUSED_URL = `http://127.0.0.1:${CUT_PORT}/api/v1`;
const BASE_SEPOLIA = { name: 'base-sepolia', network: 'eip155:84532', chainId: 84532, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' } as const;
const SEPOLIA_CHAIN_ID = 11155111;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const ERC20_READ = parseAbi(['function balanceOf(address) view returns (uint256)']);

type Opts = { cmd: string; live: boolean; testAttester: boolean; alignBc: boolean; agent: string; mode: 'refused' | '503'; restore: boolean; cutOnce: boolean; args: string[] };

function parseArgs(cmd: string, argv: string[]): Opts {
  const o: Opts = { cmd, live: false, testAttester: false, alignBc: false, agent: DEFAULT_AGENT, mode: 'refused', restore: false, cutOnce: false, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') o.live = true;
    else if (a === '--dry-run') o.live = false;
    else if (a === '--test-attester') o.testAttester = true;
    else if (a === '--assume-align-bc') o.alignBc = true;
    else if (a === '--restore') o.restore = true;
    else if (a === '--agent') o.agent = String(argv[++i]);
    else if (a === '--mode' || a.startsWith('--mode=')) {
      const v = a.includes('=') ? a.split('=')[1] : String(argv[++i]);
      if (v !== 'refused' && v !== '503') throw new Error(`--mode は refused か 503（404 は「届かない」に当たらないので用意しない・PLAN §3.8）。got ${v}`);
      o.mode = v;
    } else if (a.startsWith('--')) throw new Error(`知らないオプション ${a}`);
    else o.args.push(a);
  }
  if (argv.includes('--live') && argv.includes('--dry-run')) throw new Error('--live と --dry-run を同時に付けない');
  if (o.live && o.testAttester) throw new Error('--test-attester は模擬の世界。--live と一緒に使わない');
  if (o.live && o.alignBc) throw new Error('--assume-align-bc は模擬の世界。--live と一緒に使わない');
  return o;
}

// ---------------------------------------------------------------- readers
function sepoliaReaders() {
  const { read, sim } = sepoliaRpcs();
  const primary = read[0];
  const secondary = read.find(u => hostOf(u) !== hostOf(primary));
  if (!secondary) throw new Error(`Sepolia の読み口は別の提供元を2つ（env に ${read.map(hostOf).join(', ')} しか無い）`);
  const mk = (u: string) => createPublicClient({ chain: sepolia, transport: viemHttp(u, { timeout: 30_000, retryCount: 1 }) });
  return { clients: { primary: mk(primary), secondary: mk(secondary) }, hosts: [hostOf(primary), hostOf(secondary)], sim, read };
}

function baseSepoliaReaders() {
  const primary = process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';
  const cross = process.env.BASE_SEPOLIA_RPC_URL_2 || 'https://sepolia.base.org';
  if (hostOf(primary) === hostOf(cross)) throw new Error(`Base Sepolia の読み口は別の提供元を2つ（両方 ${hostOf(primary)}）。BASE_SEPOLIA_RPC_URL_2 を足す`);
  const mk = (u: string) => createPublicClient({ chain: baseSepolia, transport: viemHttp(u, { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
  return { reader: mk(primary), cross: mk(cross), hosts: [hostOf(primary), hostOf(cross)] };
}

async function chainFromBlock(reader: PublicClient): Promise<{ block: bigint; source: string }> {
  if (process.env.TOKYO_CHAIN_FROM_BLOCK) return { block: BigInt(process.env.TOKYO_CHAIN_FROM_BLOCK), source: 'env TOKYO_CHAIN_FROM_BLOCK' };
  const seed = process.env.SEED_TX;
  if (seed && /^0x[0-9a-fA-F]{64}$/.test(seed)) {
    try {
      const rc = await reader.getTransactionReceipt({ hash: seed as Hex });
      if (rc.status === 'success') return { block: rc.blockNumber, source: 'SEED_TX receipt' };
    } catch { /* below */ }
  }
  return { block: SEED_TX_BLOCK_FALLBACK, source: 'K1_LOG BS-02 block (fallback)' };
}

function localAttesters(): Array<{ name: string; address: string; recordKeys: string[] }> {
  const j = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'trusted-attesters.json'), 'utf8'));
  return j.trustedAttesters ?? [];
}
function localMaxAge(): number {
  const j = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'trusted-attesters.json'), 'utf8'));
  return typeof j.maxAgeSeconds === 'number' ? j.maxAgeSeconds : 86_400;
}

// ---------------------------------------------------------------- screening cache on disk (1,000 calls per key)
// The in-process cache of screening.ts lasts one run. pay seller-a then pay seller-e are two runs, and both screen
// the payer: this file keeps pass/block for the same 10 minutes so the payer is asked once. No key is stored.
function loadScreenCache(): ScreeningCache {
  const m: ScreeningCache = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(SCREEN_CACHE_FILE, 'utf8')) as Record<string, { at: number; result: ScreeningResult }>;
    for (const [k, v] of Object.entries(j)) {
      if (Date.now() - v.at < SCREENING_CACHE_TTL_MS && (v.result.verdict === 'pass' || v.result.verdict === 'block')) m.set(k, { at: v.at, promise: Promise.resolve(v.result) });
    }
  } catch { /* no file yet */ }
  return m;
}
async function saveScreenCache(m: ScreeningCache): Promise<void> {
  const o: Record<string, { at: number; result: ScreeningResult }> = {};
  for (const [k, v] of m) {
    const r = await v.promise;
    if (Date.now() - v.at < SCREENING_CACHE_TTL_MS && (r.verdict === 'pass' || r.verdict === 'block')) o[k] = { at: v.at, result: r };
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SCREEN_CACHE_FILE, JSON.stringify(o, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------- cut-vet402
export type Cut = { mode: 'refused' | '503'; url: string; close: () => Promise<void> };

/** "unreachable" is exactly two things (PLAN 3.3.3 G5): a refused connection, or HTTP 503 from a throwaway server. */
export async function startCut(mode: 'refused' | '503'): Promise<Cut> {
  if (mode === 'refused') {
    const refused = await new Promise<boolean>(resolve => {
      const sock = net.connect({ host: '127.0.0.1', port: CUT_PORT });
      sock.once('connect', () => { sock.destroy(); resolve(false); });
      sock.once('error', (e: any) => resolve(e?.code === 'ECONNREFUSED'));
    });
    if (!refused) throw new Error(`127.0.0.1:${CUT_PORT} does not refuse connections (something listens there). Set TOKYO_CUT_PORT to a closed port`);
    return { mode, url: CUT_REFUSED_URL, close: async () => {} };
  }
  const srv = http.createServer((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}'); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  return { mode, url: `http://127.0.0.1:${port}/api/v1`, close: () => new Promise<void>(r => srv.close(() => r())) };
}

function cutState(): { mode: 'refused' | '503'; at: string } | null {
  try { return JSON.parse(fs.readFileSync(CUT_FILE, 'utf8')); } catch { return null; }
}

async function cmdCut(o: Opts): Promise<number> {
  if (o.restore) {
    const had = cutState();
    if (fs.existsSync(CUT_FILE)) fs.unlinkSync(CUT_FILE);
    console.log(had ? `cut-vet402 restored: pay asks ${process.env.VET402_API_URL || SDK_DEFAULT_API} again (was ${had.mode} since ${had.at})` : 'cut-vet402 was not on. Nothing to restore.');
    return 0;
  }
  if (o.args[0] === 'pay') {
    return cmdPay({ ...o, cmd: 'pay', cutOnce: true, args: o.args.slice(1) });
  }
  if (o.args.length) throw new Error(`cut-vet402 のあとに置けるのは pay <name> だけ（got ${o.args.join(' ')}）`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(CUT_FILE, JSON.stringify({ mode: o.mode, at }) + '\n');
  const url = o.mode === 'refused' ? CUT_REFUSED_URL : 'http://127.0.0.1:<port>/api/v1 (a throwaway server that answers 503, started inside each pay)';
  console.log(`cut-vet402 on (${o.mode}): every pay now asks the vet402 API at ${url}`);
  if (o.mode === 'refused') console.log(`  check it in another terminal: curl -sS -m 3 ${CUT_REFUSED_URL}/health   # expect: curl: (7) Failed to connect`);
  console.log('  undo: npx tsx src/run.ts cut-vet402 --restore');
  return 0;
}

// ---------------------------------------------------------------- live helpers
async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) { console.log('標準入力が端末でないので送らない（人が y を打つ場でだけ送る）'); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a === 'y';
}

const SIGNER_ENV: Record<string, string> = { W_op: 'TOKYO_OPERATOR_PRIVATE_KEY', W_ens: 'W_ENS_PRIVATE_KEY' };

/** The admin.ts discipline for one Sepolia transaction: chainId, simulate alone, balance, typed y, then send. */
async function sendGated(steps: Array<PreCall & { signer: 'W_op' | 'W_ens' }>): Promise<boolean> {
  const { read, sim } = sepoliaRpcs();
  const url = await pickRpc([...sim, ...read.filter(u => !sim.includes(u))]);
  const c = createPublicClient({ chain: sepolia, transport: viemHttp(url, { timeout: 60_000 }) }) as PublicClient;
  const chainId = await c.getChainId();
  if (chainId !== SEPOLIA_CHAIN_ID) { console.log(`  NG     chainId ${chainId}（Sepolia ${SEPOLIA_CHAIN_ID} でない）。送らない`); return false; }
  console.log(`  OK     chainId ${chainId} (${hostOf(url)})`);
  const bn = await c.getBlockNumber();
  const res = await simulateSequence(steps, bn, sim);
  let ok = true;
  res.forEach((r, k) => { ok &&= r.status === 'OK'; console.log(`  ${r.status.padEnd(6)} ${steps[k].id.padEnd(5)} ${steps[k].signer.padEnd(5)} gas=${String(r.gas).padEnd(7)} ${steps[k].what}  ${r.status === 'OK' ? '[' + r.logs.join(',') + ']' : r.error}`); });
  if (!ok) { console.log('  --live を止める: 今の鎖の上で通らない'); return false; }
  const fees = await c.estimateFeesPerGas();
  const price = fees.maxFeePerGas ?? (await c.getGasPrice());
  const gasOf = (k: number) => BigInt(Math.ceil(res[k].gas * 1.3) + 30_000);
  const need = new Map<string, { from: Address; wei: bigint }>();
  steps.forEach((s, k) => { const cur = need.get(s.signer) ?? { from: s.from, wei: 0n }; cur.wei += gasOf(k) * price; need.set(s.signer, cur); });
  for (const [signer, n] of need) {
    const bal = await c.getBalance({ address: n.from });
    const good = bal >= n.wei;
    ok &&= good;
    console.log(`  ${good ? 'OK    ' : 'NG    '} balance ${signer.padEnd(5)} ${n.from} ${fmtEth(bal)} >= ${fmtEth(n.wei)} (maxFee ${Number(price) / 1e9} gwei, gas x1.3 + 30k)`);
  }
  if (!ok) { console.log('  残高が足りない。送らない'); return false; }
  console.log(`\n[live] Sepolia (chainId ${chainId}) に ${steps.length} 本送る:`);
  for (const s of steps) console.log(`  ${s.id.padEnd(5)} ${s.signer.padEnd(5)} ${s.from} -> ${s.to}  ${s.what}`);
  if (!(await confirm('送るなら y を打つ: '))) { console.log('送らなかった'); return false; }
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    const pkRaw = process.env[SIGNER_ENV[s.signer]];
    if (!pkRaw) throw new Error(`--live に ${SIGNER_ENV[s.signer]} が要る`);
    const account = privateKeyToAccount((pkRaw.startsWith('0x') ? pkRaw : '0x' + pkRaw) as Hex);
    if (account.address.toLowerCase() !== s.from.toLowerCase()) throw new Error(`${s.id}: ${s.signer} の鍵のアドレス ${account.address} が from ${s.from} と違う。送らない`);
    const w = createWalletClient({ account, chain: sepolia, transport: viemHttp(url) });
    const hash = await w.sendTransaction({ to: s.to, data: s.data, gas: gasOf(k) } as any);
    console.log(`  sent   ${s.id.padEnd(5)} ${hash}`);
    const rc = await c.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error(`${s.id} が失敗した (tx ${hash})。ここで止める`);
    console.log(`  mined  ${s.id.padEnd(5)} block ${rc.blockNumber} gasUsed ${rc.gasUsed}`);
  }
  return true;
}

// ---------------------------------------------------------------- verify helper
type Verdict = { ok: boolean; reasons: string[]; steps: number; block: bigint };
async function verifyName(ens: any, clients: any, name: string, attesters: any[], maxAgeSeconds: number): Promise<Verdict> {
  const r = await ens.checkEnsOffer({ name, resource: DEFAULT_RESOURCE, method: 'GET', profile: BASE_SEPOLIA, clients, policy: { trustedAttesters: attesters, maxAgeSeconds } });
  return { ok: r.ok, reasons: r.reason_codes, steps: r.trace.filter((s: any) => s.status === 'ok').length, block: r.block.number };
}
const showVerdict = (v: Verdict) => (v.ok ? `VALID ${v.steps}/7` : `REFUSE ${v.reasons.join(', ')}`);
const holds = (v: Verdict, expect: string) => (expect === 'VALID' ? v.ok : !v.ok && v.reasons.includes(expect));

type World = { ens: any; real: any; hosts: string[]; sim: string[]; B: bigint; base: PreCall[]; attesters: any[]; maxAge: number; label: string };

/** The dry-run world: the pinned real block, plus the simulated pre-state that --test-attester / --assume-align-bc ask for. */
async function dryWorld(o: Opts, names: string[]): Promise<World> {
  const ens = await loadEnsSdk();
  const r = sepoliaReaders();
  if (!r.sim.length) throw new Error('eth_simulateV1 を受ける Sepolia RPC が無い');
  const pin = await ens.pinBlock(r.clients, 120);
  const base: PreCall[] = [];
  if (o.alignBc) base.push(alignBcCall());
  let attesters: any[] = localAttesters();
  let label = `attester pinned from trusted-attesters.json (${attesters.map((a: any) => `${a.name}=${a.address}`).join(', ')})`;
  if (o.testAttester) {
    const resolverOf: Record<string, Address> = { 'seller-a.eth': P_A, 'seller-b.eth': P_BC, 'seller-c.eth': P_BC, 'seller-d.eth': P_D };
    const fx = [];
    for (const n of names) {
      const manager = await ens.findExactOwner(r.clients, pin.B, n);
      if (!manager) throw new Error(`${n} の持ち主が 0x0（block ${pin.B}）`);
      const real = (await ens.resolveText(r.clients, pin.B, n, 'x402-offer')).value;
      const projected = o.alignBc && (n === 'seller-b.eth' || n === 'seller-c.eth') ? OFFER_A : real;
      fx.push({ name: n, resolver: resolverOf[n], manager, offerRaw: projected });
    }
    const f = await testAttesterFixture(ens, fx, Number(pin.ts));
    base.push(...f.pre);
    attesters = [f.attester];
    label = `TEST ATTESTER (simulation only): atst.vet402.eth -> anvil#0 ${ANVIL0}, envelopes for ${names.join(', ')} signed by anvil#0 inside the simulation`;
  }
  return { ens, real: r.clients, hosts: r.hosts, sim: r.sim, B: pin.B, base, attesters, maxAge: localMaxAge(), label };
}

// ---------------------------------------------------------------- pay
async function cmdPay(o: Opts): Promise<number> {
  const name = o.args[0];
  if (!name || o.args.length !== 1) throw new Error('usage: run.ts pay <name> [--dry-run | --live] [--test-attester]');
  const envf = loadEnvFile();
  const payerAddr = process.env.TOKYO_W_PAY_ADDRESS ? getAddress(process.env.TOKYO_W_PAY_ADDRESS) : null;
  if (!payerAddr) throw new Error('TOKYO_W_PAY_ADDRESS が env に無い（支払う側のアドレス。screening と支払いに使う）');
  const persisted = cutState();
  const cutMode = o.cutOnce ? o.mode : persisted?.mode ?? null;
  const cut = cutMode ? await startCut(cutMode) : null;
  try {
    const apiUrl = cut?.url ?? process.env.VET402_API_URL ?? SDK_DEFAULT_API;
    const bs = baseSepoliaReaders();
    const from = await chainFromBlock(bs.reader);
    const r = sepoliaReaders();
    let ensClients: any = r.clients;
    let attesters: any[] = localAttesters();
    let worldLabel = `Sepolia ${r.hosts.join(' + ')} (two providers, one block)`;
    if (o.testAttester) {
      const w = await dryWorld(o, [name]);
      ensClients = simulatedEnsClients({ primary: w.real.primary }, w.sim[0], w.base).clients;
      attesters = w.attesters;
      worldLabel = `SIMULATED on ${hostOf(w.sim[0])} at block ${w.B} — ${w.label}`;
    }
    console.log(`pay ${name}  ${o.live ? '--live' : '--dry-run (nothing is signed or sent)'} | agent ${o.agent} | payer W_pay ${payerAddr}`);
    console.log(`  ENS  ${worldLabel}`);
    console.log(`  Base Sepolia ${bs.hosts.join(' + ')} | receipts counted from block ${from.block} (${from.source})`);
    console.log(`  vet402 API ${cut ? `CUT (${cut.mode}${o.cutOnce ? ', this run only' : ', since ' + persisted?.at}): ${cut.url}` : hostOf(apiUrl)} | env ${envf.loaded ? envf.file : '(file not found)'}`);

    const cache = loadScreenCache();
    const screen = (a: { payTo: string; payer: string }) => screenPayment(a, { cache });
    const baseArgs = {
      name, agentName: o.agent, expectedResolver: P_AG1, ensClients, localAttesters: attesters, payerAddress: payerAddr,
      screen, fetch: globalThis.fetch, apiUrl, apiKey: process.env.VET402_API_KEY || undefined,
      chainReader: bs.reader, chainReaderCrossCheck: bs.cross, chainFromBlock: from.block, print: (l: string) => console.log(l),
    };
    let dry: PayFlowOutcome;
    try {
      dry = await runPayFlow({ ...baseArgs, payer: dryPayer(payerAddr), live: false });
    } finally {
      await saveScreenCache(cache);
    }
    if (!o.live) return 0;

    // ---- live: the dry pass above must have reached ALLOW; then chainId, balance and a typed y ----
    console.log('\n[live] 関門');
    if (dry.verdict !== 'ALLOW') { console.log(`  NG     dry pass: ${dry.verdict} ${dry.reasons.join(', ')}。送らない`); return 2; }
    console.log('  OK     dry pass reached the payer (ALLOW)');
    const [cA, cB] = await Promise.all([bs.reader.getChainId(), bs.cross.getChainId()]);
    const g1 = cA === BASE_SEPOLIA_CHAIN_ID && cB === BASE_SEPOLIA_CHAIN_ID;
    console.log(`  ${g1 ? 'OK    ' : 'NG    '} chainId ${bs.hosts[0]}=${cA} ${bs.hosts[1]}=${cB} (need ${BASE_SEPOLIA_CHAIN_ID})`);
    const amount = BigInt(dry.result.challenge.amount);
    const [bA, bB] = await Promise.all([
      bs.reader.readContract({ address: BASE_SEPOLIA.asset, abi: ERC20_READ, functionName: 'balanceOf', args: [payerAddr] }),
      bs.cross.readContract({ address: BASE_SEPOLIA.asset, abi: ERC20_READ, functionName: 'balanceOf', args: [payerAddr] }),
    ]) as [bigint, bigint];
    const bal = bA < bB ? bA : bB;
    const g2 = bal >= amount;
    console.log(`  ${g2 ? 'OK    ' : 'NG    '} USDC of W_pay ${Number(bal) / 1e6} >= ${Number(amount) / 1e6}`);
    if (!g1 || !g2) { console.log('  関門が外れた。送らない'); return 2; }
    console.log(`\n[live] Base Sepolia で ${Number(amount) / 1e6} USDC を ${dry.result.challenge.payTo} へ（${name}・W_pay ${payerAddr}）`);
    if (!(await confirm('払うなら y を打つ: '))) { console.log('払わなかった'); return 1; }
    const pk = process.env.TOKYO_W_PAY_PRIVATE_KEY;
    if (!pk) throw new Error('TOKYO_W_PAY_PRIVATE_KEY が env に要る');
    const account = privateKeyToAccount((pk.startsWith('0x') ? pk : '0x' + pk) as Hex);
    if (account.address !== payerAddr) throw new Error('TOKYO_W_PAY_PRIVATE_KEY のアドレスが TOKYO_W_PAY_ADDRESS と違う。払わない');
    console.log('');
    const liveOut = await runPayFlow({ ...baseArgs, payer: account as any, live: true });
    await saveScreenCache(cache);
    return liveOut.verdict === 'PAID' ? 0 : 2;
  } finally {
    if (cut) await cut.close();
  }
}

// ---------------------------------------------------------------- mutate / reset (D-1 / D-1r, W_op)
async function waitForText(ens: any, clients: any, name: string, want: string): Promise<void> {
  for (let k = 0; k < 20; k++) {
    try {
      const pin = await ens.pinBlock(clients, 300);
      if ((await ens.resolveText(clients, pin.B, name, 'x402-offer')).value === want) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`${name} の x402-offer が 60 秒たっても両方の RPC で新しい値にならない`);
}

async function cmdMutateReset(o: Opts): Promise<number> {
  loadEnvFile();
  const wOp = getAddress(process.env.TOKYO_W_OP_ADDRESS ?? W_OP_DEFAULT);
  const isMutate = o.cmd === 'mutate';
  const tx = demoTx(isMutate ? 'D-1' : 'D-1r', wOp);
  if (o.live) {
    console.log(`${o.cmd} --live: ${tx.id} ${tx.what}`);
    // Do not pay gas for a write that changes nothing (reset when the offer is already the K1-04 bytes, or mutate twice).
    {
      const ens0 = await loadEnsSdk();
      const r0 = sepoliaReaders();
      const pin = await ens0.pinBlock(r0.clients, 120);
      const now = (await ens0.resolveText(r0.clients, pin.B, 'seller-a.eth', 'x402-offer')).value;
      if (now === (isMutate ? OFFER_A_1CHAR : OFFER_A)) { console.log(`  seller-a.eth x402-offer is already ${isMutate ? 'mutated (10001)' : 'the K1-04 bytes (10000)'}: nothing to send`); return 0; }
    }
    const sent = await sendGated([{ ...tx, signer: 'W_op' }]);
    if (!sent) return 2;
    const ens = await loadEnsSdk();
    const r = sepoliaReaders();
    await waitForText(ens, r.clients, 'seller-a.eth', isMutate ? OFFER_A_1CHAR : OFFER_A);
    const v = await verifyName(ens, r.clients, 'seller-a.eth', localAttesters(), localMaxAge());
    const expect = isMutate ? 'ens_attestation_signer_mismatch' : 'VALID';
    console.log(`  verify seller-a.eth at block ${v.block}: ${showVerdict(v)}  expect ${expect}  ${holds(v, expect) ? 'ok' : 'DIFFERENT'}`);
    return 0;
  }
  const w = await dryWorld(o, ['seller-a.eth']);
  console.log(`${o.cmd} --dry-run | eth_simulateV1 on ${hostOf(w.sim[0])} at block ${w.B} | nothing is signed or sent`);
  console.log(`  ${w.label}`);
  for (const p of w.base) console.log(`  pre    ${p.id.padEnd(16)} ${p.what}`);
  const current = (await w.ens.resolveText(w.real, w.B, 'seller-a.eth', 'x402-offer')).value;
  console.log(`  seller-a.eth x402-offer now: ${current === OFFER_A ? 'the K1-04 bytes (amount 10000)' : current === OFFER_A_1CHAR ? 'MUTATED (amount 10001)' : 'something else: ' + current.slice(0, 80)}`);
  // (1) the --live gate: this transaction alone on the current chain
  const alone = await simulateSequence([tx], w.B, w.sim);
  console.log(`  [gate] ${alone[0].status.padEnd(6)} ${tx.id} W_op ${wOp} gas=${alone[0].gas} ${tx.what}  ${alone[0].status === 'OK' ? '[' + alone[0].logs.join(',') + ']' : alone[0].error}`);
  // (2) the expectation on the simulated chain
  const seq: PreCall[] = isMutate ? [tx] : [demoTx('D-1', wOp), tx];
  const states: Array<{ label: string; pre: PreCall[]; expect: string }> = [
    { label: 'before', pre: w.base, expect: 'VALID' },
    ...(isMutate ? [] : [{ label: 'after D-1', pre: [...w.base, seq[0]], expect: 'ens_attestation_signer_mismatch' }]),
    { label: `after ${tx.id}`, pre: [...w.base, ...seq], expect: isMutate ? 'ens_attestation_signer_mismatch' : 'VALID' },
  ];
  let allOk = alone[0].status === 'OK';
  for (const s of states) {
    const sc = simulatedEnsClients({ primary: w.real.primary }, w.sim[0], s.pre).clients;
    const v = await verifyName(w.ens, sc, 'seller-a.eth', w.attesters, w.maxAge);
    const h = holds(v, s.expect);
    allOk &&= h;
    console.log(`  ${s.label.padEnd(12)} verify seller-a.eth: ${showVerdict(v).padEnd(44)} expect ${s.expect.padEnd(32)} ${h ? 'ok' : 'DIFFERENT'}`);
  }
  if (!allOk && !o.testAttester) console.log('  hint: before B5b (09:30) there is no real envelope; add --test-attester to see the post-B5b expectations in simulation');
  console.log(`${allOk ? 'dry-run ok' : 'dry-run NG'}: ${o.cmd}（署名・送信はしていない）`);
  return allOk ? 0 : 2;
}

// ---------------------------------------------------------------- scene3 (D-2 -> D-3 -> D-4 -> D-5, W_ens)
export const SCENE3: Array<{ id: 'D-2' | 'D-3' | 'D-4' | 'D-5'; admin: string[]; verify: string; expect: string; word: string }> = [
  { id: 'D-2', admin: ['unlink', 'seller-b.eth'], verify: 'seller-b.eth', expect: 'ens_offer_missing', word: 'unlink(b) → refuse(ens_offer_missing)' },
  { id: 'D-3', admin: ['relink', 'seller-b.eth'], verify: 'seller-b.eth', expect: 'VALID', word: 'relink(b) → VALID' },
  { id: 'D-4', admin: ['link', 'seller-c.eth', '1'], verify: 'seller-c.eth', expect: 'ens_attestation_signer_mismatch', word: 'link(c→1) → refuse(signer_mismatch)' },
  { id: 'D-5', admin: ['relink', 'seller-c.eth'], verify: 'seller-c.eth', expect: 'VALID', word: 'relink(c→2) → VALID' },
];
const WANT_RECORD: Record<string, [string, bigint]> = { 'D-2': ['seller-b.eth', 0n], 'D-3': ['seller-b.eth', 1n], 'D-4': ['seller-c.eth', 1n], 'D-5': ['seller-c.eth', 2n] };

async function recordIds(ens: any, clients: any): Promise<{ B: bigint; b: bigint; c: bigint }> {
  const pin = await ens.pinBlock(clients, 300);
  const read = (n: string) => ens.readBoth(clients, (c: any) => c.readContract({ ...recordIdCall(P_BC, n), blockNumber: pin.B }), `getRecordId(${n})`) as Promise<bigint>;
  const [b, c] = await Promise.all([read('seller-b.eth'), read('seller-c.eth')]);
  return { B: pin.B, b, c };
}

function runAdmin(args: string[]): Promise<number> {
  return new Promise(resolve => {
    console.log(`\n$ npx tsx src/admin.ts ${args.join(' ')} --live`);
    const p = spawn('npx', ['tsx', 'src/admin.ts', ...args, '--live'], { cwd: DEMO_DIR, stdio: 'inherit', env: process.env });
    p.on('exit', code => resolve(code ?? 1));
    p.on('error', () => resolve(1));
  });
}

async function cmdScene3(o: Opts): Promise<number> {
  if (o.live) {
    loadEnvFile();
    const ens = await loadEnsSdk();
    const r = sepoliaReaders();
    const start = await recordIds(ens, r.clients);
    console.log(`scene3 --live | ${r.hosts.join(' + ')} | block ${start.B}: seller-b record ${start.b}, seller-c record ${start.c}`);
    if (start.b !== 1n || start.c !== 2n) { console.log('  始める前の状態が b=1・c=2 でない。先に admin.ts relink で戻してから打つ。何も送っていない'); return 2; }
    console.log('  順番は固定: D-2 unlink(b) → D-3 relink(b) → D-4 link(c→1) → D-5 relink(c→2)。各 tx は admin.ts が関門と y を持つ');
    const done: string[] = [];
    let aborted = false;
    const MANUAL = 'npx tsx src/admin.ts relink seller-b.eth --live ; npx tsx src/admin.ts relink seller-c.eth --live';
    console.log(`  途中で止めた（Ctrl-C を含む）ときの戻し方: ${MANUAL}`);
    try {
      for (const s of SCENE3) {
        const rc = await runAdmin(s.admin);
        if (rc !== 0) { console.log(`  ${s.id} は送られなかった（admin.ts exit ${rc}）。ここで本筋を止め、片付けに入る`); aborted = true; break; }
        const [n, id] = WANT_RECORD[s.id];
        for (let k = 0; k < 20; k++) { const now = await recordIds(ens, r.clients).catch(() => null); if (now && (n === 'seller-b.eth' ? now.b : now.c) === id) break; await new Promise(z => setTimeout(z, 3000)); }
        const v = await verifyName(ens, r.clients, s.verify, localAttesters(), localMaxAge());
        console.log(`  ${s.id} verify ${s.verify} at block ${v.block}: ${showVerdict(v)}  expect ${s.expect}  ${holds(v, s.expect) ? 'ok' : 'DIFFERENT'}`);
        done.push(s.word);
      }
    } catch (e: any) {
      console.log(`  本筋が例外で止まった: ${String(e?.message ?? e).slice(0, 200)}。片付けに入る`);
      aborted = true;
    }
    // Clean-up is decided from the chain, not from which step returned: b back to 1, then c back to 2 (D-5 last).
    let clean = false;
    try {
      const end = await recordIds(ens, r.clients);
      if (end.b !== 1n) { console.log('\n片付け: seller-b を記録 1 に戻す（D-3）'); await runAdmin(['relink', 'seller-b.eth']); }
      const end2 = await recordIds(ens, r.clients);
      if (end2.c !== 2n) { console.log('\n片付け: seller-c を記録 2 に戻す（D-5）'); await runAdmin(['relink', 'seller-c.eth']); }
      let fin = await recordIds(ens, r.clients);
      for (let k = 0; k < 20 && !(fin.b === 1n && fin.c === 2n); k++) { await new Promise(z => setTimeout(z, 3000)); fin = await recordIds(ens, r.clients); }
      clean = fin.b === 1n && fin.c === 2n;
      console.log(`\nD-5 clean-up: block ${fin.B}: seller-b record ${fin.b}, seller-c record ${fin.c} -> ${clean ? 'ok (c is back on its own record)' : 'NG: ' + MANUAL}`);
    } catch (e: any) {
      console.log(`\nD-5 clean-up: 状態を読めなかった (${String(e?.message ?? e).slice(0, 160)})。census で b=1・c=2 を確かめ、違えば: ${MANUAL}`);
    }
    if (clean && !aborted) console.log(`scene3 ok: ${done.join(' → ')}`);
    return clean && !aborted ? 0 : 2;
  }

  loadEnvFile();
  const names = ['seller-a.eth', 'seller-b.eth', 'seller-c.eth', 'seller-d.eth'];
  const w = await dryWorld(o, names);
  const wOp = getAddress(process.env.TOKYO_W_OP_ADDRESS ?? W_OP_DEFAULT);
  const txs = SCENE3.map(s => demoTx(s.id, wOp));
  console.log(`scene3 --dry-run | eth_simulateV1 on ${hostOf(w.sim[0])} at block ${w.B} | nothing is signed or sent`);
  console.log(`  ${w.label}`);
  for (const p of w.base) console.log(`  pre    ${p.id.padEnd(18)} ${p.what}`);
  const seq = await simulateSequence([...w.base, ...txs], w.B, w.sim);
  let allOk = seq.every(x => x.status === 'OK');
  const verifyAt = async (pre: PreCall[], name: string) =>
    verifyName(w.ens, simulatedEnsClients({ primary: w.real.primary }, w.sim[0], pre).clients, name, w.attesters, w.maxAge);
  const line = (label: string, v: Verdict, expect: string) => {
    const h = holds(v, expect);
    allOk &&= h;
    console.log(`  ${label.padEnd(34)} ${showVerdict(v).padEnd(46)} expect ${expect.padEnd(32)} ${h ? 'ok' : 'DIFFERENT'}`);
  };
  const [b0, c0] = await Promise.all([verifyAt(w.base, 'seller-b.eth'), verifyAt(w.base, 'seller-c.eth')]);
  line('before   verify seller-b.eth', b0, 'VALID');
  line('before   verify seller-c.eth', c0, 'VALID');
  const words: string[] = [];
  for (let k = 0; k < SCENE3.length; k++) {
    const s = SCENE3[k];
    const res = seq[w.base.length + k];
    const texts = res.logs.filter(l => l === 'TextUpdated').length;
    console.log(`  ${s.id}  W_ens ${txs[k].what}  gas=${res.gas} ${res.status}${res.status === 'OK' ? `  events [${res.logs.join(',')}] TextUpdated x${texts}` : '  ' + res.error}`);
    const v = await verifyAt([...w.base, ...txs.slice(0, k + 1)], s.verify);
    line(`${s.id}  verify ${s.verify}`, v, s.expect);
    words.push(s.word);
  }
  const after = [...w.base, ...txs];
  const finals = await Promise.all(names.map(n => verifyAt(after, n)));
  const allValid = finals.every(v => v.ok);
  console.log(`  after D-5: ${names.map((n, k) => `${n} ${showVerdict(finals[k])}`).join(' | ')}  -> ${finals.filter(v => v.ok).length}/4 VALID`);
  allOk &&= allValid;
  if (!allOk && !o.testAttester) console.log('  hint: before B5b (09:30) the names carry no real envelope, and before 07:00 b/c have no agent-endpoint[x402]. See the post-B5b expectations with --test-attester --assume-align-bc');
  console.log(`D-5 clean-up: always the last transaction of scene3 (seller-c back on record 2)`);
  console.log(`${allOk ? `scene3 dry-run ok: ${words.join(' → ')}` : `scene3 dry-run NG (expected: ${words.join(' → ')})`}（署名・送信はしていない）`);
  return allOk ? 0 : 2;
}

// ---------------------------------------------------------------- entry
export async function runScene(cmd: string, argv: string[]): Promise<number> {
  const o = parseArgs(cmd, argv);
  if (cmd === 'cut-vet402') { loadEnvFile(); return cmdCut(o); }
  if (cmd === 'pay') return cmdPay(o);
  if (cmd === 'mutate' || cmd === 'reset') return cmdMutateReset(o);
  if (cmd === 'scene3') return cmdScene3(o);
  throw new Error(`unknown command ${cmd}`);
}

#!/usr/bin/env -S npx tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- ETHGlobal Tokyo 2026: viem ABI helpers and JSON from RPCs are loosely typed here; behaviour is pinned by tests. */
// attester.ts: atst.vet402.eth buys from a seller's name, checks what arrived, and only then signs the
// ENSIP-29 draft attestation for the seller's x402-offer (PLAN_v4.3 section 3.9, "attester steps").
//
//   npx tsx src/attester.ts --names seller-a,seller-b,seller-c,seller-d [--dry-run | --live-pay] [--no-screen] [--allow-unknown]
//
// Six steps per name. If any one fails, that name is not signed (draft lines 50-54):
//   1 owner challenge   the name's owner signs a challenge (EIP-191); verifyMessage gives a
//   2 manager           findExactOwner(dns(n)) == a
//   3 buy               agent-endpoint[x402] == offer.resource and the live 402 asks exactly what the offer
//                       promises (compareOfferToAccept is empty and the amount is equal), Intercepta screens
//                       payTo and payer, then payOrRefuse buys on Base Sepolia
//                       (payee = address, requireVet402Allow:false + evidence.minChainReceipts:1, two readers)
//   4 delivery          the paid response body carries every key of offer.output.required at the top level
//   5 unchanged         (n, a, v) read again at a later Sepolia block are the same
//   6 sign             t = now; K_atst signs keccak256(payload) (EIP-191); the envelope goes to out/envelopes.json
//
// --dry-run (default): signs nothing and moves no funds. Step 1 derives the owner's address without
//   signing; step 3 runs payOrRefuse with a payer whose signTypedData throws, so every SDK gate runs up
//   to the signature and stops there; steps 4 and 6 are not run.
//
// Screening (gate 3) runs by default, in dry-run too: Intercepta screens each payTo that reached gate 3 and the
// payer, and its verdict alone decides whether the name goes on to payOrRefuse. block and unavailable refuse
// (payee_screening_blocked / payee_screening_unavailable). unknown (no risk record and no activity on Base
// mainnet) refuses with payee_unknown_needs_human unless --allow-unknown is given (a person decided).
// Answers are cached for 10 minutes in out/screening-cache.json, shared with run.ts pay (1,000-call quota).
// --no-screen (dry-run only) skips Intercepta: the "before" run, to compare with the default "after" run.
// --screen is accepted and changes nothing (screening is the default).
// --live-pay: sends only when all four gates hold: (1) both Base Sepolia readers say chainId 84532,
//   (2) W_pay's USDC balance covers the total, (3) screening passes for every payTo and the payer,
//   (4) a human types y. Before the y, payOrRefuse also runs once per name with the throwing payer, and
//   every name must pass it (a name that fails stops the whole run; nothing is bought for anyone).
//
// VET402_API_KEY (optional env): passed to payOrRefuse as apiKey. The seller URL is not in vet402's
// catalog, so payOrRefuse asks /payees/{payTo}/score, which answers 401 without a key (measured 2026-09-25).
//
// payee_screening_blocked / payee_screening_unavailable / payee_unknown_needs_human are words of this demo only (not the SDK's).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient, getAddress, http, keccak256, parseAbi, recoverMessageAddress, verifyMessage,
  type Hex, type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia } from 'viem/chains';
import { DEMO_DIR, b5cAutoConfirm, loadEnvFile } from './lib/env.ts';
import { hostOf } from './lib/rpc.ts';
import { loadEnsSdk, loadPaySdk } from './lib/sdk.ts';
import { loadScreeningCacheFile, saveScreeningCacheFile, screenPayment, type PaymentScreening } from './screening.ts';

export const RECORD_KEY = 'x402-offer';
export const ATTESTER_NAME = 'atst.vet402.eth';
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
/** BS-02 = SEED_TX (K1_LOG 2026-09-25): the first USDC receipt of W_ens on Base Sepolia. */
export const SEED_TX_BLOCK_FALLBACK = 47_286_905n;
const DRY_RUN_STOP = 'dry_run_stop: payOrRefuse reached the payer signature; dry-run signs nothing';
const ERC20_READ = parseAbi(['function balanceOf(address) view returns (uint256)']);

// ---------------------------------------------------------------- pure part (T37)
type Offer = {
  v: 1; resource: string; method: 'GET' | 'POST'; network: string; asset: string; amount: string; payTo: string;
  output?: { required: string[] };
};

/** Same shape rules as the SDK's offer parser. null when the value is not an x402 offer. */
export function parseOffer(raw: unknown): Offer | null {
  if (typeof raw !== 'string') return null;
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  const addr = /^0x[0-9a-fA-F]{40}$/;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.v !== 1 || typeof o.resource !== 'string' || (o.method !== 'GET' && o.method !== 'POST')) return null;
  if (typeof o.network !== 'string' || typeof o.asset !== 'string' || !addr.test(o.asset)) return null;
  if (typeof o.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(o.amount)) return null;
  if (typeof o.payTo !== 'string' || !addr.test(o.payTo)) return null;
  if (o.output !== undefined && (!o.output || !Array.isArray(o.output.required) || !o.output.required.every((k: unknown) => typeof k === 'string'))) return null;
  return o as Offer;
}

/**
 * compareOfferToAccept, plus: the 402 must ask for exactly the promised amount. The SDK's gate lets a
 * cheaper 402 through (a buyer may pay less), but an attester vouches that the promise is what the seller
 * charges, so any difference in price stops the attestation.
 */
export function strictOfferDiffs(ens: any, offer: Offer, accept: Record<string, unknown>): string[] {
  const diffs: string[] = [...ens.compareOfferToAccept(offer, accept)];
  // Every amount field the 402 carries must equal the offer (the SDK reads maxAmountRequired first, v2 uses amount).
  const raws = [accept?.amount, accept?.maxAmountRequired].filter(v => v !== undefined);
  if (!diffs.includes('price_above_declared') && (raws.length === 0 || raws.some(r => String(r) !== offer.amount))) diffs.push(`price_differs_from_offer (402 ${raws.map(String).join('/') || 'none'} != offer ${offer.amount})`);
  return diffs;
}

export type AttestSigner = { address: string; signMessage(args: { message: { raw: Hex } }): Promise<Hex> };
export type AttestInput = {
  name: string;
  manager: string;
  offerRaw: string;
  /** The accepts[] entry that was actually paid. */
  accept: Record<string, unknown>;
  /** The paid response body (parsed JSON). */
  purchaseBody: unknown;
  /** x402-offer read again at a later block, after the purchase. */
  offerRawAfterPurchase: string;
  /** Manager read again at that later block. Optional; when given it must equal manager. */
  managerAfterPurchase?: string;
  /** Unix seconds of signing. */
  t: number;
  signer: AttestSigner;
};
export type AttestResult = {
  envelope: string | null;
  reason: string | null;
  step?: 3 | 4 | 5 | 6;
  payloadHex?: Hex;
  digest?: Hex;
  signature?: Hex;
};

/**
 * Steps 3 (offer vs paid 402), 4 (delivery), 5 (unchanged) and 6 (sign). The signer is touched only
 * after every check has passed, so a refusal never reaches K_atst.
 */
export async function attestIfVerified(i: AttestInput): Promise<AttestResult> {
  const ens = await loadEnsSdk();
  const offer = parseOffer(i.offerRaw);
  if (!offer) return { envelope: null, reason: `offer_malformed: ${RECORD_KEY} of ${i.name} is not an x402 offer`, step: 3 };
  const diffs: string[] = strictOfferDiffs(ens, offer, i.accept);
  if (diffs.length) return { envelope: null, reason: `offer_mismatch: the paid 402 differs from the offer (${diffs.join(', ')})`, step: 3 };
  const required = offer.output?.required ?? [];
  if (!required.length) return { envelope: null, reason: 'delivery_unverifiable: the offer declares no output.required, so the body cannot be checked', step: 4 };
  const body = i.purchaseBody;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { envelope: null, reason: 'delivery_missing: the paid response body is not a JSON object', step: 4 };
  const missing = required.filter(k => !(k in (body as Record<string, unknown>)) || (body as Record<string, unknown>)[k] === undefined || (body as Record<string, unknown>)[k] === null);
  if (missing.length) return { envelope: null, reason: `delivery_missing: the paid body lacks ${missing.join(', ')}`, step: 4 };
  if (i.offerRawAfterPurchase !== i.offerRaw) return { envelope: null, reason: `offer_changed: ${RECORD_KEY} changed between the first read and the re-read after the purchase`, step: 5 };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(i.manager))) return { envelope: null, reason: 'manager_missing: no owner address for the name', step: 5 };
  if (i.managerAfterPurchase !== undefined && String(i.managerAfterPurchase).toLowerCase() !== String(i.manager).toLowerCase()) {
    return { envelope: null, reason: `manager_changed: owner moved from ${i.manager} to ${i.managerAfterPurchase} during the purchase`, step: 5 };
  }
  if (!Number.isInteger(i.t) || i.t <= 0) return { envelope: null, reason: `bad_t: ${String(i.t)}`, step: 6 };

  const payload: Uint8Array = ens.encodePayload({ n: ens.normalizeName(i.name), a: getAddress(i.manager), k: RECORD_KEY, v: i.offerRaw, t: i.t }, 'ensip29-draft');
  const payloadHex = ens.bytesToHex(payload) as Hex;
  const digest = keccak256(payload);
  const signature = await i.signer.signMessage({ message: { raw: digest } });
  const recovered = await recoverMessageAddress({ message: { raw: digest }, signature });
  if (recovered.toLowerCase() !== String(i.signer.address).toLowerCase()) {
    return { envelope: null, reason: `self_check_failed: the signature recovers to ${recovered}, not the signer ${i.signer.address}`, step: 6, payloadHex, digest };
  }
  const envelope: string = ens.encodeEnvelope({ version: 1, t: i.t, sig: signature }, 'base64');
  return { envelope, reason: null, step: 6, payloadHex, digest, signature };
}

// ---------------------------------------------------------------- CLI
type Mode = 'dry-run' | 'live-pay';
type Opts = { names: string[]; mode: Mode; screen: boolean; allowUnknown: boolean; outDir: string };

export function parseArgs(argv: string[]): Opts {
  const o: Opts = { names: [], mode: 'dry-run', screen: true, allowUnknown: false, outDir: path.join(DEMO_DIR, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--names') o.names = String(argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => (s.includes('.') ? s : `${s}.eth`).toLowerCase());
    else if (a.startsWith('--names=')) o.names = a.slice(8).split(',').map(s => s.trim()).filter(Boolean).map(s => (s.includes('.') ? s : `${s}.eth`).toLowerCase());
    else if (a === '--live-pay') o.mode = 'live-pay';
    else if (a === '--dry-run') o.mode = 'dry-run';
    else if (a === '--screen') o.screen = true;
    else if (a === '--no-screen') o.screen = false;
    else if (a === '--allow-unknown') o.allowUnknown = true;
    else if (a === '--out') o.outDir = path.resolve(String(argv[++i]));
    else throw new Error(`知らないオプション ${a}`);
  }
  if (argv.includes('--live-pay') && argv.includes('--dry-run')) throw new Error('--live-pay と --dry-run を同時に付けない');
  if (argv.includes('--screen') && argv.includes('--no-screen')) throw new Error('--screen と --no-screen を同時に付けない');
  if (o.mode === 'live-pay' && !o.screen) throw new Error('--no-screen は dry-run だけ（--live-pay は必ず Intercepta を通す）');
  if (!o.names.length) throw new Error('usage: npx tsx src/attester.ts --names seller-a,seller-b,seller-c,seller-d [--dry-run | --live-pay] [--no-screen] [--allow-unknown]');
  return o;
}

type StepTag = 'ok' | 'FAIL' | 'skip' | 'dry';
const line = (tag: StepTag, n: number | string, label: string, detail: string) =>
  console.log(`  [${tag.padEnd(4)}] ${String(n)} ${label.padEnd(16)} ${detail}`);

function sepoliaClients() {
  const primary = process.env.ENS_SEPOLIA_RPC_URL || 'https://sepolia.rpc.sentio.xyz';
  const secondary = process.env.ENS_SEPOLIA_RPC_URL_2 || process.env.ENS_SEPOLIA_RPC_URL_3 || 'https://rpc.sepolia.ethpandaops.io';
  if (hostOf(primary) === hostOf(secondary)) throw new Error(`Sepolia の読み口は別の提供元を2つ（両方 ${hostOf(primary)}）`);
  const mk = (u: string) => createPublicClient({ chain: sepolia, transport: http(u, { timeout: 20_000, retryCount: 1 }) });
  return { clients: { primary: mk(primary), secondary: mk(secondary) }, hosts: [hostOf(primary), hostOf(secondary)] };
}

function baseSepoliaReaders() {
  const primary = process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';
  const cross = process.env.BASE_SEPOLIA_RPC_URL_2 || 'https://sepolia.base.org';
  if (hostOf(primary) === hostOf(cross)) throw new Error(`Base Sepolia の読み口は別の提供元を2つ（両方 ${hostOf(primary)}）。BASE_SEPOLIA_RPC_URL_2 を足す`);
  const mk = (u: string) => createPublicClient({ chain: baseSepolia, transport: http(u, { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
  return { reader: mk(primary), cross: mk(cross), hosts: [hostOf(primary), hostOf(cross)], urls: [primary, cross] };
}

function trustedAttester(): { name: string; address: `0x${string}` } {
  const f = path.join(DEMO_DIR, 'trusted-attesters.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const a = (j.trustedAttesters ?? []).find((x: any) => x.name === ATTESTER_NAME && (x.recordKeys ?? []).includes(RECORD_KEY));
  if (!a) throw new Error(`${f} に ${ATTESTER_NAME}（${RECORD_KEY}）が無い`);
  return { name: a.name, address: getAddress(a.address) };
}

const pkOf = (envName: string): Hex | null => {
  const v = process.env[envName];
  if (!v) return null;
  return (v.startsWith('0x') ? v : '0x' + v) as Hex;
};

/** The name owner's key, looked up among the owner keys in the env file. Only the address is ever printed. */
function ownerAccountFor(): { account: ReturnType<typeof privateKeyToAccount>; envName: string } | null {
  const envName = process.env.TOKYO_SELLER_OWNER_KEY_ENV || 'W_ENS_PRIVATE_KEY';
  const pk = pkOf(envName);
  return pk ? { account: privateKeyToAccount(pk), envName } : null;
}

/** GET the resource without payment; decode the v2 PAYMENT-REQUIRED header. */
async function fetchChallenge(resource: string, method: string): Promise<{ status: number; accepts: any[] | null; why?: string }> {
  let res: Response;
  try {
    res = await fetch(resource, { method, headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch (e: any) {
    return { status: 0, accepts: null, why: `request failed (${e?.name ?? 'error'})` };
  }
  if (res.status !== 402) return { status: res.status, accepts: null, why: `HTTP ${res.status}, not 402` };
  const raw = res.headers.get('payment-required');
  if (!raw) return { status: 402, accepts: null, why: '402 without a PAYMENT-REQUIRED header (not x402 v2)' };
  try {
    const j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return { status: 402, accepts: Array.isArray(j.accepts) ? j.accepts : null, why: Array.isArray(j.accepts) ? undefined : 'PAYMENT-REQUIRED has no accepts[]' };
  } catch {
    return { status: 402, accepts: null, why: 'PAYMENT-REQUIRED is not base64 JSON' };
  }
}

/** fetch for payOrRefuse that keeps a copy of the paid response (the one that carried PAYMENT-SIGNATURE). */
function capturingFetch(): { fetch: typeof fetch; paid: () => { status: number; body: string } | null } {
  let paid: { status: number; body: string } | null = null;
  const f = (async (input: any, init?: any) => {
    const res = await fetch(input, { ...(init ?? {}), signal: AbortSignal.timeout(60_000) });
    const h = init?.headers ?? {};
    const carriesPayment = Object.keys(h).some(k => k.toLowerCase() === 'payment-signature');
    if (carriesPayment) paid = { status: res.status, body: await res.clone().text() };
    return res;
  }) as typeof fetch;
  return { fetch: f, paid: () => paid };
}

async function waitForLaterBlock(ens: any, clients: any, after: bigint): Promise<any> {
  for (let i = 0; i < 12; i++) {
    const pin = await ens.pinBlock(clients, 120);
    if (pin.B > after) return pin;
    await new Promise(r => setTimeout(r, 5_000));
  }
  throw new Error(`Sepolia が block ${after} から進まない（60 秒）`);
}

async function confirm(q: string): Promise<boolean> {
  if (b5cAutoConfirm(q.trim())) return true;
  if (!process.stdin.isTTY) { console.log('標準入力が端末でないので送らない（人が y を打つ場でだけ送る）'); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a === 'y';
}

type Work = {
  name: string;
  manager?: `0x${string}`;
  B1?: bigint;
  offerRaw?: string;
  offer?: Offer;
  accept?: Record<string, unknown>;
  screening?: PaymentScreening;
  stop?: { step: number; why: string };
};

async function chainFromBlock(reader: PublicClient): Promise<{ block: bigint; source: string }> {
  if (process.env.TOKYO_CHAIN_FROM_BLOCK) return { block: BigInt(process.env.TOKYO_CHAIN_FROM_BLOCK), source: 'env TOKYO_CHAIN_FROM_BLOCK' };
  const seed = process.env.SEED_TX;
  if (seed && /^0x[0-9a-fA-F]{64}$/.test(seed)) {
    try {
      const rc = await reader.getTransactionReceipt({ hash: seed as Hex });
      if (rc.status === 'success') return { block: rc.blockNumber, source: `SEED_TX receipt (${seed.slice(0, 10)}…)` };
    } catch { /* fall back below */ }
  }
  return { block: SEED_TX_BLOCK_FALLBACK, source: 'K1_LOG BS-02 (SEED_TX block, fallback)' };
}

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  const envf = loadEnvFile();
  const live = o.mode === 'live-pay';
  const ens = await loadEnsSdk();
  const pay = await loadPaySdk();
  const { clients, hosts } = sepoliaClients();
  const bs = baseSepoliaReaders();
  const att = trustedAttester();
  const payerAddr = process.env.TOKYO_W_PAY_ADDRESS ? getAddress(process.env.TOKYO_W_PAY_ADDRESS) : null;
  const screenLabel = o.screen ? `screening on${o.allowUnknown ? ' (--allow-unknown)' : ''}` : 'screening OFF (--no-screen: the "before" run)';
  console.log(`attester.ts ${live ? '--live-pay' : '--dry-run'} | names ${o.names.join(', ')} | ${screenLabel} | env ${envf.loaded ? envf.file : '(file not found)'}`);
  console.log(`  Sepolia ${hosts.join(' + ')} | Base Sepolia ${bs.hosts.join(' + ')} | attester ${att.name}=${att.address} | payer W_pay ${payerAddr ?? '(TOKYO_W_PAY_ADDRESS なし)'}`);

  // ---- preflight that does not depend on a name ----
  const pin0 = await ens.pinBlock(clients, 120);
  const atstOnChain = (await ens.resolveAddr(clients, pin0.B, att.name)).value;
  const kAtstEnv = process.env.TOKYO_K_ATST_ADDRESS ? getAddress(process.env.TOKYO_K_ATST_ADDRESS) : null;
  const atstOk = !!atstOnChain && atstOnChain === att.address && (!kAtstEnv || kAtstEnv === att.address);
  console.log(`  ${atstOk ? 'ok  ' : 'NG  '} ${att.name} -> ${atstOnChain ?? '(none)'} at Sepolia block ${pin0.B}; pinned ${att.address}; env TOKYO_K_ATST_ADDRESS ${kAtstEnv ?? '(none)'}`);
  const owner = ownerAccountFor();

  // ---- steps 1-3a per name (reads only) ----
  const works: Work[] = [];
  for (const raw of o.names) {
    const w: Work = { name: ens.normalizeName(raw) };
    works.push(w);
    console.log(`\n${w.name}`);
    // 1 owner challenge
    const challenge = `vet402 attester challenge\nname: ${w.name}\nattester: ${att.name}\nnonce: 0x${randomBytes(16).toString('hex')}\nissued: ${new Date().toISOString()}`;
    let claimant: `0x${string}` | null = null;
    if (!owner) {
      w.stop = { step: 1, why: `the owner key is not in the env (${process.env.TOKYO_SELLER_OWNER_KEY_ENV || 'W_ENS_PRIVATE_KEY'}); the owner must sign the challenge` };
      line('FAIL', 1, 'owner challenge', w.stop.why);
    } else if (!live) {
      claimant = owner.account.address;
      line('dry', 1, 'owner challenge', `${owner.envName} -> ${claimant}; challenge not signed (dry-run). --live-pay signs it and checks verifyMessage`);
    } else {
      const sig = await owner.account.signMessage({ message: challenge });
      const good = await verifyMessage({ address: owner.account.address, message: challenge, signature: sig });
      if (good) { claimant = owner.account.address; line('ok', 1, 'owner challenge', `verifyMessage ok: a = ${claimant} (EIP-191, ${challenge.split('\n')[3]})`); }
      else { w.stop = { step: 1, why: 'verifyMessage failed' }; line('FAIL', 1, 'owner challenge', w.stop.why); }
    }
    // 2 manager
    if (!w.stop) {
      const pin = await ens.pinBlock(clients, 120);
      w.B1 = pin.B;
      const m = await ens.findExactOwner(clients, pin.B, w.name);
      if (!m) { w.stop = { step: 2, why: `findExactOwner is 0x0 at block ${pin.B} (unregistered or a wildcard subname)` }; line('FAIL', 2, 'manager', w.stop.why); }
      else if (m !== claimant) { w.stop = { step: 2, why: `findExactOwner ${m} != a ${claimant}` }; line('FAIL', 2, 'manager', w.stop.why); }
      else { w.manager = m; line('ok', 2, 'manager', `findExactOwner(${w.name}) = ${m} at Sepolia block ${pin.B} (2 RPCs agree)`); }
    }
    // 3a offer and the live 402
    if (!w.stop) {
      const v = await ens.resolveText(clients, w.B1!, w.name, RECORD_KEY);
      const offer = parseOffer(v.value);
      const ep = await ens.resolveText(clients, w.B1!, w.name, 'agent-endpoint[x402]');
      if (!offer) { w.stop = { step: 3, why: `${RECORD_KEY} is ${v.value ? 'not an x402 offer' : 'empty'}` }; line('FAIL', 3, 'buy', w.stop.why); }
      else {
        w.offerRaw = v.value; w.offer = offer;
        if (ep.value !== offer.resource) {
          // Same rule as checkEnsOffer (endpoint == offer.resource). Stop before asking the seller anything.
          w.stop = { step: 3, why: `agent-endpoint[x402] is ${JSON.stringify(ep.value)}, not offer.resource ${offer.resource}` };
          line('FAIL', 3, 'buy', w.stop.why);
        } else {
          const ch = await fetchChallenge(offer.resource, offer.method);
          const accept = ch.accepts?.find((x: any) => x?.network === 'eip155:84532' || x?.network === 'base-sepolia') ?? null;
          if (!ch.accepts || !accept) {
            w.stop = { step: 3, why: `no 402 to compare: ${offer.method} ${offer.resource} -> ${ch.why ?? 'no eip155:84532 entry in accepts[]'}` };
            line('FAIL', 3, 'buy', w.stop.why);
          } else {
            const diffs = strictOfferDiffs(ens, offer, accept);
            if (diffs.length) { w.stop = { step: 3, why: `402 != offer: ${diffs.join(', ')} (402 amount ${accept.amount} payTo ${accept.payTo}; offer amount ${offer.amount} payTo ${offer.payTo})` }; line('FAIL', 3, 'buy', w.stop.why); }
            else { w.accept = accept; line(live ? 'ok' : 'dry', '3a', 'offer vs 402', `402 = offer (amount ${accept.amount}, payTo ${accept.payTo}, ${accept.network}, asset ${accept.asset}); agent-endpoint[x402] = offer.resource`); }
          }
        }
      }
    }
  }

  // ---- the four gates of --live-pay (printed in dry-run too) ----
  const buyable = works.filter(w => !w.stop);
  const total = buyable.reduce((t, w) => t + BigInt(String(w.accept!.amount)), 0n);
  console.log(`\ngates (${live ? 'live-pay' : 'dry-run: evaluated without any key; (3) asks Intercepta unless --no-screen'})`);
  const [cA, cB] = await Promise.all([bs.reader.getChainId(), bs.cross.getChainId()]);
  const g1 = cA === BASE_SEPOLIA_CHAIN_ID && cB === BASE_SEPOLIA_CHAIN_ID;
  console.log(`  ${g1 ? 'ok  ' : 'NG  '} (1) chainId ${bs.hosts[0]}=${cA} ${bs.hosts[1]}=${cB} (need ${BASE_SEPOLIA_CHAIN_ID})`);
  let g2 = false;
  if (payerAddr) {
    const [balA, balB] = await Promise.all([
      bs.reader.readContract({ address: USDC_BASE_SEPOLIA, abi: ERC20_READ, functionName: 'balanceOf', args: [payerAddr] }),
      bs.cross.readContract({ address: USDC_BASE_SEPOLIA, abi: ERC20_READ, functionName: 'balanceOf', args: [payerAddr] }),
    ]) as [bigint, bigint];
    const bal = balA < balB ? balA : balB;
    g2 = bal >= total && total > 0n;
    console.log(`  ${g2 ? 'ok  ' : 'NG  '} (2) USDC of W_pay ${payerAddr} = ${Number(bal) / 1e6} (${bs.hosts[0]} ${balA} / ${bs.hosts[1]} ${balB}) >= total ${Number(total) / 1e6} for ${buyable.length} name(s)`);
  } else console.log('  NG   (2) TOKYO_W_PAY_ADDRESS が env に無い');
  let g3: boolean | null = null;
  if (o.screen) {
    g3 = buyable.length > 0;
    const cacheFile = path.join(o.outDir, 'screening-cache.json');
    const cache = loadScreeningCacheFile(cacheFile);
    try {
      for (const w of buyable) {
        w.screening = await screenPayment({ payTo: w.offer!.payTo, payer: payerAddr ?? '' }, { cache });
        const v = w.screening.verdict;
        const okS = v === 'pass' || (v === 'unknown' && o.allowUnknown);
        g3 &&= okS;
        const why = v === 'unknown'
          ? (o.allowUnknown ? '  -> go on: unknown payee allowed by --allow-unknown' : `  -> REFUSE ${w.screening.refuse} (a person decides: --allow-unknown)`)
          : okS ? '' : '  -> REFUSE ' + w.screening.refuse;
        console.log(`  ${okS ? 'ok  ' : 'NG  '} (3) ${w.name}: ${w.screening.line}${why}`);
        if (!okS) w.stop = { step: 3, why: `REFUSE ${w.screening.refuse}` };
      }
    } finally {
      await saveScreeningCacheFile(cacheFile, cache);
    }
  } else console.log('  --   (3) Intercepta: not asked (--no-screen, dry-run only). Every name that reached gate 3 goes on to payOrRefuse');
  console.log(`  ${live ? '..  ' : '--  '} (4) typed y: ${live ? 'asked below' : 'asked only with --live-pay'}`);

  const from = await chainFromBlock(bs.reader);
  const head = await bs.reader.getBlockNumber();
  console.log(`  info minChainReceipts:1 counts USDC Transfer to payTo from Base Sepolia block ${from.block} (${from.source}) to ${head}: ${head - from.block + 1n} blocks = ${(head - from.block) / 1000n + 1n} getLogs of <=1,000 per reader (SDK limit ${pay.MAX_CHAIN_SCAN_BLOCKS})`);
  const apiKey = process.env.VET402_API_KEY || undefined;
  console.log(`  info vet402 API key: ${apiKey ? 'VET402_API_KEY is set (sent only to vet402.com as Bearer)' : 'none. An uncatalogued resource needs /payees/{payTo}/score, which answers 401 without a key -> evidence_unavailable'}`);

  // Every SDK gate of payOrRefuse, run with a payer whose signTypedData throws. Nothing can be signed here.
  const payInput = (w: Work, account: any, f: typeof fetch) => ({
    payee: w.offer!.payTo,
    network: 'base-sepolia',
    resource: w.offer!.resource,
    method: w.offer!.method,
    amountUsd: Number(w.offer!.amount) / 1e6,
    fetch: f,
    account,
    ...(apiKey ? { apiKey } : {}),
    source: 'tokyo-attester',
    policy: { maxPerTxUsd: 0.05, requireVet402Allow: false, evidence: { minChainReceipts: 1, chainFromBlock: from.block } },
    chainReader: bs.reader,
    chainReaderCrossCheck: bs.cross,
  });
  const dryPayer = { address: payerAddr ?? '0x0000000000000000000000000000000000000000', signTypedData: async () => { throw new Error(DRY_RUN_STOP); } };
  console.log(`\npayOrRefuse up to the payer signature (no signature possible: the payer here only throws)`);
  for (const w of works.filter(x => !x.stop)) {
    try {
      const r = await pay.payOrRefuse(payInput(w, dryPayer, fetch));
      const hint = !apiKey && r.decision.reason_codes.includes('resource_uncatalogued') ? '  (hint: set VET402_API_KEY; the payee score answers 401 without it)' : '';
      w.stop = { step: 3, why: `payOrRefuse ${r.status}: ${r.decision.reason_codes.join(', ')}${hint}` };
      line('FAIL', '3b', `${w.name}`, w.stop.why);
    } catch (e: any) {
      if (String(e?.message) === DRY_RUN_STOP) line(live ? 'ok' : 'dry', '3b', `${w.name}`, `all SDK gates passed up to the payer signature (requireVet402Allow:false, minChainReceipts:1 on ${bs.hosts.join(' + ')})`);
      else { w.stop = { step: 3, why: `payOrRefuse threw: ${String(e?.message ?? e).slice(0, 200)}` }; line('FAIL', '3b', `${w.name}`, w.stop.why); }
    }
  }

  const proceed = works.filter(w => !w.stop);
  if (!live) {
    for (const w of proceed) {
      console.log(`\n${w.name}`);
      line('skip', 4, 'delivery', 'dry-run: nothing bought, no body to check');
      const pin2 = await waitForLaterBlock(ens, clients, w.B1!);
      const m2 = await ens.findExactOwner(clients, pin2.B, w.name);
      const v2 = (await ens.resolveText(clients, pin2.B, w.name, RECORD_KEY)).value;
      const same = m2 === w.manager && v2 === w.offerRaw;
      line(same ? 'ok' : 'FAIL', 5, 'unchanged', `(n, a, v) at block ${pin2.B} vs ${w.B1}: ${same ? 'same' : 'CHANGED'}`);
      if (!same) w.stop = { step: 5, why: 'changed' };
      const t = Math.floor(Date.now() / 1000);
      const payload = ens.encodePayload({ n: w.name, a: w.manager!, k: RECORD_KEY, v: w.offerRaw!, t }, 'ensip29-draft');
      line('dry', 6, 'sign', `payload ${payload.length} bytes, digest ${keccak256(payload).slice(0, 18)}… would be signed by K_atst ${att.address} with t=${t}; not signed (dry-run)`);
    }
    const failed = works.filter(w => w.stop);
    console.log(`\ndry-run: ${works.length - failed.length}/${works.length} names pass every step that can run without signing${failed.length ? '; stopped: ' + failed.map(w => `${w.name} at step ${w.stop!.step}`).join(', ') : ''}. Nothing was signed or sent.`);
    return failed.length ? 2 : 0;
  }

  // ---- live: gates, one y, then steps 3b-6 ----
  const gatesOk = g1 && g2 && g3 === true && atstOk;
  if (!gatesOk || proceed.length !== works.length) {
    console.log(`\n--live-pay を止める: ${!gatesOk ? '関門が外れた（上の NG 行）' : '通らない名前がある（上の FAIL 行）。全部そろってから打つ'}。何も送っていない`);
    return 2;
  }
  const totalNow = proceed.reduce((t, w) => t + BigInt(String(w.accept!.amount)), 0n);
  console.log(`\n[live-pay] Base Sepolia で ${proceed.length} 件買う（W_pay ${payerAddr} -> payTo、USDC）:`);
  for (const w of proceed) console.log(`  ${w.name.padEnd(14)} ${w.offer!.method} ${w.offer!.resource}  ${Number(w.accept!.amount) / 1e6} USDC -> ${w.accept!.payTo}`);
  console.log(`  合計 ${Number(totalNow) / 1e6} USDC。そのあと K_atst (${att.address}) が各名前の証明に署名し ${path.join(o.outDir, 'envelopes.json')} に書く（ENS へは書かない）`);
  if (!(await confirm('買って署名するなら y を打つ: '))) { console.log('送らなかった'); return 1; }

  const payerPk = pkOf('TOKYO_W_PAY_PRIVATE_KEY');
  const atstPk = pkOf('TOKYO_K_ATST_PRIVATE_KEY');
  if (!payerPk || !atstPk) throw new Error('TOKYO_W_PAY_PRIVATE_KEY と TOKYO_K_ATST_PRIVATE_KEY が env に要る');
  const account = privateKeyToAccount(payerPk);
  if (account.address !== payerAddr) throw new Error('TOKYO_W_PAY_PRIVATE_KEY のアドレスが TOKYO_W_PAY_ADDRESS と違う。止める');
  const kAtst = privateKeyToAccount(atstPk);
  if (kAtst.address !== att.address) throw new Error(`K_atst ${kAtst.address} が ${att.name} の固定 ${att.address} と合わない。署名しない`);
  const envelopes: Record<string, string> = {};
  const log: any[] = [];
  for (const w of proceed) {
    console.log(`\n${w.name}`);
    const cap = capturingFetch();
    let result: any;
    try {
      result = await pay.payOrRefuse(payInput(w, account, cap.fetch));
    } catch (e: any) {
      line('FAIL', '3b', 'payOrRefuse', `threw: ${String(e?.message ?? e).slice(0, 200)} -> not signed`);
      continue;
    }
    if (result.status !== 'paid' || !result.txHash) {
      line('FAIL', '3b', 'payOrRefuse', `${result.status}: ${result.decision.reason_codes.join(', ')}${result.txHash ? ' tx ' + result.txHash : ''}${result.nonce ? ' nonce ' + result.nonce : ''} -> not signed`);
      log.push({ at: new Date().toISOString(), name: w.name, step: 3, status: result.status, reasons: result.decision.reason_codes, txHash: result.txHash, nonce: result.nonce });
      continue;
    }
    line('ok', '3b', 'payOrRefuse', `paid ${Number(result.challenge.amount) / 1e6} USDC -> ${result.challenge.payTo}  tx ${result.txHash} (verdict_source ${result.decision.verdict_source})`);
    const paid = cap.paid();
    let body: unknown = null;
    try { body = paid ? JSON.parse(paid.body) : null; } catch { body = null; }
    const keys = body && typeof body === 'object' ? Object.keys(body as object).join(',') : '(no JSON body)';
    const pin2 = await waitForLaterBlock(ens, clients, w.B1!);
    const m2 = await ens.findExactOwner(clients, pin2.B, w.name);
    const v2 = (await ens.resolveText(clients, pin2.B, w.name, RECORD_KEY)).value;
    const t = Math.floor(Date.now() / 1000);
    const r = await attestIfVerified({
      name: w.name, manager: w.manager!, offerRaw: w.offerRaw!, accept: result.challenge, purchaseBody: body,
      offerRawAfterPurchase: v2, managerAfterPurchase: m2 ?? '0x0000000000000000000000000000000000000000', t, signer: kAtst,
    });
    const failedAt = r.envelope ? 7 : (r.step ?? 6);
    line(failedAt === 4 ? 'FAIL' : 'ok', 4, 'delivery', failedAt === 4 ? `${r.reason} (HTTP ${paid?.status ?? '-'}, keys ${keys}) -> not signed` : `HTTP ${paid?.status} body keys ${keys} include output.required`);
    if (failedAt > 4) line(failedAt === 5 ? 'FAIL' : 'ok', 5, 'unchanged', failedAt === 5 ? `${r.reason} (block ${pin2.B} vs ${w.B1}) -> not signed` : `(n, a, v) at block ${pin2.B} = at block ${w.B1}`);
    if (failedAt === 3 || failedAt === 6) line('FAIL', failedAt, failedAt === 3 ? 'offer vs paid' : 'sign', `${r.reason} -> not signed`);
    if (r.envelope) {
      envelopes[w.name] = r.envelope;
      line('ok', 6, 'sign', `t=${t} (${new Date(t * 1000).toISOString()}) digest ${r.digest} envelope(base64) ${r.envelope}`);
    }
    log.push({
      at: new Date().toISOString(), name: w.name, manager: w.manager, recordKey: RECORD_KEY, offer: w.offerRaw, blocks: { first: String(w.B1), reread: String(pin2.B) },
      purchase: { network: 'eip155:84532', txHash: result.txHash, amount: result.challenge.amount, payTo: result.challenge.payTo, httpStatus: paid?.status ?? null, bodyKeys: keys },
      screening: w.screening?.line ?? null, t, digest: r.digest ?? null, payloadHex: r.payloadHex ?? null, envelope: r.envelope, reason: r.reason,
    });
  }

  fs.mkdirSync(o.outDir, { recursive: true });
  const envFile = path.join(o.outDir, 'envelopes.json');
  // Names not in this run keep their earlier envelope (publish-attestations re-checks every one against the
  // chain and its age). Names in this run that were not signed lose theirs, so nothing stale is re-published.
  let previous: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    try { previous = JSON.parse(fs.readFileSync(envFile, 'utf8')); } catch { previous = {}; }
    fs.renameSync(envFile, path.join(o.outDir, `envelopes.${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  }
  for (const w of works) delete previous[w.name];
  fs.writeFileSync(envFile, JSON.stringify({ ...previous, ...envelopes }, null, 2) + '\n');
  fs.appendFileSync(path.join(o.outDir, 'attester-log.jsonl'), log.map(x => JSON.stringify(x)).join('\n') + '\n');
  const signed = Object.keys(envelopes);
  console.log(`\nsigned ${signed.length}/${works.length}: ${signed.join(', ') || '(none)'}\n  envelopes -> ${envFile}\n  log       -> ${path.join(o.outDir, 'attester-log.jsonl')}`);
  console.log('next: npx tsx src/admin.ts publish-attestations --dry-run   (then --live)');
  return signed.length === works.length ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, e => { console.error(`attester.ts: ${String(e?.message ?? e)}`); process.exitCode = 1; });
}

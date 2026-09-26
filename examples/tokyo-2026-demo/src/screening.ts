// screening.ts: stage S of `tokyo pay` (PLAN_v4.3 section 3.10). Before anything is signed, both the
// payee (x402-offer.payTo read from ENS) and the payer are screened with Intercepta's quick-scan:
//
//   GET https://api.web3antivirus.io/api/public/v2/extension/account/{address}/quick-scan
//   header X-API-KEY, response {toxicScore, traits[{risk, name, txsCount, description}]}
//
// When quick-scan has nothing on the payee (toxicScore 0 and no traits), that is "no risk record", not
// "clean": a fresh address gets the same answer. The payee is then asked a second question:
//
//   GET https://api.web3antivirus.io/api/public/v1/extension/account/{address}/check-activity?chainId=8453
//   header X-API-KEY, response {hasActivity: boolean}
//
// chainId 8453 is Base mainnet. The endpoint has no Base Sepolia (84532), so this says whether the payee is
// known on Base mainnet at all. hasActivity false makes the verdict "unknown" (an unknown counterparty).
// The payer is our own wallet and gets quick-scan only.
//
// Rules:
// - A dangerous trait, or toxicScore >= threshold, is "block".
// - "unknown" is not a refusal by itself here. The caller decides: attester.ts refuses it unless
//   --allow-unknown; run.ts pay lets it through only with a VALID ENS attestation and at most 0.01 USDC.
// - Anything we cannot read is "unavailable" and the payment does not go ahead: 404 (the endpoint only
//   knows accounts; contract addresses answer 404), timeout (3 s), any other non-200, broken JSON,
//   a body that is not the documented shape, a missing key file. There is no declared floor to fall
//   back to here, so "cannot check" means "do not pay" (the opposite of vet402's own stage 2.5 floor).
//   A check-activity call that fails in any of these ways is also "unavailable".
// - Pass, block and unknown are cached per address for 10 minutes (1,000 requests per key): in the process,
//   and on disk between runs when the caller uses loadScreeningCacheFile / saveScreeningCacheFile
//   (run.ts pay and attester.ts keep out/screening-cache.json; no key is written there). An answer served
//   from the cache ends with "(cached, asked HH:MM:SS UTC)". Unavailable is not cached, so the next call asks again.
// - The key is read from ~/.vet402/intercepta-sandbox-key.txt (INTERCEPTA_KEY_FILE overrides the path).
//   Its value goes into the request header and nowhere else: not a log line, not an error, not a
//   return value. This module never logs and never throws for a screening failure.
//
// The refusal words payee_screening_blocked / payee_screening_unavailable belong to this demo only.
// They are not part of the SDK vocabulary or skills/pay-or-refuse/SKILL.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const QUICK_SCAN_BASE = 'https://api.web3antivirus.io/api/public/v2/extension/account';
export const CHECK_ACTIVITY_BASE = 'https://api.web3antivirus.io/api/public/v1/extension/account';
/** Base mainnet. check-activity's chainId enum has no Base Sepolia (84532). */
export const CHECK_ACTIVITY_CHAIN_ID = '8453';
export const SCREENING_TIMEOUT_MS = 3_000;
export const SCREENING_CACHE_TTL_MS = 10 * 60 * 1_000;
/** toxicScore at or above this blocks even without a listed trait. */
export const TOXIC_SCORE_BLOCK_AT = 70;

/**
 * Trait names (from the documented 15-name enum) that block on their own. The other five
 * (sanction_address_communication, mixer_transfers, non_kyc_transfers, zero_address_risk,
 * rug_pull_trader) describe contact with risk rather than the address itself; they block only
 * through toxicScore.
 */
export const BLOCKING_TRAITS: readonly string[] = [
  'sanction_address',
  'known_scammer',
  'blacklist',
  'initiator_scam_transactions',
  'fake_phishing_transfer',
  'fake_phishing_contract_communication',
  'attack_money_target',
  'rug_pull',
  'suspicious_deployer',
  'suspicious_dex_pair_deployer',
];

export type ScreeningVerdict = 'pass' | 'block' | 'unavailable' | 'unknown';

export interface ScreeningTrait {
  name: string;
  risk?: number;
  txsCount?: number;
  description?: string;
}

export interface ScreeningResult {
  verdict: ScreeningVerdict;
  address: string;
  toxicScore?: number;
  traits?: ScreeningTrait[];
  /** check-activity's answer on Base mainnet (only asked for 0 points with no traits). */
  hasActivity?: boolean;
  /** Set when this answer came from the cache: when the API was actually asked (ms since epoch). */
  cachedAt?: number;
  /** One line, safe to print. Never contains the API key. */
  reason: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

interface CacheEntry { at: number; promise: Promise<ScreeningResult> }
export type ScreeningCache = Map<string, CacheEntry>;

export interface ScreeningOptions {
  fetch?: FetchLike;
  /** Returns the key. Default reads keyFilePath(). Tests inject this. */
  readKey?: () => string | undefined;
  timeoutMs?: number;
  cacheTtlMs?: number;
  cache?: ScreeningCache;
  now?: () => number;
  blockAt?: number;
  /** Ask check-activity (Base mainnet) when quick-scan has no record. screenPayment sets it for the payTo. */
  checkActivity?: boolean;
}

const defaultCache: ScreeningCache = new Map();

/** Clear the process-wide cache (tests). */
export function clearScreeningCache(): void { defaultCache.clear(); }

export const keyFilePath = (): string =>
  process.env.INTERCEPTA_KEY_FILE || path.join(os.homedir(), '.vet402', 'intercepta-sandbox-key.txt');

function readKeyFile(): string | undefined {
  try {
    const v = fs.readFileSync(keyFilePath(), 'utf8').trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const unavailable = (address: string, reason: string): ScreeningResult => ({ verdict: 'unavailable', address, reason });

/** txsCount is documented as a number but the live answer on 2026-09-25 did not carry a numeric one. */
function numberish(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function parseBody(address: string, text: string, blockAt: number): ScreeningResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return unavailable(address, 'response is not JSON');
  }
  if (!body || typeof body !== 'object') return unavailable(address, 'response is not a JSON object');
  const { toxicScore, traits } = body as { toxicScore?: unknown; traits?: unknown };
  if (typeof toxicScore !== 'number' || !Number.isFinite(toxicScore)) return unavailable(address, 'response has no numeric toxicScore');
  if (!Array.isArray(traits)) return unavailable(address, 'response has no traits array');
  const list: ScreeningTrait[] = [];
  for (const t of traits) {
    if (!t || typeof t !== 'object' || typeof (t as { name?: unknown }).name !== 'string') {
      return unavailable(address, 'response has a trait without a name');
    }
    const r = t as { name: string; risk?: unknown; txsCount?: unknown; description?: unknown };
    list.push({
      name: r.name,
      ...(typeof r.risk === 'number' ? { risk: r.risk } : {}),
      ...(numberish(r.txsCount) !== undefined ? { txsCount: numberish(r.txsCount) } : {}),
      ...(typeof r.description === 'string' ? { description: r.description } : {}),
    });
  }
  const hits = list.filter((t) => BLOCKING_TRAITS.includes(t.name));
  const describe = (ts: ScreeningTrait[]): string =>
    ts.map((t) => `${t.name} (txsCount ${t.txsCount ?? 'n/a'})`).join(', ');
  if (hits.length > 0) {
    return { verdict: 'block', address, toxicScore, traits: list, reason: `toxicScore ${toxicScore}, ${describe(hits)}` };
  }
  if (toxicScore >= blockAt) {
    const why = list.length > 0 ? describe(list) : 'no traits listed';
    return { verdict: 'block', address, toxicScore, traits: list, reason: `toxicScore ${toxicScore} >= ${blockAt}, ${why}` };
  }
  // 0 with no traits is also what a fresh, never-seen address gets: "no risk record", never "clean".
  const note = list.length > 0 ? `, below threshold: ${describe(list)}` : toxicScore === 0 ? ' (no risk record)' : ` (below ${blockAt}, no traits listed)`;
  return { verdict: 'pass', address, toxicScore, traits: list, reason: `toxicScore ${toxicScore}${note}` };
}

type Got = { status: number; text: string } | { failed: string };

/** One GET with the key in the header and a hard timeout. Never throws; the failure text never echoes the request. */
async function getOnce(url: string, key: string, opts: ScreeningOptions): Promise<Got> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? SCREENING_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); resolve('timeout'); }, timeoutMs);
  });
  try {
    const call = (async () => {
      const res = await doFetch(url, { method: 'GET', headers: { 'X-API-KEY': key, accept: 'application/json' }, signal: ctrl.signal });
      return { status: res.status, text: await res.text() };
    })();
    call.catch(() => undefined); // a late rejection after the timeout must not surface as unhandled
    const got = await Promise.race([call, timeout]);
    if (got === 'timeout') return { failed: `no answer within ${timeoutMs} ms` };
    return got;
  } catch (err) {
    if (timedOut) return { failed: `no answer within ${timeoutMs} ms` };
    // Only the error class name: a message could echo request details.
    const name = err instanceof Error ? err.name : 'unknown';
    return { failed: `request failed (${name})` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** check-activity on Base mainnet, asked only after quick-scan came back with no record. */
async function activityOnce(q: ScreeningResult, key: string, opts: ScreeningOptions): Promise<ScreeningResult> {
  const where = `Base (chainId ${CHECK_ACTIVITY_CHAIN_ID})`;
  const got = await getOnce(`${CHECK_ACTIVITY_BASE}/${q.address}/check-activity?chainId=${CHECK_ACTIVITY_CHAIN_ID}`, key, opts);
  const fail = (why: string): ScreeningResult => unavailable(q.address, `check-activity: ${why}`);
  if ('failed' in got) return fail(got.failed);
  if (got.status !== 200) return fail(`HTTP ${got.status}`);
  let body: unknown;
  try { body = JSON.parse(got.text); } catch { return fail('response is not JSON'); }
  const has = body && typeof body === 'object' ? (body as { hasActivity?: unknown }).hasActivity : undefined;
  if (typeof has !== 'boolean') return fail('response has no boolean hasActivity');
  if (has) return { ...q, hasActivity: true, reason: `${q.reason}, active on ${where}` };
  return { ...q, verdict: 'unknown', hasActivity: false, reason: `${q.reason}, no activity on ${where}: unknown payee` };
}

async function scanOnce(address: string, opts: ScreeningOptions): Promise<ScreeningResult> {
  const key = (opts.readKey ?? readKeyFile)();
  if (!key) return unavailable(address, 'Intercepta API key file missing or empty (INTERCEPTA_KEY_FILE)');
  const got = await getOnce(`${QUICK_SCAN_BASE}/${address}/quick-scan`, key, opts);
  if ('failed' in got) return unavailable(address, got.failed);
  if (got.status === 404) return unavailable(address, 'HTTP 404 (quick-scan covers accounts only; a contract address answers 404)');
  if (got.status !== 200) return unavailable(address, `HTTP ${got.status}`);
  const q = parseBody(address, got.text, opts.blockAt ?? TOXIC_SCORE_BLOCK_AT);
  const noRecord = q.verdict === 'pass' && q.toxicScore === 0 && (q.traits?.length ?? 0) === 0;
  return opts.checkActivity && noRecord ? activityOnce(q, key, opts) : q;
}

const hhmmss = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

/** Screen one address. Never throws; never logs. */
export async function screenAddress(address: string, opts: ScreeningOptions = {}): Promise<ScreeningResult> {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return unavailable(String(address), 'not a 0x-prefixed 20-byte address');
  }
  const cache = opts.cache ?? defaultCache;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? SCREENING_CACHE_TTL_MS;
  // quick-scan-only and activity-checked answers differ for the same address, so they are kept apart.
  const k = address.toLowerCase() + (opts.checkActivity ? ACTIVITY_SUFFIX : '');
  const hit = cache.get(k);
  if (hit && now() - hit.at < ttl) {
    const r = await hit.promise;
    if (r.verdict === 'unavailable') return { ...r, address };
    return { ...r, address, cachedAt: hit.at, reason: `${r.reason} (cached, asked ${hhmmss(hit.at)} UTC)` };
  }
  const entry: CacheEntry = { at: now(), promise: scanOnce(address, opts) };
  cache.set(k, entry);
  const r = await entry.promise;
  if (r.verdict === 'unavailable' && cache.get(k) === entry) cache.delete(k);
  return r;
}

const ACTIVITY_SUFFIX = ':activity';
const CACHEABLE = new Set<ScreeningVerdict>(['pass', 'block', 'unknown']);

/**
 * Read the on-disk cache (pass / block / unknown younger than 10 minutes). A missing or broken file is an empty
 * cache. Entries served from it say "(cached, asked HH:MM:SS UTC)".
 */
export function loadScreeningCacheFile(file: string, now: () => number = Date.now, ttlMs = SCREENING_CACHE_TTL_MS): ScreeningCache {
  const m: ScreeningCache = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { at: number; result: ScreeningResult }>;
    for (const [k, v] of Object.entries(j)) {
      if (typeof v?.at === 'number' && now() - v.at < ttlMs && CACHEABLE.has(v.result?.verdict)) m.set(k, { at: v.at, promise: Promise.resolve(v.result) });
    }
  } catch { /* no file yet, or unreadable: ask again */ }
  return m;
}

/** Write pass / block / unknown younger than 10 minutes (mode 600). The key is never part of a result. */
export async function saveScreeningCacheFile(file: string, m: ScreeningCache, now: () => number = Date.now, ttlMs = SCREENING_CACHE_TTL_MS): Promise<void> {
  const o: Record<string, { at: number; result: ScreeningResult }> = {};
  for (const [k, v] of m) {
    const r = await v.promise;
    if (now() - v.at < ttlMs && CACHEABLE.has(r.verdict)) o[k] = { at: v.at, result: r };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(o, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export type ScreeningRefusal = 'payee_screening_blocked' | 'payee_screening_unavailable' | 'payee_unknown_needs_human';

export interface PaymentScreening {
  verdict: ScreeningVerdict;
  /** Set when verdict is not pass. Demo-only refusal word. For unknown the caller may still go ahead (see top). */
  refuse?: ScreeningRefusal;
  payTo: ScreeningResult;
  payer: ScreeningResult;
  /** One line for the screen, e.g. `screening: payTo 0x… UNKNOWN: toxicScore 0 (no risk record), no activity on … / payer 0x… toxicScore 0 (no risk record)`. */
  line: string;
}

/**
 * Screen payee and payer together. Block wins over unavailable, unavailable over unknown; block and
 * unavailable stop the payment. Only the payTo is asked check-activity (opts.checkActivity is ignored here).
 */
export async function screenPayment(
  args: { payTo: string; payer: string },
  opts: ScreeningOptions = {},
): Promise<PaymentScreening> {
  const [payTo, payer] = await Promise.all([
    screenAddress(args.payTo, { ...opts, checkActivity: true }),
    screenAddress(args.payer, { ...opts, checkActivity: false }),
  ]);
  const both = [payTo, payer];
  const verdict: ScreeningVerdict = both.some((r) => r.verdict === 'block')
    ? 'block'
    : both.some((r) => r.verdict === 'unavailable') ? 'unavailable'
      : both.some((r) => r.verdict === 'unknown') ? 'unknown' : 'pass';
  const part = (label: string, r: ScreeningResult): string =>
    r.verdict === 'pass' ? `${label} ${r.address} ${r.reason}` : `${label} ${r.address} ${r.verdict.toUpperCase()}: ${r.reason}`;
  const line = `screening: ${part('payTo', payTo)} / ${part('payer', payer)}`;
  if (verdict === 'pass') return { verdict, payTo, payer, line };
  const refuse: ScreeningRefusal = verdict === 'block' ? 'payee_screening_blocked'
    : verdict === 'unavailable' ? 'payee_screening_unavailable' : 'payee_unknown_needs_human';
  return { verdict, refuse, payTo, payer, line };
}

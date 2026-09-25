// screening.ts: stage S of `tokyo pay` (PLAN_v4.3 section 3.10). Before anything is signed, both the
// payee (x402-offer.payTo read from ENS) and the payer are screened with Intercepta's quick-scan:
//
//   GET https://api.web3antivirus.io/api/public/v2/extension/account/{address}/quick-scan
//   header X-API-KEY, response {toxicScore, traits[{risk, name, txsCount, description}]}
//
// Rules:
// - A dangerous trait, or toxicScore >= threshold, is "block".
// - Anything we cannot read is "unavailable" and the payment does not go ahead: 404 (the endpoint only
//   knows accounts; contract addresses answer 404), timeout (3 s), any other non-200, broken JSON,
//   a body that is not the documented shape, a missing key file. There is no declared floor to fall
//   back to here, so "cannot check" means "do not pay" (the opposite of vet402's own stage 2.5 floor).
// - Pass and block are cached per address for 10 minutes inside the process (1,000 requests per key).
//   Unavailable is not cached, so the next call asks again.
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

export type ScreeningVerdict = 'pass' | 'block' | 'unavailable';

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
      ...(typeof r.txsCount === 'number' ? { txsCount: r.txsCount } : {}),
      ...(typeof r.description === 'string' ? { description: r.description } : {}),
    });
  }
  const hits = list.filter((t) => BLOCKING_TRAITS.includes(t.name));
  const describe = (ts: ScreeningTrait[]): string =>
    ts.map((t) => `${t.name} (txsCount ${t.txsCount ?? '?'})`).join(', ');
  if (hits.length > 0) {
    return { verdict: 'block', address, toxicScore, traits: list, reason: `toxicScore ${toxicScore}, ${describe(hits)}` };
  }
  if (toxicScore >= blockAt) {
    const why = list.length > 0 ? describe(list) : 'no traits listed';
    return { verdict: 'block', address, toxicScore, traits: list, reason: `toxicScore ${toxicScore} >= ${blockAt}, ${why}` };
  }
  const note = list.length > 0 ? `, below threshold: ${describe(list)}` : ' (clean)';
  return { verdict: 'pass', address, toxicScore, traits: list, reason: `toxicScore ${toxicScore}${note}` };
}

async function scanOnce(address: string, opts: ScreeningOptions): Promise<ScreeningResult> {
  const key = (opts.readKey ?? readKeyFile)();
  if (!key) return unavailable(address, 'Intercepta API key file missing or empty (INTERCEPTA_KEY_FILE)');
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
      const res = await doFetch(`${QUICK_SCAN_BASE}/${address}/quick-scan`, {
        method: 'GET',
        headers: { 'X-API-KEY': key, accept: 'application/json' },
        signal: ctrl.signal,
      });
      return { status: res.status, text: await res.text() };
    })();
    call.catch(() => undefined); // a late rejection after the timeout must not surface as unhandled
    const got = await Promise.race([call, timeout]);
    if (got === 'timeout') return unavailable(address, `no answer within ${timeoutMs} ms`);
    if (got.status === 404) return unavailable(address, 'HTTP 404 (quick-scan covers accounts only; a contract address answers 404)');
    if (got.status !== 200) return unavailable(address, `HTTP ${got.status}`);
    return parseBody(address, got.text, opts.blockAt ?? TOXIC_SCORE_BLOCK_AT);
  } catch (err) {
    if (timedOut) return unavailable(address, `no answer within ${timeoutMs} ms`);
    // Only the error class name: a message could echo request details.
    const name = err instanceof Error ? err.name : 'unknown';
    return unavailable(address, `request failed (${name})`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Screen one address. Never throws; never logs. */
export async function screenAddress(address: string, opts: ScreeningOptions = {}): Promise<ScreeningResult> {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return unavailable(String(address), 'not a 0x-prefixed 20-byte address');
  }
  const cache = opts.cache ?? defaultCache;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? SCREENING_CACHE_TTL_MS;
  const k = address.toLowerCase();
  const hit = cache.get(k);
  if (hit && now() - hit.at < ttl) {
    const r = await hit.promise;
    return { ...r, address };
  }
  const entry: CacheEntry = { at: now(), promise: scanOnce(address, opts) };
  cache.set(k, entry);
  const r = await entry.promise;
  if (r.verdict === 'unavailable' && cache.get(k) === entry) cache.delete(k);
  return r;
}

export type ScreeningRefusal = 'payee_screening_blocked' | 'payee_screening_unavailable';

export interface PaymentScreening {
  verdict: ScreeningVerdict;
  /** Set when verdict is not pass. Demo-only refusal word. */
  refuse?: ScreeningRefusal;
  payTo: ScreeningResult;
  payer: ScreeningResult;
  /** One line for the screen, e.g. `screening: payTo 0x… toxicScore 0 (clean) / payer 0x… toxicScore 0 (clean)`. */
  line: string;
}

/** Screen payee and payer together. Block wins over unavailable; either one stops the payment. */
export async function screenPayment(
  args: { payTo: string; payer: string },
  opts: ScreeningOptions = {},
): Promise<PaymentScreening> {
  const [payTo, payer] = await Promise.all([screenAddress(args.payTo, opts), screenAddress(args.payer, opts)]);
  const both = [payTo, payer];
  const verdict: ScreeningVerdict = both.some((r) => r.verdict === 'block')
    ? 'block'
    : both.some((r) => r.verdict === 'unavailable') ? 'unavailable' : 'pass';
  const part = (label: string, r: ScreeningResult): string =>
    r.verdict === 'pass' ? `${label} ${r.address} ${r.reason}` : `${label} ${r.address} ${r.verdict.toUpperCase()}: ${r.reason}`;
  const line = `screening: ${part('payTo', payTo)} / ${part('payer', payer)}`;
  if (verdict === 'pass') return { verdict, payTo, payer, line };
  const refuse: ScreeningRefusal = verdict === 'block' ? 'payee_screening_blocked' : 'payee_screening_unavailable';
  return { verdict, refuse, payTo, payer, line };
}

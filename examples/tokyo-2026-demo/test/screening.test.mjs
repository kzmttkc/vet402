// node --test test/screening.test.mjs   (Node >= 22.18 strips the types of ../src/screening.ts)
// fetch is always injected: these tests never reach the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHECK_ACTIVITY_BASE,
  CHECK_ACTIVITY_CHAIN_ID,
  QUICK_SCAN_BASE,
  SCREENING_CACHE_TTL_MS,
  SCREENING_TIMEOUT_MS,
  loadScreeningCacheFile,
  saveScreeningCacheFile,
  screenAddress,
  screenPayment,
} from '../src/screening.ts';

const CLEAN = '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
const RONIN = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
const ROUTER = '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b';
const KEY = 'test-key-0123456789abcdef-SECRET';

// routes[addr] answers quick-scan; routes['activity:' + addr] answers check-activity.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const act = url.startsWith(CHECK_ACTIVITY_BASE + '/') && url.includes('/check-activity?');
    const addr = act
      ? url.slice(CHECK_ACTIVITY_BASE.length + 1, url.indexOf('/check-activity?')).toLowerCase()
      : url.slice(QUICK_SCAN_BASE.length + 1, -'/quick-scan'.length).toLowerCase();
    const r = routes[act ? 'activity:' + addr : addr];
    if (!r) throw new Error('unexpected address ' + addr);
    if (typeof r === 'function') return r(init);
    return { status: r.status, text: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

const opts = (fetch, extra = {}) => ({ fetch, readKey: () => KEY, cache: new Map(), ...extra });
const noKeyIn = (value) => assert.ok(!JSON.stringify(value).includes(KEY), 'key leaked into result');

test('defaults are 3 s and 10 min', () => {
  assert.equal(SCREENING_TIMEOUT_MS, 3000);
  assert.equal(SCREENING_CACHE_TTL_MS, 600000);
});

test('pass: toxicScore 0, no traits is "no risk record" (never "clean"); key only in the header', async () => {
  const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[]}' } });
  const r = await screenAddress(CLEAN, opts(f));
  assert.equal(r.verdict, 'pass');
  assert.equal(r.toxicScore, 0);
  assert.deepEqual(r.traits, []);
  assert.equal(r.reason, 'toxicScore 0 (no risk record)');
  assert.doesNotMatch(r.reason, /clean/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${QUICK_SCAN_BASE}/${CLEAN}/quick-scan`);
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.headers['X-API-KEY'], KEY);
  noKeyIn(r);
});

test('block: known_scammer, reason carries trait name and txsCount', async () => {
  const body = JSON.stringify({
    toxicScore: 100,
    traits: [{ risk: 100, name: 'known_scammer', txsCount: 12, description: 'Known scammer' }],
  });
  const f = fakeFetch({ [RONIN.toLowerCase()]: { status: 200, body } });
  const r = await screenAddress(RONIN, opts(f));
  assert.equal(r.verdict, 'block');
  assert.equal(r.toxicScore, 100);
  assert.equal(r.traits[0].name, 'known_scammer');
  assert.match(r.reason, /known_scammer \(txsCount 12\)/);
  noKeyIn(r);
});

test('block: toxicScore over threshold with a non-blocking trait', async () => {
  const body = JSON.stringify({ toxicScore: 85, traits: [{ risk: 40, name: 'mixer_transfers', txsCount: 3, description: '' }] });
  const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body } });
  const r = await screenAddress(CLEAN, opts(f));
  assert.equal(r.verdict, 'block');
  assert.match(r.reason, /toxicScore 85 >= 70, mixer_transfers \(txsCount 3\)/);
});

test('pass: low score with a non-blocking trait stays pass and names it', async () => {
  const body = JSON.stringify({ toxicScore: 10, traits: [{ risk: 10, name: 'non_kyc_transfers', txsCount: 1, description: '' }] });
  const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body } });
  const r = await screenAddress(CLEAN, opts(f));
  assert.equal(r.verdict, 'pass');
  assert.match(r.reason, /below threshold: non_kyc_transfers/);
});

test('block: txsCount missing or a numeric string (live answer had none)', async () => {
  const body = JSON.stringify({
    toxicScore: 100,
    traits: [{ risk: 100, name: 'known_scammer', description: '' }, { risk: 100, name: 'sanction_address', txsCount: '7', description: '' }],
  });
  const f = fakeFetch({ [RONIN.toLowerCase()]: { status: 200, body } });
  const r = await screenAddress(RONIN, opts(f));
  assert.equal(r.verdict, 'block');
  assert.equal(r.reason, 'toxicScore 100, known_scammer (txsCount n/a), sanction_address (txsCount 7)');
});

test('404 (contract address) is unavailable', async () => {
  const f = fakeFetch({ [ROUTER.toLowerCase()]: { status: 404, body: '' } });
  const r = await screenAddress(ROUTER, opts(f));
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /HTTP 404/);
  assert.equal(r.toxicScore, undefined);
});

test('403 / 500 are unavailable', async () => {
  for (const status of [403, 500]) {
    const f = fakeFetch({ [CLEAN.toLowerCase()]: { status, body: '{"status":' + status + '}' } });
    const r = await screenAddress(CLEAN, opts(f));
    assert.equal(r.verdict, 'unavailable');
    assert.equal(r.reason, `HTTP ${status}`);
  }
});

test('timeout is unavailable and aborts the request', async () => {
  let aborted = false;
  const hang = (init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  });
  const f = fakeFetch({ [CLEAN.toLowerCase()]: hang });
  const t0 = Date.now();
  const r = await screenAddress(CLEAN, opts(f, { timeoutMs: 50 }));
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /no answer within 50 ms/);
  assert.ok(aborted);
  assert.ok(Date.now() - t0 < 1000);
});

test('timeout also holds when fetch ignores the abort signal', async () => {
  const f = fakeFetch({ [CLEAN.toLowerCase()]: () => new Promise(() => {}) });
  const r = await screenAddress(CLEAN, opts(f, { timeoutMs: 30 }));
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /no answer within 30 ms/);
});

test('broken JSON and wrong shape are unavailable', async () => {
  const cases = [
    ['{"toxicScore":0,', /not JSON/],
    ['[]', /no numeric toxicScore/],
    ['{"toxicScore":"0","traits":[]}', /no numeric toxicScore/],
    ['{"toxicScore":0}', /no traits array/],
    ['{"toxicScore":0,"traits":[{"risk":1}]}', /trait without a name/],
  ];
  for (const [body, re] of cases) {
    const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body } });
    const r = await screenAddress(CLEAN, opts(f));
    assert.equal(r.verdict, 'unavailable', body);
    assert.match(r.reason, re, body);
  }
});

test('network error is unavailable and the error message is not echoed', async () => {
  const f = fakeFetch({ [CLEAN.toLowerCase()]: () => { throw new TypeError('fetch failed ' + KEY); } });
  const r = await screenAddress(CLEAN, opts(f));
  assert.equal(r.verdict, 'unavailable');
  assert.equal(r.reason, 'request failed (TypeError)');
  noKeyIn(r);
});

test('missing key is unavailable without calling the API', async () => {
  const f = fakeFetch({});
  const r = await screenAddress(CLEAN, { fetch: f, readKey: () => undefined, cache: new Map() });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /key file missing/);
  assert.equal(f.calls.length, 0);
});

test('INTERCEPTA_KEY_FILE pointing nowhere is unavailable', async () => {
  const prev = process.env.INTERCEPTA_KEY_FILE;
  process.env.INTERCEPTA_KEY_FILE = '/nonexistent/intercepta-key.txt';
  try {
    const f = fakeFetch({});
    const r = await screenAddress(CLEAN, { fetch: f, cache: new Map() });
    assert.equal(r.verdict, 'unavailable');
    assert.equal(f.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.INTERCEPTA_KEY_FILE; else process.env.INTERCEPTA_KEY_FILE = prev;
  }
});

test('not an address is unavailable without calling the API', async () => {
  const f = fakeFetch({});
  for (const a of ['vitalik.eth', '0x123', '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6/../x', '']) {
    const r = await screenAddress(a, opts(f));
    assert.equal(r.verdict, 'unavailable', a);
  }
  assert.equal(f.calls.length, 0);
});

test('cache: one request per address for 10 minutes (case-insensitive), then asks again', async () => {
  const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[]}' } });
  let t = 1_000_000;
  const o = opts(f, { now: () => t });
  await screenAddress(CLEAN, o);
  t += 9 * 60 * 1000;
  const again = await screenAddress(CLEAN.toLowerCase(), o);
  assert.equal(again.verdict, 'pass');
  assert.equal(again.address, CLEAN.toLowerCase());
  assert.equal(f.calls.length, 1);
  t += 61 * 1000;
  await screenAddress(CLEAN, o);
  assert.equal(f.calls.length, 2);
});

test('cache: unavailable is not cached', async () => {
  let n = 0;
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: () => (++n === 1
      ? { status: 503, text: async () => '' }
      : { status: 200, text: async () => '{"toxicScore":0,"traits":[]}' }),
  });
  const o = opts(f);
  assert.equal((await screenAddress(CLEAN, o)).verdict, 'unavailable');
  assert.equal((await screenAddress(CLEAN, o)).verdict, 'pass');
  assert.equal(f.calls.length, 2);
});

test('screenPayment: payee with Base activity and payer pass with one line; only the payTo is activity-checked', async () => {
  const PAYER = '0x1111111111111111111111111111111111111111';
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[]}' },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":true}' },
    [PAYER]: { status: 200, body: '{"toxicScore":0,"traits":[]}' },
  });
  const s = await screenPayment({ payTo: CLEAN, payer: PAYER }, opts(f));
  assert.equal(s.verdict, 'pass');
  assert.equal(s.refuse, undefined);
  assert.equal(s.line, `screening: payTo ${CLEAN} toxicScore 0 (no risk record), active on Base (chainId 8453) / payer ${PAYER} toxicScore 0 (no risk record)`);
  assert.equal(f.calls.filter((c) => c.url.includes('/check-activity')).length, 1);
});

test('screenPayment: block wins over unavailable; unavailable alone refuses', async () => {
  const blockBody = JSON.stringify({ toxicScore: 100, traits: [{ risk: 100, name: 'known_scammer', txsCount: 4, description: '' }] });
  const f = fakeFetch({
    [RONIN.toLowerCase()]: { status: 200, body: blockBody },
    [ROUTER.toLowerCase()]: { status: 404, body: '' },
    [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[]}' },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":true}' },
  });
  const o = opts(f);
  const b = await screenPayment({ payTo: RONIN, payer: ROUTER }, o);
  assert.equal(b.verdict, 'block');
  assert.equal(b.refuse, 'payee_screening_blocked');
  assert.match(b.line, /payTo 0x098B.* BLOCK: toxicScore 100, known_scammer \(txsCount 4\)/);
  const u = await screenPayment({ payTo: ROUTER, payer: CLEAN }, o);
  assert.equal(u.verdict, 'unavailable');
  assert.equal(u.refuse, 'payee_screening_unavailable');
  assert.match(u.line, /UNAVAILABLE: HTTP 404/);
  noKeyIn([b, u]);
});

test('threshold edge: 69 passes without calling it clean, 70 blocks', async () => {
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":69,"traits":[]}' },
    [ROUTER.toLowerCase()]: { status: 200, body: '{"toxicScore":70,"traits":[]}' },
  });
  const low = await screenAddress(CLEAN, opts(f));
  assert.equal(low.verdict, 'pass');
  assert.doesNotMatch(low.reason, /clean/);
  const high = await screenAddress(ROUTER, opts(f));
  assert.equal(high.verdict, 'block');
});

test('a blocking trait blocks even with a low score', async () => {
  const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":10,"traits":[{"name":"blacklist","risk":10}]}' } });
  const r = await screenAddress(CLEAN, opts(f));
  assert.equal(r.verdict, 'block');
  assert.match(r.reason, /blacklist/);
});

test('a block is cached under the lower-cased address', async () => {
  const f = fakeFetch({ [RONIN.toLowerCase()]: { status: 200, body: '{"toxicScore":100,"traits":[{"name":"known_scammer"}]}' } });
  const o = opts(f);
  assert.equal((await screenAddress(RONIN, o)).verdict, 'block');
  assert.equal((await screenAddress(RONIN.toLowerCase(), o)).verdict, 'block');
  assert.equal(f.calls.length, 1);
});

// ---------------------------------------------------------------- check-activity (unknown payee) and cache labels

const ZERO_BODY = '{"toxicScore":0,"traits":[]}';

test('check-activity: 0 points and no traits, hasActivity false -> unknown; exact URL (v1, chainId 8453), key only in the header', async () => {
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: ZERO_BODY },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":false}' },
  });
  const r = await screenAddress(CLEAN, opts(f, { checkActivity: true }));
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.hasActivity, false);
  assert.equal(r.reason, 'toxicScore 0 (no risk record), no activity on Base (chainId 8453): unknown payee');
  assert.equal(CHECK_ACTIVITY_CHAIN_ID, '8453');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, `${CHECK_ACTIVITY_BASE}/${CLEAN}/check-activity?chainId=8453`);
  assert.equal(CHECK_ACTIVITY_BASE, 'https://api.web3antivirus.io/api/public/v1/extension/account');
  assert.equal(f.calls[1].init.headers['X-API-KEY'], KEY);
  noKeyIn(r);
});

test('check-activity: hasActivity true -> pass, still "no risk record"', async () => {
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: ZERO_BODY },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":true}' },
  });
  const r = await screenAddress(CLEAN, opts(f, { checkActivity: true }));
  assert.equal(r.verdict, 'pass');
  assert.equal(r.reason, 'toxicScore 0 (no risk record), active on Base (chainId 8453)');
});

test('check-activity failures are unavailable (fail-closed) and are not cached', async () => {
  const cases = [
    [{ status: 500, body: '' }, /^check-activity: HTTP 500$/],
    [{ status: 404, body: '' }, /^check-activity: HTTP 404$/],
    [{ status: 200, body: '{"hasActivity":' }, /^check-activity: response is not JSON$/],
    [{ status: 200, body: '{"hasActivity":"false"}' }, /^check-activity: response has no boolean hasActivity$/],
    [{ status: 200, body: '{}' }, /^check-activity: response has no boolean hasActivity$/],
    [() => { throw new TypeError('boom ' + KEY); }, /^check-activity: request failed \(TypeError\)$/],
    [() => new Promise(() => {}), /^check-activity: no answer within 30 ms$/],
  ];
  for (const [route, re] of cases) {
    const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body: ZERO_BODY }, ['activity:' + CLEAN.toLowerCase()]: route });
    const o = opts(f, { checkActivity: true, timeoutMs: 30 });
    const r = await screenAddress(CLEAN, o);
    assert.equal(r.verdict, 'unavailable', String(re));
    assert.match(r.reason, re);
    noKeyIn(r);
    assert.equal(o.cache.size, 0, 'unavailable is not cached');
  }
});

test('check-activity is asked only for 0 points with no traits', async () => {
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":10,"traits":[]}' },
    [RONIN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[{"name":"non_kyc_transfers","risk":1}]}' },
    [ROUTER.toLowerCase()]: { status: 200, body: '{"toxicScore":100,"traits":[{"name":"known_scammer"}]}' },
  });
  const o = opts(f, { checkActivity: true });
  assert.equal((await screenAddress(CLEAN, o)).verdict, 'pass');
  assert.equal((await screenAddress(RONIN, o)).verdict, 'pass');
  assert.equal((await screenAddress(ROUTER, o)).verdict, 'block');
  assert.equal(f.calls.filter((c) => c.url.includes('/check-activity')).length, 0);
});

test('screenPayment: unknown payee -> verdict unknown, refuse payee_unknown_needs_human; block and unavailable still win', async () => {
  const PAYER = '0x1111111111111111111111111111111111111111';
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: ZERO_BODY },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":false}' },
    [PAYER]: { status: 200, body: ZERO_BODY },
    [RONIN.toLowerCase()]: { status: 200, body: '{"toxicScore":100,"traits":[{"name":"known_scammer"}]}' },
    [ROUTER.toLowerCase()]: { status: 404, body: '' },
  });
  const o = opts(f);
  const u = await screenPayment({ payTo: CLEAN, payer: PAYER }, o);
  assert.equal(u.verdict, 'unknown');
  assert.equal(u.refuse, 'payee_unknown_needs_human');
  assert.equal(u.line, `screening: payTo ${CLEAN} UNKNOWN: toxicScore 0 (no risk record), no activity on Base (chainId 8453): unknown payee / payer ${PAYER} toxicScore 0 (no risk record)`);
  const b = await screenPayment({ payTo: RONIN, payer: CLEAN }, o);
  assert.equal(b.verdict, 'block');
  const n = await screenPayment({ payTo: CLEAN, payer: ROUTER }, o);
  assert.equal(n.verdict, 'unavailable');
  assert.equal(n.refuse, 'payee_screening_unavailable');
});

test('cache: an answer served from the cache says so with the time it was asked (UTC); the first answer does not', async () => {
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: ZERO_BODY },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":false}' },
  });
  let t = Date.UTC(2026, 8, 26, 3, 4, 5);
  const o = opts(f, { checkActivity: true, now: () => t });
  const first = await screenAddress(CLEAN, o);
  assert.doesNotMatch(first.reason, /cached/);
  assert.equal(first.cachedAt, undefined);
  t += 60_000;
  const again = await screenAddress(CLEAN, o);
  assert.equal(again.verdict, 'unknown');
  assert.equal(again.reason, 'toxicScore 0 (no risk record), no activity on Base (chainId 8453): unknown payee (cached, asked 03:04:05 UTC)');
  assert.equal(again.cachedAt, Date.UTC(2026, 8, 26, 3, 4, 5));
  assert.equal(f.calls.length, 2, 'unknown is cached: quick-scan + check-activity once');
});

test('cache: quick-scan-only and activity-checked answers for one address are kept apart', async () => {
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: ZERO_BODY },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":false}' },
  });
  const o = opts(f);
  assert.equal((await screenAddress(CLEAN, o)).verdict, 'pass');
  assert.equal((await screenAddress(CLEAN, { ...o, checkActivity: true })).verdict, 'unknown');
});

test('disk cache: pass, block and unknown survive a save/load for 10 minutes; unavailable and expired entries do not; no key on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-screen-'));
  const file = path.join(dir, 'screening-cache.json');
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: ZERO_BODY },
    ['activity:' + CLEAN.toLowerCase()]: { status: 200, body: '{"hasActivity":false}' },
    [RONIN.toLowerCase()]: { status: 200, body: '{"toxicScore":100,"traits":[{"name":"known_scammer"}]}' },
    [ROUTER.toLowerCase()]: { status: 503, body: '' },
  });
  let t = Date.UTC(2026, 8, 26, 1, 0, 0);
  const cache = new Map();
  const o = { fetch: f, readKey: () => KEY, cache, now: () => t };
  await screenAddress(CLEAN, { ...o, checkActivity: true });
  await screenAddress(RONIN, o);
  await screenAddress(ROUTER, o);
  await saveScreeningCacheFile(file, cache, () => t);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(KEY));
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  t += 5 * 60_000;
  const loaded = loadScreeningCacheFile(file, () => t);
  assert.equal(loaded.size, 2);
  const g = fakeFetch({});
  const u = await screenAddress(CLEAN, { fetch: g, readKey: () => KEY, cache: loaded, now: () => t, checkActivity: true });
  assert.equal(u.verdict, 'unknown');
  assert.match(u.reason, /\(cached, asked 01:00:00 UTC\)$/);
  assert.equal((await screenAddress(RONIN, { fetch: g, readKey: () => KEY, cache: loaded, now: () => t })).verdict, 'block');
  assert.equal(g.calls.length, 0);
  t += 6 * 60_000;
  assert.equal(loadScreeningCacheFile(file, () => t).size, 0, 'older than 10 minutes');
  assert.equal(loadScreeningCacheFile(path.join(dir, 'missing.json')).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

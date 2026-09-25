// node --test test/screening.test.mjs   (Node >= 22.18 strips the types of ../src/screening.ts)
// fetch is always injected: these tests never reach the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUICK_SCAN_BASE,
  SCREENING_CACHE_TTL_MS,
  SCREENING_TIMEOUT_MS,
  screenAddress,
  screenPayment,
} from '../src/screening.ts';

const CLEAN = '0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6';
const RONIN = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
const ROUTER = '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b';
const KEY = 'test-key-0123456789abcdef-SECRET';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const addr = url.slice(QUICK_SCAN_BASE.length + 1, -'/quick-scan'.length).toLowerCase();
    const r = routes[addr];
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

test('pass: toxicScore 0, no traits; key only in the header', async () => {
  const f = fakeFetch({ [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[]}' } });
  const r = await screenAddress(CLEAN, opts(f));
  assert.equal(r.verdict, 'pass');
  assert.equal(r.toxicScore, 0);
  assert.deepEqual(r.traits, []);
  assert.match(r.reason, /toxicScore 0 \(clean\)/);
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

test('screenPayment: clean payee and payer pass with one line', async () => {
  const PAYER = '0x1111111111111111111111111111111111111111';
  const f = fakeFetch({
    [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[]}' },
    [PAYER]: { status: 200, body: '{"toxicScore":0,"traits":[]}' },
  });
  const s = await screenPayment({ payTo: CLEAN, payer: PAYER }, opts(f));
  assert.equal(s.verdict, 'pass');
  assert.equal(s.refuse, undefined);
  assert.equal(s.line, `screening: payTo ${CLEAN} toxicScore 0 (clean) / payer ${PAYER} toxicScore 0 (clean)`);
});

test('screenPayment: block wins over unavailable; unavailable alone refuses', async () => {
  const blockBody = JSON.stringify({ toxicScore: 100, traits: [{ risk: 100, name: 'known_scammer', txsCount: 4, description: '' }] });
  const f = fakeFetch({
    [RONIN.toLowerCase()]: { status: 200, body: blockBody },
    [ROUTER.toLowerCase()]: { status: 404, body: '' },
    [CLEAN.toLowerCase()]: { status: 200, body: '{"toxicScore":0,"traits":[]}' },
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

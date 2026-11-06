// ============================================================
// 2026-11-06: 払う直前に読む Arkiv の判定の関門（src/lib/observatory/arkiv-ruling-gate.ts）。
// 止めるのは「Arc で確かめられた Silent / Fraud の判定が 7 日以内にある」ときだけ。読めない・時間切れ・
// 例外は allow_unread（今までどおり払う）。fetch は全部モックで、ネットへ出ない。
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ARC_TESTNET_RPC,
  ARKIV_RPC,
  FRAUD_TOPIC,
  RULING_WRITER,
  SEALED_DELIVERY_ARC_TESTNET,
  ARKIV_RULING_GATE_TIMEOUT_MS,
  arcTestnetRpcUrl,
  arkivRpcUrl,
  checkArkivRuling,
  createBatchRulingBreaker,
  resetArkivRulingCache,
  rulingQuery,
} from "@/lib/observatory/arkiv-ruling-gate";

const PAY_TO = "0x1401bd7c7fab3fe8a429672fc1c5371456c8445d";
const CLAIM_ID = `0x${"31".repeat(32)}`;
const CLAIM_TX = `0x${"ab".repeat(32)}`;
const CONTRACT = SEALED_DELIVERY_ARC_TESTNET[0];
const ARC_CHAIN_ID = 5042002;
const CURRENT_BLOCK = 1_000_000;
const BLOCK_SECONDS = 2;
const NOW_SECONDS = 1_800_000_000;

interface Scenario {
  rows?: unknown[];
  /** Arc に Fraud の事象があるか。 */
  arcEvent?: boolean;
  arkivStatus?: number;
  throwOn?: "arkiv";
  hang?: boolean;
  /** Arkiv の読み先（env で上書きしたとき）。 */
  arkivUrl?: string;
  /** Arc の読み先（env で上書きしたとき）。 */
  arcUrl?: string;
  /** この回数だけ、最初の Arkiv／Arc の呼び出しに 429 を返す。 */
  arkiv429?: number;
  arc429?: number;
  /** 429 に付ける Retry-After。 */
  retryAfter?: string;
}

function rulingRow(overrides: Record<string, unknown> = {}) {
  const attrs: Record<string, unknown> = {
    pay_to: PAY_TO,
    verdict: "fraud",
    claim_id: CLAIM_ID,
    claim_tx: CLAIM_TX,
    contract: CONTRACT,
    chain_id: String(ARC_CHAIN_ID),
    ...overrides,
  };
  // 1 時間前に書かれた判定。
  return { createdAt: String(CURRENT_BLOCK - 1800), attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) };
}

function mockFetch(scenario: Scenario) {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ url, method: body.method, params: body.params });
    if (scenario.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
      });
    }
    const tooMany = () =>
      new Response("slow down", { status: 429, headers: scenario.retryAfter === undefined ? {} : { "retry-after": scenario.retryAfter } });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    if (url === (scenario.arkivUrl ?? ARKIV_RPC)) {
      if (scenario.throwOn === "arkiv") throw new TypeError("fetch failed");
      if (scenario.arkiv429 && scenario.arkiv429 > 0) {
        scenario.arkiv429--;
        return tooMany();
      }
      if (scenario.arkivStatus) {
        return new Response("oops", { status: scenario.arkivStatus, headers: scenario.retryAfter === undefined ? {} : { "retry-after": scenario.retryAfter } });
      }
      if (body.method === "arkiv_getBlockTiming") return reply({ current_block: CURRENT_BLOCK, current_block_time: NOW_SECONDS, duration: BLOCK_SECONDS });
      if (body.method === "arkiv_query") return reply({ data: scenario.rows ?? [] });
    }
    if (url === (scenario.arcUrl ?? ARC_TESTNET_RPC)) {
      if (scenario.arc429 && scenario.arc429 > 0) {
        scenario.arc429--;
        return tooMany();
      }
      if (body.method === "eth_chainId") return reply(`0x${ARC_CHAIN_ID.toString(16)}`);
      if (body.method === "eth_getTransactionReceipt") {
        return reply({ status: "0x1", blockNumber: "0x100", logs: [{ address: CONTRACT, topics: ["0xdead", CLAIM_ID] }] });
      }
      if (body.method === "eth_blockNumber") return reply("0x200");
      if (body.method === "eth_getLogs") return reply(scenario.arcEvent ? [{ topics: [FRAUD_TOPIC, CLAIM_ID] }] : []);
      if (body.method === "eth_getBlockByNumber") return reply({ timestamp: `0x${NOW_SECONDS.toString(16)}` });
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const ENV_KEYS = ["VET402_ARKIV_RULING_GATE", "VET402_ARKIV_RPC_URL", "VET402_ARC_TESTNET_RPC_URL"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  resetArkivRulingCache();
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("Arc で確かめられた Fraud の判定が 7 日以内にある → block（verdict と claimId を返す）", async () => {
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true });
  const result = await checkArkivRuling(PAY_TO, { fetch: impl });
  assert.deepEqual(result, { action: "block", verdict: "fraud", claimId: CLAIM_ID });
  const query = calls.find((c) => c.method === "arkiv_query");
  assert.equal(query?.params[0], rulingQuery(PAY_TO, RULING_WRITER));
  assert.match(String(query?.params[0]), /\$owner = addr\(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5\)/);
  const logs = calls.find((c) => c.method === "eth_getLogs");
  const filter = (logs?.params[0] ?? {}) as { topics: (string | null)[] };
  assert.equal(filter.topics[0], FRAUD_TOPIC);
  assert.equal(filter.topics[3], `0x${PAY_TO.slice(2).padStart(64, "0")}`);
});

test("判定はあるが Arc で確かめられない → allow(no_ruling)", async () => {
  const { impl } = mockFetch({ rows: [rulingRow()], arcEvent: false });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "allow", reason: "no_ruling" });
});

test("判定が別の契約を名指す・7 日より古い → allow(no_ruling)", async () => {
  const other = rulingRow({ contract: "0x0000000000000000000000000000000000000001" });
  const old = { ...rulingRow(), createdAt: String(CURRENT_BLOCK - 604_800 / BLOCK_SECONDS) };
  const { impl, calls } = mockFetch({ rows: [other, old], arcEvent: true });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "allow", reason: "no_ruling" });
  assert.equal(calls.filter((c) => c.method === "eth_getLogs").length, 0);
});

test("判定なし → allow(no_ruling)", async () => {
  const { impl } = mockFetch({ rows: [] });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "allow", reason: "no_ruling" });
});

test("Arkiv が 500 → allow_unread", async () => {
  const { impl } = mockFetch({ arkivStatus: 500 });
  const result = await checkArkivRuling(PAY_TO, { fetch: impl });
  assert.equal(result.action, "allow_unread");
  assert.match((result as { error: string }).error, /500/);
});

test("fetch が例外 → allow_unread", async () => {
  const { impl } = mockFetch({ throwOn: "arkiv" });
  const result = await checkArkivRuling(PAY_TO, { fetch: impl });
  assert.deepEqual(result, { action: "allow_unread", error: "fetch failed" });
});

test("時間切れ → allow_unread（AbortController で切る）", async () => {
  const { impl } = mockFetch({ hang: true });
  const started = Date.now();
  const result = await checkArkivRuling(PAY_TO, { fetch: impl, timeoutMs: 50 });
  assert.equal(result.action, "allow_unread");
  assert.match((result as { error: string }).error, /timed out after 50ms/);
  assert.ok(Date.now() - started < 2000);
});

test("signal を無視する fetch でも時間上限で allow_unread", async () => {
  const impl = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  const result = await checkArkivRuling(PAY_TO, { fetch: impl, timeoutMs: 30 });
  assert.equal(result.action, "allow_unread");
});

test("VET402_ARKIV_RULING_GATE=off → 読まずに allow(disabled)", async () => {
  process.env.VET402_ARKIV_RULING_GATE = "off";
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "allow", reason: "disabled" });
  assert.equal(calls.length, 0);
});

test("0x でない payTo（Solana・Stellar・XRPL）→ 読まずに allow(not_evm)", async () => {
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true });
  for (const payTo of ["34CMQ3HB3aDWPxwAbLSbQPrBtrFhi354zAsfbb3z5v2z", "GCEOU7BSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w"]) {
    assert.deepEqual(await checkArkivRuling(payTo, { fetch: impl }), { action: "allow", reason: "not_evm" });
  }
  assert.equal(calls.length, 0);
});

test("同じ payTo の 2 回目はキャッシュで fetch を省く（大文字小文字は同じ扱い）", async () => {
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true });
  const first = await checkArkivRuling(PAY_TO, { fetch: impl });
  const count = calls.length;
  assert.ok(count > 0);
  const second = await checkArkivRuling(`0x${PAY_TO.slice(2).toUpperCase()}`, { fetch: impl });
  assert.deepEqual(second, first);
  assert.equal(calls.length, count);
});

test("allow_unread はキャッシュしない", async () => {
  const failing = mockFetch({ arkivStatus: 500 });
  assert.equal((await checkArkivRuling(PAY_TO, { fetch: failing.impl })).action, "allow_unread");
  const ok = mockFetch({ rows: [] });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: ok.impl }), { action: "allow", reason: "no_ruling" });
  assert.ok(ok.calls.length > 0);
});

test("時間上限の既定は 3000ms", () => {
  assert.equal(ARKIV_RULING_GATE_TIMEOUT_MS, 3000);
});

test("壊れた行（createdAt・属性・chain_id）は数えずに飛ばし、その後ろの正しい判定で block", async () => {
  const badCreatedAt = { ...rulingRow(), createdAt: "not-a-block" };
  const badAttributes = { createdAt: String(CURRENT_BLOCK - 10), attributes: "oops" };
  const badChainId = rulingRow({ chain_id: "not-a-number" });
  const { impl } = mockFetch({ rows: [badCreatedAt, badAttributes, badChainId, rulingRow()], arcEvent: true });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "block", verdict: "fraud", claimId: CLAIM_ID });
});

test("壊れた行だけなら allow(no_ruling)（読めない扱いにしない）", async () => {
  const { impl } = mockFetch({ rows: [rulingRow({ chain_id: "x" }), { ...rulingRow(), createdAt: "x" }], arcEvent: true });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "allow", reason: "no_ruling" });
});

test("VET402_ARKIV_RPC_URL で Arkiv の読み先を上書きできる", async () => {
  const override = "https://arkiv.example.test/key/abc";
  process.env.VET402_ARKIV_RPC_URL = override;
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true, arkivUrl: override });
  assert.equal((await checkArkivRuling(PAY_TO, { fetch: impl })).action, "block");
  const arkivCalls = calls.filter((c) => c.method.startsWith("arkiv_"));
  assert.ok(arkivCalls.length > 0);
  assert.ok(arkivCalls.every((c) => c.url === override));
  assert.equal(calls.some((c) => c.url === ARKIV_RPC), false);
});

function address(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

test("遮断器: 時間切れが 2 回続いたら、バッチの残りは fetch を呼ばずに allow_unread", async () => {
  const { impl, calls } = mockFetch({ hang: true });
  const gate = createBatchRulingBreaker(checkArkivRuling);
  const first = await gate(address(1), { fetch: impl, timeoutMs: 20 });
  assert.equal(first.action, "allow_unread");
  assert.equal((first as { timedOut?: true }).timedOut, true);
  assert.equal((await gate(address(2), { fetch: impl, timeoutMs: 20 })).action, "allow_unread");
  const before = calls.length;
  assert.deepEqual(await gate(address(3), { fetch: impl, timeoutMs: 20 }), { action: "allow_unread", error: "breaker open for this batch" });
  assert.deepEqual(await gate(address(4), { fetch: impl, timeoutMs: 20 }), { action: "allow_unread", error: "breaker open for this batch" });
  assert.equal(calls.length, before);
  // 開いた後でも 0x でない payTo は not_evm のまま（読まない）。
  assert.deepEqual(await gate("34CMQ3HB3aDWPxwAbLSbQPrBtrFhi354zAsfbb3z5v2z", { fetch: impl }), { action: "allow", reason: "not_evm" });
  // 次のバッチ（新しい遮断器）はまた読む。
  const next = createBatchRulingBreaker(checkArkivRuling);
  await next(address(5), { fetch: impl, timeoutMs: 20 });
  assert.ok(calls.length > before);
});

test("遮断器: 429 などのすぐ返る失敗は何回続いても開かない", async () => {
  // Retry-After: 0 で再試行の待ちを 0 にする（2 回とも 429）。
  const { impl, calls } = mockFetch({ arkivStatus: 429, retryAfter: "0" });
  const gate = createBatchRulingBreaker(checkArkivRuling);
  for (let i = 0; i < 5; i++) {
    const before = calls.length;
    const result = await gate(address(20 + i), { fetch: impl });
    assert.equal(result.action, "allow_unread");
    assert.match((result as { error: string }).error, /429/);
    assert.equal((result as { timedOut?: true }).timedOut, undefined);
    assert.ok(calls.length > before, `${i + 1} 回目も読む`);
  }
});

test("遮断器: 読み切れたら連続数を 0 に戻す（時間切れ → 成功 → 時間切れでは開かない）", async () => {
  const scenario: Scenario = { hang: true };
  const { impl, calls } = mockFetch(scenario);
  const gate = createBatchRulingBreaker(checkArkivRuling);
  assert.equal((await gate(address(11), { fetch: impl, timeoutMs: 20 })).action, "allow_unread");
  scenario.hang = false;
  scenario.rows = [];
  assert.deepEqual(await gate(address(12), { fetch: impl, timeoutMs: 20 }), { action: "allow", reason: "no_ruling" });
  scenario.hang = true;
  assert.equal((await gate(address(13), { fetch: impl, timeoutMs: 20 })).action, "allow_unread");
  const before = calls.length;
  const fourth = await gate(address(14), { fetch: impl, timeoutMs: 20 });
  assert.equal(fourth.action, "allow_unread");
  assert.notEqual((fourth as { error: string }).error, "breaker open for this batch");
  assert.ok(calls.length > before, "連続 1 回の後なので 4 回目は読む");
  // これで 2 連続。5 回目は読まない。
  const after = calls.length;
  assert.deepEqual(await gate(address(15), { fetch: impl, timeoutMs: 20 }), { action: "allow_unread", error: "breaker open for this batch" });
  assert.equal(calls.length, after);
});

test("VET402_ARKIV_RPC_URL が https: でない・URL として読めないときは公開の ARKIV_RPC に戻す", () => {
  process.env.VET402_ARKIV_RPC_URL = "http://arkiv.example.test/key/secret";
  assert.equal(arkivRpcUrl(), ARKIV_RPC);
  process.env.VET402_ARKIV_RPC_URL = "not a url key=secret";
  assert.equal(arkivRpcUrl(), ARKIV_RPC);
  process.env.VET402_ARKIV_RPC_URL = "file:///etc/passwd";
  assert.equal(arkivRpcUrl(), ARKIV_RPC);
  process.env.VET402_ARKIV_RPC_URL = "  ";
  assert.equal(arkivRpcUrl(), ARKIV_RPC);
  process.env.VET402_ARKIV_RPC_URL = "https://arkiv.example.test/key/abc";
  assert.equal(arkivRpcUrl(), "https://arkiv.example.test/key/abc");
});

const timingCalls = (calls: { method: string }[]) => calls.filter((c) => c.method === "arkiv_getBlockTiming").length;

test("429 → 200: Arkiv は 400ms 待って 1 回だけ再試行し、読み切って block", async () => {
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true, arkiv429: 1 });
  const started = Date.now();
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "block", verdict: "fraud", claimId: CLAIM_ID });
  assert.equal(timingCalls(calls), 2);
  assert.ok(Date.now() - started >= 350, "既定の待ち 400ms を置いている");
});

test("429 → 200: Arc の呼び出しも 1 回だけ再試行して block", async () => {
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true, arc429: 1, retryAfter: "0" });
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "block", verdict: "fraud", claimId: CLAIM_ID });
  assert.equal(calls.filter((c) => c.method === "eth_chainId").length, 2);
});

test("429 → 429: 再試行は 1 回だけで allow_unread（時間切れ扱いにしない）", async () => {
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true, arkiv429: 5, retryAfter: "0" });
  const result = await checkArkivRuling(PAY_TO, { fetch: impl });
  assert.deepEqual(result, { action: "allow_unread", error: "Arkiv answered 429" });
  assert.equal(timingCalls(calls), 2);
});

test("残り時間が待ち＋要求の分に足りなければ再試行しない", async () => {
  // 上限 600ms < 待ち 400ms + 要求の取り置き 500ms。
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true, arkiv429: 1 });
  const started = Date.now();
  const result = await checkArkivRuling(PAY_TO, { fetch: impl, timeoutMs: 600 });
  assert.deepEqual(result, { action: "allow_unread", error: "Arkiv answered 429" });
  assert.equal(timingCalls(calls), 1);
  assert.ok(Date.now() - started < 300, "待たずに返す");
});

test("Retry-After が 800ms を超える（匿名枠の retry-after: 8）なら再試行せず、すぐ allow_unread", async () => {
  const { impl, calls } = mockFetch({ rows: [], arkiv429: 1, retryAfter: "8" });
  const started = Date.now();
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "allow_unread", error: "Arkiv answered 429" });
  assert.ok(Date.now() - started < 300, "待たずに返す");
  assert.equal(timingCalls(calls), 1);
});

test("Retry-After が 800ms 以内ならその分待って再試行する", async () => {
  const { impl, calls } = mockFetch({ rows: [], arkiv429: 1, retryAfter: "0.6" });
  const started = Date.now();
  assert.deepEqual(await checkArkivRuling(PAY_TO, { fetch: impl }), { action: "allow", reason: "no_ruling" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 550 && elapsed < 2000, `Retry-After 0.6 秒を待つ（実測 ${elapsed}ms）`);
  assert.equal(timingCalls(calls), 2);
});

test("VET402_ARC_TESTNET_RPC_URL で Arc の読み先を上書きでき、https: でなければ公開の Arc に戻す", async () => {
  process.env.VET402_ARC_TESTNET_RPC_URL = "http://arc.example.test/key/secret";
  assert.equal(arcTestnetRpcUrl(), ARC_TESTNET_RPC);
  process.env.VET402_ARC_TESTNET_RPC_URL = "not a url";
  assert.equal(arcTestnetRpcUrl(), ARC_TESTNET_RPC);
  const override = "https://arc.example.test/key/abc";
  process.env.VET402_ARC_TESTNET_RPC_URL = override;
  assert.equal(arcTestnetRpcUrl(), override);
  const { impl, calls } = mockFetch({ rows: [rulingRow()], arcEvent: true, arcUrl: override });
  assert.equal((await checkArkivRuling(PAY_TO, { fetch: impl })).action, "block");
  const arcCalls = calls.filter((c) => c.method.startsWith("eth_"));
  assert.ok(arcCalls.length > 0);
  assert.ok(arcCalls.every((c) => c.url === override));
  assert.equal(calls.some((c) => c.url === ARC_TESTNET_RPC), false);
});

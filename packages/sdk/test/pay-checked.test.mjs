// ============================================================
// payChecked — 手元の支出の決まりを、署名の前に当てる（2026-11-08）。
//
// ハーネスは pay-or-refuse.test.mjs の4層をそのまま写している。
//   第1層: account を Proxy で包み、`sign*` へのプロパティ参照を数える
//   第2層: fetch は許可リストの外へ出たら throw する
// 決まりで止めたときは sign* が 0。通ったときは signTypedData がちょうど 1 回。
// 同じ呼び出しを冪等の鍵つきで 2 回しても、払うのは 1 回。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { payChecked, readDemoDecisions, readL1Decisions } = await import("../dist/index.js");

/** 第1層: signer への「参照」を記録する Proxy。回数ではなくアクセスを見る。 */
function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, accessed, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

/**
 * 第2層: 許可リスト外の fetch は throw。拒否経路で許すのは /decision と 402 を取る GET だけ。
 *
 * 2026-09-05: 応答は素のオブジェクトでも `(url, init) => 応答` でもよい。売り手は
 * 同じ URL に対して「支払いヘッダ無し → 402」「有り → 200 + レシート」と**2回**答えるので、
 * URL だけで引く固定応答では x402 の実際の往復を写せない。
 */
function allowlistFetch(allowed, responses = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (!allowed.some((a) => u.includes(a))) {
        throw new Error(`forbidden call in refuse path: ${u}`);
      }
      let r = responses[Object.keys(responses).find((k) => u.includes(k))];
      if (typeof r === "function") r = r(u, init);
      if (!r) throw new Error(`no stub for ${u}`);
      return { ok: r.status < 400, status: r.status, json: async () => r.body, headers: new Map(Object.entries(r.headers ?? {})) };
    },
  };
}

const b64 = (o) => btoa(JSON.stringify(o));
const wall = (accept, version = 2) => ({ status: 402, body: {}, headers: { "payment-required": b64({ x402Version: version, accepts: [accept] }) } });

const base = { payee: "0x36038e1d712c5e39f35952164ec58ec2b96caee7", resource: "https://kronossignals.com/api/v1/price/btc", amountUsd: 0.02 };
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: base.payee, extra: { assetTransferMethod: "eip3009" } };
const RESOURCE_ID = "ab".repeat(32);
const EVIDENCE_URL = "https://vet402.com/observatory/e/x";

function seller(accept, opts = {}) {
  const version = opts.x402Version ?? 2;
  const payHeader = version === 1 ? "X-PAYMENT" : "PAYMENT-SIGNATURE";
  const respHeader = version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE";
  const paid = [];
  const stub = (url, init) => {
    const h = init?.headers ?? {};
    const raw = h[payHeader] ?? h[payHeader.toLowerCase()];
    if (!raw) return wall(accept, version);
    paid.push({ url, method: init?.method, header: payHeader, decoded: JSON.parse(atob(raw)) });
    if (opts.noReceipt) return { status: 200, body: { success: true, transaction: "0xfrom_body" }, headers: {} };
    if (opts.omitReceiptHeader) {
      return {
        status: opts.paidStatus ?? 500,
        body: opts.paidBody ?? { success: true, transaction: "0xtx" },
        headers: {},
      };
    }
    return {
      status: opts.paidStatus ?? 200,
      body: opts.paidBody ?? { data: "ok" },
      headers: { [respHeader]: b64({ success: true, transaction: "0xtx", network: accept.network, payer: "0xDB62BD202914609830fA656F87996b91be3Aa673", ...opts.settlement }) },
    };
  };
  return { stub, paid };
}

const decisionBody = () => ({
  subject: { type: "resource", id: RESOURCE_ID },
  role: "payer",
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  facts: {
    l0: { status: "pass" },
    l1: { n_delivered: 3, n_attempts: 3, n_inconclusive: 0 },
    l2: { status: "undeclared" },
    payees: [base.payee],
  },
  evidence: [{ level: "L1", source: "vet402", purchase_id: "eip155:8453:0xabc", url: EVIDENCE_URL }],
  degraded: false,
  policy: "allow_only",
  rules_version: "2026-09-02.1",
});

const resolveBody = () => ({
  resource: { resource_id: RESOURCE_ID, payee_id: `eip155:8453:${base.payee}`, canonical_url: base.resource },
});

function tempStore() {
  return join(mkdtempSync(join(tmpdir(), "vet402-pay-checked-")), "decisions.jsonl");
}

const OPEN_RULES = { maxPerTxUsd: 1, requireAllow: true, minDeliveryRate: 0.9 };

function harness(sellerOpts = {}, fetchOpts = {}) {
  const w = watchedAccount();
  const s = seller(okAccept, sellerOpts);
  const decision = fetchOpts.decision ?? (() => ({ status: 200, body: decisionBody() }));
  const f = allowlistFetch(["/resolve", "/decision", "kronos", "payments/x402"], {
    "/resolve": { status: 200, body: resolveBody() },
    "/decision": typeof decision === "function" ? decision : decision,
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  return { w, s, f, store: tempStore() };
}

const HOST = new URL(base.resource).host;

function seedSettledSpend(store, spend, atMs = Date.now() - 30_000) {
  const row = {
    recommendation: "ALLOW",
    reason_codes: [],
    verdict_source: "local_policy",
    evidence: [],
    decision: null,
    payeeScore: null,
    policy_override: null,
    source: "pay-checked",
    at: new Date(atMs).toISOString(),
    status: "paid",
    resource: base.resource,
    txHash: "0xseed",
    nonce: "0x1",
    payChecked: {
      state: "settled",
      idempotencyKey: `seed-${atMs}`,
      rulesJson: "{}",
      amountUsd: spend.amountUsd,
      url: base.resource,
      payTo: spend.payTo,
      at: atMs,
      spend: { ...spend, at: atMs },
      result: { paid: true, delivered: true, refusedBy: null, receipt: null, evidenceUrl: null },
    },
  };
  appendFileSync(store, `${JSON.stringify(row)}\n`);
}

function call(h, over = {}) {
  return payChecked({
    url: base.resource,
    rules: OPEN_RULES,
    amountUsd: base.amountUsd,
    account: h.w.account,
    fetch: h.f.fetch,
    store: h.store,
    ...over,
  });
}

test("決まりで止めたとき、sign* への参照は 0 で、売り手には出ない", async () => {
  const h = harness();
  const r = await call(h, { rules: { maxPerTxUsd: 0.01, requireAllow: true } });
  assert.equal(r.paid, false);
  assert.equal(r.delivered, false);
  assert.equal(r.refusedBy, "max_per_tx");
  assert.equal(r.receipt, null);
  assert.equal(r.evidenceUrl, EVIDENCE_URL);
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
  assert.equal(h.f.calls.some((u) => u.includes("/api/v1/resolve?q=")), true, "resolve を引いている");
  assert.equal(h.f.calls.some((u) => u.includes(`/resources/${RESOURCE_ID}/decision?role=payer`)), true, "decision を引いている");
  // resolve の q には資源の URL が入るので、文字列全体の "kronos" では売り手への通信と区別できない。
  assert.equal(h.f.calls.some((u) => new URL(u).hostname.includes("kronos")), false, "売り手には出ていない");
  assert.equal((await readDemoDecisions({ store: h.store })).length, 0);
  assert.equal((await readL1Decisions({ store: h.store })).length, 0);
  const lines = readFileSync(h.store, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "止めた呼び出しも記録を 1 行足す");
  assert.equal(JSON.parse(lines[0]).source, "pay-checked");
  assert.equal(JSON.parse(lines[0]).payChecked.spend, null, "止まって署名していない行は支出に数えない");
});

test("決まりを通ったとき、signTypedData がちょうど 1 回で、届いた応答は delivered", async () => {
  const h = harness();
  const r = await call(h);
  assert.equal(r.paid, true);
  assert.equal(r.delivered, true);
  assert.equal(r.refusedBy, null);
  assert.equal(r.evidenceUrl, EVIDENCE_URL);
  assert.equal(r.receipt?.payTo, base.payee);
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
  assert.equal(h.s.paid.length, 1);
  const lines = readFileSync(h.store, "utf8").trim().split("\n");
  // 払う前の保留の行と、払った後の確定の行。保留の行は書き換えずに残す。
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).payChecked.state, "pending");
  const row = JSON.parse(lines[1]);
  assert.equal(row.payChecked.state, "settled");
  assert.equal(row.payChecked.spend.payTo, base.payee);
  assert.equal(row.payChecked.spend.amountUsd, base.amountUsd);
  assert.equal((await readDemoDecisions({ store: h.store })).length, 0);
  assert.equal((await readL1Decisions({ store: h.store })).length, 0);
});

test("202 と空の本文は、払えても delivered ではない", async () => {
  const accepted = harness({ paidStatus: 202, paidBody: { data: "later" } });
  const acceptedResult = await call(accepted);
  assert.equal(acceptedResult.paid, true);
  assert.equal(acceptedResult.delivered, false);
  assert.deepEqual(accepted.w.signAccesses(), ["signTypedData"]);

  const empty = harness({ paidBody: "" });
  const emptyResult = await call(empty);
  assert.equal(emptyResult.paid, true);
  assert.equal(emptyResult.delivered, false);
  assert.deepEqual(empty.w.signAccesses(), ["signTypedData"]);

  const created = harness({ paidStatus: 201 });
  const createdResult = await call(created);
  assert.equal(createdResult.paid, true);
  assert.equal(createdResult.delivered, true);
});

test("同じ呼び出しを冪等の鍵つきで 2 回しても、払うのは 1 回", async () => {
  const h = harness();
  const first = await call(h, { idempotencyKey: "purchase-1" });
  const second = await call(h, { idempotencyKey: "purchase-1" });
  assert.equal(first.paid, true);
  assert.equal(second.paid, true);
  assert.equal(second.delivered, true);
  assert.equal(second.receipt?.payTo, base.payee);
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
  assert.equal(h.s.paid.length, 1, "売り手への支払い再送は 1 回");
  assert.equal(readFileSync(h.store, "utf8").trim().split("\n").length, 2, "記録は保留と確定の 2 行のまま（2 回目は足さない）");
});

for (const [name, rules, expectedRefused, seed] of [
  ["期限切れ", { maxPerTxUsd: 1, expiresAt: "2020-01-01T00:00:00.000Z" }, "rules_expired", null],
  ["拒否一覧", { maxPerTxUsd: 1, denyPayTo: [base.payee] }, "deny_pay_to", null],
  ["WARN", { maxPerTxUsd: 1, requireAllow: true }, "require_allow", { decision: () => ({ status: 200, body: { ...decisionBody(), recommendation: "WARN" } }) }],
  ["配達率の床", { maxPerTxUsd: 1, minDeliveryRate: 0.9 }, "min_delivery_rate", { decision: () => ({ status: 200, body: { ...decisionBody(), facts: { ...decisionBody().facts, l1: { n_delivered: 1, n_attempts: 10, n_inconclusive: 0 } } } }) }],
]) {
  test(`決まり拒否（${name}）では signTypedData に触れず売り手にも出ない`, async () => {
    const h = harness({}, seed ?? {});
    const r = await call(h, { rules });
    assert.equal(r.paid, false);
    assert.equal(r.refusedBy, expectedRefused);
    assert.deepEqual(h.w.signAccesses(), []);
    assert.equal(h.s.paid.length, 0);
  });
}

test("相手の回数上限では signTypedData に触れない", async () => {
  const h = harness();
  const cap = { maxPerTxUsd: 1, perPayee: { [base.payee]: { maxCountPerHour: 2 } } };
  for (let i = 0; i < 2; i++) {
    seedSettledSpend(h.store, { payTo: base.payee, host: HOST, resourceId: RESOURCE_ID, amountUsd: 0.01 }, Date.now() - 60_000 - i * 1000);
  }
  const r = await call(h, { rules: cap });
  assert.equal(r.refusedBy, "payee_max_count_per_hour");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("相手の日次上限では signTypedData に触れない", async () => {
  const h = harness();
  const cap = { maxPerTxUsd: 1, perPayee: { [base.payee]: { maxPerDayUsd: 0.05 } } };
  seedSettledSpend(h.store, { payTo: base.payee, host: HOST, resourceId: RESOURCE_ID, amountUsd: 0.04 });
  const r = await call(h, { rules: cap });
  assert.equal(r.refusedBy, "payee_max_per_day");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("vet402 の decision が届かない（requireAllow あり）とき signTypedData に触れない", async () => {
  const h = harness({}, { decision: () => ({ status: 503, body: {} }) });
  const r = await call(h, { rules: { maxPerTxUsd: 1, requireAllow: true } });
  assert.equal(r.refusedBy, "require_allow");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("vet402 の decision が届かない（requireAllow なし）とき signTypedData に触れない", async () => {
  const h = harness({}, { decision: () => ({ status: 503, body: {} }) });
  const r = await call(h, { rules: { maxPerTxUsd: 1 } });
  assert.equal(r.refusedBy, "decision_unavailable");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("ホスト上限では signTypedData に触れない", async () => {
  const h = harness();
  seedSettledSpend(h.store, { payTo: base.payee, host: HOST, resourceId: RESOURCE_ID, amountUsd: 0.04 });
  const r = await call(h, { rules: { maxPerTxUsd: 1, perHost: { [HOST]: { maxPerDayUsd: 0.05 } } } });
  assert.equal(r.refusedBy, "host_max_per_day");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("resourceId 上限では signTypedData に触れない", async () => {
  const h = harness();
  seedSettledSpend(h.store, { payTo: base.payee, host: HOST, resourceId: RESOURCE_ID, amountUsd: 0.04 });
  const r = await call(h, { rules: { maxPerTxUsd: 1, perResourceId: { [RESOURCE_ID]: { maxPerDayUsd: 0.05 } } } });
  assert.equal(r.refusedBy, "resource_max_per_day");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("壊れた決まりでは signTypedData に触れない", async () => {
  const h = harness();
  const r = await call(h, { rules: { maxPerTxUsd: -1, requireAllow: true } });
  assert.equal(r.refusedBy, "invalid_rules");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("全体の日次上限では signTypedData に触れない", async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) {
    seedSettledSpend(
      h.store,
      { payTo: `0x${String(i).padStart(40, "a")}`, host: `host-${i}.example`, resourceId: RESOURCE_ID, amountUsd: 0.099 },
      Date.now() - 60_000 - i * 1000,
    );
  }
  const r = await call(h, { rules: { maxPerTxUsd: 1, maxPerDayUsd: 1, requireAllow: true }, amountUsd: 0.02 });
  assert.equal(r.refusedBy, "max_per_day");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("ホストの回数上限では signTypedData に触れない", async () => {
  const h = harness();
  const hostname = new URL(base.resource).hostname;
  for (let i = 0; i < 2; i++) {
    seedSettledSpend(h.store, { payTo: base.payee, host: hostname, resourceId: RESOURCE_ID, amountUsd: 0.01 }, Date.now() - 60_000 - i * 1000);
  }
  const r = await call(h, { rules: { maxPerTxUsd: 1, perHost: { [hostname]: { maxCountPerHour: 2 } }, requireAllow: true } });
  assert.equal(r.refusedBy, "host_max_count_per_hour");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("resourceId の回数上限では signTypedData に触れない", async () => {
  const h = harness();
  seedSettledSpend(h.store, { payTo: base.payee, host: HOST, resourceId: RESOURCE_ID, amountUsd: 0.01 });
  const r = await call(h, { rules: { maxPerTxUsd: 1, perResourceId: { [RESOURCE_ID]: { maxCountPerHour: 1 } }, requireAllow: true } });
  assert.equal(r.refusedBy, "resource_max_count_per_hour");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("非標準ポートの URL でも hostname のホスト上限を抜けない", async () => {
  const portUrl = "https://api.example.org:8443/v1/quote";
  const hostname = "api.example.org";
  const h = harness();
  seedSettledSpend(h.store, { payTo: base.payee, host: hostname, resourceId: RESOURCE_ID, amountUsd: 0.5 });
  const r = await payChecked({
    url: portUrl,
    rules: { maxPerTxUsd: 1, requireAllow: true, perHost: { [hostname]: { maxPerDayUsd: 0.01 } } },
    amountUsd: base.amountUsd,
    account: h.w.account,
    fetch: h.f.fetch,
    store: h.store,
  });
  assert.equal(r.refusedBy, "host_max_per_day");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("決済後の 5xx でも同じ鍵の 2 回目は払い直さない", async () => {
  const h = harness({ paidStatus: 500 });
  const first = await call(h, { idempotencyKey: "after-5xx", rules: OPEN_RULES });
  const second = await call(h, { idempotencyKey: "after-5xx", rules: OPEN_RULES });
  assert.equal(second.paid, first.paid);
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
  assert.equal(h.s.paid.length, 1);
});

test("決済後の 500（レシートヘッダ無し）でも同じ鍵の 2 回目は払い直さない", async () => {
  const h = harness({ paidStatus: 500, omitReceiptHeader: true });
  const first = await call(h, { idempotencyKey: "after-5xx-noreceipt", rules: OPEN_RULES });
  const second = await call(h, { idempotencyKey: "after-5xx-noreceipt", rules: OPEN_RULES });
  assert.equal(second.paid, first.paid);
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
  assert.equal(h.s.paid.length, 1);
});

test("記録した支払いは次の呼び出しの時間窓に入る", async () => {
  const h = harness();
  const first = await call(h, { rules: { maxPerTxUsd: 1, maxCountPerHour: 1, requireAllow: true } });
  assert.equal(first.paid, true);
  const second = await call(h, { rules: { maxPerTxUsd: 1, maxCountPerHour: 1, requireAllow: true } });
  assert.equal(second.paid, false);
  assert.equal(second.refusedBy, "max_count_per_hour");
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
  assert.equal(h.s.paid.length, 1);
});

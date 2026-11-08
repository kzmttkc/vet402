// ============================================================
// payChecked の安全の合格表（2026-11-08・独立レビューの NO-SHIP 4 件を Claude が固定。実装はこれを緑にする）。
// ハーネスは pay-checked.test.mjs と同じ。止めるべき時に署名へ到達しないことを見る。
//
// ハーネスは pay-or-refuse.test.mjs の4層をそのまま写している。
//   第1層: account を Proxy で包み、`sign*` へのプロパティ参照を数える
//   第2層: fetch は許可リストの外へ出たら throw する
// 決まりで止めたときは sign* が 0。通ったときは signTypedData がちょうど 1 回。
// 同じ呼び出しを冪等の鍵つきで 2 回しても、払うのは 1 回。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
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

function harness(sellerOpts = {}) {
  const w = watchedAccount();
  const s = seller(okAccept, sellerOpts);
  const f = allowlistFetch(["/resolve", "/decision", "kronos", "payments/x402"], {
    "/resolve": { status: 200, body: resolveBody() },
    "/decision": { status: 200, body: decisionBody() },
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  return { w, s, f, store: tempStore() };
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


const COUNT_ONE = { maxPerTxUsd: 1, maxCountPerHour: 1, requireAllow: true };

test("安全 1: 同じ保存先へ同時に 2 本呼んでも、回数上限 1 なら払うのは 1 回", async () => {
  const h = harness();
  const [a, b] = await Promise.all([call(h, { rules: COUNT_ONE }), call(h, { rules: COUNT_ONE })]);
  assert.equal([a, b].filter((r) => r.paid).length, 1);
  const refused = [a, b].find((r) => !r.paid);
  assert.equal(refused.refusedBy, "max_count_per_hour");
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
  assert.equal(h.s.paid.length, 1);
});

test("安全 1b: 1 日の上限も同時の 2 本で超えない", async () => {
  const h = harness();
  const rules = { maxPerTxUsd: 1, maxPerDayUsd: 0.03, requireAllow: true };
  const rs = await Promise.all([call(h, { rules }), call(h, { rules }), call(h, { rules })]);
  assert.equal(rs.filter((r) => r.paid).length, 1, "0.02 を 3 本、上限 0.03 なら通るのは 1 本");
  assert.equal(h.s.paid.length, 1);
});

test("安全 2: 同じ冪等の鍵で同時に 2 本呼んでも、払うのは 1 回", async () => {
  const h = harness();
  const [a, b] = await Promise.all([call(h, { idempotencyKey: "k-1" }), call(h, { idempotencyKey: "k-1" })]);
  assert.equal(h.s.paid.length, 1);
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
  for (const r of [a, b]) assert.ok(r.paid === true || r.refusedBy === "payment_pending", JSON.stringify(r));
});

test("安全 2b: 署名の後に記録が書けなくても、同じ鍵の呼び直しで 2 回目は払わない", async () => {
  const h = harness({});
  const orig = h.s.stub;
  let locked = false;
  // 売り手が支払いつきの要求を受けた瞬間に記録を読み取り専用にし、払った後の書き込みを失敗させる。
  const f = allowlistFetch(["/resolve", "/decision", "kronos", "payments/x402"], {
    "/resolve": { status: 200, body: resolveBody() },
    "/decision": { status: 200, body: decisionBody() },
    kronos: (u, init) => {
      const r = orig(u, init);
      if (r.status !== 402 && !locked) { chmodSync(h.store, 0o444); locked = true; }
      return r;
    },
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const first = await call(h, { fetch: f.fetch, idempotencyKey: "k-2" });
  assert.equal(h.s.paid.length, 1, "1 回目は払った");
  assert.ok(first.recordError, "払った後に記録できなかったことを結果で知らせる");
  chmodSync(h.store, 0o644);
  const second = await call(h, { fetch: f.fetch, idempotencyKey: "k-2" });
  assert.equal(h.s.paid.length, 1, "呼び直しでは払わない");
  assert.equal(second.paid, false);
  assert.equal(second.refusedBy, "payment_pending");
  assert.deepEqual(h.w.signAccesses(), ["signTypedData"]);
});

test("安全 2c: 払う前の保留が書けなければ払わない", async () => {
  const h = harness();
  writeFileSync(h.store, "");
  chmodSync(h.store, 0o444);
  const r = await call(h);
  chmodSync(h.store, 0o644);
  assert.equal(r.paid, false);
  assert.equal(r.refusedBy, "store_unreadable");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("安全 3: 記録が読めない（権限・ディレクトリ）なら空とみなさず止める", async () => {
  const noRead = harness();
  writeFileSync(noRead.store, "");
  chmodSync(noRead.store, 0o200);
  const r1 = await call(noRead, { rules: COUNT_ONE });
  chmodSync(noRead.store, 0o644);
  assert.equal(r1.paid, false);
  assert.equal(r1.refusedBy, "store_unreadable");
  assert.deepEqual(noRead.w.signAccesses(), []);

  const dir = harness();
  mkdirSync(dir.store);
  const r2 = await call(dir, { rules: COUNT_ONE });
  assert.equal(r2.paid, false);
  assert.equal(r2.refusedBy, "store_unreadable");
  assert.deepEqual(dir.w.signAccesses(), []);
});

test("安全 3b: 記録がまだ無い（ファイルが無い）時だけ、履歴 0 件として払う", async () => {
  const h = harness();
  const r = await call(h, { rules: COUNT_ONE });
  assert.equal(r.paid, true);
});

test("安全 4: 壊れた行や形の崩れた支出の行があれば止める", async () => {
  for (const bad of ["{not json", JSON.stringify({ source: "pay-checked", payChecked: { spend: { payTo: base.payee, amountUsd: "0.5", at: Date.now() } } })]) {
    const h = harness();
    writeFileSync(h.store, bad + "\n");
    const r = await call(h, { rules: COUNT_ONE });
    assert.equal(r.paid, false, bad);
    assert.equal(r.refusedBy, "store_unreadable", bad);
    assert.deepEqual(h.w.signAccesses(), [], bad);
    assert.equal(h.s.paid.length, 0, bad);
  }
});

test("安全 5: 払う相手が分からない時は、止めた理由を返す", async () => {
  const h = harness();
  const f = allowlistFetch(["/resolve", "/decision", "kronos"], {
    "/resolve": { status: 200, body: { resource: { resource_id: RESOURCE_ID, payee_id: null, canonical_url: base.resource } } },
    "/decision": { status: 200, body: { ...decisionBody(), facts: { ...decisionBody().facts, payees: [] } } },
    kronos: h.s.stub,
  });
  const r = await call(h, { fetch: f.fetch });
  assert.equal(r.paid, false);
  assert.equal(r.refusedBy, "payee_unknown");
  assert.deepEqual(h.w.signAccesses(), []);
});

test("安全 6: 記録は末尾に足すだけで、前の中身を書き直さない（払った後に落ちても記録が消えない）", async () => {
  const h = harness();
  const foreign = JSON.stringify({ source: "other-agent", note: "kept" }) + "\n";
  writeFileSync(h.store, foreign);
  const before1 = readFileSync(h.store, "utf8");
  const r1 = await call(h, { idempotencyKey: "a-1" });
  assert.equal(r1.paid, true);
  const after1 = readFileSync(h.store, "utf8");
  assert.ok(after1.startsWith(before1), "1 回目の後も、前の中身がそのまま先頭に残る");
  // 払っている間に別の書き手が足した行も消えない。
  const orig = h.s.stub;
  const f = allowlistFetch(["/resolve", "/decision", "kronos", "payments/x402"], {
    "/resolve": { status: 200, body: resolveBody() },
    "/decision": { status: 200, body: decisionBody() },
    kronos: (u, init) => {
      const r = orig(u, init);
      if (r.status !== 402) appendFileSync(h.store, JSON.stringify({ source: "other-agent", note: "mid-flight" }) + "\n");
      return r;
    },
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const before2 = readFileSync(h.store, "utf8");
  const r2 = await call(h, { fetch: f.fetch, idempotencyKey: "a-2" });
  assert.equal(r2.paid, true);
  const after2 = readFileSync(h.store, "utf8");
  assert.ok(after2.startsWith(before2), "2 回目の後も、前の中身がそのまま先頭に残る");
  assert.ok(after2.includes('"mid-flight"'), "払っている間に足された他の行が残る");
  assert.equal(existsSync(h.store + ".lock"), false, "終わった後にロックが残らない");
  // 保留の行を書き換えず、確定の行を後ろに足す（書き直しは途中で落ちるとファイルが空になる）。
  const rows = after2.trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.source === "pay-checked");
  const pending = rows.filter((r) => r.payChecked?.state === "pending");
  const settled = rows.filter((r) => r.payChecked?.state === "settled");
  assert.equal(pending.length, 2, "保留の行は 2 本とも残る");
  assert.equal(settled.length, 2, "確定の行が 2 本足される");
  for (const p of pending) {
    const i = rows.indexOf(p);
    const j = rows.findIndex((r) => r.payChecked?.state === "settled" && r.payChecked?.pendingId === p.payChecked.pendingId);
    assert.ok(j > i, "確定の行は対応する保留の行より後ろにある");
  }
  const src = readFileSync(new URL("../src/pay-checked.ts", import.meta.url), "utf8");
  assert.equal(/\bwriteFile(Sync)?\(\s*store\b/.test(src), false, "記録のファイルを丸ごと書き直さない");
});

test("安全 7: 生きている持ち主のロックは、古くても外さない", async () => {
  const h = harness();
  writeFileSync(h.store, "");
  // 自分自身（生きている pid）が持つ、時刻の古いロックを置く。
  writeFileSync(h.store + ".lock", JSON.stringify({ pid: process.pid, at: Date.now() - 3_600_000, token: "held-by-someone" }));
  const r = await call(h, { rules: COUNT_ONE });
  assert.equal(r.paid, false, "生きている持ち主のロックを外して入らない");
  assert.equal(r.refusedBy, "store_unreadable");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.ok(readFileSync(h.store + ".lock", "utf8").includes("held-by-someone"), "他人のロックを消さない");
});

test("安全 8: 時刻が有限の数でない支出の行があれば止める", async () => {
  const h = harness();
  writeFileSync(h.store, '{"source":"pay-checked","payChecked":{"state":"settled","spend":{"payTo":"' + base.payee + '","amountUsd":0.02,"at":1e999}}}\n');
  const r = await call(h, { rules: COUNT_ONE });
  assert.equal(r.paid, false);
  assert.equal(r.refusedBy, "store_unreadable");
  assert.deepEqual(h.w.signAccesses(), []);
});

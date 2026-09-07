// ============================================================
// **`pay_if_trusted` の外部入力 × 壊れた形の表 — 全組み合わせが署名の前に止まる（または署名に漏れない）。**
//
// 表は SDK と共有する（`packages/sdk/test/_shapes.mjs`）。同じ 1 つの配列を、この橋が読む 2 つの面
// —— ツール入力（resourceId / payee / resource / amountUsd / maxPerTxUsd / policy）と `/decision` の本文
// （橋の `measure()` が読む欄）—— に差し込む。SDK の `payOrRefuse` は第 5 段で必ず通るので、
// ここで見るのは **橋が自分で読む値**が壊れていたときに、橋の段で止まるか SDK の段で止まるか、
// いずれにせよ signer に触らないこと。
//
// money 欄: signer 参照 0・decision "REFUSE"（refuse_reasons に語彙の語）か `invalid_*` の throw。
// inert 欄: 払ってよいが、署名に載るのは正規の額・宛先のまま。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { payIfTrusted, REFUSE_REASONS } from "../dist/pay-if-trusted.js";
import { PAY_REFUSE_REASONS } from "@vet402/sdk";
import { BROKEN_SHAPES, REQUIRED_SHAPE_IDS, withShape, showShape } from "../../sdk/test/_shapes.mjs";

const PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj";
const RESOURCE_ID = "a".repeat(64);
const b64 = (o) => btoa(JSON.stringify(o));
const VOCAB = new Set([...PAY_REFUSE_REASONS, ...REFUSE_REASONS]);

const JSON_ROWS = BROKEN_SHAPES.filter((r) => r.from === "json");
const ALL_ROWS = BROKEN_SHAPES;

const allowDecision = () => ({
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 } },
  evidence: [{ level: "L1", url: "https://vet402.com/api/v1/purchases/p1", purchase_id: "p1" }],
  degraded: false,
  rules_version: "2026-09-02.1",
  registry: { status: "anchored", tx_hash: null },
  caller_policy: { verdict: "ALLOW", reason_codes: [] },
});
const ACCEPT = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: PAYEE, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } };

function watched() {
  const signed = [];
  const accessed = [];
  const signer = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async (td) => { signed.push(td); return "0xsig"; } },
    { get: (t, p) => (accessed.push(String(p)), Reflect.get(t, p)) },
  );
  return { signer, signed, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

function harness({ decision = allowDecision() } = {}) {
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decision, headers: new Map() };
    if (u.includes("/payees/")) return { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", score: 90, degraded: false, signalsUnavailable: [] }), headers: new Map() };
    if (u.includes("subgraphs/id/")) {
      const h = init?.headers ?? {};
      if (!(h["PAYMENT-SIGNATURE"] ?? h["X-PAYMENT"])) {
        return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [ACCEPT] })]]) };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: "eip155:8453" })]]) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() };
  };
  return { fetch };
}

const base = (w, fetch) => ({ resourceId: RESOURCE_ID, signer: w.signer, fetch, resource: RESOURCE, method: "POST", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1 });

async function run(input) {
  try {
    const result = await payIfTrusted(input);
    return { kind: result.decision, result };
  } catch (error) {
    return { kind: "throw", error };
  }
}

function assertStopped(w, outcome, label) {
  assert.deepEqual(w.signAccesses(), [], `${label}: signer に触った（${outcome.kind}）`);
  if (outcome.kind === "REFUSE") {
    assert.equal(outcome.result.safe_to_pay, false);
    assert.equal(outcome.result.nonce, null);
    assert.ok(outcome.result.refuse_reasons.some((r) => VOCAB.has(r)), `${label}: 語彙の語が無い: ${JSON.stringify(outcome.result.refuse_reasons)}`);
  } else if (outcome.kind === "throw") {
    assert.match(String(outcome.error?.message ?? outcome.error), /^invalid_[a-z_]+:/, `${label}: 呼び出し側エラー以外の throw`);
  } else {
    assert.fail(`${label}: 止まらなかった（${outcome.kind}）`);
  }
}

function assertNotLeaked(w, outcome, label) {
  if (outcome.kind !== "PAID" && outcome.kind !== "FAILED") return assertStopped(w, outcome, label);
  assert.equal(w.signed.length, 1, `${label}: 署名回数が 1 でない`);
  const td = w.signed[0];
  assert.equal(String(td.message.to).toLowerCase(), PAYEE.toLowerCase(), `${label}: 宛先が署名に漏れた`);
  assert.equal(td.message.value, "10000", `${label}: 額が署名に漏れた`);
  assert.equal(String(td.domain.verifyingContract).toLowerCase(), USDC.toLowerCase());
}

function sweep({ surface, rows, fields, make }) {
  for (const f of fields) {
    for (const row of rows) {
      const stop = f.kind === "money" && !(f.allow ?? []).includes(row.id);
      const label = `pay_if_trusted ${surface} ${f.path}=${showShape(row)}`;
      test(`${label} → ${stop ? "署名前に止まる" : "署名に漏れない"}`, async () => {
        const w = watched();
        const outcome = await run(make(f.path, row.value, w));
        if (stop) assertStopped(w, outcome, label);
        else assertNotLeaked(w, outcome, label);
      });
    }
  }
}

test("表: SDK と同じ表を読んでいる（必須の形が全部居る）", () => {
  const ids = new Set(BROKEN_SHAPES.map((r) => r.id));
  for (const id of REQUIRED_SHAPE_IDS) assert.ok(ids.has(id), `表に ${id} が無い`);
});

test("基準値: 壊す前の形は PAID（ネガティブコントロール）", async () => {
  const w = watched();
  const h = harness();
  const outcome = await run(base(w, h.fetch));
  assert.equal(outcome.kind, "PAID", JSON.stringify(outcome.result?.refuse_reasons ?? outcome.error?.message));
  assertNotLeaked(w, outcome, "baseline");
});

// ---------- 面 1: ツール入力 ----------

sweep({
  surface: "input",
  rows: ALL_ROWS,
  fields: [
    { path: "resourceId", kind: "money" },
    { path: "payee", kind: "money" },
    { path: "resource", kind: "money" },
    { path: "amountUsd", kind: "money", allow: ["fraction"] /* $0.5 の名乗りは 402 の $0.01 を包む */ },
    { path: "maxPerTxUsd", kind: "money", allow: ["absent", "undefined", "number", "fraction"] },
    { path: "fetch", kind: "money" },
    { path: "method", kind: "inert" },
    { path: "apiUrl", kind: "inert" },
    { path: "apiKey", kind: "inert" },
    { path: "source", kind: "inert" },
    { path: "graphApiKey", kind: "inert" },
    { path: "__unexpected_key", kind: "inert" },
  ],
  make: (path, value, w) => withShape(base(w, harness().fetch), path, value),
});

sweep({
  surface: "input.policy",
  rows: ALL_ROWS,
  fields: [
    { path: "policy", kind: "inert" },
    { path: "policy.maxPerTxUsd", kind: "money", allow: ["absent", "undefined", "number", "fraction"] },
    { path: "policy.evidence", kind: "inert" },
    { path: "policy.evidence.source", kind: "money", allow: ["absent", "undefined", "null"] },
    { path: "policy.evidence.minL1Deliveries", kind: "money", allow: ["absent", "undefined", "zero", "fraction"] },
    { path: "policy.__unexpected_key", kind: "inert" },
  ],
  make: (path, value, w) => {
    const input = { ...base(w, harness().fetch), policy: { maxPerTxUsd: 1, evidence: { source: "vet402", minL1Deliveries: 1 } } };
    delete input.maxPerTxUsd;
    return withShape(input, path, value);
  },
});

// requireVet402Allow: WARN の判定・床は満たしている。リテラルの false 以外は免除にならない。
sweep({
  surface: "input.policy(WARN)",
  rows: ALL_ROWS,
  fields: [{ path: "policy.requireVet402Allow", kind: "money", allow: ["boolean-false"] }],
  make: (path, value, w) => {
    const h = harness({ decision: { ...allowDecision(), recommendation: "WARN", reason_codes: ["l1_thin"] } });
    return withShape({ ...base(w, h.fetch), policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 1 } } }, path, value);
  },
});

// ---------- 面 2: /decision 本文（橋の measure() が読む欄）----------

sweep({
  surface: "/decision",
  rows: JSON_ROWS,
  fields: [
    { path: "recommendation", kind: "money" },
    { path: "degraded", kind: "money", allow: ["boolean-false"] },
    { path: "reason_codes", kind: "inert" },
    { path: "evidence", kind: "inert" },
    { path: "evidence.0", kind: "inert" },
    { path: "facts", kind: "inert" },
    { path: "rules_version", kind: "inert" },
    { path: "registry", kind: "inert" },
    { path: "caller_policy", kind: "inert" },
    { path: "caller_policy.verdict", kind: "inert" },
    { path: "caller_policy.reason_codes", kind: "inert" },
    { path: "__unexpected_key", kind: "inert" },
  ],
  make: (path, value, w) => base(w, harness({ decision: withShape(allowDecision(), path, value) }).fetch),
});

// 本文そのものが object でない（SDK の S1 と同じ族を橋の段でも見る）。
for (const row of JSON_ROWS.filter((r) => r.id !== "absent" && r.id !== "empty-object")) {
  test(`pay_if_trusted /decision body=${showShape(row)} → 署名前に止まる`, async () => {
    const w = watched();
    const outcome = await run(base(w, harness({ decision: row.value }).fetch));
    assertStopped(w, outcome, `body=${showShape(row)}`);
  });
}

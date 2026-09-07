// ============================================================
// **外部入力の面 × 壊れた形の表 — 全組み合わせが署名の前に止まる（または署名に漏れない）。**
//
// 2026-09-07 の第三者監査が見つけた「金が動く欠陥 6 件」は全部、外から来る値の型・形が
// 想定と違う族だった（`/decision` 本文が null、`degraded` が "true"、402 の額が "1e4"、policy が NaN）。
// 欠陥ごとのテスト（decision-body-shape / money-gate-amount-format / policy-numbers）は
// **見つかった値**しか見ない。ここでは `_shapes.mjs` の表を、`payOrRefuse` が読む**全部の外部入力**
// （/decision 本文・402 の accept・The Graph の応答・呼び手の policy・呼び手の引数）の
// **全部のフィールド**に差し込む。表に行を足せば全面に効く。
//
// 欄は 2 種類:
//   money  … 金額・宛先・判定・床。壊れた形なら**署名器は 0 回**で、status は refused（理由語は
//            PAY_REFUSE_REASONS の語彙）か、呼び出し側エラー（`invalid_*`）の throw
//   inert  … 額・宛先・判定に関わらない欄（rules_version・registry・maxTimeoutSeconds 等）。
//            壊れていても払ってよいが、**署名に載る値は正規の額と宛先のまま**で、認可の窓は上限内。
//            拒否するなら語彙の語で、throw するなら `invalid_*` で
// 「どの欄が money か」を決めるのがこのファイルの主張。欄の分類を変えるときは理由を書く。
//
// 実ネットワーク・実署名・オンチェーンなし。fetch は偽物、署名器は Proxy（参照を数える）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { payOrRefuse, PAY_REFUSE_REASONS } from "../dist/index.js";
import { ABSENT, BROKEN_SHAPES, REQUIRED_SHAPE_IDS, withShape, showShape } from "./_shapes.mjs";

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const GRAPH_KEY = "k".repeat(32);
const b64 = (o) => btoa(JSON.stringify(o));
const VOCAB = new Set(PAY_REFUSE_REASONS);

/** JSON 経由で届く面には JSON が作れる行だけを回す（NaN / undefined は fetch の json() からは来ない）。 */
const JSON_ROWS = BROKEN_SHAPES.filter((r) => r.from === "json");
const ALL_ROWS = BROKEN_SHAPES;

// ---------- 正しい形の基準値（ここから 1 欄だけを壊す）----------

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
const warnDecision = () => ({ ...allowDecision(), recommendation: "WARN", reason_codes: ["l1_thin"] });

const okAccept = () => ({
  scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAYEE,
  maxTimeoutSeconds: 60, resource: RESOURCE,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
});
const okChallenge = () => ({ x402Version: 2, resource: { url: RESOURCE }, accepts: [okAccept()] });

const okSubgraph = () => ({
  data: {
    x402AddressSummaries: [{ id: "x", address: PAYEE, role: "RECIPIENT", totalPayments: "253" }],
    _meta: { block: { number: 50898704, timestamp: 1788569053 }, deployment: "QmcE24" },
  },
});

function watchedAccount() {
  const signed = [];
  const accessed = [];
  const account = new Proxy(
    {
      address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
      signTypedData: async (td) => { signed.push(td); return "0x" + "ab".repeat(65); },
    },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, signed, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

/**
 * /decision・The Graph・売り手・受取人スコアを 1 つの偽 fetch で受ける。
 * `challenge` は 402 本文（object）か、`rawHeader` で生のヘッダ文字列を直接渡す。
 */
function harness({ decision = allowDecision(), decisionStatus = 200, challenge = okChallenge(), rawHeader = null, subgraph = okSubgraph() } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/decision")) {
      return { ok: decisionStatus < 400, status: decisionStatus, json: async () => decision, headers: new Map() };
    }
    if (u.includes("gateway.thegraph.com")) {
      return { ok: true, status: 200, json: async () => subgraph, headers: new Map() };
    }
    if (u.includes("/payees/")) {
      return { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", score: 90, degraded: false, signalsUnavailable: [] }), headers: new Map() };
    }
    if (u.includes("kronos")) {
      const h = init?.headers ?? {};
      const signedHeader = h["PAYMENT-SIGNATURE"] ?? h["X-PAYMENT"];
      if (!signedHeader) {
        const header = rawHeader ?? b64(challenge);
        return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", header]]) };
      }
      return { ok: true, status: 200, json: async () => ({ data: "ok" }), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: "eip155:8453" })]]) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() };
  };
  return { calls, fetch };
}

const base = () => ({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02 });

/** 1 回呼び、結果を { kind, result | error } に畳む。 */
async function run(input) {
  try {
    const result = await payOrRefuse(input);
    return { kind: result.status, result };
  } catch (error) {
    return { kind: "throw", error };
  }
}

function assertVocabulary(outcome, label) {
  const words = outcome.result.decision.reason_codes;
  assert.ok(words.some((w) => VOCAB.has(w)), `${label}: 拒否理由に SDK の語彙が 1 語も無い: ${JSON.stringify(words)}`);
}

function assertCallerError(outcome, label) {
  assert.match(String(outcome.error?.message ?? outcome.error), /^invalid_[a-z_]+:/, `${label}: 呼び出し側エラー以外の throw`);
}

/** money 欄: 署名器 0 回。refused（語彙）か invalid_* の throw。 */
function assertStopped(w, outcome, label) {
  assert.deepEqual(w.signAccesses(), [], `${label}: 署名器に触った（${outcome.kind}）`);
  assert.equal(w.signed.length, 0, `${label}: 署名した`);
  if (outcome.kind === "refused") assertVocabulary(outcome, label);
  else if (outcome.kind === "throw") assertCallerError(outcome, label);
  else assert.fail(`${label}: 止まらなかった（status ${outcome.kind}）`);
}

/** inert 欄: 払ってよいが、署名に載るのは正規の額・宛先・トークンで、認可の窓は上限内。 */
function assertNotLeaked(w, outcome, label) {
  if (outcome.kind === "refused") { assertVocabulary(outcome, label); assert.equal(w.signed.length, 0); return; }
  if (outcome.kind === "throw") { assertCallerError(outcome, label); assert.equal(w.signed.length, 0); return; }
  assert.equal(w.signed.length, 1, `${label}: 署名回数が 1 でない`);
  const td = w.signed[0];
  assert.equal(String(td.message.to).toLowerCase(), PAYEE, `${label}: 宛先が署名に漏れた`);
  assert.equal(td.message.value, "20000", `${label}: 額が署名に漏れた`);
  assert.equal(String(td.domain.verifyingContract).toLowerCase(), USDC.toLowerCase(), `${label}: トークンが署名に漏れた`);
  assert.equal(td.domain.chainId, 8453);
  const window = Number(td.message.validBefore) - Number(td.message.validAfter);
  assert.ok(Number.isInteger(window) && window > 0 && window <= 180, `${label}: 認可の窓が上限外 (${td.message.validBefore} - ${td.message.validAfter})`);
  assert.equal(outcome.result.signed, true);
}

/**
 * 面を 1 つ回す。`fields` は { path, kind: "money" | "inert", allow?: shapeId[] }。
 * `allow` は「その形は正しい形と等価（既定へ落ちる）」と判断した行で、money 欄でも inert の検査で通す。
 */
function sweep({ surface, rows, fields, make }) {
  for (const f of fields) {
    for (const row of rows) {
      const label = `${surface} ${f.path}=${showShape(row)}`;
      test(`${label} → ${f.kind === "money" && !(f.allow ?? []).includes(row.id) ? "署名前に止まる" : "署名に漏れない"}`, async () => {
        const w = watchedAccount();
        const outcome = await run(make(f.path, row.value, w));
        if (f.kind === "money" && !(f.allow ?? []).includes(row.id)) assertStopped(w, outcome, label);
        else assertNotLeaked(w, outcome, label);
      });
    }
  }
}

// ---------- 表そのもの ----------

test("表: 必須の形が全部居る（行を減らす変異はここで死ぬ）", () => {
  const ids = new Set(BROKEN_SHAPES.map((r) => r.id));
  for (const id of REQUIRED_SHAPE_IDS) assert.ok(ids.has(id), `表に ${id} が無い`);
  assert.ok(BROKEN_SHAPES.length >= REQUIRED_SHAPE_IDS.length);
  assert.equal(JSON.parse("1e400"), Infinity, "JSON.parse は 1e400 を Infinity に読む（huge-number 行の根拠）");
});

test("基準値: 壊す前の形は払う（ネガティブコントロール）", async () => {
  const w = watchedAccount();
  const h = harness();
  const outcome = await run({ ...base(), account: w.account, fetch: h.fetch });
  assert.equal(outcome.kind, "paid", JSON.stringify(outcome.result?.decision.reason_codes ?? outcome.error?.message));
  assertNotLeaked(w, outcome, "baseline");
});

// ---------- 面 1: /decision 本文（カタログ内・既定 policy）----------

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
    { path: "facts.l1", kind: "inert" },
    { path: "facts.l1.n_delivered", kind: "inert" },
    { path: "rules_version", kind: "inert" },
    { path: "registry", kind: "inert" },
    { path: "caller_policy", kind: "inert" },
    { path: "caller_policy.verdict", kind: "inert" },
    { path: "caller_policy.reason_codes", kind: "inert" },
    { path: "__unexpected_key", kind: "inert" },
  ],
  make: (path, value, w) => {
    const h = harness({ decision: withShape(allowDecision(), path, value) });
    return { ...base(), account: w.account, fetch: h.fetch };
  },
});

// recommendation の「ALLOW に見える別物」。`String(x) === "ALLOW"` のような緩い照合だと通る形
// （変異 M36 が生き残ったので足した・2026-09-08）。JSON で作れるものだけ。
for (const [label, value] of [
  ["array-ALLOW", ["ALLOW"]],
  ["lowercase", "allow"],
  ["padded", " ALLOW "],
  ["trailing-newline", "ALLOW\n"],
  ["nested-object", { recommendation: "ALLOW" }],
]) {
  test(`/decision recommendation=${label} → 署名前に止まる`, async () => {
    const w = watchedAccount();
    const h = harness({ decision: withShape(allowDecision(), "recommendation", value) });
    const outcome = await run({ ...base(), account: w.account, fetch: h.fetch });
    assertStopped(w, outcome, `recommendation=${label}`);
  });
}

// 床を名指ししたときの n_delivered は money 欄になる（床の比較に使う数）。
sweep({
  surface: "/decision+minL1Deliveries:1",
  rows: JSON_ROWS,
  fields: [{ path: "facts.l1.n_delivered", kind: "money", allow: ["number"] }],
  make: (path, value, w) => {
    const h = harness({ decision: withShape(allowDecision(), path, value) });
    return { ...base(), account: w.account, fetch: h.fetch, policy: { evidence: { minL1Deliveries: 1 } } };
  },
});

// ---------- 面 2: 402 チャレンジ（accept の各欄・accepts・x402Version）----------

sweep({
  surface: "402.accepts[0]",
  rows: JSON_ROWS,
  fields: [
    { path: "accepts.0.amount", kind: "money" },
    { path: "accepts.0.payTo", kind: "money" },
    { path: "accepts.0.asset", kind: "money" },
    { path: "accepts.0.network", kind: "money" },
    { path: "accepts.0.scheme", kind: "money" },
    { path: "accepts.0.extra.assetTransferMethod", kind: "money", allow: ["absent"] },
    { path: "accepts.0.extra.name", kind: "money", allow: ["absent"] },
    { path: "accepts.0.extra.version", kind: "money", allow: ["absent"] },
    { path: "accepts.0.extra", kind: "inert" },
    { path: "accepts.0.maxTimeoutSeconds", kind: "inert" },
    { path: "accepts.0.resource", kind: "inert" },
    { path: "accepts.0.__unexpected_key", kind: "inert" },
    { path: "accepts", kind: "money" },
    { path: "accepts.0", kind: "money" },
    { path: "x402Version", kind: "inert" },
    { path: "resource", kind: "inert" },
  ],
  make: (path, value, w) => {
    const h = harness({ challenge: withShape(okChallenge(), path, value) });
    return { ...base(), account: w.account, fetch: h.fetch };
  },
});

// 402 ヘッダそのものが壊れている（base64 でない・JSON でない・JSON の null）。
for (const [label, rawHeader] of [
  ["not-base64", "%%%not-base64%%%"],
  ["base64-of-non-json", btoa("<html>")],
  ["base64-of-null", b64(null)],
  ["base64-of-array", b64([okAccept()])],
  ["base64-of-string", b64("ALLOW")],
  ["empty", ""],
]) {
  test(`402.header=${label} → 署名前に止まる`, async () => {
    const w = watchedAccount();
    const h = harness({ rawHeader });
    const outcome = await run({ ...base(), account: w.account, fetch: h.fetch });
    assertStopped(w, outcome, `402.header=${label}`);
  });
}

// ---------- 面 3: The Graph subgraph の応答（source: "subgraph"・床 1・鍵あり）----------

const subgraphPolicy = () => ({ evidence: { source: "subgraph", minSubgraphReceipts: 1, graphApiKey: GRAPH_KEY } });

sweep({
  surface: "subgraph",
  rows: JSON_ROWS,
  fields: [
    { path: "data", kind: "money" },
    { path: "data.x402AddressSummaries", kind: "money" },
    { path: "data.x402AddressSummaries.0", kind: "money" },
    { path: "data.x402AddressSummaries.0.totalPayments", kind: "money", allow: ["number"] },
    { path: "data._meta", kind: "money" },
    { path: "data._meta.block", kind: "money" },
    { path: "data._meta.block.number", kind: "money", allow: ["number"] },
    { path: "data._meta.block.timestamp", kind: "inert" },
    { path: "data._meta.deployment", kind: "inert" },
    { path: "errors", kind: "inert" },
    { path: "__unexpected_key", kind: "inert" },
  ],
  make: (path, value, w) => {
    const h = harness({ subgraph: withShape(okSubgraph(), path, value) });
    return { ...base(), account: w.account, fetch: h.fetch, policy: subgraphPolicy() };
  },
});

// ---------- 面 4: 呼び手の policy ----------

sweep({
  surface: "policy",
  rows: ALL_ROWS,
  fields: [
    { path: "maxPerTxUsd", kind: "money", allow: ["absent", "undefined", "number", "fraction"] /* $20000・$0.5 は正しい上限 */ },
    { path: "evidence.minL1Deliveries", kind: "money", allow: ["absent", "undefined", "zero", "fraction"] /* 免除しない床は 0・小数でも有限・非負なら可 */ },
    { path: "evidence.source", kind: "money", allow: ["absent", "undefined", "null"] },
    { path: "evidence", kind: "inert" },
    { path: "evidence.graphApiKey", kind: "inert" },
    { path: "evidence.subgraphId", kind: "inert" },
    { path: "__unexpected_key", kind: "inert" },
  ],
  make: (path, value, w) => {
    const h = harness();
    const policy = withShape({ maxPerTxUsd: 1, evidence: { minL1Deliveries: 1, source: "vet402" } }, path, value);
    return { ...base(), account: w.account, fetch: h.fetch, policy };
  },
});

sweep({
  surface: "policy(source:both)",
  rows: ALL_ROWS,
  fields: [
    { path: "evidence.minSubgraphReceipts", kind: "money", allow: ["absent", "undefined", "zero", "fraction"] },
    { path: "evidence.graphApiKey", kind: "inert" },
    { path: "evidence.subgraphId", kind: "inert" },
  ],
  make: (path, value, w) => {
    const h = harness();
    const policy = withShape({ evidence: { source: "both", minL1Deliveries: 1, minSubgraphReceipts: 1, graphApiKey: GRAPH_KEY } }, path, value);
    return { ...base(), account: w.account, fetch: h.fetch, policy };
  },
});

// requireVet402Allow: WARN の判定・床は満たしている。**リテラルの false 以外は免除にならない**。
sweep({
  surface: "policy(WARN)",
  rows: ALL_ROWS,
  fields: [{ path: "requireVet402Allow", kind: "money", allow: ["boolean-false"] }],
  make: (path, value, w) => {
    const h = harness({ decision: warnDecision() });
    const policy = withShape({ requireVet402Allow: false, evidence: { minL1Deliveries: 1 } }, path, value);
    return { ...base(), account: w.account, fetch: h.fetch, policy };
  },
});

sweep({
  surface: "policy(whole)",
  rows: ALL_ROWS,
  fields: [{ path: "policy", kind: "inert" }],
  make: (path, value, w) => {
    const h = harness();
    return withShape({ ...base(), account: w.account, fetch: h.fetch, policy: { maxPerTxUsd: 1 } }, path, value);
  },
});

// ---------- 面 5: 呼び手の引数 ----------

sweep({
  surface: "input",
  rows: ALL_ROWS,
  fields: [
    { path: "amountUsd", kind: "money", allow: ["fraction"] /* $0.5 の名乗りは 402 の $0.02 を包む正しい値 */ },
    { path: "payee", kind: "money" },
    { path: "resource", kind: "money" },
    { path: "fetch", kind: "money" },
    { path: "method", kind: "inert" },
    { path: "resourceId", kind: "inert" },
    { path: "source", kind: "inert" },
    { path: "apiUrl", kind: "inert" },
    { path: "apiKey", kind: "inert" },
    { path: "__unexpected_key", kind: "inert" },
  ],
  make: (path, value, w) => {
    const h = harness();
    return withShape({ ...base(), account: w.account, fetch: h.fetch, method: "GET", source: "sdk" }, path, value);
  },
});

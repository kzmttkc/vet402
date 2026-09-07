// pay_if_trusted — payOrRefuse を MCP から呼べるようにしたもの（会期中の新規）。
// Day 0 は red のみ。正典は docs/ethonline-2026/WINDOW_PLAN.md §4 の 21。
//
// 既存の check_resource_decision（2026-09-02 出荷・読むだけ）との違いを、テストでも固定する:
// あちらは判定を返し、呼び手が自分で決める。こちらは signer を握り、通らなければ到達させない。
import test from "node:test";
import assert from "node:assert/strict";

// 2026-09-05 訂正（SDK の pay-or-refuse.test.mjs が 09-05 に受けたのと同じ是正）:
// Day 0 は `../src/pay-if-trusted.js` から import していたが、このパッケージは
// rootDir: src / outDir: dist で、`npm test` は `tsc` を通してから test/*.test.mjs を
// 走らせる（package.json）。`src/*.js` は**存在しない**ので、実装を書いても import は
// 必ず失敗し、3本とも永久にスタブへ落ちて緑にならない。既存テスト（decision /
// tool-contract / vouch-client）と同じく dist から読む。
let payIfTrusted;
try {
  ({ payIfTrusted } = await import("../dist/pay-if-trusted.js"));
} catch {
  payIfTrusted = async () => { throw new Error("pay_if_trusted is not implemented yet — Day 0 red"); };
}

const watched = () => {
  const accessed = [];
  const signer = new Proxy({ address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get: (t, p) => (accessed.push(String(p)), Reflect.get(t, p)) });
  return { signer, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
};

test("G21a pay_if_trusted は ALLOW 以外で mock signer への参照が0", async () => {
  const w = watched();
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [] }), headers: new Map() }) });
  assert.equal(r.decision, "REFUSE");
  // 2026-09-05 追加（SDK の A1 が同じ穴で緑になっていた・WINDOW_PLAN §4）:
  // `decision` と signer 参照だけを見ると、**ALLOW ゲートを丸ごと外した実装でも緑になる**。
  // この呼び出しは payee も resource も渡していないので、ゲートを外した実装は
  // `payment_target_unknown` で拒否し、やはり REFUSE・参照0になるからである。
  // 「なぜ拒否したか」まで検査しないと、この1本は配線の証明にならない。
  assert.match(r.refuse_reasons.join(","), /not_allow/, "ALLOW でなかったことが理由");
  // DESIGN §1: 理由はサーバの reason_codes をそのまま返す（我々の語で上書きしない）。
  assert.equal(r.refuse_reasons.includes("l1_not_attempted"), true);
  assert.equal(r.safe_to_pay, false);
  assert.equal(r.nonce, null, "署名が存在しないことの機械可読な印");
  assert.deepEqual(w.signAccesses(), []);
});

// ---- 売り手（WINDOW_PLAN §14・SDK の pay-or-refuse.test.mjs と同じ形）----
//
// 2026-09-05 訂正。Day 0 のこのファイルは ALLOW 経路の応答を
//   { ok: true, json: () => ({ success: true, transaction: "0xtx" }) }（ヘッダ空）
// と書いていた。これは **買い手が facilitator の /settle を叩き、レシートを本文から読む**
// 形で、WINDOW_PLAN §14 が本番実装（l1-runner.ts L977-1045 / x402-payer.ts）との突合で
// 否定したものである。x402 では買い手は facilitator を呼ばない——署名ヘッダを付けて
// 元のリクエストを**売り手へ再送**し、レシートは**応答ヘッダ**から読む。
// SDK は 09-05 にここを是正し、`seller(..., { noReceipt })`（本文にだけ success を書く
// 売り手）で「本文を読む実装」を赤にしている。同じ売り手をここへ写す。
//
// 変えたのは**mock の transport だけ**で、G21b の主張（PAID / attested / 署名参照ちょうど1回）は
// Day 0 のまま。むしろ 402 の壁・payTo 照合・マネーゲート・ヘッダの付与を通らないと
// 緑にならないので、要求は強くなっている。
const b64 = (o) => btoa(JSON.stringify(o));
const GRAPH_PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
const GRAPH_RESOURCE = "https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj";
/** WINDOW_PLAN §3 の実測（$0.01 / Base 正規 USDC / eip3009）。 */
const ACCEPT = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: GRAPH_PAYEE, extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } };

/** 支払いヘッダの有無で答えを変える売り手。「ヘッダを実際に付けたか」がこれで測れる。 */
function seller(accept = ACCEPT) {
  const paid = [];
  const stub = (url, init) => {
    const raw = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
    if (!raw) return { status: 402, body: {}, headers: { "payment-required": b64({ x402Version: 2, accepts: [accept] }) } };
    paid.push({ url, decoded: JSON.parse(atob(raw)) });
    return { status: 200, body: { data: "ok" }, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx", network: ACCEPT.network, payer: "0xDB62BD202914609830fA656F87996b91be3Aa673" }) } };
  };
  return { stub, paid };
}

test("G21b pay_if_trusted は ALLOW で signer を1回だけ呼び attest する", async () => {
  const w = watched();
  const s = seller();
  const calls = [];
  const r = await payIfTrusted({
    resourceId: "a".repeat(64), signer: w.signer, resource: GRAPH_RESOURCE, payee: GRAPH_PAYEE, amountUsd: 0.01,
    method: "POST",
    fetch: async (u, init) => {
      calls.push(String(u));
      if (String(u).includes("decision")) {
        // `degraded: false` はサーバが必ず出す欄（decide.ts）。2026-09-07 から SDK は boolean でない
        // degraded を「測れたと言えない」として止めるので、実形どおりに持たせる（追加1）。
        return { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], facts: {}, evidence: [{ level: "L1", source: "vet402" }], degraded: false }), headers: new Map() };
      }
      const res = String(u).includes("gateway.thegraph.com") ? s.stub(String(u), init) : { status: 200, body: { ok: true }, headers: {} };
      return { ok: res.status < 400, status: res.status, json: async () => res.body, headers: new Map(Object.entries(res.headers ?? {})) };
    },
  });
  assert.equal(r.decision, "PAID");
  assert.equal(r.attested, true);
  assert.equal(w.signAccesses().length, 1);
  // 「0回」が配線ミスでないことの証明（第4層のネガティブコントロール）に加えて、
  // **どこへ出たか**も固定する。買い手の経路に facilitator は存在しない（§14）。
  assert.equal(s.paid.length, 1, "署名ヘッダを付けて売り手へちょうど1回再送している");
  assert.equal(calls.filter((u) => /facilitator|x402\.org|\/settle/.test(u)).length, 0, "facilitator へ出ていない");
  assert.equal(r.settlement, "settle_claimed", "応答ヘッダのレシートは売り手の主張であって settled ではない（§14.1 #5）");
  assert.match(String(r.nonce), /^0x[0-9a-f]{64}$/, "何に署名したかが残る");
});

test("G21c 応答に evidence[].source が入る（審査員が証拠源を目で追える）", async () => {
  const w = watched();
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: [], facts: {}, evidence: [{ level: "L1", source: "subgraph", subgraphId: "Cb56", block: { number: 1 } }] }), headers: new Map() }) });
  assert.ok(r.measurement.evidence.every((e) => typeof e.source === "string"));
  // 2026-09-05 追加: `source` があることだけを見ると、行を作り直して source を
  // "vet402" で埋め直す実装（＝どの台帳を読んだかを消す実装）も緑になる。
  // 賞の証跡要件は「live の subgraph を読んだと**その行が言える**」ことなので、
  // subgraphId と block.number まで落ちていないことを固定する（§2 #3・§15）。
  const ev = r.measurement.evidence[0];
  assert.equal(ev.source, "subgraph", "/decision が言った source をそのまま通す");
  assert.equal(ev.subgraphId, "Cb56");
  assert.equal(ev.block?.number, 1);
  assert.deepEqual(w.signAccesses(), []);
});

// ---- H. 証拠源 policy を MCP から使う（WINDOW_PLAN §3.2・§3.2.1・2026-09-06）----
//
// SDK の `payOrRefuse` は 09-05 に `policy.requireVet402Allow` と `policy.evidence`
// （The Graph subgraph の受領件数の床）を持ったが、MCP ツールは入力に載せていなかった
// （SKILL.md「Not exposed」）。The Graph の Continuity 枠が名指しする「AI 環境からのツール」で
// The Graph のデータが**判定に効く**ためには、ここを通す必要がある。
// 判定ロジックは MCP に写さない——SDK の J 系（J2/J3/J4/J7/J10）と同じ性質を、
// MCP の薄い橋を**通して**固定する。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sanitizeToolError } from "../dist/tool-errors.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

const warnDecision = (over = {}) => ({
  recommendation: "WARN",
  reason_codes: ["l1_not_attempted"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 0, n_attempts: 0 } },
  evidence: [{ level: "L0", source: "vet402", url: "https://vet402.com/observatory/e/x" }],
  degraded: false,
  rules_version: "2026-09-02.1",
  ...over,
});

/** subgraph の応答。`role: RECIPIENT` の受領件数と live の証跡（block）を返す。 */
const graph = (receipts) => ({
  data: {
    x402AddressSummaries: receipts === null ? [] : [{ role: "RECIPIENT", totalPayments: String(receipts) }],
    _meta: { block: { number: 50898704 }, deployment: "Qm" },
  },
});

/**
 * 経路で応答を分ける fetch。subgraph の問い合わせは **POST 本文の query** で見分ける
 * （売り手の 402 も subgraph も gateway.thegraph.com で、URL だけでは分けられない）。
 */
function harness({ decision, receipts, graphStatus = 200 }) {
  const w = watched();
  const s = seller();
  const calls = [];
  const fetch = async (u, init) => {
    const url = String(u);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("/decision")) {
      return { ok: true, status: 200, json: async () => decision, headers: new Map() };
    }
    if (String(init?.body ?? "").includes("x402AddressSummaries")) {
      return { ok: graphStatus < 400, status: graphStatus, json: async () => graph(receipts), headers: new Map() };
    }
    const res = url.includes("gateway.thegraph.com") ? s.stub(url, init) : { status: 200, body: { ok: true }, headers: {} };
    return { ok: res.status < 400, status: res.status, json: async () => res.body, headers: new Map(Object.entries(res.headers ?? {})) };
  };
  return {
    w, s, calls, fetch,
    graphCalls: () => calls.filter((c) => c.body.includes("x402AddressSummaries")),
  };
}

const target = { resourceId: "a".repeat(64), resource: GRAPH_RESOURCE, payee: GRAPH_PAYEE, amountUsd: 0.01, method: "POST" };
const subgraphPolicy = { requireVet402Allow: false, evidence: { source: "subgraph", minSubgraphReceipts: 1 } };

test("H1 requireVet402Allow:false ＋ subgraph の床を満たす → WARN でも払う。署名器はちょうど1回、evidence[] に source:subgraph", async () => {
  const h = harness({ decision: warnDecision(), receipts: 259 });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
  assert.equal(r.safe_to_pay, true);
  assert.equal(h.w.signAccesses().length, 1, "署名器にちょうど1回");
  assert.equal(h.s.paid.length, 1, "署名ヘッダを付けて売り手へ1回再送");
  assert.equal(h.graphCalls().length, 1, "The Graph を実際に1回読んでいる");
  // SDK の決定行（PayDecisionRecord）をそのまま透過する。ここに The Graph の行が載る。
  const rec = r.decision_record;
  assert.ok(rec, "decision_record が無い");
  assert.equal(rec.verdict_source, "caller_policy", "vet402 ではなく呼び手の規則が通した");
  const row = rec.evidence.find((e) => e.source === "subgraph");
  assert.ok(row, `evidence[] に subgraph の行が無い: ${JSON.stringify(rec.evidence)}`);
  assert.equal(row.receipts, 259);
  assert.equal(row.block?.number, 50898704, "live の証跡（block.number）が落ちている");
  assert.equal(rec.policy_override?.rule, "requireVet402Allow:false");
  assert.deepEqual(rec.policy_override?.floors_met, [{ floor: "minSubgraphReceipts", source: "subgraph", required: 1, observed: 259 }]);
  assert.equal(rec.policy_override?.waived?.recommendation, "WARN", "免除した判定を消さない");
  assert.equal(rec.reason_codes.includes("allowed_by_caller_policy"), true);
  // `measurement` は今までどおり /decision の本文そのまま（G21c）。行を混ぜない。
  assert.deepEqual(r.measurement.evidence, warnDecision().evidence);
});

test("H2 同条件で subgraph が 0 件 → 拒否。insufficient_subgraph_evidence・署名器 0 回", async () => {
  const h = harness({ decision: warnDecision(), receipts: 0 });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("insufficient_subgraph_evidence"), true, r.refuse_reasons.join(","));
  assert.equal(r.refuse_reasons.includes("allowed_by_caller_policy"), false);
  // 橋と SDK が同じサーバ理由を持つので、そのまま連結すると l1_not_attempted が2回並ぶ。
  assert.deepEqual(r.refuse_reasons, [...new Set(r.refuse_reasons)], "理由コードが重複している");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
  assert.equal(r.nonce, null);
  // 拒否したときにも、The Graph が何を知っていたかは残る（SDK §3.5 の順序）。
  const row = r.decision_record?.evidence.find((e) => e.source === "subgraph");
  assert.equal(row?.receipts, 0);
});

test("H3 requireVet402Allow:false でも BLOCK は拒否——呼び手の床では外れない（§3.2.1）", async () => {
  const h = harness({ decision: warnDecision({ recommendation: "BLOCK", reason_codes: ["operator_blacklist"] }), receipts: 259 });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("payee_recommendation_block"), true, r.refuse_reasons.join(","));
  assert.equal(r.refuse_reasons.includes("allowed_by_caller_policy"), false, "BLOCK を呼び手の policy で通したと記録しない");
  assert.equal(r.refuse_reasons.includes("operator_blacklist"), true, "サーバの理由をそのまま通す");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("H4 requireVet402Allow:false でも degraded は拒否——測れなかったことは床で埋めない", async () => {
  const h = harness({ decision: warnDecision({ degraded: true }), receipts: 259 });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("evidence_unavailable"), true, r.refuse_reasons.join(","));
  assert.equal(r.refuse_reasons.includes("allowed_by_caller_policy"), false);
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
});

test("H5 source:subgraph で Graph の鍵が無い → 通信の前に拒否。理由は機械可読、黙って vet402 だけで判定しない", async () => {
  const h = harness({ decision: warnDecision({ recommendation: "ALLOW", reason_codes: ["l0_pass"] }), receipts: 259 });
  for (const policy of [subgraphPolicy, { evidence: { source: "both", minSubgraphReceipts: 1 } }]) {
    const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, policy });
    assert.equal(r.decision, "REFUSE");
    assert.equal(r.refuse_reasons.includes("graph_key_not_configured"), true, r.refuse_reasons.join(","));
    assert.equal(r.refuse_reasons.includes("subgraph_evidence_unavailable"), true);
    assert.equal(r.refuse_reasons.includes("evidence_unavailable"), true);
    assert.match(r.summary, /GRAPH_API_KEY/, "どこに置けば直るかを言う");
  }
  assert.equal(h.calls.length, 0, "鍵が無いと分かっているのに外へ出ない（/decision も引かない）");
  assert.deepEqual(h.w.signAccesses(), []);
});

test("H6 requireVet402Allow:false で床が1つも無い → invalid_policy（呼び出し側エラー・通信の前）", async () => {
  const h = harness({ decision: warnDecision(), receipts: 259 });
  for (const policy of [
    { requireVet402Allow: false },
    { requireVet402Allow: false, evidence: { source: "subgraph" } },
    { requireVet402Allow: false, evidence: { source: "subgraph", minSubgraphReceipts: 0 } },
  ]) {
    await assert.rejects(
      () => payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy }),
      /^Error: invalid_policy/,
    );
  }
  // 評価されない床も呼び出し側エラー（SDK の `invalid_evidence_policy` と同じ）。
  await assert.rejects(
    () => payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, policy: { evidence: { minSubgraphReceipts: 1 } } }),
    /^Error: invalid_evidence_policy/,
  );
  assert.equal(h.calls.length, 0, "呼び出し側の誤りは通信の前に落ちる");
  assert.deepEqual(h.w.signAccesses(), []);
  // MCP の境界でも語が残る（sanitizeToolError が request_failed に潰さない）。
  assert.match(sanitizeToolError(new Error("invalid_policy: requireVet402Allow: false waives …")), /^invalid_policy/);
  assert.match(sanitizeToolError(new Error("invalid_evidence_policy: minSubgraphReceipts needs …")), /^invalid_evidence_policy/);
});

test("H7 tools/list の inputSchema に policy が載る。Graph の鍵はツール入力に**載せない**", async () => {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  const child = spawn(process.execPath, [join(PKG, "dist/index.js")], { env: { ...process.env, VOUCH_API_KEY: "dummy" }, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const list = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tools/list timed out")), 10_000);
    child.stdout.on("data", () => {
      for (const line of out.split("\n")) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) { clearTimeout(timer); resolve(msg.result); }
        } catch { /* partial line */ }
      }
    });
  }).finally(() => child.kill());
  const tool = list.tools.find((t) => t.name === "pay_if_trusted");
  assert.ok(tool, "pay_if_trusted が無い");
  const policy = tool.inputSchema.properties.policy;
  assert.ok(policy, `inputSchema に policy が無い: ${Object.keys(tool.inputSchema.properties).join(",")}`);
  assert.ok(policy.properties.requireVet402Allow, "policy.requireVet402Allow が無い");
  const ev = policy.properties.evidence?.properties;
  assert.ok(ev, "policy.evidence が無い");
  assert.deepEqual(ev.source.enum, ["vet402", "subgraph", "both"]);
  assert.ok(ev.minL1Deliveries && ev.minSubgraphReceipts, "床が無い");
  assert.equal(ev.graphApiKey, undefined, "鍵をツール入力に載せない（LLM の文脈に鍵を通さない）");
  assert.equal(JSON.stringify(tool.inputSchema).includes("graphApiKey"), false);
  assert.match(tool.description, /GRAPH_API_KEY/, "鍵の置き場所を説明文で言う");
});

// ---- H8–H12. カタログ外の売り手（/decision 404 not_found）を MCP から SDK の I23 経路へ落とす（WINDOW_PLAN §3.1・§4 I23・2026-09-06）----
//
// デモの支払い先 The Graph 本体はカタログに無く、`/decision` は 404 を返す（§3.1 実測）。
// SDK の `payOrRefuse` は 09-05 からこの 404 を「402 の payTo ＋ 受取人スコア ＋ 宣言された床」で
// 判定できる（I23）が、MCP の前段は 404 を一律 `evidence_unavailable` で止めていた
// （SKILL.md「The uncatalogued-seller path in MCP: Not exposed」）。つまり **MCP から The Graph に
// 払う道は無かった**。ここでは「`resource`（402 を返す URL）が与えられているときだけ」
// 404 を SDK へ通し、境界（payTo 照合・BLOCK・床）は SDK が持つものを橋越しに固定する。
const NOT_FOUND = { error: "not_found" };
/** 2026-09-04 実測の受取人スコア応答（SDK の I23 と同じ形。recommendation / score だけ差し替える）。 */
const payeeScore = (over = {}) => ({
  payee: GRAPH_PAYEE.toLowerCase(),
  score: 69,
  recommendation: "WARN",
  dataDepth: "thin",
  degraded: false,
  signalsUnavailable: [],
  signals: { receiving: { paymentCount: 0, distinctPayers: 0, l1DeliveryCount: 0 } },
  scoredAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  ...over,
});

/** カタログ外のハーネス。/decision は 404、/payees/{addr}/score は `score`、subgraph と売り手は harness と同じ。 */
function uncataloguedHarness({ score, receipts, accept = ACCEPT }) {
  const w = watched();
  const s = seller(accept);
  const calls = [];
  const fetch = async (u, init) => {
    const url = String(u);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("/decision")) {
      return { ok: false, status: 404, json: async () => NOT_FOUND, headers: new Map() };
    }
    if (url.includes("/score")) {
      return { ok: true, status: 200, json: async () => score, headers: new Map() };
    }
    if (String(init?.body ?? "").includes("x402AddressSummaries")) {
      return { ok: true, status: 200, json: async () => graph(receipts), headers: new Map() };
    }
    const res = url.includes("gateway.thegraph.com") ? s.stub(url, init) : { status: 200, body: { ok: true }, headers: {} };
    return { ok: res.status < 400, status: res.status, json: async () => res.body, headers: new Map(Object.entries(res.headers ?? {})) };
  };
  return {
    w, s, calls, fetch,
    scoreCalls: () => calls.filter((c) => c.url.includes("/score")),
    graphCalls: () => calls.filter((c) => c.body.includes("x402AddressSummaries")),
  };
}

test("H8 /decision 404 ＋ resource あり ＋ 受取人スコア WARN ＋ requireVet402Allow:false ＋ subgraph 259 件 → 払う。署名器ちょうど1回・verdict_source caller_policy・evidence[] に subgraph", async () => {
  const h = uncataloguedHarness({ score: payeeScore(), receipts: 259 });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
  assert.equal(r.safe_to_pay, true);
  assert.equal(h.w.signAccesses().length, 1, "署名器にちょうど1回");
  assert.equal(h.s.paid.length, 1, "署名ヘッダを付けて売り手へ1回再送");
  assert.equal(h.scoreCalls().length, 1, "受取人スコアを実際に1回引いている（404 を ALLOW 扱いした実装は緑にしない）");
  assert.equal(h.graphCalls().length, 1, "The Graph を実際に1回読んでいる");
  const rec = r.decision_record;
  assert.ok(rec, "decision_record が無い");
  assert.equal(rec.verdict_source, "caller_policy", "vet402 ではなく呼び手の規則が通した");
  assert.equal(rec.reason_codes.includes("resource_uncatalogued"), true, "404 経路であることが機械可読で残る");
  assert.equal(rec.reason_codes.includes("allowed_by_caller_policy"), true);
  const row = rec.evidence.find((e) => e.source === "subgraph");
  assert.ok(row, `evidence[] に subgraph の行が無い: ${JSON.stringify(rec.evidence)}`);
  assert.equal(row.receipts, 259);
  assert.equal(row.block?.number, 50898704, "live の証跡（block.number）が落ちている");
  assert.equal(rec.policy_override?.waived?.source, "payee_score", "免除したのは受取人スコアの WARN");
  assert.equal(rec.policy_override?.waived?.recommendation, "WARN");
  assert.deepEqual(rec.policy_override?.floors_met, [{ floor: "minSubgraphReceipts", source: "subgraph", required: 1, observed: 259 }]);
  // measurement は /decision の本文そのまま。404 の本文に判定は無いので空。
  assert.equal(r.measurement.recommendation, null);
});

test("H9 同条件で subgraph 0 件 → 拒否。insufficient_subgraph_evidence・署名器 0 回", async () => {
  const h = uncataloguedHarness({ score: payeeScore(), receipts: 0 });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("insufficient_subgraph_evidence"), true, r.refuse_reasons.join(","));
  assert.equal(r.refuse_reasons.includes("resource_uncatalogued"), true);
  assert.equal(r.refuse_reasons.includes("allowed_by_caller_policy"), false);
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
  assert.equal(r.nonce, null);
  assert.equal(r.decision_record?.evidence.find((e) => e.source === "subgraph")?.receipts, 0, "拒否しても The Graph が何を知っていたかは残る");
});

test("H10 /decision 404 ＋ 受取人スコア BLOCK → requireVet402Allow:false でも拒否・署名器 0 回（§3.2.1 はカタログ外でも同じ）", async () => {
  const h = uncataloguedHarness({ score: payeeScore({ recommendation: "BLOCK", score: 5 }), receipts: 259 });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("payee_recommendation_block"), true, r.refuse_reasons.join(","));
  assert.equal(r.refuse_reasons.includes("allowed_by_caller_policy"), false, "BLOCK を呼び手の policy で通したと記録しない");
  assert.equal(h.scoreCalls().length, 1, "スコアを実際に引いて BLOCK を見た");
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
  assert.equal(r.decision_record?.verdict_source, "payee_score");
});

test("H11 /decision 404 ＋ resource 無し → evidence_unavailable。通信は /decision の1回だけ", async () => {
  const h = uncataloguedHarness({ score: payeeScore(), receipts: 259 });
  const r = await payIfTrusted({ resourceId: target.resourceId, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("evidence_unavailable"), true, r.refuse_reasons.join(","));
  assert.equal(h.calls.length, 1, `通信が /decision の1回で止まっていない: ${h.calls.map((c) => c.url).join(" | ")}`);
  assert.match(h.calls[0].url, /\/decision/);
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(r.decision_record, null, "SDK に到達していない");
});

test("H12 /decision 404 ＋ 402 の payTo が payee と不一致 → 拒否（A4）・署名器 0 回", async () => {
  const OTHER = "0x36038e1D712c5e39f35952164EC58EC2B96cAeE7";
  const h = uncataloguedHarness({ score: payeeScore({ recommendation: "ALLOW", score: 80 }), receipts: 259, accept: { ...ACCEPT, payTo: OTHER } });
  const r = await payIfTrusted({ ...target, signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32), policy: subgraphPolicy });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("payee_mismatch"), true, r.refuse_reasons.join(","));
  assert.equal(r.refuse_reasons.includes("resource_uncatalogued"), true);
  assert.deepEqual(h.w.signAccesses(), []);
  assert.equal(h.s.paid.length, 0);
  assert.equal(r.nonce, null);
});

// ---- K1–K4. 鍵なしで /decision を読む（2026-09-07・commit 3738890 の鍵なし枠に追随）----
//
// 本番 `/decision` は Authorization 無しでも答える（IP ごと 10/分・超過は 429 `rate_limited`）。
// 審査員が `GRAPH_API_KEY` 1 本で SKILL.md を歩けるように、`check_resource_decision` と
// `pay_if_trusted` は `VOUCH_API_KEY` 未設定でも `missing_api_key` で止まらず、鍵なしで読む。
// 429 は既存の失敗形式（REFUSE・safe_to_pay false）のまま、理由コードにサーバの語 `rate_limited`。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

test("K1 pay_if_trusted: apiKey 無しでも /decision を読み、Authorization ヘッダを付けない（`Bearer undefined` にしない）", async () => {
  const w = watched();
  const calls = [];
  const r = await payIfTrusted({
    resourceId: "a".repeat(64),
    signer: w.signer,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return { ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [], rules_version: "t", degraded: false }), headers: new Map() };
    },
  });
  assert.equal(calls.length, 1, "鍵なしでも /decision は 1 回読まれる");
  assert.equal("Authorization" in calls[0].headers, false, JSON.stringify(calls[0].headers));
  assert.equal(JSON.stringify(calls[0].headers).includes("undefined"), false);
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.refuse_reasons.includes("payee_recommendation_not_allow"), true, r.refuse_reasons.join(","));
  assert.deepEqual(w.signAccesses(), []);
});

test("K2 pay_if_trusted: 429 rate_limited は REFUSE のまま、理由にサーバの語 `rate_limited` を含む", async () => {
  const w = watched();
  const r = await payIfTrusted({
    resourceId: "a".repeat(64),
    signer: w.signer,
    fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: "rate_limited" }), headers: new Map() }),
  });
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.safe_to_pay, false);
  assert.equal(r.refuse_reasons.includes("evidence_unavailable"), true, r.refuse_reasons.join(","));
  assert.equal(r.refuse_reasons.includes("rate_limited"), true, r.refuse_reasons.join(","));
  assert.match(r.summary, /rate_limited|rate limit/i);
  assert.equal(r.nonce, null);
  assert.deepEqual(w.signAccesses(), []);
});

test("K3 index.ts は VOUCH_API_KEY 未設定を missing_api_key で先回りして止めない", () => {
  const src = readFileSync(join(PKG, "src/index.ts"), "utf8");
  assert.equal(src.includes('throw new Error("missing_api_key")'), false, "鍵なしを MCP 側で先回りして止めている");
});

/** MCP サーバを子プロセスで起動し、ローカル HTTP を本番 API の代わりに向けて 1 ツールを呼ぶ。 */
async function callToolKeyless(handler, toolName, args) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization ?? null });
    const { status, body } = handler(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const env = { ...process.env, VOUCH_API_URL: `http://127.0.0.1:${port}/api/v1` };
  delete env.VOUCH_API_KEY;
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args } },
  ];
  const child = spawn(process.execPath, [join(PKG, "dist/index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tools/call timed out\n${err}`)), 15_000);
      child.stdout.on("data", () => {
        for (const line of out.split("\n")) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === 2) { clearTimeout(timer); resolve(msg.result); }
          } catch { /* partial line */ }
        }
      });
    });
    return { result, seen, text: JSON.parse(result.content[0].text) };
  } finally {
    child.kill();
    server.close();
  }
}

test("K4 実プロセス: VOUCH_API_KEY 無しの check_resource_decision が /decision 200 を読み、ヘッダ無しで届く", async () => {
  const body = { recommendation: "ALLOW", reason_codes: [], facts: {}, evidence: [], rules_version: "t", degraded: false };
  const { result, seen, text } = await callToolKeyless(() => ({ status: 200, body }), "check_resource_decision", { resourceId: "a".repeat(64) });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(text.decision, "ALLOW_PAY");
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/resources\/a{64}\/decision\?role=payer/);
  assert.equal(seen[0].authorization, null, "鍵なしなのに Authorization が付いた");
});

test("K5 実プロセス: 鍵なし枠の 429 は REFUSE・isError・理由コード rate_limited", async () => {
  const { result, text } = await callToolKeyless(() => ({ status: 429, body: { error: "rate_limited" } }), "check_resource_decision", { resourceId: "a".repeat(64) });
  assert.equal(result.isError, true);
  assert.equal(text.decision, "REFUSE");
  assert.equal(text.safe_to_pay, false);
  assert.equal(text.refuse_reasons.includes("rate_limited"), true, text.refuse_reasons.join(","));
});

test("K6 実プロセス: 鍵なしの pay_if_trusted も missing_api_key で止まらず /decision を読む", async () => {
  const body = { recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [], rules_version: "t", degraded: false };
  const { result, seen, text } = await callToolKeyless(() => ({ status: 200, body }), "pay_if_trusted", { resourceId: "a".repeat(64) });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(text.decision, "REFUSE");
  assert.equal(text.refuse_reasons.includes("payee_recommendation_not_allow"), true, text.refuse_reasons.join(","));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, null);
});

// ---- 呼び手の policy を /decision に渡し、サーバの policy 語を透過する（WINDOW_PLAN §16.3・2026-09-07）----
//
// §16.3 の実 A/B で、上限超え（F4）の正解 `price_above_ceiling` は**どのツールも返さなかった**。
// ここで固定するのは「橋が /decision に amount_usd 等を渡す」「返ってきた caller_policy を
// measurement にそのまま載せる」「その verdict が REFUSE なら、その語で止める」の 3 つ。
test("P1 pay_if_trusted は amountUsd / maxPerTxUsd / minL1Deliveries を /decision のクエリに載せる", async () => {
  const w = watched();
  const urls = [];
  await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer, amountUsd: 0.02, maxPerTxUsd: 0.5, policy: { evidence: { source: "vet402", minL1Deliveries: 2 } },
    fetch: async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: [], facts: {}, evidence: [] }), headers: new Map() }; } });
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get("amount_usd"), "0.02");
  assert.equal(q.get("max_per_tx_usd"), "0.5");
  assert.equal(q.get("min_l1_deliveries"), "2");
  assert.deepEqual(w.signAccesses(), []);
});

test("P2 サーバの caller_policy は measurement にそのまま載り、REFUSE ならその語で止める（signer 参照 0）", async () => {
  const w = watched();
  const callerPolicy = { applied: { amount_usd: 5, max_per_tx_usd: 1, min_l1_deliveries: 0 }, verdict: "REFUSE", reason_codes: ["price_above_ceiling"], not_evaluated: ["min_subgraph_receipts"] };
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer, amountUsd: 5,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], facts: {}, evidence: [], caller_policy: callerPolicy }), headers: new Map() }) });
  assert.equal(r.decision, "REFUSE");
  assert.deepEqual(r.measurement.caller_policy, callerPolicy, "組み替えずに透過する");
  assert.ok(r.refuse_reasons.includes("price_above_ceiling"), "サーバの policy 語がそのまま理由になる");
  assert.ok(r.refuse_reasons.includes("l1_delivered"), "サーバの reason_codes も従来どおり残る");
  assert.deepEqual(w.signAccesses(), []);
});

test("P3 caller_policy が無い応答では measurement.caller_policy は null（無いものを作らない）", async () => {
  const w = watched();
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [] }), headers: new Map() }) });
  assert.equal(r.measurement.caller_policy, null);
});

// ---- require_vet402_allow を透過する（2026-09-07・後段）。SDK の既定（WARN は拒否）を HTTP でも鏡写しにした
// サーバに対し、橋は自分の policy.requireVet402Allow をそのまま渡す。免除（false）はサーバが当てられる
// 床（L1 ≥1）を一緒に送るときだけ宣言する——subgraph だけの床は サーバでは代わりにならず 400 になる。
test("P4 pay_if_trusted の既定は require_vet402_allow=true を送る（SDK の既定と同じ）", async () => {
  const w = watched();
  const urls = [];
  await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer, amountUsd: 0.02,
    fetch: async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", reason_codes: [], facts: {}, evidence: [] }), headers: new Map() }; } });
  assert.equal(new URL(urls[0]).searchParams.get("require_vet402_allow"), "true");
});

test("P5 requireVet402Allow:false ＋ L1 の床 → require_vet402_allow=false と min_l1_deliveries を一緒に送る", async () => {
  const w = watched();
  const urls = [];
  await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer, amountUsd: 0.02, policy: { requireVet402Allow: false, evidence: { source: "vet402", minL1Deliveries: 3 } },
    fetch: async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", reason_codes: [], facts: {}, evidence: [] }), headers: new Map() }; } });
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get("require_vet402_allow"), "false");
  assert.equal(q.get("min_l1_deliveries"), "3");
});

test("P6 requireVet402Allow:false の根拠が subgraph の床だけ → サーバへ false を送らず、サーバの payee_recommendation_not_allow だけでは第 3.1 段で止めない（床は SDK の段が当てる）", async () => {
  const w = watched();
  const urls = [];
  const callerPolicy = { applied: { amount_usd: 0.02, max_per_tx_usd: 1, min_l1_deliveries: 0, require_vet402_allow: true }, verdict: "REFUSE", reason_codes: ["payee_recommendation_not_allow"], not_evaluated: ["min_subgraph_receipts"] };
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer, amountUsd: 0.02, graphApiKey: "k".repeat(32),
    policy: { requireVet402Allow: false, evidence: { source: "subgraph", minSubgraphReceipts: 1 } },
    fetch: async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [], caller_policy: callerPolicy }), headers: new Map() }; } });
  assert.equal(new URL(urls[0]).searchParams.get("require_vet402_allow"), null, "サーバが当てられない免除は宣言しない");
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("payment_target_unknown"), `3.1 で止まらず支払い先の段まで進む: ${r.refuse_reasons.join(",")}`);
  assert.deepEqual(r.measurement.caller_policy, callerPolicy, "サーバの応答はそのまま透過する");
  assert.deepEqual(w.signAccesses(), []);
});

test("P7 requireVet402Allow:false ＋ L1 の床なのにサーバが別の語（price_above_ceiling）で REFUSE → 第 3.1 段でその語で止まる（免除は WARN だけ）", async () => {
  const w = watched();
  const callerPolicy = { applied: { amount_usd: 5, max_per_tx_usd: 1, min_l1_deliveries: 3, require_vet402_allow: false }, verdict: "REFUSE", reason_codes: ["price_above_ceiling"], not_evaluated: ["min_subgraph_receipts"] };
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer, amountUsd: 5, policy: { requireVet402Allow: false, evidence: { source: "vet402", minL1Deliveries: 3 } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [], caller_policy: callerPolicy }), headers: new Map() }) });
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("price_above_ceiling"));
  assert.equal(r.refuse_reasons.includes("payment_target_unknown"), false, "3.1 で止まっている");
});

test("K7 実プロセス: check_resource_decision は requireVet402Allow を require_vet402_allow に透過する", async () => {
  const body = { recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [], rules_version: "t", degraded: false,
    caller_policy: { applied: { amount_usd: 0.02, max_per_tx_usd: 1, min_l1_deliveries: 1, require_vet402_allow: false }, verdict: "ALLOW", reason_codes: [], not_evaluated: ["min_subgraph_receipts"] } };
  const { seen, text } = await callToolKeyless(() => ({ status: 200, body }), "check_resource_decision", { resourceId: "a".repeat(64), amountUsd: 0.02, minL1Deliveries: 1, requireVet402Allow: false });
  const q = new URL(seen[0].url, "http://x").searchParams;
  assert.equal(q.get("require_vet402_allow"), "false");
  assert.equal(q.get("min_l1_deliveries"), "1");
  assert.deepEqual(text.measurement.caller_policy, body.caller_policy, "透過");
});

// ---- D4（2026-09-07 第三者監査 D4 ＋ 追加2）: resource 無しは第 4 段で止まり、床も The Graph も評価されない ----
//
// SKILL.md（:271-272）と index.ts のツール説明は「payer が無くても関門を最後まで走らせる」と言っていたが、
// 実装は resource / payee / amountUsd が無いと第 4 段（payment_target_unknown）で返り、subgraph の読みと
// 床の評価（どちらも SDK の payOrRefuse の中）には進まない。**実装を正**とし、文書を実装に合わせる。
// このテストはその境界を固定する: 変えるなら文書とこのテストを一緒に動かすこと。
test("D4 resource 無し ＋ source:subgraph ＋ 鍵あり ＋ ALLOW → payment_target_unknown で止まり、The Graph は読まない・decision_record は null", async () => {
  const h = harness({ decision: warnDecision({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"] }), receipts: 259 });
  const r = await payIfTrusted({
    resourceId: "a".repeat(64), signer: h.w.signer, fetch: h.fetch, graphApiKey: "k".repeat(32),
    policy: { evidence: { source: "subgraph", minSubgraphReceipts: 1 } },
  });
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("payment_target_unknown"), r.refuse_reasons.join(","));
  assert.equal(h.graphCalls().length, 0, "床の評価（The Graph の読み）は SDK の段にあり、ここには来ない");
  assert.equal(r.decision_record, null, "payOrRefuse に到達していない");
  assert.equal(r.measurement.recommendation, "ALLOW", "判定そのものは返す");
  assert.deepEqual(h.w.signAccesses(), []);
});

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
function seller() {
  const paid = [];
  const stub = (url, init) => {
    const raw = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
    if (!raw) return { status: 402, body: {}, headers: { "payment-required": b64({ x402Version: 2, accepts: [ACCEPT] }) } };
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
        return { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], facts: {}, evidence: [{ level: "L1", source: "vet402" }] }), headers: new Map() };
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

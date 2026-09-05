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

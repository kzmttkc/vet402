// **予告した関門と、実際に効く関門が、同じ答えを出すこと。**
//
// この画には関門が3本ある。
//   A = `assess.ts` の関門表        —— `pay` 空撃ちの画（`predicted` 行）
//   B = `judge.ts` の dryRunVerdict —— 審査員が自分の URL で見る verdict 行
//   C = `packages/sdk` の payOrRefuse —— **拘束力を持つ本物**
//
// A と B は C を写経した別実装で、2026-09-08 の第三者監査が 78 マスを歩いて
// **A≠C 28 マス / B≠C 25 マス**を実測した（`/decision` の HTTP 429 で A が
// 「would sign and send」と予告し、C は REFUSE する等）。予告が外れる画は
// 動画の嘘になるので、ここで**3本が同じ答えを出すことを世界ごとに固定する**。
//
// 期待値は表に書かない。**C を毎回その場で走らせて、その答えを期待値にする**
// （正典を2つにしない／`gates-hold-forbidden-shapes-not-correct-answers`）。
// C が変われば A と B も追随しなければ、このテストが赤くなる。
//
// fetch は全部偽物、account は Proxy スタブ。ネットワークにも本番にも触れない。
import test from "node:test";
import assert from "node:assert/strict";
import { runPay, PAY_TARGET, PAY_POLICY } from "../src/pay.ts";
import { runJudge, parseJudgeArgs } from "../src/judge.ts";
import { assess } from "../src/assess.ts";
import { instrument, probeChallenge } from "../src/probe.ts";
import { renderPayDryRun } from "../src/render.ts";
import { createEmitter } from "../src/emit.ts";
import { payOrRefuse } from "../../../packages/sdk/dist/index.js";

const PAYER = "0xDB62BD202914609830fA656F87996b91be3Aa673";
const PAYEE = PAY_TARGET.payee;
const URL_ = PAY_TARGET.url;

const ENV = {
  GRAPH_API_KEY: "graphkey-0123456789",
  VOUCH_API_KEY: "vouchkey-0123456789",
  DEMO_PAYER_PRIVATE_KEY: "0x" + "cd".repeat(32),
};

/** 署名器への「参照」を数える Proxy（`pay.test.mjs` と同じ第1層）。 */
function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: PAYER, signTypedData: async () => "0x" + "11".repeat(65) },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAYEE,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
};

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

const SUB_OK = {
  data: {
    _meta: { block: { number: 50890586, timestamp: 1788570519 }, deployment: "QmDemoDeployment0000000000000000000000000000000" },
    x402AddressSummaries: [
      { role: "RECIPIENT", totalPayments: "253", totalVolumeDecimal: "2.53", firstPaymentTimestamp: "1", lastPaymentTimestamp: "2" },
    ],
  },
};

/**
 * 壊れた形を注入する偽 fetch。`world` は面ごとの指定:
 *   `decision` / `score` … `{status, body}` | `{throw:true}` | `{status, badJson:true}`
 *   `subgraph` … 同上、`accepts` … 402 が返す accept 配列、`no402` … 402 を返さない
 */
function makeFetch(world = {}) {
  const calls = [];
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Map(Object.entries(headers)),
  });
  const shaped = (spec, dflt) => {
    if (spec === undefined) return dflt;
    if (spec.throw) throw new Error("boom: connection reset");
    if (spec.badJson) {
      return {
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        json: async () => { throw new SyntaxError("Unexpected token"); },
        text: async () => "<html>",
        headers: new Map(),
      };
    }
    return reply(spec.status, spec.body);
  };
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.includes("/decision")) return shaped(world.decision, reply(404, { error: "not_found" }));
    if (u.includes("gateway.thegraph.com") && !u.includes("/api/x402/")) {
      if (world.subgraph?.throw) throw new Error("boom");
      return reply(world.subgraph?.status ?? 200, world.subgraph?.body ?? SUB_OK);
    }
    if (u.includes("/payees/")) {
      return shaped(world.score, reply(200, { payee: PAYEE, degraded: false, signalsUnavailable: [], score: 90, recommendation: "ALLOW" }));
    }
    if (u.includes("/payments/x402")) return reply(200, { ok: true });
    const paid = init?.headers && Object.keys(init.headers).some((k) => k.toUpperCase() === "PAYMENT-SIGNATURE");
    if (paid) {
      return reply(200, { ok: true }, {
        "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: PAYER }),
      });
    }
    if (world.no402) return reply(500, {});
    return reply(402, {}, { "payment-required": b64({ x402Version: 2, accepts: world.accepts ?? [ACCEPT] }) });
  };
  return { fetch, calls };
}

/**
 * **床を上げた世界の A。** `runPay` は `PAY_POLICY` を持ち回りで固定していて、規則を
 * 差し替える引数を持たない——持たせれば「画に出した規則と本当に効いた規則」が別物になり得る
 * （`pay.ts` の設計理由そのもの）。なので床を振る世界だけ、`pay` が使うのと同じ `assess` +
 * `renderPayDryRun` を直に呼ぶ。**予告の判定規則はここに写さず、`render` の出した行を読む。**
 *
 * `assess` には署名の経路が1行も無い（`payOrRefuse` を import すらしない）ので、
 * この道では署名器を Proxy で見張る意味がない——`signed` は常に false。
 */
async function runAWithFloor(world, minL1Deliveries) {
  const net = instrument(makeFetch(world).fetch);
  const probe = await probeChallenge(net.fetch, PAY_TARGET.method, PAY_TARGET.url, PAY_TARGET.body);
  const { view } = await assess({
    target: {
      method: PAY_TARGET.method,
      url: PAY_TARGET.url,
      body: PAY_TARGET.body,
      expectedPayee: PAY_TARGET.payee,
      ceilingUsd: PAY_TARGET.amountUsd,
    },
    policy: { requireVet402Allow: PAY_POLICY.requireVet402Allow, evidence: { ...PAY_POLICY.evidence, minL1Deliveries } },
    env: ENV,
    net,
    probe,
    envNames: ["GRAPH_API_KEY", "VOUCH_API_KEY"],
    mode: "pay",
    live: false,
  });
  const screen = renderPayDryRun(view, { color: false }).join("\n");
  const m = screen.match(/predicted\s+(--live would [\s\S]*?)(?=\n\s*-{5,})/);
  const predicted = m ? m[1].replace(/\n\s+/g, " ").trim() : "(no predicted line)";
  return {
    signal: /would sign and send/.test(predicted) ? "SIGN" : /would REFUSE/.test(predicted) ? "REFUSE" : "?",
    predicted,
    screen,
    gates: view.gates,
    signed: false,
  };
}

/** A: `pay` 空撃ち。画の `predicted` 行が SIGN と言うか REFUSE と言うか。 */
async function runA(world, floor) {
  if (floor !== undefined) return runAWithFloor(world, floor);
  const out = [];
  const f = makeFetch(world);
  const w = watchedAccount();
  try {
    const { view } = await runPay({
      live: false, env: ENV, fetch: f.fetch, account: w.account,
      emit: createEmitter({ sink: (l) => out.push(l), secrets: [] }),
    });
    const text = out.join("\n");
    const m = text.match(/predicted\s+(--live would [\s\S]*?)(?=\n\s*-{5,})/);
    const predicted = m ? m[1].replace(/\n\s+/g, " ").trim() : "(no predicted line)";
    return {
      signal: /would sign and send/.test(predicted) ? "SIGN" : /would REFUSE/.test(predicted) ? "REFUSE" : "?",
      predicted,
      screen: text,
      gates: view.gates,
      signed: w.signAccesses().length > 0,
    };
  } catch (error) {
    return { signal: "THROW", predicted: String(error.message).slice(0, 160), screen: out.join("\n"), gates: [], signed: w.signAccesses().length > 0, error };
  }
}

/** B: `judge` の署名なし判定。`pay` と同じ policy に揃える。 */
async function runB(world, extraArgs = []) {
  const out = [];
  const f = makeFetch(world);
  try {
    const args = parseJudgeArgs([
      URL_, "--method", "POST", "--body", PAY_TARGET.body, "--policy", "both",
      "--min-subgraph-receipts", "1", "--min-l1-deliveries", "0", "--ceiling-usd", "0.01", ...extraArgs,
    ]);
    const { verdict } = await runJudge({ ...args, env: ENV, fetch: f.fetch, emit: createEmitter({ sink: (l) => out.push(l), secrets: [] }) });
    return {
      signal: verdict.verdict === "ALLOW" ? "SIGN" : "REFUSE",
      reasons: verdict.reasonCodes.join(","),
      source: verdict.verdictSource,
      screen: out.join("\n"),
    };
  } catch (error) {
    return { signal: "THROW", reasons: String(error.message).slice(0, 200), source: "-", screen: out.join("\n"), error };
  }
}

/** C: 拘束力を持つ関門。偽 fetch + Proxy account なので、ネットも金も動かない。 */
async function runC(world, floor) {
  const f = makeFetch(world);
  const w = watchedAccount();
  const r = await payOrRefuse({
    payee: PAYEE, resource: URL_, method: "POST", amountUsd: PAY_TARGET.amountUsd,
    account: w.account, fetch: f.fetch, apiKey: ENV.VOUCH_API_KEY, source: "gate-parity-test",
    policy: {
      maxPerTxUsd: PAY_TARGET.amountUsd,
      requireVet402Allow: PAY_POLICY.requireVet402Allow,
      evidence: {
        ...PAY_POLICY.evidence,
        ...(floor === undefined ? {} : { minL1Deliveries: floor }),
        graphApiKey: ENV.GRAPH_API_KEY,
      },
    },
  });
  const signed = w.signAccesses().length > 0;
  return {
    signal: signed ? "SIGN" : "REFUSE",
    status: r.status,
    reasons: (r.decision.reason_codes || []).join(","),
    source: r.decision.verdict_source,
    signed,
  };
}

const S = (o) => ({ status: 200, body: { payee: PAYEE, degraded: false, signalsUnavailable: [], score: 90, recommendation: "ALLOW", ...o } });
const D = (o) => ({ status: 200, body: { recommendation: "ALLOW", degraded: false, reason_codes: [], facts: { l1: { n_delivered: 3 } }, ...o } });
const acc = (o) => [{ ...ACCEPT, ...o }];
const SUB = (data) => ({ status: 200, body: data });
const META = { block: { number: 50890586, timestamp: 1788570519 }, deployment: "QmX" };
const ROW = (t) => [{ role: "RECIPIENT", totalPayments: t, totalVolumeDecimal: "2.5", firstPaymentTimestamp: "1", lastPaymentTimestamp: "2" }];

/**
 * 監査役が歩いた 78 マス。`[面, 壊れた形, world]`、床を振る世界だけ第4要素に
 * `minL1Deliveries`（A・B・C の3本すべてに同じ値を渡す）。
 *
 * **床を明示しない世界は `minL1Deliveries: 0`** ——`PAY_POLICY` が読取の宣言として 0 を
 * 置いているからで、0 の床はどの件数でも満たされる。だから `facts.l1.n_delivered` の形を
 * ここに足しても、床を上げない限り A も B も C も一度も L1 を判定しない（＝関門にならない）。
 *
 * ここに世界を足すのは自由（期待値は C から取るので、表を書き足しても嘘は入らない）。
 */
export const CASES = [
  // ---- 面: /decision の応答（uncatalogued 経路が既定。score は健全） ----
  ["decision", "404 not_found (uncatalogued・既定)", {}],
  ["decision", "200 ALLOW degraded:false", { decision: D() }],
  ["decision", "400", { decision: { status: 400, body: { error: "bad" } } }],
  ["decision", "429", { decision: { status: 429, body: { error: "rate" } } }],
  ["decision", "500", { decision: { status: 500, body: { error: "boom" } } }],
  ["decision", "503", { decision: { status: 503, body: {} } }],
  ["decision", "timeout / fetch throws", { decision: { throw: true } }],
  ["decision", "200 + 壊れた JSON", { decision: { status: 200, badJson: true } }],
  ["decision", "200 + body null", { decision: { status: 200, body: null } }],
  ["decision", '200 + body "ok" (文字列)', { decision: { status: 200, body: "ok" } }],
  ["decision", "200 + body [] (配列)", { decision: { status: 200, body: [] } }],
  ["decision", "404 だが error!=not_found", { decision: { status: 404, body: { error: "gone" } } }],

  // ---- 面: /decision の判定語・品質欄（catalogued 経路） ----
  ["decision body", "ALLOW", { decision: D() }],
  ["decision body", "WARN", { decision: D({ recommendation: "WARN" }) }],
  ["decision body", "BLOCK", { decision: D({ recommendation: "BLOCK" }) }],
  ["decision body", '" BLOCK " (空白付き)', { decision: D({ recommendation: " BLOCK " }) }],
  ["decision body", '"block" (小文字)', { decision: D({ recommendation: "block" }) }],
  ["decision body", '"allow" (小文字)', { decision: D({ recommendation: "allow" }) }],
  ["decision body", '" ALLOW " (空白付き)', { decision: D({ recommendation: " ALLOW " }) }],
  ["decision body", "degraded:true", { decision: D({ degraded: true }) }],
  ["decision body", 'degraded:"true" (文字列)', { decision: D({ degraded: "true" }) }],
  ["decision body", "degraded:1 (数)", { decision: D({ degraded: 1 }) }],
  ["decision body", "degraded 欄が無い", { decision: { status: 200, body: { recommendation: "ALLOW", reason_codes: [], facts: { l1: { n_delivered: 3 } } } } }],
  ["decision body", "recommendation 欄が無い", { decision: { status: 200, body: { degraded: false, reason_codes: [], facts: { l1: { n_delivered: 3 } } } } }],
  // `signalsUnavailable`（「この信号は読めなかった」の申告）。`degraded: false` でも、
  // 読めなかった信号があるなら測れていない——`payee score` の面と同じ5形をここにも置く
  // （2026-09-12: `/decision` 経路だけが `degraded` しか見ておらず、★3形で judge が拒み
  //  payOrRefuse が**署名していた**）。
  ["decision body", 'signalsUnavailable:["native_drain"]', { decision: D({ signalsUnavailable: ["native_drain"] }) }],
  ["decision body", "signalsUnavailable:[] (空配列)", { decision: D({ signalsUnavailable: [] }) }],
  ["decision body", 'signalsUnavailable:"native_drain" (非配列)', { decision: D({ signalsUnavailable: "native_drain" }) }],
  ["decision body", "signalsUnavailable:null", { decision: D({ signalsUnavailable: null }) }],
  ["decision body", "signalsUnavailable:{} (object)", { decision: D({ signalsUnavailable: {} }) }],
  ["decision body", "signalsUnavailable 欄が無い", { decision: D() }],

  // ---- 面: `facts.l1.n_delivered` の形（床 1 を置いて、初めて関門になる） ----
  // 床を 0 のままにすると「どの形でも通る」ので、この面だけ第4要素で 1 に上げる。
  // 2026-09-12 の監査が実測した反例: `1e400`（JSON の Infinity）と `2.5` が
  // デモ側の床を満たし、`payOrRefuse` は 0 件と読んで拒んでいた。
  ["l1 floor", "n_delivered 3（整数・床を満たす）", { decision: D() }, 1],
  ["l1 floor", "n_delivered Infinity (1e400)", { decision: D({ facts: { l1: { n_delivered: 1e400 } } }) }, 1],
  ["l1 floor", "n_delivered 2.5（小数）", { decision: D({ facts: { l1: { n_delivered: 2.5 } } }) }, 1],
  ["l1 floor", "n_delivered -1（負）", { decision: D({ facts: { l1: { n_delivered: -1 } } }) }, 1],
  ["l1 floor", 'n_delivered "3"（文字列）', { decision: D({ facts: { l1: { n_delivered: "3" } } }) }, 1],
  ["l1 floor", "n_delivered 欄が無い", { decision: D({ facts: { l1: {} } }) }, 1],
  ["l1 floor", "facts 欄が無い", { decision: { status: 200, body: { recommendation: "ALLOW", degraded: false, reason_codes: [] } } }, 1],
  // 監査の再現そのまま: WARN を `requireVet402Allow:false` で免除した上で床だけが判定する世界。
  ["l1 floor", "WARN 免除 + n_delivered Infinity", { decision: D({ recommendation: "WARN", facts: { l1: { n_delivered: 1e400 } } }) }, 1],
  ["l1 floor", "WARN 免除 + n_delivered 2.5", { decision: D({ recommendation: "WARN", facts: { l1: { n_delivered: 2.5 } } }) }, 1],

  // ---- 面: 買い手（受取人）スコア。uncatalogued 経路 ----
  ["payee score", "ALLOW", {}],
  ["payee score", "WARN", { score: S({ recommendation: "WARN", score: 69 }) }],
  ["payee score", "BLOCK", { score: S({ recommendation: "BLOCK", score: 10 }) }],
  ["payee score", '" BLOCK " (空白付き)', { score: S({ recommendation: " BLOCK ", score: 10 }) }],
  ["payee score", '"block" (小文字)', { score: S({ recommendation: "block", score: 10 }) }],
  ["payee score", '"allow" (小文字)', { score: S({ recommendation: "allow" }) }],
  ["payee score", "degraded:true", { score: S({ degraded: true }) }],
  ["payee score", 'degraded:"true" (文字列)', { score: S({ degraded: "true" }) }],
  ["payee score", "degraded:1 (数)", { score: S({ degraded: 1 }) }],
  ["payee score", "degraded 欄が無い", { score: { status: 200, body: { payee: PAYEE, signalsUnavailable: [], score: 90, recommendation: "ALLOW" } } }],
  ["payee score", 'signalsUnavailable:["native_drain"]', { score: S({ signalsUnavailable: ["native_drain"] }) }],
  ["payee score", 'signalsUnavailable:"native_drain" (非配列)', { score: S({ signalsUnavailable: "native_drain" }) }],
  ["payee score", "signalsUnavailable:null", { score: S({ signalsUnavailable: null }) }],
  ["payee score", "signalsUnavailable:{} (object)", { score: S({ signalsUnavailable: {} }) }],
  ["payee score", "signalsUnavailable 欄が無い", { score: { status: 200, body: { payee: PAYEE, degraded: false, score: 90, recommendation: "ALLOW" } } }],
  ["payee score", "body が null", { score: { status: 200, body: null } }],
  ["payee score", "404", { score: { status: 404, body: { error: "nf" } } }],
  ["payee score", "500", { score: { status: 500, body: {} } }],
  ["payee score", "fetch throws", { score: { throw: true } }],
  ["payee score", "200 + 壊れた JSON", { score: { status: 200, badJson: true } }],

  // ---- 面: The Graph subgraph ----
  ["subgraph", "正常 253 件", {}],
  ["subgraph", "200 + GraphQL errors (鍵なしの答え)", { subgraph: SUB({ errors: [{ message: "auth error: missing authorization header" }], data: null }) }],
  ["subgraph", "_meta 欠落", { subgraph: SUB({ data: { x402AddressSummaries: ROW("253") } }) }],
  ["subgraph", "ブロック高 0", { subgraph: SUB({ data: { _meta: { block: { number: 0 } }, x402AddressSummaries: ROW("253") } }) }],
  ["subgraph", "件数 Infinity (1e400)", { subgraph: SUB({ data: { _meta: META, x402AddressSummaries: ROW(1e400) } }) }],
  ["subgraph", '件数 "0x10"', { subgraph: SUB({ data: { _meta: META, x402AddressSummaries: ROW("0x10") } }) }],
  ["subgraph", '件数 "1e4"', { subgraph: SUB({ data: { _meta: META, x402AddressSummaries: ROW("1e4") } }) }],
  ["subgraph", "件数 true", { subgraph: SUB({ data: { _meta: META, x402AddressSummaries: ROW(true) } }) }],
  ["subgraph", "行が [null]", { subgraph: SUB({ data: { _meta: META, x402AddressSummaries: [null] } }) }],
  ["subgraph", "rows が非配列", { subgraph: SUB({ data: { _meta: META, x402AddressSummaries: {} } }) }],
  ["subgraph", "受領 0 件（行なし・読めた）", { subgraph: SUB({ data: { _meta: META, x402AddressSummaries: [] } }) }],
  ["subgraph", "HTTP 500", { subgraph: { status: 500, body: {} } }],
  ["subgraph", "fetch throws", { subgraph: { throw: true } }],

  // ---- 面: 402 challenge ----
  ["402", "正常 (Base USDC 10000)", {}],
  ["402", "accepts 空", { accepts: [] }],
  ["402", "payTo が null", { accepts: acc({ payTo: null }) }],
  ["402", "payTo が非 0x (ENS 名)", { accepts: acc({ payTo: "thegraph.eth" }) }],
  ["402", "payTo が別アドレス", { accepts: acc({ payTo: "0x1111111111111111111111111111111111111111" }) }],
  ["402", "asset が別トークン (DAI)", { accepts: acc({ asset: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" }) }],
  ["402", "network が Solana", { accepts: acc({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }) }],
  ["402", 'amount "-1" (負)', { accepts: acc({ amount: "-1" }) }],
  ["402", 'amount "0"', { accepts: acc({ amount: "0" }) }],
  ["402", 'amount "0x10" (16進)', { accepts: acc({ amount: "0x10" }) }],
  ["402", 'amount "1e4" (指数)', { accepts: acc({ amount: "1e4" }) }],
  ["402", 'amount " 10000 " (空白付き)', { accepts: acc({ amount: " 10000 " }) }],
  ["402", 'amount "9999.5" (小数)', { accepts: acc({ amount: "9999.5" }) }],
  ["402", "amount が数値 10000 (非文字列)", { accepts: acc({ amount: 10000 }) }],
  ["402", "amount 巨大 (1e24)", { accepts: acc({ amount: "999999999999999999999999" }) }],
  ["402", "EIP-712 domain が別名", { accepts: acc({ extra: { assetTransferMethod: "eip3009", name: "GatewayWalletBatched", version: "2" } }) }],
  ["402", "402 が返らない (HTTP 500)", { no402: true }],
];

/**
 * **B だけが C と違ってよい世界。** `judge` は「審査員が渡した URL が x402 の口か」を
 * 先に判定する道具で、C は「この相手にこの額を払うか」を判定する道具——渡されるものが違う。
 *   - 402 の accept が1件も**復号できない**（`normalizeAccept` が全部落とす）: judge は
 *     `not an x402 endpoint` で止まる。C は目的の payee を知っているので REFUSE を返す。
 *   - `payTo が別アドレス`: judge に期待受取人は無い（402 の payTo をそのまま読む）。
 *     C は呼び手が名乗った payee と照合して `payee_mismatch`。
 * どちらも設計上の差であって、写経のずれではない。
 */
const JUDGE_IS_A_DIFFERENT_DOOR = new Set([
  "402 / accepts 空",
  "402 / payTo が null",
  "402 / amount が数値 10000 (非文字列)",
  "402 / 402 が返らない (HTTP 500)",
  "402 / payTo が別アドレス",
]);

/**
 * **答えは同じ（REFUSE）だが、名指しする理由が違ってよい世界。**
 * `payTo` が ENS 名の 402: C は呼び手の payee と照合できるので `payee_mismatch`、
 * judge は照合相手を持たないので「そのアドレスの subgraph 証拠が読めない」で止まる。
 * どちらも同じものを見て拒んでおり、judge が知らないことを名乗らせる方が嘘になる。
 */
const JUDGE_NAMES_ITS_OWN_REASON = new Set(["402 / payTo が非 0x (ENS 名)"]);

for (const [surface, shape, world, floor] of CASES) {
  test(`関門の一致 A=B=C — ${surface} / ${shape}`, async () => {
    const c = await runC(world, floor);
    const a = await runA(world, floor);
    assert.equal(
      a.signal,
      c.signal,
      `A(pay 空撃ちの予告) が C(payOrRefuse) と食い違った。\n` +
        `  A: ${a.signal} — ${a.predicted}\n` +
        `  C: ${c.signal} status=${c.status} reasons=${c.reasons} src=${c.source}`,
    );
    assert.equal(a.signed, false, "空撃ちは、どの世界でも署名器へ触れてはならない");
    if (JUDGE_IS_A_DIFFERENT_DOOR.has(`${surface} / ${shape}`)) return;
    const b = await runB(world, floor === undefined ? [] : ["--min-l1-deliveries", String(floor)]);
    assert.equal(
      b.signal,
      c.signal,
      `B(judge の verdict) が C(payOrRefuse) と食い違った。\n` +
        `  B: ${b.signal} reasons=${b.reasons} src=${b.source}\n` +
        `  C: ${c.signal} status=${c.status} reasons=${c.reasons} src=${c.source}`,
    );
    if (b.signal === "REFUSE" && !JUDGE_NAMES_ITS_OWN_REASON.has(`${surface} / ${shape}`)) {
      assert.deepEqual(
        b.reasons.split(",").sort(),
        c.reasons.split(",").sort(),
        `B と C が同じ答えを別の語で言っている。\n  B: ${b.reasons}\n  C: ${c.reasons}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 画が読めるか（審査員はこの画しか見ない）
// ---------------------------------------------------------------------------

/** 落ちた理由は、必ず画のどこかに出ていなければならない。 */
test("画: /decision が読めなかったとき、その行が [FAIL] で画に出る", async () => {
  const a = await runA({ decision: { status: 429, body: { error: "rate_limited" } } });
  assert.equal(a.signal, "REFUSE");
  const failing = a.gates.filter((g) => g.verdict === "fail");
  assert.ok(
    failing.some((g) => /decision/i.test(g.name)),
    `429 で落ちたのに、/decision を名指しする [FAIL] 行が画に無い。行: ${a.gates.map((g) => `${g.verdict}:${g.name}`).join(" | ")}`,
  );
  assert.match(a.screen, /\[FAIL\][^\n]*decision/i);
});

test("画: signalsUnavailable が非空のとき、落ちた理由が関門行に出る", async () => {
  const world = { score: { status: 200, body: { payee: PAYEE, degraded: false, signalsUnavailable: ["native_drain"], score: 90, recommendation: "ALLOW" } } };
  const b = await runB(world);
  assert.equal(b.signal, "REFUSE");
  // 「関門は全部 [ok] なのに 2 行下が REFUSE」を禁じる: 落ちた以上、[FAIL] が1つは要る。
  assert.match(b.screen, /\[FAIL\]/, `verdict REFUSE なのに関門行が1つも [FAIL] でない:\n${b.screen}`);
  assert.match(b.screen, /native_drain/, `何が測れなかったのかが画に出ていない:\n${b.screen}`);
});

test('画: amount "1e4" のとき、402 が言っていない 10000 を印字しない', async () => {
  const world = { accepts: [{ ...ACCEPT, amount: "1e4" }] };
  const a = await runA(world);
  assert.equal(a.signal, "REFUSE");
  // 関門行だけでなく**画のどこにも**出してはいけない。上の「何に署名するはずだったか」の表も、
  // 同じ `Number()` で正規化した額を並べていた。
  for (const line of a.screen.split("\n")) {
    assert.ok(!/\b10000\b/.test(line), `402 は "1e4" としか言っていないのに、画が 10000 を印字した: ${line}`);
  }
  assert.match(a.screen, /1e4/, "生の値が画から消えてしまっている");
});

test("画: payTo が ENS 名の 402 でも、生スタックではなく読める画が出る", async () => {
  const b = await runB({ accepts: [{ ...ACCEPT, payTo: "thegraph.eth" }] });
  assert.notEqual(b.signal, "THROW", `素の Error が投げられた: ${b.reasons}`);
  assert.equal(b.signal, "REFUSE");
  assert.match(b.screen, /thegraph\.eth/, "どの値で落ちたのかが画に出ていない");
});

// ---------------------------------------------------------------------------
// 正常系の画は1文字も変わってはいけない（提出済みの動画に映っている）
// ---------------------------------------------------------------------------

const NORMAL_PAY_GATES = [
  " [ok  ] payTo == expected                0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
  " [ok  ] chain + asset are Base USDC      eip155:8453 exact",
  " [ok  ] amount <= ceiling                10000 units = $0.01",
  ' [ok  ] EIP-712 domain is pinned USDC    {"name":"USD Coin","version":"2"}',
  " [ok  ] subgraph evidence is live        block 50890586, 253 receipts",
  " [ok  ] payee verdict is ALLOW           ALLOW (90) [payee score]",
  " [ok  ] evidence floor: subgraph >= 1    253 receipts (need 1)",
];

test("正常系: pay 空撃ちの関門行と predicted 行が、撮影時と同じ", async () => {
  const a = await runA({});
  const gateLines = a.screen.split("\n").filter((l) => /^ \[(ok  |FAIL|waiv|  \? )\]/.test(l));
  assert.deepEqual(gateLines, NORMAL_PAY_GATES);
  assert.equal(a.signal, "SIGN");
  assert.equal(
    a.predicted,
    "--live would sign and send $0.01. Every gate readable from here is green. Rule: " +
      "requireVet402Allow=false — vet402's verdict is waived and recorded, not required; " +
      "what judges instead is minL1Deliveries >= 0 (vet402) and minSubgraphReceipts >= 1 (subgraph).",
  );
});

test("正常系: judge の関門行と verdict 行が、撮影時と同じ", async () => {
  const b = await runB({});
  assert.equal(b.signal, "SIGN");
  assert.equal(b.reasons, "resource_uncatalogued");
  assert.equal(b.source, "payee_score");
  const gateLines = b.screen.split("\n").filter((l) => /^ \[(ok  |FAIL|waiv|  \? )\]/.test(l));
  assert.deepEqual(gateLines, [
    " [waiv] payTo == expected                0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB — no",
    " [ok  ] chain + asset are Base USDC      eip155:8453 exact",
    " [ok  ] amount <= ceiling                10000 units = $0.01",
    ' [ok  ] EIP-712 domain is pinned USDC    {"name":"USD Coin","version":"2"}',
    " [ok  ] subgraph evidence is live        block 50890586, 253 receipts",
    " [ok  ] payee verdict is ALLOW           ALLOW (90) [payee score]",
    " [ok  ] evidence floor: subgraph >= 1    253 receipts (need 1)",
  ]);
});

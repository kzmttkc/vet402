// `judge <url>` —— 審査員が自分の 402 URL を入れて、**署名なし**で判定を見る。
//
// 不変条件は3つ。
//   1. **署名器に到達する経路が最初から無い**（`--live` を持たない・account を受け取らない）
//   2. 判定の規則は SDK と同じ（閾値は SDK の定数、理由コードは SDK のソースに実在する語だけ）
//   3. 402 が取れない URL は「x402 の口ではない」と1行で止まる（exit 1・スタック無し）
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runJudge, parseJudgeArgs, JUDGE_REASON_CODES } from "../src/judge.ts";
import { ExpectedFailure, NotX402Error, PolicyError } from "../src/probe.ts";
import { failureLines } from "../src/run.ts";
import { createEmitter } from "../src/emit.ts";
import { DEFAULT_MAX_PER_TX_USD } from "../../../packages/sdk/dist/index.js";

const DEMO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_SRC = join(DEMO_DIR, "../../packages/sdk/src/pay-or-refuse.ts");

const URL_ = "https://seller.example/api/quote";
const PAYEE = "0x1111111111111111111111111111111111111111";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000",
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
};
/** 実在する v1 の綴り（`maxAmountRequired` / `network: "base"`）。 */
const ACCEPT_V1 = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "10000",
  asset: USDC,
  payTo: PAYEE,
  resource: URL_,
};
const SOLANA_ACCEPT = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "10000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: PAYEE,
};

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const WARN_69 = { score: 69, recommendation: "WARN", dataDepth: "thin" };

/** 第1層: signer への「参照」を記録する Proxy（`pay.test.mjs` と同じ手）。 */
function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: PAYEE, signTypedData: async () => "0x" + "11".repeat(65) },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

/**
 * 偽の世界。既定は**カタログ外（/decision 404）・WARN 69・subgraph 259 件・402 は Base USDC 1件**。
 *   `sellerStatus`  売り手の応答コード（402 以外なら payment-required ヘッダを付けない）
 *   `sellerThrows`  接続不能を模す
 *   `accepts` / `x402Version`
 *   `decision`      `{ status, body }` で /decision を差し替える
 *   `score`         受取人スコアの上書き（`null` で 500）
 *   `summaries`     subgraph の RECIPIENT 行（`[]` = 受領 0 件）
 *   `subgraphError` subgraph を GraphQL errors で落とす
 */
function world(opts = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u, headers: init?.headers ?? {} });
    const reply = (status, body, headers = {}) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Map(Object.entries(headers)),
    });
    if (u.includes("/decision")) {
      const d = opts.decision ?? { status: 404, body: { error: "not_found" } };
      return reply(d.status, d.body);
    }
    if (u.includes("gateway.thegraph.com") && !u.includes("/api/x402/")) {
      if (opts.subgraphError) return reply(200, { errors: [{ message: "auth error: missing authorization header" }] });
      return reply(200, {
        data: {
          _meta: { block: { number: 50890586, timestamp: 1788570519 }, deployment: "QmDemoDeployment" },
          x402AddressSummaries: opts.summaries ?? [
            { role: "RECIPIENT", totalPayments: "259", totalVolumeDecimal: "2.59", firstPaymentTimestamp: "1", lastPaymentTimestamp: "2" },
          ],
        },
      });
    }
    if (u.includes("/payees/")) {
      if (opts.score === null) return reply(500, { error: "boom" });
      return reply(200, { payee: PAYEE, degraded: false, signalsUnavailable: [], ...WARN_69, ...(opts.score ?? {}) });
    }
    if (u.startsWith(URL_)) {
      if (opts.sellerThrows) throw new Error("ECONNREFUSED");
      const status = opts.sellerStatus ?? 402;
      if (status !== 402) return reply(status, { hello: "world" });
      return reply(402, {}, { "payment-required": b64({ x402Version: opts.x402Version ?? 2, accepts: opts.accepts ?? [ACCEPT] }) });
    }
    throw new Error(`unexpected request in test: ${method} ${u}`);
  };
  return { fetch, calls };
}

const ENV = { GRAPH_API_KEY: "graphkey-0123456789", VOUCH_API_KEY: "vouchkey-0123456789" };

/** `judge` を1回走らせる。`argv` は CLI と同じ綴りで渡す（解釈の経路もテストに入れる）。 */
async function judge(argv, opts = {}, env = ENV) {
  const w = watchedAccount();
  const f = world(opts);
  const out = [];
  const args = parseJudgeArgs([URL_, ...argv]);
  const result = await runJudge({
    ...args,
    env,
    fetch: f.fetch,
    emit: createEmitter({ sink: (l) => out.push(l), secrets: [] }),
    // runJudge は account を**受け取らない**。渡しても無視されることを Proxy で見る（第1層）。
    account: w.account,
  });
  return { ...result, text: out.join("\n"), w, f };
}

// ---------- (a) カタログ外 + WARN + subgraph 259 件 → ALLOW、署名器には触れない ----------

test("(a) カタログ外・WARN 69・subgraph 259 件・--policy subgraph --min-subgraph-receipts 1 → ALLOW、署名器参照 0", async () => {
  const r = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"]);
  assert.equal(r.verdict.verdict, "ALLOW");
  assert.deepEqual(r.verdict.reasonCodes, ["resource_uncatalogued", "allowed_by_caller_policy"]);
  assert.equal(r.verdict.verdictSource, "caller_policy");
  assert.equal(r.verdict.signed, false);
  assert.deepEqual(r.w.signAccesses(), [], "judge が signer に触れている");
  assert.equal(r.f.calls.some((c) => Object.keys(c.headers).some((k) => k.toUpperCase() === "PAYMENT-SIGNATURE")), false, "支払いヘッダ付きの再送が出ている");
  // 画の末尾に verdict / reason_codes / signed が必ず出る。
  assert.match(r.text, /^\s*verdict\s+ALLOW/m);
  assert.match(r.text, /^\s*reason_codes\s+resource_uncatalogued, allowed_by_caller_policy/m);
  assert.match(r.text, /^\s*signed\s+false \(dry-run\)/m);
  // 免除した判定は消えない。
  assert.match(r.text, /WARN/);
  assert.match(r.text, /259/);
  // policy vet402 の台帳は床に使っていない（source: subgraph）。
  assert.equal(r.view.policy.floors.some((f) => f.source === "vet402"), false);
});

test("(a') 画は pay の空撃ちと同じ形——関門表と2つの情報源の対比が出る", async () => {
  const r = await judge(["--policy", "both", "--min-subgraph-receipts", "1"]);
  assert.match(r.text, /what would be signed/);
  assert.match(r.text, /what the two sources say/);
  assert.match(r.text, /\/decision\s+HTTP 404\s+\(uncatalogued\)/);
  assert.match(r.text, /_meta\.deployment\s+QmDemoDeployment/);
  assert.match(r.text, /\[waiv\] payee verdict is ALLOW/);
  assert.match(r.text, /\[ok  \] evidence floor: subgraph >= 1/);
  assert.doesNotMatch(r.text, /--live/, "judge に無い --live を画で案内している");
  assert.doesNotMatch(r.text, /DEMO_PAYER_PRIVATE_KEY/, "judge に無い鍵を env 行に出している");
});

// ---------- (b) 床を満たせない → REFUSE insufficient_subgraph_evidence ----------

test("(b) 同条件で subgraph 0 件 → REFUSE insufficient_subgraph_evidence", async () => {
  const r = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"], { summaries: [] });
  assert.equal(r.verdict.verdict, "REFUSE");
  assert.deepEqual(r.verdict.reasonCodes, ["resource_uncatalogued", "insufficient_subgraph_evidence"]);
  assert.match(r.text, /^\s*verdict\s+REFUSE/m);
  assert.deepEqual(r.w.signAccesses(), []);
});

test("(b') subgraph が読めなければ、0 件ではなく「読めなかった」で拒む", async () => {
  const r = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"], { subgraphError: true });
  assert.equal(r.verdict.verdict, "REFUSE");
  assert.deepEqual(r.verdict.reasonCodes, ["resource_uncatalogued", "evidence_unavailable", "subgraph_evidence_unavailable"]);
});

// ---------- (c) BLOCK と degraded は policy に関係なく REFUSE（WINDOW_PLAN §3.2.1）----------

test("(c) カタログ外で受取人スコアが BLOCK → 床を満たしていても REFUSE payee_recommendation_block", async () => {
  const r = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"], { score: { score: 5, recommendation: "BLOCK" } });
  assert.equal(r.verdict.verdict, "REFUSE");
  assert.deepEqual(r.verdict.reasonCodes, ["resource_uncatalogued", "payee_recommendation_block"]);
});

test("(c') カタログ内で /decision が BLOCK → 床を満たしていても REFUSE。サーバの理由はそのまま残る", async () => {
  const r = await judge(["--policy", "both", "--min-subgraph-receipts", "1"], {
    decision: { status: 200, body: { recommendation: "BLOCK", reason_codes: ["known_scam"], degraded: false, evidence: [] } },
  });
  assert.equal(r.verdict.verdict, "REFUSE");
  assert.deepEqual(r.verdict.reasonCodes, ["known_scam", "payee_recommendation_block"]);
  assert.equal(r.verdict.verdictSource, "decision");
});

test("(c'') degraded は「測れなかった」——床では埋めない", async () => {
  const uncatalogued = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"], { score: { degraded: true } });
  assert.deepEqual(uncatalogued.verdict.reasonCodes, ["resource_uncatalogued", "evidence_unavailable"]);
  const catalogued = await judge(["--policy", "both", "--min-subgraph-receipts", "1"], {
    decision: { status: 200, body: { recommendation: "WARN", reason_codes: ["thin"], degraded: true, evidence: [] } },
  });
  assert.deepEqual(catalogued.verdict.reasonCodes, ["thin", "evidence_unavailable"]);
});

test("床を宣言しなければ vet402 の ALLOW が要る（既定 fail-closed）", async () => {
  const warn = await judge(["--policy", "vet402"]);
  assert.equal(warn.verdict.verdict, "REFUSE");
  assert.deepEqual(warn.verdict.reasonCodes, ["resource_uncatalogued", "payee_recommendation_not_allow"]);
  const allow = await judge(["--policy", "vet402"], {
    decision: { status: 200, body: { recommendation: "ALLOW", reason_codes: [], degraded: false, evidence: [], facts: { l1: { n_delivered: 5 } } } },
  });
  assert.equal(allow.verdict.verdict, "ALLOW");
  assert.deepEqual(allow.verdict.reasonCodes, []);
  assert.equal(allow.verdict.verdictSource, "decision");
});

test("--min-l1-deliveries は vet402 の L1 台帳で当たる", async () => {
  const short = await judge(["--policy", "vet402", "--min-l1-deliveries", "3"], {
    decision: { status: 200, body: { recommendation: "WARN", reason_codes: ["thin"], degraded: false, evidence: [], facts: { l1: { n_delivered: 2 } } } },
  });
  assert.deepEqual(short.verdict.reasonCodes, ["thin", "insufficient_delivery_evidence"]);
  const met = await judge(["--policy", "vet402", "--min-l1-deliveries", "3"], {
    decision: { status: 200, body: { recommendation: "WARN", reason_codes: ["thin"], degraded: false, evidence: [], facts: { l1: { n_delivered: 3 } } } },
  });
  assert.equal(met.verdict.verdict, "ALLOW");
  assert.deepEqual(met.verdict.reasonCodes, ["thin", "allowed_by_caller_policy"]);
});

// ---------- 金銭ゲートは SDK の定数で当たる ----------

test("上限の既定は SDK の DEFAULT_MAX_PER_TX_USD。超えれば price_above_ceiling", async () => {
  const dflt = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"]);
  assert.equal(dflt.view.amountUsd, DEFAULT_MAX_PER_TX_USD);
  const over = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1", "--ceiling-usd", "0.005"]);
  assert.equal(over.verdict.verdict, "REFUSE");
  assert.deepEqual(over.verdict.reasonCodes, ["resource_uncatalogued", "price_above_ceiling"]);
});

test("払える accept が1件も無ければ no_eligible_accept を先頭に置き、画に映さない", async () => {
  const r = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"], { accepts: [SOLANA_ACCEPT] });
  assert.equal(r.verdict.verdict, "REFUSE");
  assert.deepEqual(r.verdict.reasonCodes, ["resource_uncatalogued", "no_eligible_accept", "chain_or_asset_mismatch"]);
  assert.equal(r.view.accept, null);
  assert.equal(r.text.includes(SOLANA_ACCEPT.asset), false);
});

// ---------- (d) 402 でない URL は1行で止まる ----------

test("(d) 200 を返す URL は NotX402Error（ExpectedFailure）で止まり、vet402 へは1本も出ない", async () => {
  await assert.rejects(() => judge(["--policy", "vet402"], { sellerStatus: 200 }), (error) => {
    assert.ok(error instanceof NotX402Error);
    assert.ok(error instanceof ExpectedFailure);
    assert.match(error.message, /not an x402 endpoint/i);
    assert.match(error.message, /HTTP 200/);
    return true;
  });
  await assert.rejects(() => judge(["--policy", "vet402"], { sellerThrows: true }), (error) => {
    assert.ok(error instanceof NotX402Error);
    assert.match(error.message, /ECONNREFUSED/);
    return true;
  });
});

test("(d') failureLines は NotX402Error / PolicyError を1行にする（スタック無し）", () => {
  for (const error of [new NotX402Error("not an x402 endpoint: HTTP 200"), new PolicyError("invalid_policy: x")]) {
    const lines = failureLines(error);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], `error: ${error.message}`);
  }
});

test("(d'') 実プロセス: 200 を返すローカル HTTP に judge を向けると exit 1・1行・`at ` 無し", async () => {
  // サーバーはこのプロセスのイベントループで動くので、子は**非同期**に起動する
  // （spawnSync はループを止め、子の要求に誰も応答できずデッドロックする）。
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const env = { ...process.env, VOUCH_API_KEY: "vouchkey-0123456789" };
    delete env.GRAPH_API_KEY;
    const r = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(DEMO_DIR, "src/run.ts"), "judge", `http://127.0.0.1:${port}/thing`, "--policy", "vet402"],
        { env, encoding: "utf8", timeout: 20_000 },
        (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
      );
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, out);
    assert.match(out, /^error: not an x402 endpoint/m);
    assert.doesNotMatch(out, /^\s+at /m, `stack trace leaked:\n${out}`);
    assert.equal(out.trim().split("\n").length, 1, `expected exactly one line:\n${out}`);
  } finally {
    server.close();
  }
});

// ---------- (e) v1 の綴りも読める ----------

test("(e) v1 綴り（maxAmountRequired / network:\"base\"）の 402 を v2 の形へ揃えて判定する", async () => {
  const r = await judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"], { accepts: [ACCEPT_V1], x402Version: 1 });
  assert.equal(r.view.x402Version, 1);
  assert.equal(r.view.accept.network, "eip155:8453");
  assert.equal(r.view.accept.amount, "10000");
  assert.equal(r.verdict.verdict, "ALLOW");
  assert.match(r.text, /x402 v1/);
});

// ---------- 環境変数 ----------

test("VOUCH_API_KEY は常に必須。GRAPH_API_KEY は --policy subgraph|both のときだけ", async () => {
  await assert.rejects(() => judge(["--policy", "vet402"], {}, { GRAPH_API_KEY: ENV.GRAPH_API_KEY }), /VOUCH_API_KEY/);
  await assert.rejects(() => judge(["--policy", "subgraph", "--min-subgraph-receipts", "1"], {}, { VOUCH_API_KEY: ENV.VOUCH_API_KEY }), /GRAPH_API_KEY/);
  // vet402 だけなら GRAPH_API_KEY 無しで走る。
  const r = await judge(["--policy", "vet402"], {}, { VOUCH_API_KEY: ENV.VOUCH_API_KEY });
  assert.equal(r.verdict.verdict, "REFUSE");
  assert.equal(r.view.subgraph, null);
  assert.equal("DEMO_PAYER_PRIVATE_KEY" in r.view.envReady, false);
});

// ---------- 引数の解釈 ----------

test("parseJudgeArgs: 既定は --policy both・ceiling は SDK 既定。--live は受け付けない", () => {
  const p = parseJudgeArgs([URL_]);
  assert.equal(p.url, URL_);
  assert.equal(p.method, "GET");
  assert.equal(p.policy, "both");
  assert.equal(p.ceilingUsd, DEFAULT_MAX_PER_TX_USD);
  assert.equal(p.minSubgraphReceipts, undefined);
  const q = parseJudgeArgs([URL_, "--method", "post", "--body", "{\"q\":1}", "--policy", "both", "--min-subgraph-receipts", "3", "--min-l1-deliveries", "0", "--ceiling-usd", "0.05"]);
  assert.equal(q.method, "POST");
  assert.equal(q.body, "{\"q\":1}");
  assert.equal(q.minSubgraphReceipts, 3);
  assert.equal(q.minL1Deliveries, 0);
  assert.equal(q.ceilingUsd, 0.05);
  assert.throws(() => parseJudgeArgs([URL_, "--live"]), (e) => e instanceof PolicyError && /--live/.test(e.message));
  assert.throws(() => parseJudgeArgs([URL_, "--policy", "graph"]), PolicyError);
  assert.throws(() => parseJudgeArgs([URL_, "--min-subgraph-receipts", "many"]), PolicyError);
  assert.throws(() => parseJudgeArgs(["--policy", "both"]), (e) => e instanceof PolicyError && /url/i.test(e.message));
  assert.throws(() => parseJudgeArgs(["ftp://x"]), PolicyError);
});

test("評価されない床は SDK と同じく呼び出し側エラー（黙って無視しない）", () => {
  assert.throws(() => parseJudgeArgs([URL_, "--policy", "subgraph", "--min-l1-deliveries", "3"]), (e) => e instanceof PolicyError && /invalid_evidence_policy/.test(e.message));
  assert.throws(() => parseJudgeArgs([URL_, "--policy", "vet402", "--min-subgraph-receipts", "1"]), (e) => e instanceof PolicyError && /invalid_evidence_policy/.test(e.message));
});

// ---------- 規則の複製を見張る ----------

test("judge が出せる理由コードは、すべて SDK の pay-or-refuse.ts に文字通り実在する語", () => {
  const sdk = readFileSync(SDK_SRC, "utf8");
  assert.ok(JUDGE_REASON_CODES.length >= 10);
  for (const code of JUDGE_REASON_CODES) {
    assert.ok(sdk.includes(`"${code}"`), `SDK に無い理由コードを demo が発明している: ${code}`);
  }
});

test("judge / assess の src は署名の経路を持たない（静的にも動的にも）", () => {
  for (const name of ["judge.ts", "assess.ts"]) {
    const body = readFileSync(join(DEMO_DIR, "src", name), "utf8");
    for (const token of ["payOrRefuse", "x402-pay", "signTypedData", "DEMO_PAYER_PRIVATE_KEY", "viem", "PAYMENT-SIGNATURE"]) {
      assert.equal(body.includes(token), false, `${name} に ${token} がある`);
    }
    assert.doesNotMatch(body, /await import\(/, `${name} が動的 import を持つ`);
  }
});

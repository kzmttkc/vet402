// 画の検査。**審査員は動画でこれを読む**ので、崩れ・はみ出し・情報の欠落は
// そのまま提出物の欠陥になる（WINDOW_PLAN §6 の 0:45–1:15 / 1:15–1:30）。
import test from "node:test";
import assert from "node:assert/strict";
import { renderRefuse, renderPayDryRun, MAX_WIDTH } from "../src/render.ts";

const refuseView = {
  resource: { method: "GET", url: "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote" },
  payee: "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59",
  ranAt: "2026-09-05T01:08:41Z",
  vet402: {
    endpoint: "https://vet402.com/api/v1/resources/8146a86d…/decision?role=payer",
    recommendation: "WARN",
    reasonCodes: ["l0_pass", "l1_not_attempted", "l2_undeclared"],
    degraded: false,
    l0: { status: "pass", observed_at: "2026-09-04 17:40:13.970619+00", dialect: "both" },
    l1: { n_delivered: 0, n_settled: 0, n_attempts: 0, observed_at: null },
    scoredAt: "2026-09-05T01:06:13.414Z",
  },
  subgraph: {
    endpoint: "https://gateway.thegraph.com/api/<KEY>/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
    block: { number: 50890518, timestamp: 1788570383 },
    deployment: "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN",
    row: {
      role: "RECIPIENT",
      totalPayments: "29",
      totalVolumeDecimal: "0.29",
      firstPaymentTimestamp: "1779151771",
      lastPaymentTimestamp: "1786811303",
    },
  },
  outcome: {
    status: "refused",
    signed: false,
    nonce: null,
    txHash: null,
    reasonCodes: ["l0_pass", "l1_not_attempted", "l2_undeclared", "payee_recommendation_not_allow"],
    evidence: [
      {
        level: "L1",
        source: "subgraph",
        receipts: 29,
        block: { number: 50890518 },
        deployment: "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN",
        url: "https://gateway.thegraph.com/api/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
      },
    ],
  },
  requests: [
    "GET https://vet402.com/api/v1/resources/8146a86d…/decision?role=payer",
    "POST https://gateway.thegraph.com/api/<KEY>/subgraphs/id/Cb56…",
  ],
};

test("refuse の画は The Graph の block と deployment を必ず映す（live を読んだ唯一の自明な証明）", () => {
  const text = renderRefuse(refuseView).join("\n");
  assert.match(text, /_meta\.block\.number/, "block 高の名前が出ていない");
  assert.match(text, /50890518/, "block 高の値が出ていない");
  assert.match(text, /_meta\.deployment/, "deployment の名前が出ていない");
  assert.match(text, /QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN/, "deployment が略さず出ていない");
});

test("refuse の画は、2つの源が別々に何を知っているかを両方見せる", () => {
  const text = renderRefuse(refuseView).join("\n");
  // 左: 我々は見たが買っていない
  assert.match(text, /l0_pass/);
  assert.match(text, /l1_not_attempted/);
  assert.match(text, /WARN/);
  // 右: The Graph は同じアドレスの受領を 29 件知っている
  assert.match(text, /totalPayments/);
  assert.match(text, /\b29\b/);
  assert.match(text, /RECIPIENT/);
  // 署名が存在しないことが機械可読で出る
  assert.match(text, /refused/);
  assert.match(text, /signed\s+false/);
});

test("refuse の画はターミナル幅で崩れず、1画面に収まる", () => {
  const lines = renderRefuse(refuseView);
  for (const line of lines) {
    assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある: ${line}`);
  }
  assert.ok(lines.length <= 32, `${lines.length} 行あり1画面に収まらない`);
});

test("色を外しても意味が残る（ANSI を落としても同じ情報が読める）", () => {
  const withColor = renderRefuse(refuseView, { color: true }).join("\n");
  const stripped = withColor.replace(/\[[0-9;]*m/g, "");
  assert.equal(stripped, renderRefuse(refuseView, { color: false }).join("\n"));
});

test("本番の長い URL と Postgres 形式の日時でも幅を超えない（実行出力で見つけた欠陥）", () => {
  const real = {
    ...refuseView,
    vet402: { ...refuseView.vet402, l0: { ...refuseView.vet402.l0, observed_at: "2026-09-04 17:40:13.970619+00" } },
    requests: [
      "GET https://vet402.com/api/v1/resources/8146a86d0e858267f15388341fc99b7d5fa23b6ebb138ba0267a38eb9a76386b/decision?role=payer",
      "POST https://gateway.thegraph.com/api/<KEY>/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
    ],
  };
  const lines = renderRefuse(real);
  for (const line of lines) assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある: ${line}`);
  assert.ok(lines.length <= 32, `${lines.length} 行あり1画面に収まらない`);
  // Postgres の綴りでも ISO へ寄る（1行に収まる）。
  assert.match(lines.join("\n"), /2026-09-04T17:40:13Z/);
  // 折り返しても**1文字も落ちない**（折り返しを畳めば元の URL がそのまま戻る）。
  const unwrapped = lines.join("\n").replace(/\n\s+/g, "");
  assert.ok(
    unwrapped.includes("https://vet402.com/api/v1/resources/8146a86d0e858267f15388341fc99b7d5fa23b6ebb138ba0267a38eb9a76386b/decision?role=payer"),
    "折り返しで resource_id が欠けている",
  );
});

const payView = {
  live: false,
  target: { method: "POST", url: "https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj" },
  expectedPayTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
  amountUsd: 0.01,
  ranAt: "2026-09-05T01:08:41Z",
  accept: {
    scheme: "exact",
    network: "eip155:8453",
    amount: "10000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
  },
  x402Version: 2,
  authorizationWindowSeconds: 120,
  payeeScore: { recommendation: "WARN", score: 69, degraded: false },
  decisionStatus: 404,
  subgraph: {
    endpoint: "https://gateway.thegraph.com/api/<KEY>/subgraphs/id/Cb56…",
    block: { number: 50890586, timestamp: 1788570519 },
    deployment: "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN",
    row: { role: "RECIPIENT", totalPayments: "253", totalVolumeDecimal: "2.53" },
  },
  gates: [
    { name: "amount == declared", verdict: "pass", detail: "10000 units = $0.01" },
    { name: "payTo == expected", verdict: "pass", detail: "0x79DC34E4…FcCB" },
    { name: "payee verdict is ALLOW", verdict: "fail", detail: "WARN (69)" },
  ],
  envReady: { GRAPH_API_KEY: true, VOUCH_API_KEY: true, DEMO_PAYER_PRIVATE_KEY: false },
};

test("空撃ちは「何に署名するはずだったか」を出すが、署名しなかったことを明言する", () => {
  const text = renderPayDryRun(payView).join("\n");
  assert.match(text, /DRY RUN/);
  assert.match(text, /--live/, "実行方法が出ていない");
  assert.match(text, /no signature was created/i);
  // 何に署名するはずだったか
  assert.match(text, /10000/, "金額（最小単位）が出ていない");
  assert.match(text, /0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB/, "payTo が出ていない");
  assert.match(text, /0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/, "asset が出ていない");
  assert.match(text, /eip155:8453/);
  assert.match(text, /120/, "認可の窓が出ていない");
});

test("空撃ちの画も幅で崩れず、1画面に収まる", () => {
  const lines = renderPayDryRun(payView);
  for (const line of lines) {
    assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある: ${line}`);
  }
  assert.ok(lines.length <= 36, `${lines.length} 行あり1画面に収まらない`);
});

test("空撃ちは「今日 --live を打つと何が起きるか」を、読めた事実から先に言う", () => {
  const text = renderPayDryRun(payView).join("\n");
  assert.match(text, /predicted/);
  assert.match(text, /would REFUSE before signing/);
  assert.match(text, /payee verdict is ALLOW/);
  const green = renderPayDryRun({
    ...payView,
    gates: payView.gates.map((g) => ({ ...g, verdict: "pass" })),
  }).join("\n");
  assert.match(green, /would sign and send \$0\.01/);
});

test("空撃ちは、取れなかった値を数字で埋めない", () => {
  const text = renderPayDryRun({ ...payView, subgraph: null, payeeScore: null }).join("\n");
  assert.match(text, /not read/i, "取れなかったことを言っていない");
  assert.equal(/totalPayments\s+\d/.test(text), false, "取れていない件数を数字で出している");
});

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

// `judge` の画は `pay` と同じ骨格に verdict の足を足す。足した分で 96 桁を超えたら動画で崩れる
// （2026-09-06 の実走で末尾行が 102 桁になっていた——描画していないモードは検査されない）。
test("judge モードの画も幅で崩れず、verdict / reason_codes / signed を末尾に出す", () => {
  const judgeView = {
    ...payView,
    mode: "judge",
    expectedPayTo: null,
    amountUsd: 1,
    verdict: {
      verdict: "ALLOW",
      reasonCodes: ["resource_uncatalogued", "allowed_by_caller_policy"],
      verdictSource: "caller_policy",
      override: {
        rule: "requireVet402Allow:false",
        waived: { source: "payee_score", recommendation: "WARN", score: 69 },
        floors_met: [{ floor: "minSubgraphReceipts", source: "subgraph", required: 1, observed: 260 }],
      },
    },
    policy: { requireVet402Allow: false, floors: [{ floor: "minSubgraphReceipts", source: "subgraph", required: 1 }] },
  };
  const lines = renderPayDryRun(judgeView);
  for (const line of lines) assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある: ${line}`);
  const text = lines.join("\n");
  assert.match(text, /^\s*verdict\s+ALLOW/m);
  assert.match(text, /^\s*reason_codes\s+resource_uncatalogued, allowed_by_caller_policy/m);
  assert.match(text, /^\s*signed\s+false \(dry-run\)/m);
  assert.match(text, /floor met\s+minSubgraphReceipts \(subgraph\) 1 <= 260/);
  assert.doesNotMatch(text, /--live/, "judge に無い --live を案内している");
  assert.match(text, /JUDGE/);
});

test("空撃ちは、取れなかった値を数字で埋めない", () => {
  const text = renderPayDryRun({ ...payView, subgraph: null, payeeScore: null }).join("\n");
  assert.match(text, /not read/i, "取れなかったことを言っていない");
  assert.equal(/totalPayments\s+\d/.test(text), false, "取れていない件数を数字で出している");
});

// 2026-09-07: 鍵なしは「欠けている」ではなく「鍵なし枠で読んだ」。VOUCH_API_KEY だけは
// MISSING と言わず、本番の枠（IP ごと 10/分）を名指しする。他の鍵の MISSING は従来どおり。
test("env 行: VOUCH_API_KEY 未設定は `unset (keyless: 10/min per IP)`、他の鍵は MISSING のまま", () => {
  const text = renderPayDryRun({ ...payView, envReady: { GRAPH_API_KEY: true, VOUCH_API_KEY: false, DEMO_PAYER_PRIVATE_KEY: false } }).join("\n");
  assert.match(text, /GRAPH_API_KEY=set/);
  assert.match(text, /VOUCH_API_KEY=unset \(keyless: 10\/min per IP\)/, text);
  assert.match(text, /DEMO_PAYER_PRIVATE_KEY=MISSING/);
  assert.doesNotMatch(text, /VOUCH_API_KEY=MISSING/);
  const withKey = renderPayDryRun(payView).join("\n");
  assert.match(withKey, /VOUCH_API_KEY=set/);
  for (const line of renderPayDryRun({ ...payView, envReady: { GRAPH_API_KEY: true, VOUCH_API_KEY: false, DEMO_PAYER_PRIVATE_KEY: false } })) {
    assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある: ${line}`);
  }
});

test("refuse の画にも env 行が出て、鍵なしは keyless と名乗る", () => {
  const keyless = renderRefuse({ ...refuseView, envReady: { GRAPH_API_KEY: true, VOUCH_API_KEY: false } });
  const text = keyless.join("\n");
  assert.match(text, /env\s+GRAPH_API_KEY=set\s+VOUCH_API_KEY=unset \(keyless: 10\/min per IP\)/, text);
  for (const line of keyless) assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある: ${line}`);
  const withKey = renderRefuse({ ...refuseView, envReady: { GRAPH_API_KEY: true, VOUCH_API_KEY: true } }).join("\n");
  assert.match(withKey, /VOUCH_API_KEY=set/);
});

// 2026-09-08: `[A] …` の1文は L1 の実数から導出する。4通りを表で固定して、
// もう一度「固定文が数字と矛盾する」状態に戻れないようにする。
import { vet402Sentence } from "../src/render.ts";

const withL1 = (l1) => ({ ...refuseView, vet402: { ...refuseView.vet402, l1: { observed_at: null, ...l1 } } });

test("[A] の1文は L1 の実数から導出される（4通り）", () => {
  // 未試行
  assert.match(
    vet402Sentence(withL1({ n_delivered: 0, n_settled: 0, n_attempts: 0, n_inconclusive: 0 })),
    /never signed a paid attempt \(L1 attempts 0\)/,
  );
  // 決済はあるが結論の出た応答が 0（conclusive = 1 − 1 = 0）——本番で観測された形
  const inconclusive = vet402Sentence(withL1({ n_delivered: 0, n_settled: 1, n_attempts: 1, n_inconclusive: 1 }));
  assert.match(inconclusive, /it paid 1 time\(s\)/, inconclusive);
  assert.match(inconclusive, /no delivery on record \(L1 delivered 0\)/, inconclusive);
  assert.doesNotMatch(inconclusive, /never bought|never signed/i, inconclusive);
  // 結論の出た試行があり、1件も届いていない（conclusive = 4 − 1 = 3）
  assert.match(
    vet402Sentence(withL1({ n_delivered: 0, n_settled: 4, n_attempts: 4, n_inconclusive: 1 })),
    /never been delivered to \(L1 delivered 0 of 3\)/,
  );
  // 届いている
  assert.match(
    vet402Sentence(withL1({ n_delivered: 2, n_settled: 3, n_attempts: 3, n_inconclusive: 1 })),
    /has been delivered to 2 time\(s\)/,
  );
});

test("[A] の1文は、どの分岐でも売り手の落ち度と読める語を使わない（09-05 決定）", () => {
  for (const l1 of [
    { n_delivered: 0, n_settled: 0, n_attempts: 0, n_inconclusive: 0 },
    { n_delivered: 0, n_settled: 1, n_attempts: 1, n_inconclusive: 1 },
    { n_delivered: 0, n_settled: 4, n_attempts: 4, n_inconclusive: 1 },
    { n_delivered: 2, n_settled: 3, n_attempts: 3, n_inconclusive: 1 },
  ]) {
    const line = vet402Sentence(withL1(l1));
    assert.doesNotMatch(line, /fail|refus|broke|scam|fraud|bad seller|unreliable/i, line);
  }
});

test("n_inconclusive が欠けた JSON でも NaN を画に出さない", () => {
  const line = vet402Sentence(withL1({ n_delivered: 0, n_settled: 1, n_attempts: 1 }));
  assert.doesNotMatch(line, /NaN|undefined/, line);
});

// 2026-09-08（本番実走で発見）: 既存の幅テストの refuseView は `n_attempts: 0` なので
// **短い分岐しか通っていなかった**。本番と同じ `settled 1 / tried 1 / inconclusive 1` を
// 流すと `[A]` の行が 167 桁になり、96 桁の枠を割っていた。計器が見ていない側で壊れていた。
test("本番と同じ L1（settled 1, tried 1, inconclusive 1）でも画は幅で崩れない", () => {
  const live = withL1({ n_delivered: 0, n_settled: 1, n_attempts: 1, n_inconclusive: 1 });
  const lines = renderRefuse(live);
  for (const line of lines) {
    assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある: ${line}`);
  }
  assert.ok(lines.length <= 32, `${lines.length} 行あり1画面に収まらない`);
  // 折り返しても1文として読める（切り詰めない）。
  const text = lines.join("\n").replace(/\n\s+/g, " ");
  assert.match(text, /\[A\] has SEEN this seller \(l0_pass\); it paid 1 time\(s\) and every paid response came back non-2xx from our own request shape — no delivery on record \(L1 delivered 0\)\./, text);
});

test("どの L1 分岐でも画は幅で崩れない", () => {
  for (const l1 of [
    { n_delivered: 0, n_settled: 0, n_attempts: 0, n_inconclusive: 0 },
    { n_delivered: 0, n_settled: 1, n_attempts: 1, n_inconclusive: 1 },
    { n_delivered: 0, n_settled: 4, n_attempts: 4, n_inconclusive: 1 },
    { n_delivered: 2, n_settled: 3, n_attempts: 3, n_inconclusive: 1 },
    { n_delivered: 0, n_settled: 1, n_attempts: 1 },
  ]) {
    for (const line of renderRefuse(withL1(l1))) {
      assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある (l1=${JSON.stringify(l1)}): ${line}`);
    }
  }
});

// 2026-09-08: `[A]` の **L0 側**も実測から導出する。直前の修正で L1 側だけを実数化したため、
// 4 分岐のうち 3 つが `(l0_pass)` の固定文のまま残っていた。`/decision` が pass 以外を返すと、
// すぐ上の `L0 status  fail` / `reason_codes  l0_fail` と同じ画で矛盾する——L1 で直したのと
// **同じ欠陥が、隣の半分に残っていた**。動詞 "has SEEN" も L0 の観測を名乗るので pass 専用。
// 語は語彙表（`src/lib/observatory/vocabulary.ts` の L0 verdicts）から取り、
// 売り手の落ち度と読める書き方をしない（2026-09-05 決定・WINDOW_PLAN §1.5）。
const L1_SHAPES = [
  { n_delivered: 0, n_settled: 0, n_attempts: 0, n_inconclusive: 0 },
  { n_delivered: 0, n_settled: 1, n_attempts: 1, n_inconclusive: 1 },
  { n_delivered: 0, n_settled: 4, n_attempts: 4, n_inconclusive: 1 },
  { n_delivered: 2, n_settled: 3, n_attempts: 3, n_inconclusive: 1 },
  { n_delivered: 0, n_settled: 1, n_attempts: 1 },
];

const withL0 = (status, l1) => ({
  ...refuseView,
  vet402: {
    ...refuseView.vet402,
    reasonCodes: [`l0_${status}`, "l1_not_attempted", "l2_undeclared"],
    l0: { ...refuseView.vet402.l0, status },
    l1: { observed_at: null, ...l1 },
  },
});

test("[A] の1文は L0 の実測から導出される（pass 以外の分岐で l0_pass と言わない）", () => {
  for (const status of ["fail", "unverified"]) {
    for (const l1 of L1_SHAPES) {
      const line = vet402Sentence(withL0(status, l1));
      assert.doesNotMatch(line, /l0_pass/, line);
      // "has SEEN this seller" は L0 の観測（pass）を名乗る動詞。pass 以外では使わない。
      assert.doesNotMatch(line, /has SEEN this seller/, line);
      // 実測した status がそのまま機械可読な形で出る（`rules.ts` と同じ `l0_${status}`）。
      assert.match(line, new RegExp(`\\(l0_${status}\\)`), line);
    }
  }
});

test("[A] の1文は L0 が pass のときだけ `has SEEN this seller (l0_pass)` と言う", () => {
  for (const l1 of L1_SHAPES) {
    const line = vet402Sentence(withL0("pass", l1));
    assert.match(line, /has SEEN this seller \(l0_pass\)/, line);
  }
});

test("[A] の1文は、L0 が pass 以外でも売り手の落ち度と読める語を使わない（09-05 決定）", () => {
  for (const status of ["fail", "unverified"]) {
    for (const l1 of L1_SHAPES) {
      // `(l0_fail)` は機械可読な reason code なので残す。禁じるのは断罪の**散文**。
      const prose = vet402Sentence(withL0(status, l1)).replace(/\(l0_[a-z]+\)/g, "");
      assert.doesNotMatch(prose, /fail|refus|broke|scam|fraud|bad seller|unreliable|dishonest/i, prose);
    }
  }
});

test("L0 が pass 以外でも画は幅で崩れず、1画面に収まる", () => {
  for (const status of ["fail", "unverified"]) {
    for (const l1 of L1_SHAPES) {
      const lines = renderRefuse(withL0(status, l1));
      for (const line of lines) {
        assert.ok(line.length <= MAX_WIDTH, `${line.length} 桁ある (l0=${status}, l1=${JSON.stringify(l1)}): ${line}`);
      }
      assert.ok(lines.length <= 32, `${lines.length} 行あり1画面に収まらない (l0=${status})`);
    }
  }
});

// `refuse.ts` は `/decision` が l0.status を返さないとき `"—"` を入れる（取れなかった印）。
// **取れなかった値から機械可読な符号を作らない**——`(l0_—)` は語彙表にも `rules.ts` にも無い。
test("L0 status が取れていないとき、存在しない reason code を作らない", () => {
  const line = vet402Sentence(withL0("—", { n_delivered: 0, n_settled: 0, n_attempts: 0, n_inconclusive: 0 }));
  assert.doesNotMatch(line, /l0_—/, line);
  assert.match(line, /not read/i, line);
});

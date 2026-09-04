// ============================================================
// payOrRefuse — 会期中の新規（ETHOnline 2026 / Continuity）。
//
// Day 0（2026-09-04）はこのファイルを **red** で置くだけ。実装しない。
// 正典は docs/ethonline-2026/WINDOW_PLAN.md §4（22本）と「呼べない」の4層証明。
//
// 何を証明するテストか、を先に書いておく:
//
//   拒否のとき signer は「呼ばれなかった」のではなく「**到達できない**」。
//   回数を数えるだけでは、配線を間違えたテストも緑になる。だから
//     第1層: account を Proxy で包み、`sign*` への **プロパティ参照**が0であること
//     第2層: fetch を許可リスト方式にし、facilitator / RPC / Graph へ出たら throw
//     第3層: 支払い実装は ALLOW ブランチ内の動的 import。拒否経路で評価されないこと
//     第4層: **ネガティブコントロール**——同じハーネスで ALLOW を1本通し、
//            `signTypedData` が「ちょうど1回」出ることを示す（0回が配線ミスでない証明）
//
// 2026-09-02 の実測（fixtures.md §7 / WINDOW_PLAN §9）を前提にする:
//   判定源は `/decision?role=payer`。旧 `/payees/{addr}/score` の signals は読まない。
//   ALLOW は本番で実際に出る（既定 policy を通る endpoint は 373 件）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";

// 会期中に実装する。Day 0 では存在しないので、**各テストが個別に赤くなる**ようスタブへ落とす
// （import で1本落ちるだけだと「22本を書いた」記録が git に残らない）。
//
// 2026-09-05 訂正: Day 0 は `../src/pay-or-refuse.js` から import していたが、この
// パッケージは rootDir: src / outDir: dist で、`npm test` は `tsc` を通してから
// `test/*.test.mjs` を走らせる（package.json）。`src/*.js` は**存在しない**ので、
// 実装を書いても import は必ず失敗し、全テストが永久にスタブへ落ちて緑にならない。
// 既存テスト（decision / spend-guard / evidence-policy …）と同じく dist から読む。
let payOrRefuse, readDemoDecisions, readL1Decisions;
try {
  ({ payOrRefuse, readDemoDecisions, readL1Decisions } = await import("../dist/index.js"));
} catch {
  const notYet = async () => { throw new Error("payOrRefuse is not implemented yet — Day 0 red (ETHOnline window opened 2026-09-04)"); };
  payOrRefuse = notYet; readDemoDecisions = notYet; readL1Decisions = notYet;
}

// ---------- ハーネス（4層） ----------

/** 第1層: signer への「参照」を記録する Proxy。回数ではなくアクセスを見る。 */
function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, accessed, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

/** 第2層: 許可リスト外の fetch は throw。拒否経路で許すのは /decision と 402 を取る GET だけ。 */
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
      const r = responses[Object.keys(responses).find((k) => u.includes(k))];
      if (!r) throw new Error(`no stub for ${u}`);
      return { ok: r.status < 400, status: r.status, json: async () => r.body, headers: new Map(Object.entries(r.headers ?? {})) };
    },
  };
}

const DECISION = "/decision";
const decision = (over = {}) => ({
  status: 200,
  body: {
    subject: { type: "resource", id: "a".repeat(64) },
    role: "payer",
    recommendation: "ALLOW",
    reason_codes: ["l0_pass", "l1_delivered"],
    facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
    evidence: [{ level: "L1", source: "vet402", purchase_id: "eip155:8453:0xabc", url: "https://vet402.com/observatory/e/x" }],
    degraded: false,
    policy: "allow_only",
    rules_version: "2026-09-02.1",
    ...over,
  },
});

const base = { payee: "0x36038e1d712c5e39f35952164ec58ec2b96caee7", resource: "https://kronossignals.com/api/v1/price/btc", amountUsd: 0.02 };

// ---------- A. 署名に到達しない（提出物の核心） ----------

test("A1 /decision が ALLOW 以外 → signer への参照が0", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION], { [DECISION]: decision({ recommendation: "WARN", reason_codes: ["l1_not_attempted"] }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  // 2026-09-05 追加（変異テストで判明）: status と signer 参照だけを見ると、ALLOW ゲートを
  // 丸ごと外した実装でも緑になる——許可リストの外へ出た fetch が throw して、別の理由で
  // 拒否されるから。「なぜ拒否したか」まで検査しないと、この4本は配線の証明にならない。
  assert.equal(f.calls.filter((u) => u.includes(DECISION)).length, 1, "判定を1回引いている");
  assert.match(r.decision.reason_codes.join(","), /not_allow/, "ALLOW でなかったことが理由");
  // DESIGN §1: 理由はサーバの reason_codes をそのまま返す（我々の語で上書きしない）。
  assert.equal(r.decision.reason_codes.includes("l1_not_attempted"), true);
  assert.deepEqual(w.signAccesses(), []);
});

test("A2 /decision が degraded → 読めなかったのだから払わない", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION], { [DECISION]: decision({ degraded: true }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.equal(f.calls.filter((u) => u.includes(DECISION)).length, 1, "判定を1回引いている");
  assert.match(r.decision.reason_codes.join(","), /unavailable/, "読めなかったことが理由");
  // degraded の判定を読み飛ばした実装では、サーバの reason_codes が理由に残らない。
  assert.equal(r.decision.reason_codes.includes("l0_pass"), true);
  assert.deepEqual(w.signAccesses(), []);
});

test("A3 /decision の取得に失敗 → fail-closed（signer 参照0）", async () => {
  const w = watchedAccount();
  const f = { fetch: async () => { throw new Error("ETIMEDOUT"); } };
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.match(r.decision.reason_codes.join(","), /unavailable/);
  assert.deepEqual(w.signAccesses(), []);
});

test("A4 402 の payTo が payee と違う → payee_mismatch・署名前に停止", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronossignals"], {
    [DECISION]: decision(),
    kronossignals: { status: 402, body: {}, headers: { "payment-required": btoa(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dead" }] })) } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("payee_mismatch"), true);
  assert.deepEqual(w.signAccesses(), []);
});

// ---------- B. 金銭ゲート（本番に4チェーン提示の402が実在する） ----------

const wall = (accept) => ({ status: 402, body: {}, headers: { "payment-required": btoa(JSON.stringify({ x402Version: 2, accepts: [accept] })) } });
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: base.payee, extra: { assetTransferMethod: "eip3009" } };

test("B5 Base 以外のネットワークは署名前に拒否", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: wall({ ...okAccept, network: "eip155:1" }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  // 2026-09-05 追加: A1/A2 と同じ穴が B5-B7 に残っていた。status と signer 参照だけでは、
  // 金銭ゲートを丸ごと外した実装でも緑になる——許可リストの外（売り手への再送）へ出た
  // fetch が throw して、別の理由で拒否されるから。**なぜ拒否したか**まで見る。
  assert.equal(r.decision.reason_codes.includes("chain_or_asset_mismatch"), true, "チェーン不一致が理由");
  assert.equal(f.calls.filter((u) => u.includes(DECISION)).length, 1, "判定を1回引いている");
  assert.equal(r.challenge?.network, "eip155:1", "402 を実際に読んだ上で落としている");
  assert.deepEqual(w.signAccesses(), []);
});

test("B6 正規 USDC 以外の asset は署名前に拒否", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: wall({ ...okAccept, asset: "0x0000000000000000000000000000000000000001" }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("chain_or_asset_mismatch"), true, "asset 不一致が理由");
  assert.equal(f.calls.filter((u) => u.includes(DECISION)).length, 1, "判定を1回引いている");
  assert.equal(r.challenge?.asset, "0x0000000000000000000000000000000000000001", "402 を実際に読んだ上で落としている");
  assert.deepEqual(w.signAccesses(), []);
});

test("B7 exact 以外の scheme / eip3009 以外の転送方式は拒否", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: wall({ ...okAccept, scheme: "upto" }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("chain_or_asset_mismatch"), true, "scheme 不一致が理由");
  assert.equal(f.calls.filter((u) => u.includes(DECISION)).length, 1, "判定を1回引いている");
  assert.equal(r.challenge?.scheme, "upto", "402 を実際に読んだ上で落としている");
  assert.deepEqual(w.signAccesses(), []);
});

test("B8 0x でない payee（ENS 名）は呼び出し側エラー——解決もしない", async () => {
  const w = watchedAccount();
  let fetched = 0;
  const f = { fetch: async () => { fetched++; throw new Error("must not be called"); } };
  await assert.rejects(
    () => payOrRefuse({ ...base, payee: "vitalik.eth", account: w.account, fetch: f.fetch }),
    // 「未実装だから落ちた」では通さない。呼び出し側エラーだと名乗ることまで要求する。
    (e) => /payee|address|ens/i.test(String(e && e.message)),
  );
  assert.equal(fetched, 0, "名前解決も判定取得もしていない");
  assert.deepEqual(w.signAccesses(), []);
});

// ---------- C. policy ----------

test("C9 maxPerTxUsd 超過は判定を引く前に落ちる", async () => {
  const w = watchedAccount();
  const f = { fetch: async () => { throw new Error("decision must not be fetched"); } };
  const r = await payOrRefuse({ ...base, amountUsd: 5, account: w.account, fetch: f.fetch, policy: { maxPerTxUsd: 1 } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("price_above_ceiling"), true);
});

test("C10 evidence.minL1Deliveries 未達で拒否", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION], { [DECISION]: decision({ facts: { l0: { status: "pass" }, l1: { n_delivered: 1, n_attempts: 1 }, l2: { status: "undeclared" } } }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "vet402" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("insufficient_delivery_evidence"), true);
});

test("C11 evidence.minSubgraphReceipts 未達で拒否", { todo: "The Graph 証拠源（WINDOW_PLAN §2 #3）が未実装。09-08 の作業。" }, async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "3" }], _meta: { block: { number: 50824146 } } } } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 100, source: "subgraph" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("insufficient_subgraph_evidence"), true);
});

test("C12 source:both で片方しか読めないとき、どちらが読めなかったかが理由に入る", { todo: "The Graph 証拠源（WINDOW_PLAN §2 #3）が未実装。09-08 の作業。" }, async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 403, body: {} },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "both" } } });
  assert.equal(r.status, "refused");
  assert.match(r.decision.reason_codes.join(","), /subgraph/);
  assert.deepEqual(w.signAccesses(), []);
});

// ---------- D. The Graph 経路の fail-closed ----------

test("D13 Gateway が 403/5xx/タイムアウト → evidence_unavailable・signer 参照0", { todo: "現状の緑は空振り——subgraph 源が未実装で Gateway を一度も呼んでいないため evidence_unavailable になっているだけ。The Graph 証拠源の実装（09-08）と同時に本物にする。" }, async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], { [DECISION]: decision(), "gateway.thegraph.com": { status: 503, body: {} } });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 1, source: "subgraph" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("evidence_unavailable"), true);
  assert.deepEqual(w.signAccesses(), []);
});

test("D14 Graph への全リクエストに User-Agent が付く（無いと Cloudflare 1010）", { todo: "The Graph 証拠源（WINDOW_PLAN §2 #3）が未実装。09-08 の作業。" }, async () => {
  const seen = [];
  const f = {
    fetch: async (url, init) => {
      seen.push({ url: String(url), ua: init?.headers?.["User-Agent"] ?? init?.headers?.["user-agent"] });
      return { ok: true, status: 200, json: async () => ({ data: { x402AddressSummaries: [{ totalPayments: "252" }], _meta: { block: { number: 1 } } } }), headers: new Map() };
    },
  };
  const w = watchedAccount();
  await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 1, source: "subgraph" } } }).catch(() => {});
  const graph = seen.filter((s) => s.url.includes("gateway.thegraph.com"));
  assert.ok(graph.length > 0, "Graph へ1回は出ている");
  for (const g of graph) assert.ok(g.ua && g.ua.length > 0, `UA が無い: ${g.url}`);
});

test("D15 source:subgraph の決定行に subgraphId と _meta.block が載る", { todo: "The Graph 証拠源（WINDOW_PLAN §2 #3）が未実装。09-08 の作業。" }, async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "252" }], _meta: { block: { number: 50824146 } } } } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 1, source: "subgraph" } } });
  const ev = r.decision.evidence.find((e) => e.source === "subgraph");
  assert.ok(ev, "source:subgraph の evidence 行がある");
  assert.ok(ev.subgraphId, "subgraphId がある");
  assert.equal(typeof ev.block?.number, "number");
});

test("D16 自社台帳の件数と subgraph の件数を1つの数に合算しない", { todo: "The Graph 証拠源（WINDOW_PLAN §2 #3）が未実装。09-08 の作業。" }, async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "252" }], _meta: { block: { number: 1 } } } } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, minSubgraphReceipts: 100, source: "both" } } });
  const sources = r.decision.evidence.map((e) => e.source);
  assert.ok(sources.includes("vet402") && sources.includes("subgraph"), "両方が別の行として出る");
});

// ---------- E. 通過時 ----------

test("E17 全条件通過時のみ signer を1回呼び、返った txHash で attest する", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronos", "facilitator", "payments/x402"], {
    [DECISION]: decision(),
    kronos: wall(okAccept),
    facilitator: { status: 200, body: { success: true, transaction: "0xtx" } },
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "vet402" } } });
  assert.equal(r.status, "paid");
  assert.equal(r.attested, true);
  assert.equal(w.signAccesses().length, 1);
});

test("E18 署名後に settle 失敗 → failed を返し、隠さない", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronos", "facilitator"], {
    [DECISION]: decision(),
    kronos: wall(okAccept),
    facilitator: { status: 500, body: { error: "settle_failed" } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "vet402" } } });
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
});

// ---------- F. 汚染しない ----------

test("F19 デモの決定行は source: agent-demo で、L1 台帳へは書かない", { todo: "現状の緑は空振り——決定行をどこにも保存していないので「L1 台帳へ書いていない」が自明に通るだけ。決定面の実装（09-09）と同時に本物にする。" }, async () => {
  const writes = [];
  const f = {
    fetch: async (url, init) => {
      writes.push(String(url));
      if (String(url).includes(DECISION)) return { ok: true, status: 200, json: async () => decision().body, headers: new Map() };
      return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
    },
  };
  const w = watchedAccount();
  await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, source: "agent-demo" });
  assert.ok(writes.some((u) => u.includes(DECISION)), "判定を1回は引いている（実装が動いた証拠）");
  assert.equal(writes.some((u) => u.includes("l1")), false, "L1 台帳へ書きに行っていない");
});

test("F20 L1 フィードはデモ行を無視し、デモフィードは L1 行を無視する", { todo: "agent-demo の決定面（WINDOW_PLAN §2 #4）が未実装。09-09 の作業。" }, async () => {
  const demo = await readDemoDecisions();
  const l1 = await readL1Decisions();
  assert.equal(demo.every((d) => d.source === "agent-demo"), true);
  assert.equal(l1.some((d) => d.source === "agent-demo"), false);
});

// ---------- H. ネガティブコントロール（これが無いと「0回」は無意味） ----------

test("H22 ネガティブコントロール: 同じハーネスで ALLOW を通すと signTypedData がちょうど1回・settle がちょうど1回出る", async () => {
  const w = watchedAccount();
  const calls = [];
  const f = {
    fetch: async (url) => {
      const u = String(url); calls.push(u);
      if (u.includes(DECISION)) return { ok: true, status: 200, json: async () => decision().body, headers: new Map() };
      if (u.includes("kronos")) return { ok: false, status: 402, json: async () => ({}), headers: new Map(Object.entries(wall(okAccept).headers)) };
      return { ok: true, status: 200, json: async () => ({ success: true, transaction: "0xtx" }), headers: new Map() };
    },
  };
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "vet402" } } });
  assert.equal(r.status, "paid");
  assert.equal(w.signAccesses().length, 1, "計測器は「1回」を検出できる（0回が配線ミスでない証明）");
  assert.equal(calls.filter((u) => u.includes("facilitator") || u.includes("settle")).length, 1);
});

// ---------- I. カタログ外の売り手（2026-09-04 本番実測・WINDOW_PLAN §3.1） ----------
//
// デモの支払い先である The Graph は vet402 のカタログに1件も無い:
//   GET /api/v1/payees/0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB/endpoints → {"count":0}
//   GET /api/v1/resources/9e8469d3…/decision?role=payer                     → 404 {"error":"not_found"}
// `getResource()` は resource_id の単純照会なので、カタログ未登録は必ず 404 になる。
//
// つまり **デモの支払い経路そのものが 404 経路**である。ここで諦める実装は提出物にならず、
// ここで黙って払う実装は憲法違反。404 のとき payOrRefuse は
//   402 チャレンジの payTo ＋ 受取人スコア（GET /api/v1/payees/{address}/score）
// だけで判定を出し、材料が無いときだけ**署名前に**機械可読な理由で拒否する。

const SCORE = "/score";
/** WINDOW_PLAN §3 の実測。payTo は The Graph 本体の受取ウォレット。 */
const GRAPH_RESOURCE = "https://gateway.thegraph.com/api/x402/subgraphs/id/DZz4kDTdmzWLWsV373w2ViSHapzk4nUyBASJcNvwrn";
const GRAPH_PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
const graphAccept = { ...okAccept, amount: "10000", payTo: GRAPH_PAYEE };
const notFound = { status: 404, body: { error: "not_found" } };

/** 2026-09-04 実測の受取人スコア応答（recommendation / score だけ差し替える）。 */
const payeeScore = (over = {}) => ({
  status: 200,
  body: {
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
  },
});

const uncatalogued = { payee: GRAPH_PAYEE, resource: GRAPH_RESOURCE, method: "POST", amountUsd: 0.01 };

test("I23a /decision が 404 not_found でも、402 の payTo と受取人スコアだけで判定する（ALLOW → 支払いへ進む）", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com", "facilitator", "payments/x402"], {
    [DECISION]: notFound,
    [SCORE]: payeeScore({ recommendation: "ALLOW", score: 74, dataDepth: "moderate" }),
    "gateway.thegraph.com": wall(graphAccept),
    facilitator: { status: 200, body: { success: true, transaction: "0xtx" } },
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...uncatalogued, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "paid");
  // 判定を出した経路が 404 フォールバックであることが機械可読で残る。
  assert.equal(r.decision.reason_codes.includes("resource_uncatalogued"), true);
  // 引いた材料は「判定 1 回・スコア 1 回」。引かずに通した実装は緑にしない。
  assert.equal(f.calls.filter((u) => u.includes(DECISION)).length, 1);
  assert.equal(f.calls.filter((u) => u.includes(SCORE)).length, 1);
  // ネガティブコントロール: このハーネスは「1回」を検出できる（0回が配線ミスでない証明）。
  assert.equal(w.signAccesses().length, 1);
  assert.equal(f.calls.filter((u) => u.includes("facilitator")).length, 1);
});

test("I23b /decision が 404 かつ受取人スコアが ALLOW でない → 署名前に拒否・理由コードあり", async () => {
  const w = watchedAccount();
  // facilitator を許可リストに入れない。到達した時点で throw する（第2層）。
  const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com"], {
    [DECISION]: notFound,
    [SCORE]: payeeScore(),
    "gateway.thegraph.com": wall(graphAccept),
  });
  const r = await payOrRefuse({ ...uncatalogued, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("resource_uncatalogued"), true);
  assert.equal(r.decision.reason_codes.includes("payee_recommendation_not_allow"), true);
  // 404 を見た瞬間に一律で拒否する実装では緑にしない——スコアを実際に引いたことを要求する。
  assert.equal(f.calls.filter((u) => u.includes(SCORE)).length, 1);
  assert.deepEqual(w.signAccesses(), []);
});

test("I23c /decision が 404 かつ受取人スコアも取得できない → fail-closed", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com"], {
    [DECISION]: notFound,
    [SCORE]: { status: 503, body: { error: "upstream_unavailable" } },
    "gateway.thegraph.com": wall(graphAccept),
  });
  const r = await payOrRefuse({ ...uncatalogued, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.match(r.decision.reason_codes.join(","), /unavailable/);
  // 「引きに行かずに拒否」ではなく「引いて読めなかったから拒否」であること。
  assert.equal(f.calls.filter((u) => u.includes(SCORE)).length, 1);
  assert.deepEqual(w.signAccesses(), []);
});

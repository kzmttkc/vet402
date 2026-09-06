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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * 第2層: 許可リスト外の fetch は throw。拒否経路で許すのは /decision と 402 を取る GET だけ。
 *
 * 2026-09-05: 応答は素のオブジェクトでも `(url, init) => 応答` でもよい。売り手は
 * 同じ URL に対して「支払いヘッダ無し → 402」「有り → 200 + レシート」と**2回**答えるので、
 * URL だけで引く固定応答では x402 の実際の往復を写せない。
 */
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
      let r = responses[Object.keys(responses).find((k) => u.includes(k))];
      if (typeof r === "function") r = r(u, init);
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

const b64 = (o) => btoa(JSON.stringify(o));
const wall = (accept, version = 2) => ({ status: 402, body: {}, headers: { "payment-required": b64({ x402Version: version, accepts: [accept] }) } });
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: base.payee, extra: { assetTransferMethod: "eip3009" } };

/**
 * 売り手。**買い手は facilitator を呼ばない**——決済するのは売り手側であり、買い手は
 * 署名を載せて元のリクエストを再送するだけで、レシートは**応答ヘッダ**から読む。
 * 根拠: coinbase/x402 specs/transports-v2/http.md（PAYMENT-SIGNATURE / PAYMENT-RESPONSE）と
 * 本番実装 `src/lib/observatory/l1-runner.ts` L977-1045 / `x402-payer.ts`。
 *
 * このスタブは支払いヘッダの有無で答えを変える。付いていない要求に 402 の壁を、
 * 付いた要求に 200 とレシートヘッダを返す——「ヘッダを実際に付けたか」がこれで測れる。
 */
function seller(accept, opts = {}) {
  const version = opts.x402Version ?? 2;
  const payHeader = version === 1 ? "X-PAYMENT" : "PAYMENT-SIGNATURE";
  const respHeader = version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE";
  const paid = [];
  const stub = (url, init) => {
    const h = init?.headers ?? {};
    const raw = h[payHeader] ?? h[payHeader.toLowerCase()];
    if (!raw) return wall(accept, version);
    paid.push({ url, method: init?.method, header: payHeader, decoded: JSON.parse(atob(raw)) });
    // `noReceipt`: レシートヘッダを出さず、**本文にだけ** success を書く売り手。
    // 本文を読む実装はここで緑になってしまう（＝レシートは本文ではない、の検算）。
    if (opts.noReceipt) return { status: 200, body: { success: true, transaction: "0xfrom_body" }, headers: {} };
    return {
      status: opts.paidStatus ?? 200,
      body: opts.paidBody ?? { data: "ok" },
      headers: { [respHeader]: b64({ success: true, transaction: "0xtx", network: accept.network, payer: "0xDB62BD202914609830fA656F87996b91be3Aa673", ...opts.settlement }) },
    };
  };
  return { stub, paid };
}

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

test("C9b 402 の amount が上限を超えていれば、呼び手の名乗りが上限内でも署名前に拒否（金銭ゲートは 402 の金額で当てる）", async () => {
  // 2026-09-06 の変異 M12（402 の amount 上限を 1000 倍に緩める）が生き残った。全テストの 402 は
  // $0.01〜0.02 で、**上限（既定 $1）を超える 402 を売り手が出す固定具が無かった**。
  // C9 は呼び手が名乗った amountUsd の関門であって、売り手が 402 で言う金額の関門ではない。
  // ここでは呼び手の名乗り（$0.02）は上限内のまま、売り手が $1.50 を要求する。
  const w = watchedAccount();
  const s = seller({ ...okAccept, amount: "1500000" }); // 1.50 USDC（6 桁）> 既定上限 $1
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: s.stub });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "vet402" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("price_above_ceiling"), true);
  assert.equal(f.calls.some((u) => u.includes(DECISION)), true, "判定は引いている（C9 の呼び手側の関門ではない）");
  assert.equal(f.calls.some((u) => u.includes("kronos")), true, "402 を実際に読んだ上で落としている");
  assert.equal(s.paid.length, 0, "署名付きの再送は出ていない");
  assert.deepEqual(w.signAccesses(), []);
});

test("C10 evidence.minL1Deliveries 未達で拒否", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION], { [DECISION]: decision({ facts: { l0: { status: "pass" }, l1: { n_delivered: 1, n_attempts: 1 }, l2: { status: "undeclared" } } }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "vet402" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("insufficient_delivery_evidence"), true);
});

test("C11 evidence.minSubgraphReceipts 未達で拒否", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "3" }], _meta: { block: { number: 50824146 } } } } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 100, source: "subgraph" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("insufficient_subgraph_evidence"), true);
});

test("C11d 床は「以上」で通す——受領件数が床ちょうどなら通り、床−1 なら拒否（境界値）", async () => {
  // 2026-09-06 の変異 M06（`<` → `<=`）が生き残った。C11 は 3 件 vs 床 100、D16b は 252 vs 254 で、
  // **床ちょうど**の組が1つも無かった。境界を1つずらす実装（床の値そのものを拒否する）は
  // それでも緑だった。ここで両側から固定する。
  const graph = (n) => ({ status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: String(n) }], _meta: { block: { number: 1 } } } } });
  const run = async (receipts) => {
    const w = watchedAccount();
    const s = seller(okAccept);
    const f = allowlistFetch([DECISION, "gateway.thegraph.com", "kronos", "payments/x402"], {
      [DECISION]: decision(),
      "gateway.thegraph.com": graph(receipts),
      kronos: s.stub,
      "payments/x402": { status: 200, body: { ok: true } },
    });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 100, source: "subgraph" } } });
    return { r, signs: w.signAccesses().length };
  };
  // 床ちょうど（100 == 100）→ 床を満たす。支払いへ進む。
  const exact = await run(100);
  assert.equal(exact.r.decision.reason_codes.includes("insufficient_subgraph_evidence"), false, "床ちょうどを「未達」と読んでいる");
  assert.equal(exact.r.status, "paid");
  assert.equal(exact.signs, 1);
  // 床−1（99 < 100）→ 未達。署名しない。
  const below = await run(99);
  assert.equal(below.r.status, "refused");
  assert.equal(below.r.decision.reason_codes.includes("insufficient_subgraph_evidence"), true);
  assert.equal(below.signs, 0);
});

test("C11b 床を評価できない source で minSubgraphReceipts を渡したら呼び出し側エラー——黙って無視しない", async () => {
  // WINDOW_PLAN §13「会期後に必ず直すもの #2」。既定 source は "vet402" なので、
  // `minSubgraphReceipts` だけ渡すとどの分岐にも当たらず、**床を指定したのに拒否も警告も
  // 出ない**状態だった。「壊れて見えない」型なので、黙って無視せず呼び出し側エラーにする。
  const w = watchedAccount();
  let fetched = 0;
  const f = { fetch: async () => { fetched++; throw new Error("must not be called"); } };
  const isPolicyError = (e) => /invalid_evidence_policy/.test(String(e && e.message));
  // (a) source を書かなかった（既定 "vet402" は subgraph の床を評価できない）
  await assert.rejects(
    () => payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 100 } } }),
    isPolicyError,
  );
  // (b) 明示的に矛盾させた（"vet402" と名乗りながら subgraph の床を置く）
  await assert.rejects(
    () => payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 100, source: "vet402" } } }),
    isPolicyError,
  );
  // (c) 対称: "subgraph" と名乗りながら自社台帳の床を置く
  await assert.rejects(
    () => payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "subgraph" } } }),
    isPolicyError,
  );
  assert.equal(fetched, 0, "判定も subgraph も引いていない（呼び出し側の誤りは通信の前に落とす）");
  assert.deepEqual(w.signAccesses(), []);
});

test("C11c カタログ外（/decision が 404）でも minSubgraphReceipts は効く——ここでも黙って無視しない", async () => {
  // デモの支払い先（The Graph）はカタログ外（§3.1）。証拠の床が 404 経路で無視されるなら、
  // **この機能がいちばん要る場所で効いていない**ことになる。
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: { status: 404, body: { error: "not_found" } },
    "gateway.thegraph.com": { status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "3" }], _meta: { block: { number: 50889853 } } } } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 100, source: "subgraph" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("resource_uncatalogued"), true, "404 経路であることが残る");
  assert.equal(r.decision.reason_codes.includes("insufficient_subgraph_evidence"), true);
  assert.equal(f.calls.filter((u) => u.includes("gateway.thegraph.com")).length, 1, "subgraph を実際に引いた上で落としている");
  assert.deepEqual(w.signAccesses(), []);
});

test("C12 source:both で片方しか読めないとき、どちらが読めなかったかが理由に入る", async () => {
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

test("D13 Gateway が 403/5xx/タイムアウト → evidence_unavailable・signer 参照0", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], { [DECISION]: decision(), "gateway.thegraph.com": { status: 503, body: {} } });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 1, source: "subgraph" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("evidence_unavailable"), true);
  // 2026-09-05: この検査が無いと**空振りの緑**になる——subgraph 源が未実装で Gateway を
  // 一度も呼んでいなくても evidence_unavailable は出る。「実際に呼んだ上で失敗したから
  // 拒否した」ことまで見て、はじめて fail-closed の証明になる。
  assert.equal(f.calls.filter((u) => u.includes("gateway.thegraph.com")).length, 1, "Gateway を実際に1回呼んでいる");
  // どちらの源が読めなかったかが機械可読で残る（黙って自社台帳へ落ちていない）。
  assert.match(r.decision.reason_codes.join(","), /subgraph/);
  assert.deepEqual(w.signAccesses(), []);
});

test("D13c source:subgraph は床を書かなくても、Gateway が読めなければ払わない", async () => {
  // D13 は `minSubgraphReceipts: 1` を渡していたので、床の側だけで fail-closed していても
  // 緑になった。床を書かない呼び手——「subgraph を証拠にしたい」とだけ言った呼び手——に対して
  // **黙って払ってしまう**実装を、この1本が止める。売り手は正常に払える状態で置く。
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "gateway.thegraph.com", "kronos", "payments/x402"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 503, body: {} },
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { source: "subgraph" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("subgraph_evidence_unavailable"), true);
  assert.equal(s.paid.length, 0, "署名を付けた再送が出ていない");
  assert.deepEqual(w.signAccesses(), []);
});

test("D14 Graph への全リクエストに User-Agent が付く（無いと Cloudflare 1010）", async () => {
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

test("D13b Gateway が HTTP 200 と GraphQL errors を返す（鍵無しの実挙動）→ evidence_unavailable", async () => {
  // 2026-09-05 実測。keyless パスへ出ると Gateway は **403 ではなく 200** を返し、
  // 本文に `{"errors":[{"message":"auth error: missing authorization header"}]}` を入れる。
  // `response.ok` だけを見る実装はこれを成功と読み、**受領 0 件**として
  // 「証拠が薄い」という**誤った理由**で拒否する。認証されていないことと、
  // 受け取りが 0 件であることは、まったく別のことである。
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 200, body: { errors: [{ message: "auth error: missing authorization header" }] } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 1, source: "subgraph" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("evidence_unavailable"), true);
  assert.equal(r.decision.reason_codes.includes("subgraph_evidence_unavailable"), true);
  assert.equal(r.decision.reason_codes.includes("insufficient_subgraph_evidence"), false, "「薄い」ではなく「読めなかった」");
  assert.equal(r.decision.evidence.some((e) => e.source === "subgraph"), false, "読めていないものを証拠行にしない");
  assert.deepEqual(w.signAccesses(), []);
});

test("D14b 問い合わせは小文字アドレスかつ role: RECIPIENT で絞る（支払回数と受領回数を混ぜない）", async () => {
  // 2026-09-05 実測: 1つのアドレスが PAYER 行と RECIPIENT 行の両方を持つ
  // （`0xf7b1356c…` は RECIPIENT 12,376,084 / PAYER 11,540,523）。絞らずに足すと
  // 「払った回数」を「受け取った回数」として売ることになる。
  const bodies = [];
  const f = {
    fetch: async (url, init) => {
      if (String(url).includes("gateway.thegraph.com")) bodies.push(String(init?.body ?? ""));
      return { ok: true, status: 200, json: async () => ({ data: { x402AddressSummaries: [{ totalPayments: "252" }], _meta: { block: { number: 1 } } } }), headers: new Map() };
    },
  };
  const w = watchedAccount();
  // payee は**大文字混じり**で渡す。小文字化しないと subgraph は1件も返さない（§15）。
  await payOrRefuse({ ...base, payee: "0x36038E1D712C5E39F35952164EC58EC2B96CAEE7", account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 1, source: "subgraph" } } }).catch(() => {});
  assert.equal(bodies.length > 0, true, "Graph へ出ている");
  for (const b of bodies) {
    assert.match(b, /0x36038e1d712c5e39f35952164ec58ec2b96caee7/, "小文字のアドレスで引いている");
    assert.equal(b.includes("0x36038E1D"), false, "大文字のまま引いていない");
    assert.match(b, /role:\s*RECIPIENT/, "受領側だけに絞っている");
  }
});

test("D15 source:subgraph の決定行に subgraphId と _meta.block が載る", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "252" }], _meta: { block: { number: 50824146 } } } } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minSubgraphReceipts: 1, source: "subgraph", graphApiKey: "SECRET_KEY_DO_NOT_LOG" } } });
  const ev = r.decision.evidence.find((e) => e.source === "subgraph");
  assert.ok(ev, "source:subgraph の evidence 行がある");
  assert.ok(ev.subgraphId, "subgraphId がある");
  assert.equal(typeof ev.block?.number, "number");
  // §2 #3: live であることの証跡。いつ引いたかが無いと、静的データと区別できない。
  assert.match(String(ev.queriedAt), /^\d{4}-\d{2}-\d{2}T/);
  // 決定行は追記専用 JSONL に残り、提出物にも載る。**呼び手の鍵をそこへ書き出さない。**
  // 引くときは鍵をパスに載せるので、決定行に入れる URL は鍵を伏せた方でなければならない。
  assert.equal(JSON.stringify(r.decision).includes("SECRET_KEY_DO_NOT_LOG"), false, "呼び手の鍵が決定行に漏れている");
  assert.equal(f.calls.some((u) => u.includes("SECRET_KEY_DO_NOT_LOG")), true, "実際の問い合わせには鍵が載っている（伏せる対象が実在する）");
});

test("D16 自社台帳の件数と subgraph の件数を1つの数に合算しない", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "gateway.thegraph.com"], {
    [DECISION]: decision(),
    "gateway.thegraph.com": { status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: "252" }], _meta: { block: { number: 1 } } } } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, minSubgraphReceipts: 100, source: "both" } } });
  const sources = r.decision.evidence.map((e) => e.source);
  assert.ok(sources.includes("vet402") && sources.includes("subgraph"), "両方が別の行として出る");
});

test("D16b 床は源ごとに当てる——合算した1つの数で当てると通ってしまう組み合わせで検算する", async () => {
  // D16 は「行が2本ある」ことしか見ていなかった（2026-09-05 の変異で判明）。件数を
  // **合算した1つの数**で床を当てる実装は、それでも緑のままだった。ここで塞ぐ。
  // 自社台帳 3 件・subgraph 252 件。合算 255 なら 254 の床を超えるが、
  // **subgraph 単独では 252 < 254 で足りない**。足した実装はここで緑になり、この検査で落ちる。
  const graph = (n) => ({ status: 200, body: { data: { x402AddressSummaries: [{ totalPayments: String(n) }], _meta: { block: { number: 1 } } } } });
  const run = (policy) => {
    const w = watchedAccount();
    const f = allowlistFetch([DECISION, "gateway.thegraph.com"], { [DECISION]: decision(), "gateway.thegraph.com": graph(252) });
    return payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: policy } });
  };
  const a = await run({ minL1Deliveries: 3, minSubgraphReceipts: 254, source: "both" });
  assert.equal(a.status, "refused");
  assert.equal(a.decision.reason_codes.includes("insufficient_subgraph_evidence"), true, "subgraph の床に自社台帳の件数を足していない");

  // 逆向き。自社台帳 3 件は 100 の床に足りない。subgraph の 252 を足して通してはいけない。
  const b = await run({ minL1Deliveries: 100, minSubgraphReceipts: 1, source: "both" });
  assert.equal(b.status, "refused");
  assert.equal(b.decision.reason_codes.includes("insufficient_delivery_evidence"), true, "自社台帳の床に subgraph の件数を足していない");
});

// ---------- E. 通過時 ----------

const paidPolicy = { evidence: { minL1Deliveries: 3, source: "vet402" } };

test("E17 全条件通過時のみ signer を1回呼び、返った txHash で attest する", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(),
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "paid");
  assert.equal(r.attested, true);
  assert.equal(r.txHash, "0xtx");
  assert.equal(w.signAccesses().length, 1);
});

test("E18 署名後に決済されなかった → failed を返し、隠さない", async () => {
  const w = watchedAccount();
  // 売り手が 402 を返し続ける（署名を受け取ったが決済しなかった）。
  const s = seller(okAccept, { paidStatus: 402, settlement: { success: false, transaction: "", errorReason: "insufficient_funds" } });
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: s.stub });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  // 署名は実在する。**何に署名したか**（nonce）も残る——これが無いと、後から
  // オンチェーンの tx をこの購入に結び付けられない（監査 P1-1 の nonce 束縛）。
  assert.match(String(r.nonce), /^0x[0-9a-f]{64}$/);
  assert.equal(s.paid.length, 1, "署名を付けて1回だけ再送している");
});

test("E18b 署名の後で再送の応答を読めず例外になっても throw しない——failed・signed:true・署名した nonce を返す", async () => {
  // 2026-09-06 の変異 M27（onSigned で nonce を控えない）が生き残った。ソースの
  // 「ここから先で落ちても『何に署名したか』は残る」は成り立っていなかった:
  // `executeX402Payment` が署名後に throw すると `decideAndPay` ごと throw し、
  // `signedNonce` は呼び手に返らない。署名した認可は validBefore まで生きた金なので、
  // 例外で nonce を失うのは「払ったかもしれないのに照合できない」を作る。
  //
  // fetch の reject は x402-pay.ts の中で吸収される（failed + nonce）。呼び手まで例外が届くのは
  // **再送の応答を読む段**——応答の headers を読んだ瞬間に throw する応答で再現する
  // （壊れた fetch シム／中間層が返す応答の形が違う、という実在の失敗の形）。
  const signed = [];
  const account = {
    address: "0xDB62BD202914609830fA656F87996b91be3Aa673",
    signTypedData: async (typedData) => { signed.push(String(typedData.message.nonce)); return "0xsig"; },
  };
  // allowlistFetch は応答の headers を包み直す（＝fetch の中で読む）ので、ここは素の fetch で書く。
  // 応答オブジェクトそのものは返し、**x402-pay が headers を読む瞬間**に throw させる。
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = String(url); calls.push(u);
    if (u.includes(DECISION)) return { ok: true, status: 200, json: async () => decision().body, headers: new Map() };
    if (!u.includes("kronos")) throw new Error(`forbidden call: ${u}`);
    const h = init?.headers ?? {};
    if (!(h["PAYMENT-SIGNATURE"] ?? h["payment-signature"])) {
      const w = wall(okAccept);
      return { ok: false, status: w.status, json: async () => w.body, headers: new Map(Object.entries(w.headers)) };
    }
    return { ok: true, status: 200, json: async () => ({}), get headers() { throw new Error("response headers unreadable"); } };
  };
  const r = await payOrRefuse({ ...base, account, fetch: fetchFn, policy: paidPolicy });
  assert.equal(calls.filter((u) => u.includes("kronos")).length, 2, "402 の壁 → 署名付き再送の2回");
  assert.equal(signed.length, 1, "署名器はちょうど1回");
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.equal(r.attested, false);
  assert.equal(r.txHash, null);
  assert.equal(r.nonce, signed[0], "返る nonce は署名器が実際に署名した nonce と一致する");
  assert.equal(r.decision.reason_codes.includes("settle_failed"), true);
});

// ---------- G. 支払いの経路そのもの（2026-09-05 の是正） ----------
//
// 直前の実装は `https://x402.org/facilitator/settle` を **買い手から** 叩いていた。
// x402 では買い手は facilitator を呼ばない——署名を載せて元のリクエストを売り手へ
// 再送し、決済は売り手（が使う facilitator）が行い、レシートは応答ヘッダで返る。
// 誤りのまま 09-08 に The Graph へ実支払いをすれば、金は動かず理由も残らなかった。

test("G-a 支払いは売り手への再送で行う——facilitator へは一度も出ない", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  // 許可リストに facilitator を**入れない**。出た瞬間に throw する（第2層）。
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(),
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "paid");
  assert.equal(f.calls.filter((u) => /facilitator|x402\.org|\/settle/.test(u)).length, 0, "facilitator へ出ていない");
  assert.equal(f.calls.filter((u) => u.includes("kronos")).length, 2, "売り手へ 402 取得＋支払い再送の2回");
});

test("G-b 再送は PAYMENT-SIGNATURE を付けた、同じ URL・同じ method（v2）", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(),
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, method: "POST", policy: paidPolicy });
  assert.equal(r.status, "paid");
  assert.equal(s.paid.length, 1);
  const sent = s.paid[0];
  assert.equal(sent.url, base.resource, "元の資源 URL へ再送している");
  assert.equal(sent.method, "POST", "元の method を保っている");
  assert.equal(sent.decoded.x402Version, 2);
  assert.equal(sent.decoded.resource.url, base.resource);
  assert.equal(sent.decoded.accepted.payTo, base.payee);
  assert.equal(sent.decoded.payload.signature, "0xsig");
  // EIP-3009 の認可。nonce は**我々しか作れない一回性の値**で、結果にも載る。
  const auth = sent.decoded.payload.authorization;
  assert.equal(auth.from.toLowerCase(), "0xdb62bd202914609830fa656f87996b91be3aa673");
  assert.equal(auth.to, base.payee);
  assert.equal(auth.value, "20000");
  assert.match(auth.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(auth.nonce, r.nonce, "署名した nonce が関数の外へ返っている");
});

test("G-c v1 のチャレンジには X-PAYMENT で答える（network slug も戻す）", async () => {
  const w = watchedAccount();
  // 本番に実在する v1 の形: network は "base" スラッグ、金額は maxAmountRequired。
  const v1Accept = { scheme: "exact", network: "base", maxAmountRequired: "20000", asset: okAccept.asset, payTo: base.payee };
  const s = seller(v1Accept, { x402Version: 1 });
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(),
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "paid", "v1 の壁にも払える");
  assert.equal(s.paid[0].header, "X-PAYMENT");
  assert.equal(s.paid[0].decoded.x402Version, 1);
  assert.equal(s.paid[0].decoded.network, "base", "v1 へはスラッグで返す");
});

test("G-d レシートは応答ヘッダから読む——本文の success は信じない", async () => {
  const w = watchedAccount();
  // ヘッダ無し・本文だけ success:true。ここで "paid" になる実装は本文を読んでいる。
  const s = seller(okAccept, { noReceipt: true });
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: s.stub });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "failed", "レシートヘッダが無いのだから決済は確認できていない");
  assert.equal(r.txHash, null, "本文の transaction を拾っていない");
  assert.equal(r.signed, true);
});

test("G-e attest は署名した nonce を載せる（その決済 tx がこの購入のものかの唯一の手がかり）", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const attests = [];
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(),
    kronos: s.stub,
    "payments/x402": (url, init) => {
      attests.push(JSON.parse(init.body));
      return { status: 200, body: { ok: true } };
    },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "paid");
  assert.equal(attests.length, 1);
  // 「どちらも null」で緑になる書き方をしない——実在する 32 バイトであることまで見る。
  assert.match(String(attests[0].authNonce), /^0x[0-9a-f]{64}$/);
  assert.equal(attests[0].authNonce, r.nonce);
  assert.equal(attests[0].txHash, "0xtx");
});

test("G-f 拒否経路では nonce が存在しない（署名していないのだから）", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION], { [DECISION]: decision({ recommendation: "BLOCK" }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.nonce, null);
  assert.deepEqual(w.signAccesses(), []);
});

test("G-g EIP-712 ドメインは売り手からではなくトークンから取る（署名前に矛盾を拒否）", async () => {
  const w = watchedAccount();
  // 売り手が name/version を偽って提示する。署名しても決済できない形なので、
  // 通せば「一円も動かないまま署名だけ生きている」状態を作れる（本番 2026-08-22 監査）。
  const s = seller({ ...okAccept, extra: { assetTransferMethod: "eip3009", name: "Evil Coin", version: "9" } });
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: s.stub });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("chain_or_asset_mismatch"), true);
  assert.equal(s.paid.length, 0, "再送していない");
  assert.deepEqual(w.signAccesses(), []);
});

// ---------- F. 汚染しない ----------

// 決定行は **1本のローカル追記専用 JSONL** に、行ごと `source` で区別して入れる
// （WINDOW_PLAN §2 #4・2026-09-05 の設計判断）。別ファイルに分けると F20 が構造的に
// 自明になり、テストが何も証明しなくなる。同じ store に混ぜて、**読み手が正しく分ける**
// ことを要求してはじめて混線が検出できる。本番 DB へは一切書かない（会期中は実装凍結）。
function tempStore() {
  return join(mkdtempSync(join(tmpdir(), "vet402-decisions-")), "decisions.jsonl");
}

test("F19 デモの決定行は source: agent-demo で、L1 台帳へは書かない", async () => {
  const store = tempStore();
  const w = watchedAccount();
  const s = seller(okAccept);
  const writes = [];
  const f = {
    fetch: async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") writes.push({ u, method });
      if (u.includes(DECISION)) return { ok: true, status: 200, json: async () => decision().body, headers: new Map() };
      const r = u.includes("kronos") ? s.stub(u, init) : { status: 200, body: { ok: true }, headers: {} };
      return { ok: r.status < 400, status: r.status, json: async () => r.body, headers: new Map(Object.entries(r.headers ?? {})) };
    },
  };
  // デモの支払い先（The Graph の x402 口）と同じ POST。再送も書き込み系として数えられる。
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, method: "POST", source: "agent-demo", decisionStore: store, policy: paidPolicy });
  assert.equal(r.status, "paid", "実装が最後まで動いた証拠");
  assert.equal(s.paid.length, 1, "支払いの再送は1回だけ");

  // 支払い経路（売り手の資源）と attest 以外に、書き込み系の fetch が1本も出ない。
  const onPaymentPath = (u) => u === base.resource || u.includes("payments/x402");
  assert.deepEqual(writes.filter((x) => !onPaymentPath(x.u)), [], "支払い経路以外の書き込み系 fetch が出ている");
  assert.equal(writes.length, 3, "402 取得・支払い再送・attest の3本だけ（POST 資源なので全部書き込み系）");
  assert.equal(writes.some((x) => /\/l1|purchases|observatory/.test(x.u)), false, "L1 台帳へ書きに行っていない");

  // 決定行は store に1行だけ入り、source は agent-demo。
  assert.equal(r.stored, true, "台帳に書けたことが機械可読で残る");
  assert.equal(r.storeError, null);
  const demo = await readDemoDecisions({ store });
  assert.equal(demo.length, 1);
  assert.equal(demo[0].source, "agent-demo");
  assert.equal(demo[0].recommendation, "ALLOW");
  assert.equal(readFileSync(store, "utf8").trim().split("\n").length, 1, "追記専用の JSONL に1行");
  // 同じ store を L1 として読んでも、デモ行は出てこない。
  assert.deepEqual(await readL1Decisions({ store }), []);
});

test("F20 L1 フィードはデモ行を無視し、デモフィードは L1 行を無視する", async () => {
  const store = tempStore();
  const w = watchedAccount();
  const mk = async (source) => {
    const s = seller(okAccept);
    const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
      [DECISION]: decision(),
      kronos: s.stub,
      "payments/x402": { status: 200, body: { ok: true } },
    });
    return payOrRefuse({ ...base, account: w.account, fetch: f.fetch, source, decisionStore: store, policy: paidPolicy });
  };
  // **同じ store** に両方入れる。分けて置いたら、この検査は何も証明しない。
  await mk("agent-demo");
  await mk("vet402");
  await mk("agent-demo");
  assert.equal(readFileSync(store, "utf8").trim().split("\n").length, 3, "3行とも同じファイルにある");

  const demo = await readDemoDecisions({ store });
  const l1 = await readL1Decisions({ store });
  assert.equal(demo.length, 2);
  assert.equal(l1.length, 1);
  assert.equal(demo.every((d) => d.source === "agent-demo"), true);
  assert.equal(l1.some((d) => d.source === "agent-demo"), false);
  assert.equal(l1.every((d) => d.source === "vet402"), true);
  assert.equal(demo.some((d) => d.source === "vet402"), false);
});

test("F21 壊れた行があっても読める（追記専用ファイルは途中で千切れ得る）", async () => {
  const store = tempStore();
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(
    store,
    JSON.stringify({ source: "agent-demo", recommendation: "REFUSE", reason_codes: ["payee_mismatch"] }) +
      "\n{ちぎれた\n" +
      JSON.stringify({ source: "vet402", recommendation: "ALLOW", reason_codes: [] }) +
      "\n",
  );
  assert.equal((await readDemoDecisions({ store })).length, 1);
  assert.equal((await readL1Decisions({ store })).length, 1);
});

test("F23 store への追記が失敗しても、支払いの結果（nonce / txHash）は失われない", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(), kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
  });
  // 実在するファイルの**下**を store に指定する → ENOTDIR。書けない store の典型。
  const file = tempStore();
  writeFileSync(file, "");
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, source: "agent-demo", decisionStore: join(file, "nope.jsonl"), policy: paidPolicy });
  // 金は動いている。台帳に書けなかったことを理由に結果を握り潰さない——
  // 握り潰すと「払ったのに nonce も txHash も残らない」が最悪の形で起きる。
  assert.equal(r.status, "paid");
  assert.equal(r.txHash, "0xtx");
  assert.match(String(r.nonce), /^0x[0-9a-f]{64}$/);
  // ただし黙って成功にはしない。書けなかったことは機械可読で残す（fail-loud）。
  assert.equal(r.stored, false);
  assert.ok(r.storeError && r.storeError.length > 0, "書けなかった理由が残る");
});

test("F22 store が無ければ空を返す（存在しないことと空であることを区別して落とさない）", async () => {
  const store = join(tempStore(), "..", "never-written.jsonl");
  assert.deepEqual(await readDemoDecisions({ store }), []);
  assert.deepEqual(await readL1Decisions({ store }), []);
});

// ---------- H. ネガティブコントロール（これが無いと「0回」は無意味） ----------

test("H22 ネガティブコントロール: 同じハーネスで ALLOW を通すと signTypedData がちょうど1回・支払い再送がちょうど1回出る", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const calls = [];
  const f = {
    fetch: async (url, init) => {
      const u = String(url); calls.push(u);
      if (u.includes(DECISION)) return { ok: true, status: 200, json: async () => decision().body, headers: new Map() };
      const r = u.includes("kronos") ? s.stub(u, init) : { status: 200, body: { ok: true }, headers: {} };
      return { ok: r.status < 400, status: r.status, json: async () => r.body, headers: new Map(Object.entries(r.headers ?? {})) };
    },
  };
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "paid");
  assert.equal(w.signAccesses().length, 1, "計測器は「1回」を検出できる（0回が配線ミスでない証明）");
  // 支払いは売り手への再送1回だけ。facilitator は買い手の経路に存在しない。
  assert.equal(s.paid.length, 1);
  assert.equal(calls.filter((u) => /facilitator|\/settle/.test(u)).length, 0);
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
  const s = seller(graphAccept);
  // facilitator は許可リストに**入れない**——買い手の経路に存在しないから（G-a）。
  const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com", "payments/x402"], {
    [DECISION]: notFound,
    [SCORE]: payeeScore({ recommendation: "ALLOW", score: 74, dataDepth: "moderate" }),
    "gateway.thegraph.com": s.stub,
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
  // デモの支払い先は POST の x402 口。署名を付けた再送が1回だけ出る。
  assert.equal(s.paid.length, 1);
  assert.equal(s.paid[0].method, "POST");
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

// ---------- J. policy.requireVet402Allow（WINDOW_PLAN §3.2・2026-09-05 の決定） ----------
//
// **本番実測**: デモの支払い先 The Graph `0x79DC34E4…FcCB` は 69 / WARN / thin。
// 既定のままでは `payee_recommendation_not_allow` で止まり、台本の実 tx カットが撮れない。
//
// 決めたのは「vet402 を信じなくてよい」を**製品の規則として明示的に書けるようにする**こと。
//   - 既定は `true`（今日と同じ fail-closed）。**黙って弱くならない**
//   - `false` のとき、vet402 の推奨が ALLOW でなくても、**呼び手が宣言した証拠の床が
//     すべて満たされていれば**払う
//   - **床を1つも宣言せずに `false` にしたら呼び出し側エラー**（`invalid_policy`）。
//     「誰も判定しない」状態を作らせない。0 の床は床ではない（何も判定しない）
//   - 通したときは決定行に**どの規則で通したか**が残る（`verdict_source: "caller_policy"` と
//     満たした床の内訳）。審査員が読むのはここ
//   - **カタログ内（200）でもカタログ外（404）でも同じ規則**。404 経路だけの特例にしない

/** WARN を返す `/decision`（本番の The Graph と同じ状態を、カタログ内の形で置く）。 */
const warnDecision = (over = {}) =>
  decision({ recommendation: "WARN", reason_codes: ["l0_pass", "l1_not_attempted"], ...over });

const graphBody = (n) => ({
  status: 200,
  body: { data: { x402AddressSummaries: [{ role: "RECIPIENT", totalPayments: String(n) }], _meta: { block: { number: 50890586 } } } },
});

test("J1 既定は fail-closed——requireVet402Allow を書かなければ WARN は署名前に止まる", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  // 売り手は**正常に払える状態**で置く。止めているのが ALLOW ゲートだけであることを見る。
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: warnDecision(), kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { evidence: { minL1Deliveries: 3, source: "vet402" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("payee_recommendation_not_allow"), true);
  assert.equal(s.paid.length, 0, "署名を付けた再送が出ていない");
  assert.deepEqual(w.signAccesses(), []);
});

test("J1b requireVet402Allow: true を明示しても同じ（既定と明示が一致している）", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: warnDecision(), kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({
    ...base, account: w.account, fetch: f.fetch,
    policy: { requireVet402Allow: true, evidence: { minL1Deliveries: 3, source: "vet402" } },
  });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("payee_recommendation_not_allow"), true);
  assert.deepEqual(w.signAccesses(), []);
});

test("J2 床を1つも宣言せずに requireVet402Allow: false → 呼び出し側エラー（通信の前に落ちる）", async () => {
  const w = watchedAccount();
  let fetched = 0;
  const f = { fetch: async () => { fetched++; throw new Error("must not be called"); } };
  const isPolicyError = (e) => /invalid_policy/.test(String(e && e.message));
  // (a) evidence を丸ごと書かなかった
  await assert.rejects(
    () => payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { requireVet402Allow: false } }),
    isPolicyError,
  );
  // (b) evidence はあるが床が1つも無い（source を選んだだけ）
  await assert.rejects(
    () => payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { requireVet402Allow: false, evidence: { source: "vet402" } } }),
    isPolicyError,
  );
  // (c) **0 の床は床ではない。** 何も判定しないので「誰も判定しない」状態と同じ。
  //     ここを許すと、規則を1語足しただけで全部素通しにできてしまう。
  await assert.rejects(
    () => payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 0, source: "vet402" } } }),
    isPolicyError,
  );
  assert.equal(fetched, 0, "判定も 402 も引いていない（呼び出し側の誤りは通信の前に落とす）");
  assert.deepEqual(w.signAccesses(), []);
  // エラー文は**原因そのもの**を名指しする（`invalid_evidence_policy` と同じ思想）。
  const err = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { requireVet402Allow: false } }).catch((e) => e);
  assert.match(String(err.message), /requireVet402Allow/);
  assert.match(String(err.message), /minL1Deliveries|minSubgraphReceipts/);
});

test("J3 requireVet402Allow: false ＋ 床を満たす → カタログ内 WARN でも払う（規則が決定行に残る）", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: warnDecision(), kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({
    ...base, account: w.account, fetch: f.fetch,
    policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 3, source: "vet402" } },
  });
  assert.equal(r.status, "paid");
  assert.equal(w.signAccesses().length, 1);
  // **どの規則で通したか**。ここを読むのが審査員。
  assert.equal(r.decision.verdict_source, "caller_policy", "vet402 の判定ではなく呼び手の規則で通ったことが残る");
  assert.equal(r.decision.reason_codes.includes("allowed_by_caller_policy"), true);
  // vet402 が何と言っていたかは**消えない**。黙って弱くなっていないことの証拠。
  assert.equal(r.decision.reason_codes.includes("l1_not_attempted"), true, "WARN の理由がそのまま残る");
  const o = r.decision.policy_override;
  assert.ok(o, "policy_override が無い");
  assert.equal(o.rule, "requireVet402Allow:false");
  assert.equal(o.waived.source, "decision");
  assert.equal(o.waived.recommendation, "WARN");
  assert.deepEqual(o.waived.reason_codes, ["l0_pass", "l1_not_attempted"]);
  // 満たした床の**内訳**。「床を見たふり」を潰すため、要求値と実測値の両方を要求する。
  assert.deepEqual(o.floors_met, [{ floor: "minL1Deliveries", source: "vet402", required: 3, observed: 3 }]);
});

test("J4 requireVet402Allow: false でも、床を満たさなければ払わない", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: warnDecision({ facts: { l0: { status: "pass" }, l1: { n_delivered: 1, n_attempts: 1 }, l2: { status: "undeclared" } } }),
    kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({
    ...base, account: w.account, fetch: f.fetch,
    policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 3, source: "vet402" } },
  });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("insufficient_delivery_evidence"), true);
  assert.equal(r.decision.policy_override, null, "通していないのに「通した規則」を記帳しない");
  assert.equal(s.paid.length, 0, "署名を付けた再送が出ていない");
  assert.deepEqual(w.signAccesses(), []);
});

test("J5 カタログ外（404）でも同じ規則が効く——WARN 69 の The Graph に、subgraph の床で払う", async () => {
  // **これがデモの実物**（WINDOW_PLAN §3.1・§3.2）。カタログ 404・受取人スコア 69/WARN/thin・
  // The Graph 自身の subgraph は 253 件の受領を知っている。呼び手はその第三者データを床にする。
  const w = watchedAccount();
  const s = seller(graphAccept);
  const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com", "payments/x402"], {
    [DECISION]: notFound,
    "/api/x402/": s.stub,
    "/api/graphkey/": graphBody(253),
    [SCORE]: payeeScore(),
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({
    ...uncatalogued, account: w.account, fetch: f.fetch,
    policy: {
      requireVet402Allow: false,
      evidence: { source: "both", minL1Deliveries: 0, minSubgraphReceipts: 1, graphApiKey: "graphkey" },
    },
  });
  assert.equal(r.status, "paid");
  assert.equal(w.signAccesses().length, 1);
  assert.equal(s.paid.length, 1, "署名を付けた再送が1回だけ出ている");
  assert.equal(r.decision.verdict_source, "caller_policy");
  // 404 経路であることは**独立に**残る（経路の印と、通した規則は別のこと）。
  assert.equal(r.decision.reason_codes.includes("resource_uncatalogued"), true);
  assert.equal(r.decision.reason_codes.includes("allowed_by_caller_policy"), true);
  const o = r.decision.policy_override;
  assert.ok(o, "policy_override が無い");
  assert.equal(o.waived.source, "payee_score", "404 経路では受取人スコアを waive したと残る");
  assert.equal(o.waived.recommendation, "WARN");
  assert.equal(o.waived.score, 69, "何点だったかが残る（69 のまま通した、が読める）");
  // 床の内訳は**源ごと**。subgraph の 253 が自社台帳の数と混ざっていない。
  assert.deepEqual(o.floors_met, [
    { floor: "minL1Deliveries", source: "vet402", required: 0, observed: 0 },
    { floor: "minSubgraphReceipts", source: "subgraph", required: 1, observed: 253 },
  ]);
  // 受取人スコアそのものも決定行に残る（69 を隠して通していない）。
  assert.equal(r.decision.payeeScore.score, 69);
});

test("J6 カタログ外でも、床を満たさなければ払わない", async () => {
  const w = watchedAccount();
  const s = seller(graphAccept);
  const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com", "payments/x402"], {
    [DECISION]: notFound,
    "/api/x402/": s.stub,
    "/api/graphkey/": graphBody(3),
    [SCORE]: payeeScore(),
  });
  const r = await payOrRefuse({
    ...uncatalogued, account: w.account, fetch: f.fetch,
    policy: {
      requireVet402Allow: false,
      evidence: { source: "subgraph", minSubgraphReceipts: 100, graphApiKey: "graphkey" },
    },
  });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("insufficient_subgraph_evidence"), true);
  assert.equal(r.decision.policy_override, null);
  assert.equal(s.paid.length, 0);
  assert.deepEqual(w.signAccesses(), []);
});

test("J10 requireVet402Allow: false でも BLOCK は通さない——WARN は意見、BLOCK は遮断", async () => {
  // WINDOW_PLAN §3.2.1。BLOCK は「我々の意見」ではなく運営者のグローバル遮断
  // （既知の詐欺・自己取引）で、呼び手が床を宣言していても払ってはいけない相手。
  // **この検査を消すと、SDK が遮断先へ払う道具になる。** 緩和の変更で黙って外れないよう固定する。

  // (a) カタログ内（/decision が BLOCK を返す）。床はすべて満たしている状態で呼ぶ。
  {
    const w = watchedAccount();
    const s = seller(okAccept);
    const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
      [DECISION]: decision({ recommendation: "BLOCK", reason_codes: ["operator_blacklist"] }),
      kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
    });
    const r = await payOrRefuse({
      ...base, account: w.account, fetch: f.fetch,
      policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 3, source: "vet402" } },
    });
    assert.equal(r.status, "refused", "BLOCK は呼び手の床では外れない");
    assert.equal(r.decision.reason_codes.includes("payee_recommendation_block"), true,
      `BLOCK を名指しした理由が無い: ${r.decision.reason_codes.join(",")}`);
    assert.equal(r.decision.reason_codes.includes("allowed_by_caller_policy"), false,
      "BLOCK を呼び手の policy で通したと記録してはいけない");
    assert.equal(s.paid.length, 0, "売り手へ支払い付きの再送をしていない");
    assert.deepEqual(w.signAccesses(), [], "署名器に到達していない");
  }

  // (b) カタログ外（/decision 404 → 受取人スコアが BLOCK）。同じ規則が対称に効く。
  // 402 の壁も subgraph も gateway.thegraph.com なので、**subgraph の id で鍵を分ける**。
  {
    const w = watchedAccount();
    const s = seller(graphAccept);
    const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com", "payments/x402"], {
      [DECISION]: notFound,
      [SCORE]: payeeScore({ recommendation: "BLOCK", score: 12, dataDepth: "thin" }),
      "id/Cb56": { status: 200, body: { data: { x402AddressSummaries: [{ role: "RECIPIENT", totalPayments: "253" }], _meta: { block: { number: 50891626 }, deployment: "Qm" } } } },
      "gateway.thegraph.com": s.stub,
      "payments/x402": { status: 200, body: { ok: true } },
    });
    const r = await payOrRefuse({
      ...uncatalogued, account: w.account, fetch: f.fetch,
      policy: { requireVet402Allow: false,
                evidence: { minSubgraphReceipts: 1, source: "subgraph", graphApiKey: "k" } },
    });
    assert.equal(r.status, "refused", "404 経路でも BLOCK は外れない");
    assert.equal(r.decision.reason_codes.includes("payee_recommendation_block"), true,
      `BLOCK を名指しした理由が無い: ${r.decision.reason_codes.join(",")}`);
    assert.equal(s.paid.length, 0);
    assert.deepEqual(w.signAccesses(), []);
  }
});

test("J7 requireVet402Allow: false は degraded を通さない——「測れなかった」と「ALLOW でない」は別のこと", async () => {
  // 免除したのは**判定の中身**であって、判定が存在しないことではない。
  // ここを一緒にすると、fail-closed が丸ごと外れる。
  const runCatalogued = async (over) => {
    const w = watchedAccount();
    const s = seller(okAccept);
    const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
      [DECISION]: decision(over), kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
    });
    const r = await payOrRefuse({
      ...base, account: w.account, fetch: f.fetch,
      policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 3, source: "vet402" } },
    });
    return { r, w, s };
  };
  const a = await runCatalogued({ degraded: true });
  assert.equal(a.r.status, "refused");
  assert.equal(a.r.decision.reason_codes.includes("evidence_unavailable"), true);
  assert.equal(a.s.paid.length, 0);
  assert.deepEqual(a.w.signAccesses(), []);

  // 404 経路も対称。スコアが degraded / 一部未測定なら通さない。
  const runUncatalogued = async (scoreOver) => {
    const w = watchedAccount();
    const s = seller(graphAccept);
    const f = allowlistFetch([DECISION, SCORE, "gateway.thegraph.com", "payments/x402"], {
      [DECISION]: notFound,
      "/api/x402/": s.stub,
      "/api/graphkey/": graphBody(253),
      [SCORE]: payeeScore(scoreOver),
    });
    const r = await payOrRefuse({
      ...uncatalogued, account: w.account, fetch: f.fetch,
      policy: { requireVet402Allow: false, evidence: { source: "subgraph", minSubgraphReceipts: 1, graphApiKey: "graphkey" } },
    });
    return { r, w, s };
  };
  const b = await runUncatalogued({ degraded: true });
  assert.equal(b.r.status, "refused");
  assert.equal(b.r.decision.reason_codes.includes("evidence_unavailable"), true);
  assert.deepEqual(b.w.signAccesses(), []);
  const c = await runUncatalogued({ signalsUnavailable: ["receiving"] });
  assert.equal(c.r.status, "refused");
  assert.equal(c.r.decision.reason_codes.includes("evidence_unavailable"), true);
  assert.deepEqual(c.w.signAccesses(), []);
});

test("J8 vet402 が ALLOW なら、requireVet402Allow: false でも「呼び手の規則で通した」とは書かない", async () => {
  // 上書きしていないのに上書きしたと記帳するのは、決定行を読めなくする。
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(), kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({
    ...base, account: w.account, fetch: f.fetch,
    policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 3, source: "vet402" } },
  });
  assert.equal(r.status, "paid");
  assert.equal(r.decision.verdict_source, "decision", "vet402 が通したのだから vet402 が判定源");
  assert.equal(r.decision.policy_override, null);
  assert.equal(r.decision.reason_codes.includes("allowed_by_caller_policy"), false);
});

test("J9 通した規則は追記専用 JSONL の行にもそのまま残る（後から誰でも読める）", async () => {
  const store = tempStore();
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: warnDecision(), kronos: s.stub, "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({
    ...base, account: w.account, fetch: f.fetch, source: "agent-demo", decisionStore: store,
    policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 3, source: "vet402" } },
  });
  assert.equal(r.status, "paid");
  assert.equal(r.stored, true);
  const [row] = await readDemoDecisions({ store });
  assert.equal(row.verdict_source, "caller_policy");
  assert.equal(row.reason_codes.includes("allowed_by_caller_policy"), true);
  assert.equal(row.policy_override.waived.recommendation, "WARN");
  assert.deepEqual(row.policy_override.floors_met, [{ floor: "minL1Deliveries", source: "vet402", required: 3, observed: 3 }]);
});

// ---------- K. 402 の accepts から**条件を満たすもの**を選ぶ ----------
//
// **実測**（拒否側フィクスチャ `agent.api.0x.org`）: 402 は accept を**3件**返す——
// Base USDC / Solana / Base の `GatewayWalletBatched` ドメイン。今は先頭がたまたま
// 正しい Base USDC だが、**売り手が順序を変えれば SDK は Solana を掴み
// `chain_or_asset_mismatch` で拒む**。拒否は変わらないが**理由がすり替わる**。
// デモの画が壊れ、「拒否の理由は正確である」という主張も壊れる。
//
// 選び方は本番 `src/lib/observatory/x402-payer.ts` の `selectAccept` と同じ意味論:
// scheme exact ∧ network eip155:8453 ∧ Base 正規 USDC ∧ eip3009（未提示は可）。

const solanaAccept = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "10000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: base.payee,
};
/** 実測の1件目。Base USDC で、EIP-712 ドメインをトークンの実測値どおり名乗る。 */
const usdcDomainAccept = {
  ...okAccept,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
};
/** 実測の3件目。同じ Base USDC だが EIP-712 ドメインが `GatewayWalletBatched` を名乗る。 */
const batchedDomainAccept = {
  ...okAccept,
  extra: { assetTransferMethod: "eip3009", name: "GatewayWalletBatched", version: "1" },
};
const walls = (accepts, version = 2) => ({
  status: 402, body: {}, headers: { "payment-required": b64({ x402Version: version, accepts }) },
});

test("K1 条件を満たす accept が先頭でなくても、それを選んで払う", async () => {
  const w = watchedAccount();
  const paid = [];
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(),
    kronos: (url, init) => {
      const h = init?.headers ?? {};
      const raw = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"];
      if (!raw) return walls([solanaAccept, okAccept]);
      paid.push(JSON.parse(atob(raw)));
      return { status: 200, body: { ok: true }, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx", network: "eip155:8453", payer: "0xDB62BD202914609830fA656F87996b91be3Aa673" }) } };
    },
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "paid", "先頭の Solana を掴んで拒否していない");
  assert.equal(r.challenge.network, "eip155:8453");
  assert.equal(r.challenge.asset, okAccept.asset);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].accepted.network, "eip155:8453", "署名したのは Base USDC の accept");
  assert.equal(w.signAccesses().length, 1);
});

test("K2 条件を満たす accept が1つも無ければ、そのことを名指しして拒否する", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronos"], {
    [DECISION]: decision(),
    kronos: walls([solanaAccept, { ...solanaAccept, network: "eip155:1" }]),
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("no_eligible_accept"), true, "「払える accept が1つも無い」と名指ししている");
  // **一次の所見はそれ**。「たまたま掴んだ1件がチェーン違いだった」ではなく
  // 「全部見たが1件も払えなかった」が先に立つ。並び順まで固定する。
  assert.equal(
    r.decision.reason_codes.indexOf("no_eligible_accept") <
      r.decision.reason_codes.indexOf("chain_or_asset_mismatch"),
    true,
    "一次の所見が先に来ていない",
  );
  // 壁は読めている。「402 が読めなかった」ではない。
  assert.equal(r.decision.reason_codes.includes("evidence_unavailable"), false);
  // 見た accept は**実際に提示されたもの**（存在しないものを画に出さない）。
  assert.equal(r.challenge.network, solanaAccept.network);
  assert.deepEqual(w.signAccesses(), []);
});

test("K2b 402 そのものが読めないのは今まで通り evidence_unavailable（別の状態と混ぜない）", async () => {
  const w = watchedAccount();
  const f = allowlistFetch([DECISION, "kronos"], { [DECISION]: decision(), kronos: { status: 402, body: {}, headers: {} } });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("evidence_unavailable"), true);
  assert.equal(r.decision.reason_codes.includes("no_eligible_accept"), false);
  assert.deepEqual(w.signAccesses(), []);
});

test("K3 EIP-712 ドメインが正規でない Base USDC より、正規のものを選ぶ（実測の3件目の形）", async () => {
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
    [DECISION]: decision(),
    kronos: (url, init) => {
      const h = init?.headers ?? {};
      if (!(h["PAYMENT-SIGNATURE"] ?? h["payment-signature"])) return walls([batchedDomainAccept, usdcDomainAccept]);
      return s.stub(url, init);
    },
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
  assert.equal(r.status, "paid", "偽ドメインの1件目を掴んで chain_or_asset_mismatch にしていない");
  assert.equal(r.challenge.extra.name, "USD Coin");
  assert.equal(w.signAccesses().length, 1);
});

test("K4 実測の3件を**どの順に並べ替えても**、選ぶ accept と結論は変わらない", async () => {
  // 売り手は順序を自由に決められる。順序で結論が変わるなら、それは売り手が我々の
  // 判定を動かせるということ。6通りの順列すべてで同じ accept を選ぶことを要求する。
  const three = [usdcDomainAccept, solanaAccept, batchedDomainAccept];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const order of permutations) {
    const w = watchedAccount();
    const s = seller(okAccept);
    const f = allowlistFetch([DECISION, "kronos", "payments/x402"], {
      [DECISION]: decision(),
      kronos: (url, init) => {
        const h = init?.headers ?? {};
        if (!(h["PAYMENT-SIGNATURE"] ?? h["payment-signature"])) return walls(order.map((i) => three[i]));
        return s.stub(url, init);
      },
      "payments/x402": { status: 200, body: { ok: true } },
    });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: paidPolicy });
    assert.equal(r.status, "paid", `順序 ${order.join("")} で払えていない`);
    assert.equal(r.challenge.network, "eip155:8453", `順序 ${order.join("")}`);
    assert.equal(r.challenge.extra.name, "USD Coin", `順序 ${order.join("")} で偽ドメインを掴んでいる`);
    assert.equal(w.signAccesses().length, 1, `順序 ${order.join("")}`);
  }
});

test("D17 /decision が名乗った source を SDK が塗り替えない（行の出どころを消さない）", async () => {
  // 2026-09-05: SDK は /decision の行を `source: "vet402"` で**作り直して**いた。
  // 本番の /decision は自社台帳の行しか出さないので今日は同じ値になるが、
  // 「サーバが名乗った源」と「SDK が決め打ちした源」は別のことである。
  // 名乗りを無視する実装は、サーバが別の源の行を出した瞬間に**嘘をつく**——
  // しかも値が入っているので壊れて見えない（llm-output-contract と同じ型）。
  const w = watchedAccount();
  const live = {
    level: "L1",
    source: "subgraph",
    url: "https://gateway.thegraph.com/api/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
    subgraphId: "Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
    block: { number: 50888579 },
    deployment: "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN",
    queriedAt: "2026-09-05T09:00:00.000Z",
    receipts: 253,
  };
  const f = allowlistFetch([DECISION], {
    [DECISION]: decision({ evidence: [live] }),
  });
  // ALLOW で通し、402 は許可リスト外にして署名前で止める。見るのは判定ではなく
  // 「サーバが名乗った源が決定行にどう残るか」だけ。
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused", "402 を読めないので署名前に止まる");
  const row = r.decision.evidence.find((e) => e.url === live.url);
  assert.ok(row, "サーバの行が決定行に残る");
  assert.equal(row.source, "subgraph", "サーバが名乗った源を vet402 に塗り替えていない");
  assert.equal(row.subgraphId, live.subgraphId, "live の証跡（subgraphId）を落としていない");
  assert.equal(row.block?.number, live.block.number, "live の証跡（block.number）を落としていない");
  assert.equal(row.deployment, live.deployment);
  assert.equal(row.queriedAt, live.queriedAt);
  assert.equal(row.receipts, live.receipts, "その源が知っている件数は行ごとに残る");
  assert.deepEqual(w.signAccesses(), []);
});

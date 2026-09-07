// `refuse` —— 台本 0:45–1:15 / 1:15–1:30。
//
// 検査するのは2つ。
//  (1) **秘密が1文字も出ない。** 撮影で映るので、これが最優先（WINDOW_PLAN §6）
//  (2) 2つの独立した源の値が**両方**画に出て、署名は存在しない
import test from "node:test";
import assert from "node:assert/strict";
import { runRefuse, REFUSE_TARGET } from "../src/refuse.ts";
import { createEmitter } from "../src/emit.ts";
import { collectSecrets } from "../src/redact.ts";

const GRAPH_KEY = "gk-0123456789abcdef0123456789abcdef";
const VOUCH_KEY = "vk-fedcba9876543210fedcba9876543210";
const PRIVATE_KEY = "0x" + "ee".repeat(32);
const env = { GRAPH_API_KEY: GRAPH_KEY, VOUCH_API_KEY: VOUCH_KEY, DEMO_PAYER_PRIVATE_KEY: PRIVATE_KEY };

const DECISION_BODY = {
  subject: { type: "resource", id: "8146a86d", canonical_url: REFUSE_TARGET.url, method: "GET" },
  role: "payer",
  recommendation: "WARN",
  // 2026-09-08: rules 2026-09-08.1。1 回決済して 4xx の相手は「未試行」でなく「結論なし」（l1_inconclusive）。
  reason_codes: ["l0_pass", "l1_inconclusive", "l2_undeclared"],
  facts: {
    l0: { status: "pass", observed_at: "2026-09-04 17:40:13.970619+00", dialect: "both", fail_reason: null },
    l1: { n_delivered: 0, n_settled: 1, n_attempts: 1, n_inconclusive: 1, n_probe_error: 1, p50_ms: null, p95_ms: null, last_purchase_id: null, observed_at: null },
    l2: { status: "undeclared" },
  },
  freshness: { l0: "2026-09-04 17:40:13.970619+00", l1: null, l2: null },
  evidence: [{ level: "L0", url: "https://vet402.com/observatory/e/5f824113" }],
  degraded: false,
  scoredAt: "2026-09-05T01:06:13.414Z",
};

const SUBGRAPH_BODY = {
  data: {
    _meta: { block: { number: 50890518, timestamp: 1788570383 }, deployment: "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN" },
    x402AddressSummaries: [
      {
        id: "0x01000000b15a55e8",
        address: REFUSE_TARGET.payee.toLowerCase(),
        role: "RECIPIENT",
        totalPayments: "29",
        totalVolumeDecimal: "0.29",
        firstPaymentTimestamp: "1779151771",
        lastPaymentTimestamp: "1786811303",
      },
    ],
  },
};

function stubFetch() {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    const reply = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Map(),
    });
    if (u.includes("/decision")) return reply(200, DECISION_BODY);
    if (u.includes("gateway.thegraph.com")) return reply(200, SUBGRAPH_BODY);
    throw new Error(`unexpected call in refuse path: ${u}`);
  };
  return { fetch, calls };
}

/** 署名器へ「触れた」瞬間に落ちる account。拒否経路には最初から署名の手段が無い。 */
function tripwireAccount() {
  return new Proxy({}, { get(_t, p) { throw new Error(`tripwire: refuse path touched account.${String(p)}`); } });
}

async function run() {
  const out = [];
  const f = stubFetch();
  const result = await runRefuse({
    env,
    fetch: f.fetch,
    account: tripwireAccount(),
    emit: createEmitter({ sink: (line) => out.push(line), secrets: collectSecrets(env) }),
  });
  return { out, result, calls: f.calls };
}

test("秘密は1文字も出力に現れない（撮影で映る画面なので最優先）", async () => {
  const { out } = await run();
  const text = out.join("\n");
  for (const secret of [GRAPH_KEY, VOUCH_KEY, PRIVATE_KEY, PRIVATE_KEY.slice(2)]) {
    assert.equal(text.includes(secret), false, `秘密が出力に残っている: ${secret.slice(0, 6)}…`);
  }
  // 空振りで緑にならないこと: 鍵が載る URL は実際に画へ出ており、伏せた印が残っている。
  assert.match(text, /gateway\.thegraph\.com\/api\/<KEY>\/subgraphs\//, "鍵付き URL がそもそも画に出ていない");
});

test("2つの独立した源が、同じアドレスについて別々のことを言っているのが画に出る", async () => {
  const { out, result } = await run();
  const text = out.join("\n");
  // [A] 我々: 見た（l0_pass）が買っていない（L1 0）
  assert.match(text, /WARN/);
  assert.match(text, /l0_pass/);
  assert.match(text, /l1_inconclusive/);
  assert.doesNotMatch(text, /l1_not_attempted/, "1 回決済した相手を未試行と描かない（2026-09-08）");
  // [B] The Graph: 同じアドレスの受領 29 件を、block 50890518 時点で知っている
  assert.match(text, /totalPayments/);
  assert.match(text, /\b29\b/);
  assert.match(text, /50890518/);
  assert.match(text, /QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN/);
  assert.equal(result.view.subgraph.row.role, "RECIPIENT");
  assert.equal(result.view.vet402.recommendation, "WARN");
});

test("署名は存在しない——status も nonce も、それを機械可読で言う", async () => {
  const { out, result } = await run();
  assert.equal(result.result.status, "refused");
  assert.equal(result.result.signed, false);
  assert.equal(result.result.nonce, null);
  assert.equal(result.result.decision.reason_codes.includes("payee_recommendation_not_allow"), true);
  assert.match(out.join("\n"), /signed\s+false/);
});

test("拒否経路の証拠行には、live を読んだ証跡（block と deployment）が入る", async () => {
  const { result } = await run();
  const row = result.result.decision.evidence.find((e) => e.source === "subgraph");
  assert.ok(row, "subgraph の証拠行が無い");
  assert.equal(row.block.number, 50890518);
  assert.equal(row.deployment, "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN");
  assert.equal(row.receipts, 29);
  // 証拠行の URL に鍵が載っていない（決定行はそのまま台帳へ行く）。
  assert.equal(row.url.includes(GRAPH_KEY), false);
});

test("Graph の鍵が無ければ、足りない名前だけを言って落ちる", async () => {
  await assert.rejects(
    () => runRefuse({
      env: { VOUCH_API_KEY: VOUCH_KEY },
      fetch: stubFetch().fetch,
      account: tripwireAccount(),
      emit: createEmitter({ sink: () => {}, secrets: collectSecrets(env) }),
    }),
    (error) => {
      assert.match(error.message, /GRAPH_API_KEY/);
      assert.equal(error.message.includes(VOUCH_KEY), false);
      return true;
    },
  );
});

// 2026-09-07（commit 3738890）: 本番 `/decision` は鍵なしでも答える（IP ごと 10/分）。
// 審査員は `GRAPH_API_KEY` 1 本で `refuse` を走らせられる。鍵なしでは Authorization を
// **付けない**（`Bearer undefined` を付けると本番が 401 を返し、審査員の鍵の問題に見える）。
test("VOUCH_API_KEY 無しでも refuse は走り、/decision に Authorization を付けず、env 行に鍵なしと出す", async () => {
  const stub = stubFetch();
  const headersSeen = [];
  const fetch = async (url, init) => {
    if (String(url).includes("/decision")) headersSeen.push(init?.headers ?? {});
    return stub.fetch(url, init);
  };
  const lines = [];
  const { view, result } = await runRefuse({
    env: { GRAPH_API_KEY: GRAPH_KEY },
    fetch,
    account: tripwireAccount(),
    emit: createEmitter({ sink: (line) => lines.push(line), secrets: collectSecrets({ GRAPH_API_KEY: GRAPH_KEY }) }),
  });
  assert.equal(headersSeen.length, 1, "/decision が読まれていない");
  assert.equal("Authorization" in headersSeen[0], false, JSON.stringify(headersSeen[0]));
  assert.equal(JSON.stringify(headersSeen[0]).includes("undefined"), false);
  assert.equal(result.status, "refused");
  assert.equal(result.signed, false);
  assert.equal(view.vet402.recommendation, "WARN");
  assert.deepEqual(view.envReady, { GRAPH_API_KEY: true, VOUCH_API_KEY: false });
  const text = lines.join("\n");
  assert.match(text, /VOUCH_API_KEY=unset \(keyless: 10\/min per IP\)/, text);
  assert.match(text, /GRAPH_API_KEY=set/);
});

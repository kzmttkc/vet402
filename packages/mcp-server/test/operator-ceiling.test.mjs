// 運用者の天井（2026-09-12 コード監査 H-1）。
//
// 監査の再現（修正前・スタブ署名器・オンチェーンには出ていない）:
//   402 が $5.00 を要求する売り手に対し
//     amountUsd: 5                      → REFUSE / price_above_ceiling / signTypedData 0 回
//     amountUsd: 5, maxPerTxUsd: 500    → PAID   / signTypedData 1 回 / 署名した value = 5000000
//   つまり **上限はモデルの出力で決まっていた**。運用者側の天井が存在しなかった。
//
// ここで固定するのは 3 つ:
//   1. 天井の決め方（純関数 resolveMaxPerTxUsd）— 超えたら切り下げ・未設定なら既定・以下ならそのまま
//   2. 金の経路（payIfTrusted）— 切り下げ後の天井では署名器に触れない。逆に運用者が許せば払える
//   3. 配線（index.ts）— ツール入力の生値ではなく解決後の値を SDK へ渡している
//
// (3) が要るのは、(1) が正しくても index.ts が呼び忘れれば穴が戻るからで、
// index.ts は import すると `main()` が stdio を掴んで終了しないため
// （test/tool-contract.test.mjs 冒頭と同じ事情）、TypeScript の AST で見る。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  resolveMaxPerTxUsd,
  ceilingNotes,
  DEFAULT_MAX_PER_TX_USD,
  MAX_PER_TX_USD_ENV,
} from "../dist/ceiling.js";
import { payIfTrusted } from "../dist/pay-if-trusted.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

// ============================================================
// 1. 天井の決め方（純関数）
// ============================================================

test("O1 ツール入力が天井を超えたら天井まで切り下げる（モデルは上げられない）", () => {
  const r = resolveMaxPerTxUsd(500, "2");
  assert.equal(r.effective, 2, "Math.min(入力, 天井)");
  assert.equal(r.ceiling, 2);
  assert.equal(r.requested, 500);
  assert.equal(r.clamped, true);
  assert.equal(r.ceilingConfigured, true);
  // 監査が実際に通した値。既定の天井でも同じこと。
  assert.equal(resolveMaxPerTxUsd(500, undefined).effective, DEFAULT_MAX_PER_TX_USD);
  assert.equal(resolveMaxPerTxUsd(500, undefined).clamped, true);
});

test("O2 天井未設定なら既定（$1）。既定は SDK の DEFAULT_MAX_PER_TX_USD と同値で、緩める方向に変えない", () => {
  assert.equal(DEFAULT_MAX_PER_TX_USD, 1);
  for (const raw of [undefined, "", "   "]) {
    const r = resolveMaxPerTxUsd(undefined, raw);
    assert.equal(r.effective, 1, `env=${JSON.stringify(raw)}`);
    assert.equal(r.ceiling, 1);
    assert.equal(r.ceilingConfigured, false);
    assert.equal(r.envRejected, false, "未設定は「拒否した」ではない");
    assert.equal(r.clamped, false);
    assert.equal(r.requested, undefined);
  }
});

test("O3 天井以下の入力はそのまま通す（下げる自由は残す）", () => {
  const r = resolveMaxPerTxUsd(0.5, "2");
  assert.equal(r.effective, 0.5);
  assert.equal(r.clamped, false);
  assert.deepEqual(ceilingNotes(r), [], "何も起きていないなら summary を汚さない");
  // 境界ちょうどは切り下げではない。
  const eq = resolveMaxPerTxUsd(2, "2");
  assert.equal(eq.effective, 2);
  assert.equal(eq.clamped, false);
});

test("O4 読めない env は「無制限」ではなく既定へ落ち、落としたことを名乗る（fail-closed）", () => {
  for (const raw of ["abc", "-1", "0", "Infinity", "NaN", "1e999"]) {
    const r = resolveMaxPerTxUsd(500, raw);
    assert.equal(r.ceiling, DEFAULT_MAX_PER_TX_USD, `env=${raw} を上限として受け入れた`);
    assert.equal(r.effective, DEFAULT_MAX_PER_TX_USD);
    assert.equal(r.ceilingConfigured, false);
    assert.equal(r.envRejected, true, `env=${raw} を黙って捨てている`);
    assert.match(ceilingNotes(r).join(" "), new RegExp(MAX_PER_TX_USD_ENV));
  }
});

test("O5 入力を名乗らなければ天井そのものが効く（省略で天井が消えない）", () => {
  const r = resolveMaxPerTxUsd(undefined, "2");
  assert.equal(r.effective, 2);
  assert.equal(r.clamped, false);
  // 使えない入力（負・0・非数）は「名乗らなかった」と同じに倒す。天井は消えない。
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal(resolveMaxPerTxUsd(bad, "2").effective, 2, `requested=${String(bad)}`);
  }
});

test("O6 切り下げたときだけ summary に1文を足す。新しい理由コードは作らない", () => {
  const notes = ceilingNotes(resolveMaxPerTxUsd(500, "2"));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\$2/);
  assert.match(notes[0], /\$500/);
  assert.match(notes[0], new RegExp(MAX_PER_TX_USD_ENV));
  // 拒否の語彙は SDK のまま。天井用の新語を発明していない。
  assert.equal(/price_above_ceiling|_ceiling_|reason_code/.test(notes[0]), false);
});

// ============================================================
// 2. 金の経路 — 切り下げた天井は実際に署名器を止める
// ============================================================

const b64 = (o) => btoa(JSON.stringify(o));
const PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
const RESOURCE = "https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56";
/** 402 が $5.00 を要求する売り手（USDC 6 桁 = 5000000）。監査の再現と同じ壁。 */
const ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "5000000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAYEE,
  extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
};

/** 署名器への参照を数える。**ALLOW 経路に入るまで 1 度も触られない**ことが測れる。 */
function harness() {
  const accessed = [];
  const signer = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => `0x${"ab".repeat(32)}1b` },
    { get: (t, p) => (accessed.push(String(p)), Reflect.get(t, p)) },
  );
  const paid = [];
  const fetchFn = async (u, init) => {
    const url = String(u);
    if (url.includes("/decision")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], facts: {}, evidence: [{ level: "L1", source: "vet402" }], degraded: false }),
        headers: new Map(),
      };
    }
    const raw = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
    if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [ACCEPT] })]]) };
    paid.push(JSON.parse(atob(raw)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: "ok" }),
      headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: ACCEPT.network, payer: "0xDB62BD202914609830fA656F87996b91be3Aa673" })]]),
    };
  };
  return { signer, fetchFn, paid, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

const pay = (h, maxPerTxUsd) =>
  payIfTrusted({ resourceId: "a".repeat(64), signer: h.signer, resource: RESOURCE, payee: PAYEE, amountUsd: 5, method: "POST", fetch: h.fetchFn, maxPerTxUsd });

test("O7 モデルが 500 と書いても、解決後の天井($1)では $5 の 402 に署名しない", async () => {
  const h = harness();
  // index.ts が SDK へ渡すのはこの値（生の 500 ではない）。
  const effective = resolveMaxPerTxUsd(500, undefined).effective;
  assert.equal(effective, 1);
  const r = await pay(h, effective);
  assert.equal(r.decision, "REFUSE");
  assert.equal(r.safe_to_pay, false);
  assert.ok(r.refuse_reasons.includes("price_above_ceiling"), r.refuse_reasons.join(","));
  assert.deepEqual(h.signAccesses(), [], "署名器に触れている");
  assert.equal(h.paid.length, 0, "売り手へ署名ヘッダを送っている");
  assert.equal(r.nonce, null, "署名が存在しないことの機械可読な印");
});

test("O7b 監査の再現そのもの: 生の 500 を渡せば今でも署名される（天井が効いているのは切り下げのおかげ）", async () => {
  const h = harness();
  const r = await pay(h, 500);
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
  assert.equal(h.signAccesses().length, 1);
  // だからこそ index.ts はこの生値を渡してはならない（O9 の AST 検査が配線を固定する）。
});

test("O8 運用者が $10 を許せば同じ $5 の 402 に払える（天井が「常に拒否」に退化していない）", async () => {
  const h = harness();
  const effective = resolveMaxPerTxUsd(500, "10").effective;
  assert.equal(effective, 10, "運用者の天井が入力より低いのでこちらが勝つ");
  const r = await pay(h, effective);
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
  assert.equal(h.signAccesses().length, 1);
  assert.equal(h.paid.length, 1);
});

// ============================================================
// 3. 配線 — index.ts が生のツール入力を SDK へ渡していない
// ============================================================

test("O9 index.ts は payIfTrusted へ maxPerTxUsd: ceiling.effective を渡す（生のツール入力ではない）", () => {
  const file = join(PKG, "src/index.ts");
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  let call = null;
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "payIfTrusted") call = n;
    ts.forEachChild(n, walk);
  };
  walk(src);
  assert.ok(call, "payIfTrusted の呼び出しが見つからない");
  const arg = call.arguments[0];
  assert.ok(arg && ts.isObjectLiteralExpression(arg), "payIfTrusted の引数がオブジェクトリテラルでない");

  // `...(signer ? { … } : {})` の中まで見る。
  const props = [];
  const collect = (obj) => {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) props.push(p);
      else if (ts.isShorthandPropertyAssignment(p)) props.push(p);
      else if (ts.isSpreadAssignment(p)) {
        const walkSpread = (n) => {
          if (ts.isObjectLiteralExpression(n)) collect(n);
          else ts.forEachChild(n, walkSpread);
        };
        walkSpread(p.expression);
      }
    }
  };
  collect(arg);

  const max = props.filter((p) => p.name.text === "maxPerTxUsd");
  assert.equal(max.length, 1, `maxPerTxUsd の渡し方が ${max.length} 箇所（1 箇所であるべき）`);
  assert.ok(
    ts.isPropertyAssignment(max[0]),
    "maxPerTxUsd がショートハンド（＝ツール入力の生値）のまま渡されている。H-1 が戻っている",
  );
  assert.equal(
    max[0].initializer.getText(src),
    "ceiling.effective",
    "SDK へ渡す上限が解決後の値でない。モデルの出力が天井になっている",
  );
});

// ============================================================
// 4. 本物のプロセス — stdio 越しの MCP 呼び出しで天井が効く
// ============================================================

/** 本物の MCP サーバを子プロセスで起動し、上流 API はローカル HTTP で受ける。 */
async function callTool(toolName, args, extraEnv = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ recommendation: "ALLOW", reason_codes: ["l0_pass"], facts: {}, evidence: [], rules_version: "t", degraded: false }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, VOUCH_API_URL: `http://127.0.0.1:${server.address().port}/api/v1` };
  delete env.VOUCH_API_KEY;
  delete env[MAX_PER_TX_USD_ENV];
  Object.assign(env, extraEnv);
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
          try { const m = JSON.parse(line); if (m.id === 2) { clearTimeout(timer); resolve(m.result); } } catch { /* partial line */ }
        }
      });
    });
    return { seen, text: JSON.parse(result.content[0].text) };
  } finally {
    child.kill();
    server.close();
  }
}

const RID = "a".repeat(64);
const ceilingParam = (url) => new URL(url, "http://x").searchParams.get("max_per_tx_usd");

test("O10 実プロセス: env 未設定で maxPerTxUsd:500 を渡しても上流には既定の 1 しか出ない", async () => {
  const { seen, text } = await callTool("check_resource_decision", { resourceId: RID, amountUsd: 5, maxPerTxUsd: 500 });
  assert.equal(ceilingParam(seen[0]), "1", seen[0]);
  assert.match(text.summary, /lowered to \$1/, text.summary);
  assert.match(text.summary, new RegExp(MAX_PER_TX_USD_ENV));
});

test("O11 実プロセス: 運用者が 2 を宣言すれば 2。モデルの 500 は通らない", async () => {
  const { seen, text } = await callTool("check_resource_decision", { resourceId: RID, amountUsd: 5, maxPerTxUsd: 500 }, { [MAX_PER_TX_USD_ENV]: "2" });
  assert.equal(ceilingParam(seen[0]), "2", seen[0]);
  assert.match(text.summary, /lowered to \$2/, text.summary);
});

test("O12 実プロセス: 天井以下はそのまま通り、summary に余計な1文を足さない", async () => {
  const { seen, text } = await callTool("check_resource_decision", { resourceId: RID, amountUsd: 0.4, maxPerTxUsd: 0.5 }, { [MAX_PER_TX_USD_ENV]: "2" });
  assert.equal(ceilingParam(seen[0]), "0.5", seen[0]);
  assert.equal(/Server ceiling/.test(text.summary), false, text.summary);
});

test("O13 実プロセス: 壊れた env は無制限にならず 1 へ落ち、そのことを summary で名乗る", async () => {
  const { seen, text } = await callTool("check_resource_decision", { resourceId: RID, amountUsd: 5, maxPerTxUsd: 500 }, { [MAX_PER_TX_USD_ENV]: "not-a-number" });
  assert.equal(ceilingParam(seen[0]), "1", seen[0]);
  assert.match(text.summary, /not a positive number/, text.summary);
});

test("O14 実プロセス: 政策を尋ねない呼び出しの形は変えない（頼まれていない caller_policy を生やさない）", async () => {
  const { seen, text } = await callTool("check_resource_decision", { resourceId: RID }, { [MAX_PER_TX_USD_ENV]: "2" });
  assert.equal(ceilingParam(seen[0]), null, `政策を尋ねていないのに天井を送った: ${seen[0]}`);
  assert.equal(text.decision, "ALLOW_PAY");
});

test("O15 実プロセス: role=payee には天井を付けない（サーバは payee + policy を 400 invalid_policy で弾く）", async () => {
  const { seen } = await callTool(
    "check_resource_decision",
    { resourceId: RID, role: "payee", payer: "0xDB62BD202914609830fA656F87996b91be3Aa673", amountUsd: 5, maxPerTxUsd: 500 },
    { [MAX_PER_TX_USD_ENV]: "2" },
  );
  // 呼び手が名乗った値はそのまま（運用者の天井を足さない）。足すと 400 invalid_policy になる。
  assert.equal(ceilingParam(seen[0]), "500", seen[0]);
  assert.match(seen[0], /role=payee/);
});

test("O16 実プロセス: ツール説明とスキーマがモデルに「サーバの天井は超えられない」と告げている", async () => {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, VOUCH_API_URL: `http://127.0.0.1:${server.address().port}/api/v1` };
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  const child = spawn(process.execPath, [join(PKG, "dist/index.js")], { env, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const list = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tools/list timed out")), 10_000);
    child.stdout.on("data", () => {
      for (const line of out.split("\n")) {
        try { const m = JSON.parse(line); if (m.id === 2) { clearTimeout(timer); resolve(m.result); } } catch { /* partial line */ }
      }
    });
  }).finally(() => { child.kill(); server.close(); });

  for (const name of ["pay_if_trusted", "check_resource_decision"]) {
    const tool = list.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} が無い`);
    const desc = tool.inputSchema.properties.maxPerTxUsd?.description ?? "";
    assert.match(desc, new RegExp(MAX_PER_TX_USD_ENV), `${name}: 天井の置き場所をモデルに言っていない`);
    assert.match(desc, /never raise|cannot|CANNOT/i, `${name}: 「上げられない」と言っていない`);
  }
  // 鍵と同じで、天井もツール入力からは設定できない。
  const pit = list.tools.find((t) => t.name === "pay_if_trusted");
  assert.equal(JSON.stringify(pit.inputSchema).includes(`"${MAX_PER_TX_USD_ENV}"`), false, "env 名をツール入力の項目にしていない");
});

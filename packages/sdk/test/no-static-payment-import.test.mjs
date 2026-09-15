// ============================================================
// 第3層の検算（WINDOW_PLAN §4「呼べないことの4層証明」）。
//
// `pay-or-refuse.test.mjs` の冒頭は「支払い実装は ALLOW ブランチ内の動的 import で、
// 拒否経路では**モジュールの評価すら起きない**」と宣言している。
// ところがその宣言は、2026-09-05 まで**どのテストでも検算されていなかった**——
// `pay-or-refuse.ts` の動的 import を static import に書き換えても、既存の 106 本は
// 1本も赤くならなかった。主張だけあって計器が無い状態で、検証を売る製品としては最悪。
//
// このファイルがその計器。**src ではなく dist（＝実際に走るコード）** の静的な
// モジュールグラフを、公開入口 `dist/index.js` から辿り、支払いモジュールに
// **静的には到達できない**ことを示す。型だけの import は tsc が消すので dist には出ない。
//
// 変異で確かめてあること（2026-09-05）:
//   `const { executeX402Payment } = await import("./x402-pay.js");`
//   → `import { executeX402Payment } from "./x402-pay.js";` に書き換えると
//   「第3層: dist の静的グラフに支払いモジュールが現れない」が赤くなる。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "../dist");
const SRC = resolve(here, "../src");
/** 支払い（署名）実装。ここへ静的に届いてはいけない。 */
const PAYMENT_MODULE = resolve(DIST, "x402-pay.js");

/**
 * コメントを落とす。import 文がコメントの中にあるのを本物と数えないため
 * （dist は JSDoc をそのまま残すので、`./x402-pay.js` を説明する行が実在する）。
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 静的な import / export ... from の指定子だけを拾う（`import(...)` は動的なので拾わない）。 */
function staticSpecifiers(code) {
  const src = stripComments(code);
  const out = [];
  // `import x from "m"` / `import "m"` / `export * from "m"` / `export { x } from "m"`
  // `(?!\s*\()` で動的 `import("m")` を外す——それがまさに第3層で許している形。
  const re = /(?:^|[;}\n])\s*(?:import|export)\b(?!\s*\()(?:[^;]*?\bfrom)?\s*["']([^"']+)["']\s*;?/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  // `import "m";`（副作用 import）は上の正規表現で from 無しとして拾える。
  return out;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null; // 外部パッケージは辿らない
  return resolve(dirname(fromFile), specifier);
}

/** `dist/index.js` から静的 import だけを辿って到達できるファイル一覧。 */
function staticGraphFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  const edges = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(file, spec);
      if (!target) continue;
      edges.push(`${file} -> ${spec}`);
      queue.push(target);
    }
  }
  return { files: seen, edges };
}

test("第3層: dist の静的グラフに支払いモジュールが現れない（拒否経路では評価すら起きない）", () => {
  const entry = resolve(DIST, "index.js");
  assert.ok(existsSync(entry), "dist/index.js がある（npm test は tsc を通してから走る）");
  assert.ok(existsSync(PAYMENT_MODULE), "dist/x402-pay.js がある（検査対象が実在する）");

  const { files, edges } = staticGraphFrom(entry);
  assert.ok(files.size >= 3, `グラフを実際に辿れている（辿ったファイル数=${files.size}）`);
  assert.equal(
    files.has(PAYMENT_MODULE),
    false,
    "支払いモジュールへ静的に到達できてしまう。動的 import に戻すこと。辿った辺:\n" + edges.join("\n"),
  );
});

test("第3層: 支払いモジュールは動的 import でだけ参照される", () => {
  const code = readFileSync(resolve(DIST, "pay-or-refuse.js"), "utf8");
  const stripped = stripComments(code);
  assert.match(
    stripped,
    /await\s+import\(\s*["']\.\/x402-pay\.js["']\s*\)/,
    "ALLOW ブランチ内の動的 import が消えている（消すと第3層の主張が空になる）",
  );
  assert.deepEqual(
    staticSpecifiers(code).filter((s) => s.includes("x402-pay")),
    [],
    "pay-or-refuse.js に x402-pay への静的 import がある",
  );
});

test("第3層: src 側も値としては静的 import していない（型だけは可・tsc が消す）", () => {
  const code = readFileSync(resolve(SRC, "pay-or-refuse.ts"), "utf8");
  const stripped = stripComments(code);
  const lines = stripped.split("\n");
  const offenders = lines.filter((line) => {
    if (!line.includes("x402-pay")) return false;
    const t = line.trim();
    if (!/^(import|export)\b/.test(t)) return false; // 動的 import / 型注釈は対象外
    // `import type ...` / `export type ...` は tsc が消すので値の参照にならない。
    return !/^(import|export)\s+type\b/.test(t);
  });
  assert.deepEqual(offenders, [], "src で x402-pay を値として静的 import している");
});

// ------------------------------------------------------------
// 第3層の**位置**の検算（2026-09-06）。
//
// 上の3本は「静的グラフに無い」「`await import("./x402-pay.js")` が存在する」しか見ない。
// 変異 M14——動的 import を ALLOW ブランチの外（関数冒頭・拒否経路より前）へ動かす——は
// この3本を全部通り抜けた。**動的 import であること**と、**拒否経路で評価されないこと**は
// 別の主張で、後者には計器が無かった。
//
// ここでは dist を丸ごと隔離コピーし、支払いモジュールだけを「ロードされたら throw する」
// 1行に差し替えて、その隔離コピーの `payOrRefuse` に拒否経路を走らせる。
// 拒否で返れば、支払いモジュールは評価されていない。ALLOW 経路で同じコピーが throw
// することを併せて示す（差し替えが効いている証明——0回が配線ミスでないことの検算）。
//
// テキストの位置（AST）ではなく実行で見る理由: 主張は「評価されない」であって
// 「その行がこの分岐の内側にある」ではない。位置を見る計器は、リファクタで分岐の形が
// 変わるたびに書き直しになり、しかも実行順の逆転（先に評価してから分岐へ入る）を見逃す。
// ------------------------------------------------------------

/** dist を tmp へ写し、x402-pay.js をロード即 throw に差し替えた入口の URL を返す。 */
function isolatedDistWithPoisonedPaymentModule() {
  const dir = mkdtempSync(join(tmpdir(), "vet402-sdk-poison-"));
  for (const f of readdirSync(DIST).filter((f) => f.endsWith(".js"))) copyFileSync(join(DIST, f), join(dir, f));
  writeFileSync(join(dir, "x402-pay.js"), 'throw new Error("PAYMENT MODULE EVALUATED");\n');
  return pathToFileURL(join(dir, "index.js")).href;
}

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const ACCOUNT = { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" };
const decisionBody = (recommendation) => ({
  subject: { type: "resource", id: "a".repeat(64) },
  role: "payer",
  recommendation,
  reason_codes: [],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [],
  degraded: false,
  policy: "allow_only",
  rules_version: "2026-09-02.1",
});
const wall402 = () => ({
  ok: false,
  status: 402,
  json: async () => ({}),
  headers: new Map([[
    "payment-required",
    btoa(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYEE, extra: { assetTransferMethod: "eip3009" } }] })),
  ]]),
});
/** /decision に recommendation を、資源 URL に 402 の壁を返す fetch。 */
const fetchWith = (recommendation) => async (url) => {
  const u = String(url);
  if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decisionBody(recommendation), headers: new Map() };
  if (u.startsWith(RESOURCE)) return wall402();
  throw new Error(`unexpected call: ${u}`);
};

test("第3層: 拒否経路では支払いモジュールが評価されない（ロード即 throw に差し替えても拒否で返る）", async () => {
  const { payOrRefuse } = await import(isolatedDistWithPoisonedPaymentModule());
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account: ACCOUNT, fetch: fetchWith("WARN") });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("payee_recommendation_not_allow"), true);
});

test("第3層: ネガティブコントロール——同じ差し替えで ALLOW 経路は支払いモジュールの評価で落ちる", async () => {
  const { payOrRefuse } = await import(isolatedDistWithPoisonedPaymentModule());
  await assert.rejects(
    () => payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account: ACCOUNT, fetch: fetchWith("ALLOW") }),
    /PAYMENT MODULE EVALUATED/,
  );
});

// ------------------------------------------------------------
// Solana（SVM）の第3層（2026-09-15）。
//
// Solana の支払い実装は `./svm-pay.js`（取引の組み立て・署名・再送）と `./spl-token-lite.js`、
// その下の `@solana/web3.js`。**3 つとも拒否経路では評価されない**ことを、EVM と同じ 2 つの形で見る:
// 静的グラフに現れない（テキスト）／ロード即 throw に差し替えても Solana の BLOCK が拒否で返る（実行）。
// 加えて、web3.js が**入っていない**環境で EVM の利用者が今までどおり払えることを、node_modules の
// 無い tmp に dist だけを写して固定する（peerDependency を optional にした約束の検算）。
// ------------------------------------------------------------

const SVM_PAYMENT_MODULES = ["svm-pay.js", "spl-token-lite.js"].map((f) => resolve(DIST, f));

test("第3層(SVM): dist の静的グラフに svm-pay.js / spl-token-lite.js が現れず、@solana/web3.js を静的に import するファイルも無い", () => {
  const entry = resolve(DIST, "index.js");
  for (const f of SVM_PAYMENT_MODULES) assert.ok(existsSync(f), `${f} がある（検査対象が実在する）`);
  const { files, edges } = staticGraphFrom(entry);
  for (const f of SVM_PAYMENT_MODULES) {
    assert.equal(files.has(f), false, `${f} へ静的に到達できてしまう。辿った辺:\n${edges.join("\n")}`);
  }
  for (const file of files) {
    const specs = staticSpecifiers(readFileSync(file, "utf8"));
    assert.deepEqual(specs.filter((s) => s.startsWith("@solana/")), [], `${file} が @solana/* を静的に import している`);
  }
});

test("第3層(SVM): dist のどこにも @solana/web3.js の静的 import もリテラル指定子の動的 import も無い（変数指定子だけ）", () => {
  for (const f of readdirSync(DIST).filter((f) => f.endsWith(".js"))) {
    const code = stripComments(readFileSync(join(DIST, f), "utf8"));
    assert.deepEqual(staticSpecifiers(code).filter((s) => s.startsWith("@solana/")), [], `${f} に @solana/* の静的 import`);
    assert.doesNotMatch(code, /import\(\s*["']@solana\//, `${f} にリテラル指定子の import("@solana/…")（バンドラが静的依存として辿る）`);
  }
  const pay = stripComments(readFileSync(resolve(DIST, "pay-or-refuse.js"), "utf8"));
  assert.match(pay, /await\s+import\(\s*["']\.\/svm-pay\.js["']\s*\)/, "ALLOW ブランチ内の svm-pay.js の動的 import が消えている");
});

/** dist を tmp へ写し、`poison` に挙げたファイルをロード即 throw に差し替えた入口の URL を返す。 */
function isolatedDist(poison = []) {
  const dir = mkdtempSync(join(tmpdir(), "vet402-sdk-svm-"));
  for (const f of readdirSync(DIST).filter((f) => f.endsWith(".js"))) copyFileSync(join(DIST, f), join(dir, f));
  for (const f of poison) writeFileSync(join(dir, f), `throw new Error("PAYMENT MODULE EVALUATED: ${f}");\n`);
  return { dir, entry: pathToFileURL(join(dir, "index.js")).href };
}

const SOL_PAYEE = "FMUEmtxhU46GzhKF4FW9MLJdQWiLgjiXP9TYRWSrqTpV";
const SOL_FEE_PAYER = "6TcyBfPdBt1kjsvDZLzmBFnuMaLWiTaAt4RjUr9VA5YD";
const SOL_ACCOUNT = { address: "4MfyR4G3NWfVRDWo6iNAHDBZqWMgwZX6FNtMqEW3a9JT", signTransaction: async (tx) => tx };
const solWall402 = () => ({
  ok: false,
  status: 402,
  json: async () => ({}),
  headers: new Map([[
    "payment-required",
    btoa(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "20000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: SOL_PAYEE, extra: { feePayer: SOL_FEE_PAYER } }] })),
  ]]),
});
const solFetchWith = (recommendation) => async (url) => {
  const u = String(url);
  if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decisionBody(recommendation), headers: new Map() };
  if (u.startsWith(RESOURCE)) return solWall402();
  throw new Error(`unexpected call: ${u}`);
};

test("第3層(SVM): svm-pay.js と spl-token-lite.js をロード即 throw にしても、Solana の BLOCK は拒否で返る", async () => {
  const { payOrRefuse } = await import(isolatedDist(["svm-pay.js", "spl-token-lite.js"]).entry);
  const r = await payOrRefuse({ payee: SOL_PAYEE, resource: RESOURCE, amountUsd: 0.02, svm: { account: SOL_ACCOUNT, rpcUrl: "https://rpc.example/" }, fetch: solFetchWith("BLOCK") });
  assert.equal(r.status, "refused");
  assert.equal(r.rail, "svm");
  assert.equal(r.decision.reason_codes.includes("payee_recommendation_block"), true);
});

test("第3層(SVM): ネガティブコントロール——同じ差し替えで Solana の ALLOW は svm-pay.js の評価で落ちる", async () => {
  const { payOrRefuse } = await import(isolatedDist(["svm-pay.js"]).entry);
  await assert.rejects(
    () => payOrRefuse({ payee: SOL_PAYEE, resource: RESOURCE, amountUsd: 0.02, svm: { account: SOL_ACCOUNT, rpcUrl: "https://rpc.example/" }, fetch: solFetchWith("ALLOW") }),
    /PAYMENT MODULE EVALUATED: svm-pay\.js/,
  );
});

test("peer 任意: @solana/web3.js が解決できない場所に dist だけを置いても、EVM の ALLOW は払える", async () => {
  const { dir, entry } = isolatedDist();
  // 隔離の検算: この tmp からは web3.js が本当に解決できない（解決できるなら、この検査は何も証明しない）。
  writeFileSync(join(dir, "probe.mjs"), 'export default async () => { const s = "@solana/web3.js"; return import(s); };\n');
  const probe = (await import(pathToFileURL(join(dir, "probe.mjs")).href)).default;
  await assert.rejects(() => probe(), /Cannot find|ERR_MODULE_NOT_FOUND/);

  const { payOrRefuse } = await import(entry);
  let signed = 0;
  const account = { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => { signed++; return "0xsig"; } };
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decisionBody("ALLOW"), headers: new Map() };
    if (u.startsWith(RESOURCE)) {
      if (!(init?.headers ?? {})["PAYMENT-SIGNATURE"]) return wall402();
      return { ok: true, status: 200, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", btoa(JSON.stringify({ success: true, transaction: "0xtx", network: "eip155:8453" }))]]) };
    }
    if (u.includes("/payments/x402")) return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
    throw new Error(`unexpected call: ${u}`);
  };
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account, fetch });
  assert.equal(r.status, "paid");
  assert.equal(r.rail, "evm");
  assert.equal(r.svmTransaction, null);
  assert.equal(signed, 1);
});

test("peer 任意: web3.js が解決できない場所で Solana の ALLOW は、署名の前に原因を名指しで throw する", async () => {
  const { payOrRefuse } = await import(isolatedDist().entry);
  let touched = 0;
  const account = new Proxy(SOL_ACCOUNT, { get(t, p) { if (String(p).startsWith("sign")) touched++; return Reflect.get(t, p); } });
  await assert.rejects(
    () => payOrRefuse({ payee: SOL_PAYEE, resource: RESOURCE, amountUsd: 0.02, svm: { account, rpcUrl: "https://rpc.example/" }, fetch: solFetchWith("ALLOW") }),
    /invalid_svm_setup: .*@solana\/web3\.js/,
  );
  assert.equal(touched, 0);
});

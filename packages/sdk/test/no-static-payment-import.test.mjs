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

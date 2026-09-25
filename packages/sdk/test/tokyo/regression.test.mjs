// ETHGlobal Tokyo 2026 — B1 の red テスト（回帰の3本）。
// 正典: PLAN_v4.3 §5（T29・T30・T30b）。**このファイルは新しいモジュールを import しない。**
// 実装なしで緑になってよいのはこの3本だけ（B1 の判定）。4本目が緑なら、そのテストは何も確かめていない。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = resolve(HERE, "../..");
const DIST = join(SDK, "dist");

// ネットワークに出ない（このファイルの fetch は全部これに落ちる）。
globalThis.fetch = async (url) => { throw new Error(`network forbidden in tokyo tests: ${String(url)}`); };

/**
 * dist の .js を起点に、**静的な** import / export … from だけを辿る。
 * `await import(...)`（動的）は辿らない——名前を使わない呼び手の静的グラフに viem が入らないことが主張だから。
 * 返すのは相対パスは dist からの相対ファイル名、裸の指定子はそのまま（例 "viem"・"viem/accounts"）。
 */
function staticGraph(entry) {
  const seen = new Set();
  const bare = new Set();
  const stack = [resolve(DIST, entry)];
  const re = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  }
  const files = [...seen].map((f) => f.slice(DIST.length + 1));
  return { files, bare: [...bare] };
}
const hasViem = (g) => g.bare.some((s) => s === "viem" || s.startsWith("viem/"));
const NEW_ENS_FILES = ["ens-attestation.js", "ens-read.js", "atst-codec.js"];

test("T29 payee に ENS 名（vitalik.eth）を渡すと今の文言で throw invalid_payee_address・fetch 0", async () => {
  const { payOrRefuse } = await import("../../dist/index.js");
  let fetched = 0;
  const accessed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  await assert.rejects(
    () => payOrRefuse({
      payee: "vitalik.eth",
      resource: "https://seller.example.test/api/x",
      amountUsd: 0.01,
      account,
      fetch: async () => { fetched++; throw new Error("must not be called"); },
    }),
    (e) => /^invalid_payee_address: /.test(String(e && e.message)) && /ENS names are not resolved here/.test(String(e.message)),
  );
  assert.equal(fetched, 0, "名前解決も判定取得もしていない");
  assert.deepEqual(accessed.filter((k) => k.startsWith("sign")), [], "署名者への参照 0");
});

test("T30 dist/pay-or-refuse.js の静的 import グラフに viem・ens-attestation・ens-read・atst-codec が無い", () => {
  assert.equal(existsSync(join(DIST, "pay-or-refuse.js")), true, "npm run build の後に走らせる");
  const g = staticGraph("pay-or-refuse.js");
  assert.ok(g.files.includes("pay-or-refuse.js"));
  assert.equal(hasViem(g), false, `viem が静的グラフにある: ${g.bare.join(",")}`);
  for (const f of NEW_ENS_FILES) assert.equal(g.files.includes(f), false, `${f} が静的グラフにある`);
  // ens-reasons.js は含んでよい（import を1つも持たない語彙だけのモジュール）。含むなら中身も import 0 であること。
  if (g.files.includes("ens-reasons.js")) {
    const src = readFileSync(join(DIST, "ens-reasons.js"), "utf8");
    assert.equal(/(?:^|[;\n])\s*(?:import|export)\s[^;]*?from\s*["']/.test(src), false, "ens-reasons.js は import を持たない");
  }
});

test("T30b パッケージの入口 dist/index.js も viem を静的に読み込まない・./ens があれば dist/ens.js だけが viem を含む", () => {
  const g = staticGraph("index.js");
  assert.equal(hasViem(g), false, `入口の静的グラフに viem: ${g.bare.join(",")}`);
  for (const f of NEW_ENS_FILES) assert.equal(g.files.includes(f), false, `入口の静的グラフに ${f}`);
  const pkg = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"));
  const ens = pkg.exports?.["./ens"];
  if (ens !== undefined) {
    // "./ens" を exports に足した後は、束ね口が実在し、viem を含むのはそこだけであること。
    const target = typeof ens === "string" ? ens : (ens.default ?? ens.import);
    assert.equal(target, "./dist/ens.js");
    assert.equal(existsSync(join(DIST, "ens.js")), true, "exports の ./ens が指す dist/ens.js が無い");
    const ge = staticGraph("ens.js");
    assert.equal(hasViem(ge), true, "@vet402/sdk/ens は viem を読む側");
  }
  assert.equal(pkg.exports["."].import ?? pkg.exports["."].default, "./dist/index.js");
});

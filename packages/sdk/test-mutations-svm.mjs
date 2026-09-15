#!/usr/bin/env node
/**
 * **Solana のゲートも、変異で確かめる。**（2026-09-15）
 *
 * `test-mutations.mjs`（EVM と共有の関門 45 本）と同じ規律・同じ手順で、Solana（SVM exact）の経路に
 * だけある関門を 1 つずつ壊し、テストが赤くなるかを見る。表を分けたのは、既存の表を**1 行も変えずに**
 * 残すため（そちらは提出物の証跡）。実行器はそちらの写しで、違うのは `MUTATIONS` と対象ファイルだけ。
 *
 *   npm run mutations:svm    # = node test-mutations-svm.mjs
 *
 *   - 走らせる前に「今が緑」を確かめ、緑でなければ何も変異させない
 *   - 変異はソースをその場で書き換え、必ず元へ戻す（finally）
 *   - 復元後に緑を再確認し、`MUTANT` マーカーが残っていないことを確かめる
 *   - SURVIVED / STALE / 型が殺した（KILLED (build)）が 1 つでもあれば exit 1
 *     （型で落ちる変異は「テストが規則を守っている」の証明にならないので、この表では生き残り扱い）
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAY = "src/pay-or-refuse.ts";
const SVM = "src/svm-pay.ts";
const SPL = "src/spl-token-lite.ts";

const MUTATIONS = [
  // ---- 判定（署名の前）----
  {
    id: "V01",
    what: "Solana の payee だけ BLOCK 判定を外す（非 ALLOW として別の語で落ちる）",
    rule: "BLOCK は payee_recommendation_block で拒否（S1）",
    file: PAY,
    find: "    if (isBlockVerdict(decision.recommendation)) {",
    replace: '    if (/* MUTANT */ rail !== "svm" && isBlockVerdict(decision.recommendation)) {',
  },
  {
    id: "V02",
    what: "Solana のカタログ外を即拒否しない（402 と受取人スコアへ進む）",
    rule: "404 ∧ Solana → resource_uncatalogued + evidence_unavailable（S7）",
    file: PAY,
    find: '  if (uncatalogued && rail === "svm") {',
    replace: "  if (/* MUTANT */ false) {",
  },
  {
    id: "V03",
    what: "Solana の payee で evidence.source subgraph / both を受け付ける",
    rule: "Base の subgraph は Solana を索引しない → invalid_evidence_policy（S8）",
    file: PAY,
    find: '    if (source === "subgraph" || source === "both") {',
    replace: "    if (/* MUTANT */ false) {",
  },
  {
    id: "V04",
    what: "拒否経路で Solana の署名者のプロパティに触る",
    rule: "第1層 拒否のとき sign* への参照が 0（S1〜S9）",
    file: PAY,
    find: "  ): PayOrRefuseResult => ({\n    status: \"refused\",",
    replace: "  ): PayOrRefuseResult => (void input.svm?.account.signTransaction, /* MUTANT */ {\n    status: \"refused\",",
  },
  {
    id: "V05",
    what: "svm-pay.js の動的 import を ALLOW ブランチの外（関数冒頭）へ出す",
    rule: "第3層 拒否経路では Solana の支払い実装が評価されない",
    file: PAY,
    edits: [
      { find: '    const { executeSvmPayment } = await import("./svm-pay.js");', replace: "    /* MUTANT: import hoisted */" },
      { find: "  const fetchFn = input.fetch;", replace: '  const fetchFn = input.fetch;\n  const { executeSvmPayment } = await import("./svm-pay.js"); /* MUTANT */' },
    ],
  },
  // ---- 402 の照合 ----
  {
    id: "V06",
    what: "Solana の payTo 照合を大文字小文字を畳んで比べる",
    rule: "base58 は大小で別の鍵 → payee_mismatch（S3）",
    file: PAY,
    find: "    if (accept.payTo !== input.payee) {",
    replace: "    if (/* MUTANT */ accept.payTo.toLowerCase() !== input.payee.toLowerCase()) {",
  },
  {
    id: "V07",
    what: "Solana の mint 照合を外す",
    rule: "asset が SOLANA_USDC と完全一致（S5）",
    file: PAY,
    find: "  if (accept.asset !== SOLANA_USDC) return false;",
    replace: "  /* MUTANT: mint check removed */",
  },
  {
    id: "V08",
    what: "Solana の network 照合を外す（devnet に払う）",
    rule: "network が SOLANA_MAINNET と完全一致（S5）",
    file: PAY,
    find: "  if (accept.network !== SOLANA_MAINNET) return false;",
    replace: "  /* MUTANT: network check removed */",
  },
  {
    id: "V09",
    what: "x402 v2 の要求を外す（v1 の壁に v2 の封筒で払う）",
    rule: "SVM は x402 v2 だけ（S5）",
    file: PAY,
    find: "  if (x402Version !== 2) return false;",
    replace: "  /* MUTANT: v2 check removed */",
  },
  {
    id: "V10",
    what: "feePayer が payTo と同じ accept を払える形に数える",
    rule: "feePayer は payTo と別の第三者（S5）",
    file: PAY,
    find: '  return typeof feePayer === "string" && SOLANA_RE.test(feePayer) && feePayer !== accept.payTo;',
    replace: '  return typeof feePayer === "string" && SOLANA_RE.test(feePayer); /* MUTANT */',
  },
  // ---- ALLOW ブランチ内（署名の前と後）----
  {
    id: "V11",
    what: "feePayer が署名者自身でも署名する",
    rule: "署名前に feePayer ≠ 署名者（S9）",
    file: SVM,
    find: "  if (feePayer === payerAddress) {",
    replace: "  if (/* MUTANT */ false) {",
  },
  {
    id: "V12",
    what: "payTo が曲線外でも組みに進む",
    rule: "署名前に payTo が曲線上（S9b）",
    file: SVM,
    find: "    if (!web3.PublicKey.isOnCurve(payTo.toBytes())) {",
    replace: "    if (/* MUTANT */ false) {",
  },
  {
    id: "V13",
    what: "署名者が返した取引の message を組んだものと比べない",
    rule: "違う取引は売り手へ送らない（S11 / S11b）",
    file: SVM,
    find: "    if (!sameBytes(reparsed.message.serialize(), messageBytes)) return notSent;",
    replace: "    /* MUTANT: message comparison removed */",
  },
  {
    id: "V14",
    what: "Solana の決済失敗のとき memo（nonce）を落とす",
    rule: "何に署名したかは残す（S11 / S12）",
    file: PAY,
    find: "      nonce: svmPaid?.memo ?? svmMemo,",
    replace: "      nonce: null, /* MUTANT */",
  },
  {
    id: "V15",
    what: "Solana の決済失敗のとき signed:false と書く",
    rule: "署名は実在する・隠さない（S11 / S12）",
    file: PAY,
    find: "      // 署名者が値を返した以上 true。送らなかった（message 不一致）ときも隠さない（E18）。\n      signed: true,",
    replace: "      signed: false, /* MUTANT */",
  },
  {
    id: "V16",
    what: "RPC の HTTP ステータスを見ずに blockhash を使う",
    rule: "RPC が失敗なら署名の前に throw（S13b）",
    file: SVM,
    find: '  if (!response.ok || typeof blockhash !== "string" || !BASE58_RE.test(blockhash)) {',
    replace: '  if (/* MUTANT */ typeof blockhash !== "string" || !BASE58_RE.test(blockhash)) {',
  },
  {
    id: "V18",
    what: "RPC の blockhash の形（base58）を確かめない",
    rule: "読めない blockhash は svm_rpc_unavailable で throw（S13c）",
    file: SVM,
    find: '  if (!response.ok || typeof blockhash !== "string" || !BASE58_RE.test(blockhash)) {',
    replace: '  if (/* MUTANT */ !response.ok || typeof blockhash !== "string") {',
  },
  {
    id: "V17",
    what: "u64 の範囲検査を外す（DataView が 2^64 を黙って 0 に丸める）",
    rule: "範囲外の額は throw（spl-token-lite パリティ）",
    file: SPL,
    find: "  if (units < 0n || units > U64_MAX) {",
    replace: "  if (/* MUTANT */ false) {",
  },
];

// ---------- 実行器（test-mutations.mjs の写し）----------

const TEST_FILES = (await readdir(join(ROOT, "test"))).filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`);
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function buildAndTest() {
  const build = await run(TSC, []);
  if (build.code !== 0) return { code: build.code, fail: "build", failed: [], stage: "build" };
  const t = await run("node", ["--test", ...TEST_FILES]);
  const fail = /^# fail (\d+)$/m.exec(t.out)?.[1] ?? /ℹ fail (\d+)/.exec(t.out)?.[1] ?? "?";
  const failed = [...t.out.matchAll(/^ {0,4}✖ (.+?) \(/gm)].map((m) => m[1]);
  return { code: t.code, fail, failed: [...new Set(failed)], stage: "test" };
}

async function countMutantMarkers() {
  let n = 0;
  for (const f of [PAY, SVM, SPL]) n += (await readFile(join(ROOT, f), "utf8")).split("MUTANT").length - 1;
  return n;
}

function pad(s, w) {
  const width = [...String(s)].reduce((a, c) => a + (/[^\x00-\x7f]/.test(c) ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, w - width));
}

const t0 = Date.now();
if ((await countMutantMarkers()) !== 0) {
  console.error("src に MUTANT マーカーが残っている。前回の復元が失敗している。`git diff src` を見ること。");
  process.exit(2);
}
const baseline = await buildAndTest();
if (baseline.code !== 0) {
  console.error(`baseline is not green (stage ${baseline.stage}, fail ${baseline.fail}) — refusing to mutate.`);
  process.exit(2);
}
console.log(`baseline: green (fail ${baseline.fail})\n`);

const rows = [];
let survived = 0;
for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = await readFile(path, "utf8");
  const edits = m.edits ?? [{ find: m.find, replace: m.replace }];
  let mutated = original;
  let stale = null;
  for (const e of edits) {
    if (!e.replace.includes("MUTANT")) { stale = "replace lacks MUTANT marker"; break; }
    const n = mutated.split(e.find).length - 1;
    if (n !== 1) { stale = `anchor found ${n} times (need exactly 1): ${e.find.split("\n")[0].trim()}`; break; }
    mutated = mutated.replace(e.find, e.replace);
  }
  if (stale) {
    survived += 1;
    rows.push({ ...m, fail: "-", verdict: "STALE", failed: [], note: stale });
    continue;
  }
  try {
    await writeFile(path, mutated);
    const r = await buildAndTest();
    const killedByTest = r.code !== 0 && r.stage === "test";
    if (!killedByTest) survived += 1;
    rows.push({ ...m, fail: r.fail, verdict: r.code === 0 ? "SURVIVED" : r.stage === "build" ? "KILLED (build)" : "KILLED", failed: r.failed });
  } finally {
    await writeFile(path, original);
    if ((await readFile(path, "utf8")) !== original) {
      console.error(`RESTORE FAILED for ${m.file} at ${m.id}`);
      process.exit(3);
    }
  }
}

const W = { id: 4, what: 66, rule: 50, fail: 7 };
console.log(`${pad("#", W.id)} | ${pad("変異", W.what)} | ${pad("壊した規則", W.rule)} | ${pad("fail 数", W.fail)} | KILLED/SURVIVED`);
console.log(`${"-".repeat(W.id)}-|-${"-".repeat(W.what)}-|-${"-".repeat(W.rule)}-|-${"-".repeat(W.fail)}-|----------------`);
for (const r of rows) console.log(`${pad(r.id, W.id)} | ${pad(r.what, W.what)} | ${pad(r.rule, W.rule)} | ${pad(r.fail, W.fail)} | ${r.verdict}`);
console.log("");
for (const r of rows) {
  if (r.verdict === "KILLED" && r.failed.length > 0) console.log(`${r.id}  ${r.file}  ✖ ${r.failed.slice(0, 3).join(" / ")}${r.failed.length > 3 ? ` … +${r.failed.length - 3}` : ""}`);
  else if (r.verdict === "STALE") console.log(`${r.id}  ${r.file}  STALE ← ${r.note}`);
  else if (r.verdict !== "KILLED") console.log(`${r.id}  ${r.file}  ${r.verdict} ← テストに守られていない。消さずに報告する`);
}
console.log("");

const leftover = await countMutantMarkers();
if (leftover !== 0) {
  console.error(`RESTORE FAILED — ${leftover} MUTANT marker(s) remain in src.`);
  process.exit(3);
}
const after = await buildAndTest();
if (after.code !== 0) {
  console.error(`RESTORE FAILED — the tree is not green after restoring (stage ${after.stage}, fail ${after.fail}).`);
  process.exit(3);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`restored: green (fail ${after.fail}) — MUTANT markers in src: 0`);
console.log(survived === 0 ? `all ${rows.length} mutations killed in ${secs}s` : `${survived} of ${rows.length} mutation(s) survived, stale or type-killed in ${secs}s`);
process.exitCode = survived === 0 ? 0 : 1;

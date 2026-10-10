#!/usr/bin/env node
/**
 * **偽の緑を作らない。変異で確かめる。**（Celo レーン・2026-10-10）
 *
 * Celo の購入レーン（eip155:42220）の関門を **1 つずつわざと壊してから、Celo のテストが赤くなるかを見る**。
 * 赤くならない変異（SURVIVED）があれば、その関門は検査されていないので、テストを足す。生き残りは
 * 「発見」として報告し、この表から消さない。
 *
 *   node scripts/test-mutations-celo-lane.mjs
 *   TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> node scripts/test-mutations-celo-lane.mjs
 *
 * 構造は `packages/sdk/test-mutations.mjs`・`examples/ethonline-2026-ab/test-mutations.mjs` と同じ:
 *   - 走らせる前に「今が緑であること」を確かめ、緑でなければ何も変異させない
 *   - 変異はソースを**その場で**書き換え、必ず元へ戻す（finally）
 *   - 復元後に緑を再確認し、`MUTANT` マーカーが対象ファイルに残っていないことを確かめる
 *   - SURVIVED / STALE が 1 つでもあれば exit 1
 *
 * 違いは 1 つだけ: 購入ランナー（l1-runner.ts）の関門は DB を通したテスト（tests/l1-celo-lane.pg.test.ts）でしか
 * 見えない。`needsDb: true` の変異は TEST_DATABASE_URL があるときだけ走らせ、無ければ **NOT RUN** と表に出して
 * exit 1 にする（走らせていないものは緑ではなく未知）。DB の変異を承知で飛ばすときだけ `--no-db`。
 * TEST_DATABASE_URL のテストは TRUNCATE から始まる——他のセッションと共有していない自分用の DB を渡すこと
 * （Neon のホストは tests/helpers/pg-test-guard.ts が拒否する）。
 *
 * 各変異は `/* MUTANT *\/` を含む文字列に置き換えるので、復元漏れは `grep -rn MUTANT src` で機械的に見つかる。
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYER = "src/lib/observatory/x402-payer.ts";
const BUDGET = "src/lib/observatory/budget.ts";
const RUNNER = "src/lib/observatory/l1-runner.ts";
const VERIFY = "src/lib/observatory/settlement-verify.ts";
const FUNDS = "src/lib/observatory/payer-funds.ts";
const SOURCES = [PAYER, BUDGET, RUNNER, VERIFY, FUNDS];

/** DB なしで走る Celo のテスト。 */
const UNIT_TESTS = [
  "tests/x402-celo-lane.test.ts",
  "tests/settlement-verify-celo.test.ts",
  "tests/l1-chain-daily-cap.test.ts",
  "tests/payer-funds.test.ts",
];
/** DB を通す Celo のテスト（TEST_DATABASE_URL があるときだけ）。 */
const DB_TESTS = ["tests/l1-celo-lane.pg.test.ts"];

/**
 * `find` は**ちょうど 1 回**出現する文字列でなければならない（0 回は stale、2 回以上は意図しない場所を壊す）。
 * 全部の `replace` に `MUTANT` を含める——復元漏れの検出はこの語に頼る。
 */
const MUTATIONS = [
  // ---- 既定で止まっていること ----
  {
    id: "C01",
    what: "Celo の行のフラグを外す（env が無くても署名できる）",
    rule: "OBSERVATORY_CELO_L1_ENABLED が \"true\" のときだけ",
    file: PAYER,
    find: '  flagEnv: "OBSERVATORY_CELO_L1_ENABLED",',
    replace: "  flagEnv: /* MUTANT */ null,",
  },
  {
    id: "C02",
    what: "ランナーが Celo のレーンをフラグ無しで ready にする",
    rule: "フラグ off なら Celo の候補に 1 リクエストも出さない",
    file: RUNNER,
    needsDb: true,
    find: '    { chain: "celo", ready: isCeloL1Enabled() },',
    replace: '    { chain: "celo", ready: /* MUTANT */ true },',
  },
  // ---- 日次上限 ----
  {
    id: "C03",
    what: "Celo の network を別枠の表から外す（共有 $25 だけになる）",
    rule: "Celo の支出は L1_CELO_DAILY_CAP_USD の内側",
    file: BUDGET,
    find: '  if (network === "eip155:42220") return "celo";',
    replace: '  if (/* MUTANT */ false && network === "eip155:42220") return "celo";',
  },
  {
    id: "C04",
    what: "Celo の別枠の LIKE をワイルドカードにする（他の EVM の支出を数える）",
    rule: "別枠は eip155:42220 の完全一致",
    file: BUDGET,
    find: '  celo: { env: "L1_CELO_DAILY_CAP_USD", defaultUsd: CELO_DAILY_CAP_USD_DEFAULT, networkLike: "eip155:42220" },',
    replace: '  celo: { env: "L1_CELO_DAILY_CAP_USD", defaultUsd: CELO_DAILY_CAP_USD_DEFAULT, networkLike: /* MUTANT */ "eip155:%" },',
  },
  // ---- 資産と EIP-712 ドメイン ----
  {
    id: "C05",
    what: "固定した Celo の USDC を USDT の住所に差し替える",
    rule: "Celo で署名するのは USDC 0xcebA…118C だけ",
    file: PAYER,
    find: 'export const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";',
    replace: 'export const CELO_USDC = /* MUTANT */ "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";',
  },
  {
    id: "C06",
    what: "固定した EIP-712 の name を Base の \"USD Coin\" にする",
    rule: "ドメインはチェーン上の DOMAIN_SEPARATOR() と一致",
    file: PAYER,
    find: 'export const CELO_USDC_EIP712_NAME = "USDC";',
    replace: 'export const CELO_USDC_EIP712_NAME = /* MUTANT */ "USD Coin";',
  },
  {
    id: "C07",
    what: "固定した chainId を Base の 8453 にする",
    rule: "Celo の署名は chainId 42220 のドメイン",
    file: PAYER,
    find: "  chainId: 42220,",
    replace: "  chainId: /* MUTANT */ 8453,",
  },
  // ---- 残高 ----
  {
    id: "C08",
    what: "Celo の accept の残高を Base の残高で判定する",
    rule: "署名の前に読む残高は celo（Base の残高で通さない）",
    file: RUNNER,
    needsDb: true,
    find: 'evmPayChainId === 42220 ? "celo" : "base";',
    replace: 'evmPayChainId === 42220 ? /* MUTANT */ "base" : "base";',
  },
  {
    id: "C09",
    what: "既定の読み手が chain \"celo\" を Celo の RPC で読まない（Solana の枝へ落ちる）",
    rule: "Celo の残高は Celo の USDC の balanceOf",
    file: FUNDS,
    find: '  if (chain === "celo") {',
    replace: '  if (/* MUTANT */ false && chain === "celo") {',
  },
  {
    id: "C13",
    what: "Celo の残高不足でもレーンの優先を閉じない（Base へ落とさない）",
    rule: "Celo が資金切れでも Base 先頭の出品は Base で買える",
    file: RUNNER,
    needsDb: true,
    find: '      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "celo") {',
    replace: '      if (/* MUTANT */ false && outcome.kind === "payer_unfunded" && outcome.payerChain === "celo") {',
  },
  // ---- 決済の再読 ----
  {
    id: "C10",
    what: "CELO_RPC_URL が無いとき Base の client で Celo の行を読む",
    rule: "CELO_RPC_URL が無ければ未確認のまま置く",
    file: VERIFY,
    find: "    if (!process.env.CELO_RPC_URL?.trim()) return null;",
    replace: "    if (!process.env.CELO_RPC_URL?.trim()) return /* MUTANT */ getPublicClient();",
  },
  {
    id: "C11",
    what: "再読が Transfer の宛先（payTo）を見ない",
    rule: "宣言の payTo への Transfer だけが決済",
    file: VERIFY,
    find: "    if (topicToAddress(to) !== payToLower) return false;",
    replace: "    if (/* MUTANT */ false && topicToAddress(to) !== payToLower) return false;",
  },
  {
    id: "C12",
    what: "再読が Transfer の額を見ない",
    rule: "署名した額ちょうどの Transfer だけが決済",
    file: VERIFY,
    find: "    return value === expectedValue;",
    replace: "    return /* MUTANT */ value >= 0n || value === expectedValue;",
  },
];

// ---------- 実行器 ----------

const NO_DB = process.argv.includes("--no-db");
const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function summarize(t) {
  const fail = /^ℹ fail (\d+)$/m.exec(t.out)?.[1] ?? "?";
  const failed = [...t.out.matchAll(/^ {0,4}✖ (.+?) \(/gm)].map((m) => m[1]);
  return { code: t.code, fail, failed: [...new Set(failed)] };
}

/** DB なしのテスト（TEST_DATABASE_URL を外して走らせる——pg のテストを巻き込まない）。 */
async function unitTests() {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  return summarize(await run(TSX, ["--test", ...UNIT_TESTS], env));
}

/** DB を通すテスト。TRUNCATE から始まるので直列で。 */
async function dbTests() {
  return summarize(await run(TSX, ["--test", "--test-force-exit", "--test-concurrency=1", ...DB_TESTS], process.env));
}

async function testFor(needsDb) {
  if (needsDb) return { ...(await dbTests()), suite: "db" };
  return { ...(await unitTests()), suite: "unit" };
}

async function countMutantMarkers() {
  let n = 0;
  for (const f of SOURCES) n += (await readFile(join(ROOT, f), "utf8")).split("MUTANT").length - 1;
  return n;
}

function pad(s, w) {
  // 全角は 2 幅として揃える（表を等幅で読めるように）。
  const width = [...String(s)].reduce((a, c) => a + (/[^\x00-\x7f]/.test(c) ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, w - width));
}

const t0 = Date.now();

if ((await countMutantMarkers()) !== 0) {
  console.error("src に MUTANT マーカーが残っている。前回の復元が失敗している。`git diff src` を見ること。");
  process.exit(2);
}

const baselineUnit = await unitTests();
if (baselineUnit.code !== 0) {
  console.error(`baseline (unit) is not green (fail ${baselineUnit.fail}) — refusing to mutate.`);
  process.exit(2);
}
let baselineDb = null;
if (HAS_DB) {
  baselineDb = await dbTests();
  if (baselineDb.code !== 0) {
    console.error(`baseline (db) is not green (fail ${baselineDb.fail}) — refusing to mutate.`);
    process.exit(2);
  }
}
console.log(`baseline: green (unit fail ${baselineUnit.fail}${baselineDb ? `, db fail ${baselineDb.fail}` : ", db not run — TEST_DATABASE_URL is not set"})\n`);

const rows = [];
let survived = 0;
let notRun = 0;
for (const m of MUTATIONS) {
  if (m.needsDb && !HAS_DB) {
    notRun += 1;
    rows.push({ ...m, fail: "-", verdict: "NOT RUN", failed: [], note: "needs TEST_DATABASE_URL" });
    continue;
  }
  const path = join(ROOT, m.file);
  const original = await readFile(path, "utf8");
  let stale = null;
  if (!m.replace.includes("MUTANT")) stale = "replace lacks MUTANT marker";
  const n = original.split(m.find).length - 1;
  if (!stale && n !== 1) stale = `anchor found ${n} times (need exactly 1): ${m.find.split("\n")[0].trim()}`;
  if (stale) {
    survived += 1;
    rows.push({ ...m, fail: "-", verdict: "STALE", failed: [], note: stale });
    continue;
  }
  try {
    await writeFile(path, original.replace(m.find, m.replace));
    const r = await testFor(Boolean(m.needsDb));
    const killed = r.code !== 0;
    if (!killed) survived += 1;
    rows.push({ ...m, fail: r.fail, verdict: killed ? "KILLED" : "SURVIVED", failed: r.failed });
  } finally {
    // **必ず戻す。** 戻せなければ、それ自体を大声で言う。
    await writeFile(path, original);
    if ((await readFile(path, "utf8")) !== original) {
      console.error(`RESTORE FAILED for ${m.file} at ${m.id}`);
      process.exit(3);
    }
  }
}

// ---------- 表 ----------
const W = { id: 4, what: 70, rule: 52, suite: 5, fail: 7 };
console.log(`${pad("#", W.id)} | ${pad("変異", W.what)} | ${pad("壊した規則", W.rule)} | ${pad("suite", W.suite)} | ${pad("fail 数", W.fail)} | KILLED/SURVIVED`);
console.log(`${"-".repeat(W.id)}-|-${"-".repeat(W.what)}-|-${"-".repeat(W.rule)}-|-${"-".repeat(W.suite)}-|-${"-".repeat(W.fail)}-|----------------`);
for (const r of rows) {
  console.log(`${pad(r.id, W.id)} | ${pad(r.what, W.what)} | ${pad(r.rule, W.rule)} | ${pad(r.needsDb ? "db" : "unit", W.suite)} | ${pad(r.fail, W.fail)} | ${r.verdict}`);
}
console.log("");
for (const r of rows) {
  if (r.verdict === "KILLED" && r.failed.length > 0) {
    console.log(`${r.id}  ${r.file}  ✖ ${r.failed.slice(0, 3).join(" / ")}${r.failed.length > 3 ? ` … +${r.failed.length - 3}` : ""}`);
  } else if (r.verdict === "SURVIVED") {
    console.log(`${r.id}  ${r.file}  SURVIVED ← この関門はテストに守られていない。消さずに報告する`);
  } else if (r.verdict === "STALE") {
    console.log(`${r.id}  ${r.file}  STALE ← ${r.note}`);
  } else if (r.verdict === "NOT RUN") {
    console.log(`${r.id}  ${r.file}  NOT RUN ← ${r.note}（走らせていないものは緑ではない）`);
  }
}
console.log("");

// ---------- 復元の確認 ----------
const leftover = await countMutantMarkers();
if (leftover !== 0) {
  console.error(`RESTORE FAILED — ${leftover} MUTANT marker(s) remain in src. Check \`git diff src\`.`);
  process.exit(3);
}
const afterUnit = await unitTests();
const afterDb = HAS_DB ? await dbTests() : null;
if (afterUnit.code !== 0 || (afterDb && afterDb.code !== 0)) {
  console.error(`RESTORE FAILED — the tree is not green after restoring (unit fail ${afterUnit.fail}${afterDb ? `, db fail ${afterDb.fail}` : ""}).`);
  process.exit(3);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`restored: green (unit fail ${afterUnit.fail}${afterDb ? `, db fail ${afterDb.fail}` : ""}) — MUTANT markers in src: 0`);
const ran = rows.length - notRun;
if (survived === 0 && notRun === 0) console.log(`all ${rows.length} mutations killed in ${secs}s`);
else if (survived === 0) console.log(`all ${ran} mutations that ran were killed; ${notRun} not run (needs TEST_DATABASE_URL) in ${secs}s`);
else console.log(`${survived} of ${ran} mutation(s) survived (or stale)${notRun ? `; ${notRun} not run` : ""} in ${secs}s`);
process.exitCode = survived === 0 && (notRun === 0 || NO_DB) ? 0 : 1;

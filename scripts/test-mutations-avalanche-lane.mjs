#!/usr/bin/env node
/**
 * **偽の緑を作らない。変異で確かめる。**（Avalanche レーン・2026-10-26）
 *
 * Avalanche C-Chain の購入レーン（eip155:43114）の関門を **1 つずつわざと壊してから、Avalanche のテストが赤くなるかを見る**。
 * 赤くならない変異（SURVIVED）があれば、その関門は検査されていないので、テストを足す。生き残りは
 * 「発見」として報告し、この表から消さない。
 *
 *   node scripts/test-mutations-avalanche-lane.mjs
 *   TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> node scripts/test-mutations-avalanche-lane.mjs
 *
 * 構造は `scripts/test-mutations-arbitrum-lane.mjs` と同じ。
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
const RECOVER = "src/lib/settlements/recover-late.ts";
const SOURCES = [PAYER, BUDGET, RUNNER, VERIFY, FUNDS, RECOVER];

const UNIT_TESTS = [
  "tests/x402-avalanche-lane.test.ts",
  "tests/settlement-verify-avalanche.test.ts",
  "tests/l1-chain-daily-cap.test.ts",
  "tests/payer-funds.test.ts",
  "tests/late-settlement-avalanche-reader.test.ts",
];
const DB_TESTS = ["tests/l1-avalanche-lane.pg.test.ts", "tests/late-settlement-avalanche.pg.test.ts"];

const MUTATIONS = [
  {
    id: "A01",
    what: "Avalanche の行のフラグを外す（env が無くても署名できる）",
    rule: "OBSERVATORY_AVALANCHE_L1_ENABLED が \"true\" のときだけ",
    file: PAYER,
    find: '  flagEnv: "OBSERVATORY_AVALANCHE_L1_ENABLED",',
    replace: "  flagEnv: /* MUTANT */ null,",
  },
  {
    id: "A02",
    what: "ランナーが Avalanche のレーンをフラグ無しで ready にする",
    rule: "フラグ off なら Avalanche の候補に 1 リクエストも出さない",
    file: RUNNER,
    needsDb: true,
    find: '    { chain: "avalanche", ready: isAvalancheL1Enabled() && !!process.env.AVALANCHE_RPC_URL?.trim() },',
    replace: '    { chain: "avalanche", ready: /* MUTANT */ !!process.env.AVALANCHE_RPC_URL?.trim() },',
  },
  {
    id: "A03",
    what: "Avalanche の network を別枠の表から外す（共有 $25 だけになる）",
    rule: "Avalanche の支出は L1_AVALANCHE_DAILY_CAP_USD の内側",
    file: BUDGET,
    find: '  if (network === "eip155:43114") return "avalanche";',
    replace: '  if (/* MUTANT */ false && network === "eip155:43114") return "avalanche";',
  },
  {
    id: "A04",
    what: "Avalanche の別枠の LIKE をワイルドカードにする（他の EVM の支出を数える）",
    rule: "別枠は eip155:43114 の完全一致",
    file: BUDGET,
    find: '  avalanche: { env: "L1_AVALANCHE_DAILY_CAP_USD", defaultUsd: AVALANCHE_DAILY_CAP_USD_DEFAULT, networkLike: "eip155:43114" },',
    replace: '  avalanche: { env: "L1_AVALANCHE_DAILY_CAP_USD", defaultUsd: AVALANCHE_DAILY_CAP_USD_DEFAULT, networkLike: /* MUTANT */ "eip155:%" },',
  },
  {
    id: "A05",
    what: "固定した Avalanche の USDC を USDC.e の住所に差し替える",
    rule: "Avalanche で署名するのはネイティブ USDC 0xB97E…8a6E だけ",
    file: PAYER,
    find: 'export const AVALANCHE_USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";',
    replace: 'export const AVALANCHE_USDC = /* MUTANT */ "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664";',
  },
  {
    id: "A06",
    what: "固定した EIP-712 の name を Celo の \"USDC\" にする",
    rule: "ドメインはチェーン上の DOMAIN_SEPARATOR() と一致",
    file: PAYER,
    find: 'export const AVALANCHE_USDC_EIP712_NAME = "USD Coin";',
    replace: 'export const AVALANCHE_USDC_EIP712_NAME = /* MUTANT */ "USDC";',
  },
  {
    id: "A07",
    what: "固定した chainId を Base の 8453 にする",
    rule: "Avalanche の署名は chainId 43114 のドメイン",
    file: PAYER,
    find: "  chainId: 43114,",
    replace: "  chainId: /* MUTANT */ 8453,",
  },
  {
    id: "A08",
    what: "Avalanche の accept の残高を Base の残高で判定する",
    rule: "署名の前に読む残高は avalanche（Base の残高で通さない）",
    file: RUNNER,
    needsDb: true,
    find: 'evmPayChainId === 43114 ? "avalanche" : "base";',
    replace: 'evmPayChainId === 43114 ? /* MUTANT */ "base" : "base";',
  },
  {
    id: "A09",
    what: "既定の読み手が chain \"avalanche\" を Avalanche の RPC で読まない（Solana の枝へ落ちる）",
    rule: "Avalanche の残高はネイティブ USDC の balanceOf",
    file: FUNDS,
    find: '  if (chain === "avalanche") {',
    replace: '  if (/* MUTANT */ false && chain === "avalanche") {',
  },
  {
    id: "A13",
    what: "Avalanche の残高不足でもレーンの優先を閉じない（Base へ落とさない）",
    rule: "Avalanche が資金切れでも Base 先頭の出品は Base で買える",
    file: RUNNER,
    needsDb: true,
    find: '      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "avalanche") {',
    replace: '      if (/* MUTANT */ false && outcome.kind === "payer_unfunded" && outcome.payerChain === "avalanche") {',
  },
  {
    id: "A10",
    what: "AVALANCHE_RPC_URL が無いとき Base の client で Avalanche の行を読む",
    rule: "AVALANCHE_RPC_URL が無ければ未確認のまま置く",
    file: VERIFY,
    find: "    if (!process.env.AVALANCHE_RPC_URL?.trim()) return null;",
    replace: "    if (!process.env.AVALANCHE_RPC_URL?.trim()) return /* MUTANT */ getPublicClient();",
  },
  {
    id: "A11",
    what: "再読が Transfer の宛先（payTo）を見ない",
    rule: "宣言の payTo への Transfer だけが決済",
    file: VERIFY,
    find: "    if (topicToAddress(to) !== payToLower) return false;",
    replace: "    if (/* MUTANT */ false && topicToAddress(to) !== payToLower) return false;",
  },
  {
    id: "A12",
    what: "再読が Transfer の額を見ない",
    rule: "署名した額ちょうどの Transfer だけが決済",
    file: VERIFY,
    find: "    return value === expectedValue;",
    replace: "    return /* MUTANT */ value >= 0n || value === expectedValue;",
  },
  {
    id: "A14",
    what: "回収が、その行の nonce が tx で消費されたかを見ない",
    rule: "額・宛先が合っても nonce の無い tx は貼らない",
    file: RECOVER,
    needsDb: true,
    find: "    if (!consumed.get(tx)?.has(nonce)) continue;",
    replace: "    if (/* MUTANT */ false && !consumed.get(tx)?.has(nonce)) continue;",
  },
  {
    id: "A15",
    what: "レシートが読めない tx を「nonce なし」として先へ進む",
    rule: "RPC が読めない回は行を変えない（印も付けない）",
    file: RECOVER,
    needsDb: true,
    find: '    if (nonces === null) return { unreadable: "a candidate transaction\'s receipt could not be read" };',
    replace: "    if (nonces === null) /* MUTANT */ continue;",
  },
  {
    id: "A16",
    what: "Avalanche のレーンが auth_nonce の無い行も選ぶ",
    rule: "回収するのは署名して送った行（nonce あり）だけ",
    file: RECOVER,
    needsDb: true,
    find: "      AND (${lane.nonceBound}::boolean IS NOT TRUE OR lower(btrim(coalesce(pu.auth_nonce, ''))) ~ '^0x[0-9a-f]{64}$')",
    replace: "      AND (/* MUTANT */ TRUE OR lower(btrim(coalesce(pu.auth_nonce, ''))) ~ '^0x[0-9a-f]{64}$')",
  },
  {
    id: "A17",
    what: "回収が着金の額を見ない",
    rule: "署名した額ちょうどの着金だけが候補",
    file: RECOVER,
    needsDb: true,
    find: "t.to.toLowerCase() === g.pay_to && t.value === g.amount_units && Number.isFinite",
    replace: "t.to.toLowerCase() === g.pay_to && /* MUTANT */ true && Number.isFinite",
  },
  {
    id: "A18",
    what: "回収が着金の宛先を見ない",
    rule: "その購入で署名した payTo への着金だけが候補",
    file: RECOVER,
    needsDb: true,
    find: "t.from.toLowerCase() === g.payer && t.to.toLowerCase() === g.pay_to && t.value",
    replace: "t.from.toLowerCase() === g.payer && /* MUTANT */ true && t.value",
  },
  {
    id: "A19",
    what: "回収が着金の時刻の窓を見ない",
    rule: "試行の 2 分前〜30 分後の着金だけが候補",
    file: RECOVER,
    needsDb: true,
    find: "        if (bt < at - backMs || bt > at + winMs) continue;",
    replace: "        if (/* MUTANT */ false && (bt < at - backMs || bt > at + winMs)) continue;",
  },
  {
    id: "A20",
    what: "Avalanche の読み手が Base の USDC の住所で Transfer を読む",
    rule: "読むのはネイティブ USDC 0xB97E…8a6E の Transfer だけ",
    file: RECOVER,
    find: "        address: AVALANCHE_USDC_ADDRESS,",
    replace: "        address: /* MUTANT */ BASE_USDC,",
  },
  {
    id: "A21",
    what: "Avalanche の読み手が RPC の chainId を確かめない",
    rule: "別のチェーンの空の結果を「着金なし」と読まない",
    file: RECOVER,
    find: "    if (chainId !== AVALANCHE_CHAIN_ID) return null;",
    replace: "    if (/* MUTANT */ false && chainId !== AVALANCHE_CHAIN_ID) return null;",
  },
  {
    id: "A22",
    what: "AVALANCHE_RPC_URL が無いとき公開 RPC で読む",
    rule: "AVALANCHE_RPC_URL が無ければ読まない（何も変えない）",
    file: RECOVER,
    find: "  const url = process.env.AVALANCHE_RPC_URL?.trim();\n  if (!url) return null;",
    replace: '  const url = process.env.AVALANCHE_RPC_URL?.trim() || /* MUTANT */ "https://api.avax.network/ext/bc/C/rpc";\n  if (!url) return null;',
  },
  {
    id: "A23",
    what: "Avalanche の読み手が、先端が窓に届いていない RPC の結果を使う",
    rule: "遅れているノードの空の結果を「着金なし」と読まない",
    file: RECOVER,
    find: "    if (chainId !== AVALANCHE_CHAIN_ID) return null;\n    const headMs = Number(head.timestamp) * 1000;\n    if (headMs < to.getTime()) return null;",
    replace: "    if (chainId !== AVALANCHE_CHAIN_ID) return null;\n    const headMs = Number(head.timestamp) * 1000;\n    if (/* MUTANT */ false && headMs < to.getTime()) return null;",
  },
  {
    id: "A24",
    what: "Avalanche のレーンが応答なしの行を先頭に置かない",
    rule: "応答なしの行は、新しい 402 の行より先に読む",
    file: RECOVER,
    needsDb: true,
    find: "(CASE WHEN pu.http_status_paid IS NULL THEN 0 WHEN pu.http_status_paid = 402 THEN 2 ELSE 1 END) ASC,",
    replace: "(CASE WHEN /* MUTANT */ FALSE THEN 0 WHEN pu.http_status_paid = 402 THEN 2 ELSE 1 END) ASC,",
  },
  {
    id: "A25",
    what: "Avalanche のレーンが 402 の行を最後に回さない",
    rule: "402 の行は、ほかの応答の行の後に読む",
    file: RECOVER,
    needsDb: true,
    find: "(CASE WHEN pu.http_status_paid IS NULL THEN 0 WHEN pu.http_status_paid = 402 THEN 2 ELSE 1 END) ASC,",
    replace: "(CASE WHEN pu.http_status_paid IS NULL THEN 0 WHEN /* MUTANT */ FALSE THEN 2 ELSE 1 END) ASC,",
  },
  {
    id: "A26",
    what: "離れた行を 1 つの組として端から端まで読む",
    rule: "窓が重ならない行は、行ごとの窓で読む",
    file: RECOVER,
    needsDb: true,
    find: "        if (prev !== null && t - prev > winMs + backMs) idx++;",
    replace: "        if (/* MUTANT */ false && prev !== null && t - prev > winMs + backMs) idx++;",
  },
  {
    id: "A27",
    what: "読めなかった組をログに出さない",
    rule: "読めなかった組は 1 行ログに残す",
    file: RECOVER,
    needsDb: true,
    find: "    if (!lane.rowWindows) continue;",
    replace: "    if (/* MUTANT */ true || !lane.rowWindows) continue;",
  },
  {
    id: "A28",
    what: "呼び手の締切を Avalanche のレーンの持ち時間に掛けない",
    rule: "締切を過ぎた回は Avalanche の行を読まない",
    file: RECOVER,
    needsDb: true,
    find: "            options.avalancheChainReadBudgetMs ?? AVALANCHE_CHAIN_READ_BUDGET_MS,\n            typeof options.deadlineAt === \"number\" ? options.deadlineAt - Date.now() : Infinity,",
    replace: "            options.avalancheChainReadBudgetMs ?? AVALANCHE_CHAIN_READ_BUDGET_MS,\n            /* MUTANT */ false && typeof options.deadlineAt === \"number\" ? options.deadlineAt - Date.now() : Infinity,",
  },
];

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

async function unitTests() {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  return summarize(await run(TSX, ["--test", ...UNIT_TESTS], env));
}

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
  console.error(baselineUnit.failed.join("\n"));
  process.exit(2);
}
let baselineDb = null;
if (HAS_DB) {
  baselineDb = await dbTests();
  if (baselineDb.code !== 0) {
    console.error(`baseline (db) is not green (fail ${baselineDb.fail}) — refusing to mutate.`);
    console.error(baselineDb.failed.join("\n"));
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
    rows.push({ ...m, fail: "-", verdict: "STALE", failed: [], note: stale });
    survived += 1;
    continue;
  }
  await writeFile(path, original.replace(m.find, m.replace));
  let result;
  try {
    result = await testFor(m.needsDb);
  } finally {
    await writeFile(path, original);
  }
  const killed = result.code !== 0;
  const verdict = killed ? "KILLED" : "SURVIVED";
  if (!killed) survived += 1;
  rows.push({ ...m, fail: result.fail, verdict, failed: result.failed, note: result.suite });
}

if ((await countMutantMarkers()) !== 0) {
  console.error("復元後に MUTANT マーカーが残っている。");
  process.exit(2);
}

console.log(`${pad("id", 5)} ${pad("verdict", 10)} ${pad("fail", 6)} ${pad("what", 56)} rule`);
console.log("-".repeat(120));
for (const r of rows) {
  console.log(`${pad(r.id, 5)} ${pad(r.verdict, 10)} ${pad(r.fail, 6)} ${pad(r.what, 56)} ${r.rule}`);
  if (r.note && r.verdict !== "KILLED") console.log(`      ${r.note}`);
}

const killed = rows.filter((r) => r.verdict === "KILLED").length;
const stale = rows.filter((r) => r.verdict === "STALE").length;
console.log(
  `\n${killed} KILLED / ${survived} SURVIVED+STALE / ${notRun} NOT RUN  (${((Date.now() - t0) / 1000).toFixed(1)}s)${NO_DB ? "  [--no-db]" : ""}`,
);
if (stale) console.log(`${stale} STALE (anchor missing or duplicated — the mutation did not run).`);
if (notRun && !NO_DB) {
  console.log("DB mutations were not run. Pass TEST_DATABASE_URL or --no-db to skip them on purpose.");
  process.exit(1);
}
process.exit(survived === 0 && (NO_DB || notRun === 0) ? 0 : 1);

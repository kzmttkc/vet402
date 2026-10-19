#!/usr/bin/env node
/**
 * **偽の緑を作らない。変異で確かめる。**（BNB レーン・2026-10-19・段B1）
 *
 * BNB Chain（eip155:56）の金の関門を 1 つずつわざと壊してから、テストが赤くなるかを見る。
 * 赤くならない変異（SURVIVED）があれば、その関門は検査されていない。
 * 生き残りは「発見」として報告し、この表から消さない。
 *
 *   node scripts/test-mutations-bnb-lane.mjs
 *
 * 構造は `scripts/test-mutations-stellar-lane.mjs` と同じ。
 * 段B2b: ランナーの変異（B19〜B21）は DB のテスト。TEST_DATABASE_URL が無ければ NOT RUN。
 * 索引の 18→6 桁（B22）は DB 無しで落ちる。テストはネットに出ない。
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYER = "src/lib/observatory/x402-payer.ts";
const BUDGET = "src/lib/observatory/budget.ts";
const VERIFY = "src/lib/observatory/settlement-verify.ts";
const FUNDS = "src/lib/observatory/payer-funds.ts";
const RUNNER = "src/lib/observatory/l1-runner.ts";
const INDEX = "src/lib/settlements/index-evm.ts";
const BNB = "src/lib/chain/bnb.ts";
const SOURCES = [PAYER, BUDGET, VERIFY, FUNDS, RUNNER, INDEX, BNB];

const UNIT_TESTS = [
  "tests/x402-bnb-lane.test.ts",
  "tests/settlement-verify-bnb.test.ts",
  "tests/l1-chain-daily-cap.test.ts",
  "tests/payer-funds.test.ts",
  "tests/settlements-index-bnb.test.ts",
  "tests/late-settlement-bnb-reader.test.ts",
];
const DB_TESTS = ["tests/observatory-l1-runner.test.ts"];

/**
 * `find` は対象ファイルにちょうど 1 回。`replace` は必ず MUTANT を含む。
 */
const MUTATIONS = [
  {
    id: "B01",
    what: "BNB の行のフラグを外す（env が無くても署名できる）",
    rule: "OBSERVATORY_BNB_L1_ENABLED が \"true\" のときだけ",
    file: PAYER,
    find: '  flagEnv: "OBSERVATORY_BNB_L1_ENABLED",',
    replace: "  flagEnv: /* MUTANT */ null,",
  },
  {
    id: "B02",
    what: "isBnbL1Enabled を常に true にする",
    rule: "旗は正確に \"true\" のときだけ",
    file: PAYER,
    find: '  return process.env.OBSERVATORY_BNB_L1_ENABLED === "true";',
    replace: "  return /* MUTANT */ true;",
  },
  {
    id: "B03",
    what: "18 桁→6 桁の倍率を 1 にする",
    rule: "USD1 は 18 桁、台帳は 6 桁（×10^12）",
    file: PAYER,
    find: "export const BNB_LEDGER_SCALE = 10n ** 12n;",
    replace: "export const BNB_LEDGER_SCALE = /* MUTANT */ 1n;",
  },
  {
    id: "B04",
    what: "10^12 で割り切れない額を通す",
    rule: "割り切れない額は予約の前に unbuildable",
    file: PAYER,
    find: "  if (assetUnits % BNB_LEDGER_SCALE !== 0n) return null;",
    replace: "  if (/* MUTANT */ false && assetUnits % BNB_LEDGER_SCALE !== 0n) return null;",
  },
  {
    id: "B05",
    what: "固定した USD1 の住所を別のトークンにする",
    rule: "署名するのは USD1 0x8d0D…8B0d だけ",
    file: PAYER,
    find: 'export const BNB_USD1 = "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d";',
    replace: 'export const BNB_USD1 = /* MUTANT */ "0x3333333333333333333333333333333333333333";',
  },
  {
    id: "B06",
    what: "EIP-712 の name を Base の \"USD Coin\" にする",
    rule: "ドメインは accept の extra と照合する固定名",
    file: PAYER,
    find: 'export const BNB_USD1_EIP712_NAME = "World Liberty Financial USD";',
    replace: 'export const BNB_USD1_EIP712_NAME = /* MUTANT */ "USD Coin";',
  },
  {
    id: "B07",
    what: "chainId を Base の 8453 にする",
    rule: "署名と照合は chain id 56",
    file: PAYER,
    find: "export const BNB_CHAIN_ID = 56;",
    replace: "export const BNB_CHAIN_ID = /* MUTANT */ 8453;",
  },
  {
    id: "B08",
    what: "申告額の文字列一致を外す",
    rule: "申告額は 18 桁どうしの完全一致",
    file: PAYER,
    find: "    if (priceDeclaredFor(accept) && accept.amount !== options.declaredAmount) continue;",
    replace: "    if (/* MUTANT */ false && priceDeclaredFor(accept) && accept.amount !== options.declaredAmount) continue;",
  },
  {
    id: "B09",
    what: "資産アドレスの一致を外す",
    rule: "USD1 以外（USDC・USDT など）は払わない",
    file: PAYER,
    find: '  if (accept.asset.toLowerCase() !== chain.usdc.toLowerCase()) return null;',
    replace: "  if (/* MUTANT */ false && accept.asset.toLowerCase() !== chain.usdc.toLowerCase()) return null;",
  },
  {
    id: "B10",
    what: "eip3009 以外の assetTransferMethod を通す",
    rule: "permit2 と permit2-exact は払わない",
    file: PAYER,
    find: '  if (method !== undefined && method !== "eip3009") return null;',
    replace: "  if (/* MUTANT */ false && method !== undefined && method !== \"eip3009\") return null;",
  },
  {
    id: "B11",
    what: "cappedChainFor から eip155:56 を外す",
    rule: "eip155:56 だけが bnb の 1 日の別枠",
    file: BUDGET,
    find: '  if (network === "eip155:56") return "bnb";',
    replace: '  if (/* MUTANT */ false && network === "eip155:56") return "bnb";',
  },
  {
    id: "B12",
    what: "BNB の 1 日の既定を共有上限いっぱいの $25 にする",
    rule: "既定は L1_BNB_DAILY_CAP_USD の $0.5",
    file: BUDGET,
    find: "export const BNB_DAILY_CAP_USD_DEFAULT = 0.5;",
    replace: "export const BNB_DAILY_CAP_USD_DEFAULT = /* MUTANT */ 25;",
  },
  {
    id: "B13",
    what: "別枠の LIKE をワイルドカードにする",
    rule: "別枠は eip155:56 の完全一致",
    file: BUDGET,
    find: '  bnb: { env: "L1_BNB_DAILY_CAP_USD", defaultUsd: BNB_DAILY_CAP_USD_DEFAULT, networkLike: "eip155:56" },',
    replace: '  bnb: { env: "L1_BNB_DAILY_CAP_USD", defaultUsd: BNB_DAILY_CAP_USD_DEFAULT, networkLike: /* MUTANT */ "eip155:%" },',
  },
  {
    id: "B14",
    what: "chain \"bnb\" の残高読みを飛ばす（Solana の枝へ落ちる）",
    rule: "署名の前に読むのは BNB 上の USD1",
    file: FUNDS,
    find: '  if (chain === "bnb") {',
    replace: '  if (/* MUTANT */ false && chain === "bnb") {',
  },
  {
    id: "B15",
    what: "18 桁の残高を切り上げる",
    rule: "台帳の 6 桁へは切り捨て",
    file: FUNDS,
    find: "    return raw / BNB_LEDGER_SCALE;",
    replace: "    return /* MUTANT */ (raw + BNB_LEDGER_SCALE - 1n) / BNB_LEDGER_SCALE;",
  },
  {
    id: "B16",
    what: "BNB_VERIFY_RPC_URL も BNB_RPC_URL も無いとき Base の client で BNB の行を読む",
    rule: "照合の RPC が無ければ未確認のまま置く（2026-10-20 から照合は getBnbVerifyClient）",
    file: VERIFY,
    find: "  if (chain.chainId === BNB_CHAIN_ID) return getBnbVerifyClient();",
    replace: "  if (chain.chainId === BNB_CHAIN_ID) return /* MUTANT */ getBnbVerifyClient() ?? getPublicClient();",
  },
  {
    id: "B16b",
    what: "照合の RPC の優先順を逆にする（BNB_RPC_URL を先に読む）",
    rule: "照合は古いレシートを返す BNB_VERIFY_RPC_URL を先に使う",
    file: BNB,
    find: "  const verify = process.env.BNB_VERIFY_RPC_URL?.trim();",
    replace: "  const verify = /* MUTANT */ process.env.BNB_RPC_URL?.trim() || process.env.BNB_VERIFY_RPC_URL?.trim();",
  },
  {
    id: "B16c",
    what: "最新の状態（authorizationState）を照合用の RPC で読む",
    rule: "authorizationState は BNB_RPC_URL で読む（期限の否定を止める最後の関門は照合とは別の情報源）",
    file: VERIFY,
    find: '  else if (chain.chainId === BNB_CHAIN_ID) client = process.env.BNB_RPC_URL?.trim() ? getBnbPublicClient("live") : null;',
    replace: "  else if (chain.chainId === BNB_CHAIN_ID) client = /* MUTANT */ getBnbVerifyClient();",
  },
  {
    id: "B17",
    what: "照合が台帳の 6 桁を 18 桁に直さない",
    rule: "チェーン上の額は台帳 × 10^12 と完全一致",
    file: VERIFY,
    find: "  if (chain.chainId === BNB_CHAIN_ID) expectedValue *= BNB_LEDGER_SCALE;",
    replace: "  if (/* MUTANT */ false && chain.chainId === BNB_CHAIN_ID) expectedValue *= BNB_LEDGER_SCALE;",
  },
  {
    id: "B18",
    what: "再読が Transfer の額を見ない",
    rule: "1 単位でも違えば決済ではない",
    file: VERIFY,
    find: "    return value === expectedValue;",
    replace: "    return /* MUTANT */ value >= 0n || value === expectedValue;",
  },
  {
    id: "B19",
    what: "BNB の宣言 payTo の集合を空にする",
    rule: "優先した BNB の payTo はカタログの eip155:56 の宣言と照合する",
    file: RUNNER,
    needsDb: true,
    find: "[BNB_CAIP2]: candidate.bnbDeclaredPayTos",
    replace: "[BNB_CAIP2]: /* MUTANT */ []",
  },
  {
    id: "B20",
    what: "未入金のあと bnb の優先を閉じない",
    rule: "未入金なら以後の bnb を閉じ、その候補は Base で買う",
    file: RUNNER,
    needsDb: true,
    find: '      if (outcome.kind === "payer_unfunded" && outcome.payerChain === "bnb") {',
    replace: '      if (/* MUTANT */ false && outcome.kind === "payer_unfunded" && outcome.payerChain === "bnb") {',
  },
  {
    id: "B21",
    what: "別枠が尽きても laneOpen(bnb) を通す",
    rule: "別枠が尽きた日は bnb を優先しない",
    file: RUNNER,
    needsDb: true,
    find: "laneOpen(candidate.laneChain) &&",
    replace: "/* MUTANT */ true &&",
  },
  {
    id: "X14",
    what: "旗 OFF の eip155:56 主ネットワークを候補から外す",
    rule: "旗 OFF のとき eip155:56 が主ネットワークの行を候補に残す",
    file: RUNNER,
    needsDb: true,
    find: '(lane.chain === "bnb" && process.env.OBSERVATORY_BNB_L1_ENABLED !== "true")',
    replace: '(lane.chain === "bnb" && /* MUTANT */ false)',
  },
  {
    id: "X15",
    what: "ready から BNB_RPC_URL の要求を外す",
    rule: "ready に BNB_RPC_URL を要求する",
    file: RUNNER,
    needsDb: true,
    find: '{ chain: "bnb", ready: isBnbL1Enabled() && !!process.env.BNB_RPC_URL?.trim() },',
    replace: '{ chain: "bnb", ready: isBnbL1Enabled() /* MUTANT */ },',
  },
  {
    id: "X18",
    what: "照合が BNB の Transfer の払い手を見ない",
    rule: "照合で BNB の払い手を見る",
    file: VERIFY,
    find: "    if (topicToAddress(from) !== payerLower) return false;",
    replace: "    if (/* MUTANT */ chain.chainId !== BNB_CHAIN_ID && topicToAddress(from) !== payerLower) return false;",
  },
  {
    id: "B22",
    what: "索引が 18 桁の USD1 を 6 桁に割らない",
    rule: "索引と遅延回収の額は 10^12 で割った 6 桁。割り切れない額は記録しない",
    file: INDEX,
    find: "  return bnbLedgerUnits(value);",
    replace: "  return /* MUTANT */ value;",
  },
];

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
  const plain = t.out.replace(/\u001b\[[0-9;]*m/g, "");
  const fail = /^ℹ fail (\d+)$/m.exec(plain)?.[1] ?? "?";
  const failed = [...plain.matchAll(/^ {0,4}✖ (.+?) \(/gm)].map((m) => m[1]);
  return { code: t.code, fail, failed: [...new Set(failed)] };
}

async function unitTests() {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  return summarize(await run(TSX, ["--test", "--test-concurrency=1", ...UNIT_TESTS], env));
}

async function dbTests() {
  return summarize(
    await run(TSX, ["--test", "--test-force-exit", "--test-concurrency=1", ...DB_TESTS], process.env),
  );
}

async function testFor(needsDb) {
  if (needsDb) return dbTests();
  return unitTests();
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
console.log(
  `baseline: green (unit fail ${baselineUnit.fail}${baselineDb ? `, db fail ${baselineDb.fail}` : ", db not run — TEST_DATABASE_URL is not set"})\n`,
);

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
    await writeFile(path, original);
    if ((await readFile(path, "utf8")) !== original) {
      console.error(`RESTORE FAILED for ${m.file} at ${m.id}`);
      process.exit(3);
    }
  }
}

const W = { id: 4, what: 52, rule: 48, fail: 7 };
console.log(`${pad("#", W.id)} | ${pad("変異", W.what)} | ${pad("壊した規則", W.rule)} | ${pad("fail 数", W.fail)} | KILLED/SURVIVED`);
console.log(`${"-".repeat(W.id)}-|-${"-".repeat(W.what)}-|-${"-".repeat(W.rule)}-|-${"-".repeat(W.fail)}-|----------------`);
for (const r of rows) {
  console.log(`${pad(r.id, W.id)} | ${pad(r.what, W.what)} | ${pad(r.rule, W.rule)} | ${pad(r.fail, W.fail)} | ${r.verdict}`);
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

const leftover = await countMutantMarkers();
if (leftover !== 0) {
  console.error(`RESTORE FAILED — ${leftover} MUTANT marker(s) remain in src. Check \`git diff src\`.`);
  process.exit(3);
}
const afterUnit = await unitTests();
const afterDb = HAS_DB ? await dbTests() : null;
if (afterUnit.code !== 0 || (afterDb && afterDb.code !== 0)) {
  console.error(
    `RESTORE FAILED — the tree is not green after restoring (unit fail ${afterUnit.fail}${afterDb ? `, db fail ${afterDb.fail}` : ""}).`,
  );
  process.exit(3);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`restored: green (unit fail ${afterUnit.fail}${afterDb ? `, db fail ${afterDb.fail}` : ""}) — MUTANT markers in src: 0`);
const ran = rows.length - notRun;
if (survived === 0 && notRun === 0) console.log(`all ${rows.length} mutations killed in ${secs}s`);
else if (survived === 0) console.log(`all ${ran} mutations that ran were killed; ${notRun} not run (needs TEST_DATABASE_URL) in ${secs}s`);
else console.log(`${survived} of ${ran} mutation(s) survived (or stale)${notRun ? `; ${notRun} not run` : ""} in ${secs}s`);
process.exitCode = survived === 0 && notRun === 0 ? 0 : 1;

#!/usr/bin/env node
/**
 * **偽の緑を作らない。変異で確かめる。**（Stellar レーン・2026-10-18、点検の直し）
 *
 * Stellar の購入レーン（stellar:pubnet）の金の関門を 1 つずつわざと壊してから、
 * テストが赤くなるかを見る。赤くならない変異（SURVIVED）があれば、その関門は検査されていない。
 * 生き残りは「発見」として報告し、この表から消さない。
 *
 *   node scripts/test-mutations-stellar-lane.mjs
 *   TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> node scripts/test-mutations-stellar-lane.mjs
 *
 * 構造は `scripts/test-mutations-celo-lane.mjs` と同じ。
 * S06・S07 と、v1 の壁・RPC の準備完了はランナー（l1-runner.ts）の経路なので DB が要る。
 * `needsDb: true` は TEST_DATABASE_URL があるときだけ走らせ、無ければ NOT RUN で exit 1
 * （走らせていないものは緑ではない）。DB のテストは TRUNCATE から始まる。
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYER = "src/lib/observatory/stellar402-payer.ts";
const BUDGET = "src/lib/observatory/budget.ts";
const RUNNER = "src/lib/observatory/l1-runner.ts";
const SOURCES = [PAYER, BUDGET, RUNNER];

const UNIT_TESTS = [
  "tests/stellar402-payer.test.ts",
  "tests/l1-chain-daily-cap.test.ts",
  "tests/stellar-ledger-network.test.ts",
];
/** ランナーの関門。1 ファイルの中で直列（共有 DB）。 */
const DB_TESTS = ["tests/observatory-l1-runner.test.ts"];

/**
 * `find` は対象ファイルにちょうど 1 回。`replace` は必ず MUTANT を含む。
 * S06 は payerFunds.check、S07 は reserveSpend の cappedChainFor。
 * 使っていない stellarFundsVerdict / wouldExceedStellarDailyCap は壊さない。
 */
const MUTATIONS = [
  {
    id: "S01",
    what: "旗を常に ON にする（env が無くても署名できる）",
    rule: "OBSERVATORY_STELLAR_L1_ENABLED が \"true\" のときだけ",
    file: PAYER,
    find: '  return process.env.OBSERVATORY_STELLAR_L1_ENABLED === "true";',
    replace: "  return /* MUTANT */ true;",
  },
  {
    id: "S02",
    what: "select が旗を見ない",
    rule: "旗 OFF なら accept があっても選ばない",
    file: PAYER,
    find: "  if (!isStellarL1Enabled()) {",
    replace: "  if (/* MUTANT */ false && !isStellarL1Enabled()) {",
  },
  {
    id: "S03",
    what: "1 件の上限を見ない",
    rule: "MAX_PER_PURCHASE_UNITS を 7 桁に直した額を超えたら署名しない",
    file: PAYER,
    find: "    if (stellarUnits > maxStellarUnits) continue;",
    replace: "    if (/* MUTANT */ false && stellarUnits > maxStellarUnits) continue;",
  },
  {
    id: "S04",
    what: "7 桁→6 桁の倍率を 1 にする（上限が 10 倍緩くなる）",
    rule: "Stellar USDC は 7 桁、台帳は 6 桁",
    file: PAYER,
    find: "export const STELLAR_LEDGER_SCALE = 10n;",
    replace: "export const STELLAR_LEDGER_SCALE = /* MUTANT */ 1n;",
  },
  {
    id: "S05",
    what: "資産の固定を外す（任意の asset を USDC とみなす）",
    rule: "払うのは classic USDC:GA5Z… とその SAC だけ",
    file: PAYER,
    find: "  return asset === STELLAR_USDC_SAC || asset === STELLAR_USDC_CLASSIC;",
    replace: "  return /* MUTANT */ true;",
  },
  {
    id: "S06",
    what: "ランナーの残高確認を Stellar だけ通す",
    rule: "USDC が無ければ payerFunds.check が署名の前に止める",
    file: RUNNER,
    needsDb: true,
    find: "  const funds = await payerFunds.check(payerChain, payerOwner, amount);",
    replace: "  const funds = isStellar ? { ok: /* MUTANT */ true as const } : await payerFunds.check(payerChain, payerOwner, amount);",
  },
  {
    id: "S07",
    what: "reserveSpend が stellar:pubnet の別枠を外す",
    rule: "L1_STELLAR_DAILY_CAP_USD を超えたら署名しない",
    file: RUNNER,
    needsDb: true,
    find: "  const capChain = cappedChainFor(network);",
    replace: '  const capChain = network === "stellar:pubnet" ? /* MUTANT */ null : cappedChainFor(network);',
  },
  {
    id: "S08",
    what: "秘密の伏字を外す",
    rule: "STELLAR_PAYER_SECRET はログに出さない",
    file: PAYER,
    find: '  return text.replace(STELLAR_SECRET_RE, "<stellar-secret>");',
    replace: "  return /* MUTANT */ text;",
  },
  {
    id: "S09",
    what: "cappedChainFor から stellar:pubnet を外す",
    rule: "stellar:pubnet だけが stellar の別枠",
    file: BUDGET,
    find: '  if (network === "stellar:pubnet") return "stellar";',
    replace: '  if (/* MUTANT */ false && network === "stellar:pubnet") return "stellar";',
  },
  {
    id: "S10",
    what: "宣言した payTo との照合を外す",
    rule: "カタログの payTo と違う壁には署名しない",
    file: PAYER,
    find: "    declaredPayTo === null ? protocolEligible : protocolEligible.filter((a) => a.payTo === declaredPayTo);",
    replace: "    /* MUTANT */ protocolEligible;",
  },
  {
    id: "S11",
    what: "申告額と壁の額の照合を外す",
    rule: "7 桁どうしが一致しない額には署名しない",
    file: PAYER,
    find: "    if (!declaredMatches(options.declaredAmount, stellarUnits)) continue;",
    replace: "    if (/* MUTANT */ false && !declaredMatches(options.declaredAmount, stellarUnits)) continue;",
  },
  {
    id: "S12",
    what: "v1 の壁の拒否を外す",
    rule: "x402 v1 の壁には署名しない",
    file: RUNNER,
    needsDb: true,
    find: "  const stellarV1Wall = isStellar && selection.accept !== null && challenge.x402Version !== 2;",
    replace: "  const stellarV1Wall = /* MUTANT */ false;",
  },
  {
    id: "S13",
    what: "行の network に壁の文字列を書く",
    rule: "台帳の network は stellar:pubnet に固定する",
    file: RUNNER,
    find: "  if (input.isStellar) return STELLAR_PUBNET_CAIP2;",
    replace: "  if (input.isStellar) return /* MUTANT */ input.acceptNetwork;",
  },
  {
    id: "S14",
    what: "準備完了の判定から RPC を外す",
    rule: "STELLAR_RPC_URL が無ければ候補に触れない",
    file: RUNNER,
    needsDb: true,
    find: "    stellarAccount !== null && !!process.env.STELLAR_HORIZON_URL?.trim() && !!process.env.STELLAR_RPC_URL?.trim();",
    replace: "    stellarAccount !== null && !!process.env.STELLAR_HORIZON_URL?.trim() /* MUTANT */;",
  },
  {
    id: "S15",
    what: "secondary の payTo 照合を外す",
    rule: "宣言した stellar の payTo 集合と違う壁には署名しない",
    file: PAYER,
    find: "    const setEligible = protocolEligible.filter((a) => declaredPayToSet.has(a.payTo));",
    replace: "    const setEligible = /* MUTANT */ protocolEligible;",
  },
  {
    id: "S16",
    what: "secondary の値段の免除を宣言額だけで開く",
    rule: "Base の壁が宣言と合わないとき、高い Stellar は払わない",
    file: PAYER,
    find: "  const exempt = declaredUnits !== null && options.declaredPayTo !== null && declaredOnNetwork;",
    replace: "  const exempt = declaredUnits !== null /* MUTANT */;",
  },
  {
    id: "S17",
    what: "免除が無いときの 6 桁の完全一致を外す",
    rule: "免除が無い Stellar の額は台帳の 6 桁が宣言と一致するときだけ",
    file: PAYER,
    find: "    } else if (declaredUnits === null || ledgerUnits !== declaredUnits) {",
    replace: "    } else if (/* MUTANT */ declaredUnits === null) {",
  },
  {
    id: "S18",
    what: "secondary の 1 件の上限を外す",
    rule: "宣言額が上限を超える行の Stellar には署名しない",
    file: PAYER,
    find: "    if (stellarUnits > maxStellarUnits || ledgerUnits > MAX_PER_PURCHASE_UNITS) {",
    replace: "    if (/* MUTANT */ false && (stellarUnits > maxStellarUnits || ledgerUnits > MAX_PER_PURCHASE_UNITS)) {",
  },
  {
    id: "S19",
    what: "署名前の故障で予約の削除を外す",
    rule: "署名前に落ちた secondary の未署名予約は消す",
    file: RUNNER,
    needsDb: true,
    find: "            await db.delete(x402L1Purchases).where(",
    replace: "            if (/* MUTANT */ false) await db.delete(x402L1Purchases).where(",
  },
  {
    id: "S20",
    what: "署名前の故障の Base 買い直しを外す",
    rule: "署名前に落ちた secondary は Base で 1 回買い直す",
    file: RUNNER,
    needsDb: true,
    find: '      if (outcome.kind === "stellar_signing_unavailable" && outcome.retryBase === true && stellarLanePreferred) {',
    replace: '      if (/* MUTANT */ false && outcome.kind === "stellar_signing_unavailable" && outcome.retryBase === true && stellarLanePreferred) {',
  },
  {
    id: "S21",
    what: "secondary の laneOpen(stellar) を外す",
    rule: "別枠が尽きた日は stellar を優先しない",
    file: RUNNER,
    needsDb: true,
    find: '      laneOpen("stellar") &&',
    replace: "      /* MUTANT */ true &&",
  },
  {
    id: "S22",
    what: "署名後の故障も署名前として Base を買い直す",
    rule: "署名後は予約を残し、Base では買わない",
    file: RUNNER,
    needsDb: true,
    find: "        if (!stellarSignFailedPre(error)) {",
    replace: "        if (/* MUTANT */ false) {",
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
  return summarize(await run(TSX, ["--test", ...UNIT_TESTS], env));
}

async function dbTests() {
  return summarize(
    await run(TSX, ["--test", "--test-force-exit", "--test-concurrency=1", ...DB_TESTS], process.env),
  );
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

const W = { id: 4, what: 52, rule: 48, suite: 5, fail: 7 };
console.log(
  `${pad("#", W.id)} | ${pad("変異", W.what)} | ${pad("壊した規則", W.rule)} | ${pad("suite", W.suite)} | ${pad("fail 数", W.fail)} | KILLED/SURVIVED`,
);
console.log(
  `${"-".repeat(W.id)}-|-${"-".repeat(W.what)}-|-${"-".repeat(W.rule)}-|-${"-".repeat(W.suite)}-|-${"-".repeat(W.fail)}-|----------------`,
);
for (const r of rows) {
  console.log(
    `${pad(r.id, W.id)} | ${pad(r.what, W.what)} | ${pad(r.rule, W.rule)} | ${pad(r.needsDb ? "db" : "unit", W.suite)} | ${pad(r.fail, W.fail)} | ${r.verdict}`,
  );
}
console.log("");
for (const r of rows) {
  if (r.verdict === "KILLED" && r.failed.length > 0) {
    console.log(
      `${r.id}  ${r.file}  ✖ ${r.failed.slice(0, 3).join(" / ")}${r.failed.length > 3 ? ` … +${r.failed.length - 3}` : ""}`,
    );
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

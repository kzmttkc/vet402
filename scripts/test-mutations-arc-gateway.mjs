#!/usr/bin/env node
/**
 * Circle Gateway on Arc. One broken gate at a time. A mutation that stays green is a survivor.
 *
 *   node scripts/test-mutations-arc-gateway.mjs --no-db
 *   TEST_DATABASE_URL=postgres://localhost/<test db> node scripts/test-mutations-arc-gateway.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = "src/lib/observatory/arc-gateway.ts";
const VERIFY = "src/lib/observatory/arc-gateway-verify.ts";
const BUDGET = "src/lib/observatory/budget.ts";
const RUNNER = "src/lib/observatory/l1-runner.ts";
const FUNDS = "src/lib/observatory/payer-funds.ts";
const RECOVER = "src/lib/settlements/recover-late.ts";
const SOURCE = "src/lib/observatory/settlement-source.ts";
const VERIFIER = "src/lib/observatory/settlement-verifier.ts";
const READER = "src/lib/observatory/reader.ts";
const SOURCES = [GATEWAY, VERIFY, BUDGET, RUNNER, FUNDS, RECOVER, SOURCE, VERIFIER, READER];

const UNIT_TESTS = ["tests/arc-gateway.test.ts", "tests/l1-chain-daily-cap.test.ts"];
const DB_TESTS = ["tests/l1-arc-gateway-lane.pg.test.ts"];

const MUTATIONS = [
  {
    id: "G01",
    what: "旗が空でも Gateway を有効にする",
    rule: "OBSERVATORY_ARC_GATEWAY_L1_ENABLED が \"true\" のときだけ",
    file: GATEWAY,
    find: 'return process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED === "true";',
    replace: "return /* MUTANT */ process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED !== undefined;",
  },
  {
    id: "G02",
    what: "残高が読めなくても足りる扱いにする",
    rule: "null や不足では署名しない",
    file: GATEWAY,
    find: "return available !== null && amount > 0n && available >= amount;",
    replace: "return /* MUTANT */ available === null || amount > 0n;",
  },
  {
    id: "G03",
    what: "別枠 0 でも開いている扱いにする",
    rule: "L1_ARC_GATEWAY_DAILY_CAP_USD=0 は止める",
    file: GATEWAY,
    find: 'return spent < chainDailyCapUnits("arc_gateway");',
    replace: 'return /* MUTANT */ spent <= chainDailyCapUnits("arc_gateway");',
  },
  {
    id: "G04",
    what: "ネイティブ Arc が署名できる出品も Gateway で選ぶ",
    rule: "ネイティブの accept がある出品は Gateway で払わない",
    file: GATEWAY,
    find: 'if (options.nativeArcSignable) return { accept: null, reason: "native_present" };',
    replace: 'if (/* MUTANT */ false) return { accept: null, reason: "native_present" };',
  },
  {
    id: "G05",
    what: "verifyingContract のピンを外す",
    rule: "GatewayWallet 0x7777…00ee 以外には署名しない",
    file: GATEWAY,
    find: "if (extra.verifyingContract.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return null;",
    replace: "if (/* MUTANT */ false) return null;",
  },
  {
    id: "G06",
    what: "Gateway の支出をネイティブ Arc の印で数える",
    rule: "二つの別枠は circleGatewayRail で分かれる",
    file: GATEWAY,
    find: "return sql`network = 'eip155:5042' AND raw_response_meta->>'circleGatewayRail' = 'true'`;",
    replace: "return sql`network = 'eip155:5042' AND /* MUTANT */ coalesce(raw_response_meta->>'x', '') = 'true'`;",
  },
  {
    id: "G07",
    what: "API の合計が無くても照合を進める",
    rule: "A が読めなければ settled にも refute にもしない",
    file: VERIFY,
    find: 'if (input.apiSum === null || input.apiSum !== input.rowSum || input.debit === null) return "defer";',
    replace: 'if (/* MUTANT */ false) return "defer";',
  },
  {
    id: "G08",
    what: "残高の減りが一致しなくても settled にする",
    rule: "A === S === D のときだけ settled",
    file: VERIFY,
    find: 'if (input.debit === input.rowSum) return "settle";',
    replace: 'if (/* MUTANT */ true) return "settle";',
  },
  {
    id: "G09",
    what: "請求が無い nonce を欠落扱いにしない",
    rule: "transfer が無い行は settled にしない",
    file: VERIFY,
    find: 'if (!hit) return { kind: "absent" };',
    replace: 'if (/* MUTANT */ false) return { kind: "absent" };',
  },
  {
    id: "G10",
    what: "Gateway の別枠の LIKE をワイルドカードにする",
    rule: "番兵は circle-gateway:5042 の完全一致",
    file: BUDGET,
    find: 'networkLike: "circle-gateway:5042"',
    replace: 'networkLike: /* MUTANT */ "eip155:%"',
  },
  {
    id: "G11",
    what: "eip155:5042 を Gateway の別枠として返す",
    rule: "cappedChainFor は arc のまま",
    file: BUDGET,
    find: 'if (network === "eip155:5042") return "arc";',
    replace: 'if (network === "eip155:5042") return /* MUTANT */ "arc_gateway";',
  },
  {
    id: "G12",
    what: "Gateway の残高をウォレット USDC の読みに落とす",
    rule: "arc_gateway は balanceOf で読まない",
    file: FUNDS,
    find: 'if (chain === "arc_gateway") throw new Error("arc_gateway_balance_is_not_wallet_usdc");',
    replace: 'if (/* MUTANT */ false) throw new Error("arc_gateway_balance_is_not_wallet_usdc");',
  },
  {
    id: "G13",
    what: "旗が off でもレーンを ready にする",
    rule: "旗 off なら Gateway の出品に 1 リクエストも出さない",
    file: RUNNER,
    find: '{ chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() },',
    replace: '{ chain: "arc_gateway", ready: /* MUTANT */ !!process.env.ARC_RPC_URL?.trim() },',
  },
  {
    id: "G14",
    what: "残高不足でも署名する",
    rule: "足りない・読めないなら署名しない",
    file: RUNNER,
    find: "if (!arcGatewayFundsOk(available, amount)) {",
    replace: "if (/* MUTANT */ false) {",
  },
  {
    id: "G15",
    what: "別枠を使い切ってもレーンを開いたままにする",
    rule: "支出が別枠以上なら Gateway を止める",
    file: RUNNER,
    find: "arcGatewayCapOpen(spentNow)",
    replace: "/* MUTANT */ true",
  },
  {
    id: "G16",
    what: "主候補から Gateway だけの出品を外さない",
    rule: "主候補は Gateway だけの Arc 出品を含めない",
    file: RUNNER,
    find: "extraWhere: SQL = gatewayPrimaryExclusionSql()",
    replace: "extraWhere: SQL = /* MUTANT */ sql``",
  },
  {
    id: "G17",
    what: "署名した直後に settled と書く",
    rule: "請求が確認できるまで settle_claimed",
    file: RUNNER,
    find: 'const status = isArcGateway ? "settle_claimed"',
    replace: 'const status = isArcGateway ? /* MUTANT */ "settled"',
  },
  {
    id: "G18",
    what: "売り手の名指した tx を行の tx_hash に写す",
    rule: "バッチ tx は tx_hash に置かない",
    file: RUNNER,
    find: "const claimedTx = isArcGateway ? null :",
    replace: "const claimedTx = isArcGateway ? /* MUTANT */ settlement?.transaction :",
  },
  {
    id: "G19",
    what: "ネイティブ Arc が署名できても Gateway を選ぶ",
    rule: "hasSignableNativeArcAccept が真なら Gateway で払わない",
    file: RUNNER,
    find: "nativeArcSignable: hasSignableNativeArcAccept(challenge.accepts)",
    replace: "nativeArcSignable: /* MUTANT */ false",
  },
  {
    id: "G20",
    what: "レーンが閉じていても Gateway の候補を取る",
    rule: "旗 off や別枠 0 では問い合わせない",
    file: RUNNER,
    find: 'if (!laneOpen("arc_gateway")) return [];',
    replace: "if (/* MUTANT */ false) return [];",
  },
  {
    id: "G21",
    what: "Gateway の取得にも Arc の除外を掛ける",
    rule: "ネイティブ Arc が止まっていても Gateway だけの出品は残す",
    file: RUNNER,
    find: 'const gatewayExclusions: SQL[] = laneExclusionChains.filter((x) => x.chain !== "arc")',
    replace: "const gatewayExclusions: SQL[] = laneExclusionChains.filter((x) => /* MUTANT */ true)",
  },
  {
    id: "G22",
    what: "遅延回収が Gateway の行をネイティブの着金に貼る",
    rule: "circleGatewayRail の行は回収の対象にしない",
    file: RECOVER,
    find: "AND coalesce(pu.raw_response_meta->>'circleGatewayRail', '') <> 'true'",
    replace: "AND /* MUTANT */ TRUE",
  },
  {
    id: "G23",
    what: "circle_gateway を tx 無しの NULL より後ろに置く",
    rule: "バッチ tx がある行は tx_hash が空でも circle_gateway",
    file: SOURCE,
    find: "THEN 'circle_gateway'",
    replace: "THEN /* MUTANT */ 'seller_claim'",
  },
  {
    id: "G24",
    what: "Gateway の照合結果を verified に足さない",
    rule: "請求が一致した行は verified に数える。scanned には数えない",
    file: VERIFIER,
    find: "summary.verified += gateway.settled;",
    replace: "summary.scanned += gateway.settled; /* MUTANT */",
  },
  {
    id: "G25",
    what: "公開の settlement_source に Gateway の印を渡さない",
    rule: "batchTx がある行の出どころは circle_gateway",
    file: READER,
    find: "settlementSourceOf({ txHash: rest.txHash, lateSettlement, circleGateway })",
    replace: "settlementSourceOf({ txHash: rest.txHash, lateSettlement }) /* MUTANT */",
  },
  {
    id: "G26",
    what: "旗 off の ready を DB のバッチでも通す",
    rule: "旗 off なら Gateway の出品に 1 リクエストも出さない",
    file: RUNNER,
    needsDb: true,
    find: '{ chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() },',
    replace: '{ chain: "arc_gateway", ready: /* MUTANT */ !!process.env.ARC_RPC_URL?.trim() },',
  },
  {
    id: "G27",
    what: "残高不足でも DB のバッチが署名する",
    rule: "足りない・読めないなら支払いヘッダを出さない",
    file: RUNNER,
    needsDb: true,
    find: "if (!arcGatewayFundsOk(available, amount)) {",
    replace: "if (/* MUTANT */ false) {",
  },
  {
    id: "G28",
    // 別枠 0 は選ぶ段（arcGatewayCapOpen）と laneOpen の2か所で閉じる。片方だけ開けても規則は破れないので、
    // 0 の読み取りそのもの（chainDailyCapUnits）を壊して両方を一度に開ける。
    what: "別枠 0 を既定 $2 と読み、DB のバッチが Gateway を開く",
    rule: "0 は 1 件も払わない",
    file: BUDGET,
    needsDb: true,
    find: "  let usd = cap.defaultUsd;\n  if (raw !== undefined && raw.trim() !== \"\") {\n    const n = Number(raw);\n    if (Number.isFinite(n) && n >= 0) usd = n;\n  }\n  usd = Math.min(usd, DAILY_BUDGET_USD);",
    replace: "  let usd = cap.defaultUsd;\n  if (raw !== undefined && raw.trim() !== \"\") {\n    const n = Number(raw);\n    if (Number.isFinite(n) && n > 0) usd = n; /* MUTANT */\n  }\n  usd = Math.min(usd, DAILY_BUDGET_USD);",
  },
  {
    id: "G29",
    what: "署名直後の行を settled と書く（DB）",
    rule: "請求前は settle_claimed",
    file: RUNNER,
    needsDb: true,
    find: 'const status = isArcGateway ? "settle_claimed"',
    replace: 'const status = isArcGateway ? /* MUTANT */ "settled"',
  },
  {
    id: "G30",
    what: "売り手の tx を tx_hash に写す（DB）",
    rule: "行の tx_hash は空",
    file: RUNNER,
    needsDb: true,
    find: "const claimedTx = isArcGateway ? null :",
    replace: "const claimedTx = isArcGateway ? /* MUTANT */ settlement?.transaction :",
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
  return { code: t.code, fail, failed: [...new Set(failed)], out: t.out };
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
  console.error(baselineUnit.out?.slice(-4000) ?? "");
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
if (stale) console.log(`${stale} STALE (anchor missing or duplicated).`);
if (notRun && !NO_DB) {
  console.log("DB mutations were not run. Pass TEST_DATABASE_URL or --no-db to skip them on purpose.");
  process.exit(1);
}
process.exit(survived === 0 && (NO_DB || notRun === 0) ? 0 : 1);

#!/usr/bin/env node
/**
 * **偽の緑を作らない。変異で確かめる。**（Stellar レーン・2026-10-18）
 *
 * Stellar の購入レーン（stellar:pubnet）の金の関門を 1 つずつわざと壊してから、
 * tests/stellar402-payer.test.ts が赤くなるかを見る。赤くならない変異（SURVIVED）があれば
 * その関門は検査されていない。生き残りは「発見」として報告し、この表から消さない。
 *
 *   node scripts/test-mutations-stellar-lane.mjs
 *
 * 構造は `scripts/test-mutations-celo-lane.mjs` と同じ。DB は要らない。
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAYER = "src/lib/observatory/stellar402-payer.ts";
const SOURCES = [PAYER];
const UNIT_TESTS = ["tests/stellar402-payer.test.ts"];

const MUTATIONS = [
  {
    id: "S01",
    what: "旗を常に ON にする（env が無くても署名できる）",
    rule: "OBSERVATORY_STELLAR_L1_ENABLED が \"true\" のときだけ",
    find: '  return process.env.OBSERVATORY_STELLAR_L1_ENABLED === "true";',
    replace: "  return /* MUTANT */ true;",
  },
  {
    id: "S02",
    what: "select が旗を見ない",
    rule: "旗 OFF なら accept があっても選ばない",
    find: "  if (!isStellarL1Enabled()) {",
    replace: "  if (/* MUTANT */ false && !isStellarL1Enabled()) {",
  },
  {
    id: "S03",
    what: "1 件の上限を見ない",
    rule: "MAX_PER_PURCHASE_UNITS を 7 桁に直した額を超えたら署名しない",
    find: "    if (stellarUnits > maxStellarUnits) continue;",
    replace: "    if (/* MUTANT */ false && stellarUnits > maxStellarUnits) continue;",
  },
  {
    id: "S04",
    what: "7 桁→6 桁の倍率を 1 にする（上限が 10 倍緩くなる）",
    rule: "Stellar USDC は 7 桁、台帳は 6 桁",
    find: "export const STELLAR_LEDGER_SCALE = 10n;",
    replace: "export const STELLAR_LEDGER_SCALE = /* MUTANT */ 1n;",
  },
  {
    id: "S05",
    what: "資産の固定を外す（任意の asset を USDC とみなす）",
    rule: "払うのは classic USDC:GA5Z… とその SAC だけ",
    find: "  return asset === STELLAR_USDC_SAC || asset === STELLAR_USDC_CLASSIC;",
    replace: "  return /* MUTANT */ true;",
  },
  {
    id: "S06",
    what: "残高 0 でも通す",
    rule: "USDC 残高も trustline も無ければ payer_unfunded",
    find: "  if (snapshot.sacBalance !== null && snapshot.sacBalance >= neededStellarUnits) return { ok: true, reason: null };",
    replace: "  if (/* MUTANT */ true) return { ok: true, reason: null };",
  },
  {
    id: "S07",
    what: "1 日の上限を見ない",
    rule: "L1_STELLAR_DAILY_CAP_USD を超えたら署名しない",
    find: "  return spentLedgerUnits + requestLedgerUnits > stellarDailyCapUnits();",
    replace: "  return /* MUTANT */ false;",
  },
  {
    id: "S08",
    what: "秘密の伏字を外す",
    rule: "STELLAR_PAYER_SECRET はログに出さない",
    find: '  return text.replace(STELLAR_SECRET_RE, "<stellar-secret>");',
    replace: "  return /* MUTANT */ text;",
  },
];

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
  process.exit(2);
}
console.log(`baseline: green (unit fail ${baselineUnit.fail})\n`);

const rows = [];
let survived = 0;
for (const m of MUTATIONS) {
  const path = join(ROOT, m.file ?? PAYER);
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
    const r = await unitTests();
    const killed = r.code !== 0;
    if (!killed) survived += 1;
    rows.push({ ...m, fail: r.fail, verdict: killed ? "KILLED" : "SURVIVED", failed: r.failed });
  } finally {
    await writeFile(path, original);
    if ((await readFile(path, "utf8")) !== original) {
      console.error(`RESTORE FAILED for ${path} at ${m.id}`);
      process.exit(3);
    }
  }
}

const W = { id: 4, what: 70, rule: 52, fail: 7 };
console.log(`${pad("#", W.id)} | ${pad("変異", W.what)} | ${pad("壊した規則", W.rule)} | ${pad("fail 数", W.fail)} | KILLED/SURVIVED`);
console.log(`${"-".repeat(W.id)}-|-${"-".repeat(W.what)}-|-${"-".repeat(W.rule)}-|-${"-".repeat(W.fail)}-|----------------`);
for (const r of rows) {
  console.log(`${pad(r.id, W.id)} | ${pad(r.what, W.what)} | ${pad(r.rule, W.rule)} | ${pad(r.fail, W.fail)} | ${r.verdict}`);
}
console.log("");
for (const r of rows) {
  if (r.verdict === "KILLED" && r.failed.length > 0) {
    console.log(`${r.id}  ${PAYER}  ✖ ${r.failed.slice(0, 3).join(" / ")}${r.failed.length > 3 ? ` … +${r.failed.length - 3}` : ""}`);
  } else if (r.verdict === "SURVIVED") {
    console.log(`${r.id}  ${PAYER}  SURVIVED ← この関門はテストに守られていない。消さずに報告する`);
  } else if (r.verdict === "STALE") {
    console.log(`${r.id}  ${PAYER}  STALE ← ${r.note}`);
  }
}
console.log("");

const leftover = await countMutantMarkers();
if (leftover !== 0) {
  console.error(`RESTORE FAILED — ${leftover} MUTANT marker(s) remain in src. Check \`git diff src\`.`);
  process.exit(3);
}
const afterUnit = await unitTests();
if (afterUnit.code !== 0) {
  console.error(`RESTORE FAILED — the tree is not green after restoring (unit fail ${afterUnit.fail}).`);
  process.exit(3);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`restored: green (unit fail ${afterUnit.fail}) — MUTANT markers in src: 0`);
if (survived === 0) console.log(`all ${rows.length} mutations killed in ${secs}s`);
else console.log(`${survived} of ${rows.length} mutation(s) survived (or stale) in ${secs}s`);
process.exitCode = survived === 0 ? 0 : 1;

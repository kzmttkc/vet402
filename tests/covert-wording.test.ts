// ============================================================
// 「名乗って買う」ことと、公開面の文言が一致していること（2026-09-05）。
//
// WHY: 方法論・state・FAQ・語彙の 4 面が「covert（覆面）で買っている」と書いて
// いた一方、実装は最初から vet402 を名乗る User-Agent を送っていた——しかも
// その方法論ページ自身への URL 付きで。上書きも回転も無い。看板と実装が食い違う
// のは、この製品にとって数字を間違えるのと同じ性質の欠陥になる（検算できる会社が
// 自分の測り方について嘘を書いていることになる）。
//
// この関門が守るのは 2 つ:
//   1. 公開面に "covert" が戻ってこない（訂正としての言及 1 箇所だけを許す）
//   2. 名乗る User-Agent が実装から消えない——「名乗って買う」と書いた以上、
//      名乗りをやめたら文言のほうが嘘になる
//
// docs/claims.yaml の corrections_* 4 件が why_unverifiable でこの検査を指している。
// ここを消すなら、あちらの根拠も同時に書き直すこと。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** 訂正としての言及だけを許す面と、その行に必ず入っている語。 */
const CORRECTION_MENTIONS: Record<string, string> = {
  "src/app/observatory/methodology/page.tsx": "2026-09-05 this page said",
  "src/app/corrections/page.tsx": "never covert",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(relative(ROOT, p));
  }
  return out;
}

test('"covert" は訂正としての言及以外に残っていない', () => {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    const lines = read(file).split("\n");
    lines.forEach((line, i) => {
      if (!/covert/i.test(line)) return;
      const allowed = CORRECTION_MENTIONS[file];
      if (allowed && read(file).includes(allowed)) return;
      offenders.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `公開面が「覆面で買っている」と言っている。実装は名乗って買う:\n  ${offenders.join("\n  ")}`,
  );
});

test("L0 / L1 の実装は vet402 を名乗る User-Agent を送る", () => {
  const l1 = read("src/lib/observatory/l1-runner.ts");
  const l0 = read("src/lib/observatory/l0-probe.ts");
  for (const ua of [
    "vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)",
  ]) {
    assert.ok(l1.includes(ua), `L1 ランナーに ${ua} が無い`);
  }
  for (const ua of [
    "vet402-observatory-l0/1.0 (+https://vet402.com/observatory/methodology)",
    "vet402-observatory-l0-recheck/1.0 (+https://vet402.com/observatory/methodology)",
  ]) {
    assert.ok(l0.includes(ua), `L0 プローブに ${ua} が無い`);
  }
  // 無料の先読みと有料リクエストの両方が名乗る（片方だけだと「名乗って買う」が嘘になる）。
  assert.equal(
    (l1.match(/vet402-observatory-l1\/1\.0/g) ?? []).length >= 2,
    true,
    "L1 は先読みと有料リクエストの両方で名乗ること",
  );
});

test("方法論は名乗って買うことを本文で述べている", () => {
  const prose = read("src/app/observatory/methodology/page.tsx");
  assert.ok(prose.includes("We buy under our own name"), "名乗りの節が無い");
  assert.ok(
    prose.includes("vet402-observatory-l1/1.0"),
    "名乗っている UA を本文に出していない（読者が実装と突き合わせられない）",
  );
});

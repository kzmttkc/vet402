// ============================================================
// vet402 — 導線・段 2 の固定（2026-09-02 敵対的監査「導線」節への是正）。
//
// 監査所見 F1 / F8 / F9 と P2（LP 文言）を、ソース文字列で固定する。
//   F1  hero の主 CTA は製品の核＝endpoint 検証（観測所）へ。オーナー決定 2026-09-02。
//   F8  header の「Get API key」と nav 6 本にクリック計測がなかった。
//   F9  §4 の行動リンクが 16px のテキストリンクで、モバイルの当たり判定が足りない。
//   P2  npm スコープの自己矛盾・L2 語彙の方法論との不一致・書誌欄 Obsoletes。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("hero primary CTA opens the observatory; the methodology stays secondary", () => {
  const home = read("src/app/page.tsx");
  const hero = home.slice(home.indexOf("Abstract</p>"), home.indexOf("dashbox mt-8"));
  assert.ok(hero.includes('position: "hero_observatory"'), "primary CTA is tracked as hero_observatory");
  assert.ok(hero.includes("Open the observatory"), "primary CTA label");
  assert.ok(hero.includes('position: "hero_method"'), "secondary CTA keeps its event position");
  assert.ok(hero.includes("Read the methodology"), "secondary CTA label unchanged");
  assert.ok(!hero.includes('position: "hero_verify"'), "payee lookup leaves the hero (§4 row carries it)");
  const primaryAt = hero.indexOf("hero_observatory");
  const secondaryAt = hero.indexOf("hero_method");
  assert.ok(primaryAt < secondaryAt, "primary is listed first");
});

test("abstract copy is unchanged", () => {
  const home = read("src/app/page.tsx");
  assert.ok(
    home.includes(
      "vet402 buys what x402 endpoints actually sell, verifies fulfillment against the\n            seller&apos;s own declaration, and publishes the results with evidence.",
    ),
  );
  assert.ok(home.includes("<strong>Nothing on this site is an estimate.</strong>"));
});

test("DESIGN.md records the 2026-09-02 hero decision instead of the old freeze", () => {
  const design = read("DESIGN.md");
  assert.ok(!design.includes("“Read the methodology” / “Verify a payee now”) are not to be redesigned"));
  assert.match(design, /Open the observatory/);
  assert.match(design, /2026-09-02/);
});

test("§4 action links render as 44px secondary buttons with their events intact", () => {
  const home = read("src/app/page.tsx");
  const itemRow = home.slice(home.indexOf("function ItemRow("));
  assert.match(itemRow, /buttonClass\(\{\s*variant: "secondary",\s*size: "sm"/);
  assert.ok(itemRow.includes("min-h-11"), "44px hit area on the §4 action");
  assert.ok(home.includes('position: "s4_observatory"'));
  assert.ok(home.includes('position: "s4_payee"'));
});

test("header signup and nav are click-tracked", () => {
  const header = read("src/components/site/SiteHeader.tsx");
  assert.ok(header.includes("TrackedLink"), "header imports TrackedLink");
  assert.ok(header.includes('position: "header_signup"'));
  assert.ok(header.includes('position: "drawer_signup"'));
  assert.match(header, /event="nav_click"/);
  assert.ok(!/<Link href="\/signup"/.test(header), "no untracked signup link remains");
});

test("LP §4 names @vet402 as the canonical npm scope and @vouchscore as the former name", () => {
  const home = read("src/app/page.tsx");
  assert.ok(!home.includes("scope is the only one that"));
  assert.match(home, /@vet402\/\*/);
  assert.match(home, /canonical scope/);
  assert.match(home, /@vouchscore\/\*/);
  assert.match(home, /former name, same publisher/);
});

test("LP §2 uses the methodology's L2 vocabulary", () => {
  const home = read("src/app/page.tsx");
  assert.ok(home.includes('output: "match / mismatch / no_declaration / not_checked"'));
  assert.ok(!home.includes('"conform / mismatch / undeclared"'));
});

test("RFC header says Updates: trust scores, not Obsoletes", () => {
  const home = read("src/app/page.tsx");
  assert.ok(home.includes('value: "Updates: trust scores"'));
  assert.ok(!home.includes('value: "Obsoletes: trust scores"'));
});

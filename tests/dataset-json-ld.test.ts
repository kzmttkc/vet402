// ============================================================
// Dataset JSON-LD が「引用できる形」であること（2026-09-05 AEO/LLMO）。
//
// WHY: 配布 KPI は訪問者数ではなく「外部からの引用 = このデータを出典として
// 挙げた文書・記事・ダッシュボード」で、現在 0 件。回答エンジンと Google
// Dataset Search が拾うのに要る情報 — 実際に落とせる URL（distribution）、
// 利用条件（license）、どう測ったか（measurementTechnique）— は頁の散文には
// 全部あるのに、構造化データには無かった（本番実測 2026-09-05:
// /observatory/state の Dataset は distribution も license も持たず、
// /accuracy は distribution 1 本のみで license 無し）。
//
// この関門が守るのは 3 つ:
//   1. Dataset に distribution / license / measurementTechnique がある
//   2. distribution の URL は自ドメインで、llms.txt が公開だと宣言した面だけ
//      （実在しない配布 URL を構造化データに書かない）
//   3. 時刻を省いた推奨引用文は public/llms.txt の "Cite as:" の型と一致する。
//      頁が読んだ時刻を渡した creditText は、その型の YYYY-MM-DD をその時刻で埋める。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { citeAs, datasetJsonLd, DATA_LICENSE_URL } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const sample = datasetJsonLd({
  name: "State of x402",
  citeName: "observatory",
  description: "d",
  path: "/observatory/state",
  citeUrl: `${SITE_URL}/api/v1/observatory/state`,
  measurementTechnique: "m",
  variableMeasured: ["a"],
  keywords: ["x402"],
  distribution: [
    { name: "n", encodingFormat: "application/json", contentUrl: `${SITE_URL}/api/v1/observatory/state` },
  ],
});

test("Dataset は distribution / license / measurementTechnique を必ず持つ", () => {
  assert.equal(sample["@type"], "Dataset");
  assert.equal(sample.license, DATA_LICENSE_URL);
  assert.equal(sample.isAccessibleForFree, true);
  assert.ok(Array.isArray(sample.distribution) && sample.distribution.length > 0);
  for (const d of sample.distribution) {
    assert.equal(d["@type"], "DataDownload");
    assert.ok(d.contentUrl.startsWith(SITE_URL), "配布 URL は自ドメインのみ");
    assert.ok(d.encodingFormat.length > 0);
  }
  assert.ok(sample.measurementTechnique.length > 0);
  assert.ok(sample.identifier.startsWith(SITE_URL));
  assert.equal(sample.isBasedOn, `${SITE_URL}/observatory/methodology`);
});

test("llms.txt の Cite as は型で、時刻を渡した creditText はその型を埋める", () => {
  const template = citeAs("observatory", `${SITE_URL}/api/v1/observatory/state`);
  assert.equal(sample.creditText, template);
  assert.ok(template.includes("retrieved YYYY-MM-DD"), "型は取得日の位置を YYYY-MM-DD で示す");
  const llms = read("public/llms.txt");
  assert.ok(
    llms.includes(`Cite as: ${template}`),
    `llms.txt の定型が citeAs の省略形と違う。期待: ${template}`,
  );
  const filled = "2026-10-21T04:35:00.000Z";
  const dated = datasetJsonLd({
    name: "State of x402",
    citeName: "observatory",
    description: "d",
    path: "/observatory/state",
    citeUrl: `${SITE_URL}/api/v1/observatory/state`,
    measurementTechnique: "m",
    variableMeasured: ["a"],
    keywords: ["x402"],
    retrievedAt: filled,
    distribution: [
      { name: "n", encodingFormat: "application/json", contentUrl: `${SITE_URL}/api/v1/observatory/state` },
    ],
  });
  assert.equal(dated.creditText, citeAs("observatory", `${SITE_URL}/api/v1/observatory/state`, filled));
  assert.equal(dated.creditText.includes("YYYY-MM-DD"), false);
  assert.equal(dated.creditText.includes("{"), false);
  assert.ok(dated.creditText.includes(`retrieved ${filled}`));
  const state = read("src/app/observatory/state/page.tsx");
  assert.match(state, /retrievedAt:\s*stats\.readAt/);
});

test("Dataset を出す頁は共通ビルダを通る（手書きの Dataset を残さない）", () => {
  for (const file of ["src/app/observatory/state/page.tsx", "src/app/accuracy/page.tsx", "src/app/impact/page.tsx"]) {
    const src = read(file);
    assert.ok(src.includes("datasetJsonLd({"), `${file} が共通ビルダを使っていない`);
    assert.ok(
      !/"@type":\s*"Dataset"/.test(src),
      `${file} に手書きの Dataset が残っている（ビルダと二重管理になる）`,
    );
  }
});

test("構造化データに書く配布 URL は llms.txt が公開だと宣言した面だけ", () => {
  const llms = read("public/llms.txt");
  const declared = [
    "/api/v1/observatory/state",
    "/api/v1/observatory/history",
    "/api/v1/observatory/export.csv",
    "/api/v1/observatory/l0/export.csv",
    "/api/v1/accuracy",
  ];
  for (const path of declared) {
    assert.ok(llms.includes(path), `llms.txt が ${path} を宣言していない`);
  }
  for (const file of ["src/app/observatory/state/page.tsx", "src/app/accuracy/page.tsx", "src/app/impact/page.tsx"]) {
    const src = read(file);
    const urls = [...src.matchAll(/contentUrl: `\$\{SITE_URL\}([^`]+)`/g)].map((m) => m[1]);
    assert.ok(urls.length > 0, `${file} に contentUrl が無い`);
    for (const u of urls) {
      const path = u.split("?")[0];
      assert.ok(declared.includes(path), `${file} が未宣言の配布 URL を書いている: ${u}`);
    }
  }
});

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
//   3. 推奨引用文が public/llms.txt の "Cite as:" と 1 文字も違わない
//      （同じデータに 2 通りの引用文を出回らせない）
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

test("推奨引用文は llms.txt の Cite as と同一（取得日つき）", () => {
  const cite = citeAs("observatory", `${SITE_URL}/api/v1/observatory/state`);
  assert.equal(sample.creditText, cite);
  assert.ok(cite.includes("retrieved YYYY-MM-DD"), "取得日を書く場所が引用文に無い");
  const llms = read("public/llms.txt");
  assert.ok(
    llms.includes(`Cite as: ${cite}`),
    `llms.txt の Cite as が構造化データと違う。期待: ${cite}`,
  );
});

test("Dataset を出す 2 頁は共通ビルダを通る（手書きの Dataset を残さない）", () => {
  for (const file of ["src/app/observatory/state/page.tsx", "src/app/accuracy/page.tsx"]) {
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
    "/api/v1/accuracy",
  ];
  for (const path of declared) {
    assert.ok(llms.includes(path), `llms.txt が ${path} を宣言していない`);
  }
  for (const file of ["src/app/observatory/state/page.tsx", "src/app/accuracy/page.tsx"]) {
    const src = read(file);
    const urls = [...src.matchAll(/contentUrl: `\$\{SITE_URL\}([^`]+)`/g)].map((m) => m[1]);
    assert.ok(urls.length > 0, `${file} に contentUrl が無い`);
    for (const u of urls) {
      const path = u.split("?")[0];
      assert.ok(declared.includes(path), `${file} が未宣言の配布 URL を書いている: ${u}`);
    }
  }
});

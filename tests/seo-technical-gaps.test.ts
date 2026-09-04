// ============================================================
// 技術 SEO の穴を機械で塞ぐ（2026-09-05）。
//
// 対象は「壊れて見えないので目視では見つからない」種類だけを選んだ:
//   - title / canonical パスの重複（2 頁が同じ表題を名乗ると、検索側は
//     片方を重複として落とす。実測 2026-09-05 時点では重複 0 件だったので、
//     これは修正ではなく再発を止める関門）
//   - OG 画像の実在（pageMetadata が絶対 URL を書くので、ファイルが消えても
//     HTML は正しく見える）
//   - 自己参照 canonical（ルート layout の "./" が消えると全頁が黙って失う）
//   - sitemap の lastmod（欠けても XML は妥当なまま。未来日付も同じ）
//   - 測定済み endpoint 頁の sitemap が robots から辿れる
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { OG_IMAGE_PATH } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { SITEMAP_ENDPOINT_LIMIT, SITEMAP_MEASURED_WITHIN_DAYS } from "@/lib/observatory/reader";

const ROOT = process.cwd();

function pageFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "api") continue;
      pageFiles(p, out);
    } else if (e.name === "page.tsx" || e.name === "layout.tsx") {
      out.push(p);
    }
  }
  return out;
}

/** 各頁の pageMetadata({ title, path }) を静的に読む。 */
function declaredMetadata(): { file: string; title: string; path: string }[] {
  const found: { file: string; title: string; path: string }[] = [];
  for (const file of pageFiles(join(ROOT, "src/app"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/pageMetadata\(\{([\s\S]*?)\n\s*\}\)/g)) {
      const block = m[1];
      const title = block.match(/title:\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/)?.[1];
      const path = block.match(/path:\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/)?.[1];
      if (title && path) found.push({ file: file.slice(ROOT.length), title, path });
    }
  }
  return found;
}

test("公開ページの title は一意（同じ表題を 2 頁が名乗らない）", () => {
  const rows = declaredMetadata();
  assert.ok(rows.length >= 20, `pageMetadata の呼び出しが少なすぎる: ${rows.length}`);
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const r of rows) {
    const prev = seen.get(r.title);
    if (prev) dups.push(`${r.title} — ${prev} と ${r.file}`);
    else seen.set(r.title, r.file);
  }
  assert.deepEqual(dups, []);
});

test("canonical パスも一意（2 頁が同じ URL を canonical にしない）", () => {
  const rows = declaredMetadata();
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const r of rows) {
    const prev = seen.get(r.path);
    if (prev) dups.push(`${r.path} — ${prev} と ${r.file}`);
    else seen.set(r.path, r.file);
  }
  assert.deepEqual(dups, []);
});

test("自己参照 canonical はルート layout に在る", () => {
  const layout = readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8");
  assert.ok(/canonical:\s*"\.\/"/.test(layout), 'ルート layout の canonical: "./" が消えている');
});

test("OG 画像は実在する（HTML だけ正しく見える状態を作らない）", () => {
  // ファイル規約（src/app/opengraph-image.png）で配信されるので、実体はそこ。
  const candidates = [
    join(ROOT, "src/app", OG_IMAGE_PATH.replace(/^\//, "")),
    join(ROOT, "public", OG_IMAGE_PATH.replace(/^\//, "")),
  ];
  assert.ok(
    candidates.some((p) => existsSync(p)),
    `${OG_IMAGE_PATH} の実体が無い: ${candidates.join(" / ")}`,
  );
  const alt = join(ROOT, "src/app/opengraph-image.alt.txt");
  assert.ok(existsSync(alt), "opengraph-image.alt.txt が無い");
});

test("sitemap の全エントリが lastmod を持ち、未来日付が無い", () => {
  // 日付のみの lastmod と UTC の「今日」を直接比べると、JST で書いた当日の
  // 日付が UTC ではまだ翌日扱いになる。時差ぶんの 1 日だけ許容する
  // （「未来日付を書いていないか」を見たいのであって、時差を見たいのではない）。
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const entry of sitemap()) {
    assert.ok(entry.lastModified, `${entry.url} に lastModified が無い`);
    const iso =
      entry.lastModified instanceof Date
        ? entry.lastModified.toISOString().slice(0, 10)
        : String(entry.lastModified).slice(0, 10);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(iso), `${entry.url} の lastModified が日付でない: ${iso}`);
    assert.ok(iso <= tomorrow, `${entry.url} の lastModified が未来: ${iso}`);
  }
});

test("robots は静的 sitemap と endpoint sitemap の両方を指す", () => {
  const r = robots();
  const sitemaps = Array.isArray(r.sitemap) ? r.sitemap : [r.sitemap];
  assert.ok(sitemaps.includes(`${SITE_URL}/sitemap.xml`));
  assert.ok(sitemaps.includes(`${SITE_URL}/sitemap-observatory.xml`));
});

test("endpoint sitemap は測定済みだけを、規格上限の内側で出す", () => {
  const route = readFileSync(join(ROOT, "src/app/sitemap-observatory.xml/route.ts"), "utf8");
  assert.ok(route.includes("getSitemapEndpoints"));
  assert.ok(route.includes("x-vet402-truncated"), "上限で切れたことを黙らせない");
  assert.ok(SITEMAP_ENDPOINT_LIMIT <= 50_000, "sitemap 規格の上限を超えている");
  assert.ok(SITEMAP_MEASURED_WITHIN_DAYS > 0 && SITEMAP_MEASURED_WITHIN_DAYS <= 30);

  const reader = readFileSync(join(ROOT, "src/lib/observatory/reader.ts"), "utf8");
  const fn = reader.slice(reader.indexOf("export async function getSitemapEndpoints"));
  assert.ok(fn.includes("e.status = 'active'"), "掲載中に限っていない");
  assert.ok(fn.includes("(lp.verdicts)[1] = 'pass'"), "公開判定 pass に限っていない");
  assert.ok(fn.includes("last_probed_at >="), "実測の鮮度で絞っていない");
});

test("静的 sitemap は endpoint 頁を列挙しない（2 本立ての境界を保つ）", () => {
  assert.ok(!sitemap().some((e) => e.url.includes("/observatory/e/")));
});

// ============================================================
// 公開 HTML 頁の集計読み取りは Data Cache に載せる／API は載せない
// （2026-09-05 SEO/AEO 是正）。
//
// 本番実測（2026-09-05, 日本から curl -I）: 全公開頁が
// `private, no-cache, no-store` / `x-vercel-cache: MISS`。CSP の per-request
// nonce をルート layout が headers() で読む以上、頁は必ず動的レンダリングに
// なる（Next.js の仕様）。CDN キャッシュを効かせるには CSP を弱めるしかなく、
// それは SEO ではなくセキュリティの判断なのでここではやらない。
// 代わりに SSR の中身を安くする: DB を引く頁 0.82s に対し引かない /faq は
// 0.34s で、差はほぼ全部が集計 SQL。
//
// この関門が守るのは 2 つ:
//   1. 頁は cached-reads を使う（速度が黙って戻らない）
//   2. **API ルートは cached-reads を使わない**。/api/v1/observatory/state は
//      body に retrievedAt を入れて「取得時刻つきで引用してよい」と宣言して
//      いる面なので、キャッシュを噛ませるとその時刻が嘘になる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/cached-reads";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("集計を出す公開頁は cached-reads 経由で読む", () => {
  const expected: [string, string[]][] = [
    ["src/app/page.tsx", ["getCoverageShareCached", "getObservatoryStatsCached"]],
    ["src/app/observatory/page.tsx", ["getObservatoryStatsCached"]],
    [
      "src/app/observatory/state/page.tsx",
      ["getObservatoryStatsCached", "getObservatoryStatsByChainCached", "getCoverageShareCached"],
    ],
    ["src/app/observatory/methodology/page.tsx", ["getUnverifiedBreakdownCached"]],
  ];
  for (const [file, symbols] of expected) {
    const src = read(file);
    assert.ok(src.includes('from "@/lib/observatory/cached-reads"'), `${file} が cached-reads を読んでいない`);
    for (const sym of symbols) {
      assert.ok(src.includes(sym), `${file} に ${sym} が無い`);
    }
  }
});

test("API ルートは cached-reads を使わない（retrievedAt を嘘にしない）", () => {
  const offenders = filesUnder(join(ROOT, "src/app/api"))
    .filter((f) => /cached-reads/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length));
  assert.deepEqual(offenders, []);
});

test("鮮度の窓は 1 つだけで、頁と API の食い違いが 10 分を超えない", () => {
  assert.equal(typeof PUBLIC_READ_REVALIDATE, "number");
  assert.ok(PUBLIC_READ_REVALIDATE > 0, "0 は無効化と同じ");
  assert.ok(
    PUBLIC_READ_REVALIDATE <= 600,
    "方法論頁は自分の内訳が /api/v1/observatory/state と一致すると書いている。窓が長いほどその主張が崩れる時間が延びる",
  );
});

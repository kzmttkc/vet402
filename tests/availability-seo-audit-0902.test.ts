// ============================================================
// vet402 — 2026-09-02 敵対的監査「可用性＋テキスト」P2 の固定
//
// - og:image が 27 頁中 24 頁で欠けていた: pageMetadata が openGraph を「置換」
//   するので、src/app/opengraph-image.png のファイル規約による自動配線が
//   ページ側の openGraph に負けていた（本番実測: / と /demo にだけ og:image）
// - /demo の <title> が "60-second demo | vet402 | vet402"（template と二重）
// - sitemap に /impact /decisions /operations /playground が無い
// - /docs が 404（/docs/api が正典）
// - DIRECTION CONTRACT の HTML コメントが本番 HTML / RSC ペイロードに配信
// - 401 missing_api_key に案内が無い、/resolve 400 に期待パラメータ名が無い、
//   /census/summary の Cache-Control に max-age が無い
// - /leaderboard の 3 呼称、/playground の見出し記号の不統一
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import sitemap from "@/app/sitemap";
import { pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { authenticateRequest } from "@/lib/api/auth";
import { publicRateLimit } from "@/lib/api/public-route";
import nextConfig from "../next.config";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ------------------------------------------------------------------
// og:image
// ------------------------------------------------------------------
test("pageMetadata は openGraph.images と twitter.images を既定で継承する", () => {
  const meta = pageMetadata({ title: "T", description: "D", path: "/faq" });
  const og = meta.openGraph as { images?: unknown } | undefined;
  assert.ok(og, "openGraph が無い");
  const images = og.images as Array<{ url: string; width?: number; height?: number; alt?: string }>;
  assert.ok(Array.isArray(images) && images.length === 1, "openGraph.images が 1 件でない");
  assert.equal(images[0].url, `${SITE_URL}/opengraph-image.png`);
  assert.equal(images[0].width, 1200);
  assert.equal(images[0].height, 630);
  assert.ok(typeof images[0].alt === "string" && images[0].alt.length > 0, "og:image:alt が無い");
  const tw = meta.twitter as { images?: unknown } | undefined;
  assert.deepEqual(tw?.images, [`${SITE_URL}/opengraph-image.png`]);
});

test("og:image:alt はファイル規約の alt テキストと同じ文", () => {
  const meta = pageMetadata({ title: "T", description: "D", path: "/faq" });
  const images = (meta.openGraph as { images: Array<{ alt?: string }> }).images;
  assert.equal(images[0].alt, read("src/app/opengraph-image.alt.txt").trim());
});

// ------------------------------------------------------------------
// /demo title・sitemap・redirect
// ------------------------------------------------------------------
test("/demo の title はテンプレートが付ける接尾辞を自分で持たない", () => {
  const src = read("src/app/demo/page.tsx");
  const m = /title:\s*"([^"]+)"/.exec(src);
  assert.ok(m, "/demo に title が無い");
  assert.ok(!m[1].includes("vet402"), `"${m[1]}" — layout の template "%s | vet402" と二重になる`);
});

test("sitemap に公開・被リンクありの 4 頁が入り、孤立 3 頁は入らない", () => {
  const urls = new Set(sitemap().map((e) => e.url));
  for (const p of ["/impact", "/decisions", "/operations", "/playground"]) {
    assert.ok(urls.has(`${SITE_URL}${p}`), `sitemap missing ${p}`);
  }
  // /demo /live /partners は内部リンクが 0 本の孤立頁。sitemap に載せると
  // 「サイトの一部」だと索引に言うことになるので、導線を付けるまで載せない。
  for (const p of ["/demo", "/live", "/partners"]) {
    assert.ok(!urls.has(`${SITE_URL}${p}`), `${p} は孤立頁 — sitemap に載せない`);
  }
});

test("/docs は /docs/api へ 308", async () => {
  const redirects = await nextConfig.redirects!();
  const hit = redirects.find((r) => r.source === "/docs");
  assert.ok(hit, "/docs のリダイレクトが無い");
  assert.equal(hit.destination, "/docs/api");
  assert.equal(hit.permanent, true);
  assert.ok(!redirects.some((r) => r.source === "/agent"), "/agent は旧 URL の意味が不明なので足さない");
});

// ------------------------------------------------------------------
// DIRECTION CONTRACT を配信しない
// ------------------------------------------------------------------
test("DIRECTION CONTRACT はソースのブロックコメントにだけあり、HTML へ出る文字列ではない", () => {
  const src = read("src/app/layout.tsx");
  assert.ok(src.includes("DIRECTION CONTRACT"), "契約文そのものは残す（ソースで読める位置）");
  assert.ok(!/`[^`]*DIRECTION CONTRACT/.test(src), "テンプレート文字列に入っている＝配信される");
  assert.ok(!/__html:\s*DIRECTION_CONTRACT/.test(src), "dangerouslySetInnerHTML で配信している");
  assert.ok(/\/\*[\s\S]*?DIRECTION CONTRACT[\s\S]*?\*\//.test(src), "ブロックコメントの中に無い");
});

// ------------------------------------------------------------------
// エラー本文のヒント（挙動は変えない）
// ------------------------------------------------------------------
test("401 missing_api_key は documentation と signup を添える（キー無し・Bearer 空の両方）", async () => {
  for (const headers of [{}, { authorization: "Bearer " }] as Record<string, string>[]) {
    const res = await authenticateRequest(new Request("http://localhost/api/v1/x", { headers }));
    assert.equal(res.ok, false);
    assert.equal(res.error?.status, 401);
    const body = await res.error!.json();
    assert.equal(body.error, "missing_api_key");
    assert.equal(body.documentation, "/docs/api");
    assert.equal(body.signup, "/signup");
  }
});

test("/api/v1/resolve の 400 invalid_query は expected: \"q\" を添える", async () => {
  const { GET } = await import("@/app/api/v1/resolve/route");
  const missing = await GET(new NextRequest("http://localhost/api/v1/resolve"));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "invalid_query", expected: "q" });

  const unknown = await GET(new NextRequest("http://localhost/api/v1/resolve?q=%3F%3F%3F"));
  assert.equal(unknown.status, 400);
  const body = await unknown.json();
  assert.equal(body.error, "invalid_query");
  assert.equal(body.expected, "q");
  assert.equal(body.query.kind, "unknown");
});

test("公開ルート共通の Cache-Control と /census/summary の Cache-Control は max-age を持つ", async () => {
  const gate = await publicRateLimit(new NextRequest("http://localhost/api/v1/resolve?q=x"), "test-cache");
  assert.ok(gate.ok);
  const shared = gate.cacheHeaders["Cache-Control"];
  assert.match(shared, /\bmax-age=60\b/);
  assert.match(shared, /\bs-maxage=60\b/);

  const { GET } = await import("@/app/api/v1/census/summary/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/census/summary"));
  assert.equal(res.status, 200);
  const cc = res.headers.get("cache-control") ?? "";
  assert.match(cc, /\bmax-age=300\b/, `census: ${cc}`);
  assert.match(cc, /\bs-maxage=300\b/, `census: ${cc}`);
});

// ------------------------------------------------------------------
// 呼称の統一
// ------------------------------------------------------------------
test("/leaderboard は title・見出し行・H1 で Register と名乗る", () => {
  const src = read("src/app/leaderboard/page.tsx");
  const title = /title:\s*"([^"]+)"/.exec(src)?.[1] ?? "";
  assert.match(title, /^Register\b/);
  const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(src)?.[1] ?? "";
  assert.match(h1, /^Register\b/, `H1 "${h1}"`);
});

test("/playground の段落番号は sec-no と同じ「N.」で、「N ·」を使わない", () => {
  const client = read("src/app/playground/playground-client.tsx");
  assert.ok(!/\b[0-9] · /.test(client), "「N ·」の見出しが残っている");
  for (const n of [1, 2, 3]) {
    assert.ok(new RegExp(`>${n}\\. [A-Z]`).test(client), `「${n}. …」の見出しが無い`);
  }
  const page = read("src/app/playground/page.tsx");
  assert.ok(page.includes('<span className="sec-no">4.</span>'), "4. の sec-no が無い");
  assert.ok(!/0-100/.test(client + page), "0-100 は 0–100（en dash）に統一");
});

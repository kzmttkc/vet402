import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sitemap from "@/app/sitemap";
import { OG_IMAGE_PATH } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

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

function resolveTitleConst(src: string, name: string): string | null {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\\\`[^\\\`]*\\\`)`));
  return m ? m[1].slice(1, -1) : null;
}

function declaredTitles(): { file: string; title: string }[] {
  const byFile = new Map<string, string>();
  for (const file of pageFiles(join(ROOT, "src/app"))) {
    const rel = file.slice(ROOT.length);
    if (rel.includes("/observatory/")) continue;
    const src = readFileSync(file, "utf8");
    let title: string | null = null;
    for (const m of src.matchAll(/title:\s*\{\s*absolute:\s*("(?:[^"\\]|\\.)*"|`[^`]*`|TITLE|title)/g)) {
      const raw = m[1];
      if (raw === "TITLE") title = resolveTitleConst(src, "TITLE");
      else if (raw === "title") {
        const t = src.match(/const\s+title\s*=\s*(`[^`]*`|"[^"]*")/);
        if (t) title = t[1].slice(1, -1);
      } else title = raw.slice(1, -1);
    }
    if (!title) {
      for (const m of src.matchAll(/pageMetadata\(\{([\s\S]*?)\n\s*\}\)/g)) {
        const block = m[1];
        const hit = block.match(/title:\s*("(?:[^"\\]|\\.)*"|`[^`]*`|TITLE)/)?.[1];
        if (!hit) continue;
        title =
          hit === "TITLE" ? resolveTitleConst(src, "TITLE") : hit.startsWith("`") || hit.startsWith('"') ? hit.slice(1, -1) : hit;
      }
    }
    if (title) byFile.set(rel, title);
  }
  return [...byFile.entries()].map(([file, title]) => ({ file, title }));
}

test("/pricing の title と canonical", () => {
  const src = read("src/app/pricing/page.tsx");
  assert.match(src, /vet402 pricing: free x402 seller checks, paid limits/);
  assert.match(src, /path:\s*"\/pricing"/);
  assert.match(src, /title:\s*\{\s*absolute:/);
});

test("next.config に /pricing redirect が無い", () => {
  const cfg = read("next.config.ts");
  assert.doesNotMatch(cfg, /source:\s*"\/pricing"/);
});

test("比較ページの title・5 選択肢・引用 URL と取得日", () => {
  const src = read("src/app/x402/ways-to-check-a-seller/page.tsx");
  assert.match(src, /Ways to check an x402 seller before paying \| vet402/);
  assert.match(src, /Pay and read the response/);
  assert.match(src, /Read the 402 yourself/);
  assert.match(src, />x402scan</);
  assert.match(src, />Watch402</);
  assert.match(src, />vet402</);
  assert.match(src, /https:\/\/docs\.x402\.org\//);
  assert.match(src, /https:\/\/www\.x402scan\.com\//);
  assert.match(src, /https:\/\/watchx402\.com\//);
  assert.match(src, /2026-11-15 UTC/);
  assert.match(src, /as of \{stats\.readAt\.slice\(0, 10\)\} UTC/);
});

test("比較ページの禁止語（not a guarantee を除く guarantee）", () => {
  const src = read("src/app/x402/ways-to-check-a-seller/page.tsx");
  const lower = src.toLowerCase();
  const stripped = lower.replace(/not a guarantee/g, "").replace(/safejsonld/g, "");
  for (const w of ["best", "#1", "guarantee", "safe", "we", "our"]) {
    assert.equal(new RegExp(`\\b${w.replace("#", "\\#")}\\b`, "i").test(stripped), false, `forbidden "${w}" in ways page source`);
  }
});

function waysPublicProse(src: string): string {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  const literals = [...noComments.matchAll(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"/g)].map((m) => m[0].slice(1, -1));
  const jsx = [...noComments.matchAll(/<(?:[A-Za-z][\w.]*)(?:\s[^<>]*?)?>([^<>{}]*)</g)].map((m) => m[1]);
  return [...literals, ...jsx].join("\n");
}

test("比較ページ: 引用2文・順序・blockquote・ダッシュとセミコロン 0", () => {
  const src = read("src/app/x402/ways-to-check-a-seller/page.tsx");
  const prose = waysPublicProse(src);
  assert.match(prose, /Pay and read the response/);
  assert.match(prose, /Read the 402 yourself/);
  assert.match(src, />x402scan</);
  assert.match(src, />Watch402</);
  assert.match(src, /Explore the x402 ecosystem\. View transactions, sellers, origins and resources\./);
  assert.match(src, /Every x402 listing on the Bazaar, checked daily\. Publicly\./);
  const headings = [...src.matchAll(/<h2 className="sec-head">[\s\S]*?<span>([^<]+)<\/span>\s*<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(headings, [
    "Pay and read the response",
    "Read the 402 yourself",
    "x402scan",
    "Watch402",
    "vet402",
  ]);
  assert.equal((src.match(/<blockquote/g) ?? []).length, 2);
  assert.equal(/unlike/i.test(prose), false);
  assert.equal(/\bdoes not\b/i.test(prose), false);
  assert.equal(/[\u2014\u2013;]/.test(prose), false);
  assert.ok(src.indexOf("Pay and read the response") < src.indexOf("Watch402"));
  assert.ok(src.indexOf("Watch402") < src.indexOf("vet402 pays with real"));
});

test("sitemap.ts に /pricing と比較ページ・評判 50 件用の読み", async () => {
  const src = read("src/app/sitemap.ts");
  assert.match(src, /\/pricing/);
  assert.match(src, /ways-to-check-a-seller/);
  assert.match(src, /getReputationHostsCached/);
  const urls = (await sitemap()).map((e) => e.url);
  assert.ok(urls.includes(`${SITE_URL}/pricing`));
  assert.ok(urls.includes(`${SITE_URL}/x402/ways-to-check-a-seller`));
});

test("sitemap-sellers.xml は I4 の /sellers/ だけ（2026-11-27）", () => {
  const route = read("src/app/sitemap-sellers.xml/route.ts");
  assert.match(route, /\/sellers\//);
  assert.doesNotMatch(route, /reputationLoc|getReputationHostsCached/);
  assert.match(route, /getIndexableSellerHostsCached/);
  assert.match(route, /getSellerBoardCached/);
});

test("主要ページ（observatory 配下除く）の title 重複 0", () => {
  const rows = declaredTitles();
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const r of rows) {
    const prev = seen.get(r.title);
    if (prev) dups.push(`${r.title} — ${prev} と ${r.file}`);
    else seen.set(r.title, r.file);
  }
  assert.deepEqual(dups, []);
});

test("OG 画像が在る（pageMetadata 経由の頁）", () => {
  const rel = OG_IMAGE_PATH.replace(/^\//, "");
  const alt = join(ROOT, "public", rel);
  const appRoute = join(ROOT, "src/app", rel);
  assert.ok(existsSync(alt) || existsSync(appRoute), `missing OG at public or src/app for ${OG_IMAGE_PATH}`);
});

test("home metadata title matches H1 job statement", () => {
  const src = read("src/app/page.tsx");
  assert.match(
    src,
    /title:\s*"Know if an x402 seller delivers before your agent pays \| vet402"/,
  );
  assert.doesNotMatch(src, /verify x402 payments for AI agents/);
});

test("signup eyebrow says Free API key, not Access request", () => {
  const src = read("src/app/signup/page.tsx");
  assert.match(src, />Free API key</);
  assert.doesNotMatch(src, /Access request/);
});

test("observatory network field stays readable at 360px (select, not eip155 placeholder)", () => {
  const src = read("src/app/observatory/page.tsx");
  assert.match(src, /<select[^>]*name="network"/);
  assert.doesNotMatch(src, /placeholder="eip155:8453"/);
  assert.match(src, /min-w-\[13ch\]/);
});
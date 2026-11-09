// ============================================================
// site_events_daily — first-party page and funnel events (2026-11-09).
// ============================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { __setDbForTests } from "@/lib/db/client";
import { setAfterResponseSchedulerForTest } from "@/lib/util/after-response";
import { GUIDE_CHAINS } from "@/components/site/x402-guides";
import {
  SITE_EVENTS,
  pathGroup,
  recordSiteEvent,
  shouldCount,
  sourceLabel,
} from "@/lib/site-events";

const ROOT = join(import.meta.dirname, "..");

afterEach(() => {
  setAfterResponseSchedulerForTest(null);
  __setDbForTests(null);
});

test("pathGroup: static routes and normalization", () => {
  assert.equal(pathGroup("/docs/api"), "/docs/api");
  assert.equal(pathGroup("/docs/api/"), "/docs/api");
  assert.equal(pathGroup("/docs/api?utm=1"), "/docs/api");
  assert.equal(pathGroup("/memo"), "/memo");
  assert.equal(pathGroup("/dashboard/keys"), "/dashboard");
});

test("pathGroup: chain slug and blog", () => {
  const slug = GUIDE_CHAINS[0]?.slug ?? "base";
  assert.equal(pathGroup(`/x402/chains/${slug}`), `/x402/chains/${slug}`);
  assert.equal(pathGroup("/x402/chains/unknown-chain-slug"), "/x402/chains/[chain]");
  assert.equal(pathGroup("/blog/what-is-x402"), "/blog/what-is-x402");
  assert.equal(pathGroup("/blog/not-a-real-post"), "/blog/[other]");
});

test("pathGroup: dynamic patterns", () => {
  assert.equal(pathGroup("/observatory/e/abc-123"), "/observatory/e/[id]");
  assert.equal(pathGroup("/sellers/example.com"), "/sellers/[host]");
  assert.equal(pathGroup("/payee/0xabc"), "/payee/[address]");
  assert.equal(pathGroup("/mystery-page"), "other");
  assert.ok(pathGroup(`/${"a".repeat(80)}`).length <= 64);
});

test("sourceLabel", () => {
  assert.equal(sourceLabel(""), "direct");
  assert.equal(sourceLabel("internal"), "internal");
  assert.equal(sourceLabel(undefined), "direct");
  assert.equal(sourceLabel("vet402.com"), "internal");
  assert.equal(sourceLabel("www.vet402.com"), "internal");
  assert.equal(sourceLabel("www.google.com"), "google");
  assert.equal(sourceLabel("gemini.google.com"), "gemini");
  assert.equal(sourceLabel("bing.com"), "bing");
  assert.equal(sourceLabel("duckduckgo.com"), "duckduckgo");
  assert.equal(sourceLabel("search.yahoo.com"), "yahoo");
  assert.equal(sourceLabel("chatgpt.com"), "chatgpt");
  assert.equal(sourceLabel("chat.openai.com"), "chatgpt");
  assert.equal(sourceLabel("perplexity.ai"), "perplexity");
  assert.equal(sourceLabel("claude.ai"), "claude");
  assert.equal(sourceLabel("copilot.microsoft.com"), "copilot");
  assert.equal(sourceLabel("t.co"), "x");
  assert.equal(sourceLabel("x.com"), "x");
  assert.equal(sourceLabel("github.com"), "github");
  assert.equal(sourceLabel("linkedin.com"), "linkedin");
  assert.equal(sourceLabel("lnkd.in"), "linkedin");
  assert.equal(sourceLabel("reddit.com"), "reddit");
  assert.equal(sourceLabel("news.ycombinator.com"), "hn");
  assert.equal(sourceLabel("dev.to"), "devto");
  assert.equal(sourceLabel("npmjs.com"), "npm");
  assert.equal(sourceLabel("example.com"), "other");
});

test("shouldCount: bot and origin", () => {
  const mk = (pairs: [string, string][]) => ({
    get: (k: string) => pairs.find(([h]) => h.toLowerCase() === k.toLowerCase())?.[1] ?? null,
  });
  assert.equal(shouldCount(mk([])), false);
  assert.equal(shouldCount(mk([["user-agent", ""]])), false);
  assert.equal(shouldCount(mk([["user-agent", "Googlebot/2.1"]])), false);
  assert.equal(shouldCount(mk([["user-agent", "Mozilla/5.0"], ["sec-fetch-site", "same-origin"]])), true);
  assert.equal(
    shouldCount(mk([["user-agent", "Mozilla/5.0"], ["origin", "https://vet402.com"]])),
    true,
  );
  assert.equal(
    shouldCount(mk([["user-agent", "Mozilla/5.0"], ["origin", "https://evil.example"]])),
    false,
  );
});

test("recordSiteEvent: unknown event is a no-op", () => {
  let ran = false;
  setAfterResponseSchedulerForTest((fn) => {
    ran = true;
    fn();
  });
  recordSiteEvent({ event: "not_in_allowlist", path: "/", source: "direct" });
  assert.equal(ran, false);
});

function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const full = join(ROOT, rel);
    if (statSync(full).isDirectory()) out.push(...walkSrc(rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

test("allowlist: every track/event name in src is in SITE_EVENTS", () => {
  const names = new Set<string>();
  const reTrack = /track\(\s*["']([^"']+)["']/g;
  const reEvent = /event\s*=\s*["']([^"']+)["']/g;
  const reEventColon = /event:\s*["']([^"']+)["']/g;
  for (const rel of walkSrc("src")) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const re of [reTrack, reEvent, reEventColon]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) names.add(m[1]);
    }
  }
  const allow = new Set<string>(SITE_EVENTS);
  const missing = [...names].filter((n) => !allow.has(n)).sort();
  assert.deepEqual(missing, [], `events missing from SITE_EVENTS: ${missing.join(", ")}`);
});

test("src has no Plausible product wiring", () => {
  const bad: string[] = [];
  const productRe = /plausible\.io|window\.plausible|PLAUSIBLE_|Plausible Analytics/i;
  for (const rel of walkSrc("src")) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    if (productRe.test(src)) bad.push(rel);
  }
  assert.deepEqual(bad, []);
});

test("privacy page: site_events_daily and no Plausible", () => {
  const privacy = readFileSync(join(ROOT, "src/app/legal/privacy/page.tsx"), "utf8");
  assert.match(privacy, /site_events_daily/);
  assert.doesNotMatch(privacy, /Plausible/);
  assert.doesNotMatch(privacy, /plausible/);
});

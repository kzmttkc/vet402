// ============================================================
// vet402 — the machine layer must say what the human layer says.
//
// 2026-08-13, machine-reader persona audit. The customer of this product is a
// program, and the honesty was living entirely in HTML:
//
//   /accuracy (HTML)     "100% counts BLOCK *or* WARN — 1 of 25 stops at WARN,
//                         and an integration that lets WARN through pays it"
//                        "0% means none were blocked, not all were passed"
//   /api/v1/accuracy     { "detectionRate": 100, "falsePositiveRate": 0 }
//   public/llms.txt      "…the same numbers /accuracy renders"
//
// The JSON carried the same numbers without the sentences that say what they
// mean, and llms.txt told the machine it therefore need not read the page.
// Three more of the same shape were open at the same time: /faq published, as
// machine-readable JSON-LD, the claim that every API response carries the
// disclaimer in its payload — while the two key-less scored endpoints did not;
// /api/demo/score called a value up to 5.5 minutes old `live: true` with no
// expiry, where its sibling passport has always published one; and any mistyped
// path under /api/ answered 23KB of HTML to a caller that had built a JSON
// parser, ignoring `Accept: application/json`.
//
// These tests pin the properties, not the prose.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeAccuracyReport } from "@/lib/scoring/accuracy";
import { computeBenchmarkReport, type BenchmarkRow } from "@/lib/scoring/benchmark-report";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const src = (rel: string) => read(join("src", rel));

test("the JSON accuracy report ships the same caveats the page prints", () => {
  const route = src("app/api/v1/accuracy/route.ts");
  const page = src("app/accuracy/page.tsx");

  // The two sentences that turn a flattering number into an honest one.
  for (const phrase of [
    "a detection here counts BLOCK",
    "a false positive here counts only a BLOCK on a known-good address",
  ]) {
    assert.ok(
      route.includes(phrase),
      `the JSON must carry the caveat "${phrase}", not leave it on the HTML page`,
    );
    assert.ok(page.includes(phrase), `the page must still carry "${phrase}" — both sides or neither`);
  }

  // The unflattering readings, stated in the machine's own vocabulary rather
  // than only inside an English sentence it has to parse.
  for (const field of [
    "detectionRateCountsWarnAsDetection",
    "knownBadWarnOnly",
    "falsePositiveRateCountsBlockOnly",
    "knownGoodAllowed",
    "knownGoodWarned",
  ]) {
    assert.ok(route.includes(field), `interpretation must expose ${field}`);
  }
});

test("the caveat counts are read from the report, never hard-coded", () => {
  // A frozen "1 of 25" becomes a lie the week the address set changes — the
  // reason the page computes its own note the same way.
  const route = src("app/api/v1/accuracy/route.ts");
  const caveatBlock = route.slice(
    route.indexOf("function buildInterpretation"),
    route.indexOf("export async function GET"),
  );
  assert.ok(caveatBlock.length > 0, "buildInterpretation must exist above the handler");
  assert.match(caveatBlock, /benchmark\.knownBad\.warned/);
  assert.match(caveatBlock, /benchmark\.knownBad\.total/);
  assert.match(caveatBlock, /benchmark\.knownGood\.total/);
  assert.match(caveatBlock, /benchmark\.knownGood\.warned/);
  assert.match(caveatBlock, /report\.minSample/);
  // No literal sample sizes anywhere in the interpretation builder.
  assert.doesNotMatch(
    caveatBlock,
    /\b(?:17|25|24)\b/,
    "a count in this block is a hard-coded sample size — read it from the report instead",
  );
});

test("the caveats describe the live benchmark shape, whatever it is", () => {
  // Production on 2026-08-13: 25 known-bad (24 BLOCK / 1 WARN), 17 known-good
  // (0 ALLOW / 17 WARN). Rebuilt here from rows so the arithmetic behind the
  // published sentences is exercised, not asserted.
  const rows: BenchmarkRow[] = [];
  for (let i = 0; i < 24; i++) {
    rows.push({ relatedWallet: `0xbad${i}`, recommendation: "BLOCK", outcomeType: "confirmed_fraud", detectedAt: "2026-08-12T00:00:00Z" });
  }
  rows.push({ relatedWallet: "0xbadwarn", recommendation: "WARN", outcomeType: "confirmed_fraud", detectedAt: "2026-08-12T00:00:00Z" });
  for (let i = 0; i < 17; i++) {
    rows.push({ relatedWallet: `0xgood${i}`, recommendation: "WARN", outcomeType: "confirmed_legitimate", detectedAt: "2026-08-12T00:00:00Z" });
  }

  const benchmark = computeBenchmarkReport(rows);
  assert.equal(benchmark.knownBad.detectionRate, 100);
  assert.equal(benchmark.knownGood.falsePositiveRate, 0);

  // The two numbers that make those rates readable, and which the JSON now
  // states outright rather than leaving to be inferred.
  assert.equal(benchmark.knownBad.warned, 1, "a 100% detection rate with a WARN inside it");
  assert.equal(benchmark.knownGood.allowed, 0, "a 0% false-positive rate with nothing allowed");
  assert.equal(benchmark.knownGood.warned, 17);

  // And the external figures stay null on an empty external sample — the JSON
  // says "insufficient data" by being null, never by printing a rate.
  const external = computeAccuracyReport([]);
  assert.equal(external.allowAdverseRate, null);
  assert.equal(external.blockFalsePositiveRate, null);
});

test("llms.txt does not tell a machine the JSON is enough unless it is", () => {
  const llms = read("public/llms.txt");
  const line = llms.split("\n").find((l) => l.includes("GET /api/v1/accuracy"));
  assert.ok(line, "llms.txt must still list the accuracy endpoint");
  assert.match(
    line,
    /interpretation/,
    "llms.txt claims the JSON has the same numbers; it must also say the caveats ride along",
  );
});

test("the key-less scored endpoints carry the disclaimer /faq promises", () => {
  // /faq publishes this as JSON-LD — a machine-checkable claim. It must not be
  // falsified by the payloads a machine is most likely to fetch first.
  const faq = src("components/site/faq-data.ts");
  assert.match(faq, /includes this disclaimer directly in the payload/);

  assert.match(src("app/api/demo/score/route.ts"), /disclaimer: result\.disclaimer/);
  assert.match(src("app/api/v1/accuracy/route.ts"), /disclaimer: DISCLAIMER/);
  assert.match(src("app/api/v1/agents/[agentId]/passport/route.ts"), /disclaimer:/);
});

test("/api/demo/score publishes freshness the way its sibling passport does", () => {
  const demo = src("app/api/demo/score/route.ts");
  const passport = src("app/api/v1/agents/[agentId]/passport/route.ts");

  for (const file of [demo, passport]) {
    assert.match(file, /scoredAt: result\.scoredAt/);
    assert.match(
      file,
      /cacheExpiresAt: result\.cacheExpiresAt/,
      "freshness must come from the engine's own result, not from a route's private cache window",
    );
  }
});

test("the key-less paths publish their rate limit on the wire", () => {
  // A limiter the client cannot see is useless as a documented contract. Both
  // routes previously short-circuited on their module cache BEFORE consuming
  // the limiter, so the common response carried no headers at all — and the
  // documented ceiling was not actually applied to it.
  for (const rel of ["app/api/v1/accuracy/route.ts", "app/api/demo/score/route.ts"]) {
    const file = src(rel);
    const limiterAt = file.indexOf("consumeIpRateLimit");
    const cacheAt = file.indexOf("cached.expiresAt > now");
    assert.ok(limiterAt > 0 && cacheAt > 0, `${rel} must have both a limiter and a cache`);
    assert.ok(
      limiterAt < cacheAt,
      `${rel}: the limiter must run before the cache short-circuit, or a cache hit is unmetered and header-less`,
    );
    assert.match(file, /\.\.\.rlHeaders/, `${rel} must put the rate-limit ceiling on its responses`);
  }
});

test("a per-caller counter is never baked into a shared-cache response", () => {
  // Measured on the deploy, not read off the code: eleven fetches of the CDN-
  // cached /api/demo/score all reported `RateLimit-Remaining: 9`, because the
  // function was never reached — the number described whoever populated the
  // cache. That is precisely the "a number that means something other than what
  // it appears to mean" defect the rest of this file exists to close, so the
  // cacheable responses carry the ceiling only.
  const helper = src("lib/api/ip-rate-limit.ts");
  const shared = helper.slice(helper.indexOf("export function sharedCacheRateLimitHeaders"));
  assert.doesNotMatch(shared, /RateLimit-Remaining/, "Remaining is per-caller and must not be shared");
  assert.doesNotMatch(shared, /RateLimit-Reset/, "Reset is per-caller and must not be shared");
  assert.match(shared, /RateLimit-Limit/, "the ceiling is true for everyone and stays");

  for (const rel of ["app/api/v1/accuracy/route.ts", "app/api/demo/score/route.ts"]) {
    const file = src(rel);
    // Every `s-maxage` response must use the shared set, never the full one.
    for (const block of file.split("NextResponse.json").slice(1)) {
      const head = block.slice(0, 400);
      if (!head.includes("s-maxage")) continue;
      assert.ok(
        head.includes("...rlHeaders") && !head.includes("perCallerRlHeaders"),
        `${rel}: a CDN-cacheable response must not carry per-caller rate-limit counters`,
      );
    }
    // …and the 429, which is not shared, must carry the full set incl. Retry-After.
    assert.match(
      file,
      /status: 429,\s*headers: perCallerRlHeaders/,
      `${rel}: the 429 must carry Remaining/Reset/Retry-After`,
    );
  }
});

test("an unmatched /api path answers JSON, not the site's HTML 404", () => {
  const catchAll = src("app/api/[...unmatched]/route.ts");
  assert.match(catchAll, /error: "not_found"/);
  assert.match(catchAll, /status: 404/);
  // Every method, not just GET: a machine that POSTs to a typo gets the same
  // parseable answer.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    assert.match(
      catchAll,
      new RegExp(`export async function ${method}\\b`),
      `the catch-all must handle ${method}`,
    );
  }
});

test("the published schema advertises the live host and the whole product", () => {
  const spec = read("docs/openapi.yaml");

  // llms.txt asks machines not to cite or link the old deployment host. The
  // site's own schema was advertising it as Production.
  const serverBlock = spec.slice(spec.indexOf("\nservers:"), spec.indexOf("\nsecurity:"));
  assert.ok(
    serverBlock.includes("- url: https://vet402.com"),
    "the production server must be the canonical domain",
  );
  assert.doesNotMatch(
    serverBlock.split("\n").filter((l) => l.trim().startsWith("- url:")).join("\n"),
    /vercel\.app/,
    "no server entry may point at the retired deployment host",
  );

  // Coverage: a generated client must be able to reach the whole public API.
  for (const path of [
    "/api/v1/accuracy:",
    "/api/v1/agents/verify:",
    "/api/v1/agents/{agentId}/passport:",
    "/api/v1/watchlist:",
    "/api/v1/watchlist/{id}:",
    "/api/v1/observatory/watch:",
    "/api/demo/score:",
    "/api/badge/{address}:",
    "/api/badge/agent/{agentId}:",
    "/api/health:",
  ]) {
    assert.ok(spec.includes(`\n  ${path}`), `docs/openapi.yaml must document ${path.slice(0, -1)}`);
  }

  // The dormant guarantee endpoint stays out: it 404s unless a flag is on, and
  // an unlaunched financial product must not be discoverable.
  assert.ok(
    !spec.includes("\n  /api/v1/guarantee/quote:"),
    "the flag-gated guarantee endpoint must not be advertised while it is off",
  );
});

// 2026-11-02（監査 L7）: CDN が配る CSV の 200 に呼び手ごとの残数を載せない。本番で `age: 832` の HIT に
// `ratelimit-remaining: 5` が付き、他人の残数が配られていた。
test("the three CSV exports send only RateLimit-Limit on a cached 200", () => {
  for (const route of [
    "src/app/api/v1/observatory/export.csv/route.ts",
    "src/app/api/v1/observatory/l0/export.csv/route.ts",
    "src/app/api/v1/sellers/export.csv/route.ts",
  ]) {
    const src = readFileSync(join(ROOT, route), "utf8");
    assert.match(src, /const shared = (withNoindex\()?sharedCacheRateLimitHeaders\(limited\)/, route);
    assert.match(src, /headers: \{\n\s+\.\.\.shared,\n\s+"content-type": "text\/csv/, route);
  }
});

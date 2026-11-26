// 2026-11-16 PMF85 legal copy: terms §0, signup line, privacy Clarity c.bing.com, survival §12, dates, weekly key-less counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ");

const PMF85_VERBATIM =
  "Anyone can create a free account. Paid plans are for business use; where consumer law applies, it prevails.";

function sliceBetween(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `start marker missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `end marker missing: ${end}`);
  return src.slice(a, b);
}

const termsSrc = read("src/app/legal/terms/page.tsx");
const privacySrc = read("src/app/legal/privacy/page.tsx");

const NEW_SNIPPETS = [
  sliceBetween(termsSrc, "Who can use vet402", "sec-no\">1."),
  sliceBetween(
    termsSrc,
    "or personal injury. Section 0 allows anyone a free account",
    "consumer-protection rules nonetheless apply to you",
  ),
  sliceBetween(
    termsSrc,
    "instance. Section 0 allows anyone a free account",
    "own country, those rules apply on their own terms",
  ),
  "Paid plans are for business use, and where consumer law applies, it prevails. They are billed after an API key exists.",
  read("src/app/signup/page.tsx").slice(
    read("src/app/signup/page.tsx").indexOf(PMF85_VERBATIM),
    read("src/app/signup/page.tsx").indexOf(PMF85_VERBATIM) + 400,
  ),
  sliceBetween(privacySrc, "Weekly key-less caller counts", "Keyed decision counts"),
  sliceBetween(privacySrc, "weekly key-less caller counts. The", "Legal obligation"),
  sliceBetween(privacySrc, "For weekly key-less caller counts, the pseudonymized digests", "Key-less API call counts"),
  sliceBetween(
    privacySrc,
    "For weekly key-less caller counts, vet402 does not store",
    "To exercise any of these, email",
  ),
  sliceBetween(privacySrc, 'id="session-analytics"', 'id="privacy-choices"'),
  sliceBetween(privacySrc, "While Clarity runs, the browser may also connect", "<strong>Masking.</strong>"),
];

test("terms §0: no consumer marketing denial; carries the PMF85 verbatim pair", () => {
  const terms = squash(read("src/app/legal/terms/page.tsx"));
  assert.doesNotMatch(terms, /not marketed or sold to consumers/i);
  assert.doesNotMatch(terms, /intended for business-to-business use/i);
  assert.doesNotMatch(terms, /business use only \(section 0\)/i);
  assert.doesNotMatch(terms, /is a B2B service \(section 0\)/i);
  assert.ok(terms.includes(PMF85_VERBATIM), "verbatim sentence pair");
  assert.match(terms, /Who can use vet402/);
});

test("signup: carries the PMF85 verbatim pair", () => {
  const signup = squash(read("src/app/signup/page.tsx"));
  assert.ok(signup.includes(PMF85_VERBATIM));
});

test("privacy: c.bing.com in external transmission and session analytics", () => {
  const privacy = read("src/app/legal/privacy/page.tsx");
  const ext = sliceBetween(privacySrc, 'id="external-transmission"', 'id="session-analytics"');
  assert.ok(ext.includes("c.bing.com"), "external-transmission paragraph");
  assert.ok(privacy.includes("c.bing.com"));
  const matches = privacy.match(/c\.bing\.com/g);
  assert.ok(matches && matches.length >= 2, "c.bing.com appears at least twice");
});

test("terms §12: survival includes sections 13 through 16", () => {
  const terms = squash(read("src/app/legal/terms/page.tsx"));
  assert.match(terms, /sections 13 through 16/);
});

test("terms and privacy: revision and last-updated dates match the November 2026 legal revisions", () => {
  for (const [f, display] of [
    ["src/app/legal/terms/page.tsx", "November 16, 2026"],
    ["src/app/legal/privacy/page.tsx", "November 26, 2026"],
  ] as const) {
    const src = read(f);
    assert.match(src, new RegExp(`Revision: <span className="text-signal">${display}<\\/span>`));
    assert.match(src, new RegExp(`Last updated: ${display}`));
    assert.match(src, new RegExp(`>${display}<`));
    for (const stale of [
      "September 29, 2026",
      "November 2, 2026",
      "November 9, 2026",
      "September 2026",
      "October 2026",
    ]) {
      assert.doesNotMatch(src, new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("privacy: weekly key-less caller counts (H-2)", () => {
  const privacy = squash(read("src/app/legal/privacy/page.tsx"));
  assert.match(privacy, /Weekly key-less caller counts/);
  assert.match(privacy, /secret salt/);
  assert.match(privacy, /replaced every week/);
  assert.match(privacy, /sha256\(salt \+ IP address \+ User-Agent\)/);
  assert.match(privacy, /IP address and User-Agent are not stored/);
  assert.match(privacy, /closes a UTC week/);
  assert.match(privacy, /deletes that week.*salt, digests, and carry bits/);
  assert.match(privacy, /Only three counts remain/);
  assert.match(privacy, /how many distinct callers/);
  assert.match(privacy, /2 or more UTC days/);
  assert.match(privacy, /also calling the key-less API the previous week/);
  assert.match(privacy, /bloom-filter positions carried from the prior week/);
  assert.match(privacy, /does not keep the previous week.*salt/);
  assert.match(privacy, /UTC calendar dates/);
  assert.doesNotMatch(privacy, /uses the IP address only for rate limiting/i);
  assert.doesNotMatch(privacy, /hashes the same IP address and User-Agent with the previous week/);
});

test("privacy: weekly key-less erasure states no stored IP or UA (H-2)", () => {
  const block = squash(
    sliceBetween(privacySrc, "For weekly key-less caller counts, vet402 does not store", "To exercise any of these, email"),
  );
  assert.match(block, /does not store an IP address or User-Agent/);
  assert.match(block, /only the three aggregate counts for that week remain/);
  assert.match(block, /cannot be linked to a particular caller/);
  assert.doesNotMatch(block, /delete every row/);
});

test("terms §16: aligned with §0; not business-to-business subscriptions", () => {
  const s16 = squash(
    sliceBetween(termsSrc, "Paid subscriptions", "</section>").replace(/<[^>]+>/g, " "),
  );
  assert.doesNotMatch(s16, /business-to-business subscriptions/i);
  assert.match(s16, /Paid plans are for business use/);
  assert.match(s16, /where consumer law applies, it prevails/);
  assert.match(s16, /billed after an API key exists/);
});

test("PMF85 new English: banned words and punctuation", () => {
  for (const chunk of NEW_SNIPPETS) {
    const prose = chunk.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    assert.doesNotMatch(prose, /\bwe\b/i, "new copy avoids we");
    assert.doesNotMatch(prose, /\bour\b/i, "new copy avoids our");
    assert.doesNotMatch(prose, /\bus\b/i, "new copy avoids us");
    assert.doesNotMatch(prose, /—/, "new copy avoids em dash");
    assert.doesNotMatch(prose, /\bguarantee\b/i, "new copy avoids guarantee");
    assert.doesNotMatch(prose, /\bsafely\b/i, "new copy avoids safely");
    assert.doesNotMatch(prose, /\bsafe\b/i, "new copy avoids safe");
    assert.doesNotMatch(prose, /\bbest\b/i, "new copy avoids best");
  }
});
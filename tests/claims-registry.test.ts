// ============================================================
// vet402 — claims registry gate (2026-09-04).
//
// 2026-08-13 の LP は "every catalog-listed x402 endpoint, probed daily" と
// 書いていた。2026-08-20 に /observatory/state が同じサイトへ実測を出し、
// その値は 18.8% (2,750/14,662) だった。**同一サイト内で主張と実測が矛盾**した
// まま 20 日間公開され、その間に走った 6 回の監査はどれも気づかなかった。
// 外部の観測所 probe402 が 9/1 に読み取り 9/3 に公開している。
//
// 根本原因は「散文の主張」と「機械が出す実測」を突き合わせる常設の検査が
// 無かったこと。監査は都度の指示文に依存していて、「言っていることは
// 本当か」が毎回入る保証がない。
//
// この suite は関門を 2 つ置く:
//   1. 公開面のコピーに現れた断定（daily / every / never ...）が
//      docs/claims.yaml に登録済みか（未登録なら fail）
//   2. 登録簿そのものが正直か（check を書けないものは why_unverifiable 必須、
//      quote は実際にその surface に存在すること）
// 実行時の照合は scripts/claims-canary.ts（npm run claims:canary）が持つ。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { extractAssertions, ASSERTIVE_TERMS } from "@/lib/claims/extract";
import { parseRegistry } from "@/lib/claims/yaml";
import { evaluateAssertion } from "@/lib/claims/evaluate";
import { runClaimChecks } from "@/lib/claims/canary";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ---------- 1. 抽出器の単体 ----------

test("extractor finds an assertive term in JSX text", () => {
  const found = extractAssertions(`export default function P(){return <p>The catalog is re-fetched daily.</p>;}`, "x.tsx");
  assert.equal(found.length, 1);
  assert.equal(found[0].term, "daily");
  assert.match(found[0].text, /re-fetched daily/);
  assert.equal(found[0].line, 1);
});

test("extractor ignores // line comments but not URLs inside strings", () => {
  const src = [
    `// every endpoint is probed daily`,
    `const u = "https://vet402.com/api";`,
    `const jsx = <p>never mixed</p>;`,
  ].join("\n");
  const terms = extractAssertions(src, "x.tsx").map((a) => a.term);
  assert.deepEqual(terms, ["never"]);
});

test("extractor ignores /* */ and {/* */} comments, including Japanese ones", () => {
  const src = [
    `/* every probe runs daily */`,
    `const a = <div>`,
    `  {/* 2026-08-13 UX監査: ここは never "bad" と言わない */}`,
    `  <span>always signed</span>`,
    `</div>;`,
  ].join("\n");
  const found = extractAssertions(src, "x.tsx");
  assert.deepEqual(found.map((a) => a.term), ["always"]);
  assert.equal(found[0].line, 4);
});

test("extractor ignores import lines", () => {
  const src = `import { allChains } from "@/lib/all-chains-daily";\nconst j = <p>ok</p>;`;
  assert.deepEqual(extractAssertions(src, "x.tsx"), []);
});

test("extractor ignores className / class attribute values", () => {
  const src = `const j = <td className="break-all sr-only"><caption className="sr-only">rows</caption></td>;`;
  assert.deepEqual(extractAssertions(src, "x.tsx"), []);
});

test("extractor ignores identifiers such as Promise.all and arr.every", () => {
  const src = `const r = await Promise.all([a, b]); const ok = rows.every((x) => x.pass);`;
  assert.deepEqual(extractAssertions(src, "x.tsx"), []);
});

test("extractor reads JSX text that follows an expression, not just text after a tag", () => {
  // `{" "}` や `{value}` の直後に続く文が落ちると、LP の
  // "The catalog is re-fetched daily; endpoints are probed on a rolling schedule"
  // のような**まさに事故った文**が丸ごと検査を素通りする。
  const src = `const j = <p>counts{" "}are never mixed, and {n} endpoints are probed daily.</p>;`;
  const terms = extractAssertions(src, "x.tsx").map((a) => a.term);
  assert.deepEqual(terms.sort(), ["daily", "never"]);
});

test("extractor drops code-shaped fragments between braces", () => {
  const src = [`function f() {`, `  if (all.length) {`, `    return rows.map((r) => r.id);`, `  }`, `}`].join("\n");
  assert.deepEqual(extractAssertions(src, "x.tsx"), []);
});

test("extractor ignores lone words — a one-word label is not a factual sentence", () => {
  // <option>All</option> や <span>never</span> はフィルタ／バッジの見出し。
  // 2語からは残す（"probed daily" のような短い断定を落とさないため）。
  assert.deepEqual(extractAssertions(`<select><option>All</option><span>never</span></select>`, "x.tsx"), []);
  assert.equal(extractAssertions(`<p>probed daily</p>`, "x.tsx").length, 1);
});

test("extractor ignores code samples inside <code> and <pre>", () => {
  const src = [
    `const j = <p>Under the default <code>allow-only</code> policy, this denies.</p>;`,
    `const k = <pre><code>{'{ "note": "runs daily" }'}</code></pre>;`,
  ].join("\n");
  const found = extractAssertions(src, "x.tsx");
  assert.deepEqual(found.map((a) => `${a.line}:${a.term}`), []);
});

test("extractor ignores code-carrying object keys (response / request / code)", () => {
  const src = [
    "const e = { note: \"Scored daily.\", response: `{ \"x\": \"only proves control\" }` };",
  ].join("\n");
  const found = extractAssertions(src, "x.tsx");
  assert.deepEqual(found.map((a) => a.term), ["daily"]);
});

test("extractor reads prose out of string literals (metadata descriptions)", () => {
  const src = `export const metadata = { description: "Daily measurements over the public x402 catalog." };`;
  const found = extractAssertions(src, "x.tsx");
  assert.equal(found.length, 1);
  assert.equal(found[0].term, "daily");
});

test("ASSERTIVE_TERMS covers the words the 2026-08-13 incident turned on", () => {
  for (const t of ["daily", "every", "all", "always", "never", "100%", "continuously", "real time", "instantly", "no one else", "only"]) {
    assert.ok(ASSERTIVE_TERMS.some((r) => r.pattern.test(` ${t} `)), `missing term: ${t}`);
  }
});

// ---------- 2. YAML サブセットの単体 ----------

test("registry parser reads claims with a nested check", () => {
  const doc = parseRegistry(
    [
      `allow_phrases:`,
      `  - phrase: "sr-only"`,
      `    why: "Tailwind utility"`,
      `claims:`,
      `  - id: lp_probe_cadence`,
      `    surface: src/app/page.tsx`,
      `    quote: "probed on a rolling schedule"`,
      `    means: "not daily"`,
      `    check:`,
      `      url: https://vet402.com/api/v1/observatory/state`,
      `      assert: "coverage.pct >= 0"`,
      `    verified_at: 2026-09-04`,
      ``,
    ].join("\n"),
  );
  assert.equal(doc.allow_phrases.length, 1);
  assert.equal(doc.allow_phrases[0].phrase, "sr-only");
  assert.equal(doc.claims.length, 1);
  assert.equal(doc.claims[0].id, "lp_probe_cadence");
  assert.equal(doc.claims[0].check?.assert, "coverage.pct >= 0");
  assert.equal(doc.claims[0].verified_at, "2026-09-04");
});

test("registry parser keeps `check: null` as null", () => {
  const doc = parseRegistry(
    [
      `claims:`,
      `  - id: a`,
      `    surface: src/app/page.tsx`,
      `    quote: "x"`,
      `    means: "y"`,
      `    check: null`,
      `    why_unverifiable: "no public endpoint exposes this"`,
      `    verified_at: 2026-09-04`,
    ].join("\n"),
  );
  assert.equal(doc.claims[0].check, null);
  assert.equal(doc.claims[0].why_unverifiable, "no public endpoint exposes this");
});

// ---------- 3. 評価器の単体 ----------

test("evaluator compares a nested numeric path", () => {
  assert.deepEqual(evaluateAssertion("coverage.pct >= 0", { coverage: { pct: 18.8 } }), {
    ok: true,
    actual: 18.8,
    expected: "coverage.pct >= 0",
  });
  assert.equal(evaluateAssertion("coverage.pct >= 50", { coverage: { pct: 18.8 } }).ok, false);
});

test("evaluator compares strings with ==", () => {
  assert.equal(evaluateAssertion('cadence == "rolling"', { cadence: "rolling" }).ok, true);
  assert.equal(evaluateAssertion('cadence == "daily"', { cadence: "rolling" }).ok, false);
});

test("evaluator reports a missing path as false, not as a crash", () => {
  const r = evaluateAssertion("a.b.c <= 3", { a: {} });
  assert.equal(r.ok, false);
  assert.equal(r.actual, undefined);
});

test("evaluator refuses an expression it cannot parse", () => {
  assert.throws(() => evaluateAssertion("coverage.pct ~~ 3", {}), /unsupported/i);
});

// ---------- 3b. カナリアの本体（取得は注入する） ----------

test("canary reports a failing claim with its actual value", async () => {
  const claims = parseRegistry(
    [
      `claims:`,
      `  - id: rolling`,
      `    surface: src/app/page.tsx`,
      `    quote: "probed on a rolling schedule"`,
      `    means: "not daily"`,
      `    check:`,
      `      url: https://example.test/state`,
      `      assert: "coverage7d.pct < 100"`,
      `    verified_at: 2026-09-04`,
      `  - id: unchecked`,
      `    surface: src/app/page.tsx`,
      `    quote: "never mixed"`,
      `    means: "editorial rule"`,
      `    check: null`,
      `    why_unverifiable: "policy commitment, not a measurement"`,
      `    verified_at: 2026-09-04`,
    ].join("\n"),
  ).claims;

  const report = await runClaimChecks(claims, async () => ({ coverage7d: { pct: 100 } }));
  assert.equal(report.ok, false);
  assert.equal(report.checked, 1); // check: null は評価対象に入れない
  assert.deepEqual(report.failed, [
    { id: "rolling", quote: "probed on a rolling schedule", expected: "coverage7d.pct < 100", actual: 100 },
  ]);
});

test("canary fetches each url once even when several claims share it", async () => {
  const claims = parseRegistry(
    [
      `claims:`,
      `  - id: a`,
      `    surface: src/app/page.tsx`,
      `    quote: "a"`,
      `    means: "m"`,
      `    check:`,
      `      url: https://example.test/state`,
      `      assert: "pct >= 0"`,
      `    verified_at: 2026-09-04`,
      `  - id: b`,
      `    surface: src/app/page.tsx`,
      `    quote: "b"`,
      `    means: "m"`,
      `    check:`,
      `      url: https://example.test/state`,
      `      assert: "pct <= 100"`,
      `    verified_at: 2026-09-04`,
    ].join("\n"),
  ).claims;

  let calls = 0;
  const report = await runClaimChecks(claims, async () => {
    calls++;
    return { pct: 68.8 };
  });
  assert.equal(calls, 1);
  assert.equal(report.ok, true);
  assert.equal(report.checked, 2);
});

test("canary turns a fetch failure into a failed claim, not a crash", async () => {
  const claims = parseRegistry(
    [
      `claims:`,
      `  - id: a`,
      `    surface: src/app/page.tsx`,
      `    quote: "a"`,
      `    means: "m"`,
      `    check:`,
      `      url: https://example.test/state`,
      `      assert: "pct >= 0"`,
      `    verified_at: 2026-09-04`,
    ].join("\n"),
  ).claims;

  const report = await runClaimChecks(claims, async () => {
    throw new Error("HTTP 503");
  });
  assert.equal(report.ok, false);
  assert.equal(report.failed[0].actual, "fetch failed: HTTP 503");
});

// ---------- 4. 登録簿そのものの規律 ----------

const registry = parseRegistry(read("docs/claims.yaml"));

test("a claim without a check must say why it is unverifiable", () => {
  for (const c of registry.claims) {
    if (c.check === null) {
      assert.ok(
        c.why_unverifiable && c.why_unverifiable.trim().length > 10,
        `${c.id}: check is null so why_unverifiable is required`,
      );
    } else {
      assert.ok(c.check.url.startsWith("https://"), `${c.id}: check.url must be https`);
      assert.ok(c.check.assert.trim().length > 0, `${c.id}: check.assert missing`);
      // 式が読めることは今ここで確かめる（本番に当てるのはカナリア）
      evaluateAssertion(c.check.assert, {});
    }
  }
});

test("every registered quote actually appears in the surface it names", () => {
  for (const c of registry.claims) {
    const src = read(c.surface);
    assert.ok(src.includes(c.quote), `${c.id}: quote not found in ${c.surface}: ${JSON.stringify(c.quote)}`);
  }
});

test("claim ids are unique and every claim states what it means", () => {
  const ids = registry.claims.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate claim id");
  for (const c of registry.claims) {
    assert.ok(c.means.trim().length > 5, `${c.id}: means is required`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(c.verified_at), `${c.id}: verified_at must be a date`);
  }
});

test("every allow_phrase carries a reason", () => {
  for (const a of registry.allow_phrases) {
    assert.ok(a.why.trim().length > 5, `allow_phrase ${JSON.stringify(a.phrase)} needs a reason`);
  }
});

// ---------- 5. 関門: 公開面の断定が登録済みか ----------

function publicSurfaces(): string[] {
  const out: string[] = [];
  const walk = (dir: string, pick: (p: string) => boolean) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, pick);
      else if (pick(p)) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, "src/app"), (p) => p.endsWith("/page.tsx"));
  walk(join(ROOT, "src/components/site"), (p) => p.endsWith(".tsx") || p.endsWith(".ts"));
  return out.sort();
}

test("no unregistered assertive claim ships on a public surface", () => {
  const quotes = registry.claims.map((c) => c.quote);
  const allowed = registry.allow_phrases.map((a) => a.phrase.toLowerCase());
  const orphans: string[] = [];

  for (const file of publicSurfaces()) {
    for (const a of extractAssertions(read(file), file)) {
      const low = a.text.toLowerCase();
      if (allowed.some((p) => low.includes(p))) continue;
      if (quotes.some((q) => a.text.includes(q))) continue;
      orphans.push(`${a.file}:${a.line} [${a.term}] ${a.text}`);
    }
  }

  assert.deepEqual(
    orphans,
    [],
    `Unregistered factual claims on public surfaces.\n` +
      `Register each in docs/claims.yaml (with a check, or check: null + why_unverifiable),\n` +
      `or add the wording to allow_phrases with a reason:\n  ` +
      orphans.join("\n  "),
  );
});

test("the registry cannot rot: every claim points at a surface that still exists", () => {
  const surfaces = new Set(publicSurfaces());
  for (const c of registry.claims) {
    assert.ok(surfaces.has(c.surface), `${c.id}: ${c.surface} is not a scanned public surface`);
  }
});

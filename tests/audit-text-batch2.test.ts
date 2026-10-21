// ============================================================
// 2026-10-21 監査 A-06 / A-07 / A-13 / A-14 の公開文を、戻すと赤になる形で固定する。
// DB も本番も叩かない。列挙の改名、枠の最新値、測定数のハードコードはしない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { L2_STATUSES } from "@/lib/decision/types";
import { evaluateAssertion } from "@/lib/claims/evaluate";
import { parseRegistry } from "@/lib/claims/yaml";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const flat = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const L2_MAP =
  /conform is written when the re-read L2 value \(l2_reading\) of the latest delivery is match\. mismatch is written when that re-read value is mismatch\. An older mismatch row with no recorded reason is re-read first, and a cut body reads not_checked\. In the other cases the decision word is not_checked when the current declaration names output \(a required key or an example property\), and undeclared when it does not\./;

test("A-06 keeps the decision enum and states when conform, mismatch, not_checked, and undeclared are written", () => {
  assert.deepEqual([...L2_STATUSES], ["conform", "mismatch", "undeclared", "not_checked"]);
  const openapi = read("docs/openapi.yaml");
  assert.match(
    openapi,
    /L2Status:\n {6}type: string\n {6}enum: \[conform, mismatch, undeclared, not_checked\]\n {6}description:/,
  );
  assert.match(flat(openapi), L2_MAP);
  assert.equal(openapi.includes("conform is match."), false);
  assert.equal(openapi.includes("undeclared is no_declaration"), false);
  const method = read("src/app/observatory/methodology/page.tsx");
  assert.match(method, /Ledger words and decision words\./);
  assert.match(flat(method), L2_MAP);
  assert.match(method, /https:\/\/api\.exa\.ai\/search/);
  assert.match(method, /example of where to read/);
  assert.equal(method.includes("is one such row"), false);
  assert.equal(method.includes("every API returns"), false);
  assert.equal(method.includes("rows that were never checked"), false);
  assert.equal(method.includes("undeclared is no_declaration"), false);
  const docs = read("src/app/docs/api/page.tsx");
  const quick = docs.slice(docs.indexOf("Should my agent pay this URL"), docs.indexOf("What happened when we actually paid"));
  assert.match(quick, /https:\/\/api\.exa\.ai\/search/);
  assert.match(flat(quick), L2_MAP);
  assert.match(quick, /read facts\.l2\.status on its decision/);
  assert.equal(quick.includes("Those names"), false);
  assert.equal(quick.includes("are the same row"), false);
  assert.equal(docs.includes("undeclared is no_declaration"), false);
  assert.equal(docs.includes("for those same rows"), false);
  const facts = read("src/lib/decision/seller-facts.ts");
  assert.match(facts, /if \(l2\.l2Schema === "match"\) l2Status = "conform"/);
  assert.match(facts, /else if \(l2\.l2Schema === "mismatch"\) l2Status = "mismatch"/);
  assert.equal(/l2Status = "no_declaration"/.test(facts), false);
  const home = read("src/app/page.tsx");
  assert.match(home, /output: "match \/ mismatch \/ no_declaration \/ not_checked"/);
  assert.match(flat(home), L2_MAP);
  assert.equal(home.includes("undeclared is no_declaration"), false);
  const llms = read("public/llms.txt");
  const full = read("src/app/llms-full.txt/route.ts");
  const llmsMap =
    /in the other cases the decision word is not_checked when the current declaration names output \(a required key or an example property\) and undeclared when it does not/;
  assert.match(llms, /Output: match \/ mismatch \/ no_declaration \/ not_checked/);
  assert.match(llms, llmsMap);
  assert.match(full, llmsMap);
});

test("A-07 gates a payment on getDecision and does not pay from the wallet score alone", () => {
  const docs = read("src/app/docs/api/page.tsx");
  const gate = docs.slice(docs.indexOf("SDK: gate a payment"), docs.indexOf("Middleware: gate an x402 endpoint"));
  assert.ok(gate.length > 100);
  assert.match(gate, /getDecision/);
  assert.match(gate, /resolve\("https:\/\/api\.exa\.ai\/search"\)/);
  assert.match(gate, /d\.recommendation === "ALLOW" && d\.degraded === false/);
  assert.equal(gate.includes("decision.allow"), false);
  assert.equal(gate.includes("hand off to AgentKit"), false);
  assert.match(gate, /This sample checks the payee wallet score\./);
  assert.match(gate, /Pay only when recommendation is ALLOW and\s+degraded is false\./);
  assert.match(gate, /console\.log\(scored\.allow, scored\.reasons\)/);
  const readme = read("packages/sdk/README.md");
  assert.match(readme, /getDecision and resolve are read-only/);
  assert.match(readme, /1 rate-limit unit per call/);
  assert.match(readme, /idempotencyKey/);
  assert.equal(readme.includes("getDecision needs a key"), false);
  assert.equal(readme.includes("`getDecision` needs a key"), false);
  assert.equal(readme.includes("Both are"), false);
  const signup = read("src/app/signup/page.tsx");
  assert.match(signup, /A free key reads a payee score\. A resource decision stays available without a key\./);
  assert.match(signup, /The observatory, a resource decision, and payee lookup/);
  assert.equal(signup.includes("Score a payee before you pay"), false);
  assert.match(signup, /baad6a17bfaf57b11c0c1d8cfb0b38d3d01f09736b7d8af2f92f0313ddef8bdb\/decision\?role=payer/);
  assert.match(signup, /Read a resource decision/);
  const sdk = read("packages/sdk/src/index.ts");
  assert.match(sdk, /return new SpendGuard\(policy, \(payee\) => this\.getPayeeScore\(payee\)\)/);
});

test("A-13 labels the census frame as a shape and attributes the two published totals", () => {
  const docs = read("src/app/docs/api/page.tsx");
  const census = docs.slice(docs.indexOf('path: "/api/v1/census/summary'), docs.indexOf('path: "/api/v1/observatory/corrections'));
  assert.ok(census.length > 100);
  assert.match(census, /Example of the shape only/);
  assert.match(census, /These counts are not a reading\. Fetch the URL and cite retrievedAt from that response\./);
  assert.match(census, /"settlements_raw": "<count>"/);
  assert.equal(census.includes("980"), false);
  assert.equal(census.includes("1219706"), false);
  const home = read("src/app/page.tsx");
  assert.match(home, /The gap between those two published totals is/);
  assert.match(home, /38\.5% of transactions and 88\.9% of volume/);
  assert.match(home, /not a rate printed in either document/);
  assert.match(
    home,
    /https:\/\/www\.visa\.com\/vcom-assets\/content\/dam\/visa\/reimagine-visa\/thought-leadership\/documents\/agentic-payments-report\.pdf/,
  );
  assert.equal(home.includes("38.5% of x402 transactions fall away"), false);
  assert.equal(home.includes("the raw totals appear in the report"), false);
  assert.equal(home.includes("The article states that"), false);
  const blog = read("src/lib/blog.ts");
  assert.match(blog, /the Visa and Artemis PDF reports raw x402 activity of \$135\.7M/);
  assert.match(blog, /the article reports wash-and-test-adjusted totals of/);
  assert.match(blog, /The gap between those two published totals is/);
  assert.equal(blog.includes("combined figure"), false);
  assert.equal(blog.includes("attributes 38.5%"), false);
});

test("A-14 fills cite from the response clock and marks the last history day unfinished", () => {
  const stateRoute = read("src/app/api/v1/observatory/state/route.ts");
  const historyRoute = read("src/app/api/v1/observatory/history/route.ts");
  assert.equal(stateRoute.includes("retrieved {retrievedAt}"), false);
  assert.equal(historyRoute.includes("retrieved {retrievedAt}"), false);
  assert.match(stateRoute, /retrieved \$\{retrievedAt\}/);
  assert.match(historyRoute, /retrieved \$\{retrievedAt\}/);
  assert.match(historyRoute, /license: "CC-BY-4\.0"/);
  assert.match(historyRoute, /licenseUrl: "https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/"/);
  assert.match(historyRoute, /history\?days=\$\{span\}/);
  const page = read("src/app/observatory/state/page.tsx");
  assert.match(page, /retrieved \$\{stats\.readAt\}/);
  assert.match(page, /retrievedAt: stats\.readAt/);
  assert.match(page, /This citation names the state aggregate/);
  assert.match(page, /chain table in section 2/);
  assert.match(page, /This chain table was read at \{chainReadAt\}/);
  assert.equal(page.includes("The figures in this drawing were read at"), false);
  assert.equal(page.includes("2026-10-20T13:44:29"), false);
  assert.equal(page.includes("2026-10-21T04:35"), false);
  assert.match(page, /history\?days=\$\{HISTORY_DAYS\}/);
  assert.match(page, /const HISTORY_DAYS = 60/);
  assert.match(page, /contentUrl: `\$\{SITE_URL\}\/api\/v1\/observatory\/history\?days=\$\{HISTORY_DAYS\}`/);
  assert.match(page, /The last point is not a finished day/);
  assert.match(page, /The last day is partial because the rollup clock is lastRollupAt/);
  const impact = read("src/app/impact/page.tsx");
  assert.match(impact, /page drew that share at \{drawnAt\}/);
  const home = read("src/app/page.tsx");
  assert.match(home, /page read \$\{coverage\.readAt\}/);
  assert.equal(read("src/lib/observatory/cached-reads.ts").includes("Recomputed at most daily"), false);
  assert.equal(stateRoute.includes("Recomputed at most daily"), false);
  const registry = parseRegistry(read("docs/claims.yaml"));
  const cite = registry.claims.find((c) => c.id === "method_every_number_moves_cite_with_retrieval_date");
  assert.ok(cite?.check);
  const filled =
    "KIZUNA Creation. vet402 observatory. Dataset, retrieved 2026-10-21T04:35:00.000Z. https://vet402.com/api/v1/observatory/state";
  assert.equal(evaluateAssertion(cite.check.assert, { cite: filled }).ok, true);
  assert.equal(
    evaluateAssertion(cite.check.assert, { cite: filled.replace("2026-10-21T04:35:00.000Z", "{retrievedAt}") }).ok,
    false,
  );
  assert.equal(
    evaluateAssertion(cite.check.assert, { cite: filled.replace("2026-10-21T04:35:00.000Z", "YYYY-MM-DD") }).ok,
    false,
  );
});

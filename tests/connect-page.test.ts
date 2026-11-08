// /connect: the entry that picks a side (buy, sell, both). Every snippet on the
// page must be real, so this test checks each one against the repo: package
// names against package.json / pyproject.toml, vet402.com paths against route
// and page files (rewrites in next.config.ts count).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_CHOICES, CONNECT_LEAD, CONNECT_SIGNUP_HREF } from "@/lib/connect/snippets";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const LEAD = "Put vet402 between AI agents. Both sides trade safely.";

const allSnippets = CONNECT_CHOICES.flatMap((c) => c.stacks);

test("the lead sentence is the product sentence, and the page renders it first", () => {
  assert.equal(CONNECT_LEAD, LEAD);
  const page = read("src/app/connect/page.tsx");
  assert.ok(page.includes("CONNECT_LEAD"), "page renders CONNECT_LEAD");
  const h1 = page.indexOf("<h1");
  assert.ok(h1 > 0 && page.indexOf("CONNECT_LEAD", h1) - h1 < 200, "CONNECT_LEAD sits in the h1");
});

test("three choices: I buy / I sell / Both", () => {
  assert.deepEqual(
    CONNECT_CHOICES.map((c) => c.label),
    ["I buy", "I sell", "Both"],
  );
  const chooser = read("src/components/connect/ConnectChooser.tsx");
  assert.ok(chooser.includes('role="tablist"'));
  assert.ok(chooser.includes('role="tab"'));
  assert.ok(chooser.includes('role="tabpanel"'));
});

test("each choice starts in three steps: key, stack, one line", () => {
  for (const c of CONNECT_CHOICES) {
    assert.equal(c.steps.length, 3, c.id);
    assert.match(c.steps[0], /API key/i, c.id);
    assert.match(c.steps[1], /stack/i, c.id);
    assert.match(c.steps[2], /copy/i, c.id);
  }
  assert.ok(["/signup", "/dashboard/keys"].includes(CONNECT_SIGNUP_HREF));
  assert.ok(existsSync(join(ROOT, "src/app", CONNECT_SIGNUP_HREF, "page.tsx")));
});

test("buy shows curl, TypeScript, Python, MCP and no-code; sell shows Express, Hono and Next.js", () => {
  const ids = (id: string) => CONNECT_CHOICES.find((c) => c.id === id)!.stacks.map((s) => s.stack);
  for (const s of ["curl", "TypeScript", "Python", "MCP", "No-code"]) assert.ok(ids("buy").includes(s), `buy ${s}`);
  for (const s of ["Express", "Hono", "Next.js"]) assert.ok(ids("sell").includes(s), `sell ${s}`);
  // Both does not repeat the snippets (are.na / Linear plainness): one sentence and a switch to each tab.
  const both = CONNECT_CHOICES.find((c) => c.id === "both")!;
  assert.deepEqual(both.stacks, []);
  assert.deepEqual(both.switchTo, ["buy", "sell"]);
  assert.equal(both.summary, "Use the I buy snippet on the way out and the I sell snippet on the way in.");
  assert.ok(both.note, "both carries the shared-record paragraph");
  assert.match(read("src/components/connect/ConnectChooser.tsx"), /c\.switchTo/);
});

function repoPackageNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const pj = join(ROOT, "packages", dir, "package.json");
    if (existsSync(pj)) names.add(JSON.parse(readFileSync(pj, "utf8")).name);
    const py = join(ROOT, "packages", dir, "pyproject.toml");
    if (existsSync(py)) {
      const m = readFileSync(py, "utf8").match(/^name\s*=\s*"([^"]+)"/m);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

test("every package a snippet names exists in this repo", () => {
  const names = repoPackageNames();
  for (const s of allSnippets) {
    for (const p of s.packages) assert.ok(names.has(p), `${s.stack}: package ${p} not in repo`);
    // The package must also be what the code imports or installs.
    for (const p of s.packages) {
      const python = p === "vet402-sdk";
      assert.ok(python ? s.code.includes("from vet402 import") : s.code.includes(p), `${s.stack}: code does not use ${p}`);
    }
  }
});

function routeExists(path: string): boolean {
  // The API base itself (an apiUrl value) is not a route. It counts when it is the SDK default.
  if (path === "/api/v1") return read("packages/sdk/src/index.ts").includes('DEFAULT_API_URL = "https://vet402.com/api/v1"');
  const rewrites = read("next.config.ts");
  const rw = rewrites.match(new RegExp(`source:\\s*"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*destination:\\s*"([^"]+)"`));
  const target = rw ? rw[1] : path;
  const segs = target.split("/").filter(Boolean);
  const walk = (dir: string, i: number): boolean => {
    if (i === segs.length) return existsSync(join(dir, "route.ts")) || existsSync(join(dir, "page.tsx"));
    if (!existsSync(dir)) return false;
    const exact = join(dir, segs[i]);
    if (existsSync(exact) && walk(exact, i + 1)) return true;
    return readdirSync(dir).some((d) => /^\[[^\]]+\]$/.test(d) && walk(join(dir, d), i + 1));
  };
  return walk(join(ROOT, "src/app"), 0);
}

test("every vet402.com URL in a snippet is a route or page in this repo", () => {
  let seen = 0;
  for (const s of allSnippets) {
    for (const m of s.code.matchAll(/https:\/\/vet402\.com(\/[A-Za-z0-9_\-/.{}$]*)/g)) {
      const path = m[1].replace(/\/$/, "").replace(/\{\{[^}]*\}\}|\$\{?[A-Za-z_]+\}?|\{[A-Za-z_]+\}|\$[A-Z_]+/g, "x");
      assert.ok(routeExists(path), `${s.stack}: ${m[0]} has no route`);
      seen++;
    }
  }
  assert.ok(seen >= 3, `expected several vet402.com URLs, saw ${seen}`);
});

// The version the repo publishes as vet402. 0.1.0 went to npm on 2026-11-08 10:03 JST (shasum
// 1f38f06ed81b69744aab8f53a4acf6c7effe1916, 10 files). 0.1.1 carries the README for the published name
// and is published from this commit. Bump this constant with the next publish.
const VET402_ON_NPM = "0.1.1";

test("the vet402 package in the repo is the version on npm", () => {
  assert.equal(JSON.parse(read("packages/vet402/package.json")).version, VET402_ON_NPM);
});

test("TypeScript buy snippet checks with vet402, then pays with payOrRefuse from vet402/buyer", () => {
  const ts = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks.find((s) => s.stack === "TypeScript")!;
  assert.match(ts.code, /import \{ check \} from "vet402";/);
  assert.match(ts.code, /import \{ payOrRefuse \} from "vet402\/buyer";/);
  assert.match(ts.code, /await check\(/);
  assert.match(ts.intro, /npm install vet402/);
  assert.deepEqual(ts.packages, ["vet402"]);
});

test("curl fills RESOURCE_ID from the first call, and no-code names n8n with an encoded q", () => {
  const buy = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks;
  const curl = buy.find((s) => s.stack === "curl")!;
  assert.match(curl.code, /RESOURCE_ID=\$\(curl/);
  const nocode = buy.find((s) => s.stack === "No-code")!;
  assert.match(nocode.intro, /n8n/);
  assert.doesNotMatch(nocode.intro, /Zapier/);
  assert.match(nocode.code, /encodeURIComponent/);
});

// The record page /observatory/e/[id] shows tx hashes (not purchase ids), and /resolve?q=<tx> serves
// the raw window, whose length comes from env (src/lib/settlements/rollup.ts RAW_RETENTION_DAYS, 30 in
// production on 2026-11-08) and is named in the answer, so the page names the field, not a number.
test("the shared-record paragraph says only what the record shows: tx hashes per URL page, a windowed tx lookup", () => {
  const note = CONNECT_CHOICES.find((c) => c.id === "both")!.note!;
  assert.doesNotMatch(note, /each purchase has/i);
  assert.doesNotMatch(note, /public page/i);
  assert.match(note, /transaction hash/);
  assert.doesNotMatch(note, /raw_window|raw window/);
  assert.doesNotMatch(note, /\b\d+ days\b/);
});

test("public English on /connect: no we, no dash, no semicolon in prose, no assertive words", () => {
  const prose = [CONNECT_LEAD, ...CONNECT_CHOICES.flatMap((c) => [c.summary, ...c.steps, c.note ?? "", ...c.stacks.map((s) => s.intro)])];
  for (const p of prose) {
    assert.doesNotMatch(p, /\b(we|our|us)\b/i, p);
    assert.doesNotMatch(p, /[\u2013\u2014;]/, p);
    assert.doesNotMatch(p, /\b(only|every|always|never|daily|all)\b/i, p);
  }
});

test("the MCP snippet uses the documented config shape and the hosted URL", () => {
  const mcp = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks.find((s) => s.stack === "MCP")!;
  assert.ok(mcp.code.includes('{"mcpServers":{"vet402":{"type":"http","url":"https://vet402.com/mcp"}}}'));
});

const CONNECT_UI = ["src/app/connect/page.tsx", "src/components/connect/ConnectChooser.tsx"];

test("plain black, white and grey: no accent colour classes on the page or chooser", () => {
  for (const f of CONNECT_UI) {
    const src = read(f);
    assert.doesNotMatch(src, /text-signal|bg-signal|text-brand|bg-brand|border-brand|text-(red|green|blue|amber|cyan|teal|emerald|sky|indigo)-/, f);
    // Shared pieces that carry the navy brand colour (CodeBlock is #233456, .sheet has a blue-grey rule).
    assert.doesNotMatch(src, /components\/docs\/CodeBlock|className="[^"]*\bsheet\b|\bdoc-title\b|\bsec-head\b/, f);
    // Tailwind palette classes other than neutral (and plain black / white) are colours.
    for (const m of src.matchAll(/\b(?:text|bg|border|ring|outline|fill|stroke|decoration)-([a-z]+)-\d{2,3}\b/g)) {
      assert.ok(m[1] === "neutral", `${f}: ${m[0]}`);
    }
  }
});

test("the connect stylesheet uses neutral greys (R = G = B) and no dark island", () => {
  const css = read("src/app/connect/connect.module.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const bad: string[] = [];
  for (const m of css.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => h.slice(i, i + 2).toLowerCase());
    if (!(r === g && g === b)) bad.push(m[0]);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    if (!(m[1] === m[2] && m[2] === m[3])) bad.push(m[0]);
  }
  assert.deepEqual(bad, []);
  assert.doesNotMatch(css, /hsl\(|oklch\(|color-mix\(/);
  // No dark island: the shared header and footer are light only.
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark/);
});

test("code samples keep a copy button with an accessible name and a polite live region", () => {
  const src = CONNECT_UI.map(read).join("\n") + (existsSync(join(ROOT, "src/components/connect/MonoCode.tsx")) ? read("src/components/connect/MonoCode.tsx") : "");
  assert.match(src, /aria-label="Copy code"/);
  assert.match(src, /aria-live="polite"/);
  assert.match(src, /navigator\.clipboard/);
});

test("/connect is in the sitemap, the header menu and the footer; the home page is untouched", () => {
  assert.ok(read("src/app/sitemap.ts").includes("${SITE_URL}/connect"));
  assert.ok(read("src/components/site/SiteHeader.tsx").includes('href: "/connect"'));
  assert.ok(read("src/components/site/SiteFooter.tsx").includes('href: "/connect"'));
  assert.ok(!read("src/app/page.tsx").includes("/connect"));
});

test("llms.txt points to /connect and to the vet402 package on npm", () => {
  const llms = read("public/llms.txt");
  const line = llms.split("\n").find((l) => l.includes("/connect"));
  assert.ok(line, "llms.txt has a /connect line");
  assert.match(line!, /vet402/);
  assert.doesNotMatch(line!, /not yet on npm/);
  assert.match(line!, /npm install vet402/);
});

// Copy and it runs: every name a TypeScript snippet imports exists in the build of the package it
// names (vet402, @vet402/sdk and @vet402/middleware, all on npm on 2026-11-08).
function distFileFor(spec: string): string {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = spec.slice(name.length) || ".";
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const pj = join(ROOT, "packages", dir, "package.json");
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (pkg.name !== name) continue;
    const entry = pkg.exports?.[sub === "." ? "." : `.${sub}`];
    const file = entry?.import ?? entry?.default;
    assert.ok(file, `${spec}: no export entry`);
    return join(ROOT, "packages", dir, file);
  }
  throw new Error(`${spec}: no package in repo`);
}

test("every TypeScript import in a /connect snippet names an export of a published package", async () => {
  let checked = 0;
  for (const s of allSnippets) {
    for (const m of s.code.matchAll(/import \{([^}]+)\} from "([^"]+)";/g)) {
      const names = m[1].split(",").map((n) => n.trim().replace(/^type\s+/, "")).filter(Boolean);
      assert.ok(/^(vet402(\/(buyer|seller))?|@vet402\/sdk|@vet402\/middleware(\/[a-z]+)?)$/.test(m[2]), `${s.stack}: ${m[2]} is not a published package`);
      const mod = (await import(distFileFor(m[2]))) as Record<string, unknown>;
      for (const n of names) assert.ok(n in mod, `${s.stack}: ${m[2]} has no export ${n}`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `expected the TypeScript, Express, Hono and Next.js imports, saw ${checked}`);
});

// Second independent review (2026-11-08): what a reader can run today, and what the page may claim.
test("Python uses plain HTTP on the two routes (vet402-sdk is not on PyPI and has no resolve or decision)", () => {
  const py = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks.find((s) => s.stack === "Python")!;
  assert.deepEqual(py.packages, []);
  assert.doesNotMatch(py.code, /from vet402 import|pip install -e/);
  assert.match(py.code, /import httpx/);
  assert.match(py.code, /https:\/\/vet402\.com\/api\/v1\/resolve/);
  assert.match(py.code, /\/decision/);
});

test("no snippet promises a coming package, and MCP needs no key to paste", () => {
  for (const s of allSnippets) assert.doesNotMatch(`${s.intro}\n${s.code}`, /\bis coming\b|\bcoming soon\b/i, s.stack);
  const mcp = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks.find((s) => s.stack === "MCP")!;
  assert.doesNotMatch(mcp.code, /VOUCH_API_KEY|your_key_here/);
  assert.match(mcp.intro, /Claude Desktop/);
});

test("values a reader must fill are named in the snippet, not left undefined", () => {
  const ts = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks.find((s) => s.stack === "TypeScript")!;
  assert.match(ts.code, /const payee = "/);
  assert.match(ts.code, /const account = /);
});

test("curl encodes q and says it needs jq", () => {
  const curl = CONNECT_CHOICES.find((c) => c.id === "buy")!.stacks.find((s) => s.stack === "curl")!;
  assert.match(curl.code, /--data-urlencode/);
  assert.match(curl.intro, /jq/);
});

test("the Both paragraph tells the two reads apart: URL record for the buyer, payer wallet score for the seller gate", () => {
  const note = CONNECT_CHOICES.find((c) => c.id === "both")!.note!;
  assert.doesNotMatch(note, /one public record|same record|same purchase/i);
  assert.match(note, /wallet/i);
  assert.match(note, /record/i);
});

test("step three says copy the snippet", () => {
  for (const c of CONNECT_CHOICES) assert.match(c.steps[2], /^Copy the snippet/, c.id);
});

test("scripts/release-packages.mjs publishes packages/vet402 with the other three", () => {
  const src = read("scripts/release-packages.mjs");
  const m = src.match(/const PACKAGES = \[([^\]]+)\]/);
  assert.ok(m);
  const list = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  for (const p of ["packages/sdk", "packages/mcp-server", "packages/middleware", "packages/vet402"]) assert.ok(list.includes(p), p);
  // Every listed package passes the script's manifest checks (private, scope, publishConfig).
  const unscopedOk = new Set([...(src.match(/const UNSCOPED_OK = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  for (const dir of list) {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    assert.ok(!pkg.private, `${dir} private`);
    assert.ok(pkg.name.startsWith("@") || unscopedOk.has(pkg.name), `${dir} unscoped ${pkg.name}`);
    assert.equal(pkg.publishConfig?.access, "public", `${dir} publishConfig`);
  }
  // Each listed package's tests run before the dry run.
  for (const dir of list) assert.ok(src.includes(`run("npm", ["test"], path.join(ROOT, "${dir}"))`), `${dir} tests are not run`);
});

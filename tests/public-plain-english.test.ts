// 公開英文の決まり（MCP と同型）。/legal/* は法務のため対象外（文言は別規則）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RULES: { name: string; re: RegExp }[] = [
  { name: "we/our/us", re: /\b(we|our|us)\b/i },
  { name: "semicolon", re: /;/ },
  { name: "dash", re: /[\u2013\u2014]| - / },
  { name: ", not X", re: /,\s*not\b/i },
  { name: "capital Vet402", re: /\bVet402\b/ },
  {
    name: "vet402 verb agreement",
    re: /\bvet402 (do|are|were|have|buy|pay|carry|hold|request|record)(?=[\s:;,.'"]|$)/i,
  },
];

export function violations(text: string): string[] {
  const t = text.trim();
  if (t === "—" || t === "–" || t === "-") return [];
  if (/^—\s*\(/.test(t)) return [];
  const normalized = text
    .replace(/&[a-z]+;/gi, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ");
  const out: string[] = [];
  for (const r of RULES) if (r.re.test(normalized)) out.push(r.name);
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const JSX_LINE =
  /className="(doc-|text-brand|fact-|sec-)|<\/?(p|td|th|li|h2|h3|caption|strong|em|dd|dt)\b|^\s+[&A-Za-z].*</;

function literalProse(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"\\]|\\.)*"/g)) {
    const s = m[0]
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ");
    if (
      s.length >= 8 &&
      /[a-zA-Z]/.test(s) &&
      /\s/.test(s) &&
      !s.includes("${") &&
      !s.startsWith("/api") &&
      !/^image\/|^text\/|^application\//.test(s)
    )
      out.push(s);
  }
  for (const m of line.matchAll(/'([^'\\]|\\.)*'/g)) {
    const s = m[0].slice(1, -1);
    if (s.length >= 8 && /[a-zA-Z]/.test(s) && /\s/.test(s) && !/^image\/|^text\//.test(s)) out.push(s);
  }
  const gt = line.match(/>\s*([^<{]+?)\s*</);
  if (gt) {
    const s = gt[1].replace(/\s+/g, " ").trim();
    if (s.length >= 4 && /[a-zA-Z]/.test(s)) out.push(s);
  }
  return out;
}

/** 公開面 TSX の JSX 行から英文リテラルを拾う（コメントと TS 本体は除く）。 */
export function extractPublicProse(src: string): string[] {
  const stripped = stripComments(src);
  const out: string[] = [];
  for (const line of stripped.split("\n")) {
    if (!JSX_LINE.test(line)) continue;
    if (/^\s*(import |export const metadata|const [A-Z_]+ =|type |interface |function [a-z])/.test(line)) continue;
    out.push(...literalProse(line));
  }
  return out;
}

function walkPages(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "legal" || name === "api" || name === "dashboard" || name === "ethonline") continue;
      walkPages(p, out);
      continue;
    }
    if (name === "page.tsx") out.push(p);
  }
}

function llmsProseLines(): string[] {
  const lines = [readFileSync("public/llms.txt", "utf8"), readFileSync("public/llms-full-prose.txt", "utf8")].join(
    "\n",
  ).split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("http://") || t.startsWith("https://")) continue;
    if (t === "# vet402" || t.startsWith("## ")) continue;
    if (/^[-*] `/.test(t)) continue;
    if (/^<!--/.test(t)) continue;
    // Long API inventory lines use semicolons and field names by design. Plain-English rules apply to narrative blocks.
    if (/^[-*] https:\/\/vet402\.com/.test(t)) continue;
    if (t.length > 600) continue;
    if (/[a-zA-Z]/.test(t) && /\s/.test(t) && t.length >= 20) out.push(t.replace(/^[-*]\s+/, ""));
  }
  return out;
}

const API_STRING_KEYS = ["note:", "disclaimer:", "description:", "cite:", "interpretation"] as const;

function extractApiPublicStrings(): { file: string; fragments: string[] }[] {
  const root = join(process.cwd(), "src/app/api/v1");
  const out: { file: string; fragments: string[] }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        const src = readFileSync(p, "utf8");
        const frags: string[] = [];
        for (const key of API_STRING_KEYS) {
          const re = new RegExp(`${key}\\s*:\\s*"([^"]{20,})"`, "g");
          for (const m of src.matchAll(re)) frags.push(m[1] ?? "");
          const reTpl = new RegExp(`${key}\\s*:\\s*\`([^\`]{20,})\``, "g");
          for (const m of src.matchAll(reTpl)) frags.push(m[1] ?? "");
        }
        if (frags.length) out.push({ file: p.replace(process.cwd() + "/", ""), fragments: frags });
      }
    }
  };
  walk(root);
  return out;
}

function assertNoViolations(fragments: readonly string[], label: string) {
  const problems: string[] = [];
  for (let i = 0; i < fragments.length; i++) {
    const v = violations(fragments[i]);
    if (v.length) problems.push(`${label} [#${i}] ${v.join(",")}: ${fragments[i].slice(0, 120)}`);
  }
  assert.deepEqual(problems, []);
}

test("規則そのものが当たる", () => {
  assert.ok(violations("We pay").includes("we/our/us"));
  assert.ok(violations("a; b").includes("semicolon"));
  assert.ok(violations("a \u2014 b").includes("dash"));
  assert.ok(violations("Vet402 record:").includes("capital Vet402"));
  assert.ok(violations("vet402 do not know").includes("vet402 verb agreement"));
  assert.deepEqual(violations("—"), []);
  assert.deepEqual(violations("— (denominator)"), []);
  assert.deepEqual(violations("vet402 buys under its own name"), []);
});

const appPages: string[] = [];
walkPages(join(process.cwd(), "src/app"), appPages);

const SITE_COMPONENTS = readdirSync("src/components/site", { recursive: true })
  .filter((f): f is string => typeof f === "string" && (f.endsWith(".tsx") || f.endsWith(".ts")))
  .map((f) => join("src/components/site", f));

for (const rel of [...appPages.map((p) => p.replace(process.cwd() + "/", "")), ...SITE_COMPONENTS].sort()) {
  const label = rel.replace(/^src\/(app|components\/site)\//, "").replace(/\/page\.tsx$/, "");
  test(`公開英文 ${label}`, () => {
    const src = readFileSync(rel, "utf8");
    const prose = extractPublicProse(src);
    if (prose.length === 0) return;
    assertNoViolations(prose, label);
  });
}

test("public/llms.txt and llms-full-prose prose lines follow public English rules", () => {
  assertNoViolations(llmsProseLines(), "llms index and llms-full-prose");
});

test("C-9/C-11: impact copy gate fails if a checked sentence reintroduces an em dash", () => {
  const line = readFileSync("src/app/impact/page.tsx", "utf8");
  assert.match(line, /published with the same weight\. Each endpoint/);
  assert.doesNotMatch(line, /published with the same weight — a receipt/);
});

for (const { file, fragments } of extractApiPublicStrings()) {
  test(`API public strings ${file}`, () => {
    assertNoViolations(fragments, file);
  });
}
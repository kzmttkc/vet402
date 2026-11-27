// FIX_R2 E-1〜E-5: 導線の食い違いと公開面の約束。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiDocsPageText } from "./lib/api-docs-source";

const ROOT = process.cwd();
const apiDocs = () => apiDocsPageText();
const file = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function firstInstallPackageNames(text: string): string[] {
  const m = text.match(/npm install vet402|npm i vet402|npm install @vet402\/[^\s]+|npm i @vet402\/[^\s]+/g);
  return m ?? [];
}

test("E-1: the first install line is npm install vet402 on home, docs Packages, connect, and llms.txt", () => {
  const surfaces = [
    { label: "home", text: file("src/components/site/home/paths.ts") },
    { label: "docs/api packages", text: apiDocs().split('id="packages"')[1]?.slice(0, 4000) ?? "" },
    { label: "connect TS intro", text: file("src/lib/connect/snippets.ts").match(/stack: "TypeScript"[\s\S]*?packages:/)?.[0] ?? "" },
    {
      label: "llms connect",
      text:
        (file("public/llms.txt") + file("public/llms-full-prose.txt"))
          .split("\n")
          .find((l) => l.includes("/connect")) ?? "",
    },
  ];
  for (const s of surfaces) {
    const installs = firstInstallPackageNames(s.text);
    assert.ok(installs.length > 0, `${s.label}: no install line`);
    assert.match(installs[0], /^npm (install|i) vet402$/, `${s.label}: first install is ${installs[0]}`);
  }
});

test("E-1: docs Packages explains that vet402 bundles @vet402/sdk and @vet402/middleware", () => {
  const sec = apiDocs().split('id="packages"')[1]?.slice(0, 2500) ?? "";
  assert.match(sec, /vet402.*@vet402\/sdk.*@vet402\/middleware/s);
});

test("E-2: docs MCP section leads with hosted vet402.com/mcp and documents 0.3.1 URL input", () => {
  const sec = apiDocs().split("Hosted MCP (reads records)")[1]?.slice(0, 4500) ?? "";
  const hosted = sec.indexOf("vet402.com/mcp");
  const npx = sec.indexOf("@vet402/mcp-server");
  assert.ok(hosted >= 0 && npx >= 0 && hosted < npx, "hosted MCP must appear before local npx package");
  assert.doesNotMatch(sec, /next release/i);
  assert.match(sec, /0\.3\.1/);
  assert.match(sec, /URL itself/);
  assert.doesNotMatch(sec, /Application&nbsp;Support/);
  assert.match(sec, /Application Support/);
});

test("E-3: check-a-seller and FAQ integration step lead with GET /api/v1/check", () => {
  assert.match(file("src/app/x402/check-a-seller/page.tsx"), /\/api\/v1\/check/);
  assert.match(file("src/components/site/faq-data.ts"), /GET \/api\/v1\/check\?url=/);
});

test("E-4: /connect states that check() JSON differs from GET /api/v1/check", () => {
  const note = file("src/lib/connect/snippets.ts").match(/CONNECT_CHECK_SHAPE_NOTE =\s*\n\s*"([^"]+)"/)?.[1] ?? "";
  assert.match(note, /GET \/api\/v1\/check/);
  assert.match(note, /reasonCodes/);
  assert.match(note, /reason_codes/);
  const snippets = file("src/lib/connect/snippets.ts");
  assert.match(snippets, /r\.recommendation/);
  assert.match(snippets, /reason_codes/);
  assert.match(file("src/app/connect/page.tsx"), /CONNECT_CHECK_SHAPE_NOTE/);
  assert.match(file("src/app/connect/page.tsx"), /\/api\/v1\/check/);
});

test("E-5: llms check cache text matches private, no-store and 60s server cache", () => {
  const llms = file("public/llms.txt") + file("public/llms-full-prose.txt");
  const line = llms.split("\n").find((l) => l.includes("GET /api/v1/check?url="));
  assert.ok(line);
  assert.match(line!, /private, no-store/);
  assert.match(line!, /60 seconds/);
  assert.match(line!, /x-vet402-retrieved-at/);
  assert.doesNotMatch(line!, /CDN may serve a response up to 60 seconds old, and up to five more minutes/);
  assert.match(file("src/lib/api/keyless-check-route.ts"), /private, no-store/);
  assert.match(file("src/lib/api/check-seller-cache.ts"), /CHECK_SELLER_CACHE_SECONDS = 60/);
});
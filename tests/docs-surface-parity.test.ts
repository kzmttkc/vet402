// ============================================================
// vet402 — 人間向け文書 ⇔ 実装 の突合 (2026-09-02 敵対的監査 P1-12 / P1-13 / §4)
//
// 監査で見つかった漂流はどれも「実装が増えたのに、その隣の文書が増えなかった」
// 形だった: SDK README の Methods に getDecision / resolve が無い、MCP README の
// Tools 表に check_resource_decision が無い、McpServer の version が package.json
// と違う、docs/api と llms.txt に §7.3 / §9.1 の 9 ルートが 0 件、.env.example に
// コードが読む変数が 30 個以上無い。どれも人が読み比べないと気付かない。
// ここでは実装側（AST / grep）を正典に取り、文書がそれを含むことを検査する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ------------------------------------------------------------------
// MCP server
// ------------------------------------------------------------------
function mcpToolNames(): string[] {
  const src = read("packages/mcp-server/src/index.ts");
  return [...src.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

test("McpServer の version 文字列が packages/mcp-server/package.json と一致する", () => {
  const pkg = JSON.parse(read("packages/mcp-server/package.json")) as { version: string };
  const src = read("packages/mcp-server/src/index.ts");
  const m = /new McpServer\(\{[^}]*version:\s*"([^"]+)"/s.exec(src);
  assert.ok(m, "new McpServer({ version }) が見つからない");
  assert.equal(m[1], pkg.version, "MCP クライアントに名乗る version が npm の版と違う");
});

test("MCP の全ツールが README / mcp-setup / ルート README の Tools 表に載っている", () => {
  const tools = mcpToolNames();
  assert.ok(tools.includes("check_resource_decision"), `AST がツールを拾えていない: ${tools.join(",")}`);
  for (const doc of ["packages/mcp-server/README.md", "docs/mcp-setup.md", "README.md"]) {
    const body = read(doc);
    for (const tool of tools) {
      assert.ok(body.includes(`\`${tool}\``), `${doc} に \`${tool}\` が無い`);
    }
  }
});

// ------------------------------------------------------------------
// TypeScript SDK
// ------------------------------------------------------------------
function vouchClientPublicMethods(): string[] {
  const sf = ts.createSourceFile(
    "index.ts",
    read("packages/sdk/src/index.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || st.name?.text !== "VouchClient") continue;
    for (const member of st.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const mods = ts.getModifiers(member) ?? [];
      if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) continue;
      if (member.name.text.startsWith("#")) continue;
      out.push(member.name.text);
    }
  }
  return out;
}

test("SDK README の Methods 行に VouchClient の公開メソッドが全部ある", () => {
  const methods = vouchClientPublicMethods().filter((m) => m !== "request");
  assert.ok(methods.includes("getDecision") && methods.includes("resolve"), `AST が読めていない: ${methods.join(",")}`);
  const readme = read("packages/sdk/README.md");
  for (const m of methods) {
    assert.ok(readme.includes(`\`${m}\``), `packages/sdk/README.md に \`${m}\` が無い`);
  }
});

test("SDK README のスコア例は固定値を約束しない（\"72 'ALLOW'\" は実測と一致しない）", () => {
  for (const doc of ["packages/sdk/README.md", "src/app/docs/api/page.tsx"]) {
    assert.ok(!/72 'ALLOW'/.test(read(doc)), `${doc} が 72 'ALLOW' を実測のように書いている`);
  }
});

test("Python SDK README が /decision 未対応を明記する", () => {
  const readme = read("packages/python-sdk/README.md");
  assert.ok(/\/decision/.test(readme), "packages/python-sdk/README.md が /decision に触れていない");
  assert.ok(/not (yet )?(supported|implemented|available)/i.test(readme), "未対応であることを書いていない");
});

// ------------------------------------------------------------------
// docs/api・llms.txt・llms-full・README の新規 9 ルート
// ------------------------------------------------------------------
const NEW_ROUTES = [
  "/api/v1/resolve",
  "/api/v1/resources/{resourceId}",
  "/api/v1/resources/{resourceId}/decision",
  "/api/v1/endpoints/{endpointId}",
  "/api/v1/endpoints/{endpointId}/payees",
  "/api/v1/payees/{address}/endpoints",
  "/api/v1/observatory/endpoints/{id}/facts",
  "/api/v1/census/summary",
  "/api/v1/observatory/corrections",
];

/** `{resourceId}` / `:resourceId` / `<resource_id>` / `{id}` のどの書き方でも同じ経路と見なす。 */
function routePattern(route: string): RegExp {
  const esc = route
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\\?\{[a-zA-Z_]+\\?\}/g, "(?:\\{[a-zA-Z_]+\\}|:[a-zA-Z_]+|<[a-zA-Z_]+>|[0-9a-f]{64}|[0-9a-f-]{36})");
  return new RegExp(esc + "(?![a-zA-Z_/])");
}

for (const doc of ["src/app/docs/api/page.tsx", "public/llms.txt", "src/app/llms-full.txt/route.ts", "README.md"]) {
  test(`${doc} に §7.3 / §9.1 の新規 9 ルートが全部ある`, () => {
    const body = read(doc);
    const missing = NEW_ROUTES.filter((r) => !routePattern(r).test(body));
    assert.deepEqual(missing, [], `${doc} に無いルート`);
  });
}

test("公開面が evidence[].source を説明している（源の名前を機械可読で出したことを人間の面にも書く）", () => {
  // WINDOW_PLAN §13 の 4 面パリティ #3: 公開フィールドを足したら docs にも 1 行。
  // 「どの台帳が答えたか」は判定そのものではないが、§3 の核（同じウォレットについて
  // 我々のエンジンと The Graph の subgraph が違うことを言う）を読者が確かめる入口なので、
  // 仕様書だけでなく人間が読む面にも出す。
  const page = read("src/app/docs/api/page.tsx");
  assert.ok(/evidence\[\]\.source|evidence\[\].*source/.test(page), "docs/api に evidence[].source の説明が無い");
  for (const word of ["vet402", "subgraph"]) {
    assert.ok(page.includes(word), `docs/api に源の名前 ${word} が無い`);
  }
  assert.ok(/subgraphId/.test(page), "docs/api が live の証跡（subgraphId）に触れていない");
});

test("docs/api の Quickstart は例の番号を正しく指し、npm スコープの正典を @vet402 と書く", () => {
  const page = read("src/app/docs/api/page.tsx");
  assert.ok(!page.includes("(example 3)"), "payee-score の例は 4 番目（example 3 は署名メッセージ）");
  assert.ok(/@vouchscore[^.]*(old|former|previous|legacy)/i.test(page), "@vouchscore が旧名であることを書いていない");
  assert.ok(!/@vouchscore<\/code> scope is the only one/.test(page), "@vouchscore が唯一のスコープ、は npm i @vet402/sdk と矛盾する");
});

// ------------------------------------------------------------------
// .env.example
// ------------------------------------------------------------------
/** 実行環境が注入する変数。運用者が .env に書くものではないので除外。 */
const PLATFORM_VARS = new Set(["NODE_ENV", "VERCEL", "VERCEL_ENV", "NEXT_RUNTIME", "TEST_DATABASE_URL"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(p);
  }
  return out;
}

test(".env.example がコードの読む環境変数を（値なしでも）全部名指ししている", () => {
  const vars = new Set<string>();
  for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "packages"))]) {
    for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) vars.add(m[1]);
  }
  assert.ok(vars.has("DATABASE_URL") && vars.has("WEBHOOK_SECRET_KEK"), "grep が変数を拾えていない");
  const example = read(".env.example");
  const documented = new Set(
    [...example.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]),
  );
  const missing = [...vars].filter((v) => !PLATFORM_VARS.has(v) && !documented.has(v)).sort();
  assert.deepEqual(missing, [], ".env.example に無い変数（`# NAME=` の形で 1 行説明つきで足す）");
});

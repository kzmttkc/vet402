// ============================================================
// /docs/mcp と /.well-known/mcp-registry-auth（2026-10-28・合格の表 #8–#9）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const REGISTRY_LINE = "v=MCPv1; k=ed25519; p=hUGz6AcJV3KCWiF3sj9ctUenPLwjIcT77DWRffHW6QU=";

test("#8 /docs/mcp のソースに各節 id と 3 つの tool 名がある", () => {
  const page = read("src/app/docs/mcp/page.tsx");
  for (const id of ["connect", "tools", "feed", "limits", "method", "privacy", "contact"]) {
    assert.ok(page.includes(`id="${id}"`), id);
  }
  for (const tool of ["check_x402_seller", "check_my_x402_endpoint", "find_x402_sellers"]) {
    assert.ok(page.includes(tool), tool);
  }
});

test("well-known ファイルと next.config の Content-Type", () => {
  const body = read("public/.well-known/mcp-registry-auth");
  assert.equal(body, `${REGISTRY_LINE}\n`);
  const cfg = read("next.config.ts");
  assert.ok(cfg.includes("/.well-known/mcp-registry-auth"));
  assert.ok(cfg.includes("text/plain"));
});

test("#8–#9 next start で /docs/mcp と registry-auth（build 済みのときだけ）", async (t) => {
  if (!existsSync(join(ROOT, ".next/BUILD_ID"))) {
    t.skip("run npm run build first");
    return;
  }
  const port = 3099;
  const secret = () => randomBytes(32).toString("hex");
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "production",
      APP_ENV: "production",
      DATABASE_URL: "postgres://localhost:5432/vet402_next_start_test",
      API_KEY_PEPPER: secret(),
      DASHBOARD_SESSION_SECRET: secret(),
      ADMIN_SECRET: secret(),
      CRON_SECRET: secret(),
      BASE_RPC_URL: "https://mainnet.base.org",
      PROXY_HEADER_SOURCE: "generic",
    },
    stdio: "ignore",
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(4000);
  try {
    const mcp = await fetch(`http://127.0.0.1:${port}/docs/mcp`);
    assert.equal(mcp.status, 200);
    const html = await mcp.text();
    assert.ok(html.includes('id="feed"'));
    assert.ok(html.includes("check_x402_seller"));

    const reg = await fetch(`http://127.0.0.1:${port}/.well-known/mcp-registry-auth`);
    assert.equal(reg.status, 200);
    assert.match(reg.headers.get("content-type") ?? "", /text\/plain/);
    assert.equal((await reg.text()).trim(), REGISTRY_LINE);
  } finally {
    child.kill("SIGTERM");
  }
});

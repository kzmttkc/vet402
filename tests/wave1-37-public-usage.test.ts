// ============================================================
// 第 1 波 3.7 自社以外の利用の公開（DB なし。npm test で走る）。
// 合格テストの文: ~/Takeshi_Automation/output/1110/factory/specs_3.7_3.8_9a_3.4.md の 3.7。
//
// [fix] はこの枝で足した OpenAPI の publicApiUsage が無いと落ちる行。[guard] は main で既にある退行防止。
// 集計の細部は tests/fair-review-1110.test.ts の公平-1 と tests/client-usage.test.ts が担う。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const FORBIDDEN_PUBLIC_ENGLISH = /\b(we|our|us)\b|—|–|;|Key-less|in-house|Append-only|third-party/i;
const FORBIDDEN_USAGE_FIELDS = /\b(userCount|uniqueUsers|uniqueOwners|downloadCount|npmDownloads)\b/i;

function openapiPublicApiUsageBlock(): string {
  const spec = readFileSync("docs/openapi.yaml", "utf8");
  const anchor = "                  publicApiUsage:";
  const start = spec.indexOf(anchor);
  assert.ok(start > 0, "openapi documents publicApiUsage on the state response");
  const end = spec.indexOf("                  operatorEndpointsExcluded:", start);
  assert.ok(end > start, "publicApiUsage block ends before operatorEndpointsExcluded");
  return spec.slice(start, end);
}

async function stateGet() {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  return { res, body: await res.json() };
}

// ------------------------------------------------------------------
// 3.7 OpenAPI（この枝の差分。main には publicApiUsage の記述が無い）
// ------------------------------------------------------------------

test("[fix] 3.7: openapi publicApiUsage description follows PUBLIC_API_USAGE_NOTE and the public English rules", async () => {
  const block = openapiPublicApiUsageBlock();
  const { PUBLIC_API_USAGE_NOTE } = await import("@/lib/api/client-usage-public");
  const desc = /description: >-\n([\s\S]*?)\n                    required:/.exec(block)?.[1] ?? "";
  const flat = desc.replace(/\n\s+/g, " ").trim();
  assert.doesNotMatch(flat, FORBIDDEN_PUBLIC_ENGLISH);
  assert.doesNotMatch(flat, /Since 2026-11-10/i);
  assert.match(flat, /without an API key/);
  assert.match(flat, /check counts GET \/api\/v1\/check, a separate entry point, so it is not part of decision/);
  assert.match(flat, /not added to l1\.attempts/);
  assert.match(flat, /may not send that User-Agent and then appear as other/);
  assert.equal(flat, PUBLIC_API_USAGE_NOTE, "openapi description matches the live note on the state GET");
});

test("[fix] 3.7: openapi lists decision, check, resolve, mcp, sdk and otherRoutes on each byDay row", () => {
  const block = openapiPublicApiUsageBlock();
  assert.match(block, /required: \[day, decision, check, resolve, mcp, sdk, otherRoutes\]/);
});

// ------------------------------------------------------------------
// 3.7-1 系列は試行と足せない（main に既にある。退行防止）
// ------------------------------------------------------------------

test("[guard] 3.7-1: the state GET puts call counts beside l1, not inside it, and the note refuses l1.attempts", async () => {
  const { res, body } = await stateGet();
  assert.equal(res.status, 200);
  assert.ok(body.l1 && typeof body.l1.attempts === "number");
  assert.ok(body.publicApiUsage && typeof body.publicApiUsage === "object");
  assert.equal("publicApiUsage" in body.l1, false);
  assert.equal(typeof body.publicApiUsage.retrievedAt, "string");
  assert.equal(typeof body.publicApiUsage.note, "string");
  assert.match(body.publicApiUsage.note, /not added to l1\.attempts/);
  assert.doesNotMatch(body.publicApiUsage.note, /l1\.attempts\s*\+|plus l1\.attempts/i);
  const raw = JSON.stringify(body.publicApiUsage).toLowerCase();
  assert.ok(!raw.includes('"usercount"'), "no user count on the usage series");
  assert.ok(!raw.includes('"unique"'), "no unique-user estimate on the usage series");
  assert.doesNotMatch(body.publicApiUsage.note, FORBIDDEN_PUBLIC_ENGLISH);
});

test("[guard] 3.7-1: each byDay row names decision, check, resolve, mcp, sdk and otherRoutes only", async () => {
  const { PUBLIC_API_USAGE_NOTE, emptyPublicUsageDay } = await import("@/lib/api/client-usage-public");
  assert.doesNotMatch(PUBLIC_API_USAGE_NOTE, FORBIDDEN_PUBLIC_ENGLISH);
  const slot = emptyPublicUsageDay("2026-11-01");
  assert.deepEqual(Object.keys(slot).sort(), ["check", "day", "decision", "mcp", "otherRoutes", "resolve", "sdk"]);
});

// ------------------------------------------------------------------
// 3.7-3 SDK と MCP の名乗り（main に既にある。退行防止）
// ------------------------------------------------------------------

test("[guard] 3.7-3: vet402-sdk and vet402-mcp name themselves on vet402 API calls only", async () => {
  const { clientIdentityHeaders, SDK_USER_AGENT } = await import("../packages/sdk/src/user-agent.js");
  const { MCP_USER_AGENT } = await import("../packages/mcp-server/src/version.js");
  assert.match(SDK_USER_AGENT, /^vet402-sdk\/\d+\.\d+\.\d+$/);
  assert.match(MCP_USER_AGENT, /^vet402-mcp\/\d+\.\d+\.\d+$/);
  assert.deepEqual(clientIdentityHeaders(), { "User-Agent": SDK_USER_AGENT });
  const { clientUsageLabel } = await import("@/lib/api/client-usage");
  assert.equal(clientUsageLabel(SDK_USER_AGENT), SDK_USER_AGENT);
  assert.equal(clientUsageLabel(MCP_USER_AGENT), MCP_USER_AGENT);
  assert.equal(clientUsageLabel("node"), "other");
});

// ------------------------------------------------------------------
// 3.7-5 ダウンロード数を利用件数の目標にしない
// ------------------------------------------------------------------

test("[guard] 3.7-5: publicApiUsage never copies adoption.sdkDownloads or npm figures", async () => {
  const { res, body } = await stateGet();
  assert.equal(res.status, 200);
  const usageJson = JSON.stringify(body.publicApiUsage);
  assert.ok(!usageJson.includes("sdkDownloads"), "downloads stay in adoption, not usage counts");
  assert.doesNotMatch(usageJson, FORBIDDEN_USAGE_FIELDS);
  if (body.adoption?.sdkDownloads) {
    assert.ok(!usageJson.includes(String(body.adoption.sdkDownloads.downloads)), "npm download count is not mirrored");
  }
});

// ------------------------------------------------------------------
// 3.7-6 retrievedAt、ライセンス、cite
// ------------------------------------------------------------------

test("[guard] 3.7-6: state keeps CC BY 4.0, KIZUNA cite, and publicApiUsage keeps retrievedAt", async () => {
  const { res, body } = await stateGet();
  assert.equal(res.status, 200);
  assert.equal(body.license, "CC-BY-4.0");
  assert.match(body.cite, /KIZUNA Creation/);
  assert.match(body.publicApiUsage.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
});

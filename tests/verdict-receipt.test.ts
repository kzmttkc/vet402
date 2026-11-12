// 判定ごとの EIP-191 レシート（課題 B3）。
// 鍵が無い応答は今の本文のまま。改ざんした receipt は POST /api/v1/receipts/verify で落ちる。
// 署名鍵は試験の中だけで置く。よく知られた Anvil の開発用鍵であり、本番の鍵ではない。
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { handleCheck } from "@/lib/api/check-handler";
import { checkSeller, type McpDeps } from "@/lib/mcp/tools";
import { __setDbForTests } from "@/lib/db/client";
import { ipRateLimits } from "@/lib/db/schema";
import { decisionCache } from "@/lib/decision/cache";
import { GET as decisionGET } from "@/app/api/v1/resources/[resourceId]/decision/route";
import { POST as verifyPOST } from "@/app/api/v1/receipts/verify/route";
import { checkCanonicalInput, decisionCanonicalInput, verdictReceiptMessage } from "@/lib/receipts/verdict-receipt";

const SIGNER_ENV = "VET402_RECEIPT_SIGNER_KEY";
const TEST_SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NOW = new Date("2026-11-12T00:00:00.000Z");
const RID = "a".repeat(64);
const OBS_ID = "11111111-2222-4333-8444-555555555555";
const SCORED_AT = "2026-11-12T00:00:00.000Z";

const SEEDED = {
  recommendation: "ALLOW",
  scoredAt: SCORED_AT,
  reason_codes: ["l0_pass"],
  facts: { l0: { status: "pass" } },
  evidence: [] as unknown[],
};

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PROXY_HEADER_SOURCE", "DECISION_KEYLESS_READ", SIGNER_ENV];

function fakeDeps(): McpDeps {
  return {
    now: () => NOW,
    resolve: (async () => ({ resource: null, endpoints: [] })) as unknown as McpDeps["resolve"],
    decide: (async () => null) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
  } as unknown as McpDeps;
}

function chain(rows: unknown[]): unknown {
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown[]) => void) => resolve(rows);
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

type Bucket = { count: number; resetAt: Date };

function fakeDb() {
  const buckets = new Map<string, Bucket>();
  return {
    execute: async (q: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q.queryChunks ?? q);
      if (text.includes("ip_rate_limits") && text.includes("GREATEST")) {
        const key = /"(decision:[^"]+)"/.exec(text)?.[1];
        const cur = key ? buckets.get(key) : undefined;
        if (cur && cur.resetAt.getTime() > Date.now() && cur.count > 0) cur.count -= 1;
        return { rows: [] };
      }
      if (text.includes("x402_endpoints")) {
        if (!text.includes(RID)) return { rows: [] };
        return {
          rows: [
            {
              observatory_id: OBS_ID,
              endpoint_hash: "c".repeat(64),
              resource_id: RID,
              canonical_url: "https://example.com/x402/thing",
              method: "GET",
              payee_id: null,
              status: "active",
              first_seen: null,
              last_seen: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    select: () => chain([]),
    update: () => chain([]),
    insert: (table: unknown) => ({
      values: (v: { bucketKey: string; count: number; resetAt: Date }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            assert.equal(table, ipRateLimits);
            const now = Date.now();
            const cur = buckets.get(v.bucketKey);
            const next: Bucket =
              !cur || cur.resetAt.getTime() <= now ? { count: 1, resetAt: v.resetAt } : { count: cur.count + 1, resetAt: cur.resetAt };
            buckets.set(v.bucketKey, next);
            return [{ bucketKey: v.bucketKey, count: next.count, resetAt: next.resetAt }];
          },
        }),
      }),
    }),
  };
}

function checkReq(qs: string): Request {
  return new Request(`https://vet402.com/api/v1/check${qs}`);
}

function decisionReq() {
  return new NextRequest(`http://localhost/api/v1/resources/${RID}/decision?role=payer`, {
    headers: { "x-forwarded-for": "203.0.113.40" },
  });
}

function verifyReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/receipts/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.41" },
    body: JSON.stringify(body),
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("verdict receipt", { concurrency: false }, () => {
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.PROXY_HEADER_SOURCE = "generic";
  delete process.env.DECISION_KEYLESS_READ;
  delete process.env[SIGNER_ENV];
  __setDbForTests(fakeDb());
  decisionCache.clear();
  decisionCache.set(`${OBS_ID}|payer|-|0|0|0`, { result: SEEDED as never, expiresAt: Date.now() + 60_000 });
});

afterEach(() => {
  __setDbForTests(null);
  decisionCache.clear();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("改ざんした receipt は verify で落ち、改ざん前は通る", async () => {
  const POST = verifyPOST;
  process.env[SIGNER_ENV] = TEST_SIGNER_KEY;
  const deps = fakeDeps();
  const res = await handleCheck(checkReq("?url=https%3A%2F%2Fapi.example.org%2Fx"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.receipt.verdict, "NONE");
  assert.equal(body.receipt.as_of, NOW.toISOString());
  assert.equal(typeof body.receipt.input_sha256, "string");
  assert.equal(typeof body.receipt.signer, "string");
  assert.equal(typeof body.receipt.signature, "string");
  assert.equal(body.receipt.input_sha256, sha256(checkCanonicalInput("https://api.example.org/x", null)));

  const ok = await POST(verifyReq(body.receipt));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  const tampered = { ...body.receipt, verdict: "ALLOW" };
  const bad = await POST(verifyReq(tampered));
  assert.equal(bad.status, 200);
  assert.deepEqual(await bad.json(), { ok: false, error: "invalid_signature" });

  const flipped = body.receipt.signature.slice(0, -1) + (body.receipt.signature.endsWith("a") ? "b" : "a");
  const badSig = await POST(verifyReq({ ...body.receipt, signature: flipped }));
  assert.equal(badSig.status, 200);
  assert.equal((await badSig.json()).ok, false);

  const decision = await decisionGET(decisionReq(), { params: Promise.resolve({ resourceId: RID }) });
  assert.equal(decision.status, 200);
  const decisionBody = await decision.json();
  assert.equal(decisionBody.receipt.verdict, "ALLOW");
  assert.equal(decisionBody.receipt.as_of, SCORED_AT);
  assert.equal(
    decisionBody.receipt.input_sha256,
    sha256(decisionCanonicalInput({ resourceId: RID, role: "payer", payer: null, callerDialect: null, allowWithoutL1: false })),
  );
  const decisionOk = await POST(verifyReq(decisionBody.receipt));
  assert.deepEqual(await decisionOk.json(), { ok: true });
  const decisionBad = await POST(verifyReq({ ...decisionBody.receipt, as_of: "2026-11-12T00:00:01.000Z" }));
  assert.deepEqual(await decisionBad.json(), { ok: false, error: "invalid_signature" });
});

test("鍵が無いとき check と decision の応答は receipt を足さず今のまま", async () => {
  delete process.env[SIGNER_ENV];
  const deps = fakeDeps();
  const qs = "?url=https%3A%2F%2Fapi.example.org%2Fx";
  const res = await handleCheck(checkReq(qs), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Object.hasOwn(body, "receipt"), false);
  const mcp = await checkSeller(deps, { url: "https://api.example.org/x" });
  assert.deepEqual(body, JSON.parse(JSON.stringify(mcp)));

  const decision = await decisionGET(decisionReq(), { params: Promise.resolve({ resourceId: RID }) });
  assert.equal(decision.status, 200);
  const decisionBody = await decision.json();
  assert.equal(Object.hasOwn(decisionBody, "receipt"), false);
  assert.deepEqual(decisionBody, SEEDED);

  process.env[SIGNER_ENV] = TEST_SIGNER_KEY;
  const badUrl = await handleCheck(checkReq("?url=http%3A%2F%2Fapi.example.org%2Fx"), deps);
  assert.equal(badUrl.status, 400);
  assert.equal(Object.hasOwn(await badUrl.json(), "receipt"), false);
});

test("レシートの節は検証の方法を書き、we とセミコロンとダッシュを使わない", () => {
  const doc = readFileSync("docs/verdict-receipt.md", "utf8");
  const sample = verdictReceiptMessage({
    input_sha256: "a".repeat(64),
    verdict: "ALLOW",
    as_of: "2026-11-12T00:00:00.000Z",
  }).split("\n");
  assert.ok(doc.includes(sample[0]!), sample[0]);
  assert.ok(doc.includes(sample[sample.length - 1]!), sample[sample.length - 1]);
  assert.match(doc, /vet402\.com verdict receipt/);
  assert.match(doc, /domain: vet402\.com/);
  assert.match(doc, /input sha256:/);
  assert.match(doc, /This signature attests the verdict above for the input with this sha256\. It moves no funds\./);
  assert.match(doc, /POST \/api\/v1\/receipts\/verify/);
  assert.match(doc, /VET402_RECEIPT_SIGNER_KEY/);
  assert.doesNotMatch(doc, /\b(we|our|us)\b/i);
  assert.equal(doc.includes(";"), false);
  assert.equal(/[—–]/.test(doc), false);

  const page = readFileSync("src/app/docs/api/page.tsx", "utf8");
  assert.ok(page.includes('path: "/api/v1/receipts/verify"'));
  const openapi = readFileSync("docs/openapi.yaml", "utf8");
  assert.ok(openapi.includes("/api/v1/receipts/verify:"));
  const exportCsv = readFileSync("src/app/api/v1/observatory/export.csv/route.ts", "utf8");
  assert.equal(exportCsv.includes("receipt"), false);
});
});

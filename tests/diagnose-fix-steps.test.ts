import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { handleDiagnose } from "@/lib/api/diagnose-handler";
import {
  FIX_STEPS,
  missingFixSteps,
  howToFix,
  retestFor,
  UNSAFE_TARGET_FIX,
} from "@/lib/diagnose/fix-steps";
import { CHECK_IDS, publicEnglishFaults } from "@/lib/diagnose/copy";
import { judgeChallenge, type DiagnoseBody, type JudgeInput } from "@/lib/diagnose/judge";

const NOW = new Date("2026-11-12T00:00:00.000Z");
const SELLER = "https://seller.example/paid";
const PAY = "0x1111111111111111111111111111111111111111";

function challenge(accepts: unknown[]): string {
  return JSON.stringify({ x402Version: 2, resource: { url: SELLER }, accepts });
}

function accept(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, ...over };
}

function judge(body: string, over: Partial<JudgeInput> = {}): DiagnoseBody {
  return judgeChallenge({
    requestedUrl: SELLER,
    method: "GET",
    httpStatus: 402,
    headers: new Headers(),
    bodyText: body,
    now: NOW,
    catalog: { listed: false, check_url: null },
    ...over,
  });
}

function singleSentence(text: string): void {
  assert.ok(text.endsWith("."), text);
  assert.ok(!text.includes(". "), text);
  assert.ok(!text.includes("? "), text);
  assert.ok(!text.includes("! "), text);
}

test("missingFixSteps is empty for FIX_STEPS", () => {
  assert.deepEqual(missingFixSteps(), []);
});

test("missingFixSteps reports a gap when one step is removed", () => {
  const copy = structuredClone(FIX_STEPS);
  delete copy.returns_402.fail;
  const missing = missingFixSteps(copy);
  assert.ok(missing.includes("returns_402:fail"));
});

test("every fix step is one English sentence and passes publicEnglishFaults", () => {
  for (const id of CHECK_IDS) {
    for (const status of ["fail", "warn", "info"] as const) {
      const text = FIX_STEPS[id][status];
      if (!text) continue;
      singleSentence(text);
      assert.deepEqual(publicEnglishFaults(text), [], `${id}:${status}`);
    }
  }
  singleSentence(UNSAFE_TARGET_FIX);
  assert.deepEqual(publicEnglishFaults(UNSAFE_TARGET_FIX), []);
});

test("judgeChallenge attaches how_to_fix and retest", () => {
  const allow = judge(challenge([accept()]));
  assert.equal(allow.verdict, "ALLOW");
  assert.equal(allow.retest, null);
  for (const c of allow.checks) assert.equal(c.how_to_fix, null);

  const block = judge(challenge([accept()]), { httpStatus: 200 });
  assert.equal(block.verdict, "BLOCK");
  assert.notEqual(block.retest, null);
  assert.ok(block.retest!.rerun_url.includes(encodeURIComponent(SELLER)));
  assert.ok(block.retest!.request_url.startsWith("https://github.com/vet402/vet402/issues/new"));
  const failCheck = block.checks.find((c) => c.status === "fail");
  assert.ok(failCheck);
  assert.equal(failCheck!.how_to_fix, howToFix(failCheck!.id, "fail"));

  const warn = judge(challenge([accept({ network: "base" })]));
  assert.equal(warn.verdict, "WARN");
  assert.notEqual(warn.retest, null);
});

test("handleDiagnose unsafe_target includes how_to_fix", async () => {
  const res = await handleDiagnose(
    new Request(`https://vet402.com/api/v1/diagnose?url=${encodeURIComponent("https://127.0.0.1/latest")}`),
    {
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      },
      now: () => NOW,
      dbPresent: false,
    },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; how_to_fix?: string };
  assert.equal(body.error, "unsafe_target");
  assert.equal(body.how_to_fix, UNSAFE_TARGET_FIX);
});

test("diagnose route stays GET only and no new write routes under api", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/v1/diagnose/route.ts"), "utf8");
  assert.ok(route.includes("export async function GET"));
  assert.ok(!route.match(/export async function POST/));

  const apiRoot = join(process.cwd(), "src/app/api");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name === "route.ts" && p.includes("diagnose")) {
        const src = readFileSync(p, "utf8");
        if (/export async function POST/.test(src)) hits.push(p);
      }
    }
  };
  walk(apiRoot);
  assert.deepEqual(hits, []);
});

test("retestFor encodes method", () => {
  const r = retestFor("https://a.example/x", "POST");
  assert.ok(r.rerun_url.endsWith("&method=POST") || r.rerun_url.includes("method=POST"));
});
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nearAiDayPayload, nearAiDayRootHash } from "@/lib/nearai/anchors";
import { canonicalizeJson, replayRtmr3 } from "@/lib/nearai/crypto";
import { decidePublication } from "@/lib/nearai/publication";
import { countStrictUpToDateMachines } from "@/lib/nearai/read-public";
import type { NearAiProbeOutput } from "@/lib/nearai/probe-types";
import { nextNearAiRunUtc, readNearAiObservatory } from "@/lib/nearai/observatory-response";
import { MemoryNearAiStore, setNearAiStoreForTests, type NearAiStore } from "@/lib/nearai/store";
import { verifyNearReport } from "@/lib/nearai/verify-report";
import { verifyNvidiaGpu } from "@/lib/nearai/verify-gpu";
import { checkNearAiAttestation } from "@/lib/mcp/nearai";
import { NextRequest } from "next/server";

const FIXTURE = join(process.cwd(), "tests/fixtures/nearai-sample-output.json");

function loadSample(): NearAiProbeOutput {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as NearAiProbeOutput;
}

function tamperedSample(): NearAiProbeOutput {
  const s = structuredClone(loadSample());
  const m = s.nearaiModelsProbed[0]!;
  m.candidates![0]!.failureClass = "nonce_or_signer_mismatch";
  m.candidates![0]!.intelOk = false;
  m.candidates![0]!.strictUpToDate = false;
  return s;
}

test("11/22 sample: 12 models and 17 UpToDate GPU-pass instances", () => {
  const sample = loadSample();
  assert.equal(sample.catalogSummary.nearaiModels.length, 12);
  assert.equal(sample.nearaiModelsProbed.length, 12);
  assert.equal(countStrictUpToDateMachines(sample), 17);
  for (const m of sample.nearaiModelsProbed) {
    assert.equal(m.allPassCrypto, true);
    assert.equal(m.allStrictUpToDate, true);
  }
});

test("fixture ingest: public snapshot lists 12 models as pass", async () => {
  const mem = new MemoryNearAiStore();
  mem.reset();
  setNearAiStoreForTests(mem);
  await mem.ingestProbeOutput(loadSample(), "2026-11-22");
  const snap = await mem.getLatestPublicSnapshot();
  assert.ok(snap);
  assert.equal(snap!.models.length, 12);
  assert.ok(snap!.models.every((m) => m.status === "pass" && m.gpuPass));
});

test("PCCS down → unverified (verifyNearReport)", async () => {
  const nonceHex = "11".repeat(32);
  const report = {
    intel_quote: "00",
    signing_algo: "ecdsa",
    signing_address: "0x" + "22".repeat(20),
    request_nonce: nonceHex,
    event_log: "[]",
    info: { tcb_info: JSON.stringify({ app_compose: "{}" }) },
  };
  const res = await verifyNearReport(report, nonceHex, {
    verifyQvl: async () => {
      throw new Error("pccs down");
    },
  });
  assert.equal(res.failureClass, "pccs_unavailable");
  const pub = decidePublication(
    {
      targetKey: "m",
      tcbStatus: "unknown",
      advisoryIds: [],
      gpuPass: false,
      rawFailureClass: "pccs_unavailable",
      cryptoOk: false,
      strictUpToDate: false,
    },
    null,
    false,
  );
  assert.equal(pub.show && pub.status, "unverified");
});

test("NRAS down → unverified", async () => {
  const nonce = "aa".repeat(32);
  const res = await verifyNvidiaGpu(JSON.stringify({ nonce }), nonce, async () => new Response("{}", { status: 503 }));
  assert.equal(res.failureClass, "nras_unavailable");
});

test("one mismatch stays pending_reverify", async () => {
  const mem = new MemoryNearAiStore();
  mem.reset();
  await mem.ingestProbeOutput(tamperedSample(), "2026-11-22");
  const snap = await mem.getLatestPublicSnapshot();
  const row = snap!.models.find((m) => m.modelId === tamperedSample().nearaiModelsProbed[0]!.modelId);
  assert.equal(row?.status, "pending_reverify");
});

test("two consecutive serious mismatches → held (hidden from public)", async () => {
  const mem = new MemoryNearAiStore();
  mem.reset();
  await mem.ingestProbeOutput(tamperedSample(), "2026-11-22");
  await mem.ingestProbeOutput(tamperedSample(), "2026-11-23");
  const snap = await mem.getLatestPublicSnapshot();
  const id = tamperedSample().nearaiModelsProbed[0]!.modelId;
  assert.ok(!snap!.models.some((m) => m.modelId === id));
});

test("nearAi day roots independent from L1 anchors module", async () => {
  const anchorsSrc = readFileSync(join(process.cwd(), "src/lib/observatory/anchors.ts"), "utf8");
  assert.ok(!anchorsSrc.includes("nearai"));
  const day = "2026-11-22";
  const rows = [{ id: 1, modelId: "a/b", tcbStatus: "UpToDate", publicStatus: "pass", gpuPass: true, advisoryIds: [], candidateCount: 1, probedAt: "2026-11-22T12:00:00.000Z" }];
  const a = nearAiDayPayload(day, rows);
  const b = nearAiDayPayload(day, rows);
  assert.equal(a, b);
  assert.equal(nearAiDayRootHash("genesis", day, rows).length, 64);
});

test("crypto helpers: canonicalizeJson and replayRtmr3", () => {
  assert.equal(canonicalizeJson({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
  const events = [{ imr: 3, event_type: 134217729, event: "app-id", event_payload: "abcd" }];
  const et = Buffer.alloc(4);
  et.writeUInt32LE(134217729);
  const d = createHash("sha384")
    .update(et)
    .update(":")
    .update("app-id")
    .update(":")
    .update(Buffer.from("abcd", "hex"))
    .digest();
  const expected = createHash("sha384").update(Buffer.alloc(48)).update(d).digest();
  assert.deepEqual(replayRtmr3(JSON.stringify(events)), expected);
});

test("MCP check_nearai_attestation returns latest snapshot", async () => {
  const mem = new MemoryNearAiStore();
  mem.reset();
  setNearAiStoreForTests(mem);
  await mem.ingestProbeOutput(loadSample(), "2026-11-22");
  const out = await checkNearAiAttestation();
  assert.notEqual(out, "unavailable");
  if (out !== "unavailable" && "schemaVersion" in out) assert.equal(out.models.length, 12);
  setNearAiStoreForTests(null);
});

test("nextNearAiRunUtc: before 09:00 UTC is same day; after is next day", () => {
  assert.equal(nextNearAiRunUtc(new Date("2026-11-23T08:59:59.999Z")), "2026-11-23T09:00:00.000Z");
  assert.equal(nextNearAiRunUtc(new Date("2026-11-23T09:00:00.000Z")), "2026-11-24T09:00:00.000Z");
});

test("no run yet: readNearAiObservatory and GET /nearai return 200 no_run_yet", async () => {
  const mem = new MemoryNearAiStore();
  mem.reset();
  setNearAiStoreForTests(mem);
  const body = await readNearAiObservatory();
  assert.equal("status" in body && body.status, "no_run_yet");
  if (!("status" in body)) throw new Error("expected no_run_yet");
  assert.equal(body.models.length, 0);
  assert.match(body.next_run_utc, /^\d{4}-\d{2}-\d{2}T09:00:00\.000Z$/);
  const out = await checkNearAiAttestation();
  assert.notEqual(out, "unavailable");
  assert.equal((out as { status: string }).status, "no_run_yet");
  const { GET } = await import("@/app/api/v1/observatory/nearai/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/nearai"));
  assert.equal(res.status, 200);
  const json = (await res.json()) as { status: string; next_run_utc: string; models: unknown[] };
  assert.equal(json.status, "no_run_yet");
  assert.match(json.next_run_utc, /T09:00:00\.000Z$/);
  assert.deepEqual(json.models, []);
  setNearAiStoreForTests(null);
});

test("store read failure: GET /nearai and MCP answer nearai_unavailable", async () => {
  const throwing: NearAiStore = {
    ingestProbeOutput: async () => {
      throw new Error("n/a");
    },
    getLatestRun: async () => null,
    getLatestPublicSnapshot: async () => {
      throw new Error("db down");
    },
    getAnchorRowsForDay: async () => [],
    getDaySeal: async () => null,
    latestRootBefore: async () => null,
    sealDay: async () => ({ status: "unavailable" }),
  };
  setNearAiStoreForTests(throwing);
  const out = await checkNearAiAttestation();
  assert.equal(out, "unavailable");
  const { GET } = await import("@/app/api/v1/observatory/nearai/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/nearai"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "nearai_unavailable" });
  setNearAiStoreForTests(null);
});

test("OutOfDate advisory: not Fail", () => {
  const pub = decidePublication(
    {
      targetKey: "m",
      tcbStatus: "OutOfDate",
      advisoryIds: ["INTEL-SA-123"],
      gpuPass: true,
      rawFailureClass: null,
      cryptoOk: true,
      strictUpToDate: false,
    },
    null,
    false,
  );
  assert.equal(pub.show && pub.status, "advisory");
  if (pub.show) assert.deepEqual(pub.advisoryIds, ["INTEL-SA-123"]);
});
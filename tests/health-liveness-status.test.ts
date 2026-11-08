// ============================================================
// Vouch — the PUBLIC /api/health contract is 200/503, with no third code.
//
// docs/api (§Reliability) tells integrators:
//
//   "A public health endpoint, GET /api/health, returns 200/503 for uptime
//    pollers. … Point your own uptime monitor at /api/health."
//
// Measured 2026-08-13 (hackathon persona, round 2): a `degraded` verdict —
// the engine answering, but from inputs it could not fully read, which is
// what /payee/[address] renders to a real visitor as "Not verifiable right
// now" — came back as HTTP **200**. An uptime poller reads the status code
// and nothing else, so the exact state this probe was built to surface was
// invisible to every monitor pointed at it.
//
// That is the third instance of one bug this day, each a layer under the
// last: the hard-coded "ok" body, the seller-only probe, and now the code
// that carries the answer out. The body still distinguishes degraded from
// error for a human; the code does not pretend either one is up.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateLiveness, livenessHttpStatus } from "@/lib/health/liveness";
import { LIVENESS_PUBLIC_SENTENCE, livenessBannerMessage } from "@/lib/health/banner-message";

const probe = (status: "ok" | "degraded" | "error") => async () => ({ status });

test("degraded is not 200 — the docs promise 200/503 and a poller reads the code", () => {
  assert.equal(livenessHttpStatus("degraded"), 503);
});

test("only ok is 200", () => {
  assert.equal(livenessHttpStatus("ok"), 200);
  assert.equal(livenessHttpStatus("error"), 503);
});

test("a degraded BUYER-side probe takes the endpoint to 503", async () => {
  const result = await evaluateLiveness({ scoring: probe("ok"), payee: probe("degraded") });
  assert.equal(result.status, "degraded");
  assert.equal(result.httpStatus, 503);
});

test("a degraded SELLER-side probe takes the endpoint to 503", async () => {
  const result = await evaluateLiveness({ scoring: probe("degraded"), payee: probe("ok") });
  assert.equal(result.status, "degraded");
  assert.equal(result.httpStatus, 503);
});

test("both probes healthy is the only 200", async () => {
  const result = await evaluateLiveness({ scoring: probe("ok"), payee: probe("ok") });
  assert.equal(result.status, "ok");
  assert.equal(result.httpStatus, 200);
});

test("error still outranks degraded in the reported status", async () => {
  const result = await evaluateLiveness({ scoring: probe("degraded"), payee: probe("error") });
  assert.equal(result.status, "error");
  assert.equal(result.httpStatus, 503);
});

test("the body keeps the distinction a bare status code cannot carry", async () => {
  const degraded = await evaluateLiveness({ scoring: probe("ok"), payee: probe("degraded") });
  const down = await evaluateLiveness({ scoring: probe("error"), payee: probe("error") });
  assert.equal(degraded.httpStatus, down.httpStatus);
  assert.notEqual(degraded.status, down.status);
});

test("both probes are run concurrently, not in sequence", async () => {
  const order: string[] = [];
  const slow = async () => {
    order.push("scoring:start");
    await new Promise((r) => setTimeout(r, 30));
    order.push("scoring:end");
    return { status: "ok" as const };
  };
  const quick = async () => {
    order.push("payee:start");
    return { status: "ok" as const };
  };
  await evaluateLiveness({ scoring: slow, payee: quick });
  // payee starts before scoring finishes — the endpoint costs the slower
  // probe, not the sum of both.
  assert.deepEqual(order, ["scoring:start", "payee:start", "scoring:end"]);
});

test("the public status banner reads GET /api/health and does not import scoring engines", () => {
  const banner = readFileSync(
    join(process.cwd(), "src/components/site/StatusBanner.tsx"),
    "utf8",
  );
  const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const health = readFileSync(join(process.cwd(), "src/app/api/health/route.ts"), "utf8");
  const chrome = readFileSync(
    join(process.cwd(), "src/components/site/SiteChrome.tsx"),
    "utf8",
  );
  assert.match(banner, /\/api\/health/);
  assert.match(banner, /livenessBannerMessage/);
  assert.doesNotMatch(banner, /evaluateLiveness/);
  assert.doesNotMatch(banner, /runPayeeProbe/);
  assert.doesNotMatch(banner, /runScoringProbe/);
  assert.doesNotMatch(layout, /StatusBanner/);
  assert.match(chrome, /StatusBanner/);
  assert.match(health, /recordHealthSnapshotIfDue/);
});

test("outage copy is silent on ok and uses one public sentence for a failed read", () => {
  assert.equal(livenessBannerMessage("ok"), null);
  assert.equal(livenessBannerMessage("rate_limited"), null);
  assert.equal(livenessBannerMessage(undefined), null);
  assert.equal(livenessBannerMessage("error"), LIVENESS_PUBLIC_SENTENCE);
  assert.equal(livenessBannerMessage("degraded"), LIVENESS_PUBLIC_SENTENCE);
  assert.doesNotMatch(LIVENESS_PUBLIC_SENTENCE, /—|–|payee|indexer/);
});

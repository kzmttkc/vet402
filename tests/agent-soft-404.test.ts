// ============================================================
// Vouch — /agent/[agentId] soft-404 regression (2026-08-26).
//
// Same defect class as /observatory/e/[id] (fixed in 3858760): a loading.tsx
// anywhere in this route's ancestor chain wraps the async page in an implicit
// <Suspense> boundary. Next then starts streaming an optimistic 200 shell
// before the async component reaches notFound() (called for a malformed,
// non-numeric agentId — see parseAgentId), and the HTTP status can never be
// corrected afterward: curl/uptime checks/crawlers see 200 even though the
// rendered body eventually shows "Not Found". Reproduced and fixed for
// /observatory/e/[id] by removing every loading.tsx in its ancestor chain;
// this pins the same invariant for /agent/[agentId].
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("no loading.tsx in the /agent/[agentId] ancestor chain (would soft-404)", () => {
  for (const rel of ["src/app/agent/loading.tsx", "src/app/agent/[agentId]/loading.tsx"]) {
    assert.ok(
      !existsSync(join(ROOT, rel)),
      `${rel} must not exist — it wraps the page in an implicit Suspense boundary, which ` +
        "breaks the HTTP 404 status for a malformed agent id (see /observatory/e/[id] fix, commit 3858760)",
    );
  }
});

test("generateMetadata calls notFound() for a malformed agent id, matching the page body", () => {
  const src = read("src/app/agent/[agentId]/page.tsx");
  const metaFn = src.slice(src.indexOf("export async function generateMetadata"), src.indexOf("export default async function"));
  assert.ok(
    metaFn.includes("notFound()"),
    "generateMetadata must call notFound() itself so <head> does not show a generic " +
      "passport title for an id that will 404",
  );
});

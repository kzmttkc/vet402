// Request validation of GET /api/v1/rwa/facts/[address] (SPEC §7 error table).
// These paths never reach the chain.
//
// Run from the repo root: npx tsx --test packages/rwa/test/facts-route.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../../../src/app/api/v1/rwa/facts/[address]/route";

const call = (address: string, qs = "") =>
  GET(new NextRequest(`http://localhost/api/v1/rwa/facts/${address}${qs}`), { params: Promise.resolve({ address }) });

test("400 invalid_address for a value that is not 20-byte hex", async () => {
  for (const bad of ["vitalik.eth", "0x1234", "0xZZ553db0049fc6843c0d00d0efc08d31848e3c74"]) {
    const res = await call(bad);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_address" });
  }
});

test("400 when chain is not 4663", async () => {
  const res = await call("0xa8553db0049fc6843c0d00d0efc08d31848e3c74", "?chain=8453");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_address");
});

test("error responses carry the key-less RateLimit headers", async () => {
  const res = await call("nope");
  assert.ok(res.headers.get("RateLimit-Limit"), "RateLimit-Limit");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { jcsSerialize, JcsError } from "@/lib/signing/jcs";
import { GET } from "@/app/.well-known/vet402-keys.json/route";
import {
  buildSignatureBytes,
  getResponseSigningJwks,
  parseVet402SignatureHeader,
  resetResponseSigningCacheForTests,
  signedJson,
  verifyResponseSignature,
} from "@/lib/signing/response-signature";

function installTestSigningKey(): void {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  process.env.VET402_RESPONSE_SIGNING_KEY = der.toString("base64");
  delete process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK;
  resetResponseSigningCacheForTests();
}

function installP256SigningKey(): void {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  process.env.VET402_RESPONSE_SIGNING_KEY = der.toString("base64");
  delete process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK;
  resetResponseSigningCacheForTests();
}

test("JCS RFC 8785 appendix: numbers table and key ordering", () => {
  const value = {
    numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0e1],
    string: "foo",
    literals: [null, true, false],
  };
  assert.equal(
    jcsSerialize(value),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,0],"string":"foo"}',
  );
  assert.equal(jcsSerialize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(jcsSerialize(["x", undefined, "y"]), '["x",null,"y"]');
  assert.throws(() => jcsSerialize(Number.NaN), JcsError);
  assert.throws(() => jcsSerialize(Number.POSITIVE_INFINITY), JcsError);
});

test("JCS UTF-16 key sort (RFC 8785 appendix B)", () => {
  assert.equal(jcsSerialize({ ö: "O", Å: "A", ä: "A", Ö: "O" }), '{"Å":"A","Ö":"O","ä":"A","ö":"O"}');
});

test("JCS lone surrogate in string throws JcsError", () => {
  assert.throws(() => jcsSerialize({ s: "\uD800" }), JcsError);
});

test("sign then verify succeeds", () => {
  installTestSigningKey();
  const path = "/api/v1/check?url=https%3A%2F%2Fexample.com";
  const body = { recommendation: "ALLOW", n: 1 };
  const req = new Request(`https://vet402.com${path}`);
  const res = signedJson(req, body);
  const hdr = res.headers.get("Vet402-Signature");
  assert.ok(hdr);
  const jwks = getResponseSigningJwks();
  assert.ok(verifyResponseSignature(hdr, path, body, jwks));
});

test("verify using JSON.parse of response text (Date, toJSON, undefined)", async () => {
  installTestSigningKey();
  const path = "/api/v1/observatory/state";
  const body = {
    d: new Date(0),
    gap: undefined,
    wrapped: { toJSON: () => ({ inner: 1 }) },
  };
  const req = new Request(`https://vet402.com${path}`);
  const res = signedJson(req, body);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, JSON.stringify(body));
  const hdr = res.headers.get("Vet402-Signature");
  assert.ok(hdr);
  const parsed = JSON.parse(text) as unknown;
  const jwks = getResponseSigningJwks();
  assert.ok(verifyResponseSignature(hdr, path, parsed, jwks));
});

test("body with function value: 200, wire JSON matches stringify, signature present", async () => {
  installTestSigningKey();
  const path = "/api/v1/find?q=x";
  const body = { ok: true, skip: () => {} };
  const req = new Request(`https://vet402.com${path}`);
  const res = signedJson(req, body);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, JSON.stringify(body));
  const parsed = JSON.parse(text);
  const hdr = res.headers.get("Vet402-Signature");
  assert.ok(hdr);
  assert.ok(verifyResponseSignature(hdr, path, parsed, getResponseSigningJwks()));
});

test("un-signable body (lone surrogate): 200 without signature header", async () => {
  installTestSigningKey();
  const path = "/api/v1/observatory/anchors";
  const body = { label: "\uD800" };
  const req = new Request(`https://vet402.com${path}`);
  const res = signedJson(req, body);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Vet402-Signature"), null);
  assert.equal(await res.text(), JSON.stringify(body));
});

test("tampered body fails verification", () => {
  installTestSigningKey();
  const path = "/api/v1/find?q=weather";
  const body = { alternatives: [] as unknown[] };
  const req = new Request(`https://vet402.com${path}`);
  const res = signedJson(req, body);
  const hdr = res.headers.get("Vet402-Signature")!;
  const jwks = getResponseSigningJwks();
  assert.ok(!verifyResponseSignature(hdr, path, { alternatives: [{}] }, jwks));
});

test("wrong path fails verification", () => {
  installTestSigningKey();
  const path = "/api/v1/observatory/state";
  const body = { l1: { attempts: 1 } };
  const req = new Request(`https://vet402.com${path}`);
  const hdr = signedJson(req, body).headers.get("Vet402-Signature")!;
  assert.ok(!verifyResponseSignature(hdr, "/api/v1/observatory/state?x=1", body, getResponseSigningJwks()));
});

test("no signing key: header absent, body unchanged", async () => {
  delete process.env.VET402_RESPONSE_SIGNING_KEY;
  resetResponseSigningCacheForTests();
  const body = { error: "temporarily_unavailable" };
  const res = signedJson(new Request("https://vet402.com/api/v1/check"), body, { status: 503 });
  assert.equal(res.headers.get("Vet402-Signature"), null);
  assert.deepEqual(await res.json(), body);
});

test("P-256 signing key: no signature header and empty JWKS", async () => {
  installP256SigningKey();
  const res = signedJson(new Request("https://vet402.com/api/v1/check"), { ok: true });
  assert.equal(res.headers.get("Vet402-Signature"), null);
  const jwks = getResponseSigningJwks();
  assert.deepEqual(jwks.keys, []);
  const routeRes = await GET();
  const doc = (await routeRes.json()) as { keys: unknown[] };
  assert.deepEqual(doc.keys, []);
});

test("JWKS kid matches header keyid", () => {
  installTestSigningKey();
  const body = { ok: true };
  const path = "/api/v1/delivery/sellers.json";
  const hdr = signedJson(new Request(`https://vet402.com${path}`), body).headers.get("Vet402-Signature")!;
  const parsed = parseVet402SignatureHeader(hdr);
  assert.ok(parsed);
  const jwks = getResponseSigningJwks();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0]!.kid, parsed!.keyid);
});

test("previous public JWK appears as second key in JWKS", () => {
  installTestSigningKey();
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const previous = {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: jwk.x!,
    kid: "0123456789abcdef",
    use: "sig" as const,
    alg: "EdDSA" as const,
  };
  process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK = JSON.stringify(previous);
  resetResponseSigningCacheForTests();
  const jwks = getResponseSigningJwks();
  assert.equal(jwks.keys.length, 2);
  assert.equal(jwks.keys[1]!.kid, "0123456789abcdef");
});

test("malformed previous public JWK is ignored", () => {
  for (const bad of [
    { kty: "OKP", crv: "Ed25519", x: { evil: 1 }, kid: 5 },
    { kty: "OKP", crv: "Ed25519", x: "short", kid: "0123456789abcdef" },
    { kty: "OKP", crv: "Ed25519", x: "A".repeat(43), kid: "not-hex" },
    { kty: "EC", crv: "P-256", x: "A".repeat(43), kid: "0123456789abcdef" },
  ]) {
    installTestSigningKey();
    process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK = JSON.stringify(bad);
    resetResponseSigningCacheForTests();
    assert.equal(getResponseSigningJwks().keys.length, 1, JSON.stringify(bad));
  }
  installTestSigningKey();
  process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK = "{not json";
  resetResponseSigningCacheForTests();
  assert.equal(getResponseSigningJwks().keys.length, 1);
});

test("previous public JWK with the current kid is not duplicated", () => {
  installTestSigningKey();
  resetResponseSigningCacheForTests();
  const current = getResponseSigningJwks().keys[0]!;
  process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK = JSON.stringify(current);
  resetResponseSigningCacheForTests();
  assert.equal(getResponseSigningJwks().keys.length, 1);
});

test("GET /.well-known/vet402-keys.json with Ed25519 key", async () => {
  installTestSigningKey();
  const res = await GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as { keys: { kid: string }[] };
  assert.equal(body.keys.length, 1);
  assert.ok(body.keys[0]!.kid);
  assert.match(res.headers.get("Cache-Control") ?? "", /max-age=300/);
});

test("GET /.well-known/vet402-keys.json without signing key", async () => {
  delete process.env.VET402_RESPONSE_SIGNING_KEY;
  resetResponseSigningCacheForTests();
  const res = await GET();
  const body = (await res.json()) as { keys: unknown[] };
  assert.deepEqual(body, { keys: [] });
});

test("different key order yields identical signature bytes", () => {
  installTestSigningKey();
  const path = "/api/v1/observatory/anchors";
  const signedAt = "2026-11-25T08:00:00Z";
  const a = buildSignatureBytes(path, signedAt, { z: 1, a: { y: 2, b: 3 } });
  const b = buildSignatureBytes(path, signedAt, { a: { b: 3, y: 2 }, z: 1 });
  assert.equal(a.toString("hex"), b.toString("hex"));
});

const SIG64 = Buffer.alloc(64, 0xab).toString("base64url");

test("parseVet402SignatureHeader rejects duplicate parameters", () => {
  const dup = `v=1; alg=ed25519; keyid=abcd; signed_at=2026-11-25T08:00:00Z; v=1; sig=${SIG64}`;
  assert.equal(parseVet402SignatureHeader(dup), null);
});

test("parseVet402SignatureHeader rejects unknown parameters", () => {
  const bad = `v=1; alg=ed25519; keyid=abcd; signed_at=2026-11-25T08:00:00Z; extra=1; sig=${SIG64}`;
  assert.equal(parseVet402SignatureHeader(bad), null);
});

test("parseVet402SignatureHeader rejects non-UTC signed_at", () => {
  const bad = `v=1; alg=ed25519; keyid=abcd; signed_at=2026-11-25T08:00:00.000Z; sig=${SIG64}`;
  assert.equal(parseVet402SignatureHeader(bad), null);
});

test("parseVet402SignatureHeader rejects wrong-length sig", () => {
  const bad = "v=1; alg=ed25519; keyid=abcd; signed_at=2026-11-25T08:00:00Z; sig=YWJj";
  assert.equal(parseVet402SignatureHeader(bad), null);
});

test("parseVet402SignatureHeader accepts valid 64-byte sig", () => {
  const good = `v=1; alg=ed25519; keyid=abcd1234; signed_at=2026-11-25T08:00:00Z; sig=${SIG64}`;
  const parsed = parseVet402SignatureHeader(good);
  assert.ok(parsed);
  assert.equal(Buffer.from(parsed!.sig, "base64url").length, 64);
});
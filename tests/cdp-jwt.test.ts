import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { cdpJwt } from "../src/lib/x402/cdp-jwt";

const HOST = "api.cdp.coinbase.com";
const PATH = "/platform/v2/x402/verify";
const URI = `POST ${HOST}${PATH}`;
const NOW = 1_700_000_000;

function decodePart(token: string, index: 0 | 1): Record<string, unknown> {
  const part = token.split(".")[index];
  assert.ok(part, "missing jwt part");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function verifyJwt(token: string, publicKey: KeyObject, alg: "EdDSA" | "ES256"): void {
  const [h, p, s] = token.split(".");
  assert.ok(h && p && s, "jwt must have three parts");
  const ok =
    alg === "ES256"
      ? createVerify("sha256")
          .update(`${h}.${p}`)
          .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))
      : verify(null, Buffer.from(`${h}.${p}`, "utf8"), publicKey, Buffer.from(s, "base64url"));
  assert.equal(ok, true, "signature must verify");
}

function assertCdpClaims(header: Record<string, unknown>, payload: Record<string, unknown>, keyId: string): void {
  assert.equal(header.kid, keyId);
  assert.equal(header.typ, "JWT");
  assert.equal(typeof header.nonce, "string");
  assert.match(header.nonce as string, /^[0-9a-f]{32}$/);
  assert.equal(payload.sub, keyId);
  assert.equal(payload.iss, "cdp");
  assert.deepEqual(payload.aud, ["cdp_service"]);
  assert.equal((payload.exp as number) - (payload.nbf as number), 120);
  assert.deepEqual(payload.uris, [URI]);
}

test("Ed25519 CDP secret: signature verifies and claims match", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const secret64 = Buffer.concat([
    Buffer.from(jwk.d, "base64url"),
    Buffer.from(jwk.x, "base64url"),
  ]).toString("base64");
  const keyId = "test-ed25519-key";
  const nonce = "a".repeat(32);
  const token = cdpJwt({
    keyId,
    keySecret: secret64,
    method: "POST",
    host: HOST,
    path: PATH,
    nowSec: NOW,
    nonce,
  });
  const header = decodePart(token, 0);
  const payload = decodePart(token, 1);
  assert.equal(header.alg, "EdDSA");
  assertCdpClaims(header, payload, keyId);
  assert.equal(payload.nbf, NOW);
  assert.equal(payload.exp, NOW + 120);
  verifyJwt(token, publicKey, "EdDSA");
});

test("ES256 EC PEM: signature verifies and claims match", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ format: "pem", type: "sec1" });
  assert.match(String(pem), /BEGIN EC PRIVATE KEY/);
  const keyId = "organizations/test/apiKeys/00000000";
  const token = cdpJwt({
    keyId,
    keySecret: String(pem),
    method: "POST",
    host: HOST,
    path: PATH,
    nowSec: NOW,
  });
  const header = decodePart(token, 0);
  const payload = decodePart(token, 1);
  assert.equal(header.alg, "ES256");
  assertCdpClaims(header, payload, keyId);
  verifyJwt(token, publicKey, "ES256");
});

test("unknown key format throws cdp_key_format_unsupported", () => {
  assert.throws(
    () =>
      cdpJwt({
        keyId: "x",
        keySecret: "not-a-valid-key",
        method: "POST",
        host: HOST,
        path: PATH,
      }),
  (e: unknown) => e instanceof Error && e.message === "cdp_key_format_unsupported",
  );
});
import { createPrivateKey, createSign, randomBytes, sign, type KeyObject } from "node:crypto";

export type CdpJwtParams = {
  keyId: string;
  keySecret: string;
  method: string;
  host: string;
  path: string;
  nowSec?: number;
  nonce?: string;
};

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function ed25519Pkcs8Der(seed: Buffer): Buffer {
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
  const algId = Buffer.concat([Buffer.from([0x30, oid.length]), oid]);
  const inner = Buffer.concat([Buffer.from([0x04, 0x20]), seed]);
  const privOctet = Buffer.concat([Buffer.from([0x04, inner.length]), inner]);
  const body = Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), algId, privOctet]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function loadEd25519Key(keySecret: string): { key: KeyObject; alg: "EdDSA" } {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(keySecret, "base64");
  } catch {
    throw new Error("cdp_key_format_unsupported");
  }
  if (decoded.length !== 64) throw new Error("cdp_key_format_unsupported");
  const seed = decoded.subarray(0, 32);
  const der = ed25519Pkcs8Der(seed);
  return { key: createPrivateKey({ key: der, format: "der", type: "pkcs8" }), alg: "EdDSA" };
}

function loadEs256Key(keySecret: string): { key: KeyObject; alg: "ES256" } {
  if (!keySecret.includes("-----BEGIN EC PRIVATE KEY-----")) {
    throw new Error("cdp_key_format_unsupported");
  }
  return { key: createPrivateKey(keySecret), alg: "ES256" };
}

function resolveSigningKey(keySecret: string): { key: KeyObject; alg: "EdDSA" | "ES256" } {
  try {
    const decoded = Buffer.from(keySecret, "base64");
    if (decoded.length === 64) return loadEd25519Key(keySecret);
  } catch {
    /* not base64 Ed25519 */
  }
  if (keySecret.includes("-----BEGIN EC PRIVATE KEY-----")) return loadEs256Key(keySecret);
  throw new Error("cdp_key_format_unsupported");
}

/** CDP REST Bearer JWT (matches @coinbase/cdp-sdk `generateJwt` wire format). */
export function cdpJwt(params: CdpJwtParams): string {
  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  const nonce = params.nonce ?? randomBytes(16).toString("hex");
  const uri = `${params.method.toUpperCase()} ${params.host}${params.path}`;
  const { key, alg } = resolveSigningKey(params.keySecret);

  const header = { alg, kid: params.keyId, typ: "JWT", nonce };
  const payload = {
    sub: params.keyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uris: [uri],
  };

  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig =
    alg === "ES256"
      ? createSign("sha256")
          .update(signingInput)
          .sign({ key, dsaEncoding: "ieee-p1363" })
      : sign(null, Buffer.from(signingInput, "utf8"), key);

  return `${signingInput}.${sig.toString("base64url")}`;
}
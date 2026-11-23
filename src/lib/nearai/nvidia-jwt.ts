import { createPublicKey, createVerify } from "node:crypto";

export const NVIDIA_ISSUER = "https://nras.attestation.nvidia.com";
export const NVIDIA_JWKS_URL = `${NVIDIA_ISSUER}/.well-known/jwks.json`;

type EcJwk = {
  kty: "EC";
  crv: "P-384";
  x: string;
  y: string;
  kid?: string;
  alg?: string;
  use?: string;
};

export type NvidiaJwks = { keys: EcJwk[] };

export function decodeJwks(raw: unknown): NvidiaJwks {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as NvidiaJwks).keys)) {
    throw new Error("invalid_jwks");
  }
  return raw as NvidiaJwks;
}

function selectJwk(jwks: NvidiaJwks, kid: string | undefined): EcJwk | null {
  for (const key of jwks.keys) {
    if (key.kty !== "EC" || key.crv !== "P-384") continue;
    if (key.alg && key.alg !== "ES384") continue;
    if (key.use && key.use !== "sig") continue;
    if (kid && key.kid !== kid) continue;
    if (!kid && jwks.keys.length === 1) return key;
    if (kid && key.kid === kid) return key;
  }
  return null;
}

function assertTimeClaims(payload: Record<string, unknown>): void {
  const now = Math.floor(Date.now() / 1000);
  for (const field of ["iat", "nbf", "exp"] as const) {
    const v = payload[field];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.trunc(v) !== v) {
      throw new Error("invalid_claims");
    }
  }
  const iat = payload.iat as number;
  const nbf = payload.nbf as number;
  const exp = payload.exp as number;
  if (iat > now) throw new Error("not_yet_valid");
  if (nbf > now) throw new Error("not_yet_valid");
  if (exp <= now) throw new Error("expired");
}

/** Verify NRAS overall EAT JWT (ES384) against NVIDIA JWKS — mirrors inference-sdk `nvidia.ts` / `gpu.go`. */
export function verifyNrasJwt(token: string, jwks: NvidiaJwks): Record<string, unknown> {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("invalid_jwt");
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  } catch {
    throw new Error("invalid_jwt");
  }
  if (header.alg !== "ES384") throw new Error("unsupported_algorithm");
  const jwk = selectJwk(jwks, header.kid);
  if (!jwk) throw new Error("key_not_found");

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const verifier = createVerify("sha384");
  verifier.update(`${parts[0]}.${parts[1]}`);
  const sigOk = verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"));
  if (!sigOk) throw new Error("invalid_signature");

  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  if (payload.iss !== NVIDIA_ISSUER) throw new Error("invalid_claims");
  assertTimeClaims(payload);
  return payload;
}
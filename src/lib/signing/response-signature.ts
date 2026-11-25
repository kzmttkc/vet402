import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { NextResponse } from "next/server";
import { logServerWarnSafe } from "@/lib/util/log-safe";
import { jcsSerialize } from "./jcs";

export type Vet402Jwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: "EdDSA";
};

export type Vet402Jwks = { keys: Vet402Jwk[] };

type LoadedKey = { privateKey: KeyObject; publicKey: KeyObject; kid: string };

const HEADER_PARAMS = new Set(["v", "alg", "keyid", "signed_at", "sig"]);

let cachedKey: LoadedKey | null | undefined;
let warnedMissingKey = false;
let warnedNotEd25519 = false;
let warnedSigningFailed = false;

export function resetResponseSigningCacheForTests(): void {
  cachedKey = undefined;
  warnedMissingKey = false;
  warnedNotEd25519 = false;
  warnedSigningFailed = false;
}

function requestPath(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

export function isoUtcSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isIso8601UtcWholeSeconds(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s);
}

function ed25519RawPublicKey(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: "jwk" }) as JsonWebKey;
  if (!jwk.x) throw new Error("missing Ed25519 public key");
  return Buffer.from(jwk.x, "base64url");
}

function kidFromPublicKey(pub: KeyObject): string {
  return createHash("sha256").update(ed25519RawPublicKey(pub)).digest("hex").slice(0, 16);
}

function parsePreviousPublicJwk(): Vet402Jwk | null {
  const raw = process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK?.trim();
  if (!raw) return null;
  try {
    const jwk = JSON.parse(raw) as Record<string, unknown>;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return null;
    const { x, kid } = jwk;
    // Malformed values are ignored so a strict JWKS reader never sees a broken key set.
    if (typeof x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
    if (Buffer.from(x, "base64url").length !== 32) return null;
    if (typeof kid !== "string" || !/^[0-9a-f]{16}$/.test(kid)) return null;
    return { kty: "OKP", crv: "Ed25519", x, kid, use: "sig", alg: "EdDSA" };
  } catch {
    return null;
  }
}

function loadSigningKey(): LoadedKey | null {
  if (cachedKey !== undefined) return cachedKey;
  const b64 = process.env.VET402_RESPONSE_SIGNING_KEY?.trim();
  if (!b64) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      logServerWarnSafe("response_signing", "VET402_RESPONSE_SIGNING_KEY unset; response signatures omitted");
    }
    cachedKey = null;
    return null;
  }
  try {
    const der = Buffer.from(b64, "base64");
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      if (!warnedNotEd25519) {
        warnedNotEd25519 = true;
        logServerWarnSafe(
          "response_signing",
          "VET402_RESPONSE_SIGNING_KEY is not Ed25519 PKCS#8; response signatures omitted",
        );
      }
      cachedKey = null;
      return null;
    }
    const publicKey = createPublicKey(privateKey);
    cachedKey = { privateKey, publicKey, kid: kidFromPublicKey(publicKey) };
    return cachedKey;
  } catch {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      logServerWarnSafe("response_signing", "VET402_RESPONSE_SIGNING_KEY invalid; response signatures omitted");
    }
    cachedKey = null;
    return null;
  }
}

export function getResponseSigningJwks(): Vet402Jwks {
  const keys: Vet402Jwk[] = [];
  const loaded = loadSigningKey();
  if (loaded) {
    const raw = ed25519RawPublicKey(loaded.publicKey);
    keys.push({
      kty: "OKP",
      crv: "Ed25519",
      x: raw.toString("base64url"),
      kid: loaded.kid,
      use: "sig",
      alg: "EdDSA",
    });
  }
  const previous = parsePreviousPublicJwk();
  if (previous && !keys.some((k) => k.kid === previous.kid)) keys.push(previous);
  return { keys };
}

export function buildSignatureBytes(path: string, signedAt: string, body: unknown): Buffer {
  const envelope = { v: 1, path, signedAt, body };
  return Buffer.from(jcsSerialize(envelope), "utf8");
}

export type ParsedVet402Signature = {
  v: string;
  alg: string;
  keyid: string;
  signed_at: string;
  sig: string;
};

export function parseVet402SignatureHeader(header: string | null): ParsedVet402Signature | null {
  if (!header) return null;
  const value = header.trim();
  const parts: Record<string, string> = {};
  for (const piece of value.split(";")) {
    const segment = piece.trim();
    if (!segment) continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) return null;
    const k = segment.slice(0, eq).trim();
    const v = segment.slice(eq + 1).trim();
    if (!HEADER_PARAMS.has(k)) return null;
    if (Object.hasOwn(parts, k)) return null;
    parts[k] = v;
  }
  if (
    parts.v !== "1" ||
    parts.alg !== "ed25519" ||
    !parts.keyid ||
    !parts.signed_at ||
    !parts.sig
  ) {
    return null;
  }
  if (!isIso8601UtcWholeSeconds(parts.signed_at)) return null;
  if (!/^[A-Za-z0-9_-]{86}$/.test(parts.sig)) return null;
  let sig: Buffer;
  try {
    sig = Buffer.from(parts.sig, "base64url");
  } catch {
    return null;
  }
  if (sig.length !== 64) return null;
  return {
    v: parts.v,
    alg: parts.alg,
    keyid: parts.keyid,
    signed_at: parts.signed_at,
    sig: parts.sig,
  };
}

function publicKeyForKid(jwks: Vet402Jwks, kid: string): KeyObject | null {
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  try {
    return createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return null;
  }
}

export function verifyResponseSignature(
  header: string | null,
  path: string,
  body: unknown,
  jwks: Vet402Jwks,
): boolean {
  const parsed = parseVet402SignatureHeader(header);
  if (!parsed) return false;
  const pub = publicKeyForKid(jwks, parsed.keyid);
  if (!pub) return false;
  const message = buildSignatureBytes(path, parsed.signed_at, body);
  const sig = Buffer.from(parsed.sig, "base64url");
  return verify(null, message, pub, sig);
}

export function formatVet402SignatureHeader(path: string, body: unknown, loaded: LoadedKey): string | null {
  const signedAt = isoUtcSeconds(new Date());
  const message = buildSignatureBytes(path, signedAt, body);
  const sig = sign(null, message, loaded.privateKey);
  return `v=1; alg=ed25519; keyid=${loaded.kid}; signed_at=${signedAt}; sig=${sig.toString("base64url")}`;
}

export function signedJson(req: Request, body: unknown, init?: ResponseInit): NextResponse {
  const text = JSON.stringify(body);
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  const loaded = loadSigningKey();
  if (loaded) {
    try {
      const plain = JSON.parse(text) as unknown;
      const headerValue = formatVet402SignatureHeader(requestPath(req.url), plain, loaded);
      if (headerValue) headers.set("Vet402-Signature", headerValue);
    } catch {
      if (!warnedSigningFailed) {
        warnedSigningFailed = true;
        logServerWarnSafe("response_signing", "response body not signable; signature omitted");
      }
    }
  }

  return new NextResponse(text, {
    ...init,
    headers,
  });
}
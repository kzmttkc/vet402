import { normalizeExternalFailure } from "./failure-class";
import {
  decodeJwks,
  NVIDIA_ISSUER,
  NVIDIA_JWKS_URL,
  verifyNrasJwt,
  type NvidiaJwks,
} from "./nvidia-jwt";

const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";

export type GpuVerifyResult = {
  present: boolean;
  ok: boolean | null;
  failureClass: string | null;
  verdict?: boolean;
  eatNonceMatches?: boolean;
  nvidiaVer?: string | null;
  gpuCount?: number | null;
  status?: number;
  jwtVerified?: boolean;
};

export type VerifyNvidiaGpuOptions = {
  fetchFn?: typeof fetch;
  jwks?: NvidiaJwks;
  jwksFetcher?: (url: string) => Promise<NvidiaJwks>;
  jwksUrl?: string;
};

export function jwtFailureClass(reason: string): string {
  if (reason === "expired" || reason === "not_yet_valid" || reason === "invalid_claims") return "nras_jwt_claims_invalid";
  if (reason === "unsupported_algorithm") return "nras_jwt_unsupported_algorithm";
  if (reason === "key_not_found") return "nras_jwt_key_not_found";
  return "nras_jwt_invalid_signature";
}

export async function verifyNvidiaGpu(
  nvidiaPayloadRaw: unknown,
  expectedNonceHex: string,
  fetchOrOptions?: typeof fetch | VerifyNvidiaGpuOptions,
  legacyFetch?: typeof fetch,
): Promise<GpuVerifyResult> {
  const options: VerifyNvidiaGpuOptions =
    typeof fetchOrOptions === "function" || fetchOrOptions === undefined
      ? { fetchFn: fetchOrOptions ?? legacyFetch ?? fetch }
      : fetchOrOptions;
  const fetchFn = options.fetchFn ?? fetch;
  const jwksUrl = options.jwksUrl ?? NVIDIA_JWKS_URL;

  if (!nvidiaPayloadRaw) {
    return { present: false, ok: null, failureClass: "gpu_evidence_missing" };
  }
  let payload: { nonce?: string };
  try {
    payload = (typeof nvidiaPayloadRaw === "string" ? JSON.parse(nvidiaPayloadRaw) : nvidiaPayloadRaw) as {
      nonce?: string;
    };
  } catch (err) {
    return {
      present: true,
      ok: false,
      failureClass: "gpu_payload_malformed",
      ...(err instanceof Error ? { error: err.message } : {}),
    };
  }
  const nonceMatches =
    typeof payload?.nonce === "string" && payload.nonce.toLowerCase() === expectedNonceHex.toLowerCase();
  if (!nonceMatches) {
    return { present: true, ok: false, failureClass: "gpu_nonce_mismatch", eatNonceMatches: false };
  }
  try {
    const res = await fetchFn(NRAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        present: true,
        ok: false,
        failureClass: normalizeExternalFailure(`nras_http_${res.status}`),
        status: res.status,
      };
    }
    const parsed = JSON.parse(text) as unknown;
    const overallToken = Array.isArray(parsed) && Array.isArray((parsed as unknown[])[0]) ? (parsed as unknown[][])[0][1] : null;
    if (!overallToken || typeof overallToken !== "string") {
      return { present: true, ok: false, failureClass: "nras_unavailable" };
    }

    let claims: Record<string, unknown>;
    try {
      let jwks = options.jwks;
      if (!jwks) {
        const jwksFetcher =
          options.jwksFetcher ??
          (async (url: string) => {
            const jwksRes = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
            if (!jwksRes.ok) throw new Error("jwks_http");
            return decodeJwks(await jwksRes.json());
          });
        jwks = await jwksFetcher(jwksUrl);
      }
      claims = verifyNrasJwt(overallToken, jwks);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid_signature";
      if (reason === "jwks_http") {
        return { present: true, ok: false, failureClass: "nras_unavailable" };
      }
      return {
        present: true,
        ok: false,
        failureClass: jwtFailureClass(reason),
        jwtVerified: false,
      };
    }

    const verdict = claims["x-nvidia-overall-att-result"] === true;
    const eatNonce = claims["eat_nonce"];
    const eatNonceMatches = typeof eatNonce === "string" && eatNonce.toLowerCase() === expectedNonceHex.toLowerCase();
    const submods = claims.submods as Record<string, unknown> | undefined;
    return {
      present: true,
      ok: verdict && eatNonceMatches,
      failureClass: verdict
        ? eatNonceMatches
          ? null
          : "nras_eat_nonce_mismatch"
        : "nras_verdict_false",
      verdict,
      eatNonceMatches,
      nvidiaVer: typeof claims["x-nvidia-ver"] === "string" ? claims["x-nvidia-ver"] : null,
      gpuCount: submods ? Object.keys(submods).length : null,
      jwtVerified: true,
    };
  } catch {
    return { present: true, ok: false, failureClass: "nras_unavailable" };
  }
}

export { NVIDIA_ISSUER, NVIDIA_JWKS_URL };
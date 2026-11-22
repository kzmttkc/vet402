import { normalizeExternalFailure } from "./failure-class";

const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = String(jwt).split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

export type GpuVerifyResult = {
  present: boolean;
  ok: boolean | null;
  failureClass: string | null;
  verdict?: boolean;
  eatNonceMatches?: boolean;
  nvidiaVer?: string | null;
  gpuCount?: number | null;
  status?: number;
};

export async function verifyNvidiaGpu(
  nvidiaPayloadRaw: unknown,
  expectedNonceHex: string,
  fetchFn: typeof fetch = fetch,
): Promise<GpuVerifyResult> {
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
    const claims = decodeJwtPayload(overallToken);
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
    };
  } catch {
    return { present: true, ok: false, failureClass: "nras_unavailable" };
  }
}
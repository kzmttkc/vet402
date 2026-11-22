/** Closed vocabulary for NEAR AI TEE probe failures (stage 1). */

export const ACCEPTED_TCB_STRICT = new Set(["UpToDate"]);

export const ACCEPTED_TCB_CRYPTO = new Set([
  "UpToDate",
  "OutOfDate",
  "SWHardeningNeeded",
  "ConfigurationNeeded",
  "ConfigurationAndSWHardeningNeeded",
]);

/** Counts as NEAR-side serious crypto / integrity — subject to 2-run gate and optional hold. */
export const SERIOUS_CRYPTO_FAILURES = new Set([
  "tdx_debug_enabled",
  "nonce_or_signer_mismatch",
  "tls_spki_mismatch",
  "mrconfig_mismatch",
  "rtmr3_mismatch",
  "gpu_nonce_mismatch",
  "gpu_nras_false",
  "nras_eat_nonce_mismatch",
  "nras_verdict_false",
  "compose_actions_mismatch",
  "missing_intel_quote",
  "not_td10_quote",
  "empty_model_attestations",
]);

export function isExternalVerifierUnavailable(failureClass: string | null | undefined): boolean {
  if (!failureClass) return false;
  if (failureClass === "pccs_unavailable" || failureClass === "nras_unavailable") return true;
  if (failureClass.startsWith("nras_http_")) return true;
  return false;
}

export function isSeriousCryptoFailure(failureClass: string | null | undefined): boolean {
  if (!failureClass) return false;
  if (isExternalVerifierUnavailable(failureClass)) return false;
  if (failureClass.startsWith("tcb_rejected:")) return false;
  if (SERIOUS_CRYPTO_FAILURES.has(failureClass)) return true;
  return failureClass.startsWith("http_");
}

export function normalizeExternalFailure(failureClass: string | null): string | null {
  if (!failureClass) return null;
  if (failureClass.startsWith("nras_http_") || failureClass === "nras_malformed_response") {
    return "nras_unavailable";
  }
  return failureClass;
}
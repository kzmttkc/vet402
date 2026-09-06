import { getProductionEnvErrors } from "./production-env";

export type AppEnv = "development" | "production" | "test";

export function getAppEnv(): AppEnv {
  const explicit = process.env.APP_ENV;
  if (explicit === "production" || explicit === "development" || explicit === "test") {
    return explicit;
  }
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function isProduction(): boolean {
  return getAppEnv() === "production";
}

export function isDevelopment(): boolean {
  return getAppEnv() === "development";
}

export function isDevApiKeyEnabled(): boolean {
  return Boolean(process.env.DEV_API_KEY) && !isProduction();
}

export function isSkipChainReadsEnabled(): boolean {
  return process.env.SKIP_CHAIN_READS === "true" && !isProduction();
}

/**
 * /decision の鍵なし読み取り枠（AQ-053・2026-09-07）。既定は有効。`"0"` で従来の
 * 401 に戻す。鍵ありの経路には一切影響しない（枠も本文も従来どおり）。
 */
export function isDecisionKeylessReadEnabled(): boolean {
  return process.env.DECISION_KEYLESS_READ !== "0";
}

/**
 * N-20 guarantee underwriting (AQ-016): OFF by default, everywhere. The pure
 * underwriting math and its API/UI receptacle are built so the go-live is a
 * config flip, but offering a financial guarantee is a business + legal
 * decision that must NOT be reachable until Takeshi + counsel approve it. The
 * flag is deliberately not honored as a build-time default and there is no
 * production carve-out that turns it on implicitly — it is only ever true when
 * this exact env var is explicitly set. See docs/guarantee-underwriting-design.md.
 */
export function isGuaranteeUnderwritingEnabled(): boolean {
  return process.env.GUARANTEE_UNDERWRITING_ENABLED === "true";
}

let validated = false;

/**
 * Fail fast on boot when production env is incomplete or unsafe.
 * Mirrors scripts/check-production-env.ts (single source of truth).
 */
export function assertProductionConfig(): void {
  // Soft-prod trap: Vercel-like NODE_ENV=production with APP_ENV=development|test.
  if (
    process.env.NODE_ENV === "production" &&
    (process.env.APP_ENV === "development" || process.env.APP_ENV === "test")
  ) {
    throw new Error(
      "APP_ENV=development|test is not allowed when NODE_ENV=production (mislabeled deploy)",
    );
  }

  if (!isProduction()) return;

  if (process.env.APP_ENV !== "production") {
    throw new Error("APP_ENV must be set to production in production deployments");
  }

  const errors = getProductionEnvErrors();
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export function ensureProductionConfig(): void {
  if (validated) return;
  assertProductionConfig();
  validated = true;
}

export function secureCookiesEnabled(): boolean {
  if (isProduction()) return true;
  if (process.env.FORCE_SECURE_COOKIES === "true") return true;
  return false;
}

export { getProductionEnvErrors, getProductionEnvWarnings } from "./production-env";

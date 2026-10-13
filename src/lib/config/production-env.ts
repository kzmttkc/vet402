import { hasLowEntropy, WEAK_SECRET_PATTERNS } from "./env-secrets";
import {
  isUsingLegacyProxyConfig,
  isValidProxyHeaderSource,
  isVercelRuntime,
  PROXY_HEADER_SOURCES,
  rawProxyHeaderSource,
  resolveProxyHeaderSource,
} from "./proxy-headers";

export type ProductionEnvIssue = {
  level: "error" | "warn";
  message: string;
};

/** Required in production per docs/deployment.md */
export const PRODUCTION_REQUIRED_STRING_VARS = [
  ["DATABASE_URL", 16],
  ["API_KEY_PEPPER", 32],
  ["DASHBOARD_SESSION_SECRET", 32],
  ["ADMIN_SECRET", 32],
  ["CRON_SECRET", 32],
  ["BASE_RPC_URL", 8],
] as const;

function isWeakSecret(value: string): boolean {
  return WEAK_SECRET_PATTERNS.some((pattern) => pattern.test(value)) || hasLowEntropy(value);
}

function validateRequiredString(
  name: string,
  value: string | undefined,
  minLength: number,
): ProductionEnvIssue | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < minLength) {
    return {
      level: "error",
      message: `${name} is required in production (min ${minLength} chars, non-empty)`,
    };
  }
  if (isWeakSecret(trimmed)) {
    return {
      level: "error",
      message: `${name} must not use a default, placeholder, or low-entropy value in production`,
    };
  }
  return null;
}

function validateBaseRpcUrl(value: string | undefined): ProductionEnvIssue | null {
  const base = validateRequiredString("BASE_RPC_URL", value, 8);
  if (base) return base;

  const trimmed = value!.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        level: "error",
        message: "BASE_RPC_URL must be an http(s) URL in production",
      };
    }
  } catch {
    return {
      level: "error",
      message: "BASE_RPC_URL must be a valid URL in production",
    };
  }

  return null;
}

/**
 * Forwarded-IP configuration (2026-08-22 audit).
 *
 * The one condition that must be an ERROR rather than a warning is "trust the
 * Vercel header while not on Vercel": off Vercel nothing overwrites
 * `x-vercel-forwarded-for`, so believing it hands every caller a free
 * per-request identity and every per-IP limit stops existing. That state is
 * only reachable by writing PROXY_HEADER_SOURCE=vercel explicitly — the
 * legacy inference in proxy-headers.ts refuses to produce it without VERCEL=1
 * — so this check cannot fire on the current production deployment.
 *
 * `none` in production is a WARNING, not an error, and deliberately so. The
 * old rule ("TRUST_PROXY_HEADERS must be true") was an error, but the new
 * inference depends on VERCEL=1 being present in the runtime; if that
 * platform variable were ever absent, an error here would turn a degraded
 * rate limiter into a total boot failure. `none` is fail-closed already —
 * everyone shares one bucket, nobody gets a bypass — so it is worth a loud
 * warning and not an outage. The message says which of the two situations it
 * is.
 */
export function collectProxyHeaderIssues(): ProductionEnvIssue[] {
  const issues: ProductionEnvIssue[] = [];
  const raw = rawProxyHeaderSource();

  if (raw !== null && !isValidProxyHeaderSource(raw)) {
    issues.push({
      level: "error",
      message: `PROXY_HEADER_SOURCE must be one of ${PROXY_HEADER_SOURCES.join("|")} (got "${raw}")`,
    });
    return issues;
  }

  const source = resolveProxyHeaderSource();

  if (source === "vercel" && !isVercelRuntime()) {
    issues.push({
      level: "error",
      message:
        "PROXY_HEADER_SOURCE=vercel trusts x-vercel-forwarded-for, which only Vercel overwrites — off Vercel any client can spoof it and every per-IP rate limit is bypassable. Use generic (behind a stripping proxy) or none.",
    });
  }

  if (source === "generic") {
    issues.push({
      level: "warn",
      message:
        "PROXY_HEADER_SOURCE=generic trusts spoofable X-Forwarded-For / X-Real-IP — only sound behind a proxy that rewrites them",
    });
  }

  if (source === "none") {
    issues.push({
      level: "warn",
      message:
        raw === "none"
          ? "PROXY_HEADER_SOURCE=none — every caller shares one rate-limit bucket (no per-IP limits)"
          : "PROXY_HEADER_SOURCE is not set and could not be inferred safely — every caller shares one rate-limit bucket. Set PROXY_HEADER_SOURCE=vercel|generic|none explicitly.",
    });
  }

  if (isUsingLegacyProxyConfig()) {
    issues.push({
      level: "warn",
      message: `TRUST_PROXY_HEADERS is deprecated — set PROXY_HEADER_SOURCE=${source} explicitly`,
    });
  }

  return issues;
}

/**
 * Collect production env validation issues without throwing.
 * Used by deploy scripts, deep health, and startup guards.
 */
export function collectProductionEnvIssues(): ProductionEnvIssue[] {
  const issues: ProductionEnvIssue[] = [];

  if (process.env.APP_ENV !== "production") {
    return issues;
  }

  for (const [name, min] of PRODUCTION_REQUIRED_STRING_VARS) {
    if (name === "BASE_RPC_URL") {
      const rpcIssue = validateBaseRpcUrl(process.env.BASE_RPC_URL);
      if (rpcIssue) issues.push(rpcIssue);
      continue;
    }

    const issue = validateRequiredString(name, process.env[name], min);
    if (issue) issues.push(issue);
  }

  if (process.env.DEV_API_KEY) {
    issues.push({
      level: "error",
      message: "DEV_API_KEY must not be set in production",
    });
  }

  if (process.env.SKIP_CHAIN_READS === "true") {
    issues.push({
      level: "error",
      message: "SKIP_CHAIN_READS must not be enabled in production",
    });
  }

  issues.push(...collectProxyHeaderIssues());

  const indexerRpc = process.env.INDEXER_RPC_URL?.trim();
  if (indexerRpc) {
    try {
      const url = new URL(indexerRpc);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push({
          level: "error",
          message: "INDEXER_RPC_URL must be an http(s) URL when set",
        });
      }
    } catch {
      issues.push({
        level: "error",
        message: "INDEXER_RPC_URL must be a valid URL when set",
      });
    }
  }

  // 2026-10-13: 予備の読み先の書き損じは error にしない（予備のせいで本番を止めない）。
  // ただし黙って捨てると「予備があるつもり」で 10/8 と同じ止まり方をするので、warn で名指しする。
  // （chain/ を config から import しない。同じ規則を 5 行で持つ: tests/log-scan-failover.test.ts が両方を突き合わせる）
  const rawFallbacks = (process.env.LOG_SCAN_FALLBACK_RPC_URLS ?? "").trim();
  const badFallbacks =
    rawFallbacks === "" || /^(none|off)$/i.test(rawFallbacks)
      ? 0
      : rawFallbacks.split(",").filter((part) => {
          try {
            const url = new URL(part.trim());
            return url.protocol !== "http:" && url.protocol !== "https:";
          } catch {
            return true;
          }
        }).length;
  if (badFallbacks > 0) {
    issues.push({
      level: "warn",
      message: `LOG_SCAN_FALLBACK_RPC_URLS has ${badFallbacks} entr${badFallbacks === 1 ? "y" : "ies"} that are not http(s) URLs; they are ignored`,
    });
  }

  if (!process.env.BLOCKSCOUT_API_URL?.trim()) {
    issues.push({
      level: "warn",
      message: "BLOCKSCOUT_API_URL is not set — wallet metrics may be degraded",
    });
  }

  // 2026-08-15 (audit): STRIPE_SECRET_KEY alone is not sufficient for billing
  // to actually work — Checkout can succeed while the webhook that applies
  // the resulting plan silently 503s (fail-closed, not a security bug), and a
  // customer's paid plan never lands. That failure mode is invisible unless
  // someone thinks to check; catching it at boot is cheap. Only required when
  // Stripe is in use at all — a deployment that never sets STRIPE_SECRET_KEY
  // is not doing billing and should not be forced to configure it.
  if (process.env.STRIPE_SECRET_KEY) {
    const webhookIssue = validateRequiredString(
      "STRIPE_WEBHOOK_SECRET",
      process.env.STRIPE_WEBHOOK_SECRET,
      32,
    );
    if (webhookIssue) issues.push(webhookIssue);

    if (!process.env.STRIPE_PRICE_PRO?.trim()) {
      issues.push({
        level: "error",
        message: "STRIPE_PRICE_PRO is required in production when STRIPE_SECRET_KEY is set",
      });
    }
    if (!process.env.STRIPE_PRICE_SCALE?.trim()) {
      issues.push({
        level: "error",
        message: "STRIPE_PRICE_SCALE is required in production when STRIPE_SECRET_KEY is set",
      });
    }
  }

  return issues;
}

export function getProductionEnvErrors(): string[] {
  return collectProductionEnvIssues()
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.message);
}

export function getProductionEnvWarnings(): string[] {
  return collectProductionEnvIssues()
    .filter((issue) => issue.level === "warn")
    .map((issue) => issue.message);
}

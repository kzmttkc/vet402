// 売り手の URL を 1 回だけ取り、402 を検査する。支払わない。署名しない。
import { getDb } from "@/lib/db/client";
import type { AddressResolver } from "@/lib/net/public-address";
import { defaultResolver } from "@/lib/net/public-address";
import { pinnedFetch } from "@/lib/net/pinned-fetch";
import { readBodyCapped } from "@/lib/net/read-capped";
import { safeFetch, UnsafeTargetError, type SafeFetchOptions } from "@/lib/net/safe-fetch";
import { resolve } from "@/lib/resolve/lookup";
import { judgeChallenge, type DiagnoseBody, type DiagnoseCatalog, type JudgeInput } from "./judge";
import { parseChallengeText } from "./parse";
import { readReadiness, type Readiness } from "./readiness";

export const DIAGNOSE_BODY_CAP_BYTES = 64 * 1024;
export const DIAGNOSE_TIMEOUT_MS = 10_000;
const UA = "vet402-diagnose/1.0 (+https://vet402.com/docs/api)";

export type { DiagnoseBody, DiagnoseCatalog, JudgeInput, RecommendedAccept } from "./judge";
export { judgeChallenge } from "./judge";

type FetchImpl = NonNullable<SafeFetchOptions["fetchImpl"]>;

export type DiagnoseLiveInput = {
  url: string;
  method?: string;
  fetchImpl?: FetchImpl;
  resolve?: AddressResolver;
  now?: () => Date;
  dbPresent?: boolean;
  catalogLookup?: () => Promise<"absent" | "listed">;
  timeoutMs?: number;
};

export type DiagnoseLiveResult =
  | { ok: true; body: DiagnoseBody }
  | { ok: false; status: 400; error: "unsafe_target" };

function methodOf(method: string | undefined): "GET" | "POST" {
  return method?.toUpperCase() === "POST" ? "POST" : "GET";
}

function checkUrl(url: string, method: "GET" | "POST"): string {
  return `https://vet402.com/api/v1/check?url=${encodeURIComponent(url)}&method=${method}`;
}

async function loadCatalog(input: DiagnoseLiveInput, method: "GET" | "POST"): Promise<DiagnoseCatalog | null> {
  if (input.catalogLookup) {
    const hit = await input.catalogLookup();
    return hit === "listed" ? { listed: true, check_url: checkUrl(input.url, method) } : { listed: false, check_url: null };
  }
  const present = input.dbPresent ?? getDb() !== null;
  if (!present) return null;
  try {
    const found = await resolve(input.url, { method });
    if (found.resource) return { listed: true, check_url: checkUrl(input.url, method) };
    return { listed: false, check_url: null };
  } catch {
    return null;
  }
}

export async function diagnoseLive(input: DiagnoseLiveInput): Promise<DiagnoseLiveResult> {
  const method = methodOf(input.method);
  const now = input.now ?? (() => new Date());
  const fetchImpl = input.fetchImpl ?? pinnedFetch;
  const resolveHost = input.resolve ?? defaultResolver;
  const timeoutMs = input.timeoutMs ?? DIAGNOSE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const judgeBase = (): Omit<JudgeInput, "httpStatus" | "headers" | "bodyText" | "catalog" | "readiness"> => ({
    requestedUrl: input.url,
    method,
    now: now(),
  });

  try {
    let response: Response;
    try {
      response = await safeFetch(
        input.url,
        {
          method,
          headers: {
            accept: "application/json",
            "user-agent": UA,
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
          },
          body: method === "POST" ? "{}" : undefined,
          signal: controller.signal,
        },
        { fetchImpl, resolve: resolveHost, httpsOnly: true },
      );
    } catch (error) {
      if (error instanceof UnsafeTargetError) return { ok: false, status: 400, error: "unsafe_target" };
      const catalog = await loadCatalog(input, method);
      return {
        ok: true,
        body: judgeChallenge({ ...judgeBase(), httpStatus: null, headers: new Headers(), bodyText: "", catalog }),
      };
    }

    const bodyText = await readBodyCapped(response, DIAGNOSE_BODY_CAP_BYTES);
    const catalog = await loadCatalog(input, method);
    let readiness: Record<string, Readiness> | undefined;
    if (response.status === 402) {
      const parsed = parseChallengeText(bodyText);
      if (parsed?.versionOk) {
        try {
          readiness = await readReadiness({
            accepts: parsed.accepts,
            fetchImpl,
            resolve: resolveHost,
            signal: controller.signal,
            maxBytes: DIAGNOSE_BODY_CAP_BYTES,
          });
        } catch {
          readiness = undefined;
        }
      }
    }
    return {
      ok: true,
      body: judgeChallenge({
        ...judgeBase(),
        httpStatus: response.status,
        headers: response.headers,
        bodyText,
        catalog,
        readiness,
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}

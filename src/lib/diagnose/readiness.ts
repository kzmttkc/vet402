// 受け取り口座の準備。公開 RPC を注入された fetch で 1 回読む。読めなければ unreadable。
import type { AddressResolver } from "@/lib/net/public-address";
import { readBodyCapped } from "@/lib/net/read-capped";
import { safeFetch, type SafeFetchOptions } from "@/lib/net/safe-fetch";
import { canonicalNetwork, isRlusdCurrency, needsAccountReadiness, RLUSD_ISSUER, STELLAR_USDC_ISSUER } from "./assets";
import type { ParsedAccept } from "./parse";

export type Readiness = "ready" | "inactive" | "no_trustline" | "unreadable";

export const XRPL_RPC_URL = "https://s1.ripple.com:51234/";
export const STELLAR_HORIZON_URL = "https://horizon.stellar.org";

const READINESS_CAP = 4;
const UA = "vet402-diagnose/1.0 (+https://vet402.com/docs/api)";

type FetchImpl = NonNullable<SafeFetchOptions["fetchImpl"]>;

export type ReadinessInput = {
  accepts: ParsedAccept[];
  fetchImpl: FetchImpl;
  resolve: AddressResolver;
  signal: AbortSignal;
  maxBytes: number;
};

function issuerOf(accept: ParsedAccept): string | null {
  const issuer = accept.extra?.issuer;
  return typeof issuer === "string" && issuer.length > 0 ? issuer : null;
}

function targetsOf(accepts: ParsedAccept[]): ParsedAccept[] {
  const seen = new Set<string>();
  const out: ParsedAccept[] = [];
  for (const accept of accepts) {
    if (!needsAccountReadiness(accept.network)) continue;
    if (seen.has(accept.payTo)) continue;
    seen.add(accept.payTo);
    out.push(accept);
  }
  return out;
}

async function postJson(input: ReadinessInput, url: string, body: unknown): Promise<unknown | null> {
  if (input.signal.aborted) return null;
  try {
    const response = await safeFetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify(body),
        signal: input.signal,
      },
      { fetchImpl: input.fetchImpl, resolve: input.resolve, httpsOnly: true },
    );
    const text = await readBodyCapped(response, input.maxBytes);
    if (!response.ok) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function getText(input: ReadinessInput, url: string): Promise<{ status: number; json: unknown | null }> {
  if (input.signal.aborted) return { status: 0, json: null };
  try {
    const response = await safeFetch(
      url,
      { method: "GET", headers: { "user-agent": UA }, signal: input.signal },
      { fetchImpl: input.fetchImpl, resolve: input.resolve, httpsOnly: true },
    );
    const text = await readBodyCapped(response, input.maxBytes);
    let json: unknown | null = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

function rpcBody(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  if (root.result && typeof root.result === "object") return root.result as Record<string, unknown>;
  return root;
}

async function readXrpl(input: ReadinessInput, accept: ParsedAccept): Promise<Readiness> {
  const info = rpcBody(await postJson(input, XRPL_RPC_URL, {
    method: "account_info",
    params: [{ account: accept.payTo, ledger_index: "validated" }],
  }));
  if (!info) return "unreadable";
  if (info.error === "actNotFound") return "inactive";
  if (info.status !== "success" || !info.account_data) return "unreadable";
  const issuer = issuerOf(accept) ?? RLUSD_ISSUER;
  const lines = rpcBody(await postJson(input, XRPL_RPC_URL, {
    method: "account_lines",
    params: [{ account: accept.payTo, peer: issuer, ledger_index: "validated" }],
  }));
  if (!lines || lines.status !== "success" || !Array.isArray(lines.lines)) return "unreadable";
  const ready = lines.lines.some((line) => {
    if (!line || typeof line !== "object") return false;
    const row = line as { currency?: unknown; account?: unknown };
    return typeof row.currency === "string" && isRlusdCurrency(row.currency) && row.account === issuer;
  });
  return ready ? "ready" : "no_trustline";
}

async function readStellar(input: ReadinessInput, accept: ParsedAccept): Promise<Readiness> {
  const url = `${STELLAR_HORIZON_URL}/accounts/${encodeURIComponent(accept.payTo)}`;
  const got = await getText(input, url);
  if (got.status === 404) return "no_trustline";
  if (got.status !== 200 || !got.json || typeof got.json !== "object") return "unreadable";
  const balances = (got.json as { balances?: unknown }).balances;
  if (!Array.isArray(balances)) return "no_trustline";
  const ready = balances.some((row) => {
    if (!row || typeof row !== "object") return false;
    const balance = row as { asset_code?: unknown; asset_issuer?: unknown };
    return balance.asset_code === "USDC" && balance.asset_issuer === STELLAR_USDC_ISSUER;
  });
  return ready ? "ready" : "no_trustline";
}

export async function readReadiness(input: ReadinessInput): Promise<Record<string, Readiness>> {
  const targets = targetsOf(input.accepts);
  const out: Record<string, Readiness> = {};
  const checked = targets.slice(0, READINESS_CAP);
  for (const extra of targets.slice(READINESS_CAP)) out[extra.payTo] = "unreadable";
  for (const accept of checked) {
    const network = accept.network;
    try {
      if (canonicalNetwork(network) === "xrpl:0") out[accept.payTo] = await readXrpl(input, accept);
      else out[accept.payTo] = await readStellar(input, accept);
    } catch {
      out[accept.payTo] = "unreadable";
    }
  }
  return out;
}

// 402 の読み取り。支払い側のパーサは使わない（欠けた scheme を exact で埋めない）。
import { canonicalNetwork } from "./assets";

export type ParsedAccept = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  resource: string | null;
  extra: Record<string, unknown> | null;
  index: number;
};

export type ParsedChallenge = {
  versionOk: boolean;
  accepts: ParsedAccept[];
  topResource: string | null;
};

export function decodeHeader(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return trimmed;
  const cleaned = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const pad = cleaned.length % 4 === 0 ? cleaned : cleaned + "=".repeat(4 - (cleaned.length % 4));
  try {
    const text = Buffer.from(pad, "base64").toString("utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

function readResource(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string") {
    const url = (value as { url: string }).url.trim();
    return url || null;
  }
  return null;
}

function versionOk(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return n === 1 || n === 2;
}

function readAccept(raw: unknown, index: number): ParsedAccept | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const amount = typeof row.amount === "string" ? row.amount : typeof row.maxAmountRequired === "string" ? row.maxAmountRequired : "";
  const extra = row.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? (row.extra as Record<string, unknown>) : null;
  return {
    scheme: typeof row.scheme === "string" ? row.scheme : "",
    network: typeof row.network === "string" ? row.network : "",
    amount,
    asset: typeof row.asset === "string" ? row.asset : "",
    payTo: typeof row.payTo === "string" ? row.payTo : "",
    resource: readResource(row.resource),
    extra,
    index,
  };
}

export function parseChallengeText(text: string): ParsedChallenge | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const acceptsRaw = root.accepts;
  if (!Array.isArray(acceptsRaw) || acceptsRaw.length === 0) {
    return { versionOk: false, accepts: [], topResource: readResource(root.resource) };
  }
  const accepts: ParsedAccept[] = [];
  for (let i = 0; i < acceptsRaw.length; i += 1) {
    const row = readAccept(acceptsRaw[i], i);
    if (!row) return { versionOk: false, accepts: [], topResource: readResource(root.resource) };
    accepts.push(row);
  }
  return {
    versionOk: versionOk(root.x402Version),
    accepts,
    topResource: readResource(root.resource),
  };
}

export function resourceUrls(challenge: ParsedChallenge): string[] {
  const out: string[] = [];
  if (challenge.topResource) out.push(challenge.topResource);
  for (const accept of challenge.accepts) {
    if (accept.resource) out.push(accept.resource);
  }
  return out;
}

/** protocol + host + path（末尾スラッシュ 1 つは無視）+ search。 */
export function sameResource(left: string, right: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(left);
    b = new URL(right);
  } catch {
    return false;
  }
  const path = (value: string) => (value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value);
  return a.protocol === b.protocol && a.host === b.host && path(a.pathname) === path(b.pathname) && a.search === b.search;
}

function normToken(value: string): string {
  if (value.startsWith("0x") || value.startsWith("0X")) return value.toLowerCase();
  return value;
}

function normNetwork(value: string): string {
  const caip = canonicalNetwork(value);
  const cut = caip.indexOf(":");
  if (cut === -1) return caip.toLowerCase();
  return caip.slice(0, cut).toLowerCase() + caip.slice(cut);
}

function normUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return value;
  }
}

/** ヘッダと本文が同じ挑戦か。表記ゆれ（0x の大文字、既知の網の別名）は同じと見る。 */
export function challengeFinger(challenge: ParsedChallenge): string {
  return JSON.stringify({
    resources: resourceUrls(challenge).map(normUrl).sort(),
    accepts: challenge.accepts.map((accept) => ({
      scheme: accept.scheme.toLowerCase(),
      amount: accept.amount,
      asset: normToken(accept.asset),
      network: normNetwork(accept.network),
      payTo: normToken(accept.payTo),
      resource: accept.resource ? normUrl(accept.resource) : "",
    })),
  });
}

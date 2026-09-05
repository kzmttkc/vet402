/**
 * 読むだけの計測。**書き込みも署名もしない。**
 *
 * ここにあるのは「本番の口を素で叩いて、返ってきたものをそのまま持つ」処理だけで、
 * 判定は一切していない。判定は `@vet402/sdk` の `payOrRefuse` が持つ——
 * デモが判定を写経すると、映っているものと本当に効いているものが分かれてしまう。
 */

/** 本番 API。 */
export const VET402_API = "https://vet402.com/api/v1";

export type Reply = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  headers: { get: (name: string) => string | null | undefined };
};

export type Instrumented = {
  fetch: typeof fetch;
  /** 出した順に並ぶ HTTP 呼び出し。**鍵は emit が伏せる**（ここでは加工しない）。 */
  calls: string[];
  /** The Graph の gateway が返した本文そのもの。右カラムはこれを映す。 */
  subgraphRaw: unknown;
};

/**
 * 通信を包んで、**呼び出しの一覧**と **The Graph の生の応答**を控える。
 * 応答本文は一度しか読めないので、控えたあとに読み直せる形で渡し直す。
 */
export function instrument(base: typeof fetch): Instrumented {
  const record: Instrumented = { fetch: null as unknown as typeof fetch, calls: [], subgraphRaw: undefined };
  record.fetch = (async (url: unknown, init?: Record<string, unknown>) => {
    const target = String(url);
    const method = typeof init?.method === "string" ? init.method : "GET";
    record.calls.push(`${method} ${target}`);
    const response = (await base(target as string, init as RequestInit)) as unknown as Reply;
    // gateway の x402 口（`/api/x402/`）は売り手であって subgraph ではない。混ぜない。
    const isSubgraph = target.includes("gateway.thegraph.com/api/") && !target.includes("/api/x402/");
    if (!isSubgraph || typeof response.text !== "function") return response as unknown as Response;
    const body = await response.text();
    try {
      record.subgraphRaw = JSON.parse(body);
    } catch {
      record.subgraphRaw = { unparseable: true };
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return record;
}

/** 資源 ID（本番の規則: sha256("<METHOD> <正規化URL>")・WINDOW_PLAN §3.1）。 */
export async function computeResourceId(method: string, url: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${method} ${url}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function headerOf(response: Reply, name: string): string | null {
  for (const candidate of [name, name.toUpperCase(), name.toLowerCase()]) {
    const value = response.headers?.get?.(candidate);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export type Challenge = { x402Version: 1 | 2; accepts: Record<string, unknown>[] };

/**
 * 402 チャレンジを、**支払いヘッダを付けずに**取る。返ってこなければ null——
 * **取れなかったものを数字で埋めない**。
 */
export async function readChallenge(
  fetchFn: typeof fetch,
  method: string,
  url: string,
  body?: string,
): Promise<Challenge | null> {
  const response = (await fetchFn(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
  } as RequestInit)) as unknown as Reply;
  const raw = headerOf(response, "payment-required");
  if (!raw) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)))) as {
      x402Version?: unknown;
      accepts?: unknown;
    };
    if (!Array.isArray(json.accepts) || json.accepts.length === 0) return null;
    return { x402Version: json.x402Version === 1 ? 1 : 2, accepts: json.accepts as Record<string, unknown>[] };
  } catch {
    return null;
  }
}

/** Base メインネットの正規 USDC 建ての accept を選ぶ。無ければ先頭を返す（判定はしない）。 */
export function pickBaseUsdcAccept(accepts: Record<string, unknown>[]): Record<string, unknown> {
  const found = accepts.find(
    (a) =>
      a.network === "eip155:8453" &&
      String(a.asset ?? "").toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" &&
      a.scheme === "exact",
  );
  return found ?? accepts[0];
}

export async function readJson(
  fetchFn: typeof fetch,
  url: string,
  apiKey: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const response = (await fetchFn(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  } as RequestInit)) as unknown as Reply;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * 足りない環境変数を**名前だけ**言って落ちる。**値は絶対に載せない**
 * （このメッセージも emit を通るが、通る前提で書かない）。
 */
export function requireEnv(env: Record<string, string | undefined>, names: string[]): void {
  const missing = names.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length === 0) return;
  throw new Error(
    `missing environment variable(s): ${missing.join(", ")}. ` +
      "Export them before running this demo; the values are never printed.",
  );
}

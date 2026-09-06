/**
 * 読むだけの計測。**書き込みも署名もしない。**
 *
 * ここにあるのは「本番の口を素で叩いて、返ってきたものをそのまま持つ」処理だけで、
 * 判定は一切していない。判定は `@vet402/sdk` の `payOrRefuse` が持つ——
 * デモが判定を写経すると、映っているものと本当に効いているものが分かれてしまう。
 */

import { BASE_CHAIN, BASE_USDC } from "../../../packages/sdk/dist/index.js";

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
 * v1 の綴りを v2 の形へ揃える（SDK `pay-or-refuse.ts` の `normalizeAccept` と同じ規則）。
 * 実在する v1 の壁は `network: "base"` と `maxAmountRequired` を使う。ここで揃えないと
 * v1 の 402 は「払える accept が無い」に見え、画が嘘になる。読めない形は null（数字で埋めない）。
 */
export function normalizeAccept(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const amount =
    typeof rec.amount === "string" ? rec.amount
    : typeof rec.maxAmountRequired === "string" ? rec.maxAmountRequired
    : null;
  if (amount === null || typeof rec.payTo !== "string") return null;
  if (typeof rec.scheme !== "string" || typeof rec.asset !== "string") return null;
  const network =
    rec.network === "base" ? BASE_CHAIN
    : rec.network === "base-sepolia" ? "eip155:84532"
    : typeof rec.network === "string" ? rec.network
    : "";
  return {
    scheme: rec.scheme,
    network,
    amount,
    asset: rec.asset,
    payTo: rec.payTo,
    ...(typeof rec.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: rec.maxTimeoutSeconds } : {}),
    ...(typeof rec.extra === "object" && rec.extra !== null ? { extra: rec.extra } : {}),
  };
}

function decodeChallenge(raw: string): Challenge | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)))) as {
      x402Version?: unknown;
      accepts?: unknown;
    };
    if (!Array.isArray(json.accepts) || json.accepts.length === 0) return null;
    const accepts = json.accepts.map(normalizeAccept).filter((a): a is Record<string, unknown> => a !== null);
    if (accepts.length === 0) return null;
    return { x402Version: json.x402Version === 1 ? 1 : 2, accepts };
  } catch {
    return null;
  }
}

export type ChallengeProbe = {
  /** 接続できなければ null。 */
  status: number | null;
  challenge: Challenge | null;
  /** 接続不能のときの原因（鍵は含まない——URL と例外の本文だけ）。 */
  error: string | null;
};

/**
 * 402 チャレンジを、**支払いヘッダを付けずに**取り、**取れなかった理由も持ち帰る**。
 * `judge` はここで「x402 の口ではない」を1行で言うために、ステータスと例外を要る。
 * 読むのは SDK と同じ `PAYMENT-REQUIRED` ヘッダだけ（v1 の本文だけのチャレンジは SDK も読まない）。
 */
export async function probeChallenge(
  fetchFn: typeof fetch,
  method: string,
  url: string,
  body?: string,
): Promise<ChallengeProbe> {
  let response: Reply;
  try {
    response = (await fetchFn(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
    } as RequestInit)) as unknown as Reply;
  } catch (error) {
    return { status: null, challenge: null, error: error instanceof Error ? error.message : String(error) };
  }
  const raw = headerOf(response, "payment-required");
  return { status: response.status, challenge: raw ? decodeChallenge(raw) : null, error: null };
}

/**
 * 402 チャレンジを取る。返ってこなければ null——**取れなかったものを数字で埋めない**。
 * 接続不能は呼び手へ投げる（`pay` は固定の相手なので、繋がらないのは想定外）。
 */
export async function readChallenge(
  fetchFn: typeof fetch,
  method: string,
  url: string,
  body?: string,
): Promise<Challenge | null> {
  const probe = await probeChallenge(fetchFn, method, url, body);
  if (probe.error !== null) throw new Error(probe.error);
  return probe.challenge;
}

/**
 * この accept は**プロトコル上そもそも払える形か**。SDK `isProtocolEligible` と同じ4条件
 * （scheme / network / asset / 転送方式）。チェーンと資産は SDK の定数を引く——ここに
 * 16 進を書いた瞬間、SDK が変わっても画が追随しない。
 */
export function isProtocolEligible(a: Record<string, unknown>): boolean {
  if (a.scheme !== "exact") return false;
  if (a.network !== BASE_CHAIN) return false;
  if (String(a.asset ?? "").toLowerCase() !== BASE_USDC.toLowerCase()) return false;
  const transfer = (a.extra as { assetTransferMethod?: unknown } | undefined)?.assetTransferMethod;
  return transfer === undefined || transfer === "eip3009";
}

/** EIP-712 ドメインがトークンのもの（USD Coin / 2）と矛盾しないか。SDK `hasCanonicalUsdcDomain` と同じ。 */
export function hasCanonicalUsdcDomain(a: Record<string, unknown>): boolean {
  const extra = a.extra as { name?: unknown; version?: unknown } | undefined;
  return (extra?.name === undefined || extra.name === "USD Coin") && (extra?.version === undefined || extra.version === "2");
}

/**
 * **SDK が選ぶのと同じ accept を選ぶ。** 意味論は `packages/sdk/src/pay-or-refuse.ts` の
 * `selectAccept`（さらにその元は本番 `src/lib/observatory/x402-payer.ts`）。
 *
 * 2026-09-05 まで、ここは条件に合うものが無ければ**先頭を返して**いた。実測の 402 は
 * accept を3件返す（Base USDC / Solana / `GatewayWalletBatched` ドメイン）ので、
 * 先頭を返す実装は**払えない accept を「これに署名します」として画に映す**。
 * 映っているものと本当に署名されるものが違えば、それは動画としての嘘である。
 * **1件も無ければ null**——無いことは、無いと書く。
 */
export function selectPayableAccept(
  accepts: Record<string, unknown>[],
): Record<string, unknown> | null {
  const eligible = accepts.filter(isProtocolEligible);
  if (eligible.length === 0) return null;
  // EIP-712 ドメインが正規のものを優先する（矛盾する accept は署名しても決済され得ない）。
  return eligible.find(hasCanonicalUsdcDomain) ?? eligible[0];
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
 * **想定内の失敗。** `run.ts` の `failureLines` はこれを整形済み1行にし、スタックを出さない
 * （審査員が最初に踏む場所で `at …` が7行出ると「壊れている」と読まれる）。
 * それ以外の Error は原因を隠さないためスタックを残す。
 */
export class ExpectedFailure extends Error {
  override readonly name: string = "ExpectedFailure";
}

/**
 * 足りない環境変数を**名前だけ**言って落ちる。**値は絶対に載せない**
 * （このメッセージも emit を通るが、通る前提で書かない）。
 */
export class MissingEnvError extends ExpectedFailure {
  override readonly name = "MissingEnvError";
}

/** 渡された URL が x402 の口ではない（402 が取れない・接続不能）。`judge` だけが投げる。 */
export class NotX402Error extends ExpectedFailure {
  override readonly name = "NotX402Error";
}

/** 引数・policy の呼び出し側エラー。SDK の `invalid_policy` / `invalid_evidence_policy` と同じ型。 */
export class PolicyError extends ExpectedFailure {
  override readonly name = "PolicyError";
}

export function requireEnv(env: Record<string, string | undefined>, names: string[]): void {
  const missing = names.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length === 0) return;
  throw new MissingEnvError(
    `missing environment variable(s): ${missing.join(", ")}. ` +
      "Export them before running this demo; the values are never printed.",
  );
}

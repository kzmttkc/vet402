// ============================================================
// vet402 Observatory L0 — MPP directory source（Tempo・2026-09-17）。
//
// Bazaar（cdp_bazaar）・PayAI に続く 3 つ目の出どころ。`GET https://mpp.dev/api/services`
// の 1 回の取得で全サービスが返る（2026-09-17 実測: 142 サービス・1,457 endpoint・
// うち tempo+charge の従量課金 1,071・1,053 件が $1 以下・通貨は USDC.e のみ）。
//
// Bazaar と違うこと:
//   - 受取先（recipient）は directory に**無い**。生きた 402 の challenge にだけ載る。
//     だから pay_to は null で入れ、L0 が challenge を読んだときに学習する
//     （probe-runner・pay_to IS NULL の行にだけ書く）。日次の再同期は学習した pay_to を
//     消さない（catalog-sync の keepLearnedPayTo）。
//   - ページングが無い。1 回で取り、上限（MAX_ITEMS）を超えたぶんは切って complete=false と
//     言う（黙って全部取れたことにしない）。
//   - `:id` `{id}` のようなパス変数は Bazaar と同じ扱い: カタログには入れ、L0 は path_template で
//     unverified、L1 は候補にしない（path-template.ts が正典）。
//
// snapshot / delisting は source ごとに独立（x402_catalog_snapshots.source）なので、
// cdp_bazaar の差分計算はこの source が増えても変わらない。
// ============================================================
import { normalizeResourceKey, type CatalogFetchResult, type ParsedCatalogItem } from "./catalog-source";
import { syncCatalog, type SyncSummary } from "./catalog-sync";
import { MPP_CHARGE_SCHEME, MPP_DIRECTORY_SOURCE, TEMPO_CHAIN_ID, TEMPO_MAINNET_CAIP2 } from "./mpp-payer";

export { MPP_DIRECTORY_SOURCE };
export const MPP_DIRECTORY_URL_DEFAULT = "https://mpp.dev/api/services";
/** 1 回の同期で受け取る endpoint の上限（実測 1,457 の余裕）。超えたぶんは切り、complete=false。 */
export const MPP_DIRECTORY_MAX_ITEMS = 2_000;

const DECLARED_METHODS = new Set(["GET", "POST", "HEAD", "DELETE"]);

export function mppDirectoryUrl(): string {
  const raw = process.env.MPP_DIRECTORY_URL?.trim();
  return raw && raw.length > 0 ? raw : MPP_DIRECTORY_URL_DEFAULT;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function stripNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[stripNul(k)] = stripNul(v);
    return out as T;
  }
  return value;
}

/** serviceUrl と path をスラッシュ 1 本で結ぶ（`https://a/` + `/v1/x` → `https://a/v1/x`）。 */
export function joinServiceUrl(serviceUrl: string, path: string): string {
  const base = serviceUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/**
 * directory の 1 サービスの 1 endpoint を、Bazaar と同じ行の形（ParsedCatalogItem）へ写す。
 * tempo/charge 以外（session・subscription・stripe 等）は null——測る対象ではない。
 */
export function parseMppEndpoint(service: unknown, endpoint: unknown): ParsedCatalogItem | null {
  return parseMppEndpointPrepared(prepareService(service), stripNul(asRecord(endpoint) ?? {}));
}

/** service の NUL 除去を 1 回だけ行う（endpoints は各行で別に除去する・レビュー #9）。 */
function prepareService(service: unknown): Record<string, unknown> {
  const rec = asRecord(service) ?? {};
  const { endpoints: _endpoints, ...rest } = rec;
  void _endpoints;
  return stripNul(rest);
}

function parseMppEndpointPrepared(svc: Record<string, unknown>, ep: Record<string, unknown>): ParsedCatalogItem | null {
  const serviceUrl = asString(svc.serviceUrl) ?? asString(svc.url);
  const path = asString(ep.path);
  if (!serviceUrl || !path) return null;
  const payment = asRecord(ep.payment);
  if (!payment) return null;
  if (payment.method !== "tempo" || payment.intent !== "charge") return null;
  const currency = asString(payment.currency);
  const amount = asString(payment.amount) ?? (typeof payment.amount === "number" ? String(payment.amount) : null);
  if (!currency || !amount) return null;
  // Tempo mainnet（4217）だけを測る。Moderato（42431）や他のチェーン ID は行にしない（レビュー #4）。
  const chainId = typeof payment.chainId === "number" ? payment.chainId : TEMPO_CHAIN_ID;
  if (chainId !== TEMPO_CHAIN_ID) return null;
  const network = TEMPO_MAINNET_CAIP2;
  const realm = asString(svc.realm);
  const rawMethod = asString(ep.method)?.toUpperCase() ?? null;
  const method = rawMethod && DECLARED_METHODS.has(rawMethod) ? rawMethod : null;
  const resourceUrl = joinServiceUrl(serviceUrl, path);
  const description = asString(ep.description) ?? asString(svc.name);
  const decimals = typeof payment.decimals === "number" ? payment.decimals : null;
  const unitType = asString(payment.unitType);
  return {
    resourceKey: normalizeResourceKey(resourceUrl),
    resourceUrl,
    method,
    network,
    // 受取先は directory に無い。L0 が生きた challenge から学習する。
    payTo: null,
    priceAmount: amount,
    priceAsset: currency.toLowerCase(),
    description,
    // OpenAPI（docs.apiReference）は取りに行かない（サービスごとに 1 回の追加 fetch・
    // 形も Bazaar の input/output 宣言と違う）。宣言スキーマ無し＝L2 は no_declaration。
    declaredSchema: null,
    qualityCalls30d: null,
    qualityPayers30d: null,
    qualityLastCalledAt: null,
    rawAccepts: [
      {
        scheme: MPP_CHARGE_SCHEME,
        network,
        asset: currency.toLowerCase(),
        amount,
        payTo: null,
        extra: {
          realm,
          intent: "charge",
          unitType,
          decimals,
          serviceId: asString(svc.id),
          integration: asString(svc.integration),
          status: asString(svc.status),
          docs: asRecord(svc.docs) ?? null,
        },
      },
    ],
  };
}

/** directory の JSON 全体 → カタログ行。resourceKey で重複を落とす（先勝ち）。 */
export function parseMppDirectory(body: unknown): { items: ParsedCatalogItem[]; endpointCount: number; complete: boolean } {
  const rec = asRecord(body);
  const services = Array.isArray(rec?.services) ? rec!.services : [];
  const byKey = new Map<string, ParsedCatalogItem>();
  let endpointCount = 0;
  let truncated = false;
  for (const service of services) {
    const endpoints = Array.isArray(asRecord(service)?.endpoints) ? (asRecord(service)!.endpoints as unknown[]) : [];
    const svc = prepareService(service);
    for (const endpoint of endpoints) {
      const item = parseMppEndpointPrepared(svc, stripNul(asRecord(endpoint) ?? {}));
      if (!item) continue;
      endpointCount++;
      if (byKey.size >= MPP_DIRECTORY_MAX_ITEMS) {
        truncated = true;
        continue;
      }
      if (!byKey.has(item.resourceKey)) byKey.set(item.resourceKey, item);
    }
  }
  return { items: [...byKey.values()], endpointCount, complete: !truncated };
}

/** 1 回の fetch。失敗・非 JSON は complete=false・items 空（delisting を出さない側へ倒す）。 */
export async function fetchMppDirectory(
  options: { fetchImpl?: (url: string) => Promise<Response>; url?: string; timeoutMs?: number } = {},
): Promise<CatalogFetchResult> {
  const { fetchImpl = fetch, url = mppDirectoryUrl(), timeoutMs = 30_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body: unknown = null;
  try {
    const res = await (fetchImpl === fetch
      ? fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "vet402-observatory-catalog/1.0 (+https://vet402.com/observatory/methodology)" } })
      : fetchImpl(url));
    if (res.ok) body = await res.json();
  } catch {
    body = null;
  } finally {
    clearTimeout(timer);
  }
  if (body === null) return { items: [], totalCount: 0, fetchedCount: 0, complete: false };
  const parsed = parseMppDirectory(body);
  return {
    items: parsed.items,
    totalCount: parsed.endpointCount,
    fetchedCount: parsed.items.length,
    complete: parsed.complete && parsed.items.length > 0,
  };
}

/** 本番配線: directory → x402_endpoints（source = mpp_directory）。学習済み pay_to は保つ。 */
export async function syncMppDirectory(options: { fetchResult?: CatalogFetchResult; today?: string } = {}): Promise<SyncSummary> {
  const fetchResult = options.fetchResult ?? (await fetchMppDirectory());
  return await syncCatalog({ fetchResult, today: options.today, source: MPP_DIRECTORY_SOURCE, keepLearnedPayTo: true });
}

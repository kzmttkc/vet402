// ============================================================
// vet402 が自分で足す出品（operator listings・2026-11-22）。
//
// なぜ在るか: vet402 が読む目録（CDP Bazaar・Circle x402 discovery・MPP directory）に載らない
// x402 の売り手も、同じ L0 / L1 で測りたい。目録の代わりに、このファイルに書いた短い一覧を
// 毎日の目録同期（/api/cron/catalog-sync-aux）が x402_endpoints（source = 'operator'）へ入れる。
// 買うのは通常の L1 の経路で、予算・上限・署名は他の出どころと同じ（特別な経路は無い）。
//
// 公開の約束（public/llms.txt・docs/openapi.yaml・配達フィードの listed_in = 'operator'・
// 記録ページの Source）:
//   - 一覧はこのファイルだけ。足すのも消すのも commit で、理由と日付を各行に書く。
//   - 売り手は払っても頼んでも載らない。vet402 が自分の判断で足す。
//   - 行を消すと、次の同期でその出品は delisted になる（完全な一覧なので不在が証明できる）。
//
// 載せてよい行（parseOperatorListings が確かめる。破れていれば同期は例外で止まる）:
//   - https の URL、method は GET だけ。L1 は 402 が本文を宣言しない POST に `{}` を送るので、
//     本文の要る POST を載せると、vet402 の側の不備で売り手に失敗の記録を付ける。
//   - network はメインネットの CAIP-2、payTo は 0x の 40 桁、amount は正の整数（原子単位）。
//   - 値は売り手の生きた 402（payment-required ヘッダ）から写す。L0 が毎回その 402 と突き合わせる。
//
// 2026-11-22 の検討: gateway.usebuy.ai（Celo・eip155:42220・USDC 0xcebA…118C・5000 = 0.005 USDC）。
// /v1/catalog の有料 170 件（提供中 149 件）はすべて POST で、提供中のうち 148 件は本文の必須項目を
// 持つ（残る 1 件は Celo の JSON-RPC 中継 chainstack.celo で、空の本文では意味のある要求にならない）。
// GET の有料出品が 0 件なので、上の規則どおり載せていない。
// ============================================================
import { isImportableResourceUrl, normalizeResourceKey, type CatalogFetchResult, type ParsedCatalogItem } from "./catalog-source";
import { isMainnet } from "./chains";

/** x402_endpoints.source と x402_catalog_snapshots.source に入る値。配達フィードの listed_in も同じ文字列。 */
export const OPERATOR_SOURCE = "operator";

/** 公開の文面が名指しするファイル（リポジトリの相対パス）。 */
export const OPERATOR_LISTINGS_FILE = "src/lib/observatory/operator-listings.ts";

/** 公開リポジトリ上のこのファイル。記録ページの Source 欄がリンクする。 */
export const OPERATOR_LISTINGS_URL = `https://github.com/kzmttkc/vet402/blob/main/${OPERATOR_LISTINGS_FILE}`;

/** 記録ページの Source 欄に 'operator' と並べる 1 文。 */
export const OPERATOR_SOURCE_NOTE =
  "Not from a catalog. vet402 added this seller itself from a checked-in list that names the reason and date. Sellers cannot pay or ask to be added.";

export type OperatorListing = {
  url: string;
  method: "GET";
  /** CAIP-2（例 eip155:42220）。 */
  network: string;
  payTo: string;
  /** トークンのコントラクト。 */
  asset: string;
  /** 原子単位の整数の文字列。 */
  amount: string;
  /** 402 の accept の extra（EIP-712 の name / version）。 */
  extra?: { name: string; version: string };
  maxTimeoutSeconds?: number;
  /** なぜ足したか（1 文）。 */
  reason: string;
  /** 足した日（YYYY-MM-DD・UTC）。 */
  addedOn: string;
};

export const OPERATOR_LISTINGS: readonly OperatorListing[] = [];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^[1-9][0-9]{0,29}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 一覧を行の形に直す。規則に合わない行・重複は例外（黙って捨てない）。 */
export function parseOperatorListings(list: readonly OperatorListing[]): ParsedCatalogItem[] {
  const seen = new Set<string>();
  return list.map((entry, i) => {
    const where = `operator listing #${i} (${String(entry?.url)})`;
    if (!isImportableResourceUrl(entry.url) || new URL(entry.url).protocol !== "https:") throw new Error(`${where}: url must be https`);
    if (entry.method !== "GET") throw new Error(`${where}: method must be GET`);
    if (!entry.network.startsWith("eip155:") || !isMainnet(entry.network)) throw new Error(`${where}: network must be an EVM mainnet CAIP-2 id`);
    if (!EVM_ADDRESS.test(entry.payTo)) throw new Error(`${where}: payTo must be a 0x address`);
    if (!EVM_ADDRESS.test(entry.asset)) throw new Error(`${where}: asset must be a 0x address`);
    if (!AMOUNT.test(entry.amount)) throw new Error(`${where}: amount must be a positive integer string`);
    if (entry.reason.trim() === "") throw new Error(`${where}: reason is required`);
    if (!DATE.test(entry.addedOn) || Number.isNaN(Date.parse(`${entry.addedOn}T00:00:00Z`))) throw new Error(`${where}: addedOn must be YYYY-MM-DD`);
    const resourceKey = normalizeResourceKey(entry.url);
    if (seen.has(resourceKey)) throw new Error(`${where}: duplicate url`);
    seen.add(resourceKey);
    const accept = {
      scheme: "exact",
      network: entry.network,
      amount: entry.amount,
      asset: entry.asset,
      payTo: entry.payTo,
      ...(entry.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: entry.maxTimeoutSeconds } : {}),
      ...(entry.extra ? { extra: entry.extra } : {}),
    };
    return {
      resourceKey,
      resourceUrl: entry.url,
      method: "GET",
      network: entry.network,
      payTo: entry.payTo.toLowerCase(),
      priceAmount: entry.amount,
      priceAsset: entry.asset,
      description: null,
      declaredSchema: null,
      declaredInput: null,
      qualityCalls30d: null,
      qualityPayers30d: null,
      qualityLastCalledAt: null,
      bazaarCurated: null,
      rawAccepts: [accept],
    };
  });
}

/** 一覧は手元に全部あるので、取得は常に完全（消した行は次の同期で delisted になる）。 */
export function operatorFetchResult(list: readonly OperatorListing[] = OPERATOR_LISTINGS): CatalogFetchResult {
  const items = parseOperatorListings(list);
  return { items, totalCount: items.length, fetchedCount: items.length, complete: true };
}

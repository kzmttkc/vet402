// ============================================================
// pay.sh カタログ（solana-foundation/pay-skills）の購入対象一覧（2026-11-24）。
// vet402 が delivery 用に足す。同期は catalog-sync-aux（source = pay_skills）。
// 上限・署名は通常の L1 と同じ。一覧は scripts/build-paysh-catalog.mjs から生成する。
// ============================================================
import { isImportableResourceUrl, normalizeResourceKey, type CatalogFetchResult, type ParsedCatalogItem } from "./catalog-source";
import { isMainnet } from "./chains";
import { OPERATOR_EXAMPLE_BODY_MAX_BYTES } from "./operator-listings";
import { PAY_SKILLS_LISTINGS } from "./pay-skills-listings-data";

export const PAY_SKILLS_SOURCE = "pay_skills";

export const PAY_SKILLS_LISTINGS_FILE = "src/lib/observatory/pay-skills-listings-data.ts";

export const PAY_SKILLS_LISTINGS_URL = `https://github.com/vet402/vet402/blob/main/${PAY_SKILLS_LISTINGS_FILE}`;

export const PAY_SKILLS_SOURCE_NOTE =
  "Not from a catalog fetch. vet402 added pay.sh (solana-foundation/pay-skills) delivery targets from a checked-in generated list. Sellers cannot pay or ask to be added.";

export type PaySkillsListing = {
  url: string;
  method: "GET" | "POST";
  network: string;
  payTo: string;
  asset: string;
  amount: string;
  exampleBody?: string;
  reason: string;
  addedOn: string;
  catalogOrder: number;
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^[1-9][0-9]{0,29}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function canonicalExampleBody(raw: string): string | null {
  if (Buffer.byteLength(raw, "utf8") > OPERATOR_EXAMPLE_BODY_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return JSON.stringify(parsed);
}

export function paySkillsExampleBody(resourceUrl: string, list: readonly PaySkillsListing[] = PAY_SKILLS_LISTINGS): string | null {
  const key = normalizeResourceKey(resourceUrl);
  const entry = list.find((e) => normalizeResourceKey(e.url) === key);
  if (!entry || entry.method !== "POST" || entry.exampleBody === undefined) return null;
  return canonicalExampleBody(entry.exampleBody);
}

export { PAY_SKILLS_LISTINGS };

function payToValid(network: string, payTo: string): boolean {
  if (network.startsWith("solana:")) return payTo.length >= 32 && payTo.length <= 44;
  return EVM_ADDRESS.test(payTo);
}

function assetValid(network: string, asset: string): boolean {
  if (network.startsWith("solana:")) return asset.length >= 32;
  return EVM_ADDRESS.test(asset);
}

export function parsePaySkillsListings(list: readonly PaySkillsListing[]): ParsedCatalogItem[] {
  const seen = new Set<string>();
  return list.map((entry, i) => {
    const where = `pay_skills listing #${i} (${String(entry?.url)})`;
    if (!isImportableResourceUrl(entry.url) || new URL(entry.url).protocol !== "https:") throw new Error(`${where}: url must be https`);
    if (entry.method !== "GET" && entry.method !== "POST") throw new Error(`${where}: method must be GET or POST`);
    if (entry.method === "GET" && entry.exampleBody !== undefined) throw new Error(`${where}: a GET listing carries no exampleBody`);
    if (entry.method === "POST" && (entry.exampleBody === undefined || canonicalExampleBody(entry.exampleBody) === null)) {
      throw new Error(`${where}: a POST listing needs an exampleBody that is a JSON object or array of at most ${OPERATOR_EXAMPLE_BODY_MAX_BYTES} bytes`);
    }
    if (!isMainnet(entry.network)) throw new Error(`${where}: network must be mainnet`);
    if (!payToValid(entry.network, entry.payTo)) throw new Error(`${where}: payTo invalid for network`);
    if (!assetValid(entry.network, entry.asset)) throw new Error(`${where}: asset invalid for network`);
    if (!AMOUNT.test(entry.amount)) throw new Error(`${where}: amount must be a positive integer string`);
    if (entry.reason.trim() === "") throw new Error(`${where}: reason is required`);
    if (!DATE.test(entry.addedOn) || Number.isNaN(Date.parse(`${entry.addedOn}T00:00:00Z`))) throw new Error(`${where}: addedOn must be YYYY-MM-DD`);
    if (!Number.isInteger(entry.catalogOrder) || entry.catalogOrder < 1) throw new Error(`${where}: catalogOrder must be a positive integer`);
    const resourceKey = normalizeResourceKey(entry.url);
    if (seen.has(resourceKey)) throw new Error(`${where}: duplicate url`);
    seen.add(resourceKey);
    const accept = {
      scheme: "exact",
      network: entry.network,
      amount: entry.amount,
      asset: entry.asset,
      payTo: entry.payTo,
      maxTimeoutSeconds: 300,
    };
    return {
      resourceKey,
      resourceUrl: entry.url,
      method: entry.method,
      network: entry.network,
      payTo: entry.network.startsWith("solana:") ? entry.payTo : entry.payTo.toLowerCase(),
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

export function paySkillsFetchResult(list: readonly PaySkillsListing[] = PAY_SKILLS_LISTINGS): CatalogFetchResult {
  const items = parsePaySkillsListings(list);
  return { items, totalCount: items.length, fetchedCount: items.length, complete: true };
}

parsePaySkillsListings(PAY_SKILLS_LISTINGS);
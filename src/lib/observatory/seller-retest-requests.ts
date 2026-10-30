// ============================================================
// 売り手から依頼された 1 回きりの L1 買い直しリスト（2026-10-30・Goldsky 他）。
//
// 目録に無い URL でも、依頼ごとに 1 回だけ Base で買う。完了・期限・402 の照合は
// seller-retest.ts と l1-runner.ts が行う。ここは版管理された依頼の正典だけ。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { BASE_CAIP2, BASE_USDC } from "./x402-payer";

/** x402_endpoints.source — 目録同期（cdp_bazaar / circle_discovery）の diff・reconcile 対象外。 */
export const SELLER_RETEST_REQUEST_SOURCE = "seller_retest_request";

/** 1 回の L1 バッチで処理する依頼の上限（census / retest の枠とは別）。 */
export const SELLER_RETEST_MAX_PER_RUN = 10;

/** 依頼 URL / クエリ / 本文中のプレースホルダ（実行時に L1 の Base 支払い元などへ置換）。 */
export const SELLER_RETEST_PAYER_PLACEHOLDER = "__VET402_BASE_PAYER__";
export const SELLER_RETEST_USDC_PLACEHOLDER = "__BASE_USDC__";
/** Base の固定ブロック番号（feeds blocks 系）。 */
/** Base head に近い固定値（2026-10-30 時点の head ≈ 53,279,184）。 */
export const SELLER_RETEST_BASE_BLOCK_NUMBER = "53279000";

/** L0 候補・L1 候補（依頼レーン以外）から seller_retest_request 行を外す共通条件（x402_endpoints e）。 */
export function notSellerRetestRequestSourceSql(): SQL {
  return sql`e.source <> ${SELLER_RETEST_REQUEST_SOURCE}`;
}

/**
 * 依頼レーンの「署名前の枠」の印（claimSellerRequestAuthSlot が auth_nonce に書く `presign:<rowId>`）。
 * 署名の直後に本物の nonce で上書きされる。この印のままの行は資格情報を一度も出していない。
 */
export const SELLER_REQUEST_PRESIGN_PREFIX = "presign:";

/**
 * x402_l1_purchases の行が「資格情報を出していない」条件（2026-10-30 差し戻し2・B2）。
 * auth_nonce が NULL か、依頼レーンの署名前の枠の印（presign:）。予約の解放・孤児の掃除・失敗の確定の
 * 3 か所がこれで未署名を判定し、印の行は auth_nonce を NULL に戻して普通の未署名の予約と同じ結果にする。
 * 列は修飾しない（各 UPDATE の対象表の auth_nonce）。
 */
export function unsignedAuthNonceSql(): SQL {
  return sql`(auth_nonce IS NULL OR auth_nonce LIKE ${`${SELLER_REQUEST_PRESIGN_PREFIX}%`})`;
}

export type SellerRetestRequest = {
  /** 台帳 raw_response_meta.sellerRequestId に残す安定 ID。 */
  id: string;
  /** 依頼日（ISO 8601・日付部分のみでも可）。 */
  requestedOn: string;
  /** 売り手の登録ドメイン（edge.goldsky.com 等）。 */
  sellerDomain: string;
  /** 完全な https URL（クエリ込み可。プレースホルダ可）。 */
  url: string;
  method: "GET" | "POST";
  /** POST のときの無払い・有払い両方に使う本文（JSON 文字列）。 */
  body?: string;
  /** 402 の accepts で必須とする network（CAIP-2）。 */
  network: string;
  /** 402 の payTo が一致しなければ買わない。 */
  payTo: string;
  /** この日（UTC 日付 YYYY-MM-DD）を過ぎた依頼は買わない。 */
  expiresOn: string;
  /** 期待する前払い額（USDC 6 桁・既定 5000 = 0.005 USDC）。 */
  amountUnits?: string;
};

const GOLDSKY_PAY_TO = "0x87aB362fEF2106d24762289410a18e7c42304C68";
const GOLDSKY_DOMAIN = "edge.goldsky.com";

/** 本番の Goldsky 9 ルート（2026-10-30 Elliott Charbonneau 依頼）。 */
export const SELLER_RETEST_REQUESTS: readonly SellerRetestRequest[] = [
  {
    id: "goldsky-2026-10-30-evm-rpc",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: "https://edge.goldsky.com/standard/evm/8453",
    method: "POST",
    body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}',
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-feeds-wallets-balances",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: `https://edge.goldsky.com/data/feeds/wallets/balances?address=${SELLER_RETEST_PAYER_PLACEHOLDER}`,
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-feeds-wallets-transfers",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: `https://edge.goldsky.com/data/feeds/wallets/transfers?address=${SELLER_RETEST_PAYER_PLACEHOLDER}`,
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-feeds-tokens",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: `https://edge.goldsky.com/data/feeds/tokens?tokens=base:${SELLER_RETEST_USDC_PLACEHOLDER}`,
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-polymarket-activity",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: "https://edge.goldsky.com/data/polymarket/activity",
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-polymarket-positions",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: `https://edge.goldsky.com/data/polymarket/positions?address=${SELLER_RETEST_PAYER_PLACEHOLDER}`,
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-polymarket-balances",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: `https://edge.goldsky.com/data/polymarket/balances?address=${SELLER_RETEST_PAYER_PLACEHOLDER}`,
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-blocks-base-number",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: `https://edge.goldsky.com/data/blocks/base?number=${SELLER_RETEST_BASE_BLOCK_NUMBER}`,
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
  {
    id: "goldsky-2026-10-30-blocks-base-head",
    requestedOn: "2026-10-30",
    sellerDomain: GOLDSKY_DOMAIN,
    url: "https://edge.goldsky.com/data/blocks/base/head",
    method: "GET",
    network: BASE_CAIP2,
    payTo: GOLDSKY_PAY_TO,
    expiresOn: "2027-04-30",
    amountUnits: "5000",
  },
];

/** テスト専用の短いリスト（本番依頼と同じ規則・模擬ホスト・9 件）。 */
export const SELLER_RETEST_TEST_REQUESTS: readonly SellerRetestRequest[] = Array.from({ length: 11 }, (_, i) => {
  const n = i + 1;
  const payTo = `0x${n.toString(16).padStart(40, "0")}`;
  const isPost = n === 2;
  return {
    id: `test-seller-retest-${n}`,
    requestedOn: "2026-10-30",
    sellerDomain: `mock-seller-retest-${n}.example`,
    url: isPost
      ? `https://mock-seller-retest.example/route/post-${n}`
      : n === 3
        ? `https://mock-seller-retest.example/route/query?address=${SELLER_RETEST_PAYER_PLACEHOLDER}`
        : `https://mock-seller-retest.example/route/${n}`,
    method: isPost ? ("POST" as const) : ("GET" as const),
    // テスト用の POST は配列の中身と順番まで照合できる本文（本番の Goldsky の依頼は eth_blockNumber・params []）。
    ...(isPost ? { body: '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' } : {}),
    network: BASE_CAIP2,
    payTo,
    expiresOn: "2027-01-01",
    amountUnits: "5000",
  };
});

/** 期限切れ（runL1Batch テスト用・依頼レーンのみ）。 */
export const SELLER_RETEST_TEST_EXPIRED: SellerRetestRequest = {
  id: "test-seller-retest-expired",
  requestedOn: "2026-10-30",
  sellerDomain: "mock-seller-retest-expired.example",
  url: "https://mock-seller-retest.example/route/expired",
  method: "GET",
  network: BASE_CAIP2,
  payTo: "0x00000000000000000000000000000000000000ee",
  expiresOn: "2020-01-01",
  amountUnits: "5000",
};

export function sellerRetestRequestCatalog(): readonly SellerRetestRequest[] {
  if (process.env.OBSERVATORY_SELLER_RETEST_TEST_LIST === "1")
    return [...SELLER_RETEST_TEST_REQUESTS, SELLER_RETEST_TEST_EXPIRED];
  return SELLER_RETEST_REQUESTS;
}

function sellerRetestExplicitlyDisabled(): boolean {
  const raw = process.env.OBSERVATORY_SELLER_RETEST_ENABLED?.trim();
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v === "false" || v === "0" || v === "off" || v === "no";
}

/** 依頼リストの処理（2026-10-30）。テストでは OBSERVATORY_SELLER_RETEST_TEST_LIST=1 のときだけ動く。本番 cron は既定 on。 */
export function sellerRetestLaneEnabled(): boolean {
  if (sellerRetestExplicitlyDisabled()) return false;
  if (process.env.OBSERVATORY_SELLER_RETEST_TEST_LIST === "1") return true;
  if (process.env.OBSERVATORY_SELLER_RETEST_ENABLED?.trim().toLowerCase() === "true") return true;
  return process.env.NODE_ENV === "production";
}

export function resolveSellerRetestUrl(template: string, payerAddress: string): string {
  const usdc = BASE_USDC;
  return template
    .split(SELLER_RETEST_PAYER_PLACEHOLDER)
    .join(payerAddress.toLowerCase())
    .split(SELLER_RETEST_USDC_PLACEHOLDER)
    .join(usdc);
}

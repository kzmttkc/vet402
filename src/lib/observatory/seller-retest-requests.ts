// ============================================================
// 売り手から依頼された 1 回きりの L1 買い直しリスト（2026-10-30・Goldsky 他）。
//
// 目録に無い URL でも、依頼ごとに 1 回だけ買う。Base の依頼は今までどおり Base。
// Celo（eip155:42220）の依頼は、402 の accepts から network と payTo と額と Celo の USDC が
// 一致する accept を選び、Celo レーンと同じ purchaseOne（selectAccept と signX402Payment）で払う。
// それ以外の網は拒む。完了・期限・402 の照合は seller-retest.ts と l1-runner.ts が行う。
// ここは版管理された依頼の正典だけ。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { EVM_LANE_ENDPOINT_SOURCE } from "./evm-lane-ingest";
import { BASE_CAIP2, BASE_USDC, CELO_CAIP2 } from "./x402-payer";

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

/**
 * L0 候補・L1 候補・公開掲載数から外す endpoint source（x402_endpoints e）。
 * seller_retest_request（依頼レーン）と vet402_evm_lane（公開 EVM 購入記録の写し）の両方。
 */
export function notSellerRetestRequestSourceSql(): SQL {
  return sql`e.source <> ${SELLER_RETEST_REQUEST_SOURCE} AND e.source <> ${EVM_LANE_ENDPOINT_SOURCE}`;
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
  /** Lupa の Dólar AR API（2026-11-10 Marce が X で依頼。CDP Bazaar に未掲載。402 は 11/10 20:3x JST に読んで照合）。 */
  {
    id: "lupapago-2026-11-10-fx-ar",
    requestedOn: "2026-11-10",
    sellerDomain: "api.lupapago.com",
    url: "https://api.lupapago.com/v1/fx/ar",
    method: "GET",
    network: BASE_CAIP2,
    payTo: "0x6fc99c8a5334e00f6fce854700959930a3c62dbc",
    expiresOn: "2026-12-10",
    amountUnits: "2000",
  },
  /** Agent402.tools の買い直し（2026-11-14 売り手がメールで依頼。11/13 の WARN の後、出力の宣言を image/png・image/jpeg の binary に直した）。402 は 2026-11-14 15:0x JST に読んで Base USDC の accept を照合。 */
  {
    id: "agent402-2026-11-14-qr",
    requestedOn: "2026-11-14",
    sellerDomain: "agent402.tools",
    url: "https://agent402.tools/api/qr?text=https%3A%2F%2Fagent402.tools&size=256",
    method: "GET",
    network: BASE_CAIP2,
    payTo: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
    expiresOn: "2026-12-14",
    amountUnits: "1000",
  },
  {
    id: "agent402-2026-11-14-image-convert",
    requestedOn: "2026-11-14",
    sellerDomain: "agent402.tools",
    url: "https://agent402.tools/api/image-convert",
    method: "POST",
    body: '{"image":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMKSSnUxrJ99AtrXPfXxIkCBBggQJEgZ5JwJ01a+JcwAAAABJRU5ErkJggg==","format":"jpeg","quality":80}',
    network: BASE_CAIP2,
    payTo: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
    expiresOn: "2026-12-14",
    amountUnits: "5000",
  },
  /** Prezenti M3 のための Celo の1回。売り手の依頼ではない。402 は 2026-11-12 14:3x JST に読んで照合（accepts は Celo・Arc・Base の3つ）。 */
  {
    id: "blockscout-2026-11-12-celo-addresses",
    requestedOn: "2026-11-12",
    sellerDomain: "api.blockscout.com",
    url: "https://api.blockscout.com/42220/api/v2/addresses",
    method: "GET",
    network: CELO_CAIP2,
    payTo: "0x242ba6d68ffeb4a098b591b32d370f973ff882b7",
    expiresOn: "2026-12-12",
    amountUnits: "2000",
  },  /** blockscout の買い直し（2026-11-12）。前の回は宣言の見本（型の名前）をクエリに入れて 422 だった。今は型の名前の見本は送らない。 */
  {
    id: "blockscout-2026-11-13-celo-addresses-noquery",
    requestedOn: "2026-11-12",
    sellerDomain: "api.blockscout.com",
    url: "https://api.blockscout.com/42220/api/v2/addresses",
    method: "GET",
    network: CELO_CAIP2,
    payTo: "0x242ba6d68ffeb4a098b591b32d370f973ff882b7",
    expiresOn: "2026-12-12",
    amountUnits: "2000",
  },
  /** Prezenti M3 のための Celo の1回（目録の外。売り手の依頼ではない）。USAT と USDC の2つを受ける。払うのは USDC だけ。402 は 2026-11-12 14:4x JST に読んで Celo USDC の accept を照合。 */
  {
    id: "agent-embassy-2026-11-12-celo-verify",
    requestedOn: "2026-11-12",
    sellerDomain: "agent-embassy-celo.fly.dev",
    url: "https://agent-embassy-celo.fly.dev/v1/check/verify",
    method: "POST",
    body: '{"url":"https://example.com"}',
    network: CELO_CAIP2,
    payTo: "0xD004278bC57FE4B9F743ABf17d713ed4169A88E9",
    expiresOn: "2026-12-12",
    amountUnits: "1000",
  },

  /** Prezenti M3 のための Celo の1回（目録の外。売り手の依頼ではない）。402 は 2026-11-12 14:4x JST に読んで Celo USDC の accept を照合。 */
  {
    id: "open-rails-2026-11-12-celo-block",
    requestedOn: "2026-11-12",
    sellerDomain: "open-rails-data-agent.shablony-pro.workers.dev",
    url: "https://open-rails-data-agent.shablony-pro.workers.dev/celo/block",
    method: "GET",
    network: CELO_CAIP2,
    payTo: "0x5a8DbD4788584f9C4B59eB64087a1A18fc2f7952",
    expiresOn: "2026-12-12",
    amountUnits: "500",
  },
  /** Prezenti M3 のための Celo の1回（目録の外。売り手の依頼ではない）。402 は 2026-11-12 14:4x JST に読んで Celo USDC の accept を照合。 */
  {
    id: "paycrawl-2026-11-12-celo-article",
    requestedOn: "2026-11-12",
    sellerDomain: "paycrawl-gateway.raghu250407.workers.dev",
    url: "https://paycrawl-gateway.raghu250407.workers.dev/agent/page/article-1",
    method: "GET",
    network: CELO_CAIP2,
    payTo: "0x24c9DEAF91f462EE6705F710C4D0aadCbD64b4E7",
    expiresOn: "2026-12-12",
    amountUnits: "1000",
  },
  /** Prezenti M3 のための Celo の1回（目録の外。売り手の依頼ではない）。cUSD・USDC・USDT・USA₮ を受ける。払うのは USDC だけ。402 は 2026-11-13 10:3x JST に読んで Celo USDC の accept（10000）を照合。 */
  {
    id: "landingen24h-2026-11-13-celo-ar-dolar",
    requestedOn: "2026-11-13",
    sellerDomain: "landingen24h.com",
    url: "https://landingen24h.com/celo/ar/dolar",
    method: "GET",
    network: CELO_CAIP2,
    payTo: "0xb6d00A148AD63Fd9CCDd484B687c6012bA1561E1",
    expiresOn: "2026-12-12",
    amountUnits: "10000",
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

// ============================================================
// vet402 Observatory L1 — purchase runner (design §1 L1/L2, §5 W3).
//
// One batch = walk the real-demand target list and, per endpoint, do ONE
// paid purchase (made under our own User-Agent): request → 402 → sign (x402-payer's funnel of refusals) →
// paid retry → record what actually happened, with the settlement tx hash
// as the receipt. Everything is recorded, including the refusals — a seller
// over-charging vs its own catalog listing is a published fact, not a
// payment.
//
// Money discipline (in order of the checks in code):
//  1. Master switches: OBSERVATORY_L1_ENABLED must be "true" AND the wallet
//     key present — otherwise zero requests are made at all.
//  2. Budget: today's spend is summed FROM THE DATABASE (x402_l1_purchases.
//     spent_units, UTC day) — restarts and concurrent invocations read the
//     same ledger. checkL1Budget gates each purchase BEFORE signing.
//  3. spent_units is RESERVED (row written, status `in_flight`) BEFORE the
//     signature exists, and the reservation itself re-checks the day's total
//     inside a single SQL statement (reserveSpend). Two reasons, both found
//     live-fire in the 2026-08-15 audit: (a) a signed EIP-3009 authorization
//     is live money until validBefore, so a kill between signing and the
//     write (maxDuration, DB blip) must not lose the spend; (b) reading the
//     day's total once per batch let two overlapping invocations each spend a
//     full daily budget ($49 measured against a $25 cap).
//  4. One purchase per endpoint per sweep window (default 6 days) — the
//     weekly-sweep cadence emerges from the daily budget, not from a queue.
// ============================================================
import { privateKeyToAccount } from "viem/accounts";
import { eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { utcDayStart } from "@/lib/db/utc-day";
import { x402L1Purchases } from "@/lib/db/schema";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { readBodyCapped } from "@/lib/net/read-capped";
import { UnsafeTargetError, createSafeFetchImpl, type SafeFetchCallOptions } from "@/lib/net/safe-fetch";
import { createDeadline } from "@/lib/util/deadline";
import { CHAIN_DAILY_CAPS, cappedChainFor, chainDailyCapUnits, checkL1Budget, isL1Enabled, laneFloorPerRun, DAILY_BUDGET_USD, type CappedChain } from "./budget";
import { isSpendingHalted, type HaltVerdict } from "./kill-switch";
import { addDerivedOperatorAddresses, isOperatorPayTo, operatorPayToDenylist } from "./operator";
import {
  ARC_CAIP2,
  buildAuthorization,
  encodePaymentHeader,
  evmChainFor,
  isArcL1Enabled,
  parseChallenge,
  parseSettlementResponse,
  selectAccept,
  signX402Payment,
} from "./x402-payer";
import { logServerError } from "@/lib/util/log";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { Keypair } from "@solana/web3.js";
import {
  SOLANA_MAINNET_CAIP2,
  buildSolanaPaymentTransaction,
  encodeSolanaPaymentHeader,
  isSolanaL1Enabled,
  selectSolanaAccept,
} from "./sol402-payer";
import type { Wallet as XrplWallet } from "xrpl";
import { XRPL_MAINNET_CAIP2 } from "./chains";
import { withDailyFallback } from "@/lib/settlements/rollup";
import { l1TierWhere } from "./coverage";
import { isPathTemplate, notPathTemplateSql } from "./path-template";
import { declaredRequestBody, type RequestBodySource } from "./declared-input";
import { createPayerFunds, defaultPayerUsdcBalance, type PayerChain, type PayerFunds, type PayerUsdcBalanceReader } from "./payer-funds";
import { createHash } from "node:crypto";
// Tempo の MPP 方言（2026-09-17・mpp-payer.ts）。x402 ではなく WWW-Authenticate: Payment の壁。
// フラグ OBSERVATORY_TEMPO_L1_ENABLED（既定 off）が無ければ Tempo は lanes で候補外（行 0）。
import {
  TEMPO_MAINNET_CAIP2,
  createMppCredential,
  isTempoL1Enabled,
  parseMppChallengesFromHeaders,
  parseMppReceipt,
  selectMppChallenge,
  type MppxCharge,
} from "./mpp-payer";

export type L1BatchSummary = {
  attempted: number;
  settled: number;
  /**
   * 署名して支払ったが決済レシートが返らなかった件数。2026-08-22 まで
   * `delivered_no_receipt`（品は来たがレシート無し）を吸収していて、DBの
   * status は区別しているのに cron 応答からは判別できなかった。
   */
  settleFailed: number;
  /** 品は返ってきたが PAYMENT-RESPONSE が無かった件数（DBの status と1:1）。 */
  deliveredNoReceipt: number;
  skipped: number;
  budgetDenied: number;
  spentUnitsTotal: string;
  /** True when the batch stopped early to stay inside maxDuration (see L1_BATCH_BUDGET_MS). */
  stoppedForDeadline: boolean;
  /** Candidates left untouched by that stop — zero on a normal full walk. */
  notAttempted: number;
  /** Stale `in_flight` rows resolved at the top of this batch (see sweepOrphanedInFlight). */
  orphansResolved: number;
  /**
   * 実行時の停止スイッチが効いた（2026-09-05 監査 P0・kill-switch.ts）。
   * バッチ開始時に立っていれば 1 リクエストも出さず、途中で立てば
   * そこで打ち切る（飛行中の 1 件は最後まで記帳する）。
   */
  halted: boolean;
  haltReason: string | null;
  disabledReason: "l1_disabled" | "wallet_key_missing" | "spending_halted" | null;
  /**
   * 購入元の USDC 残高が足りない（または読めない）ために署名しなかった候補の数
   * （2026-09-17 Issue #29・payer-funds.ts）。台帳には行を書かないので、ここと
   * サーバログ（observatory.l1.payer_unfunded）だけが資金切れを知らせる。
   */
  payerUnfunded: number;
  /**
   * チェーンごとの候補の最低枠（2026-09-17・budget.ts laneFloorPerRun）で主候補の先頭に置いた
   * 件数。別枠を持つレーン（CHAIN_DAILY_CAPS）だけが鍵になる。旗が off・別枠が尽きた・候補が
   * 無い日は 0。購入の可否は従来の経路（デッドライン・別枠・残高・原子的予約）がそのまま決める。
   */
  laneFloor: Partial<Record<CappedChain, number>>;
  /**
   * XRPL の open_ledger_fee が上限（1,000 drops）を超えていて署名しなかった候補の数（2026-09-17）。
   * 台帳には行を書かない（payer_unfunded と同じ作法）。1 件出たらそのバッチの XRPL は閉じる。
   */
  xrplFeeOverCap: number;
};

type Candidate = {
  id: string;
  resourceUrl: string;
  method: string | null;
  priceAmount: string | null;
  payTo: string | null;
  network: string | null;
  declaredSchema: unknown;
  isPriority: boolean;
  /** 成立が MATURE_SETTLED_MIN 件以上＝証拠が足りている（買い直しは 30 日間隔）。 */
  isMature: boolean;
  /** このエンドポイントで settled 行がある network（CAIP-2）。レーンの accept 優先の材料（2026-09-17）。 */
  settledNetworks: string[];
};

/**
 * レーンが選ぶ accept の network（2026-09-17）。別枠を持つレーン（budget.ts CHAIN_DAILY_CAPS）が
 * selectable なとき、purchaseOne は「そのエンドポイントにそのチェーンでの settled 行がまだ無い」
 * レーンの network を selectAccept の preferNetworks に渡す。一度そのチェーンで settled したら
 * 従来の並び（Base 先頭）に戻す＝レーンの実績は 1 エンドポイント 1 回でよい。
 */
const LANE_NETWORK: Partial<Record<CappedChain, string>> = {
  solana: SOLANA_MAINNET_CAIP2,
  arc: ARC_CAIP2,
  // tempo は入れない（2026-09-17）: Tempo は MPP 方言で accept 選択の経路（mpp-payer）が別。
  // x402 の challenge に Tempo の accept が混ざることも無いので、preferNetworks の対象外。
  // xrpl も入れない（2026-09-17）: 署名器が別（xrpl402-payer・selectXrplAccept）で、EVM の
  // selectAccept は xrpl:0 の accept を eligible にしない。
};

/**
 * raw_accepts の 2 番目以降の accept まで見てレーン候補にするか。Arc（EVM）は同じ EOA・同じ
 * EVM の署名経路なので、Base が先頭の exa.ai の行も Arc の accept で買える。Solana は
 * purchaseOne の経路が主ネットワーク（e.network）で分かれるため、先頭が Base の行を Solana の
 * 枠に入れても Base で買われてしまう——e.network が Solana の行だけを従来どおり枠に入れる。
 */
const LANE_SECONDARY_ACCEPTS: Record<CappedChain, boolean> = { solana: false, arc: true, tempo: false, xrpl: false };

/**
 * OBSERVATORY_SOLANA_SECRET_KEY: JSON配列（solana-keygenの出力）または
 * base64。どちらも64バイトのsecret keyへ落ちる。壊れていれば null
 * （fail-closed: 鍵が読めない状態でSolana候補は選ばれない）。
 */
export function loadSolanaKeypair(): Keypair | null {
  const raw = process.env.OBSERVATORY_SOLANA_SECRET_KEY?.trim() ?? "";
  if (!raw) return null;
  try {
    if (raw.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
    }
    return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(raw, "base64")));
  } catch {
    return null;
  }
}

const USDC_PER_USD = 1_000_000;

/** 本物の blockhash 取得（テストは options.getSolanaBlockhash で差し替える）。 */
async function defaultSolanaBlockhash(): Promise<string> {
  const { Connection } = await import("@solana/web3.js");
  // 2026-09-02 監査是正: 決済索引と同じく、RPC 未設定は公開 RPC へ無言で落ちず fail-loud。
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) throw new Error("solana_rpc_unset: set SOLANA_RPC_URL before enabling Solana L1 purchases");
  const conn = new Connection(rpc, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  return blockhash;
}

/**
 * XRPL の署名器（xrpl402-payer.ts）。**フラグが立っているときだけ動的に読む**——OFF の本番バンドルに
 * `xrpl` を入れない（payer-funds と同じ作法・2026-09-17 レビュー #7e）。
 */
type XrplPayerModule = typeof import("./xrpl402-payer");
async function loadXrplPayerModule(): Promise<XrplPayerModule | null> {
  if (process.env.OBSERVATORY_XRPL_L1_ENABLED !== "true") return null;
  return await import("./xrpl402-payer");
}

/**
 * XRPL の署名に要る Sequence・validated ledger・手数料（テストは options.getXrplSigningInputs で差し替える）。
 * `feeDrops: null` は「網の open_ledger_fee が上限 1,000 drops を超えている」——そのバッチの XRPL は署名しない。
 */
export type XrplSigningInputs = { sequence: number; validatedLedgerIndex: number; feeDrops?: string | null };
/** XRPL_RPC_URL 未設定は createXrplJsonRpc が throw（公開 RPC へ無言で倒れない）。手数料は `fee` を 1 回読み、上限 1,000 drops。 */
async function defaultXrplSigningInputs(address: string): Promise<XrplSigningInputs> {
  const { createXrplJsonRpc, getAccountSequence, getNetworkFeeDrops, getValidatedLedgerIndex } = await import("./xrpl402-payer");
  const rpc = createXrplJsonRpc();
  const [sequence, validatedLedgerIndex, feeDrops] = await Promise.all([getAccountSequence(address, rpc), getValidatedLedgerIndex(rpc), getNetworkFeeDrops(rpc)]);
  return { sequence, validatedLedgerIndex, feeDrops };
}

const guardedFetch = createSafeFetchImpl();

/** The daily cap in USDC base units — the same $25 checkL1Budget judges in USD. */
const DAILY_BUDGET_UNITS = BigInt(DAILY_BUDGET_USD) * BigInt(USDC_PER_USD);

/**
 * バッチ全体の壁時計予算（2026-08-22 監査・Critical の後半）。
 *
 * /api/cron/l1-purchase は maxDuration=300s。runL1Batch は limit=100 件を
 * 逐次処理するのに全体のデッドラインを持っておらず、300s を越えた瞬間に
 * **署名済み・予約済みの購入が記帳される前に殺される**——in_flight の行だけ
 * が残り「金が動いたかもしれないのにレシートが無い」最悪の落ち方をする。
 *
 * 対策は「走っている購入を殺す」ではなく「**新しい購入を始めない**」。
 * 1件の最悪ケースは HTTP 2本（各 timeoutMs・本文読み取り込み）＋ 署名・
 * 予約・記帳・Solana の blockhash RPC で、後者を L1_PURCHASE_SLACK_MS で
 * 見積もる。既定では 210s + (20s*2 + 20s) = 270s < 300s なので、
 * デッドライン直前に始めた1件が最悪でも maxDuration の内側で終わる。
 */
export const L1_BATCH_BUDGET_MS = 210_000;

/** 1購入あたり、2本の HTTP 以外（署名・DB・blockhash RPC）に見込む余裕。 */
export const L1_PURCHASE_SLACK_MS = 20_000;

/** 1件の購入の最悪所要時間。 */
export function worstCasePurchaseMs(timeoutMs: number): number {
  return timeoutMs * 2 + L1_PURCHASE_SLACK_MS;
}

/**
 * 残り時間で「もう1件」始めてよいか。純関数（DB なしでテストするため公開）。
 * 判定は最悪ケース基準——平均で判断すると、遅い1件が maxDuration を跨ぐ。
 */
export function canStartAnotherPurchase(remainingMs: number, timeoutMs: number): boolean {
  return remainingMs >= worstCasePurchaseMs(timeoutMs);
}

/** Endpoints purchased within this window are not re-purchased (1判定1購買). */
export const SWEEP_WINDOW_DAYS = 6;

/**
 * Sellers with independently verified organic demand (要件定義v2 2026-08-14
 * §0.5): the rikocr8orh8 Bazaar survey (data 2026-07-28, methodology
 * reproducible, verified against the primary source) names these four as
 * carrying 73% of ALL organic Bazaar calls. The moat is the receipt
 * TIME-SERIES — a settle-through record with 3+ points on an endpoint buyers
 * actually depend on is worth more than 3 one-shot rows on the long tail —
 * so these hosts are pinned to the head of candidate selection and swept on
 * the shorter window below.
 */
export const PRIORITY_SELLER_HOSTS = [
  "x402.twit.sh",
  "x402.tavily.com",
  "stableenrich.dev",
  "api.exa.ai",
];

/** Priority sellers may be re-purchased daily — repeats build the series. */
export const PRIORITY_SWEEP_WINDOW_DAYS = 1;

/**
 * 証拠が溜まったエンドポイントの買い直し間隔（2026-09-16）。
 *
 * 公開台帳 export.csv?days=30 の実測（2026-09-16）: 30 日で $83.81・成立 2,639 件・
 * エンドポイント 1,743。うち **初回購入 55.5%（$46.54）／買い直し 44%（$37.27）**。
 * カタログは増え続けるので、全件を 6 日間隔で回し続けると、買い直しの側だけが
 * 単調に積み上がる（この形のまま年 $3,400 に向かう）。
 *
 * 判断は「何件あれば、その売り手について言えることが変わらなくなるか」。成立を
 * 3 件積んだ相手に 4 件目を足しても、公開する所見（決済する／届く）は動かない。
 * だから成熟したエンドポイントは 30 日間隔へ落とし、空いた枠を**まだ何も測って
 * いない相手**へ回す。分母（掃引の対象）は減らさない——間隔が延びるだけで、
 * L0 の生存観測も公開台帳の行もそのまま残る。
 */
export const MATURE_SWEEP_WINDOW_DAYS = 30;

/** 「成熟」の線。status='settled' だけを数える（下の settledCountSql を見よ）。 */
export const MATURE_SETTLED_MIN = 3;

/**
 * その UTC 日に許す**初回購入**の件数（2026-09-16）。
 *
 * 9/02 週に $47.66 と跳ねたのは、カタログへ 1,059 件が一度に入って初回購入が
 * 一斉に走ったから。日次 $25 の上限はそれ自体は正しく働いたが、上限に張り付いた
 * 日は買い直し（＝時系列の密度＝堀）が押し出される。枠は上限の代わりではなく、
 * **上限の内側で初回購入と買い直しの取り分を決める**ためのもの。
 *
 * 枠に達した日は「購入行がまだ 1 件も無いエンドポイント」だけを候補から外す。
 * 行は書かない——書けばスイープ窓のあいだ再選択されず、翌日の枠にも戻らない。
 */
export const FIRST_PURCHASE_DAILY_QUOTA = 120;

/**
 * resource_key is host+path; a priority host matches itself and any path under
 * it — but NOTHING else. The old `${h}%` matched any prefix, so a look-alike
 * host an attacker can register (`api.exa.aique.com/paid` under `api.exa.ai%`,
 * `x402.twit.shady.io/x` under `x402.twit.sh%`) would be pinned to the head of
 * candidate selection and re-purchased daily, siphoning the $25/day budget off
 * the real priority sellers. Anchoring each host on an exact match OR a `/`
 * path boundary closes that. SQL patterns and the JS predicate below are both
 * derived from the same host list so they cannot drift.
 */
const PRIORITY_PATTERNS = PRIORITY_SELLER_HOSTS.flatMap((h) => [h, `${h}/%`]);

/**
 * True iff a catalog resource_key belongs to a priority host: exactly the host,
 * or the host followed by a `/` path. Case-insensitive to mirror SQL ILIKE.
 * Exported for direct testing without a database.
 */
export function isPriorityResourceKey(resourceKey: string): boolean {
  const key = resourceKey.toLowerCase();
  return PRIORITY_SELLER_HOSTS.some((h) => {
    const host = h.toLowerCase();
    return key === host || key.startsWith(`${host}/`);
  });
}

// Operator (self) payTo denylist — the addresses L1 must never buy from — lives
// in the dependency-light ./operator module so the public read path can share
// it. Re-exported here for existing callers.
export { operatorPayToDenylist };

/**
 * `ILIKE ANY(ARRAY[$1, $2, …]::text[])` with each pattern as its own bound
 * parameter — a bare JS array binds as a single scalar on postgres-js and
 * fails with 42809 (wrong object type).
 */
const prioritySqlArray = () =>
  sql`ARRAY[${sql.join(PRIORITY_PATTERNS.map((p) => sql`${p}`), sql`, `)}]::text[]`;

/**
 * 成熟の判定に数える行は **status='settled' だけ**。
 *
 * ここを「有料試行の件数」にすると、決済しない売り手ほど速く成熟して測られなく
 * なる——検証者としては逆向きの誘因になる。settle_claimed（主張はあるが未照合）も
 * 数えない: 照合が済んでいない主張は、まだ我々の証拠ではない。
 */
const settledCountSql = (endpointRef: SQL) => sql`(
    SELECT count(*) FROM x402_l1_purchases s
    WHERE s.endpoint_id = ${endpointRef} AND s.status = 'settled'
  )`;

/**
 * 候補 SQL のスイープ窓。**優先売り手を最初に判定する**——成熟の条件（成立 3 件）
 * は優先売り手ほど先に満たすので、順番を逆にすると堀そのものが 30 日間隔へ落ちる。
 * JS 側の sweepWindowDaysFor が同じ順番を持つ（予約もこの窓で締める）。
 */
const sweepWindowDaysSql = (endpointRef: SQL, resourceKeyRef: SQL) => sql`(CASE
            WHEN ${resourceKeyRef} ILIKE ANY(${prioritySqlArray()}) THEN ${PRIORITY_SWEEP_WINDOW_DAYS}::int
            WHEN ${settledCountSql(endpointRef)} >= ${MATURE_SETTLED_MIN} THEN ${MATURE_SWEEP_WINDOW_DAYS}::int
            ELSE ${SWEEP_WINDOW_DAYS}::int
          END)`;

/**
 * 予約が締めるスイープ窓。sweepWindowDaysSql と同じ順番（優先売り手が先）。
 * DB 無しで固定できるよう純関数で出す。
 */
export function sweepWindowDaysFor(input: { isPriority: boolean; isMature: boolean }): number {
  if (input.isPriority) return PRIORITY_SWEEP_WINDOW_DAYS;
  return input.isMature ? MATURE_SWEEP_WINDOW_DAYS : SWEEP_WINDOW_DAYS;
}

/**
 * その UTC 日に「それまで購入行の無かったエンドポイント」を買った件数。
 *
 * 数え方は endpoint ごとの min(attempted_at) が今日の 0 時 UTC 以降か——status は
 * 見ない。budget_denied や request_error でも、その endpoint は「今日もう手を
 * 付けた」ので枠を 1 つ使っている（候補 SQL の「未購入」判定＝行の有無とも揃う）。
 */
const firstPurchasesTodayCountSql = () => sql`(
    SELECT count(*) FROM (
      SELECT pu.endpoint_id FROM x402_l1_purchases pu
      GROUP BY pu.endpoint_id
      HAVING min(pu.attempted_at) >= ${utcDayStart()}
    ) f
  )`;

function unitsToUsd(units: bigint): number {
  return Number(units) / USDC_PER_USD;
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
}

type Reservation =
  | { ok: true; rowId: string }
  | {
      ok: false;
      reason:
        | "daily_budget_exceeded"
        | "already_purchased"
        /** その network の日次別枠（budget.ts CHAIN_DAILY_CAPS: Solana・Arc）に届かなかった。 */
        | "chain_daily_cap"
        | "first_purchase_quota";
    };

/**
 * Claim the spend before it can happen. ONE statement, so the day's total and
 * the sweep-window check are evaluated and the ledger row written without the
 * caller ever holding a stale number: whoever commits first is the one whose
 * money is counted, and the loser is refused.
 *
 * Written as a single statement on purpose — production runs on neon-http,
 * where every query is its own connection and implicit transaction, so
 * multi-statement locking (advisory locks, SELECT ... FOR UPDATE) cannot span
 * a check and its write. What is left uncovered is only the sub-millisecond
 * overlap of two INSERTs whose snapshots predate each other's commit, and its
 * cost is bounded by one purchase (≤ $1), not by a second daily budget.
 */
async function reserveSpend(input: {
  db: NonNullable<ReturnType<typeof getDb>>;
  endpointId: string;
  payer: string;
  network: string;
  asset: string;
  payTo: string;
  amountUnits: string;
  /** Per-candidate: PRIORITY_SWEEP_WINDOW_DAYS for pinned sellers, SWEEP_WINDOW_DAYS otherwise. */
  windowDays: number;
}): Promise<Reservation> {
  const { db, endpointId, payer, network, asset, payTo, amountUnits, windowDays } = input;
  // チェーン別の別枠（budget.ts CHAIN_DAILY_CAPS）。2026-09-15 の Solana の別枠を 2026-09-17 に
  // Arc と共通の表にした。Base は別枠を持たないので CTE も条件も入らない（従来と同じ 1 文）。
  const capChain = cappedChainFor(network);
  const capLike = capChain ? CHAIN_DAILY_CAPS[capChain].networkLike : null;
  const capUnits = capChain ? String(chainDailyCapUnits(capChain)) : null;
  const raw = await db.execute(sql`
    WITH day AS (
      SELECT coalesce(sum(spent_units::numeric), 0) AS spent
      FROM x402_l1_purchases
      WHERE attempted_at >= ${utcDayStart()}
    ), chain_day AS (
      -- その network の別枠の当日支出。Base の定期購入を押し出さない。別枠の無い network は
      -- 何にも一致しないパターンで 0 を返す（条件も付かない）。
      SELECT coalesce(sum(spent_units::numeric), 0) AS spent
      FROM x402_l1_purchases
      WHERE attempted_at >= ${utcDayStart()} AND network LIKE ${capLike ?? ""}
    ), dup AS (
      SELECT EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = ${endpointId}::uuid
          AND pu.attempted_at > now() - make_interval(days => ${windowDays})
      ) AS taken
    ), first_day AS (
      -- 初回購入の日次枠（FIRST_PURCHASE_DAILY_QUOTA）。候補 SQL がバッチ開始時に
      -- 一度外すが、1 バッチの途中で枠を跨ぐぶんはそこでは止まらない。Solana の
      -- 別枠と同じで、締めるのは予約の側（同じ 1 文の中で数える）。
      SELECT ${firstPurchasesTodayCountSql()} AS n,
             NOT EXISTS (
               SELECT 1 FROM x402_l1_purchases pu WHERE pu.endpoint_id = ${endpointId}::uuid
             ) AS is_first
    ), ins AS (
      INSERT INTO x402_l1_purchases
        (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units)
      SELECT ${endpointId}::uuid, 'in_flight', ${payer}, ${network}, ${asset},
             ${payTo}, ${amountUnits}, ${amountUnits}
      FROM day, chain_day, dup, first_day
      WHERE NOT dup.taken
        AND day.spent + ${amountUnits}::numeric <= ${String(DAILY_BUDGET_UNITS)}::numeric
        ${capUnits === null ? sql`` : sql`AND chain_day.spent + ${amountUnits}::numeric <= ${capUnits}::numeric`}
        AND (NOT first_day.is_first OR first_day.n < ${FIRST_PURCHASE_DAILY_QUOTA})
      RETURNING id
    )
    SELECT (SELECT id FROM ins)::text AS row_id, (SELECT taken FROM dup) AS taken,
           (SELECT spent FROM chain_day)::text AS chain_spent,
           (SELECT is_first FROM first_day) AS is_first,
           (SELECT n FROM first_day)::text AS first_day_count
  `);
  const row = rowsOf(raw)[0];
  // No row back at all means the statement did not run as written — refuse to
  // spend on a gate whose verdict we cannot read.
  if (!row) throw new Error("l1 spend reservation returned no verdict row");
  const rowId = typeof row.row_id === "string" && row.row_id !== "" ? row.row_id : null;
  if (rowId) return { ok: true, rowId };
  if (row.taken === true) return { ok: false, reason: "already_purchased" };
  if (row.is_first === true) {
    const firstCount =
      typeof row.first_day_count === "string" ? Number(row.first_day_count.split(".")[0]) : null;
    // 読めなければ枠が尽きた側へ倒す（行を書かない——書くと掃引の窓ぶん締め出す）。
    if (firstCount === null || !Number.isFinite(firstCount) || firstCount >= FIRST_PURCHASE_DAILY_QUOTA) {
      return { ok: false, reason: "first_purchase_quota" };
    }
  }
  if (capChain !== null) {
    const chainSpent = typeof row.chain_spent === "string" ? BigInt(row.chain_spent.split(".")[0]) : null;
    // 読めなければ別枠の判定とみなす（行を書かない側へ倒す——書くと 6 日締め出す）
    if (chainSpent === null || chainSpent + BigInt(amountUnits) > chainDailyCapUnits(capChain)) {
      return { ok: false, reason: "chain_daily_cap" };
    }
  }
  return { ok: false, reason: "daily_budget_exceeded" };
}

/**
 * observed_purchases.delivery_verified の判定（2026-08-22 監査・項目1）。
 *
 * この列は**書き手側の保証**で、読み手（observed-purchases.ts）は導出できず
 * フラグを信じるしかない。だから true にする条件は「品が実際に届いたと
 * 我々が観測した」ことに限る:
 *   - 有料リトライが HTTP 200 を返し、
 *   - 本文が空でなく（空ボディの200は「届いた」と言えない）、
 *   - 宣言スキーマに対して mismatch でない（宣言があるのに違う形の応答は、
 *     配送の確認になっていない。宣言が無い no_declaration は減点しない）。
 * どれか欠ければ false で**記録する**——行ごと捨てるのではなく、x402 相当の
 * 「決済はした」事実として残す（scoreEconomicActivity はこの差を見ている）。
 *
 * 純関数。DB なしでテストするため公開。
 */
export function isDeliveryVerified(input: {
  httpStatusPaid: number | null;
  payloadNonEmpty: boolean;
  l2Schema: string;
}): boolean {
  return input.httpStatusPaid === 200 && input.payloadNonEmpty && input.l2Schema !== "mismatch";
}

/**
 * 孤児 `in_flight` の回収しきい値（2026-08-22 監査）。
 *
 * reserveSpend は署名の**前**に in_flight 行を書く（正しい——署名済み
 * EIP-3009 は validBefore まで生きた金なので、記帳より先に予約する）。
 * だが署名後・結果の記帳前に落ちた行を後から解決する仕組みが無く、
 * スイープ窓（既定6日・優先1日）の重複判定は status を見ないので、
 * 孤児が1件でもあるとそのエンドポイントは窓の間ずっと購入対象から
 * 外れ続ける（本番実測 2026-08-22 時点では 0 件）。
 *
 * 30分の根拠: 1件の最悪ケースは worstCasePurchaseMs = 60s、バッチ全体でも
 * cron の maxDuration = 300s が上限。30分はその6倍あるので、**実行中の
 * 別インボケーションの行を誤って回収することはあり得ない**。
 */
/**
 * 署名後失敗が何回続いたら冷却へ入れるか（2026-08-24 監査）。
 *
 * 1回では外さない——正直な売り手も一時的に落ちるし、ネットワークの都合でも
 * 決済は失敗する。3回連続で「署名させたが決済に至らない」なら、それは
 * その壁についての所見であり、予算を投じ続ける理由がない。
 *
 * 冷却は永久ではない: スイープ窓（既定6日・優先1日）を過ぎれば、上の
 * NOT EXISTS が古い試行を見なくなるので自然に対象へ戻る。回復の道を
 * 残さない排除にはしない。
 */
export const NON_SETTLING_COOLDOWN_STREAK = 3;

export const ORPHAN_IN_FLIGHT_MINUTES = 30;

/**
 * 孤児 in_flight を解決する。変えるのは status と raw_response_meta だけで、
 * **spent_units には触らない**——「署名したら計上する」は予算の不変条件で、
 * ここで金額を戻すと、実際に動いたかもしれない金の分だけ当日の予算が
 * 二重に空く。だから day 集計（runL1Batch の日次合計・reserveSpend の day
 * CTE。どちらも status を見ずに spent_units を合計する）は回収の前後で
 * 完全に同じ値を返す。
 *
 * 解決先を `request_error` にする理由: 我々のランナーが死んだという**我々側
 * の事実**であり、売り手についての測定ではない。`settle_failed` に落とすと
 * 測っていない失敗を売り手の決済率の分母（PAID_ATTEMPT_STATUSES）に入れて
 * しまう。request_error は公開面（decisions / export.csv / backtest /
 * reader）のどの分母からも既に外れている。
 */
export async function sweepOrphanedInFlight(
  db: NonNullable<ReturnType<typeof getDb>>,
  olderThanMinutes: number = ORPHAN_IN_FLIGHT_MINUTES,
): Promise<number> {
  const raw = await db.execute(sql`
    UPDATE x402_l1_purchases
    SET status = 'request_error',
        raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object(
          'phase', 'sweep',
          'reason', 'orphaned_in_flight',
          'note', 'reserved and possibly signed; the runner died before the outcome was written',
          'sweptAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
    WHERE status = 'in_flight'
      AND attempted_at < now() - make_interval(mins => ${olderThanMinutes}::int)
    RETURNING id
  `);
  return rowsOf(raw).length;
}

/**
 * 予約したのに結果を書けなかった行を、その場で `settle_failed` へ倒す
 * （2026-09-04 監査 P1-2）。
 *
 * sweepOrphanedInFlight（30 分後の掃除）との違いは「誰が落ちたか分かっているか」。
 * こちらは**同じ実行の中で例外を掴んでいる**ので、理由まで書ける。
 * 解決先を settle_failed にするのは、我々が署名して払える状態にした試行だから
 * ——公開面の分母（PAID_ATTEMPT_STATUSES）に入り、冷却の対象にもなる。
 * spent_units は触らない（「署名したら計上する」は予算の不変条件）。
 */
export async function resolveReservationAsFailed(
  db: NonNullable<ReturnType<typeof getDb>>,
  rowId: string,
  error: unknown,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE x402_l1_purchases
      SET status = 'settle_failed',
          raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) || jsonb_build_object(
            'phase', 'post_reservation',
            'reason', 'threw_after_reservation',
            'error', ${String(error).slice(0, 300)}
          )
      WHERE id = ${rowId}::uuid
    `);
  } catch (writeError) {
    // ここまで失敗したら 30 分後の孤児掃除が拾う。黙って消さない。
    logServerError("observatory.l1.resolve_reservation_failed", writeError);
  }
}

/**
 * 停止スイッチを 1 回読む。**fail-closed の「DB が読めないので止めた」を
 * 黙って「運用者が止めた」に見せない**ための薄い包み: 前者は障害なので
 * fail-loud にする（cron の応答からは haltReason の文言で区別できるが、
 * 障害はログにも出ていなければ誰も気づかない）。
 */
async function haltGate(db: NonNullable<ReturnType<typeof getDb>>): Promise<HaltVerdict> {
  const verdict = await isSpendingHalted(db);
  if (verdict.halted && verdict.source === "unreachable") {
    logServerError("observatory.l1.halt_flag_unreadable", new Error(verdict.reason));
  }
  return verdict;
}

export async function runL1Batch(
  options: {
    limit?: number;
    fetchImpl?: (url: string, init?: RequestInit, call?: SafeFetchCallOptions) => Promise<Response>;
    timeoutMs?: number;
    /**
     * Playground demo path: narrow candidate selection to this one endpoint.
     * Everything else — L0-pass requirement, self-exclusion, sweep-window
     * dedup, the atomic budget reservation — applies unchanged, so a demo
     * trigger can never spend past what the daily batch itself could.
     */
    onlyEndpointId?: string;
    /** Test seam: Solana recent blockhash. Default hits SOLANA_RPC_URL. */
    getSolanaBlockhash?: () => Promise<string>;
    /** Whole-batch wall-clock budget; default L1_BATCH_BUDGET_MS (test seam). */
    batchBudgetMs?: number;
    /** Test seam: 購入元の USDC 残高（基本単位）。既定は BASE_RPC_URL / SOLANA_RPC_URL を読む。 */
    getPayerUsdcBalance?: PayerUsdcBalanceReader;
    /** Test seam: Tempo（MPP）の署名器。既定は mppx/client（Tempo RPC へ出る）。 */
    mppxCharge?: MppxCharge;
    /** Test seam: XRPL の Sequence と validated ledger。既定は XRPL_RPC_URL（JSON-RPC）を読む。 */
    getXrplSigningInputs?: (address: string) => Promise<XrplSigningInputs>;
  } = {},
): Promise<L1BatchSummary> {
  // SSRF (2026-08-15 audit): resourceUrl is a seller-declared string from the
  // public Bazaar catalog. The production default refuses any target that is —
  // or redirects to — a non-public address, so this runner cannot be pointed
  // at the platform's own internal surfaces (nor made to carry a signed
  // payment authorization there). See src/lib/net/safe-fetch.ts.
  const {
    limit = 100,
    fetchImpl = guardedFetch,
    timeoutMs = 20_000,
    onlyEndpointId,
    batchBudgetMs = L1_BATCH_BUDGET_MS,
  } = options;
  const deadline = createDeadline(batchBudgetMs);
  const getSolanaBlockhash = options.getSolanaBlockhash ?? defaultSolanaBlockhash;
  const getXrplSigningInputs = options.getXrplSigningInputs ?? defaultXrplSigningInputs;
  const summary: L1BatchSummary = {
    attempted: 0,
    settled: 0,
    settleFailed: 0,
    deliveredNoReceipt: 0,
    skipped: 0,
    budgetDenied: 0,
    spentUnitsTotal: "0",
    stoppedForDeadline: false,
    notAttempted: 0,
    orphansResolved: 0,
    halted: false,
    haltReason: null,
    disabledReason: null,
    payerUnfunded: 0,
    laneFloor: {},
    xrplFeeOverCap: 0,
  };

  // 1. Master switches — fail-closed before any network traffic.
  if (!isL1Enabled()) {
    summary.disabledReason = "l1_disabled";
    return summary;
  }
  // MetaMask exports the key WITHOUT the 0x prefix; Coinbase Wallet WITH it.
  // Accept both, normalize to the 0x form viem requires.
  const rawPk = process.env.OBSERVATORY_WALLET_PRIVATE_KEY?.trim() ?? "";
  const pk = rawPk.startsWith("0x") ? rawPk : rawPk ? `0x${rawPk}` : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    summary.disabledReason = "wallet_key_missing";
    return summary;
  }
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // 1.2 実行時の停止スイッチ（2026-09-05 監査 P0）。env のフラグ（上）は
  //     再デプロイしないと変わらないので、支出を今すぐ止める手段になれない。
  //     DB の 1 行を、ネットワークへ 1 本も出す前に読む。
  const batchHalt = await haltGate(db);
  if (batchHalt.halted) {
    summary.halted = true;
    summary.haltReason = batchHalt.reason;
    summary.disabledReason = "spending_halted";
    return summary;
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  // Solana は独立フラグ + 独立鍵。どちらか欠ければ candidates から除外される
  // （試行すらしない）。予算・台帳は Base と共有（USDC 基本単位が共通）。
  const solanaKeypair = isSolanaL1Enabled() ? loadSolanaKeypair() : null;
  const solanaReady = solanaKeypair !== null;
  // XRPL（2026-09-17）も同じ形: 独立フラグ + 独立 seed。RLUSD は 1 単位 = $1 なので台帳の目盛りは共有。
  const xrplPayer = await loadXrplPayerModule();
  const xrplWallet = xrplPayer ? xrplPayer.loadXrplWallet() : null;
  // ready = フラグ + seed + XRPL_RPC_URL。RPC が無ければ SQL の段階で候補外にする——署名の材料（Sequence・
  // validated ledger）を読めない失敗を、売り手の request_error 行にしない（2026-09-17 出荷前レビュー #2）。
  const xrplReady = xrplWallet !== null && !!process.env.XRPL_RPC_URL?.trim();

  // 2026-08-23 監査: 自己除外が VET402_OPERATOR_PAYTO の手入力だけに依存していて、
  // **本番では未設定＝完全な no-op** だった。中立性は堀そのものなので、忘れられる
  // 場所に置かない。いま鍵を読んだアドレス（＝我々が署名できる＝定義上そこへの
  // 支払いは自己取引）を実行時に注入し、環境変数のリストと合併する。
  addDerivedOperatorAddresses([
    account.address,
    solanaKeypair?.publicKey.toBase58() ?? null,
    xrplWallet?.classicAddress ?? null,
  ]);

  // 1.5 Resolve orphaned reservations from earlier runs BEFORE anything else
  //     reads the ledger. Ordering is safe by construction: the sweep never
  //     touches spent_units, so the day total below is identical either way.
  //     A failure here must not stop the batch — it is housekeeping, not a
  //     money gate — but it is never swallowed silently.
  try {
    summary.orphansResolved = await sweepOrphanedInFlight(db);
  } catch (error) {
    if (!isMissingSchemaError(error)) logServerError("observatory.l1.orphan_sweep", error);
  }

  // 2. Today's spend from the ledger (UTC day).
  let spentToday = 0n;
  try {
    const raw = await db.execute(sql`
      SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent
      FROM x402_l1_purchases
      WHERE attempted_at >= ${utcDayStart()}
    `);
    const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
      spent: string;
    }[];
    // Fail-closed: an unreadable ledger must never read as "nothing spent
    // today" — that is the one wrong answer that opens a fresh daily budget.
    const spentRaw = list[0]?.spent;
    if (typeof spentRaw !== "string") throw new Error("l1 daily spend query returned no total");
    spentToday = BigInt(spentRaw.split(".")[0]);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    return summary; // table missing → cold start, nothing to do safely
  }

  // 2.5 別枠を持つレーン（Solana・Arc）ごとに、(a) レーンが有効か、(b) その日の別枠が
  //     もう尽きていないかを見て、どちらかが否なら候補から外す（試行して断られた行を
  //     書くと、その売り手はスイープ窓のあいだ再選択されない）。読めなければ外す側へ倒す。
  //     Arc（2026-09-17）は Base と同じ鍵で署名するので、有効条件はフラグだけ。
  const lanes: { chain: CappedChain; ready: boolean }[] = [
    { chain: "solana", ready: solanaReady },
    { chain: "arc", ready: isArcL1Enabled() },
    // Tempo（MPP・2026-09-17）: Base と同じ EOA・USDC.e。有効条件はフラグだけ。
    { chain: "tempo", ready: isTempoL1Enabled() },
    // XRPL（2026-09-17）: 独立フラグ + 独立 seed。どちらか欠ければ候補から外れる。
    { chain: "xrpl", ready: xrplReady },
  ];
  const laneExclusions: SQL[] = [];
  const laneSelectable = new Map<CappedChain, boolean>();
  /** selectable（旗 on・別枠が残る）なレーンの network。purchaseOne の preferNetworks の元（LANE_NETWORK に無いレーンは入らない）。 */
  const selectableLaneNetworks: string[] = [];
  for (const lane of lanes) {
    let selectable = lane.ready;
    if (selectable) {
      try {
        const rawLane = await db.execute(sql`
          SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent
          FROM x402_l1_purchases
          WHERE attempted_at >= ${utcDayStart()} AND network LIKE ${CHAIN_DAILY_CAPS[lane.chain].networkLike}
        `);
        const laneRows = (Array.isArray(rawLane) ? rawLane : (rawLane as { rows?: unknown[] }).rows ?? []) as { spent: string }[];
        const spentRaw = laneRows[0]?.spent;
        if (typeof spentRaw !== "string" || BigInt(spentRaw.split(".")[0]) >= chainDailyCapUnits(lane.chain)) {
          selectable = false;
        }
      } catch (error) {
        logServerError(`observatory.l1.${lane.chain}_cap_read`, error);
        selectable = false;
      }
    }
    // レーンが無効（フラグ無し or 鍵が読めない）か別枠が尽きた間は、候補から SQL の段階で
    // 外す——「試行して skip」の雑音でなく、最初から対象外。行も書かない。
    laneSelectable.set(lane.chain, selectable);
    if (!selectable) {
      laneExclusions.push(sql`AND (e.network IS NULL OR e.network NOT LIKE ${CHAIN_DAILY_CAPS[lane.chain].networkLike})`);
    } else {
      const laneNetwork = LANE_NETWORK[lane.chain];
      if (laneNetwork !== undefined) selectableLaneNetworks.push(laneNetwork);
    }
  }

  // 2.6 初回購入の日次枠（FIRST_PURCHASE_DAILY_QUOTA）。枠に達した日は「購入行が
  //     まだ 1 件も無いエンドポイント」を候補から外す（買い直しは続く）。読めなければ
  //     外す側へ倒す——初回購入を 1 日見送っても翌日また候補になるが、枠を数えられない
  //     まま走ると、カタログが跳ねた日に初回購入だけで日次予算を使い切る。
  let firstPurchasesSelectable = true;
  try {
    const rawFirst = await db.execute(sql`SELECT ${firstPurchasesTodayCountSql()}::text AS n`);
    const firstRows = (Array.isArray(rawFirst)
      ? rawFirst
      : ((rawFirst as { rows?: unknown[] }).rows ?? [])) as { n: string }[];
    const firstRaw = firstRows[0]?.n;
    if (typeof firstRaw !== "string" || Number(firstRaw) >= FIRST_PURCHASE_DAILY_QUOTA) {
      firstPurchasesSelectable = false;
    }
  } catch (error) {
    logServerError("observatory.l1.first_purchase_quota_read", error);
    firstPurchasesSelectable = false;
  }

  // 3. Targets: L0-passing active endpoints. Priority sellers (verified
  //    organic demand, PRIORITY_SELLER_HOSTS) are pinned to the head and
  //    re-enter daily so their receipt series accumulates; the long tail
  //    follows by observed demand and is swept once per SWEEP_WINDOW_DAYS.
  //    (要件定義v2 2026-08-14 §2.1-2: concentrate the daily budget on repeat
  //    purchases of the endpoints buyers depend on, not one-shot coverage.)
  const denylist = operatorPayToDenylist();
  const selfExclusion = denylist.length
    ? sql`AND (e.pay_to IS NULL OR lower(e.pay_to) <> ALL(ARRAY[${sql.join(
        denylist.map((a) => sql`${a}`),
        sql`, `,
      )}]::text[]))`
    : sql``;
  // 候補 SQL は settlement_daily を読む（C2 の 30 日窓が生行の保持期間へ縮まないため）。
  // 表がまだ無い環境では生行だけの式へ落とす（withDailyFallback）。
  const targetsSql = (daily: boolean, lane?: { chain: CappedChain; networkLike: string; limit: number }) => sql`
    SELECT e.id, e.resource_url, e.method, e.price_amount, e.pay_to, e.network, e.declared_schema,
           (e.resource_key ILIKE ANY(${prioritySqlArray()})) AS is_priority,
           (${settledCountSql(sql`e.id`)} >= ${MATURE_SETTLED_MIN}) AS is_mature,
           -- レーンの accept 優先（2026-09-17）: このエンドポイントで settled 済みの network。
           (SELECT coalesce(array_agg(DISTINCT s.network), '{}'::text[])
              FROM x402_l1_purchases s
              WHERE s.endpoint_id = e.id AND s.status = 'settled' AND s.network IS NOT NULL) AS settled_networks
    FROM x402_endpoints e
    JOIN LATERAL (
      SELECT verdict FROM x402_l0_probes p
      WHERE p.endpoint_id = e.id
      ORDER BY probed_at DESC LIMIT 1
    ) lp ON lp.verdict = 'pass'
    WHERE e.status = 'active'
      -- 2026-08-26 緊急修正（外部レビュー F-1）: resource_url に ':siren' のような
      -- **未置換のパスパラメータ**が残るエンドポイントを対象から外す。パラメータの
      -- 実値を知らない我々には正しいリクエストを作れず、実測で settle_failed の
      -- 82%（724/885 が HTTP 400）がこの形だった——「我々が不正な URL で叩いて
      -- 断られた」を「売り手が決済しない」として記録し、日次予算を燃やし
      -- （認可$35.28分・オンチェーン移動はゼロ）、冤罪の BLOCK を4件出していた。
      -- active 15,251 件中 709 件が該当。これらは L0（生存観測）には残る——
      -- 測れないものを買いに行かない、というだけ。
      -- 2026-09-02 監査 A1: ':name' 以外の形（'{name}' '<name>' '[name]' '*'・
      -- URL 符号化済み）も同じ。判定は path-template.ts が正典（JS 側と同じ正規表現・
      -- 下の候補ループにも isPathTemplate のガードを置く二重防御）。
      AND ${notPathTemplateSql()}
      ${onlyEndpointId ? sql`AND e.id = ${onlyEndpointId}::uuid` : sql``}
      ${sql.join(laneExclusions, sql` `)}
      ${
        // レーン枠（2026-09-17・laneFloorCandidates）。主ネットワークが一致する行に加え、
        // LANE_SECONDARY_ACCEPTS のレーンは raw_accepts のいずれかの accept が一致する行
        // （exa.ai: Base 先頭・Arc 2 番目）も入れる。そのチェーンで settled 済みの行は入れない
        // （レーンの実績は 1 エンドポイント 1 回でよい——以後は従来の並びで Base を買う）。
        lane
          ? sql`AND (e.network LIKE ${lane.networkLike}${
              LANE_SECONDARY_ACCEPTS[lane.chain]
                ? sql` OR (jsonb_typeof(e.raw_accepts) = 'array' AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements(e.raw_accepts) a WHERE a->>'network' LIKE ${lane.networkLike}))`
                : sql``
            })
             AND NOT EXISTS (
               SELECT 1 FROM x402_l1_purchases ls
               WHERE ls.endpoint_id = e.id AND ls.status = 'settled' AND ls.network LIKE ${lane.networkLike})`
          : sql``
      }
      ${selfExclusion}
      -- Tempo（MPP・2026-09-17 レビュー #4）: directory は受取先を載せない。L0 が生きた challenge から
      -- 学習した pay_to を持つ行だけを L1 候補にする（受取先を知らない相手に署名しない）。
      AND (e.source <> 'mpp_directory' OR e.pay_to IS NOT NULL)
      ${
        // 初回購入の枠を使い切った日は、購入行がまだ無いエンドポイントを外す
        // （買い直しは続く）。行を書かないので、翌 UTC 日にまた候補へ戻る。
        firstPurchasesSelectable
          ? sql``
          : sql`AND EXISTS (SELECT 1 FROM x402_l1_purchases fp WHERE fp.endpoint_id = e.id)`
      }
      AND NOT EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = e.id
          AND pu.attempted_at > now() - make_interval(days => ${sweepWindowDaysSql(sql`e.id`, sql`e.resource_key`)})
      )
      -- 2026-08-24 監査: 署名後失敗による予算 Griefing への耐性。
      -- reserveSpend は署名の前に計上する（正しい——署名済み EIP-3009 は
      -- validBefore まで生きた金）。だが売り手が決済しなければ、我々は金を
      -- 一円も渡していないのに日次$25の観測予算だけが減る。敵対的な売り手が
      -- 「署名だけさせて決済しない」を繰り返すと、**スコアを偽造しなくても
      -- 検証者の観測能力を枯らせる**。スコアの穴ではなく可用性への攻撃。
      --
      -- 守り方は「疑わしきを罰する」ではなく「無駄撃ちを止める」。直近の
      -- 有料試行が連続で決済に至っていないエンドポイントは、冷却期間のあいだ
      -- 対象から外す。1回の失敗では外さない（正直な売り手も一時的に落ちる）。
      -- 外れている間もL0の観測は続くので、公開台帳から消えるわけではない。
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT pu.status
          FROM x402_l1_purchases pu
          WHERE pu.endpoint_id = e.id
            AND pu.status IN (
              'settled', 'settle_claimed', 'settle_claim_refuted',
              'settle_claimed_unverifiable', 'delivered_no_receipt', 'settle_failed',
              -- 2026-09-04 監査 P1-2: sweepOrphanedInFlight の解決先。
              -- 予約後・記帳前に落ちた行は request_error になるが、この status は
              -- 冷却のどの条件にも当たらなかった。つまり「署名させて我々を
              -- 落とす」を繰り返す売り手は、何度でも予算を焼けた。
              -- request_error は無償リクエストの失敗（到達不能・SSRF 拒否）も
              -- 含むが、3 回続けて何も測れていない相手に予算を投じ続ける理由も
              -- 同じく無い。公開面の分母（PAID_ATTEMPT_STATUSES）には
              -- 従来どおり入らない。
              'request_error'
            )
          ORDER BY pu.attempted_at DESC
          LIMIT ${NON_SETTLING_COOLDOWN_STREAK}
        ) recent
        HAVING count(*) = ${NON_SETTLING_COOLDOWN_STREAK}
           AND count(*) FILTER (
                 WHERE recent.status IN ('settled', 'settle_claimed')
               ) = 0
      )
    -- §7.4（2026-09-02）: C2（決済帰属あり ∨ 問い合わせ多）を最初に買う。日次予算が
    -- 尽きれば残りは未実施のまま（facts では l1_not_attempted = 未検証。pass とは書かない）。
    -- C2 だけに絞らないのは、決済索引が空の初日に L1 が完全に止まるのを避けるため——
    -- 仕様の「C2 は 24 時間ごと L1」は順序で満たし、他階層は従来の掃引で薄く測る。
    -- 2026-09-02 グラント側の指摘: 日次 $25 の枠に対し実支出 $1〜3・購入実績のある endpoint は
    -- 8.1%。C2 の次は「一度も買っていない in-cap endpoint」を優先し、証拠の裾野を広げる
    -- （上限は全て据え置き: 1 件 $1・日次 $25・原子的予約・cooldown）。
    ORDER BY (${l1TierWhere(daily)}) DESC,
             (NOT EXISTS (SELECT 1 FROM x402_l1_purchases np WHERE np.endpoint_id = e.id)) DESC,
             (e.resource_key ILIKE ANY(${prioritySqlArray()})) DESC,
             e.quality_payers_30d DESC NULLS LAST, e.quality_calls_30d DESC NULLS LAST
    LIMIT ${lane?.limit ?? limit}
  `;
  const rawTargets = await withDailyFallback(
    async () => await db.execute(targetsSql(true)),
    async () => await db.execute(targetsSql(false)),
  );
  const targetList = (Array.isArray(rawTargets)
    ? rawTargets
    : (rawTargets as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  let candidates: Candidate[] = targetList.map(rowToCandidate);

  // 3.5 チェーンごとの候補の最低枠（2026-09-17・budget.ts laneFloorPerRun）。需要順の主候補は
  //     EVM の未購入の裾野に埋まり、Solana（候補 204・未購入 192）は別枠 $2 を一度も使い切れずに
  //     1 件/日だった。別枠を持つレーンごとに、同じ WHERE で network を絞った候補を先頭に置く。
  //     主候補の LIMIT は減らさない（Base の候補は毎回 20 件以上残す）。旗が off・別枠が尽きた
  //     レーンは laneExclusions が同じ WHERE で外すので、ここでも 0 行。playground の 1 件指定
  //     （onlyEndpointId）では枠を使わない。
  const laneHead = await laneFloorCandidates({
    lanes,
    floor: onlyEndpointId ? 0 : laneFloorPerRun(),
    fetchLane: async (chain, laneLimit) => {
      const lane = { chain, networkLike: CHAIN_DAILY_CAPS[chain].networkLike, limit: laneLimit };
      return await withDailyFallback(
        async () => await db.execute(targetsSql(true, lane)),
        async () => await db.execute(targetsSql(false, lane)),
      );
    },
  });
  summary.laneFloor = laneHead.counts;
  if (laneHead.head.length > 0) {
    // 主候補にも入っていた行は先頭へ移す（同じ売り手を 1 回のバッチで 2 度買わない）。
    const headIds = new Set(laneHead.head.map((c) => c.id));
    candidates = [...laneHead.head, ...candidates.filter((c) => !headIds.has(c.id))];
  }

  // 購入元残高の関門（2026-09-17 Issue #29）。チェーンごとに 1 バッチ 1 回だけ読み、
  // 読めなければ署名しない側へ倒す。ログはチェーンごとに 1 回。
  const payerFunds = createPayerFunds(options.getPayerUsdcBalance ?? defaultPayerUsdcBalance);
  const unfundedLogged = new Set<string>();
  const onPayerUnfunded = (chain: string, detail: Record<string, unknown>) => {
    summary.payerUnfunded++;
    if (unfundedLogged.has(chain)) return;
    unfundedLogged.add(chain);
    logServerError("observatory.l1.payer_unfunded", new Error(`payer_unfunded chain=${chain} ${JSON.stringify(detail)}`));
  };

  // XRPL は **1 バッチ 1 件**（2026-09-17 レビュー #2）。署名は account_info の Sequence を使うので、
  // 同じバッチで 2 件署名すると同じ Sequence の tx が 2 本できる（片方は tefPAST_SEQ）。署名した後の
  // XRPL 候補は候補選択の段階で外し、行を書かず別枠も減らさない（翌バッチにまた候補になる）。
  // 網の手数料が上限を超えていた（xrpl_fee_over_cap）ときも同じく、そのバッチの XRPL は閉じる。
  let xrplLaneClosed = false;

  for (const [index, candidate] of candidates.entries()) {
    // Start nothing we cannot finish inside maxDuration. Purchases already in
    // flight are never interrupted — the whole point is that a signed
    // authorization must always reach its ledger row.
    if (!canStartAnotherPurchase(deadline.remaining(), timeoutMs)) {
      summary.stoppedForDeadline = true;
      summary.notAttempted = candidates.length - index;
      break;
    }
    const isXrplCandidate = candidate.network === XRPL_MAINNET_CAIP2;
    if (isXrplCandidate && xrplLaneClosed) {
      summary.skipped++;
      continue;
    }
    // SQL が外しているはずだが、二重防御（2026-09-02 A1）。テンプレート URL に
    // 署名して予算を燃やす経路は、どの入口からも開かない。
    if (isPathTemplate(candidate.resourceUrl)) {
      summary.skipped++;
      continue;
    }
    try {
      // レーンの accept 優先（LANE_NETWORK）: selectable なレーンのうち、この endpoint にその
      // チェーンでの settled 行がまだ無いものを先に選ばせる。
      const preferNetworks = selectableLaneNetworks.filter((n) => !candidate.settledNetworks.includes(n));
      const outcome = await purchaseOne({ candidate, preferNetworks, account, solanaKeypair, getSolanaBlockhash, xrplPayer, xrplWallet, getXrplSigningInputs, fetchImpl, timeoutMs, db, spentToday, payerFunds, onPayerUnfunded, tempoEnabled: laneSelectable.get("tempo") ?? false, mppxCharge: options.mppxCharge });
      spentToday += outcome.spent;
      if (isXrplCandidate && outcome.spent > 0n) xrplLaneClosed = true;
      summary.spentUnitsTotal = String(BigInt(summary.spentUnitsTotal) + outcome.spent);
      if (outcome.kind === "attempted") {
        summary.attempted++;
        if (outcome.settled) summary.settled++;
        else if (outcome.status === "delivered_no_receipt") summary.deliveredNoReceipt++;
        else summary.settleFailed++;
      } else if (outcome.kind === "halted") {
        // 停止は「この候補には高すぎた」ではなく「もう買うな」。予算否認と違い、
        // 残りの候補を歩き続ける理由がひとつも無いのでバッチごと降りる。
        summary.halted = true;
        summary.haltReason = outcome.haltReason ?? null;
        summary.disabledReason = "spending_halted";
        summary.notAttempted = candidates.length - index - 1;
        break;
      } else if (outcome.kind === "payer_unfunded") {
        // 署名していない。summary.payerUnfunded は onPayerUnfunded が数える。残りの候補は
        // 安いものなら買える（バッチ内の署名額を差し引いた残高で比べる）ので歩き続ける。
      } else if (outcome.kind === "xrpl_fee_over_cap") {
        // 網の open_ledger_fee が上限超。署名していない・行も無い。このバッチの XRPL は閉じ、
        // 他チェーンの候補は歩き続ける。理由は summary とサーバログに残す。
        summary.xrplFeeOverCap++;
        if (!xrplLaneClosed) {
          logServerError("observatory.l1.xrpl_fee_over_cap", new Error(`open_ledger_fee above ${1_000} drops; XRPL lane closed for this batch`));
        }
        xrplLaneClosed = true;
      } else if (outcome.kind === "budget_denied") {
        summary.budgetDenied++;
        // Budget exhausted for anything at this price — later candidates may
        // be cheaper, so keep walking rather than break (prices vary 100x).
      } else {
        summary.skipped++;
      }
    } catch (error) {
      logServerError("observatory.l1.purchase", error);
      summary.skipped++;
    }
  }

  return summary;
}

/** 候補 SQL の 1 行 → Candidate（主候補とレーン枠の候補が同じ形になるように共有）。 */
function rowToCandidate(r: Record<string, unknown>): Candidate {
  return {
    id: String(r.id),
    resourceUrl: String(r.resource_url),
    method: (r.method as string | null) ?? null,
    priceAmount: (r.price_amount as string | null) ?? null,
    payTo: (r.pay_to as string | null) ?? null,
    network: (r.network as string | null) ?? null,
    declaredSchema: r.declared_schema ?? null,
    isPriority: r.is_priority === true,
    isMature: r.is_mature === true,
    settledNetworks: parseTextArray(r.settled_networks),
  };
}

/** text[] は pg では配列、経路によっては '{a,b}' の文字列で来る。どちらも読む。無ければ空。 */
function parseTextArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.startsWith("{") && v.endsWith("}")) {
    const inner = v.slice(1, -1);
    return inner === "" ? [] : inner.split(",").map((x) => x.replace(/^"|"$/g, ""));
  }
  return [];
}

/**
 * チェーンごとの候補の最低枠（2026-09-17）。別枠を持つレーン（CHAIN_DAILY_CAPS の表）を順に
 * 回し、有効なレーンごとに最大 `floor` 件を取って主候補の先頭に置く行を返す。
 *
 *  - レーン同士は id で重複排除する。主候補との重複は呼び手が主候補側から抜く（先頭へ移す）。
 *  - 旗が off（`ready` でない）レーンは問い合わせない。別枠が尽きたレーンは候補 SQL の
 *    laneExclusions が同じ WHERE で外すので 0 行になる（行は書かない・従来どおり除外）。
 *  - 1 レーンの問い合わせが失敗しても、バッチは止めない（枠は並びの補助であって金の関門では
 *    ない）。ログに残して 0 件として続ける。
 *  - 購入の可否はここでは決めない。返した候補は主候補と同じく purchaseOne を通り、デッドライン・
 *    別枠・残高・原子的予約の関門をそのまま受ける。
 */
export async function laneFloorCandidates(input: {
  lanes: readonly { chain: CappedChain; ready: boolean }[];
  floor: number;
  fetchLane: (chain: CappedChain, limit: number) => Promise<unknown>;
}): Promise<{ head: Candidate[]; counts: Partial<Record<CappedChain, number>> }> {
  const head: Candidate[] = [];
  const counts: Partial<Record<CappedChain, number>> = {};
  const seen = new Set<string>();
  for (const lane of input.lanes) {
    counts[lane.chain] = 0;
    if (!lane.ready || input.floor <= 0) continue;
    let rows: Record<string, unknown>[] = [];
    try {
      const raw = await input.fetchLane(lane.chain, input.floor);
      rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    } catch (error) {
      if (!isMissingSchemaError(error)) logServerError(`observatory.l1.lane_floor_${lane.chain}`, error);
      continue;
    }
    for (const row of rows) {
      const candidate = rowToCandidate(row);
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      head.push(candidate);
      counts[lane.chain] = (counts[lane.chain] ?? 0) + 1;
    }
  }
  return { head, counts };
}

async function purchaseOne(input: {
  candidate: Candidate;
  /** selectAccept に先に選ばせる network（LANE_NETWORK・settled 済みは除く）。 */
  preferNetworks: readonly string[];
  account: ReturnType<typeof privateKeyToAccount>;
  solanaKeypair: Keypair | null;
  getSolanaBlockhash: () => Promise<string>;
  xrplPayer: XrplPayerModule | null;
  xrplWallet: XrplWallet | null;
  getXrplSigningInputs: (address: string) => Promise<XrplSigningInputs>;
  fetchImpl: (url: string, init?: RequestInit, call?: SafeFetchCallOptions) => Promise<Response>;
  timeoutMs: number;
  db: NonNullable<ReturnType<typeof getDb>>;
  spentToday: bigint;
  payerFunds: PayerFunds;
  onPayerUnfunded: (chain: string, detail: Record<string, unknown>) => void;
  /** Tempo（MPP）を買ってよいか（フラグ・別枠）。false なら Tempo 候補は試行しない。 */
  tempoEnabled: boolean;
  mppxCharge?: MppxCharge;
}): Promise<{
  kind: "attempted" | "skipped" | "budget_denied" | "halted" | "payer_unfunded" | "xrpl_fee_over_cap";
  settled: boolean;
  spent: bigint;
  /** 台帳に書いた status（attempted のときのみ）——summary の集計はこれを見る。 */
  status?: string;
  /** kind === "halted" のときの判定理由（cron 応答とログに出る）。 */
  haltReason?: string;
}> {
  const { candidate, preferNetworks, account, solanaKeypair, getSolanaBlockhash, xrplPayer, xrplWallet, getXrplSigningInputs, fetchImpl, timeoutMs, db, spentToday, payerFunds, onPayerUnfunded, tempoEnabled, mppxCharge } = input;
  const method = (candidate.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  const isSolana = candidate.network === SOLANA_MAINNET_CAIP2;
  // Tempo（MPP・2026-09-17）: 壁は x402 の封筒ではなく WWW-Authenticate: Payment。
  const isTempo = candidate.network === TEMPO_MAINNET_CAIP2;
  const isXrpl = candidate.network === XRPL_MAINNET_CAIP2;
  // 台帳上の payer 表記: EVM は小文字（既存の join 規約）・base58 は原文
  // （小文字化は base58 を破壊する——catalog-source と同じ理由）。
  const payerLabel = isSolana
    ? (solanaKeypair?.publicKey.toBase58() ?? "solana_key_missing")
    : isXrpl
      ? (xrplWallet?.classicAddress ?? "xrpl_key_missing")
      : account.address.toLowerCase();

  const record = async (row: Partial<typeof x402L1Purchases.$inferInsert>) => {
    await db.insert(x402L1Purchases).values({
      endpointId: candidate.id,
      status: "request_error",
      payer: payerLabel,
      ...row,
    });
    invalidateDecisionCache(candidate.id); // 購入結果は判定材料（このインスタンスのみ・cache.ts 参照）
  };

  // runL1Batch が solanaReady で候補を絞るので、ここに solana 候補が来て
  // 鍵が無いのは onlyEndpointId 経路等の異常系だけ——黙って進まない。
  if (isSolana && !solanaKeypair) {
    return { kind: "skipped", settled: false, spent: 0n };
  }
  // 同じく二重防御: フラグ無しの Tempo 候補はここへ来ないが、来ても 1 リクエストも出さない。
  if (isTempo && !tempoEnabled) {
    return { kind: "skipped", settled: false, spent: 0n };
  }
  if (isXrpl && (!xrplWallet || !xrplPayer)) {
    return { kind: "skipped", settled: false, spent: 0n };
  }

  // Unpaid request → expect the wall.
  //
  // 2026-08-22 (audit, Critical): the abort timer MUST still be armed while the
  // BODY is read. AbortController only bounds the response up to its headers —
  // clearing the timer before `.text()` (what this code did) left a seller free
  // to dribble a body out forever, and timeoutMs stopped meaning anything. The
  // clear now lives in `finally`, so the whole request+body is inside one
  // budget and a slow body aborts like any other timeout.
  // 無払いの要求の本文は `{}` のまま（2026-09-17 Issue #29 で判断）。売り手の本文の宣言
  // （extensions.bazaar.info.input.body）はこの要求への 402 応答に載っていて、読む前に
  // 送れる宣言は無い。x402 の壁は本文を見る前に 402 を返すので `{}` で足りる——公開
  // export（2026-09-16 取得・30 日）で無払いが 402 にならなかった行（no_402）は 24 行／約 6,700 行。
  let first: Response;
  let firstBody = "";
  const firstController = new AbortController();
  const firstTimer = setTimeout(() => firstController.abort(), timeoutMs);
  try {
    first = await fetchImpl(candidate.resourceUrl, {
      method,
      signal: firstController.signal,
      redirect: "follow",
      headers: { accept: "application/json", "user-agent": "vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    firstBody = await readBodyCapped(first, 16_000);
  } catch (error) {
    await record({
      status: "request_error",
      rawResponseMeta: {
        phase: "unpaid",
        // A target the SSRF guard refused records OUR decision, not a
        // measurement of the seller — kept as its own reason code so the two
        // never get read as the same thing.
        reason: error instanceof UnsafeTargetError ? error.reason : null,
        error: String(error).slice(0, 300),
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  } finally {
    clearTimeout(firstTimer);
  }

  if (first.status !== 402) {
    await record({ status: "no_402", httpStatusPaid: null, rawResponseMeta: { phase: "unpaid", status: first.status } });
    return { kind: "skipped", settled: false, spent: 0n };
  }

  // MPP の challenge（Tempo）は WWW-Authenticate に載る。x402 の封筒は Tempo では読まない
  // （x402 の accept に署名する経路が Tempo に向かって開かない）。
  // 読むのは mppx の Challenge.deserializeList（2026-09-17 レビュー #5/#6）。mppx が読めない
  // ヘッダは署名器も読めない＝ unsignable。**予約より前に**落とす（2026-09-04 監査 P1-2 と同じ規律。
  // status の語彙は閉じているので no_eligible_accept に載せ、detail に unsignable を残す）。
  const mppParsed = isTempo ? await parseMppChallengesFromHeaders(first.headers) : { challenges: [], error: null };
  const mppChallenges = mppParsed.challenges;
  const challenge = isTempo
    ? mppChallenges.length > 0
      ? { x402Version: 2 as const, accepts: [] as never[] }
      : null
    : parseChallenge({ bodyText: firstBody, headers: first.headers });
  if (!challenge) {
    await record({
      status: "no_eligible_accept",
      rawResponseMeta: {
        phase: "unpaid",
        note: isTempo ? (mppParsed.error ? "mppx could not deserialize the Payment challenge" : "no MPP Payment challenge") : "unparseable challenge",
        ...(isTempo ? { protocol: "mpp", ...(mppParsed.error ? { detail: "unsignable", error: mppParsed.error } : {}) } : {}),
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }

  const mppSelection = isTempo
    ? selectMppChallenge(mppChallenges, { declaredAmount: candidate.priceAmount, declaredPayTo: candidate.payTo })
    : null;
  const selection = mppSelection
    ? mppSelection
    : isSolana
    ? selectSolanaAccept(challenge.accepts, {
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
        payerAddress: solanaKeypair?.publicKey.toBase58() ?? null,
      })
    : isXrpl
      ? xrplPayer!.selectXrplAccept(challenge.accepts, {
          declaredAmount: candidate.priceAmount,
          declaredPayTo: candidate.payTo,
        })
      : selectAccept(challenge.accepts, {
          declaredAmount: candidate.priceAmount,
          declaredPayTo: candidate.payTo,
          // 宣言額はカタログの先頭 accept（e.network）の値。別チェーンの accept とは比べない。
          declaredNetwork: candidate.network,
          preferNetworks,
        });
  // ここから先の台帳の network・別枠（reserveSpend の cappedChainFor）・残高の chain（payerChain）は
  // すべて「選んだ accept の network」で決まる——Base 先頭の exa の行を Arc の accept で買えば、
  // 行は eip155:5042・別枠 arc・残高 arc になる（tests/l1-lane-accept-preference.pg.test.ts）。
  // XRPL の封筒は v2 だけ（正本に v1 の形が無い）。v1 の壁には署名しない。
  const xrplV1Wall = isXrpl && selection.accept !== null && challenge.x402Version !== 2;
  if (!selection.accept || xrplV1Wall) {
    await record({
      status: xrplV1Wall ? "no_eligible_accept" : selection.reason!,
      rawResponseMeta: {
        phase: "select",
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
        ...(mppSelection
          ? {
              protocol: "mpp",
              detail: mppSelection.detail,
              challenges: mppChallenges.slice(0, 4).map((c) => ({
                id: c.id,
                realm: c.realm,
                method: c.method,
                intent: c.intent,
                chainId: c.request?.methodDetails.chainId ?? null,
                currency: c.request?.currency ?? null,
                amount: c.request?.amount ?? null,
                recipient: c.request?.recipient ?? null,
                expires: c.expires,
              })),
            }
          : {
              challengeAccepts: challenge.accepts.slice(0, 4),
              // XRPL の no_eligible_accept の内訳（asset_not_usd = XRP 建てだけの壁・v1 は RLUSD のみ）。
              ...(xrplV1Wall ? { reason: "x402_v1_unsupported" } : "detail" in selection && selection.detail ? { reason: selection.detail } : {}),
            }),
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }
  const accept = selection.accept;
  // XRPL の IOU は "0.01" のような単位の 10 進文字列（selectXrplAccept が 6 桁 units に落とす）。
  // EVM / Solana は基本単位の整数文字列。台帳（amount_units / spent_units）は常に 6 桁 units。
  const amount: bigint = "amountUnits" in selection ? (selection.amountUnits as bigint) : BigInt(accept.amount);
  const amountUnitsText = String(amount);
  // 行に書く network は定数（2026-09-17 レビュー #1）。selectXrplAccept は完全一致しか通さないので accept.network と
  // 同じ値だが、別枠の `LIKE 'xrpl:%'` と照合の `=== "xrpl:0"` が壁の表記に依存しないことをここで固定する。
  const ledgerNetwork = isXrpl ? XRPL_MAINNET_CAIP2 : accept.network;
  // 支払い付き POST の本文（2026-09-17 Issue #29）。売り手が 402 で宣言した input.body を
  // そのまま送り、無ければ従来どおり `{}`。規則は declared-input.ts。
  const paidRequestBody: { body: string; source: RequestBodySource } | null =
    method === "POST" ? declaredRequestBody({ bodyText: firstBody, headers: first.headers }) : null;

  // Budget gate — BEFORE signing. The ledger, not memory, is the truth.
  const budget = checkL1Budget({
    spentTodayUsd: unitsToUsd(spentToday),
    requestUsd: unitsToUsd(amount),
  });
  if (!budget.allowed) {
    await record({
      status: "budget_denied",
      amountUnits: amountUnitsText,
      rawResponseMeta: { reason: budget.reason, dailyBudgetUsd: DAILY_BUDGET_USD },
    });
    return { kind: "budget_denied", settled: false, spent: 0n };
  }

  // Solana は署名の材料に blockhash（外部RPC）が要る。予約の後に外部I/Oで
  // 失敗すると「signed → counted」の不変条件が破れるので、予約の前に取る。
  let solanaBlockhash: string | null = null;
  if (isSolana) {
    try {
      solanaBlockhash = await getSolanaBlockhash();
    } catch (error) {
      await record({
        status: "request_error",
        rawResponseMeta: { phase: "blockhash", error: String(error).slice(0, 300) },
      });
      return { kind: "skipped", settled: false, spent: 0n };
    }
  }
  // XRPL（2026-09-17）: Sequence と validated ledger（LastLedgerSequence の基準）。Solana の blockhash と
  // 同じ理由で予約の前に取る。
  let xrplSigningInputs: XrplSigningInputs | null = null;
  if (isXrpl) {
    try {
      xrplSigningInputs = await getXrplSigningInputs(xrplWallet!.classicAddress);
    } catch (error) {
      await record({
        status: "request_error",
        rawResponseMeta: { phase: "xrpl_signing_inputs", error: String(error).slice(0, 300) },
      });
      return { kind: "skipped", settled: false, spent: 0n };
    }
    // 手数料が上限超（clampFeeDrops → null）。署名せず、行も書かない（payer_unfunded と同じ作法）。
    if (xrplSigningInputs.feeDrops === null) {
      return { kind: "xrpl_fee_over_cap", settled: false, spent: 0n };
    }
  }

  // Self-dealing backstop (2026-08-22 audit), the LAST gate before money is
  // committed. Candidate selection excludes our own payTo, but it can only
  // filter the CATALOG's e.pay_to — a wall is free to answer with a different
  // address, and when the catalog declared none (declaredPayTo === null) the
  // payto_mismatch gate above has nothing to compare against either. An
  // on-chain self-transfer dressed up as a "settle-through verified" receipt
  // would make the neutrality that is the whole moat a lie, so it is refused
  // here and recorded (operator.ts).
  if (isOperatorPayTo(accept.payTo)) {
    await record({
      status: "payto_operator_self",
      network: ledgerNetwork,
      asset: accept.asset,
      payTo: accept.payTo.startsWith("0x") ? accept.payTo.toLowerCase() : accept.payTo,
      amountUnits: amountUnitsText,
      rawResponseMeta: {
        phase: "select",
        reason: "wall named the operator's own payTo",
        declaredPayTo: candidate.payTo,
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }

  // 実行時の停止スイッチ・1 回目（2026-09-05 監査 P0）。予約の**前**に読む。
  // バッチ開始時の判定はここまでに数十秒〜数分古くなっている——運用者が
  // 「いま止めろ」と言ったのに、走行中のバッチが残りを買い切ってしまう窓が
  // その差分。予約を取る前に落とせば、日次予算も食わない。
  const preReserveHalt = await haltGate(db);
  if (preReserveHalt.halted) {
    // 行を書く（黙って飛ばさない）。副作用として、この endpoint はスイープ窓
    // （既定 6 日）のあいだ再選択されない——budget_denied と同じ挙動で、停止は
    // 稀なので許容する。バッチは次の候補へ進まず降りるので、行は 1 件だけ。
    await record({
      status: "halted",
      amountUnits: amountUnitsText,
      rawResponseMeta: { phase: "pre_reserve", reason: preReserveHalt.reason },
    });
    return { kind: "halted", settled: false, spent: 0n, haltReason: preReserveHalt.reason };
  }

  // 購入元残高の関門（2026-09-17 Issue #29）。予約と署名の**前**。2026-09-13〜15 に Base の
  // 購入元の USDC が尽きたまま署名を続け、売り手の 402 を `settle_failed` として 972 行
  // 記録した——我々の資金切れを売り手の失敗にした。足りない／読めないなら署名しない。
  // 行は書かない（chain_daily_cap と同じ: 書くとスイープ窓のあいだ再選択されない）。
  // 2026-09-17 Arc レーン: 残高はチェーンごと。Arc は Base と同じ EOA だが Arc の USDC は別。
  // XRPL（2026-09-17）は独立の seed。残高は RLUSD + 手数料ぶんの XRP（payer-funds.ts）。
  const payerChain: PayerChain = isTempo ? "tempo" : isSolana ? "solana" : isXrpl ? "xrpl" : evmChainFor(accept.network)?.chainId === 5042 ? "arc" : "base";
  const payerOwner = isSolana ? solanaKeypair!.publicKey.toBase58() : isXrpl ? xrplWallet!.classicAddress : account.address;
  const funds = await payerFunds.check(payerChain, payerOwner, amount);
  if (!funds.ok) {
    onPayerUnfunded(payerChain, { ...funds, amountUnits: String(amount) });
    return { kind: "payer_unfunded", settled: false, spent: 0n };
  }

  // Reserve BEFORE signing. This is the authoritative gate: it re-reads the
  // day's total and the sweep window inside one statement and writes the row
  // that carries spent_units, so the money is on the ledger before it can
  // exist. A kill, a timeout or a DB error after this point loses the outcome
  // detail, never the spend.
  const reservation = await reserveSpend({
    db,
    endpointId: candidate.id,
    payer: payerLabel,
    network: ledgerNetwork,
    asset: accept.asset,
    payTo: accept.payTo.startsWith("0x") ? accept.payTo.toLowerCase() : accept.payTo,
    amountUnits: String(amount),
    windowDays: sweepWindowDaysFor({
      isPriority: candidate.isPriority,
      isMature: candidate.isMature,
    }),
  });
  if (!reservation.ok) {
    if (reservation.reason === "already_purchased") {
      // A concurrent run got this endpoint first — its row is the record.
      return { kind: "skipped", settled: false, spent: 0n };
    }
    if (reservation.reason === "first_purchase_quota") {
      // その UTC 日の初回購入の枠が尽きた。行を書かない——書くとスイープ窓の
      // あいだ再選択されず、翌日の枠にも戻らない（枠は延期であって除外ではない）。
      return { kind: "skipped", settled: false, spent: 0n };
    }
    if (reservation.reason === "chain_daily_cap") {
      // そのチェーン（Solana・Arc）の別枠に届かなかった。行を書かない——書くとこの売り手は
      // スイープ窓のあいだ再選択されず、掃引が終わらない。翌 UTC 日にまた候補になる。
      return { kind: "skipped", settled: false, spent: 0n };
    }
    await record({
      status: "budget_denied",
      amountUnits: amountUnitsText,
      rawResponseMeta: { reason: "daily_budget_exceeded", dailyBudgetUsd: DAILY_BUDGET_USD },
    });
    return { kind: "budget_denied", settled: false, spent: 0n };
  }

  // 2026-09-04 監査 P1-2: **予約より後は、何が飛んでも行を in_flight のまま
  // 置かない。** reserveSpend は署名の前に spent_units を立てる（正しい——
  // 署名済み EIP-3009 は validBefore まで生きた金）。だから予約の後で例外が
  // 出ると、一円も動いていないのに日次 $25 の観測予算だけが減り、行は
  // in_flight のまま残る。in_flight は冷却のどの status にも当たらないので、
  // 同じ売り手に何度でも同じことをさせられた（可用性への攻撃）。
  //
  // 署名できない accept は selectAccept / selectSolanaAccept が予約より前に
  // 落とすようになったが、それは既知の形だけを塞ぐ。ここは**未知の形**の
  // 受け皿で、落ちた行は settle_failed（分母に入る status・冷却の対象）へ倒す。
  // 実行時の停止スイッチ・2 回目（2026-09-05 監査 P0）。**署名の直前**。
  // 予約は署名の前に spent_units を立てるので、ここで止めるなら予約を
  // 0 へ戻す必要がある——署名していない予約は「金」ではないのに、放置すると
  // 停止したぶんだけ日次予算が消えてしまう。行は消さず `halted` で残す
  // （何が起きたかを台帳が答えられる状態を崩さない）。
  const preSignHalt = await haltGate(db);
  if (preSignHalt.halted) {
    await db
      .update(x402L1Purchases)
      .set({
        status: "halted",
        spentUnits: "0",
        rawResponseMeta: { phase: "pre_sign", reason: preSignHalt.reason },
      })
      .where(eq(x402L1Purchases.id, reservation.rowId));
    invalidateDecisionCache(candidate.id);
    return { kind: "halted", settled: false, spent: 0n, haltReason: preSignHalt.reason };
  }

  // ここから先は署名する。このバッチの残高の見積もりから差し引く（決済は非同期なので、
  // 成立を待たずに「使った」とみなす——過大に見積もって署名し続けないため）。
  payerFunds.commit(payerChain, payerOwner, amount);

  try {
    // Sign — from here on the money is live, so the ledger row ALWAYS carries
    // spent_units, whatever the seller does next.
    let header: { headerName: string; headerValue: string };
    // 我々しか作れない一回性の値。行に残して初めて「その決済 tx はこの購入のもの」
    // と照合できる（2026-09-04 監査 P1-1・settlement-verify.ts の nonce 束縛）。
    let authNonce: string;
    if (mppSelection && mppSelection.accept) {
      // Tempo（MPP）: 署名は参照実装 mppx に委ね、ピン（chainId 4217・受取先の許可リスト・
      // pull）は我々が渡す。memo（帰属 bytes32）を auth_nonce として残し、決済照合が
      // tx の TransferWithMemo と突き合わせる。
      const cred = await createMppCredential(
        { account, challenge: mppSelection.accept.mpp, recipient: accept.payTo },
        mppxCharge ? { mppxCharge } : {},
      );
      authNonce = cred.memo;
      header = { headerName: cred.headerName, headerValue: cred.headerValue };
    } else if (isSolana) {
      const built = await buildSolanaPaymentTransaction({
        accept,
        payer: solanaKeypair!,
        recentBlockhash: solanaBlockhash!,
      });
      authNonce = built.memo;
      header = encodeSolanaPaymentHeader({
        accept,
        transactionB64: built.transactionB64,
        resourceUrl: candidate.resourceUrl,
      });
    } else if (isXrpl) {
      // XRPL（2026-09-17）: 署名済み blob の hash が「その tx はこの購入のもの」の材料。
      // 提出前に我々だけが知り、売り手には選べない（照合器は claimed tx == この hash を要求する）。
      const tx = xrplPayer!.buildXrplPayment({
        account: xrplWallet!.classicAddress,
        accept,
        sequence: xrplSigningInputs!.sequence,
        validatedLedgerIndex: xrplSigningInputs!.validatedLedgerIndex,
        feeDrops: xrplSigningInputs!.feeDrops ?? undefined,
      });
      const signed = xrplPayer!.signXrplPayment(xrplWallet!, tx);
      authNonce = signed.hash;
      header = encodePaymentHeader({
        x402Version: 2,
        accept,
        payload: { signedTxBlob: signed.signedTxBlob },
        resourceUrl: candidate.resourceUrl,
      });
    } else {
      const authorization = buildAuthorization({
        from: account.address,
        to: accept.payTo,
        value: accept.amount,
        nowSec: Math.floor(Date.now() / 1000),
        maxTimeoutSeconds: accept.maxTimeoutSeconds,
      });
      authNonce = authorization.nonce;
      const { signature } = await signX402Payment({ account, accept, authorization });
      header = encodePaymentHeader({
        x402Version: challenge.x402Version,
        accept,
        payload: { signature, authorization },
        resourceUrl: candidate.resourceUrl,
      });
    }
    // 署名の直後に nonce を確定させる。ここから先で落ちても、行には
    // 「何に署名したか」が残る（予約行は既にあるので UPDATE）。
    await db
      .update(x402L1Purchases)
      .set({ authNonce })
      .where(eq(x402L1Purchases.id, reservation.rowId));

    let paid: Response | null = null;
    let paidBody = "";
    let paidError: string | null = null;
    // Same 2026-08-22 fix as the unpaid leg: the timer covers the body read too.
    // On the PAID leg an aborted body is not a lost measurement — the settlement
    // receipt lives in the HEADERS, which we already hold — so the outcome is
    // still recorded, with the body error kept in rawResponseMeta.bodyError.
    const paidController = new AbortController();
    const paidTimer = setTimeout(() => paidController.abort(), timeoutMs);
    try {
      paid = await fetchImpl(candidate.resourceUrl, {
        method,
        signal: paidController.signal,
        redirect: "follow",
        headers: {
          accept: "application/json",
          "user-agent": "vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)",
          [header.headerName]: header.headerValue,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(paidRequestBody ? { body: paidRequestBody.body } : {}),
      },
        // 2026-09-17（Issue #29 独立検証）: 宣言本文は売り手のオリジンから出さない。別オリジンへ
        // 本文を運ぶ転送には従わず 3xx をそのまま記録する（safe-fetch.ts の crossOriginBody）。
        // `{}` の要求は従来どおり。
        paidRequestBody?.source === "declared" ? { crossOriginBody: "refuse" } : undefined,
      );
      paidBody = await readBodyCapped(paid, 16_000);
    } catch (error) {
      paidError = String(error).slice(0, 300);
    } finally {
      clearTimeout(paidTimer);
    }

    const latencyMs = Date.now() - startedAt;
    // MPP の受領証は Payment-Receipt（base64url JSON・reference = tx hash）。x402 と同じ形へ写してある。
    const mppReceipt = paid && isTempo ? parseMppReceipt(paid.headers) : null;
    const settlement = paid ? (isTempo ? mppReceipt : parseSettlementResponse(paid.headers)) : null;
    const payloadNonEmpty = paidBody.trim().length > 0;
    const contentType = paid?.headers.get("content-type") ?? null;
    const contentTypeMatch = contentType === null ? null : contentType.includes("json");

    // L2 — minimal structural check against the catalog-declared schema.
    let l2Schema: string = "not_checked";
    let l2Detail: { missing: string[]; declarationHash: string | null; responseHash: string } | null = null;
    if (paid && paid.status === 200) {
      const d = checkL2Detailed(candidate.declaredSchema, paidBody, contentType);
      l2Schema = d.status;
      l2Detail = { missing: d.missing, declarationHash: d.declarationHash, responseHash: d.responseHash };
    }

    // 2026-08-23 監査: ここまで `transaction` は「空でない文字列」以外を何も見ていなかった。
    // 値は売り手の PAYMENT-RESPONSE ヘッダそのままで、決済せずに success:true と
    // 架空の文字列を返すだけで「決済成功」の行を作れた。その行は公開台帳になり、
    // 2026-08-22 以降は observed_purchases 経由でスコアの最上位軸にも流れる。
    //
    // 形式検査は権威ではない（形だけ正しい偽ハッシュは通る）。本当の関門は
    // オンチェーン照合で、それが入るまでは「売り手申告＋形式検査済み」と公開面に書く。
    // ここで分けるのは「決済したと言い、識別子も筋が通っている」ことと
    // 「決済したと言うが、識別子がトランザクションIDですらない」ことの区別——
    // 後者は売り手についての所見なので、delivered_no_receipt（レシートを主張して
    // いない）に潰さず独立した status にする。
    const claimedSettlement = settlement?.success === true && !!settlement.transaction;
    const settlementTxWellFormed =
      claimedSettlement &&
      isWellFormedSettlementTx(settlement!.transaction, isSolana ? "solana" : isXrpl ? "xrpl" : "evm");

    // 2026-08-23 監査 C-4: ここで `settled` と名乗らない。
    // settled の定義は「我々がチェーンで確認した」であって、売り手が success:true と
    // 返したことではない。購入直後にチェーンを読みに行くと、確定を待つ間に
    // バッチのデッドラインを食い潰す（しかも確定前の tx を確認済みと刻む事故になる）。
    // だから購入は `settle_claimed` で置き、日次の照合 cron が
    // `settled` / `settle_claim_refuted` へ確定させる。
    const claimedAndWellFormed = claimedSettlement && settlementTxWellFormed;
    const status = !paid
      ? "settle_failed"
      : claimedAndWellFormed
        ? "settle_claimed"
        : claimedSettlement
          ? "settle_claimed_unverifiable" // 決済したと主張したが識別子が形式不正
          : paid.status === 200
            ? "delivered_no_receipt" // goods returned but no settlement receipt header
            : "settle_failed";
    // summary の互換のため「売り手が決済を主張したか」は残すが、これは
    // settled ではない。名前で取り違えないよう別名にしてある。
    const settled = claimedAndWellFormed;

    // Resolve the reservation in place — spent_units stays exactly what was
    // reserved (signed = counted, success or not); only the outcome is filled in.
    const rawResponseMeta = {
      phase: "paid",
      status: paid?.status ?? null,
      contentType,
      // Tempo は MPP（WWW-Authenticate: Payment / Authorization: Payment / Payment-Receipt）。
      ...(isTempo ? { protocol: "mpp" } : {}),
      bodyHead: paidBody.slice(0, 500),
      // どの本文で POST したか（2026-09-17 Issue #29）。"declared" は売り手の 402 が宣言した
      // input.body、"empty" は `{}`。GET には付けない。
      ...(paidRequestBody ? { requestBody: paidRequestBody.source } : {}),
      // A response whose HEADERS arrived but whose body aborted/failed: the
      // error would otherwise be dropped (rawSettlement keeps the settlement
      // when one exists), so it is kept here rather than silently lost.
      ...(paid && paidError ? { bodyError: paidError } : {}),
      // §6.3: L2 の判定材料。mismatch の公開に要る宣言ハッシュ・応答ハッシュ・欠落キー。
      ...(l2Detail ? { l2: l2Detail } : {}),
    };
    const outcomeRow = {
      status,
      txHash: settlement?.transaction ?? null,
      httpStatusPaid: paid?.status ?? null,
      latencyMs,
      payloadNonEmpty: paid ? payloadNonEmpty : null,
      contentTypeMatch,
      l2Schema,
      rawSettlement: settlement
        ? isTempo && mppReceipt
          ? { ...settlement, receipt: mppReceipt.receipt, header: paid?.headers.get("payment-receipt") ?? null }
          : settlement
        : paidError
          ? { error: paidError }
          : null,
      rawResponseMeta,
    };
    let recordedStatus = status;
    try {
      await db.update(x402L1Purchases).set(outcomeRow).where(eq(x402L1Purchases.id, reservation.rowId));
    } catch (error) {
      if (!isDuplicateTxHashError(error)) throw error;
      // 2026-09-04 監査 P1-1: 売り手が**別の購入で既に使われた tx**をレシートとして
      // 返した。部分一意 index（x402_l1_purchases_tx_unique）が書き込みを弾いた
      // ——それ自体が売り手についての所見なので、行を in_flight のまま残さず
      // その場で確定させる。tx_hash は null で入れる（一意 index を再び踏まないため。
      // 主張された値は raw_response_meta に残るので消えていない）。
      recordedStatus = "settle_claim_refuted";
      await db
        .update(x402L1Purchases)
        .set({
          ...outcomeRow,
          status: recordedStatus,
          txHash: null,
          settlementVerified: false,
          settlementVerifiedAt: new Date(),
          settlementVerifyReason: `tx_hash_reused: ${settlement?.transaction ?? ""}`.slice(0, 500),
          rawResponseMeta: { ...rawResponseMeta, reusedTxHash: settlement?.transaction ?? null },
        })
        .where(eq(x402L1Purchases.id, reservation.rowId));
    }
    invalidateDecisionCache(candidate.id);

    // observed_purchases への記帳（2026-08-22 監査・項目1）。
    //
    // この表は scoreEconomicActivity（重み0.40の最上位軸）の L1 枝・
    // scoreL1Receiving・payee-engine の l1DeliveryDepth の唯一の材料で、
    // 「trusted-writer ingest」と設計されながら**全リポで呼び手が存在せず**
    // 0行だった（本番実測 2026-08-22: observed_purchases 0行 /
    // x402_l1_purchases 1,167行・決済成功496）。その間ずっと
    // signals.x402.l1PurchaseCount 等は常に 0 を公開していた。
    //
    // 何を1行とするか（schema と observed-purchases.ts の意味論に従う）:
    //  - tx_hash は NOT NULL かつ一意＝この表の自然キー。決済レシート
    //    （PAYMENT-RESPONSE の transaction）が無い試行は行にできないので、
    //    書けるのは settled のときだけ。delivered_no_receipt は「品は来たが
    //    レシートが無い」＝オンチェーンの購入として名指せないので書かない;
    //  - delivery_verified は**書き手側の保証**（reader は読み取り時に導出
    //    できず、このフラグを信じるだけ）。だから「品が実際に届いた」と
    //    我々が観測した時だけ true にする: HTTP 200 かつ本文が空でなく、
    //    宣言スキーマに対して mismatch でないこと。1つでも欠ければ false で
    //    記録する——行を捨てるのではなく、x402 相当の事実として残す;
    //  - block_timestamp は取らない（L1 はレシートのハッシュしか持たず、
    //    ブロック時刻を引く経路がまだ無い）。null なら reader は created_at を
    //    日次軸に使う（settledAt の coalesce）ので、数秒差で正しい日に入る。
    //    推測で埋めない。
    //
    // 大文字小文字: recordObservedPurchase は wallet/counterparty を小文字化
    // する。base58（Solana）には情報が失われるが、読み手
    // （getObservedPurchaseStats / getObservedDeliveryStats）も引数を小文字化
    // して比較するので、書き・読みで一貫している。台帳（x402_l1_purchases）
    // 側は base58 の原文を保つ、という既存の分担はそのまま。
    //
    // graceful: ここで何が起きても購入の記帳（正典は x402_l1_purchases）は
    // 既に完了している。ただし黙って消さない——失敗は logServerError に残す。
    // 2026-08-23 監査 C-4: **ここでは書かない。** 上の長いコメントが説明している
    // 配線は 2026-08-22 に入れたもので方向は正しかったが、当時の `settled` は
    // 「売り手が success:true と言った」でしかなかった。つまり売り手の自己申告が
    // そのままスコアの最上位軸へ流れていた。
    //
    // observed_purchases への書き込みは
    // src/lib/observatory/settlement-verifier.ts へ移した。オンチェーンで
    // 宛先・金額・トークン・チェーン・確定数を確認できた行だけが証拠になる。
    // delivery_verified の判定規則（isDeliveryVerified）は共有していて、
    // 遡及行と実時間行が食い違わないようにしてある。

    // ERC-8004 への公開（C4）は**ここでは呼ばない**（2026-09-02 監査 P1-7）。
    // この時点の `settled` は売り手の自己申告で、オンチェーンに書く verdict には
    // なれない。発火点は settlement-verifier（チェーンで settled / refuted が
    // 確定した後）。

    return {
      kind: "attempted",
      // 再利用 tx を弾いた行は settled の候補ではない。
      settled: settled && recordedStatus === status,
      spent: amount,
      status: recordedStatus,
    };
  } catch (error) {
    logServerError("observatory.l1.purchase_after_reservation", error);
    await resolveReservationAsFailed(db, reservation.rowId, error);
    invalidateDecisionCache(candidate.id);
    return { kind: "attempted", settled: false, spent: amount, status: "settle_failed" };
  }
}

/**
 * 「別の購入が既に使っている決済 tx」の一意違反か（2026-09-04 監査 P1-1）。
 *
 * postgres-js / neon-http でエラーの形が違うので、SQLSTATE と制約名の
 * どちらかで判定する。ここを取り違えると、無関係な DB 障害を売り手の
 * 所見（settle_claim_refuted）として記録してしまうので、制約名まで見る。
 */
function isDuplicateTxHashError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const text = `${(error as { constraint_name?: string })?.constraint_name ?? ""} ${String(error)}`;
  return (code === "23505" || /23505|duplicate key/i.test(text)) && /x402_l1_purchases_tx_unique/.test(text);
}

/**
 * L2 contract conformance, minimal and honest: with no declaration the
 * verdict is `no_declaration` (never a failure); with a declaration we check
 * what is machine-checkable without a full JSON-Schema engine — the body
 * parses as JSON and carries the declared top-level required/properties keys.
 */
/**
 * §6.3 / §14 P2（2026-09-02）: mismatch の公開には宣言のハッシュ・実レスポンスのハッシュ・
 * 差分の機械可読リストを付ける（生の有料コンテンツ全文は公開しない）。
 */
export function checkL2Detailed(
  declaredSchema: unknown,
  bodyText: string,
  contentType: string | null,
): { status: string; missing: string[]; declarationHash: string | null; responseHash: string } {
  const status = checkL2(declaredSchema, bodyText, contentType);
  const missing: string[] = [];
  const schema = typeof declaredSchema === "object" && declaredSchema !== null ? (declaredSchema as Record<string, unknown>) : null;
  if (status === "mismatch" && schema) {
    const props = (schema.properties ?? null) as Record<string, unknown> | null;
    const output = (props?.output ?? null) as Record<string, unknown> | null;
    const outputProps = (output?.properties ?? null) as Record<string, unknown> | null;
    const example = (outputProps?.example ?? null) as Record<string, unknown> | null;
    const requiredKeys = Array.isArray(example?.required) ? (example!.required as string[]) : [];
    let rec: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(bodyText);
      rec = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      rec = null;
    }
    for (const key of requiredKeys) if (!rec || !(key in rec)) missing.push(key);
  }
  const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
  return {
    status,
    missing,
    declarationHash: schema ? sha(JSON.stringify(schema)) : null,
    responseHash: sha(bodyText),
  };
}

function checkL2(declaredSchema: unknown, bodyText: string, contentType: string | null): string {
  const schema = typeof declaredSchema === "object" && declaredSchema !== null
    ? (declaredSchema as Record<string, unknown>)
    : null;
  if (!schema) return "no_declaration";

  // The catalog schema wraps input/output; the OUTPUT declaration is what the
  // response must honor.
  const props = (schema.properties ?? null) as Record<string, unknown> | null;
  const output = (props?.output ?? null) as Record<string, unknown> | null;
  const outputProps = (output?.properties ?? null) as Record<string, unknown> | null;
  const example = (outputProps?.example ?? null) as Record<string, unknown> | null;
  const exampleProps = (example?.properties ?? null) as Record<string, unknown> | null;
  const requiredKeys = Array.isArray(example?.required) ? (example!.required as string[]) : [];

  if (!contentType?.includes("json")) return requiredKeys.length > 0 ? "mismatch" : "no_declaration";

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return "mismatch";
  }
  if (requiredKeys.length === 0 && !exampleProps) return "no_declaration";
  const rec = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (!rec) return "mismatch";
  for (const key of requiredKeys) {
    if (!(key in rec)) return "mismatch";
  }
  return "match";
}

// ============================================================
// vet402 Observatory L1 — purchase runner (design §1 L1/L2, §5 W3).
//
// One batch = walk the real-demand target list and, per endpoint, do ONE
// covert purchase: request → 402 → sign (x402-payer's funnel of refusals) →
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
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { x402L1Purchases } from "@/lib/db/schema";
import { recordObservedPurchase } from "@/lib/db/observed-purchases";
import { readBodyCapped } from "@/lib/net/read-capped";
import { UnsafeTargetError, createSafeFetchImpl } from "@/lib/net/safe-fetch";
import { createDeadline } from "@/lib/util/deadline";
import { checkL1Budget, isL1Enabled, DAILY_BUDGET_USD } from "./budget";
import { isOperatorPayTo, operatorPayToDenylist } from "./operator";
import {
  buildAuthorization,
  encodePaymentHeader,
  parseChallenge,
  parseSettlementResponse,
  selectAccept,
  signX402Payment,
} from "./x402-payer";
import { logServerError } from "@/lib/util/log";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { fireL1RegistryHook } from "@/lib/chain/registry-hook";
import { Keypair } from "@solana/web3.js";
import {
  SOLANA_MAINNET_CAIP2,
  buildSolanaPaymentTransaction,
  encodeSolanaPaymentHeader,
  isSolanaL1Enabled,
  selectSolanaAccept,
} from "./sol402-payer";

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
  disabledReason: "l1_disabled" | "wallet_key_missing" | null;
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
};

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
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  return blockhash;
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
  | { ok: false; reason: "daily_budget_exceeded" | "already_purchased" };

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
  const raw = await db.execute(sql`
    WITH day AS (
      SELECT coalesce(sum(spent_units::numeric), 0) AS spent
      FROM x402_l1_purchases
      WHERE attempted_at >= date_trunc('day', now() AT TIME ZONE 'utc')
    ), dup AS (
      SELECT EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = ${endpointId}::uuid
          AND pu.attempted_at > now() - make_interval(days => ${windowDays})
      ) AS taken
    ), ins AS (
      INSERT INTO x402_l1_purchases
        (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units)
      SELECT ${endpointId}::uuid, 'in_flight', ${payer}, ${network}, ${asset},
             ${payTo}, ${amountUnits}, ${amountUnits}
      FROM day, dup
      WHERE NOT dup.taken
        AND day.spent + ${amountUnits}::numeric <= ${String(DAILY_BUDGET_UNITS)}::numeric
      RETURNING id
    )
    SELECT (SELECT id FROM ins)::text AS row_id, (SELECT taken FROM dup) AS taken
  `);
  const row = rowsOf(raw)[0];
  // No row back at all means the statement did not run as written — refuse to
  // spend on a gate whose verdict we cannot read.
  if (!row) throw new Error("l1 spend reservation returned no verdict row");
  const rowId = typeof row.row_id === "string" && row.row_id !== "" ? row.row_id : null;
  if (rowId) return { ok: true, rowId };
  return { ok: false, reason: row.taken === true ? "already_purchased" : "daily_budget_exceeded" };
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

export async function runL1Batch(
  options: {
    limit?: number;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
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
    disabledReason: null,
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
  const account = privateKeyToAccount(pk as `0x${string}`);
  // Solana は独立フラグ + 独立鍵。どちらか欠ければ candidates から除外される
  // （試行すらしない）。予算・台帳は Base と共有（USDC 基本単位が共通）。
  const solanaKeypair = isSolanaL1Enabled() ? loadSolanaKeypair() : null;
  const solanaReady = solanaKeypair !== null;

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
      WHERE attempted_at >= date_trunc('day', now() AT TIME ZONE 'utc')
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
  const rawTargets = await db.execute(sql`
    SELECT e.id, e.resource_url, e.method, e.price_amount, e.pay_to, e.network, e.declared_schema,
           (e.resource_key ILIKE ANY(${prioritySqlArray()})) AS is_priority
    FROM x402_endpoints e
    JOIN LATERAL (
      SELECT verdict FROM x402_l0_probes p
      WHERE p.endpoint_id = e.id
      ORDER BY probed_at DESC LIMIT 1
    ) lp ON lp.verdict = 'pass'
    WHERE e.status = 'active'
      ${onlyEndpointId ? sql`AND e.id = ${onlyEndpointId}::uuid` : sql``}
      ${
        // Solana購入が無効（フラグ無し or 鍵が読めない）の間は候補から
        // SQLの段階で外す——「試行してskip」の雑音でなく、最初から対象外。
        solanaReady ? sql`` : sql`AND (e.network IS NULL OR e.network NOT LIKE 'solana:%')`
      }
      ${selfExclusion}
      AND NOT EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = e.id
          AND pu.attempted_at > now() - make_interval(days => (CASE
            WHEN e.resource_key ILIKE ANY(${prioritySqlArray()}) THEN ${PRIORITY_SWEEP_WINDOW_DAYS}::int
            ELSE ${SWEEP_WINDOW_DAYS}::int
          END))
      )
    ORDER BY (e.resource_key ILIKE ANY(${prioritySqlArray()})) DESC,
             e.quality_payers_30d DESC NULLS LAST, e.quality_calls_30d DESC NULLS LAST
    LIMIT ${limit}
  `);
  const targetList = (Array.isArray(rawTargets)
    ? rawTargets
    : (rawTargets as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  const candidates: Candidate[] = targetList.map((r) => ({
    id: String(r.id),
    resourceUrl: String(r.resource_url),
    method: (r.method as string | null) ?? null,
    priceAmount: (r.price_amount as string | null) ?? null,
    payTo: (r.pay_to as string | null) ?? null,
    network: (r.network as string | null) ?? null,
    declaredSchema: r.declared_schema ?? null,
    isPriority: r.is_priority === true,
  }));

  const pendingHooks: Promise<void>[] = [];
  for (const [index, candidate] of candidates.entries()) {
    // Start nothing we cannot finish inside maxDuration. Purchases already in
    // flight are never interrupted — the whole point is that a signed
    // authorization must always reach its ledger row.
    if (!canStartAnotherPurchase(deadline.remaining(), timeoutMs)) {
      summary.stoppedForDeadline = true;
      summary.notAttempted = candidates.length - index;
      break;
    }
    try {
      const outcome = await purchaseOne({ candidate, account, solanaKeypair, getSolanaBlockhash, fetchImpl, timeoutMs, db, spentToday, pendingHooks });
      spentToday += outcome.spent;
      summary.spentUnitsTotal = String(BigInt(summary.spentUnitsTotal) + outcome.spent);
      if (outcome.kind === "attempted") {
        summary.attempted++;
        if (outcome.settled) summary.settled++;
        else if (outcome.status === "delivered_no_receipt") summary.deliveredNoReceipt++;
        else summary.settleFailed++;
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

  // レジストリ書き込みを回収してから返す。allSettled なので、ここで
  // 何が失敗しても summary（購入の事実）は変わらない。
  await Promise.allSettled(pendingHooks);

  return summary;
}

async function purchaseOne(input: {
  candidate: Candidate;
  account: ReturnType<typeof privateKeyToAccount>;
  solanaKeypair: Keypair | null;
  getSolanaBlockhash: () => Promise<string>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs: number;
  db: NonNullable<ReturnType<typeof getDb>>;
  spentToday: bigint;
  /** バッチ末尾で待つレジストリ書き込み（registry-hook）。 */
  pendingHooks: Promise<void>[];
}): Promise<{
  kind: "attempted" | "skipped" | "budget_denied";
  settled: boolean;
  spent: bigint;
  /** 台帳に書いた status（attempted のときのみ）——summary の集計はこれを見る。 */
  status?: string;
}> {
  const { candidate, account, solanaKeypair, getSolanaBlockhash, fetchImpl, timeoutMs, db, spentToday, pendingHooks } = input;
  const method = (candidate.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  const isSolana = candidate.network === SOLANA_MAINNET_CAIP2;
  // 台帳上の payer 表記: EVM は小文字（既存の join 規約）・base58 は原文
  // （小文字化は base58 を破壊する——catalog-source と同じ理由）。
  const payerLabel = isSolana
    ? (solanaKeypair?.publicKey.toBase58() ?? "solana_key_missing")
    : account.address.toLowerCase();

  const record = async (row: Partial<typeof x402L1Purchases.$inferInsert>) => {
    await db.insert(x402L1Purchases).values({
      endpointId: candidate.id,
      status: "request_error",
      payer: payerLabel,
      ...row,
    });
  };

  // runL1Batch が solanaReady で候補を絞るので、ここに solana 候補が来て
  // 鍵が無いのは onlyEndpointId 経路等の異常系だけ——黙って進まない。
  if (isSolana && !solanaKeypair) {
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

  const challenge = parseChallenge({ bodyText: firstBody, headers: first.headers });
  if (!challenge) {
    await record({ status: "no_eligible_accept", rawResponseMeta: { phase: "unpaid", note: "unparseable challenge" } });
    return { kind: "skipped", settled: false, spent: 0n };
  }

  const selection = isSolana
    ? selectSolanaAccept(challenge.accepts, {
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
      })
    : selectAccept(challenge.accepts, {
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
      });
  if (!selection.accept) {
    await record({
      status: selection.reason,
      rawResponseMeta: {
        phase: "select",
        declaredAmount: candidate.priceAmount,
        declaredPayTo: candidate.payTo,
        challengeAccepts: challenge.accepts.slice(0, 4),
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
  }
  const accept = selection.accept;
  const amount = BigInt(accept.amount);

  // Budget gate — BEFORE signing. The ledger, not memory, is the truth.
  const budget = checkL1Budget({
    spentTodayUsd: unitsToUsd(spentToday),
    requestUsd: unitsToUsd(amount),
  });
  if (!budget.allowed) {
    await record({
      status: "budget_denied",
      amountUnits: accept.amount,
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
      network: accept.network,
      asset: accept.asset,
      payTo: accept.payTo.startsWith("0x") ? accept.payTo.toLowerCase() : accept.payTo,
      amountUnits: accept.amount,
      rawResponseMeta: {
        phase: "select",
        reason: "wall named the operator's own payTo",
        declaredPayTo: candidate.payTo,
      },
    });
    return { kind: "skipped", settled: false, spent: 0n };
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
    network: accept.network,
    asset: accept.asset,
    payTo: accept.payTo.startsWith("0x") ? accept.payTo.toLowerCase() : accept.payTo,
    amountUnits: String(amount),
    windowDays: candidate.isPriority ? PRIORITY_SWEEP_WINDOW_DAYS : SWEEP_WINDOW_DAYS,
  });
  if (!reservation.ok) {
    if (reservation.reason === "already_purchased") {
      // A concurrent run got this endpoint first — its row is the record.
      return { kind: "skipped", settled: false, spent: 0n };
    }
    await record({
      status: "budget_denied",
      amountUnits: accept.amount,
      rawResponseMeta: { reason: "daily_budget_exceeded", dailyBudgetUsd: DAILY_BUDGET_USD },
    });
    return { kind: "budget_denied", settled: false, spent: 0n };
  }

  // Sign — from here on the money is live, so the ledger row ALWAYS carries
  // spent_units, whatever the seller does next.
  let header: { headerName: string; headerValue: string };
  if (isSolana) {
    const built = await buildSolanaPaymentTransaction({
      accept,
      payer: solanaKeypair!,
      recentBlockhash: solanaBlockhash!,
    });
    header = encodeSolanaPaymentHeader({
      accept,
      transactionB64: built.transactionB64,
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
    const { signature } = await signX402Payment({ account, accept, authorization });
    header = encodePaymentHeader({
      x402Version: challenge.x402Version,
      accept,
      payload: { signature, authorization },
      resourceUrl: candidate.resourceUrl,
    });
  }

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
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    paidBody = await readBodyCapped(paid, 16_000);
  } catch (error) {
    paidError = String(error).slice(0, 300);
  } finally {
    clearTimeout(paidTimer);
  }

  const latencyMs = Date.now() - startedAt;
  const settlement = paid ? parseSettlementResponse(paid.headers) : null;
  const payloadNonEmpty = paidBody.trim().length > 0;
  const contentType = paid?.headers.get("content-type") ?? null;
  const contentTypeMatch = contentType === null ? null : contentType.includes("json");

  // L2 — minimal structural check against the catalog-declared schema.
  let l2Schema: string = "not_checked";
  if (paid && paid.status === 200) {
    l2Schema = checkL2(candidate.declaredSchema, paidBody, contentType);
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
    isWellFormedSettlementTx(settlement!.transaction, isSolana ? "solana" : "evm");
  const settled = claimedSettlement && settlementTxWellFormed;
  const status = !paid
    ? "settle_failed"
    : settled
      ? "settled"
      : claimedSettlement
        ? "settle_claimed_unverifiable" // 決済したと主張したが識別子が形式不正
        : paid.status === 200
          ? "delivered_no_receipt" // goods returned but no settlement receipt header
          : "settle_failed";

  // Resolve the reservation in place — spent_units stays exactly what was
  // reserved (signed = counted, success or not); only the outcome is filled in.
  await db
    .update(x402L1Purchases)
    .set({
      status,
      txHash: settlement?.transaction ?? null,
      httpStatusPaid: paid?.status ?? null,
      latencyMs,
      payloadNonEmpty: paid ? payloadNonEmpty : null,
      contentTypeMatch,
      l2Schema,
      rawSettlement: settlement ?? (paidError ? { error: paidError } : null),
      rawResponseMeta: {
        phase: "paid",
        status: paid?.status ?? null,
        contentType,
        bodyHead: paidBody.slice(0, 500),
        // A response whose HEADERS arrived but whose body aborted/failed: the
        // error would otherwise be dropped (rawSettlement keeps the settlement
        // when one exists), so it is kept here rather than silently lost.
        ...(paid && paidError ? { bodyError: paidError } : {}),
      },
    })
    .where(eq(x402L1Purchases.id, reservation.rowId));

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
  if (settled && settlement?.transaction) {
    const deliveryVerified = isDeliveryVerified({
      httpStatusPaid: paid?.status ?? null,
      payloadNonEmpty,
      l2Schema,
    });
    try {
      await recordObservedPurchase({
        wallet: payerLabel,
        counterparty: accept.payTo,
        amount: String(amount),
        txHash: settlement.transaction,
        resource: candidate.resourceUrl,
        blockTimestamp: null,
        deliveryVerified,
        observedBy: `observatory-l1:${candidate.id}`,
      });
    } catch (error) {
      logServerError("observatory.l1.observed_purchase", error);
    }
  }

  // ERC-8004 への公開（C4）。フラグOFF既定・graceful——購入の記帳には
  // 何があっても影響しない（registry-hook.ts 冒頭）。バッチ末尾で待てるよう
  // Promise を集める: fire-and-forget のままだと Vercel が応答後に関数を
  // 凍結するので、最後の候補の書き込みだけが静かに消える。
  pendingHooks.push(fireL1RegistryHook({ endpointId: candidate.id, payTo: accept.payTo, settled }));

  return { kind: "attempted", settled, spent: amount, status };
}

/**
 * L2 contract conformance, minimal and honest: with no declaration the
 * verdict is `no_declaration` (never a failure); with a declaration we check
 * what is machine-checkable without a full JSON-Schema engine — the body
 * parses as JSON and carries the declared top-level required/properties keys.
 */
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

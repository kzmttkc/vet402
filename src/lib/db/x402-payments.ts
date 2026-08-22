import { and, count, countDistinct, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { isMissingSchemaError } from "./pg-errors";
import { BASE_USDC_ADDRESS } from "@/lib/chain/config";
import { funderWallets, x402Payments } from "./schema";
import { logServerError } from "@/lib/util/log";

/**
 * vet402 2026-08-13 (score-manipulation ruling, hole 2). A payer's own
 * settlement history only counts as evidence of REAL economic activity when the
 * money went somewhere independent, in a non-trivial amount. Two forgeries this
 * closes, both demonstrated: (1) USDC DUST self-loops — 0.000001 USDC has a
 * real Transfer log and an owner signature but is not a settlement; (2)
 * SELF-DEALING — paying yourself (A→A) or another wallet you fund from the same
 * source (A→B, both in one funding cluster) manufactures "20 settlements" out
 * of one actor's own money.
 *
 * X402_MIN_SETTLEMENT_UNITS is in USDC base units (6 decimals). The default,
 * 1_000 = 0.001 USDC (a tenth of a cent), is deliberately LOW so genuine x402
 * micropayments still count — it only strips true dust, three orders of
 * magnitude under the demonstrated 0.000001 loop. Env-tunable so the floor can
 * be raised from production data without a deploy.
 */
const X402_MIN_SETTLEMENT_UNITS = (() => {
  const raw = process.env.X402_MIN_SETTLEMENT_UNITS;
  if (raw === undefined || raw === "") return 1_000n;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : 1_000n;
  } catch {
    return 1_000n;
  }
})();

/**
 * vet402 2026-08-13 — score-eligibility. A payment row moves a trust score
 * only when it is a genuine, chain-confirmed USDC settlement whose owner signed
 * for it. Three columns, each closing a separate forgery:
 *   token = BASE_USDC     the settlement leg actually moved USDC, not a token
 *                         the payer minted themselves (the wallet-match alone
 *                         was satisfied by any ERC20 Transfer).
 *   amount_verified       the declared figure matched the on-chain USDC amount.
 *   ownership_verified    the write-back carried a valid EIP-191 signature by
 *                         the paying wallet — so a stranger's real transfer,
 *                         posted by someone who does not control that wallet,
 *                         records a row but never counts.
 * Legacy rows (NULL on the new columns) are excluded, which is correct: that
 * history was forgeable and must not keep counting.
 */
/**
 * 「受け取った証拠」として数えてよい行の述語（2026-08-23 監査）。
 *
 * 支払側 getX402PaymentStats は以前からこの3つを掛けていたのに、受取側
 * getPayeeStats には1つも無かった。同じ台帳を2つの経路が読むなら、述語は
 * 1箇所から共有する——片側だけ直すのを繰り返してきた（payTo突合もSolana先行・
 * EVM後追いだった）ので、定数にして非対称が再発しない形にする。
 */
function RECEIVING_EVIDENCE_PREDICATES(counterpartyLower: string) {
  return [
    sql`${x402Payments.onchainAmount} IS NOT NULL`,
    sql`(${x402Payments.onchainAmount})::numeric >= ${X402_MIN_SETTLEMENT_UNITS.toString()}`,
    // 自己送金は証拠ではない。所有権検証は「払った側の署名」なので、
    // 自分に払えば必ず通ってしまう。
    sql`lower(${x402Payments.wallet}) <> ${counterpartyLower}`,
  ];
}

const scoreEligible = and(
  eq(x402Payments.token, BASE_USDC_ADDRESS.toLowerCase()),
  eq(x402Payments.amountVerified, true),
  eq(x402Payments.ownershipVerified, true),
);

/**
 * The on-chain block time is the authoritative day axis; created_at (DB insert
 * time) is a caller-manipulable fallback used only for rows that predate the
 * block_timestamp column. Dripping inserts of one day's txs across a fortnight
 * no longer inflates uniqueDays, because block time is not something the caller
 * picks.
 */
const settledAt = sql`coalesce(${x402Payments.blockTimestamp}, ${x402Payments.createdAt})`;

export type X402PaymentStats = {
  paymentCount: number;
  uniqueDays: number;
  lastPaymentAt: string | null;
  /**
   * 2026-08-23 監査: 独立性を証明できずに証拠から落とした支払い件数
   * （資金源が索引に無い／payer と同じクラスタ）。0 より大きいときは
   * 「独立した支払い実績」と言い切れない——測れなかったことを
   * 問題なしとして数えないための開示。
   */
  paymentsWithUnprovableIndependence: number;
};

export type RecordX402PaymentInput = {
  wallet: string;
  txHash: string;
  amount?: string | null;
  apiKeyId?: string | null;
  network?: string;
  resource?: string | null;
  /** Receiving wallet, when resolvable — see extractPayeeFromReceipt. */
  payee?: string | null;
  /** What the CHAIN said the settlement leg moved, in the token's base units.
   *  Authoritative: `amount` above is the caller's claim, this is the fact. */
  onchainAmount?: string | null;
  /** ERC20 contract that actually moved (only Base USDC counts as x402). */
  token?: string | null;
  /** null = the caller declared no amount; false = declared but unconfirmed. */
  amountVerified?: boolean | null;
  /** On-chain block time of the settlement tx (authoritative day axis). */
  blockTimestamp?: Date | null;
  /** vet402 2026-08-13: true only when a valid EIP-191 signature by `wallet`
   *  accompanied the write-back. Rows without it are stored but never counted. */
  ownershipVerified?: boolean | null;
};

/**
 * Idempotent insert keyed by tx_hash. Returns whether a new row was created.
 *
 * Defensive against the `payee` column not existing yet (see
 * scripts/sql/2026-07-15-x402-payee.sql / scripts/backfill-payee.ts): a
 * migration lag between deploying this code and applying that migration
 * must not take the live payment-ingest path down. On an "undefined column"
 * error we retry once without `payee` rather than failing the whole request.
 */
export async function recordX402Payment(
  input: RecordX402PaymentInput,
): Promise<{ created: boolean; id: string }> {
  const db = getDb();
  if (!db) throw new Error("database_unavailable");

  const wallet = input.wallet.toLowerCase();
  const txHash = input.txHash.toLowerCase();
  const network = (input.network ?? "base").toLowerCase();
  const payee = input.payee ? input.payee.toLowerCase() : null;

  const existing = await db
    .select({ id: x402Payments.id })
    .from(x402Payments)
    .where(eq(x402Payments.txHash, txHash))
    .limit(1);

  if (existing[0]) {
    return { created: false, id: existing[0].id };
  }

  const baseValues = {
    wallet,
    txHash,
    amount: input.amount ?? null,
    apiKeyId: input.apiKeyId ?? null,
    network,
    resource: input.resource ?? null,
  };

  // Widest set first, then degrade one migration at a time. Same reasoning as
  // the payee fallback above: a migration lag must not take payment ingest
  // down, and every degradation is logged so the lag is visible rather than
  // permanent. (2026-08-05: onchain_amount / token / amount_verified —
  // scripts/sql/2026-08-05-x402-amount-verification.sql. 2026-08-13:
  // block_timestamp / ownership_verified —
  // scripts/sql/2026-08-13-x402-block-time-and-ownership.sql.)
  const verificationValues = {
    onchainAmount: input.onchainAmount ?? null,
    token: input.token ? input.token.toLowerCase() : null,
    amountVerified: input.amountVerified ?? null,
    blockTimestamp: input.blockTimestamp ?? null,
    ownershipVerified: input.ownershipVerified ?? null,
  };

  try {
    const inserted = await db
      .insert(x402Payments)
      .values({ ...baseValues, payee, ...verificationValues })
      .returning();
    return { created: true, id: inserted[0]!.id };
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;

    logServerError(
      "x402_payment_verification_columns_missing",
      new Error(
        "onchain_amount/token/amount_verified not migrated yet; inserted without them",
      ),
    );
    try {
      const inserted = await db
        .insert(x402Payments)
        .values({ ...baseValues, payee })
        .returning();
      return { created: true, id: inserted[0]!.id };
    } catch (retryError) {
      if (!isMissingSchemaError(retryError)) throw retryError;

      logServerError(
        "x402_payment_payee_column_missing",
        new Error("payee column not migrated yet; inserted without it"),
      );
      const inserted = await db.insert(x402Payments).values(baseValues).returning();
      return { created: true, id: inserted[0]!.id };
    }
  }
}

/**
 * Intentionally global (not scoped by apiKeyId/customer): x402 settlement
 * history is a cross-provider trust signal by design (docs/x402-integration.md,
 * docs/ecosystem-x402-foundation.md) — a wallet that has paid other x402
 * providers should read as more trustworthy everywhere, the same way
 * ERC-8004 reputation and wallet-age signals are global on-chain facts
 * rather than per-customer counters. Scoping this per API key would defeat
 * that cross-provider network effect.
 *
 * The integrity guarantee instead lives at write time AND in the filter here.
 * `POST /v1/payments/x402` (src/app/api/v1/payments/x402/route.ts) confirms the
 * tx is real, succeeded, and is attributable to the claimed wallet, and records
 * whether the poster proved ownership of that wallet. This aggregate then
 * counts ONLY score-eligible rows (`scoreEligible`): a genuine USDC settlement,
 * amount-confirmed, owner-signed. A real transfer posted by someone who does
 * not control the wallet, or in a token the payer minted, contributes nothing.
 */
export async function getX402PaymentStats(wallet: string): Promise<X402PaymentStats> {
  const db = getDb();
  const empty: X402PaymentStats = {
    paymentCount: 0,
    uniqueDays: 0,
    lastPaymentAt: null,
    paymentsWithUnprovableIndependence: 0,
  };
  if (!db) return empty;

  const walletLower = wallet.toLowerCase();
  try {
    // Score-eligible, non-dust, non-self settlements this wallet made as PAYER.
    // The self-send and dust filters live in SQL; the funder-cluster
    // independence check (which needs the payer's and each payee's funder) is a
    // JS post-filter below, mirroring countDistinctFunders' two-step shape.
    const rows = await db
      .select({
        payee: x402Payments.payee,
        day: sql<string | null>`date_trunc('day', ${settledAt})`,
        settledAt: sql<string | null>`${settledAt}`,
      })
      .from(x402Payments)
      .where(
        and(
          eq(x402Payments.wallet, walletLower),
          scoreEligible,
          sql`${x402Payments.onchainAmount} IS NOT NULL`,
          sql`(${x402Payments.onchainAmount})::numeric >= ${X402_MIN_SETTLEMENT_UNITS.toString()}`,
          // Not a literal self-send. A NULL payee (unresolved recipient) is not
          // provably independent, so it does not count as evidence either.
          sql`${x402Payments.payee} IS NOT NULL`,
          sql`lower(${x402Payments.payee}) <> ${walletLower}`,
        ),
      );

    const independent = await keepIndependentlyFundedRecipients(db, walletLower, rows);
    const independentRows = independent.kept;

    const uniqueDays = new Set(
      independentRows.map((r) => r.day).filter((d): d is string => d !== null),
    ).size;
    let lastPaymentAt: string | null = null;
    for (const r of independentRows) {
      if (r.settledAt && (lastPaymentAt === null || r.settledAt > lastPaymentAt)) {
        lastPaymentAt = r.settledAt;
      }
    }

    return {
      paymentCount: independentRows.length,
      uniqueDays,
      lastPaymentAt,
      // 2026-08-23: 独立を証明できずに落とした件数。0 でないなら
      // 「独立した支払い実績がこれだけある」と言い切れない。
      paymentsWithUnprovableIndependence: independent.unprovenIndependence,
    };
  } catch (error) {
    // Deploy-ordering safety (vet402 2026-08-13). The score-eligibility filter
    // and block-time axis reference block_timestamp / ownership_verified. If
    // the code ships before scripts/sql/2026-08-13-x402-block-time-and-ownership
    // .sql is applied, those columns do not exist yet. Without this guard the
    // query throws, the engine flags x402_unavailable, and assessSybilRisk turns
    // that into a BLOCK for EVERY wallet — a fail-closed outage caused purely by
    // migration lag. Degrade to "no eligible history" (a neutral x402 signal)
    // instead, mirroring getPayeeStats and recordX402Payment's own tolerance.
    if (!isMissingSchemaError(error)) throw error;
    logServerError(
      "x402_stats_column_missing",
      new Error("block_timestamp/ownership_verified not migrated yet; reading as no eligible history"),
    );
    return empty;
  }
}

/**
 * vet402 2026-08-13 (hole 2) — keep only payments whose RECIPIENT is funded
 * independently of the payer, so an actor cannot manufacture a settlement
 * history by paying wallets it funds itself. A payee is dropped when it shares a
 * funding source with the payer (the same funder_wallets collapse the payee
 * engine uses on the receiving side). Unknown funders degrade PERMISSIVELY — a
 * payee with no funder row counts as its own independent source — matching
 * countDistinctFunders: the index is a sybil discount, never a correctness gate
 * we fail a whole read on. The residual (a freshly funded cluster not yet
 * indexed) is the same window the payer-side funding_cluster check has.
 */
/**
 * Pure decision half of hole 2, unit-tested without a DB
 * (tests/vet402-x402-self-dealing.test.ts). Keeps a payment only when its payee
 * is PROVABLY funded independently of the payer.
 *
 * 2026-08-23 監査で2つ直した。
 *
 * 1. **payer 自身が資金源のときに素通りしていた。** 判定は
 *    「payee の資金源 ∈ payer の資金源集合」だけを見ていたが、payer が payee へ
 *    直接送金した場合 payee の資金源は payer になる。payer は「payer の資金源」に
 *    含まれないので、自分で作った受取先が **独立と判定された**。
 *    → `payerSelf` を受け取り、集合に含めて比較する。
 *
 * 2. **資金源が不明な payee を、独立の証拠として黙って数えていた**
 *    （"permissive degrade"）。索引に無いのは「独立の証拠が無い」であって
 *    「独立」ではない。funder_wallets は既に台帳に載ったウォレットしか
 *    索引しないので、新規に用意された受取先は必ずここを通り抜けた。
 *    → **観測そのものは消さない**（索引が空なら正直な実績まで全部消えてしまう。
 *    本番の funder_wallets は17行しかない）。行は残すが `unprovenIndependence`
 *    として件数を返し、呼び手が「独立を証明できていない」と開示できるようにする。
 *    攻撃（数円で ALLOW の天井を外す）を閉じるのは受取側の深さ判定の方で、
 *    そこでは不明を独立な資金源として**数えない**——天井が外れなければ
 *    ALLOW には届かない。観測を消すのは、攻撃を止めるために必要な量を超えている。
 *
 * A row whose payee is null was already excluded upstream, but is dropped here
 * too for safety (an unresolved recipient is not provable evidence).
 */
export function keepIndependentByFunder<T extends { payee: string | null }>(
  payerFunders: Set<string>,
  funderOfPayee: Map<string, string>,
  rows: T[],
  payerSelf?: string,
): { kept: T[]; droppedSameCluster: number; unprovenIndependence: number } {
  const cluster = new Set(payerFunders);
  if (payerSelf) cluster.add(payerSelf.toLowerCase());

  const kept: T[] = [];
  let droppedSameCluster = 0;
  let unprovenIndependence = 0;
  for (const r of rows) {
    const payee = r.payee?.toLowerCase();
    if (!payee) continue;
    const payeeFunder = funderOfPayee.get(payee);
    if (payeeFunder === undefined) {
      // 証明できていないが、観測は消さない。件数で開示する。
      unprovenIndependence++;
      kept.push(r);
      continue;
    }
    if (cluster.has(payeeFunder)) {
      // 同じクラスタ＝独立でないことが**判明した**。これは落とす。
      droppedSameCluster++;
      continue;
    }
    kept.push(r);
  }
  return { kept, droppedSameCluster, unprovenIndependence };
}

async function keepIndependentlyFundedRecipients<
  T extends { payee: string | null },
>(
  db: NonNullable<ReturnType<typeof getDb>>,
  payerLower: string,
  rows: T[],
): Promise<{ kept: T[]; droppedSameCluster: number; unprovenIndependence: number }> {
  if (rows.length === 0) {
    return { kept: rows, droppedSameCluster: 0, unprovenIndependence: 0 };
  }

  const payeeLowers = [
    ...new Set(
      rows
        .map((r) => r.payee?.toLowerCase())
        .filter((p): p is string => p !== undefined && p !== null),
    ),
  ];
  if (payeeLowers.length === 0) {
    return { kept: [], droppedSameCluster: 0, unprovenIndependence: 0 };
  }

  try {
    const payerFunderRows = await db
      .select({ funder: funderWallets.funder })
      .from(funderWallets)
      .where(sql`lower(${funderWallets.wallet}) = ${payerLower}`);
    const payerFunders = new Set(payerFunderRows.map((r) => r.funder.toLowerCase()));

    const payeeFunderRows = await db
      .select({ wallet: funderWallets.wallet, funder: funderWallets.funder })
      .from(funderWallets)
      .where(inArray(sql`lower(${funderWallets.wallet})`, payeeLowers));
    const funderOfPayee = new Map<string, string>();
    for (const r of payeeFunderRows) {
      funderOfPayee.set(r.wallet.toLowerCase(), r.funder.toLowerCase());
    }

    return keepIndependentByFunder(payerFunders, funderOfPayee, rows, payerLower);
  } catch (error) {
    // 2026-08-23 監査: ここも「索引が読めなければ全行を通す」形だった。
    // 読めなかったことは独立の証拠ではない。SQL側の自己送金・ダスト除外は
    // 既に効いているので読み取り自体は落とさないが、**独立を証明できた行は0**
    // として返し、件数で開示する。
    if (!isMissingSchemaError(error)) {
      logServerError("x402_independent_recipients", error);
    }
    // 索引が読めなかった。SQL側の自己送金・ダスト除外は既に効いているので観測は
    // 残すが、独立は1件も証明できていないと開示する。
    return { kept: rows, droppedSameCluster: 0, unprovenIndependence: rows.length };
  }
}

export type PayeeStats = {
  paymentCount: number;
  uniqueDays: number;
  distinctPayers: number;
  /**
   * vet402 2026-08-13 — the number of distinct FUNDING SOURCES behind the
   * distinct payers, not the raw payer count. Ten wallets all funded by one
   * address are one sybil cluster wearing ten faces, not ten independent
   * customers; counting them as ten let a payee buy a full receiving-diversity
   * bonus from a single funder.
   *
   * 2026-08-23 監査で意味論を変更。以前は `coalesce(funder, wallet)` で
   * **索引に無い payer を「自分自身が資金源」として数えていた**。funder_wallets は
   * 既に台帳へ載ったウォレットしか索引しないので、新規ウォレットは判定の瞬間に
   * 必ず未索引。つまり新規ウォレットを2つ用意するだけで「独立した2つの資金源」に
   * なり、ダスト送金3回で dataDepth が moderate に上がって ALLOW の天井が外れた。
   * 旧docstringは「正当化できない減点はしない」と書いていたが、それは
   * **測れなかったものを問題なしとして数える**ことだった——vet402が市場に売っている
   * 規律そのものを自社実装で破っていた。
   *
   * 今は **資金源が判明している payer だけ**を数える。判明しない分は減点でも
   * 加点でもなく `payersWithUnknownFunder` として開示し、呼び手が
   * 「測れなかった」として扱えるようにする。
   */
  distinctFunders: number;
  /**
   * 資金源が索引に無く、独立性を証明できなかった payer の数（2026-08-23）。
   * 0 より大きいときは「独立した支払者がこれだけ居た」と言い切れない。
   */
  payersWithUnknownFunder: number;
  firstPaymentAt: string | null;
  lastPaymentAt: string | null;
};

/**
 * Receiving-side settlement history for a payee (the "did agents actually
 * pay this provider and keep paying" signal for GET /v1/payees/{address}/score).
 * Degrades to zeroed stats — never throws — when the `payee` column isn't
 * migrated yet, mirroring recordX402Payment's fallback: a payee lookup
 * during migration lag should read as data-poor (cold start), not error out.
 */
export async function getPayeeStats(payee: string): Promise<PayeeStats> {
  const db = getDb();
  const empty: PayeeStats = {
    paymentCount: 0,
    uniqueDays: 0,
    distinctPayers: 0,
    distinctFunders: 0,
    payersWithUnknownFunder: 0,
    firstPaymentAt: null,
    lastPaymentAt: null,
  };
  if (!db) return empty;

  const payeeLower = payee.toLowerCase();
  try {
    const rows = await db
      .select({
        paymentCount: count(),
        uniqueDays: sql<number>`count(distinct date_trunc('day', ${settledAt}))`,
        distinctPayers: countDistinct(x402Payments.wallet),
        firstPaymentAt: sql<string | null>`min(${settledAt})`,
        lastPaymentAt: sql<string | null>`max(${settledAt})`,
      })
      .from(x402Payments)
      // 2026-08-23 監査: ここは `eq(payee) + scoreEligible` だけで、支払側
      // (getX402PaymentStats) が持つ3つの防御述語——金額非NULL・ダスト下限・
      // **自己送金の除外**——が丸ごと欠けていた。scoreEligible が見るのは
      // トークン・金額検証・所有権検証だけで、所有権検証は「払った側の署名」
      // なので、自分に払えば必ず成立する。書き込みAPIにも wallet≠payee の
      // ガードは無い。結果、売り手はダスト送金を数回足すだけで paymentCount と
      // distinctPayers を積め、dataDepth を moderate に上げて ALLOW の天井
      // (PAYEE_THIN_SCORE_CEILING) を外せた。**同じ台帳を読む2つの経路で、
      // 片方だけに防御述語がある**という非対称は、それ自体が欠陥。
      .where(and(eq(x402Payments.payee, payeeLower), scoreEligible, ...RECEIVING_EVIDENCE_PREDICATES(payeeLower)));

    const row = rows[0];
    const distinctPayers = Number(row?.distinctPayers ?? 0);
    const funders = await countDistinctFunders(db, payeeLower, distinctPayers);

    return {
      paymentCount: Number(row?.paymentCount ?? 0),
      uniqueDays: Number(row?.uniqueDays ?? 0),
      distinctPayers,
      distinctFunders: funders.knownFunders,
      payersWithUnknownFunder: funders.unknownPayers,
      firstPaymentAt: row?.firstPaymentAt ?? null,
      lastPaymentAt: row?.lastPaymentAt ?? null,
    };
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    logServerError(
      "payee_stats_column_missing",
      new Error("payee column not migrated yet; returning empty stats"),
    );
    return empty;
  }
}

/**
 * vet402 2026-08-13 — collapse a payee's distinct payers down to their distinct
 * funding sources. Sybil clusters share one funder, so counting funders instead
 * of wallets stops a payee from manufacturing "many independent customers" out
 * of one funded set. Reads the same funder_wallets index the payer-side
 * funding_cluster check uses (populated only by the trusted indexer, never by
 * API scoring).
 *
 * 2026-08-23 監査で意味論を変更。旧実装は
 *   count(distinct coalesce(funder_wallets.funder, payers.wallet))
 * で、**索引に行が無い payer を「自分自身が資金源」として数えていた**。
 * funder_wallets の母集団は既に trust_events / customer_lists に載った
 * ウォレットだけなので（funder-indexer.ts:34-41）、**新規ウォレットは判定の
 * 瞬間に必ず未索引**。したがって新規ウォレット2つが自動的に「独立した2つの
 * 資金源」になり、C-1（ダスト自己送金）と噛み合って ALLOW の天井を外せた。
 *
 * 今は「判明した資金源の数」と「判明しなかった payer の数」を分けて返す。
 * 不明を独立として数えない代わりに、減点もしない——呼び手が
 * `payersWithUnknownFunder` を見て「測れなかった」と開示できる。
 */
async function countDistinctFunders(
  db: NonNullable<ReturnType<typeof getDb>>,
  payeeLower: string,
  distinctPayers: number,
): Promise<{ knownFunders: number; unknownPayers: number }> {
  if (distinctPayers === 0) return { knownFunders: 0, unknownPayers: 0 };
  try {
    const payers = db
      .selectDistinct({ wallet: x402Payments.wallet })
      .from(x402Payments)
      .where(
        and(
          eq(x402Payments.payee, payeeLower),
          scoreEligible,
          ...RECEIVING_EVIDENCE_PREDICATES(payeeLower),
        ),
      )
      .as("payers");

    const rows = await db
      .select({
        knownFunders: sql<number>`count(distinct ${funderWallets.funder})`,
        unknownPayers: sql<number>`count(*) FILTER (WHERE ${funderWallets.funder} IS NULL)`,
      })
      .from(payers)
      .leftJoin(funderWallets, sql`lower(${funderWallets.wallet}) = ${payers.wallet}`);

    const known = Number(rows[0]?.knownFunders ?? 0);
    const unknown = Number(rows[0]?.unknownPayers ?? 0);
    // Never report MORE funding sources than payers — a defensive floor in case
    // a wallet somehow carries multiple funder rows in the index.
    return { knownFunders: Math.min(known, distinctPayers), unknownPayers: unknown };
  } catch (error) {
    // 2026-08-23 監査: ここも「索引が読めなければ raw payer count を返す」＝
    // **全員が独立した資金源だと主張する**形だった。読めなかったのは事実であって
    // 独立の証拠ではない。判明0・全員不明として返し、呼び手に開示させる
    // （payee 読み取り自体は落とさない——degrade はするが嘘はつかない）。
    if (!isMissingSchemaError(error)) {
      logServerError("payee_distinct_funders", error);
    }
    return { knownFunders: 0, unknownPayers: distinctPayers };
  }
}

export async function countX402PaymentsForApiKey(apiKeyId: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const rows = await db
    .select({ value: count() })
    .from(x402Payments)
    .where(eq(x402Payments.apiKeyId, apiKeyId));

  return Number(rows[0]?.value ?? 0);
}

export async function countTotalX402Payments(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const rows = await db.select({ value: count() }).from(x402Payments);
  return Number(rows[0]?.value ?? 0);
}

/** Payments attributed in the last N days (ops / coverage). */
export async function countRecentX402Payments(days = 30): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ value: count() })
    .from(x402Payments)
    .where(gte(x402Payments.createdAt, since));

  return Number(rows[0]?.value ?? 0);
}

export async function countDistinctPaymentWallets(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const rows = await db.select({ value: countDistinct(x402Payments.wallet) }).from(x402Payments);
  return Number(rows[0]?.value ?? 0);
}

export type X402PaymentRow = {
  id: string;
  wallet: string;
  amount: string | null;
  txHash: string;
  network: string;
  resource: string | null;
  createdAt: Date | null;
};

export async function listX402PaymentsForApiKey(
  apiKeyId: string,
  limit = 50,
): Promise<X402PaymentRow[]> {
  const db = getDb();
  if (!db) return [];

  const safeLimit = Math.min(100, Math.max(1, limit));
  return db
    .select({
      id: x402Payments.id,
      wallet: x402Payments.wallet,
      amount: x402Payments.amount,
      txHash: x402Payments.txHash,
      network: x402Payments.network,
      resource: x402Payments.resource,
      createdAt: x402Payments.createdAt,
    })
    .from(x402Payments)
    .where(eq(x402Payments.apiKeyId, apiKeyId))
    .orderBy(desc(x402Payments.createdAt))
    .limit(safeLimit);
}

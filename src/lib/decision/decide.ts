// ============================================================
// §9.1 /decision の本体。facts と recommendation は同じ文書に同居する。
// facts を省略してスコアだけ返すモードは存在しない（buildDecision の型が facts を必須にする）。
//
//   role=payer  Resource について売り手事実 → decidePayer
//   role=payee  その Resource で支払ってきた payer について買い手事実 → decidePayee
//
// score ブロックは移行期間の併記（deprecated: true）。役割 payer で payTo が EVM の
// ときだけ既存の payee エンジン（キャッシュ 5 分）から取り、失敗しても判定は落とさない。
// registry ブロックは §11 の書き込み状態（anchored | pending | off）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logAndSwallowSafe } from "@/lib/util/log-safe";
import { isRegistryWritesEnabled } from "@/lib/chain/registry";
import type { LruCache } from "@/lib/util/lru-cache";
import { DECISION_CACHE_TTL_MS, decisionCache } from "./cache";
import { lookupCallerHash } from "./lookup-caller";
import { rowsOf } from "@/lib/settlements/upsert";
import { l2EvidenceOf, loadSellerFacts, type SellerFactsLoaded } from "./seller-facts";
import { loadBuyerFacts } from "./buyer-facts";
import { decidePayer, decidePayee, l1BasisOf, l0SingleFailConfirmed, DECISION_RULES_VERSION, type L1Basis, type Recommendation, type PayerOptions } from "./rules";
import { isSpendingHalted } from "@/lib/observatory/kill-switch";
import { assertEvidenceContract, vet402Evidence } from "./evidence";
import type { BuyerFacts, Evidence, Freshness, NotAttemptedReason, SellerFacts, VerifiedTerms } from "./types";
import type { CallerPolicy } from "./caller-policy";

export const DECISION_DISCLAIMER =
  "Scores are opinions; L0–L2 are measurement records. This is not credit assessment, KYC, sanctions screening, or certification.";

export { DECISION_CACHE_TTL_MS, invalidateDecisionCache } from "./cache";

export type DecisionSubject = {
  type: "resource";
  id: string | null;
  endpoint_id: string;
  observatory_id: string;
  canonical_url: string;
  method: string;
};

export type RegistryStatus = { status: "anchored" | "pending" | "off"; tx_hash: string | null };

export type DecisionResult = {
  subject: DecisionSubject;
  role: "payer" | "payee";
  payer: string | null;
  recommendation: Recommendation;
  reason_codes: string[];
  facts: SellerFacts | BuyerFacts;
  /**
   * 2026-09-05: vet402 自身が L1 の支出を止めているか（runtime_flags.l1_spending_halt）。
   * **全体の状態であって subject の状態ではない**ので facts の外に置く。true の間は
   * L1 の事実が更新されないので、読み手はこの文書の L1 を「今日の観測」として
   * 扱ってはいけない。DB を読めなかったときも true（fail-closed・金の関門と同じ倒れ方）。
   */
  spending_halted: boolean;
  /**
   * `reason_codes` に `l1_not_attempted` が載っているときだけ立つ下位コード。
   * 判別できないときは null——確かめていない理由を埋めない。
   */
  not_attempted_reason: NotAttemptedReason | null;
  freshness: Freshness;
  /**
   * 2026-09-29.2: 判定が L1 について読んだ数と時刻（role=payer のとき。payee は null）。
   * 数えた試行・数えなかった試行（l1_inconclusive はこれが n_attempts に等しいとき）・支払い済み未配達・
   * 最後の試行／署名／配達の時刻と経過日数・鮮度の上限（fresh_days）。facts の形は変えずに外へ置く。
   */
  l1_basis: L1Basis | null;
  /**
   * 2026-09-29 監査 5 周目（高）: vet402 が最後に配達を確かめた購入で払った条件（role=payer・無ければ null。payee は null）。
   * 呼び手は受け取った 402 の payTo・asset・network・scheme がこれと違う、または額がこれを超えるなら払わない。
   * ALLOW は「この条件で届いた」事実で、別の受取先・別の額への支払いを保証しない。
   */
  verified_terms: VerifiedTerms | null;
  evidence: Evidence[];
  score: { trustScore: number | null; recommendation: Recommendation | null; deprecated: true } | null;
  degraded: boolean;
  policy: "allow_only";
  /**
   * 2026-09-07（ETHOnline / WINDOW_PLAN §16.3）: 呼び手が `amount_usd` / `max_per_tx_usd` /
   * `min_l1_deliveries` を名乗ったときだけ付く、**呼び手の policy をサーバが当てた結果**。
   * 語は SDK の PayRefuseReason と同じ（./caller-policy.ts）。クエリが無ければ**キーごと無い**
   * （応答は従来と完全一致）。`recommendation` とは別欄で、判定を書き換えない。
   */
  caller_policy?: CallerPolicy;
  rules_version: string;
  registry: RegistryStatus;
  scoredAt: string;
  cacheExpiresAt: string;
  disclaimer: string;
};

export type BuildInput =
  | {
      role: "payer";
      subject: DecisionSubject;
      facts: SellerFacts;
      options: PayerOptions;
      score: { trustScore: number; recommendation: Recommendation } | null;
      registry: RegistryStatus;
      /**
       * 省略可能にしてあるのは既存のフィクスチャを壊さないためだけで、**本番の
       * 呼び手は必ず渡す**（tests/l1-freshness.test.ts が decide() のソースで固定する）。
       * 省略＝false は「止まっていない」という主張になる。
       */
      spendingHalted?: boolean;
      /** 判別できたときだけ渡す。渡さなければ null のまま（理由を作らない）。 */
      notAttemptedReason?: NotAttemptedReason | null;
      /** 最後に配達を確かめた購入の条件（seller-facts verifiedTermsOf）。省略は null。 */
      verifiedTerms?: VerifiedTerms | null;
      now?: Date;
    }
  | {
      role: "payee";
      subject: DecisionSubject;
      payer: string;
      facts: BuyerFacts;
      operatorBlacklist: boolean;
      registry: RegistryStatus;
      spendingHalted?: boolean;
      now?: Date;
    };

/** 純関数。facts は必須引数——省略する経路が型として存在しない（§9.1・§15）。 */
export function buildDecision(input: BuildInput): DecisionResult {
  const now = input.now ?? new Date();
  const base = {
    subject: input.subject,
    policy: "allow_only" as const,
    rules_version: DECISION_RULES_VERSION,
    registry: input.registry,
    spending_halted: input.spendingHalted === true,
    scoredAt: now.toISOString(),
    cacheExpiresAt: new Date(now.getTime() + DECISION_CACHE_TTL_MS).toISOString(),
    disclaimer: DECISION_DISCLAIMER,
  };
  if (input.role === "payer") {
    // 鮮度の基準時刻は文書の scoredAt と同じ（呼び手が now を渡していなければ）。
    const options: PayerOptions = { ...input.options, now: input.options.now ?? now };
    const d = decidePayer(input.facts, options);
    const f = input.facts;
    // 行はすべて **我々自身の台帳の観測**なので source: "vet402" を刻む。
    // このサーバは The Graph を引かない（呼び手が自分の鍵で引き、payOrRefuse が
    // 同じ配列へ source: "subgraph" の行を足す）。我々の鍵で代理して引くと
    // 「あなたは vet402 を信じなくてよい」という主張が成立しなくなる。
    const evidence: Evidence[] = [
      vet402Evidence({ level: "L0", url: `https://vet402.com/observatory/e/${input.subject.observatory_id}` }),
    ];
    if (f.l1.last_purchase_id) {
      evidence.push(
        vet402Evidence({
          level: "L1",
          purchase_id: f.l1.last_purchase_id,
          url: `https://vet402.com/api/v1/observatory/endpoints/${input.subject.observatory_id}/purchases`,
        }),
      );
    }
    const l2Evidence = l2EvidenceOf(f, input.subject.observatory_id);
    if (l2Evidence) evidence.push(l2Evidence);
    // 配る直前に 1 回だけ検査する（源を名乗らない行・合算した行を外へ出さない）。
    assertEvidenceContract(evidence);
    return {
      ...base,
      role: "payer",
      payer: null,
      recommendation: d.recommendation,
      reason_codes: d.reason_codes,
      facts: f,
      // 下位コードは `l1_not_attempted` が実際に載っているときだけ。既に試行がある
      // 相手に「停止していたから」を付けると、我々の都合で過去の記録を塗り替えることになる。
      not_attempted_reason: d.reason_codes.includes("l1_not_attempted")
        ? input.notAttemptedReason ?? null
        : null,
      freshness: { l0: f.l0.observed_at, l1: f.l1.observed_at, l2: f.l2.observed_at },
      l1_basis: l1BasisOf(f, options),
      verified_terms: input.verifiedTerms ?? null,
      evidence,
      score: input.score ? { ...input.score, deprecated: true } : null,
      // 2026-09-29.2: 確かめられた 1 回の fail（掲載中・最新プローブ 120h 以内・直前 pass）は測れている——WARN であって
      // degraded ではない。確かめられていない 1 回の fail は degraded のまま（require_vet402_allow=false の呼び手も払わない）。
      degraded: f.l0.status === "unverified" && !l0SingleFailConfirmed(f, options),
    };
  }
  const d = decidePayee(input.facts, { now, operatorBlacklist: input.operatorBlacklist });
  return {
    ...base,
    role: "payee",
    payer: input.payer,
    recommendation: d.recommendation,
    reason_codes: d.reason_codes,
    facts: input.facts,
    // role=payee の facts は買い手の記録なので、L1 未実施の概念が無い。
    not_attempted_reason: null,
    freshness: { l0: null, l1: input.facts.last_seen, l2: null },
    l1_basis: null,
    verified_terms: null,
    evidence: [],
    score: null,
    degraded: input.facts.sybil.unavailable.length > 0,
  };
}

// 本体は ./cache（書き込み側が循環なしに invalidate できるよう分離）。
const cache = decisionCache as LruCache<string, { result: DecisionResult; expiresAt: number }>;

async function registryStatusFor(observatoryId: string): Promise<RegistryStatus> {
  if (!isRegistryWritesEnabled()) return { status: "off", tx_hash: null };
  const db = getDb();
  if (!db) return { status: "pending", tx_hash: null };
  const rows = rowsOf<{ tx_hash: string | null; status: string }>(
    await db.execute(sql`
      SELECT tx_hash, status FROM registry_writes WHERE endpoint_id = ${observatoryId}::uuid
      ORDER BY created_at DESC LIMIT 1
    `),
  );
  const r = rows[0];
  if (!r) return { status: "pending", tx_hash: null };
  return { status: r.tx_hash ? "anchored" : "pending", tx_hash: r.tx_hash };
}

function subjectOf(loaded: SellerFactsLoaded): DecisionSubject {
  return {
    type: "resource",
    id: loaded.endpoint.resourceId,
    endpoint_id: loaded.endpoint.endpointHash ?? loaded.endpoint.id,
    observatory_id: loaded.endpoint.id,
    canonical_url: loaded.endpoint.canonicalUrl,
    method: loaded.endpoint.method,
  };
}

/**
 * §7.4: 問い合わせ回数を endpoint × UTC 日で加算（単文・失敗しても判定は落とさないが、理由はログに出す）。
 *
 * 2026-09-29 監査 5 周目（高）: **同じ呼び手は endpoint × UTC 日で 1 回だけ**数える。以前は呼び出しごとに 1 を
 * 足していて、鍵なしの 10 回/分/IP の枠で同じ出品を 5 回叩けば「問い合わせ多」（C2・L1 の最優先枠）に入れた。
 * decision_lookup_callers へ (endpoint, day, 呼び手の HMAC) を ON CONFLICT DO NOTHING で入れ、入ったときだけ
 * decision_lookups.n を 1 増やす——同じ 1 文なので、同時の 2 回が両方数えられることは無い（主キーの衝突で片方が待つ）。
 * 呼び手の材料は lookup-caller.ts（鍵 id か IP の /64）。材料が無い呼び出しは数えない（昇格させない側に倒す）。
 */
export function recordDecisionLookup(observatoryId: string, callerMaterial: string | null | undefined): Promise<void> {
  const db = getDb();
  if (!db || !callerMaterial) return Promise.resolve();
  const day = new Date().toISOString().slice(0, 10);
  const callerHash = lookupCallerHash(callerMaterial, day);
  return db
    .execute(
      sql`WITH seen AS (
            INSERT INTO decision_lookup_callers (endpoint_id, day, caller_hash)
            VALUES (${observatoryId}::uuid, ${day}, ${callerHash})
            ON CONFLICT (endpoint_id, day, caller_hash) DO NOTHING
            RETURNING endpoint_id, day
          )
          INSERT INTO decision_lookups (endpoint_id, day, n)
          SELECT endpoint_id, day, 1 FROM seen
          ON CONFLICT (endpoint_id, day) DO UPDATE SET n = decision_lookups.n + 1`,
    )
    .then(() => undefined)
    .catch(logAndSwallowSafe("decision.record_lookup"));
}

/**
 * 「なぜ一度も買っていないか」を **判別できるときだけ** 答える（2026-09-05）。
 *
 * 材料は 2 つしかない: いま支出を止めているか（全体）と、その相手への最終試行が
 * どの status で終わったか（台帳の事実）。どちらでも説明が付かないときは null——
 * 「まだ順番が回っていない」は我々が確かめていないので書かない。
 */
function notAttemptedReasonOf(halted: boolean, lastAttemptStatus: string | null): NotAttemptedReason | null {
  if (halted || lastAttemptStatus === "halted") return "spending_halted";
  if (lastAttemptStatus === "no_eligible_accept") return "no_eligible_accept";
  return null;
}

export type DecideRequest = (
  | { role: "payer"; observatoryId: string; callerDialect?: "v1" | "v2"; allowWithoutL1?: boolean; operatorBlacklist: boolean }
  | { role: "payee"; observatoryId: string; payerId: string; operatorBlacklist: boolean }
) & {
  /** 問い合わせを数える単位（lookup-caller.ts lookupCallerMaterial）。無ければ数えない。判定とキャッシュには使わない。 */
  callerMaterial?: string | null;
};

export async function decide(req: DecideRequest): Promise<DecisionResult | null> {
  void recordDecisionLookup(req.observatoryId, req.callerMaterial);
  const baseKey =
    req.role === "payer"
      ? `${req.observatoryId}|payer|${req.callerDialect ?? "-"}|${req.allowWithoutL1 ? 1 : 0}|${req.operatorBlacklist ? 1 : 0}`
      : `${req.observatoryId}|payee|${req.payerId}|${req.operatorBlacklist ? 1 : 0}`;
  // 停止フラグは応答に焼き込んだうえで 5 分キャッシュされるので、**キーに入れる**。
  // 入れないと「止めた直後の 5 分間、止めていないと答える」文書が配られる。
  // 読むのは 1 行の SELECT（kill-switch.ts の設計どおり無視できる往復）。
  const halt = await isSpendingHalted();
  const key = `${baseKey}|${halt.halted ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  const loaded = await loadSellerFacts(req.observatoryId);
  if (!loaded) return null;
  const subject = subjectOf(loaded);
  const registry = await registryStatusFor(loaded.endpoint.id);

  let result: DecisionResult;
  if (req.role === "payer") {
    let score: { trustScore: number; recommendation: Recommendation } | null = null;
    const payTo = loaded.endpoint.payTo;
    if (payTo && /^0x[0-9a-fA-F]{40}$/.test(payTo)) {
      try {
        const { scorePayeeWallet } = await import("@/lib/scoring/payee-engine");
        const s = await scorePayeeWallet(payTo);
        score = { trustScore: s.score, recommendation: s.recommendation };
      } catch {
        score = null; // 移行用の併記が取れなくても判定は落とさない
      }
    }
    result = buildDecision({
      role: "payer",
      subject,
      spendingHalted: halt.halted,
      facts: loaded.facts,
      options: {
        callerDialect: req.callerDialect,
        allowWithoutL1: req.allowWithoutL1,
        operatorBlacklist: req.operatorBlacklist,
        // 2026-09-29: /sellers と同じ規則で、売り手の不履行として数えない試行（vet402 の側・保留・課金なし）。
        l1NotCounted: loaded.l1NotCounted,
        // 2026-09-29 再監査: l0 が unverified の BLOCK に、何が測れなかったかの下位コードを添える（判定は変えない）。
        l0UnverifiedCause: loaded.l0UnverifiedCause ?? null,
        // 2026-09-29.2（独立レビュー）: 1 回の fail を WARN に緩める条件の材料（掲載中・最新プローブの時刻・直前の判定）。
        l0SingleFailContext: loaded.l0SingleFailContext ?? null,
        // 2026-09-29.2: 支払い済み未配達・最新の試行・鮮度の材料。渡さないと facts から保守的に作る（本番は必ず渡す）。
        l1Timeline: loaded.l1Timeline,
      },
      score,
      registry,
      notAttemptedReason: notAttemptedReasonOf(halt.halted, loaded.lastAttempt.status),
      verifiedTerms: loaded.verifiedTerms ?? null,
    });
  } else {
    const facts = await loadBuyerFacts(req.payerId);
    result = buildDecision({ role: "payee", subject, payer: req.payerId, facts, operatorBlacklist: req.operatorBlacklist, registry, spendingHalted: halt.halted });
  }
  cache.set(key, { result, expiresAt: Date.now() + DECISION_CACHE_TTL_MS });
  return result;
}

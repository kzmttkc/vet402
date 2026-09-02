// ============================================================
// §9.1 /decision の 5 分キャッシュ。decide.ts から分離してあるのは、判定材料を
// **書く側**（observatory の L0/L1/異議/決済照合）がここを呼ぶため——decide.ts は
// seller-facts 経由で observatory を import しているので、逆向きに decide.ts を
// import すると循環になる。
//
// 2026-09-02 敵対的監査: invalidateDecisionCache は定義だけあって呼び手 0 だった。
//
// 範囲の注意: これはプロセス内 LRU。Vercel では**そのインスタンスのキャッシュしか
// 消えない**——他インスタンスは DECISION_CACHE_TTL_MS（5 分）の失効を待つ。
// cron（probe / l1 / verifier）は API と別インスタンスで走ることが多いので、
// 実効は「同一インスタンスの窓を閉じる」まで。横断させるには DB 側の
// エポック列が要る（未実装・payee-cache と同じ制約）。
// ============================================================
import { LruCache } from "@/lib/util/lru-cache";

export const DECISION_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 5_000;

export type DecisionCacheEntry<T = unknown> = { result: T; expiresAt: number };

export const decisionCache = new LruCache<string, DecisionCacheEntry>(CACHE_MAX_ENTRIES);

/** キーは "<observatoryId>|…"。id を省くと全消去。 */
export function invalidateDecisionCache(observatoryId?: string): void {
  if (!observatoryId) {
    decisionCache.clear();
    return;
  }
  // 全走査は LRU の規模（≤5,000）なら十分安い。
  for (const key of decisionCache.keys()) if (key.startsWith(`${observatoryId}|`)) decisionCache.delete(key);
}

// ============================================================
// UTC 日の始まり——予算・上限の「今日」を 1 箇所で定義する（2026-09-04 監査 P2）。
//
// なぜ関数にするか: `date_trunc('day', now() AT TIME ZONE 'utc')` は **naive
// timestamp**（UTC の深夜という壁時計の値）を返す。これを timestamptz の列と
// 比べると、右辺は接続の TimeZone で解釈される。つまり接続の TimeZone が
// 変わるだけで「今日」の始まりがずれ、日次 $25 の窓が最大 1 日ぶん重なるか空く。
//
// ローカルの test DB で実測（2026-09-04）:
//   TimeZone=UTC                 → 2026-09-04 00:00+00
//   TimeZone=Asia/Tokyo          → 2026-09-04 00:00+09（= 09-03 15:00 UTC）
//   TimeZone=America/Los_Angeles → 2026-09-04 00:00-07（= 09-04 07:00 UTC）
// 同じ SQL が 3 つの違う瞬間を指していた。
//
// 監査メモが挙げていた `(now() AT TIME ZONE 'utc')::date AT TIME ZONE 'utc'` も
// **同じ理由で直らない**: `date` は timestamp ではなく timestamptz へ暗黙変換
// されるので、Asia/Tokyo では 2026-09-03 06:00 UTC を指した（同じ手順で実測）。
//
// 正しい形は下の 1 つだけ——naive timestamp を timestamp のまま「これは UTC だ」と
// 宣言して timestamptz へ戻す。3 つの TimeZone で同じ epoch になることを
// tests/utc-day-boundary.pg.test.ts が実走で固定している。
// ============================================================
import { sql } from "drizzle-orm";

/** いまの UTC 日の 00:00（timestamptz）。 */
export function utcDayStart() {
  return sql`(date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')`;
}

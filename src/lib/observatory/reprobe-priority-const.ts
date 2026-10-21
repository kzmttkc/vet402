/** 1 回の L0 実行で、普通の列より前に置く件数の上限。 */
export const REPROBE_PRIORITY_LIMIT = 50;

/** 異議を優先するのは、受けてからこの日数以内だけ。 */
export const DISPUTE_PRIORITY_DAYS = 7;

/**
 * 最新プローブがこの分数より新しい出品は、優先の列に入れない（次の実行に回す）。
 * c1 と c2 が重なったとき、同じ出品を続けて測って短い失敗を 2 回書かないため。
 */
export const PRIORITY_MIN_PROBE_AGE_MINUTES = 60;

/** 優先分を測るあいだ取るリース（job_leases）。L0 の実行が重なっても優先分は 1 本だけ。 */
export const PRIORITY_LEASE_NAME = "l0-priority";
/** cron の maxDuration（300 秒）より少し長い。 */
export const PRIORITY_LEASE_TTL_SECONDS = 330;

/** 優先の組。小さい方が先。宣言ずれの公開 fail → 旧規則の公開 fail → 異議（残りの枠）。 */
export const PRIORITY_CLASS = { declarationDrift: 0, ruleChange: 1, dispute: 2 } as const;

/**
 * 優先は 1 登録ドメインこの件数まで（組をまたいで数える）。同じドメインは直列・1 秒間隔なので、
 * 全部 10 秒でタイムアウトしても優先の段は約 55 秒で終わる（cron の maxDuration は 300 秒）。
 */
export const PRIORITY_PER_DOMAIN = 5;

/**
 * 優先の候補を SQL から読む 1 頁の行数。登録ドメインの 5 件で落ちた分は次の頁で埋める
 * （1 つの登録ドメインが先頭を埋めても、他のドメインの公開 fail が 50 件に入る）。
 */
export const PRIORITY_PAGE_SIZE = 200;
/** 読む頁の上限（1 回の実行で最大 PRIORITY_PAGE_SIZE × これ行）。 */
export const PRIORITY_MAX_PAGES = 10;

/**
 * 優先の段の 1 件あたり、本文の読みまで含めた合計の上限。probeEndpoint 自身の 10 秒の中断に、
 * 中断が届くまでの 0.5 秒を足した値（中断が効く普通の場合は probeEndpoint の timeout 行が先に返る）。
 */
export const PRIORITY_REQUEST_TOTAL_MS = 10_500;

/**
 * 出品ごとのリース（job_leases の `l0:endpoint:<id>`）の期限。要求の上限（10 秒と本文）と行の書き込みより長く、
 * 落ちた実行のリースが長く残らない長さ。
 */
export const ENDPOINT_LEASE_TTL_SECONDS = 30;

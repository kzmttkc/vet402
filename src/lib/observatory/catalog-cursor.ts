// ============================================================
// vet402 Observatory L0 — CDP Bazaar の目録を「続きから回り続けるカーソル」で読む（2026-10-30 設計 v5）。
//
// 契約の正典: docs/catalog-staleness-contract.md（関数・表・列・時計・締切・壊すべき部分）。
// 合格の基準: tests/catalog-staleness.pg.test.ts（T01〜T14）と scripts/dev/mutation-check-catalog.sh。
//
// いまは殻だけ（型は契約どおり、中身は "not implemented"）。実装は契約書に従って後で入る。
// ============================================================
import { CATALOG_SOURCE } from "./catalog-source";

/** 1 回の呼び出しで取る lease の長さ（Vercel の 300 秒の上限より短い）。 */
export const CATALOG_CURSOR_LEASE_SECONDS = 290;
/** 1 回の呼び出しで新しいページを取りにいってよい時間（注入した clock で測る）。 */
export const CATALOG_CURSOR_DEADLINE_MS = 200_000;
/** 同時に取りにいくページ数。 */
export const CATALOG_CURSOR_CONCURRENCY = 3;
/** 1 周の中で読めなかったページがこの割合を超えた周回は「弱い周回」。 */
export const WEAK_PASS_FAILED_PAGE_RATIO = 0.05;
/** 閉じる条件 (a): その行の last_seen_pass の後に閉じた強い周回の数。 */
export const DELIST_MIN_STRONG_PASSES = 3;
/** 閉じる条件 (b): last_seen_at からの時間。 */
export const DELIST_MIN_UNSEEN_HOURS = 48;
/** 閉じる条件 (c): 1 回の閉じる回で閉じてよい件数の上限（active な cdp_bazaar の行に対する割合）。 */
export const DELIST_MAX_ACTIVE_FRACTION = 0.02;
/** 見張り: 強い周回がこの時間閉じていなければ「古い」。 */
export const PASS_STALE_ALERT_HOURS = 36;

/** ログの見出し（logServerErrorSafe の context）。テストはこの文字列で出力を拾う。 */
export const LOG_TAG_PASS_STALE = "observatory.catalog-cursor.pass_stale";
export const LOG_TAG_CLOSURE_CAP_EXCEEDED = "observatory.catalog-closure.cap_exceeded";

export type CatalogCursorCallOptions = {
  /** cdp_bazaar だけ。 */
  source?: typeof CATALOG_SOURCE;
  /** 既定は本物の fetch（ページごとに 25 秒で切る）。テストは模擬の目録を渡す。 */
  fetchImpl?: (url: string) => Promise<Response>;
  /** 現在時刻。締切・lease・last_seen_at・周回の時刻・閉じる判定・見張りは全部これで測る。既定 () => new Date()。 */
  clock?: () => Date;
  /** 待ち（礼儀の間隔・429 の一時停止・再試行の backoff）は全部これで待つ。既定は setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 既定 CATALOG_CURSOR_DEADLINE_MS。clock で測る。 */
  deadlineMs?: number;
  /** 既定 CATALOG_CURSOR_CONCURRENCY。 */
  concurrency?: number;
  /** 既定 100（API の上限）。 */
  pageLimit?: number;
  /** 1 つのワーカーのページ間の礼儀の間隔。既定 150。 */
  sleepMs?: number;
  /** 429 以外の失敗の再試行回数。既定 5。 */
  maxRetriesPerPage?: number;
  /** 429 の再試行の別枠。既定 12。 */
  maxThrottleRetries?: number;
  baseUrl?: string;
};

/** 閉じた周回 1 つ（x402_catalog_passes の 1 行と同じ中身）。 */
export type CatalogPassSummary = {
  passSeq: number;
  startedAt: Date;
  completedAt: Date;
  /** 周回を閉じたときの total（API の pagination.total）。 */
  totalAtClose: number;
  /** この周回で読んだページ（失敗を含めて、カーソルを進めたページ）の数。 */
  pagesRead: number;
  /** そのうち読めなかったページ（エラー・短いページ・再試行切れの 429）。 */
  pagesFailed: number;
  /** pagesFailed / pagesRead > WEAK_PASS_FAILED_PAGE_RATIO。 */
  weak: boolean;
};

export type CatalogClosureResult = {
  /** cdp の規則 (a)(b) を満たした active 行の数（上限の判定の前）。第1段では常に 0。 */
  candidates: number;
  /** 上限の分母: この回の判定時点で active な cdp_bazaar の行の数。 */
  activeCdpRows: number;
  /** candidates が activeCdpRows の 2% を超えたので 1 件も閉じなかった。 */
  capped: boolean;
  /** この回の UPDATE … RETURNING で実際に delisted にした行の id。 */
  closedIds: string[];
  /** この回で書いた delisted のイベントの行数（= closedIds.length）。 */
  eventsWritten: number;
};

export type CatalogPassFreshness = {
  /** 最後に閉じた強い周回の completed_at。無ければ null。 */
  lastStrongPassCompletedAt: Date | null;
  /** now − lastStrongPassCompletedAt ≥ PASS_STALE_ALERT_HOURS（周回が1つも無いときは契約書の規則）。 */
  stale: boolean;
};

export type CatalogCursorCallResult =
  | { skipped: "leased" }
  | {
      skipped: null;
      /** 呼び出しの終わりの時点の pass_seq（周回を閉じたら +1 された後の値）。 */
      passSeq: number;
      /** この呼び出しが読み始めた offset（呼び出しの開始時の next_offset）。 */
      startOffset: number;
      /** 呼び出しの終わりに保存されている next_offset。 */
      nextOffset: number;
      /** この呼び出しで読んだページ（失敗を含む、カーソルを進めたページ）。 */
      pagesRead: number;
      pagesFailed: number;
      /** この呼び出しで upsert した出品の数。 */
      itemsUpserted: number;
      /** この呼び出しで最後に見た total。 */
      total: number | null;
      /** この呼び出しで閉じた周回（1 回の呼び出しで閉じる周回は最大 1 つ）。 */
      closedPass: CatalogPassSummary | null;
      /** 呼び出しの最後に毎回 1 回走る閉じる回の結果。 */
      closure: CatalogClosureResult;
      /** 呼び出しの最後に毎回 1 回走る見張りの結果。 */
      watchdog: CatalogPassFreshness;
    };

/**
 * cron の 1 回の呼び出し。lease を取り、next_offset から締切まで読み、ページごとに upsert とカーソルの保存をし、
 * total を越えたら周回を閉じる。最後に closeCatalogListings と checkCatalogPassFreshness を 1 回ずつ呼ぶ。
 */
export async function runCatalogCursorCall(options: CatalogCursorCallOptions = {}): Promise<CatalogCursorCallResult> {
  void options;
  throw new Error("not implemented");
}

/**
 * 閉じる判定の唯一の入口。cdp_bazaar の規則（強い周回 3 回・48 時間・2% の上限）と circle_discovery の規則
 * （origin/main のまま）を行ごとに当て、`UPDATE … WHERE id = ANY($1) AND status = 'active' RETURNING id` で閉じ、
 * イベントは RETURNING で返った行にだけ、同じ 1 文（データ変更 CTE）で書く。
 */
export async function closeCatalogListings(input: {
  now: Date;
  /** 'YYYY-MM-DD'。既定は now の UTC 日付。 */
  detectedOn?: string;
}): Promise<CatalogClosureResult> {
  void input;
  throw new Error("not implemented");
}

/** 見張り。stale のとき LOG_TAG_PASS_STALE で logServerErrorSafe に出す。 */
export async function checkCatalogPassFreshness(input: { now: Date }): Promise<CatalogPassFreshness> {
  void input;
  throw new Error("not implemented");
}

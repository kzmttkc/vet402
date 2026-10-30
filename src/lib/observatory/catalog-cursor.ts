// ============================================================
// vet402 Observatory L0 — CDP Bazaar の目録を「続きから回り続けるカーソル」で読む（2026-10-30 設計 v5）。
//
// 契約の正典: docs/catalog-staleness-contract.md（関数・表・列・時計・締切・壊すべき部分）。
// 合格の基準: tests/catalog-staleness.pg.test.ts（T01〜T14）と scripts/dev/mutation-check-catalog.sh。
//
// 第1段（2026-10-30）: 設計 1（カーソル・lease・ページごとの upsert・周回の記録・弱い周回の印）と 4（見張り）。
// cdp_bazaar の行は閉じない（closeCatalogListings は cdp の行を 1 件も閉じない）。閉じる規則（設計 2）は第2段。
//
// 本番は neon-http（複数文のトランザクションが無い）。lease の取得・カーソルの保存・周回の記録は、どれも 1 文で
// 正しくなるように書く。カーソルへの書き込みは全部 lease_holder で自分の lease に限る（打ち切られて残った古い
// 呼び出しが後から書いても効かない）。
// ============================================================
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { CATALOG_SOURCE, CATALOG_URL, isImportableResourceUrl, parseCatalogItem, retryAfterMs, type ParsedCatalogItem } from "./catalog-source";
import { loadCursorCircleListing, upsertCatalogCursorPage } from "./catalog-sync";
import { PASS_STALE_ALERT_HOURS as FRESHNESS_HOURS, readCdpPassFreshness } from "./catalog-freshness";

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
export const PASS_STALE_ALERT_HOURS = FRESHNESS_HOURS;

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

type Db = NonNullable<ReturnType<typeof getDb>>;

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** drizzle の生の sql に Date をそのまま渡すと postgres-js で落ちるので、ISO 文字列で渡す。 */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 1 つの要求が関数の時間を食い尽くさないよう、既定の fetch はページごとに切る。 */
const PAGE_TIMEOUT_MS = 25_000;
const defaultFetch = (url: string) => fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
/** 429 の 1 回の一時停止の上限（Retry-After がもっと長くても）。 */
const MAX_THROTTLE_PAUSE_MS = 30_000;

type PageOutcome =
  | { kind: "ok"; items: unknown[]; total: number | null }
  | { kind: "failed"; error: string }
  | { kind: "deadline" };

/**
 * cron の 1 回の呼び出し。lease を取り、next_offset から締切まで読み、ページごとに upsert とカーソルの保存をし、
 * total を越えたら周回を閉じる。最後に closeCatalogListings と checkCatalogPassFreshness を 1 回ずつ呼ぶ。
 */
export async function runCatalogCursorCall(options: CatalogCursorCallOptions = {}): Promise<CatalogCursorCallResult> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const source = options.source ?? CATALOG_SOURCE;
  if (source !== CATALOG_SOURCE) throw new Error(`runCatalogCursorCall reads ${CATALOG_SOURCE} only`);
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const deadlineMs = options.deadlineMs ?? CATALOG_CURSOR_DEADLINE_MS;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? CATALOG_CURSOR_CONCURRENCY));
  const pageLimit = Math.max(1, Math.floor(options.pageLimit ?? 100));
  const sleepMs = options.sleepMs ?? 150;
  const maxRetries = options.maxRetriesPerPage ?? 5;
  const maxThrottle = options.maxThrottleRetries ?? 12;
  const baseUrl = options.baseUrl ?? CATALOG_URL;

  // ---- 1. lease（1 文の UPDATE で原子的に。差し込んだ clock で比べる） ----
  const holder = randomUUID();
  const startedAt = clock();
  await db.execute(sql`
    INSERT INTO x402_catalog_cursors (source, created_at, updated_at)
    VALUES (${source}, ${at(startedAt)}, ${at(startedAt)})
    ON CONFLICT (source) DO NOTHING`);
  const leased = rowsOf<{ next_offset: number; pass_seq: number; pass_started_at: unknown; pass_pages_read: number; pass_pages_failed: number }>(
    await db.execute(sql`
      UPDATE x402_catalog_cursors
      SET lease_until = ${at(new Date(startedAt.getTime() + CATALOG_CURSOR_LEASE_SECONDS * 1000))},
          lease_holder = ${holder}::uuid,
          updated_at = ${at(startedAt)}
      WHERE source = ${source} AND (lease_until IS NULL OR lease_until <= ${at(startedAt)})
      RETURNING next_offset, pass_seq, pass_started_at, pass_pages_read, pass_pages_failed`),
  );
  if (leased.length === 0) return { skipped: "leased" };

  const release = async () => {
    try {
      await db.execute(sql`
        UPDATE x402_catalog_cursors SET lease_until = NULL, lease_holder = NULL
        WHERE source = ${source} AND lease_holder = ${holder}::uuid`);
    } catch (error) {
      // 放せなくても 290 秒で切れる。黙って消さない。
      logServerErrorSafe("observatory.catalog-cursor.release", error);
    }
  };

  try {
    const passSeq = Number(leased[0].pass_seq);
    const startOffset = Number(leased[0].next_offset);
    const passStartedAt = asDate(leased[0].pass_started_at) ?? startedAt;
    let passPagesRead = Number(leased[0].pass_pages_read);
    let passPagesFailed = Number(leased[0].pass_pages_failed);
    const deadlineAt = startedAt.getTime() + deadlineMs;
    const pastDeadline = () => clock().getTime() >= deadlineAt;
    const circle = await loadCursorCircleListing();

    // ---- 2〜4. 読む・upsert・カーソルの保存 ----
    let cursor = startOffset;
    let nextClaim = startOffset;
    let total: number | null = null;
    /** 締切で諦めたページの offset（それより先へはカーソルを進めない）。 */
    let abandonedAt = Number.POSITIVE_INFINITY;
    let fatal: unknown = null;
    let callPagesRead = 0;
    let callPagesFailed = 0;
    let itemsUpserted = 0;
    /** 終わったページ（offset → 読めなかったか）。連続したところまでカーソルを進めたら消す。 */
    const finished = new Map<number, boolean>();
    let pauseUntil = 0;
    let saving: Promise<void> = Promise.resolve();

    const saveCursor = () => {
      const snapshot = { cursor, passPagesRead, passPagesFailed, now: clock() };
      saving = saving.then(async () => {
        await db.execute(sql`
          UPDATE x402_catalog_cursors
          SET next_offset = ${snapshot.cursor},
              pass_pages_read = ${snapshot.passPagesRead},
              pass_pages_failed = ${snapshot.passPagesFailed},
              pass_started_at = ${at(passStartedAt)},
              updated_at = ${at(snapshot.now)}
          WHERE source = ${source} AND lease_holder = ${holder}::uuid`);
      });
      return saving;
    };

    const fetchPage = async (offset: number): Promise<PageOutcome> => {
      const url = `${baseUrl}?limit=${pageLimit}&offset=${offset}`;
      let throttled = 0;
      for (let attempt = 0; ; attempt++) {
        // 429 の一時停止は全ワーカーで共有する。
        while (pauseUntil > clock().getTime()) {
          if (pastDeadline()) return { kind: "deadline" };
          await sleep(Math.min(pauseUntil - clock().getTime(), deadlineAt - clock().getTime()));
        }
        if (pastDeadline()) return { kind: "deadline" };
        let res: Response | null = null;
        try {
          res = await fetchImpl(url);
        } catch {
          res = null; // 通信の失敗・時間切れは 5xx と同じに再試行する
        }
        if (res?.ok) {
          try {
            const body = (await res.json()) as { items?: unknown; pagination?: { total?: unknown } } | null;
            const total = typeof body?.pagination?.total === "number" && Number.isFinite(body.pagination.total) ? body.pagination.total : null;
            return { kind: "ok", items: Array.isArray(body?.items) ? body.items : [], total };
          } catch {
            // 本文が読めない: 失敗として再試行する
          }
        }
        if (res?.status === 429 && throttled < maxThrottle) {
          throttled++;
          attempt--;
          const pause = Math.min(MAX_THROTTLE_PAUSE_MS, retryAfterMs(res, clock().getTime()) ?? 2_000 * 2 ** Math.min(throttled - 1, 4));
          pauseUntil = Math.max(pauseUntil, clock().getTime() + pause);
          continue;
        }
        if (pastDeadline()) return { kind: "deadline" };
        if (attempt >= maxRetries) {
          return { kind: "failed", error: res ? (res.ok ? "unreadable_body" : `http_${res.status}`) : "network_or_timeout" };
        }
        await sleep(Math.min(10_000, 500 * 2 ** attempt));
      }
    };

    const worker = async () => {
      for (;;) {
        if (fatal !== null || pastDeadline()) return;
        if (total !== null && nextClaim >= total) return;
        if (nextClaim >= abandonedAt) return;
        const offset = nextClaim;
        nextClaim += pageLimit;
        const outcome = await fetchPage(offset);
        if (fatal !== null) return;
        if (outcome.kind === "deadline") {
          abandonedAt = Math.min(abandonedAt, offset);
          return;
        }
        if (outcome.kind === "failed" && total === null) {
          // total をまだ知らないうちに読めないページは飛ばさない（目録の大きさが分からないまま先へ進めない）。
          abandonedAt = Math.min(abandonedAt, offset);
          return;
        }
        let failed = outcome.kind === "failed";
        if (outcome.kind === "ok") {
          if (outcome.total !== null) total = outcome.total; // 目録は途中で増減する。最後に見た値を使う
          if (total !== null && offset >= total) return; // total を越えた先読みのページ（数えない）
          const parsed: ParsedCatalogItem[] = [];
          for (const raw of outcome.items) {
            const item = parseCatalogItem(raw);
            if (item.resourceKey && isImportableResourceUrl(item.resourceUrl)) parsed.push(item);
          }
          const page = await upsertCatalogCursorPage(parsed, { now: clock(), passSeq, circle });
          itemsUpserted += page.upserted;
          // 短いページ（末尾でないのに pageLimit より少ない）は読めなかったページに数える。カーソルは pageLimit 進める。
          if (outcome.items.length < pageLimit && total !== null && offset + outcome.items.length < total) failed = true;
        }
        finished.set(offset, failed);
        let advanced = false;
        while (finished.has(cursor) && cursor < abandonedAt) {
          const f = finished.get(cursor)!;
          finished.delete(cursor);
          cursor += pageLimit;
          passPagesRead++;
          callPagesRead++;
          if (f) {
            passPagesFailed++;
            callPagesFailed++;
          }
          advanced = true;
        }
        if (advanced) await saveCursor();
        if (sleepMs > 0) await sleep(sleepMs);
      }
    };
    const guarded = async () => {
      try {
        await worker();
      } catch (error) {
        fatal ??= error;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, guarded));
    await saving;
    if (fatal !== null) throw fatal;

    // ---- 6. 周回を閉じる ----
    let closedPass: CatalogPassSummary | null = null;
    if (total !== null && cursor >= total && abandonedAt === Number.POSITIVE_INFINITY) {
      const completedAt = clock();
      const weak = passPagesRead === 0 || passPagesFailed / passPagesRead > WEAK_PASS_FAILED_PAGE_RATIO;
      await db.execute(sql`
        INSERT INTO x402_catalog_passes (source, pass_seq, started_at, completed_at, total_at_close, pages_read, pages_failed, weak)
        VALUES (${source}, ${passSeq}, ${at(passStartedAt)}, ${at(completedAt)}, ${total}, ${passPagesRead}, ${passPagesFailed}, ${weak})
        ON CONFLICT (source, pass_seq) DO NOTHING`);
      await db.execute(sql`
        UPDATE x402_catalog_cursors
        SET pass_seq = pass_seq + 1, next_offset = 0, pass_pages_read = 0, pass_pages_failed = 0, pass_started_at = NULL,
            last_pass_completed_at = ${at(completedAt)},
            last_strong_pass_completed_at = CASE WHEN ${weak} THEN last_strong_pass_completed_at ELSE ${at(completedAt)} END,
            updated_at = ${at(completedAt)}
        WHERE source = ${source} AND lease_holder = ${holder}::uuid`);
      await writePassSnapshot(db, { passSeq, total, completedAt, complete: !weak });
      closedPass = { passSeq, startedAt: passStartedAt, completedAt, totalAtClose: total, pagesRead: passPagesRead, pagesFailed: passPagesFailed, weak };
      cursor = 0;
    }

    await release();
    // ---- 7. 閉じる回と見張り（lease を取れた呼び出しで毎回 1 回） ----
    const closure = await closeCatalogListings({ now: clock() });
    const watchdog = await checkCatalogPassFreshness({ now: clock() });
    return {
      skipped: null,
      passSeq: closedPass ? passSeq + 1 : passSeq,
      startOffset,
      nextOffset: cursor,
      pagesRead: callPagesRead,
      pagesFailed: callPagesFailed,
      itemsUpserted,
      total,
      closedPass,
      closure,
      watchdog,
    };
  } finally {
    await release();
  }
}

/**
 * 周回を閉じたら、その周回で見えた鍵を snapshot に書く（公開の latestSnapshot の件数と、Circle の同期が読む
 * 「cdp がいま載せている鍵」のため）。鍵の集合は DB の中で作る（10 万件を HTTP で運ばない）。弱い周回は complete=false。
 * 同じ日にもう完全な snapshot があれば、弱い周回で上書きしない。失敗しても呼び出しは落とさない。
 */
async function writePassSnapshot(db: Db, input: { passSeq: number; total: number; completedAt: Date; complete: boolean }): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO x402_catalog_snapshots (snapshot_date, source, total_count, fetched_count, resource_keys, complete)
      SELECT ${input.completedAt.toISOString().slice(0, 10)}, ${CATALOG_SOURCE}, ${input.total}, count(*)::int,
             coalesce(jsonb_agg(resource_key), '[]'::jsonb), ${input.complete}
      FROM x402_endpoints
      WHERE last_seen_pass = ${input.passSeq} AND source IN (${CATALOG_SOURCE}, 'circle_discovery')
      ON CONFLICT (snapshot_date, source) DO UPDATE
        SET total_count = excluded.total_count,
            fetched_count = excluded.fetched_count,
            resource_keys = excluded.resource_keys,
            complete = excluded.complete
        WHERE excluded.complete OR x402_catalog_snapshots.complete IS NOT TRUE`);
  } catch (error) {
    logServerErrorSafe("observatory.catalog-cursor.snapshot", error);
  }
}

/**
 * 閉じる判定の唯一の入口。
 * 第1段（2026-10-30）: cdp_bazaar に載る行は 1 件も閉じない（設計 2 の規則は第2段）。circle_discovery だけの行の
 * 閉じ方は origin/main のまま syncCatalog の中にあり、cdp に載る行を閉じないよう同じ判定で絞ってある。
 * ここは件数（判定時点の active な cdp_bazaar の行）だけを数えて返す。
 */
export async function closeCatalogListings(input: {
  now: Date;
  /** 'YYYY-MM-DD'。既定は now の UTC 日付。 */
  detectedOn?: string;
}): Promise<CatalogClosureResult> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  void input;
  const rows = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM x402_endpoints WHERE status = 'active' AND source = ${CATALOG_SOURCE}`),
  );
  return { candidates: 0, activeCdpRows: Number(rows[0]?.n ?? 0), capped: false, closedIds: [], eventsWritten: 0 };
}

/** 見張り。stale のとき LOG_TAG_PASS_STALE で logServerErrorSafe に出す（既存のアラートの経路）。 */
export async function checkCatalogPassFreshness(input: { now: Date }): Promise<CatalogPassFreshness> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const freshness = await readCdpPassFreshness(db, input.now);
  if (freshness.stale) {
    logServerErrorSafe(
      LOG_TAG_PASS_STALE,
      new Error(
        `no strong CDP Bazaar catalog pass has completed in the last ${PASS_STALE_ALERT_HOURS}h ` +
          `(last strong pass: ${freshness.lastStrongPassCompletedAt?.toISOString() ?? "none"})`,
      ),
    );
  }
  return freshness;
}

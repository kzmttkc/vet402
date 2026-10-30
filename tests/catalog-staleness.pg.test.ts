// ============================================================
// 目録の同期 v5（続きから回るカーソル・何周も見えていない行だけ閉じる）の合格の基準（2026-10-30）。
//
// 設計の正典: vet402-orders/1030-catalog-sync-v5-staleness.md（「決めた設計 1〜6」と「完了条件の表」）。
// 関数・表・列・時計・締切の契約: docs/catalog-staleness-contract.md。
// 戻すと落ちることの確かめ: scripts/dev/mutation-check-catalog.sh（パッチは実装者が置く）。
//
// 1 行 1 本のトップレベルのテスト（T01〜T13 は表の行、T14 は第1段の一時の基準）。どれも:
//   - ローカル DB（TEST_DATABASE_URL）と模擬の目録 API（fetchImpl）で、本物の関数を通す
//     （runCatalogCursorCall・syncCatalog・closeCatalogListings・notifyDelistedEvents・
//      getCdpBazaarIngestFreshness・getObservatoryStats・l1TargetsSqlBuilders）。
//   - 時間は差し込んだ clock / sleep で進める。模擬の API は 1 ページ 1 秒（並列 3 なので 1 要求ごとに 1/3 秒）を
//     clock に足す。実時計で待つのは、並行の段取りの見張り（waitFor）だけ。
//   - 「閉じない」を見るテストは、閉じるべき別の出品が同じ入力で閉じることも確かめる。
//
// Run: TEST_DATABASE_URL=postgres://$USER@localhost:5432/vet402_test_x \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/catalog-staleness.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import type { CatalogClosureResult, CatalogCursorCallOptions, CatalogCursorCallResult } from "@/lib/observatory/catalog-cursor";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("catalog staleness (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  /** 実時計とかけ離れた固定の起点（DB の now() で書かれた値と混ざっても、こちらの時計の方が必ず後になる）。 */
  const BASE = Date.UTC(2031, 0, 1, 0, 0, 0);
  const CDP = "cdp_bazaar";
  const CIRCLE = "circle_discovery";

  const baseAccept = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x1111111111111111111111111111111111111111",
  };
  const gwAccept = {
    scheme: "exact",
    network: "eip155:5042",
    amount: "100000",
    asset: "0x3600000000000000000000000000000000000000",
    payTo: "0xBd7b9f3e0CD3E1f6e698D0eeBb99F96E093BdeE3",
    maxTimeoutSeconds: 604900,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000ee" },
  };

  // ---------- 時計 ----------
  /** 差し込む時計。sleep は待たずに時計を進める（429 の一時停止・backoff も時計の上で過ぎる）。 */
  class VirtualClock {
    ms: number;
    constructor(start: number) {
      this.ms = start;
    }
    now = (): Date => new Date(this.ms);
    advance(ms: number): void {
      this.ms += ms;
    }
    /** 指定の時刻へ進める（すでに過ぎていれば何もしない）。 */
    to(at: number): void {
      if (at > this.ms) this.ms = at;
    }
    sleep = async (ms: number): Promise<void> => {
      this.ms += Math.max(0, ms);
      await new Promise((r) => setImmediate(r));
    };
  }

  // ---------- 模擬の目録 API ----------
  type Entry = { resource: string; payTo?: string };
  const cdpItem = (e: Entry) => ({
    resource: e.resource,
    description: "cdp",
    accepts: [{ ...baseAccept, payTo: e.payTo ?? baseAccept.payTo }],
    extensions: { bazaar: { info: { input: { method: "GET" } } } },
  });
  type MockOpts = {
    /** 1 要求ごとに clock に足すミリ秒（既定 1000/3 = 1 ページ 1 秒を並列 3 で）。 */
    msPerRequest?: number;
    /** ページ番号 → そのページが返す件数（API の癖。短いページ）。 */
    short?: () => Map<number, number> | undefined;
    /** null 以外を返すと、その応答をそのまま返す（429・500・止まる）。 */
    override?: (offset: number) => Promise<Response> | Response | null;
    /** offset ごとに並びを変えたいとき（T04）。 */
    listFor?: (offset: number) => Entry[];
  };
  function mockCatalog(clock: VirtualClock, list: () => Entry[], opts: MockOpts = {}) {
    const requests: number[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const limit = Number(u.searchParams.get("limit") ?? "100");
      requests.push(offset);
      clock.advance(opts.msPerRequest ?? 1000 / 3);
      const o = opts.override?.(offset);
      if (o) return o;
      const keys = opts.listFor ? opts.listFor(offset) : list();
      const n = opts.short?.()?.get(Math.floor(offset / 100)) ?? limit;
      return Response.json({ items: keys.slice(offset, offset + n).map(cdpItem), pagination: { total: keys.length } });
    };
    return { fetchImpl, requests };
  }
  const entries = (prefix: string, n: number): Entry[] =>
    Array.from({ length: n }, (_, i) => ({ resource: `https://${prefix}-${i}.example/api` }));
  const throttled = () => new Response(null, { status: 429, headers: { "retry-after": "30" } });
  const serverError = () => new Response("boom", { status: 500 });

  // ---------- 実時計の見張り（並行の段取りだけに使う） ----------
  async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await cond()) return true;
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // ---------- ログの取り込み ----------
  function captureErrors() {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
      orig(...args);
    };
    return { lines, restore: () => void (console.error = orig) };
  }

  // ---------- 本物のモジュール ----------
  async function load() {
    const cursor = await import("@/lib/observatory/catalog-cursor");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem, normalizeResourceKey } = await import("@/lib/observatory/catalog-source");
    const { notifyDelistedEvents } = await import("@/lib/observatory/notify");
    const reader = await import("@/lib/observatory/reader");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    return { cursor, syncCatalog, parseCatalogItem, normalizeResourceKey, notifyDelistedEvents, reader, db, sql };
  }
  type Mods = Awaited<ReturnType<typeof load>>;

  type Ran = Extract<CatalogCursorCallResult, { skipped: null }>;
  function ran(r: CatalogCursorCallResult, label: string): Ran {
    assert.equal(r.skipped, null, `${label}: lease が取れずに何もしなかった`);
    return r as Ran;
  }

  const rowsOf = <T>(raw: unknown): T[] =>
    (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];

  function helpers(m: Mods) {
    const { db, sql } = m;
    const truncate = () =>
      db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_delisting_events, x402_payee_watchers, x402_catalog_cursors, x402_catalog_passes, x402_l0_probes, x402_l1_purchases, x402_resource_aliases`,
      );
    const keyOf = (url: string) => m.normalizeResourceKey(url);
    const statusOf = async (url: string): Promise<string> => {
      const r = rowsOf<{ status: string }>(
        await db.execute(sql`SELECT status FROM x402_endpoints WHERE resource_key = ${keyOf(url)} AND source IN (${CDP}, ${CIRCLE})`),
      );
      assert.ok(r.length <= 1, `${url}: cdp と circle の行が 2 本ある`);
      return r[0]?.status ?? "missing";
    };
    const statusesOf = async (urls: string[]): Promise<string[]> => Promise.all(urls.map(statusOf));
    const delistEventsFor = async (url: string): Promise<number> => {
      const r = rowsOf<{ n: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM x402_delisting_events ev JOIN x402_endpoints e ON e.id = ev.endpoint_id
          WHERE ev.event_type = 'delisted' AND e.resource_key = ${keyOf(url)}`),
      );
      return Number(r[0]?.n ?? 0);
    };
    const delistEventRows = async (url: string) =>
      rowsOf<{ detected_on: string }>(
        await db.execute(sql`
          SELECT ev.detected_on FROM x402_delisting_events ev JOIN x402_endpoints e ON e.id = ev.endpoint_id
          WHERE ev.event_type = 'delisted' AND e.resource_key = ${keyOf(url)} ORDER BY ev.created_at`),
      );
    const totalDelistEvents = async (): Promise<number> =>
      Number(rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM x402_delisting_events WHERE event_type = 'delisted'`))[0]?.n ?? 0);
    const idOf = async (url: string): Promise<string> => {
      const r = rowsOf<{ id: string }>(await db.execute(sql`SELECT id::text AS id FROM x402_endpoints WHERE resource_key = ${keyOf(url)}`));
      assert.equal(r.length, 1, `${url}: 行が無い`);
      return r[0].id;
    };
    const cursorNextOffset = async (): Promise<number | null> => {
      const r = rowsOf<{ next_offset: number }>(await db.execute(sql`SELECT next_offset FROM x402_catalog_cursors WHERE source = ${CDP}`));
      return r.length === 0 ? null : Number(r[0].next_offset);
    };
    const countSeenInPass = async (prefix: string, pass: number): Promise<number> =>
      Number(
        rowsOf<{ n: number }>(
          await db.execute(sql`
            SELECT count(*)::int AS n FROM x402_endpoints
            WHERE source = ${CDP} AND status = 'active' AND last_seen_pass = ${pass} AND resource_key LIKE ${prefix + "%"}`),
        )[0]?.n ?? 0,
      );
    const opts = (clock: VirtualClock, fetchImpl: (u: string) => Promise<Response>, extra: Partial<CatalogCursorCallOptions> = {}): CatalogCursorCallOptions => ({
      fetchImpl,
      clock: clock.now,
      sleep: clock.sleep,
      sleepMs: 0,
      deadlineMs: 200_000,
      concurrency: 3,
      pageLimit: 100,
      baseUrl: "https://catalog.test/resources",
      ...extra,
    });
    /** cron の 1 回: 時計を at へ進めて呼ぶ。 */
    const callAt = async (clock: VirtualClock, at: number, fetchImpl: (u: string) => Promise<Response>, label: string, extra: Partial<CatalogCursorCallOptions> = {}) => {
      clock.to(at);
      return ran(await m.cursor.runCatalogCursorCall(opts(clock, fetchImpl, extra)), label);
    };
    const dayIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const circleOf = (resource: string) =>
      m.parseCatalogItem({ resource, metadata: { method: "POST", description: "circle" }, accepts: [baseAccept, gwAccept] });
    /** Circle の 1 日（origin/main のまま、完全な取得を渡す）。 */
    const circleDay = async (clock: VirtualClock, at: number, resources: string[]) => {
      clock.to(at);
      const items = resources.map(circleOf);
      return m.syncCatalog({
        fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true },
        today: dayIso(at),
        source: CIRCLE,
        clock: clock.now,
      });
    };
    /**
     * 閉じる回を 2 本同時に走らせる。テストが対象の行の行ロックを持ち、2 本とも閉じる UPDATE で待たせてから放す
     * （契約: 候補の読み取りは行ロックを取らない・閉じる回どうしを別のロックで直列にしない）。
     */
    const twoClosingsUnderRowLock = async (rowId: string, now: Date): Promise<CatalogClosureResult[]> => {
      const postgres = (await import("postgres")).default;
      const lockClient = postgres(TEST_DB!, { max: 1 });
      let rounds: Promise<CatalogClosureResult>[] = [];
      let settled = 0;
      try {
        await lockClient.begin(async (tx) => {
          await tx`SELECT id FROM x402_endpoints WHERE id = ${rowId}::uuid FOR UPDATE`;
          rounds = [m.cursor.closeCatalogListings({ now }), m.cursor.closeCatalogListings({ now })];
          for (const p of rounds) p.then(() => settled++, () => settled++);
          await waitFor(async () => {
            if (settled === rounds.length) return true;
            const w = rowsOf<{ n: number }>(
              await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`),
            );
            return Number(w[0]?.n ?? 0) >= 2;
          });
        });
      } finally {
        await lockClient.end();
      }
      return Promise.all(rounds);
    };
    return {
      truncate,
      keyOf,
      statusOf,
      statusesOf,
      delistEventsFor,
      delistEventRows,
      totalDelistEvents,
      idOf,
      cursorNextOffset,
      countSeenInPass,
      opts,
      callAt,
      dayIso,
      circleDay,
      twoClosingsUnderRowLock,
    };
  }

  // ==========================================================
  test("T01 カーソルは続きから読み、100,800 件（1,008 ページ・1 ページ 1 秒）の目録を 200 秒の呼び出し 2〜3 回で 1 周し、全部の鍵が見える", { timeout: 900_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const N = 100_800;
    const list = entries("t01", N);
    const clock = new VirtualClock(BASE);
    const api = mockCatalog(clock, () => list);
    const results: Ran[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await h.callAt(clock, BASE + i * 2 * HOUR, api.fetchImpl, `call ${i + 1}`);
      results.push(r);
      if (r.closedPass) break;
    }
    const closedAt = results.findIndex((r) => r.closedPass !== null);
    assert.ok(closedAt >= 0, `3 回の呼び出しで 1 周が閉じなかった: ${JSON.stringify(results.map((r) => [r.startOffset, r.nextOffset]))}`);
    assert.ok(closedAt >= 1, "1 回の呼び出しで 1,008 ページを読み切った（締切を差し込んだ clock で測っていない）");
    assert.ok(results[0].nextOffset > 0, "1 回目の呼び出しの後にカーソルが進んでいない");
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i].startOffset, results[i - 1].nextOffset, `呼び出し ${i + 1} は前の呼び出しの続きから読んでいない`);
    }
    const pass = results[closedAt].closedPass!;
    assert.equal(pass.passSeq, 1);
    assert.equal(pass.weak, false);
    assert.equal(pass.pagesFailed, 0);
    assert.equal(pass.pagesRead, 1008);
    assert.equal(pass.totalAtClose, N);
    assert.equal(results[closedAt].passSeq, 2, "周回を閉じたら pass_seq が +1 される");
    assert.equal(results[closedAt].nextOffset, 0, "周回を閉じたら next_offset が 0 に戻る");
    assert.equal(new Set(api.requests).size, 1008, "読んでいないページがある");
    assert.ok(api.requests.length <= 1008 + 3 * results.length, `同じページを何度も読んでいる: ${api.requests.length} 要求`);
    assert.equal(await h.countSeenInPass("t01-", 1), N, "1 周目で見えた鍵（last_seen_pass = 1）が全部ではない");
  });

  // ==========================================================
  test("T02 呼び出しが途中で切られても、読んだページの last_seen とカーソルは残り、次の呼び出しは続きから読む", { timeout: 120_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const N = 2_000;
    const H = 1_000;
    const list = entries("t02", N);
    const clock = new VirtualClock(BASE);
    let killed = true;
    let hung = 0;
    const api = mockCatalog(clock, () => list, {
      // 1 回目の呼び出しは offset H 以降の要求が返らない（Vercel に打ち切られた関数と同じ: その後の処理は 1 行も走らない）。
      override: (offset) => {
        if (killed && offset >= H) {
          hung++;
          return new Promise<Response>(() => {});
        }
        return null;
      },
    });
    let firstSettled = false;
    const first = m.cursor.runCatalogCursorCall(h.opts(clock, api.fetchImpl));
    first.then(
      () => void (firstSettled = true),
      () => void (firstSettled = true),
    );
    await waitFor(() => hung >= 1 || firstSettled);
    if (firstSettled) await first; // 止まる前に終わった（not implemented など）はここで原因を出す
    const saved = await waitFor(async () => (await h.cursorNextOffset()) === H);
    assert.ok(saved, `読んだページのカーソルが保存されていない（next_offset=${await h.cursorNextOffset()}、期待 ${H}）`);
    assert.equal(await h.countSeenInPass("t02-", 1), H, "切られる前に読んだページの出品が upsert されていない");
    const killedAt = clock.now().getTime();

    killed = false;
    const before = api.requests.length;
    const second = await h.callAt(clock, BASE + 2 * HOUR, api.fetchImpl, "次の呼び出し");
    assert.equal(second.startOffset, H, "次の呼び出しが続きから読んでいない");
    assert.equal(api.requests[before], H, "次の呼び出しの最初の要求が続きの offset ではない");
    assert.ok(!api.requests.slice(before).some((o) => o < H), "次の呼び出しが読み終えたページを読み直した");
    assert.equal(second.closedPass?.passSeq, 1, "次の呼び出しで 1 周目が閉じていない");
    assert.equal(await h.countSeenInPass("t02-", 1), N);
    // 切られる前に読んだ行は、2 回目に読み直されていない（last_seen_at は 1 回目の時刻のまま）。
    const early = rowsOf<{ n: number }>(
      await m.db.execute(m.sql`
        SELECT count(*)::int AS n FROM x402_endpoints
        WHERE resource_key LIKE 't02-%' AND last_seen_at <= ${new Date(killedAt).toISOString()}::timestamptz`),
    );
    assert.equal(Number(early[0]?.n ?? 0), H);
  });

  // ==========================================================
  test("T03 2 本の呼び出しを本当に重ねると、片方は skipped:\"leased\" で、ページの取得は 1 本分だけ", { timeout: 120_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const list = entries("t03", 500);
    const clock = new VirtualClock(BASE);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aReq = 0;
    let bReq = 0;
    const apiA = mockCatalog(clock, () => list);
    const apiB = mockCatalog(clock, () => list);
    const fetchA = async (url: string) => {
      aReq++;
      await gate;
      return apiA.fetchImpl(url);
    };
    const fetchB = async (url: string) => {
      bReq++;
      await gate;
      return apiB.fetchImpl(url);
    };
    let aSettled = false;
    const A = m.cursor.runCatalogCursorCall(h.opts(clock, fetchA));
    A.then(
      () => void (aSettled = true),
      () => void (aSettled = true),
    );
    await waitFor(() => aReq >= 1 || aSettled);
    if (aSettled && aReq === 0) await A; // 1 本目が取得に入る前に終わった（not implemented など）
    assert.ok(aReq >= 1, "1 本目が取得に入っていない");
    let bSettled = false;
    const B = m.cursor.runCatalogCursorCall(h.opts(clock, fetchB));
    B.then(
      () => void (bSettled = true),
      () => void (bSettled = true),
    );
    // 1 本目がページの途中で止まっているあいだに、2 本目が終わる（skipped）か取得に入るまで待つ。
    await waitFor(() => bSettled || bReq >= 1);
    release();
    const [ra, rb] = await Promise.all([A, B]);
    assert.deepEqual(rb, { skipped: "leased" }, "重ねた 2 本目が lease で止まらなかった");
    assert.equal(bReq, 0, "2 本目もページを取りにいった");
    const a = ran(ra, "1 本目");
    assert.equal(a.closedPass?.passSeq, 1);
    assert.equal(aReq, 5, "ページの取得が 1 本分（5 ページ）ではない");
    // lease は呼び出しの終わりに放され、次の cron は動ける。
    const next = await h.callAt(clock, BASE + 2 * HOUR, apiA.fetchImpl, "次の cron");
    assert.equal(next.closedPass?.passSeq, 2);
  });

  // ==========================================================
  test("T04 生きている出品が並びのずれで 1 周だけ読み落とされても閉じない（同じ入力で本当に消えた出品は閉じる）", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const base = entries("t04", 300);
    const M: Entry = { resource: "https://t04-moved.example/api" };
    const G: Entry = { resource: "https://t04-gone.example/api" };
    const clock = new VirtualClock(BASE);
    let pass = 1;
    const orderA = () => [...base.slice(0, 250), M, ...base.slice(250)];
    // 2 周目だけ: page 0 を読んだ後に M が先頭へ移る（更新されて並びが変わる）。page 0 の要求は M が 250 にある並び、
    // それ以外の要求は M が先頭にある並びで答えるので、2 周目のどの要求にも M は入らない。
    const api = mockCatalog(clock, () => orderA(), {
      listFor: (offset) => {
        if (pass === 1) return [...orderA(), G];
        if (pass === 2 && offset > 0) return [M, ...base];
        return orderA();
      },
    });
    // 周回の間隔は 49 時間（「1 周の欠け」だけで (b) の 48 時間を満たす形。(a) が 1 周なら M は閉じる）。
    for (let k = 1; k <= 5; k++) {
      pass = k;
      const r = await h.callAt(clock, BASE + (k - 1) * 49 * HOUR, api.fetchImpl, `pass ${k}`);
      assert.equal(r.closedPass?.passSeq, k, `呼び出し ${k} で周回 ${k} が閉じていない`);
      assert.equal(r.closedPass?.weak, false);
      assert.equal(await h.statusOf(M.resource), "active", `pass ${k} の後に、1 周だけ読み落とした M が閉じた`);
      if (k < 4) assert.equal(await h.statusOf(G.resource), "active", `pass ${k}: 強い周回 3 回の前に G が閉じた`);
    }
    assert.equal(await h.statusOf(G.resource), "delisted", "強い周回 3 回と 48 時間を満たした G が閉じていない");
    assert.equal(await h.delistEventsFor(G.resource), 1);
    assert.equal(await h.delistEventsFor(M.resource), 0, "M に delisted のイベントがある");
  });

  // ==========================================================
  test("T05 途中のページが毎回短い周回（R2 の形）は弱い周回になり、その裏の生きている出品は 3 日たっても閉じない（読めた周回で消えた出品は閉じる）", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const base = entries("t05", 3_000);
    const G: Entry = { resource: "https://t05-gone.example/api" };
    // page 20 と 21 が 90 件（2/30 = 6.7% > 5%）。それぞれの末尾 10 件は短いページの日には一度も返らない。
    const hidden = [...base.slice(2090, 2100), ...base.slice(2190, 2200)].map((e) => e.resource);
    const clock = new VirtualClock(BASE);
    let day = 1;
    const api = mockCatalog(clock, () => (day === 1 ? [...base, G] : base), {
      short: () => (day >= 2 && day <= 4 ? new Map([[20, 90], [21, 90]]) : undefined),
    });
    for (day = 1; day <= 7; day++) {
      const r = await h.callAt(clock, BASE + (day - 1) * DAY, api.fetchImpl, `day ${day}`);
      assert.equal(r.closedPass?.passSeq, day, `day ${day} の呼び出しで周回が閉じていない`);
      const shortDay = day >= 2 && day <= 4;
      assert.equal(r.closedPass?.weak, shortDay, `day ${day}: 弱い周回の印が期待と違う（短いページ ${shortDay ? 2 : 0}/30）`);
      if (shortDay) assert.equal(r.closedPass?.pagesFailed, 2);
      const st = await h.statusesOf(hidden);
      assert.ok(st.every((s) => s === "active"), `day ${day}: 短いページの裏の生きている出品が閉じた: ${st.join(",")}`);
      if (day < 7) assert.equal(await h.statusOf(G.resource), "active", `day ${day}: 強い周回 3 回の前に G が閉じた`);
    }
    assert.equal(await h.statusOf(G.resource), "delisted", "読めた周回（5〜7 日目）3 回の後に G が閉じていない");
    for (const url of hidden) assert.equal(await h.delistEventsFor(url), 0);
  });

  // ==========================================================
  test("T06 429 が続いて周回が閉じない（R5m の形）あいだは何も閉じない（その前の読めた周回で消えた出品は閉じる）", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const base = entries("t06", 4_949);
    const X: Entry = { resource: "https://t06-x.example/api" };
    const G: Entry = { resource: "https://t06-gone.example/api" };
    const lastPage = base.slice(4_900).map((e) => e.resource); // X と同じ最後のページ（offset 4,900）に載る 49 件
    const clock = new VirtualClock(BASE);
    let day = 1;
    const listOf = () => (day === 1 ? [...base, X, G] : day === 5 ? base : [...base, X]);
    const api = mockCatalog(clock, listOf, {
      // 6 日目から、最後のページ（X を含む）だけ 429（Retry-After: 30）が続く。
      override: (offset) => (day >= 6 && offset >= 4_900 ? throttled() : null),
    });
    for (day = 1; day <= 9; day++) {
      const r = await h.callAt(clock, BASE + (day - 1) * DAY, api.fetchImpl, `day ${day}`);
      if (day <= 5) {
        assert.equal(r.closedPass?.passSeq, day);
        assert.equal(r.closedPass?.weak, false);
      } else {
        assert.equal(r.closedPass, null, `day ${day}: 429 で読めないページを残したまま周回が閉じた`);
        assert.equal(r.nextOffset, 4_900, `day ${day}: 締切で諦めたページの先へカーソルが進んだ`);
      }
      if (day < 4) assert.equal(await h.statusOf(G.resource), "active", `day ${day}: 強い周回 3 回の前に G が閉じた`);
      if (day >= 4) assert.equal(await h.statusOf(G.resource), "delisted", `day ${day}: 強い周回 2〜4 の後に G が閉じていない`);
      assert.equal(await h.statusOf(X.resource), "active", `day ${day}: 周回が閉じないのに X が閉じた`);
      const st = await h.statusesOf(lastPage);
      assert.ok(st.every((s) => s === "active"), `day ${day}: 429 のページの出品が閉じた`);
    }
    assert.equal(await h.delistEventsFor(X.resource), 0);
    assert.equal(await h.totalDelistEvents(), 1, "G 以外にも閉じた行がある");
  });

  // ==========================================================
  test("T07 本当に消えた出品は、強い周回 3 回かつ 48 時間の後に 1 回だけ閉じ、イベントは 1 行（閉じる回が重なっても）", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const base = entries("t07", 200);
    const G: Entry = { resource: "https://t07-gone.example/api" };
    const clock = new VirtualClock(BASE);
    let k = 1;
    const api = mockCatalog(clock, () => (k === 1 ? [...base, G] : base));
    // 2 時間おきに 1 周（46 時間で 24 周）。(a) は 4 周目で満たすが、(b) の 48 時間はまだ。
    for (k = 1; k <= 24; k++) {
      const r = await h.callAt(clock, BASE + (k - 1) * 2 * HOUR, api.fetchImpl, `pass ${k}`);
      assert.equal(r.closedPass?.passSeq, k);
      assert.equal(await h.statusOf(G.resource), "active", `pass ${k}（${(k - 1) * 2} 時間後）: 48 時間の前に G が閉じた`);
    }
    assert.equal(await h.delistEventsFor(G.resource), 0);
    // 48 時間を過ぎた時点で、閉じる回を 2 本同時に（どちらも G を候補に持ち、UPDATE で待つ）。
    const gid = await h.idOf(G.resource);
    const rounds = await h.twoClosingsUnderRowLock(gid, new Date(BASE + 48 * HOUR + 60_000));
    assert.equal(rounds.filter((r) => r.closedIds.includes(gid)).length, 1, "G を閉じた回がちょうど 1 本ではない");
    assert.equal(rounds.reduce((s, r) => s + r.eventsWritten, 0), 1, "2 本の閉じる回が書いたイベントの合計が 1 ではない");
    assert.equal(await h.statusOf(G.resource), "delisted");
    assert.equal(await h.delistEventsFor(G.resource), 1, "delisted のイベントが 1 行ではない");
    // その後の cron でも増えない。
    k = 25;
    await h.callAt(clock, BASE + 50 * HOUR, api.fetchImpl, "after");
    assert.equal(await h.delistEventsFor(G.resource), 1);
    assert.equal(await h.totalDelistEvents(), 1);
  });

  // ==========================================================
  test("T08 閉じる回を 2 本同時に走らせても（R6c の形）、イベントは 1 行・webhook は 1 回", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const base = entries("t08", 300);
    const payTo = "0x" + "9".repeat(40);
    const G: Entry = { resource: "https://t08-gone.example/api", payTo };
    const clock = new VirtualClock(BASE);
    let k = 1;
    const api = mockCatalog(clock, () => (k === 1 ? [...base, G] : base));
    await m.db.execute(m.sql`INSERT INTO x402_payee_watchers (wallet, api_key_id) VALUES (${payTo}, gen_random_uuid())`);
    // 12 時間おきに 4 周（(a) は 36 時間で満たし、(b) は 48 時間で満たす）。
    for (k = 1; k <= 4; k++) {
      const r = await h.callAt(clock, BASE + (k - 1) * 12 * HOUR, api.fetchImpl, `pass ${k}`);
      assert.equal(r.closedPass?.passSeq, k);
      assert.equal(await h.statusOf(G.resource), "active");
    }
    const gid = await h.idOf(G.resource);
    const rounds = await h.twoClosingsUnderRowLock(gid, new Date(BASE + 48 * HOUR + 60_000));
    assert.equal(await h.statusOf(G.resource), "delisted", "48 時間と強い周回 3 回を満たした G が閉じていない");
    assert.equal(rounds.filter((r) => r.closedIds.includes(gid)).length, 1, "2 本の閉じる回の両方が G を閉じたと返した");
    assert.equal(await h.delistEventsFor(G.resource), 1, "delisted のイベントが 1 行ではない");
    // 2 本の呼び出しのそれぞれが通知まで走る（R6c）。
    const sent: { apiKeyId: string | null; payload: unknown }[] = [];
    const dispatch = async (apiKeyId: string | null, _eventType: string, payload: unknown) => {
      sent.push({ apiKeyId, payload });
    };
    await Promise.all([m.notifyDelistedEvents({ dispatch }), m.notifyDelistedEvents({ dispatch })]);
    await m.notifyDelistedEvents({ dispatch });
    assert.equal(sent.length, 1, `webhook が ${sent.length} 回送られた`);
    assert.equal((sent[0].payload as { resourceKey?: string }).resourceKey, h.keyOf(G.resource));
  });

  // ==========================================================
  test("T09 1 回で active の 3% が「見えていない」になったら 1 件も閉じず、アラートを出す（2% 以下になった回は閉じる）", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const keep = entries("t09-keep", 970);
    const vanish = entries("t09-vanish", 30); // 30 / 1,000 = 3%
    const clock = new VirtualClock(BASE);
    let day = 1;
    const api = mockCatalog(clock, () =>
      day === 1 ? [...keep, ...vanish] : day <= 4 ? keep : [...keep, ...vanish.slice(0, 15)],
    );
    let capLines: string[] = [];
    for (day = 1; day <= 5; day++) {
      const cap = captureErrors();
      let r: Ran;
      try {
        r = await h.callAt(clock, BASE + (day - 1) * DAY, api.fetchImpl, `day ${day}`);
      } finally {
        cap.restore();
      }
      capLines = cap.lines.filter((l) => l.includes(m.cursor.LOG_TAG_CLOSURE_CAP_EXCEEDED));
      assert.equal(r.closedPass?.passSeq, day);
      if (day === 4) {
        assert.equal(r.closure.candidates, 30, "day 4: 候補が 30 件ではない");
        assert.equal(r.closure.activeCdpRows, 1_000);
        assert.equal(r.closure.capped, true, "day 4: 3% なのに上限で止めていない");
        assert.equal(r.closure.closedIds.length, 0);
        assert.ok(capLines.length >= 1, "day 4: 上限のアラートがログに出ていない");
        const st = await h.statusesOf(vanish.map((e) => e.resource));
        assert.ok(st.every((s) => s === "active"), "day 4: 上限を超えたのに閉じた");
      }
      if (day === 5) {
        assert.equal(r.closure.capped, false);
        assert.equal(capLines.length, 0, "day 5: 2% 以下なのに上限のアラートが出た");
      }
    }
    assert.deepEqual(await h.statusesOf(vanish.slice(0, 15).map((e) => e.resource)), Array(15).fill("active"));
    assert.deepEqual(await h.statusesOf(vanish.slice(15).map((e) => e.resource)), Array(15).fill("delisted"), "1.5% になった回で閉じていない");
    assert.equal(await h.totalDelistEvents(), 15);
  });

  // ==========================================================
  test("T10 circle_discovery だけの出品が Circle から消えたら（R1c の形）、origin/main と同じ日（消えた最初の完全な取得の日）に閉じる", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const fill = entries("t10-cdp", 200);
    const Q = "https://t10-circle-only.example/v1";
    const anchor = "https://t10-circle-anchor.example/v1";
    const clock = new VirtualClock(BASE);
    const api = mockCatalog(clock, () => fill);
    for (let day = 1; day <= 4; day++) {
      const t = BASE + (day - 1) * DAY;
      await h.callAt(clock, t + HOUR, api.fetchImpl, `cdp day ${day}`);
      await h.circleDay(clock, t + 2 * HOUR, day === 1 ? [Q, anchor] : [anchor]);
      assert.equal(await h.statusOf(anchor), "active");
      assert.equal(await h.statusOf(Q), day === 1 ? "active" : "delisted", `day ${day}: Circle だけの行の状態が origin/main と違う`);
    }
    const ev = await h.delistEventRows(Q);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detected_on, h.dayIso(BASE + DAY), "閉じた日が origin/main（消えた最初の完全な取得の日）ではない");
  });

  // ==========================================================
  test("T11 cdp と circle の両方に載る出品が、cdp で 1 周だけ欠け Circle から消えても閉じない（B1 の形。両方で消えた出品と Circle だけの出品は閉じる）", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const fill = entries("t11-cdp", 200);
    const P = "https://t11-shared-p.example/api"; // 両方。cdp で 3 日目だけ欠ける。Circle は 2 日目から載せない。
    const S = "https://t11-shared-s.example/api"; // 両方。cdp からも Circle からも 2 日目から消える。
    const Q = "https://t11-circle-only.example/v1"; // Circle だけ。2 日目から消える。
    const A = "https://t11-cdp-a.example/api";
    const anchor = "https://t11-circle-anchor.example/v1";
    const clock = new VirtualClock(BASE);
    let day = 1;
    const api = mockCatalog(clock, () => {
      const extra = day === 1 ? [P, S, A] : day === 3 ? [A] : [P, A];
      return [...fill, ...extra.map((resource) => ({ resource }))];
    });
    // 1 日目: Circle が先に載せる（行の持ち主は circle_discovery）。そのあと cdp が同じ鍵を読む。
    await h.circleDay(clock, BASE + HOUR / 2, [P, S, Q, anchor]);
    await h.callAt(clock, BASE + HOUR, api.fetchImpl, "cdp day 1");
    assert.deepEqual(await h.statusesOf([P, S, Q]), ["active", "active", "active"]);
    for (day = 2; day <= 5; day++) {
      const t = BASE + (day - 1) * DAY;
      await h.callAt(clock, t + HOUR, api.fetchImpl, `cdp day ${day}`);
      await h.circleDay(clock, t + 2 * HOUR, [anchor]);
      assert.equal(await h.statusOf(P), "active", `day ${day}: cdp が 1 周だけ欠いた共有の出品が閉じた`);
      assert.equal(await h.statusOf(Q), "delisted", `day ${day}: Circle だけの出品が origin/main と同じ日に閉じていない`);
      assert.equal(await h.statusOf(S), day >= 4 ? "delisted" : "active", `day ${day}: 両方から消えた出品の状態が違う（cdp の強い周回 3 回と 48 時間で閉じる）`);
    }
    assert.equal(await h.delistEventsFor(P), 0);
    assert.equal(await h.delistEventsFor(S), 1);
    assert.equal(await h.delistEventsFor(Q), 1);
  });

  // ==========================================================
  test("T12 36 時間、強い周回が閉じなければ、ログのアラートと公開の鮮度の欄の両方が「古い」になる（行の last_seen_at は新しいまま）", { timeout: 300_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const list = entries("t12", 1_000);
    // getObservatoryStats は自分の時計（実時計）で判定するので、この試験の最後の呼び出しが「今の少し前」になるように
    // 起点を置く。判定に効くのは差（42 時間）だけで、実時計の値には依存しない。
    const t0 = Date.now() - 42 * HOUR - 10 * 60_000;
    const clock = new VirtualClock(t0);
    let broken = false;
    // 2 回目以降、page 8 と 9 が 500 を返し続ける（2/10 = 20% が読めない → 弱い周回。ほかのページは毎回読める）。
    const api = mockCatalog(clock, () => list, { override: (offset) => (broken && offset >= 800 ? serverError() : null) });
    const first = await h.callAt(clock, t0, api.fetchImpl, "strong pass");
    assert.equal(first.closedPass?.weak, false);
    assert.equal(first.watchdog.stale, false);
    broken = true;
    for (const hrs of [6, 12, 18, 24, 30, 36, 42]) {
      const cap = captureErrors();
      let r: Ran;
      try {
        r = await h.callAt(clock, t0 + hrs * HOUR, api.fetchImpl, `+${hrs}h`);
      } finally {
        cap.restore();
      }
      const alerts = cap.lines.filter((l) => l.includes(m.cursor.LOG_TAG_PASS_STALE));
      assert.equal(r.closedPass?.weak, true, `+${hrs}h: 読めないページが 20% の周回が弱い周回になっていない`);
      if (hrs === 30) {
        assert.equal(r.watchdog.stale, false, "+30h: 36 時間たっていないのに古いと判定した");
        assert.equal(alerts.length, 0, "+30h: 36 時間たっていないのにアラートが出た");
        assert.equal((await m.reader.getCdpBazaarIngestFreshness({ now: clock.now() })).stale, false);
      }
      if (hrs === 42) {
        assert.equal(r.watchdog.stale, true, "+42h: 強い周回が 42 時間閉じていないのに古いと判定しない");
        assert.equal(r.watchdog.lastStrongPassCompletedAt?.getTime(), first.closedPass!.completedAt.getTime());
        assert.ok(alerts.length >= 1, "+42h: 見張りのアラートがログに出ていない");
        assert.equal((await m.reader.getCdpBazaarIngestFreshness({ now: clock.now() })).stale, true, "公開の鮮度の欄が古いと判定しない");
      }
    }
    // 行は今も見えている（max(last_seen_at) は新しい）。それでも公開の欄は「古い」。
    const fresh = rowsOf<{ max: Date | string | null }>(
      await m.db.execute(m.sql`SELECT max(last_seen_at) AS max FROM x402_endpoints WHERE source = ${CDP} AND status = 'active'`),
    );
    assert.ok(new Date(fresh[0].max!).getTime() >= clock.now().getTime() - HOUR, "前提: 行の last_seen_at は新しい");
    const stats = await m.reader.getObservatoryStats();
    assert.equal(stats.cdpBazaarIngestStale, true, "getObservatoryStats の公開の鮮度の欄が古いと出していない");
    // 強い周回が閉じれば、公開の欄は戻る。
    broken = false;
    const recovered = await h.callAt(clock, clock.now().getTime() + 60_000, api.fetchImpl, "recovered");
    assert.equal(recovered.closedPass?.weak, false);
    assert.equal(recovered.watchdog.stale, false);
    assert.equal((await m.reader.getObservatoryStats()).cdpBazaarIngestStale, false, "強い周回が閉じた後も公開の欄が古いまま");
  });

  // ==========================================================
  test("T13 L1 の候補 SQL は、37 時間見えていない cdp_bazaar の行を入れず、circle と mpp の行は今のまま入れる", { timeout: 120_000 }, async () => {
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const { l1TargetsSqlBuilders } = await import("@/lib/observatory/l1-runner");
    const rows = [
      { key: "t13-cdp-stale.example/api", source: CDP, hoursAgo: 37 },
      { key: "t13-cdp-fresh.example/api", source: CDP, hoursAgo: 1 },
      { key: "t13-circle.example/api", source: CIRCLE, hoursAgo: 37 },
      { key: "t13-mpp.example/api", source: "mpp_directory", hoursAgo: 37 },
    ];
    for (const [i, r] of rows.entries()) {
      await m.db.execute(m.sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, raw_accepts, status, quality_payers_30d, quality_calls_30d, first_seen_at, last_seen_at)
        VALUES (${r.key}, ${"https://" + r.key}, ${r.source}, 'GET', 'eip155:8453', ${"0x" + String(i + 1).padStart(40, "e")}, '1000',
                ${JSON.stringify([{ ...baseAccept, payTo: "0x" + String(i + 1).padStart(40, "e") }])}::jsonb, 'active', 1, 1,
                now() - interval '30 days', now() - make_interval(hours => ${r.hoursAgo}))
      `);
    }
    await m.db.execute(m.sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict) SELECT id, 'GET', 'pass' FROM x402_endpoints`);
    const ctx = { limit: 100, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true };
    const raw = await m.db.execute(l1TargetsSqlBuilders(ctx).targetsSql(false));
    const ids = new Set(rowsOf<{ id: string }>(raw).map((r) => String(r.id)));
    const has = async (key: string) => ids.has(await h.idOf("https://" + key));
    assert.equal(await has("t13-cdp-fresh.example/api"), true, "前提: 新しい cdp の行は候補に入る");
    assert.equal(await has("t13-circle.example/api"), true, "circle_discovery の行が候補から落ちた");
    assert.equal(await has("t13-mpp.example/api"), true, "mpp_directory の行が候補から落ちた");
    assert.equal(await has("t13-cdp-stale.example/api"), false, "37 時間見えていない cdp_bazaar の行が L1 の候補に入った");
  });

  // ==========================================================
  test("T14 phase1: cdp_bazaar の行は強い周回 10 回続けて見えなくても active のまま。同じ入力で circle_discovery だけの行は origin/main と同じ日に閉じる", { timeout: 300_000 }, async () => {
    // 第1段（設計 1・3・4・5 だけ）の一時の基準。第2段で設計 2 が入ったら、この試験を T04〜T11 に置き換える。
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const fill = entries("t14-cdp", 200);
    const Z: Entry = { resource: "https://t14-cdp-gone.example/api" };
    const Q = "https://t14-circle-only.example/v1";
    const anchor = "https://t14-circle-anchor.example/v1";
    const clock = new VirtualClock(BASE);
    let day = 1;
    const api = mockCatalog(clock, () => (day === 1 ? [...fill, Z] : fill));
    for (day = 1; day <= 11; day++) {
      const t = BASE + (day - 1) * DAY;
      const r = await h.callAt(clock, t + HOUR, api.fetchImpl, `cdp day ${day}`);
      assert.equal(r.closedPass?.passSeq, day);
      assert.equal(r.closedPass?.weak, false);
      await h.circleDay(clock, t + 2 * HOUR, day === 1 ? [Q, anchor] : [anchor]);
      assert.equal(await h.statusOf(Z.resource), "active", `day ${day}: 第1段なのに cdp_bazaar の行が閉じた`);
      assert.equal(await h.statusOf(Q), day === 1 ? "active" : "delisted", `day ${day}: Circle だけの行の状態が origin/main と違う`);
    }
    assert.equal(await h.delistEventsFor(Z.resource), 0);
    const ev = await h.delistEventRows(Q);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detected_on, h.dayIso(BASE + DAY));
  });

  // ==========================================================
  test("T15 phase1: 導入前から cdp が持つ共有の行は、周回でそのページだけ読めず（強い周回）、Circle が載せた翌日に Circle から消えても閉じない（X1 の形。同じ入力で Circle だけの行は閉じる）", { timeout: 300_000 }, async () => {
    // 2026-10-30 点検 X1。強い周回は読めないページ 5% までと並びのずれの読み落としを許すので、その snapshot は「cdp に無い」の
    // 証明にならない。第1段の Circle の同期は cdp の不在を証明済みとして扱わず、cdp に載る行の持ち主を移さず cdp の slice を消さない。
    // 第2段で T14 と一緒に T04〜T11 に置き換える。
    const m = await load();
    const h = helpers(m);
    await h.truncate();
    const X = "https://t15-x.example/api";
    const Q = "https://t15-circle-only.example/v1";
    const anchor = "https://t15-circle-anchor.example/v1";
    const clock = new VirtualClock(BASE);
    // 導入前: 旧の cdp の同期（不完全）が X を持ち、Circle も X を載せる（X は cdp が持ち主の共有の行、last_seen_pass は NULL）。
    await m.syncCatalog({
      fetchResult: { items: [m.parseCatalogItem(cdpItem({ resource: X }))], totalCount: 100_800, fetchedCount: 80_000, complete: false },
      today: h.dayIso(BASE - DAY),
      source: CDP,
    });
    await h.circleDay(clock, BASE - DAY + HOUR, [X, anchor]);
    const before = rowsOf<{ source: string; last_seen_pass: number | null; by: Record<string, unknown> | null }>(
      await m.db.execute(m.sql`SELECT source, last_seen_pass, accepts_by_source AS by FROM x402_endpoints WHERE resource_key = ${h.keyOf(X)}`),
    )[0];
    assert.equal(before.source, CDP, "前提: X の持ち主は cdp");
    assert.equal(before.last_seen_pass, null, "前提: カーソルはまだ X を見ていない");
    // 導入後の最初の周回: X のいるページ（page 7）だけ 500 を返し続ける（1/30 = 3.3% なので強い周回）。
    const filler = entries("t15-cdp", 2_999);
    const list = [...filler.slice(0, 700), { resource: X }, ...filler.slice(700)];
    const api = mockCatalog(clock, () => list, { override: (offset) => (Math.floor(offset / 100) === 7 ? serverError() : null) });
    const pass = await h.callAt(clock, BASE, api.fetchImpl, "pass 1");
    assert.equal(pass.closedPass?.weak, false, "前提: 1/30 の読めないページは強い周回");
    assert.equal(pass.closedPass?.pagesFailed, 1);
    // Circle の 1 日目は X を載せ、2 日目は載せない。Circle だけの Q も 1 日目だけ載る。
    await h.circleDay(clock, BASE + DAY, [X, Q, anchor]);
    const mid = rowsOf<{ source: string; by: Record<string, unknown> | null }>(
      await m.db.execute(m.sql`SELECT source, accepts_by_source AS by FROM x402_endpoints WHERE resource_key = ${h.keyOf(X)}`),
    )[0];
    assert.equal(mid.source, CDP, "Circle の同期が、cdp に載る行の持ち主を circle_discovery へ移した");
    assert.ok(Array.isArray(mid.by?.[CDP]) && (mid.by?.[CDP] as unknown[]).length > 0, "Circle の同期が cdp の accepts の slice を消した");
    await h.circleDay(clock, BASE + 2 * DAY, [anchor]);
    assert.equal(await h.statusOf(X), "active", "Circle から消えた日に、cdp に載る共有の行が閉じた");
    assert.equal(await h.delistEventsFor(X), 0);
    assert.equal(await h.statusOf(Q), "delisted", "同じ入力で Circle だけの行が閉じていない");
    assert.equal(await h.delistEventsFor(Q), 1);
  });
}

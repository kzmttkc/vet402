# 目録の同期 v5 — つなぎ目の契約（2026-10-30）

設計の正典: `/Users/takeshi/vet402-orders/1030-catalog-sync-v5-staleness.md`（「決めた設計 1〜6」「完了条件の表」）。
この文書は、その設計を今のコードに入れるときの **関数・引数・戻り値・表と列・時計・締切** と、変異の確かめで **どこを壊すか** を決める。
合格の基準は `tests/catalog-staleness.pg.test.ts`（トップレベルの T01〜T14）と `scripts/dev/mutation-check-catalog.sh`。

- 殻（型だけ、中身は `throw new Error("not implemented")`）は次に置いてある。実装はこの殻を埋める。
  - `src/lib/observatory/catalog-cursor.ts`: `runCatalogCursorCall`・`closeCatalogListings`・`checkCatalogPassFreshness`・定数・型
  - `src/lib/observatory/reader.ts`: `getCdpBazaarIngestFreshness`、`ObservatoryStats.cdpBazaarIngestStale` / `cdpBazaarLastStrongPassAt`（いまは省略可。実装で必須にする）
  - `src/lib/observatory/l1-runner.ts`: `CDP_BAZAAR_L1_FRESH_HOURS = 36`（候補 SQL への組み込みは実装で入れる）
  - `src/lib/observatory/catalog-sync.ts`: `syncCatalog` の `clock?: () => Date`（いまは読まない）
  - DB: `scripts/sql/2026-10-30-catalog-staleness.sql` と `src/lib/db/schema.ts`
- テストの中身を変えて通すのは不合格。期待を変えたいときは、実装の前に理由を書いて止まる（設計の正典の決まりと同じ）。

## 1. 段階

| 段 | 入れる設計 | 合格の基準（テスト） | 変異の確かめ |
|---|---|---|---|
| 第1段 | 1（カーソル）・3（cron）・4（見張り）・5（L1） | T01・T02・T03・T12・T13・**T14**・**T15** が通る | `mutation-check-catalog.sh 1`（T01 T02 T03 T12 T13 T14 T15 のパッチ） |
| 第2段 | 2（閉じる）・6 | T01〜T13 が通る | `mutation-check-catalog.sh 2`（T01〜T13、T07 は 2 本） |

- 第1段では **cdp_bazaar の行を閉じる処理を全部止める**（`closeCatalogListings` は cdp の行を 1 件も閉じない。circle_discovery だけの行は origin/main のまま閉じる）。
- **第2段で T14・T15 を T04〜T11 に置き換える**（T15 は 2026-10-30 の点検 X1 で足した）: 第2段の実装と同じコミットで T14 をテストから消し、T04〜T11 を合格の基準に入れる。T14 は「cdp の行は閉じない」を確かめるので、設計 2 が入ると期待が逆になる。
- 第1段の間、T04〜T11 は落ちてよい（`npm run test:db` はこのファイルを含むので、第1段の報告では T04〜T11 の fail を数えて分けて書く）。

## 2. つなぎ目の原則

| 何 | どう差し込むか |
|---|---|
| 取得 | `fetchImpl(url) => Promise<Response>`。URL は `${baseUrl}?limit=${pageLimit}&offset=${offset}`（今の `fetchFullCatalog` と同じ形）。テストは模擬の目録を渡し、本物の CDP には出ない |
| 時計 | `clock: () => Date`。締切・lease・`last_seen_at`・周回の時刻・閉じる判定・見張りは **全部これで測る**。`Date.now()` や SQL の `now()` で測らない（例外は下の L1 と既存の Circle の書き込み） |
| 待ち | `sleep: (ms) => Promise<void>`。礼儀の間隔・429 の一時停止・再試行の backoff は全部これで待つ。テストは待たずに時計を進める sleep を渡す |
| 締切 | `deadlineMs`（既定 200,000）。呼び出しの開始の `clock()` から測る |
| DB | `getDb()`。本番は **neon-http**（複数文のトランザクションが無い）。原子的でなければならない書き込みは **1 文**（データ変更 CTE か 1 本の UPDATE … RETURNING）にする。`db.transaction` は使わない（テストの postgres-js では動くが本番で落ちる。テストではこれを見分けられないので、ここで決める） |
| 日時の SQL 引数 | drizzle の生の `sql` に `Date` をそのまま渡すと postgres-js で落ちる。`${d.toISOString()}::timestamptz` で渡す |

テスト専用の分岐（`process.env.X === "test"` で振る舞いを変えるもの）を本番のコードに入れない。差し込みは上の引数だけ。

## 3. DB

本番に当てる SQL は 1 本: `scripts/sql/2026-10-30-catalog-staleness.sql`（CREATE TABLE / ALTER TABLE … IF NOT EXISTS だけ）。
旧コードのまま当てても安全: 旧コードは新しい表と列を読まず書かない。列は NULL 可・既定なしで、既存の行を書き換えない。

### `x402_catalog_cursors`（目録ごとに 1 行。主キー `source`）

| 列 | 型 | 意味 |
|---|---|---|
| `source` | text PK | `cdp_bazaar` |
| `next_offset` | int not null default 0 | 次に読む offset。**連続して読み終えたページの直後**（並列で後ろのページが先に終わっても、前が終わるまで進めない） |
| `pass_seq` | int not null default 1 | いまの周回の番号。周回を閉じたら +1 |
| `pass_started_at` | timestamptz | いまの周回が始まった時刻（clock） |
| `pass_pages_read` / `pass_pages_failed` | int not null default 0 | いまの周回で読んだページ（失敗を含む）と、そのうち読めなかったページ。周回を閉じたら 0 |
| `last_pass_completed_at` | timestamptz | 最後に閉じた周回（弱い周回を含む） |
| `last_strong_pass_completed_at` | timestamptz | 最後に閉じた **強い** 周回。見張りと公開の鮮度の欄はこれで判定する |
| `lease_until` / `lease_holder` | timestamptz / uuid | lease。取り方は 4.1 |
| `created_at` / `updated_at` | timestamptz | |

行が無ければ最初の呼び出しが `INSERT … ON CONFLICT DO NOTHING` で作る。

### `x402_catalog_passes`（閉じた周回。主キー `(source, pass_seq)`）

`started_at`・`completed_at`・`total_at_close`・`pages_read`・`pages_failed`・`weak`（すべて not null）。
`weak = pages_failed / pages_read > 0.05`（`WEAK_PASS_FAILED_PAGE_RATIO`）。閉じる条件 (a) は `weak = false` の行だけを数える。

### `x402_endpoints.last_seen_pass`（int、NULL 可）

カーソルがその行を最後に見た周回の番号。NULL = カーソルが一度も見ていない（circle・mpp だけの行、導入前の行）。
cdp と circle は `resource_key` で 1 行なので、**circle が持ち主の共有の行もカーソルが見たら `last_seen_pass` と `last_seen_at` を書く**。

## 4. 関数

### 4.1 `runCatalogCursorCall(options): Promise<CatalogCursorCallResult>`（catalog-cursor.ts）

引数（`CatalogCursorCallOptions`）: `source?`（cdp_bazaar だけ）・`fetchImpl?`・`clock?`・`sleep?`・`deadlineMs?`（200,000）・`concurrency?`（3）・`pageLimit?`（100）・`sleepMs?`（150、礼儀の間隔）・`maxRetriesPerPage?`（5）・`maxThrottleRetries?`（12）・`baseUrl?`。

戻り値: `{ skipped: "leased" }`、または `{ skipped: null, passSeq, startOffset, nextOffset, pagesRead, pagesFailed, itemsUpserted, total, closedPass, closure, watchdog }`（型は殻のとおり）。

手順:

1. **lease**: `now0 = clock()`。1 文で取る:
   `UPDATE x402_catalog_cursors SET lease_until = $now0 + 290s, lease_holder = $me WHERE source = $1 AND (lease_until IS NULL OR lease_until <= $now0) RETURNING …`。
   行が返らなければ何もせず `{ skipped: "leased" }`（取得もしない）。セッションの advisory lock は使わない。
   - 設計の文面は `now()` だが、テストを時計で進めるため **差し込んだ clock の値で比べる**（原子性は同じ 1 文の UPDATE）。
   - カーソルへの以後の書き込みは全部 `AND lease_holder = $me` を付ける（打ち切られて残った古い呼び出しが後から書いても効かない）。
   - 呼び出しの終わり（正常でも例外でも）に `lease_until = NULL WHERE lease_holder = $me` で放す。打ち切られたときは 290 秒で切れる。
2. **読む**: `next_offset` から、`next_offset + k * pageLimit` の offset を若い順に `concurrency` 本で取る。`clock()` が締切（`now0 + deadlineMs`）を過ぎたら新しいページを取りにいかない。total を知った後は total 以上の offset を取りにいかない。
3. **1 ページの結果**は 4 つ:
   - 読めた: 出品を **その場で upsert**（下の 5）。
   - 短いページ: 読めたが `items.length < pageLimit` かつ `offset + items.length < total`。出品は upsert し、**読めなかったページとして数える**。カーソルは `pageLimit` 進める（受け取った件数で詰めない）。
   - 読めなかった: 429 以外の失敗を `maxRetriesPerPage` 回、または 429 を `maxThrottleRetries` 回使い切った。数えて飛ばす（周回を止めない）。
   - **締切で諦めた**: 再試行や 429 の一時停止の途中で締切を過ぎた。**失敗に数えず、カーソルはそのページに残す**（次の呼び出しがそのページから読む）。
   - 429: 今の扱い（全ワーカーを `pauseUntil` まで止める。待ちは `min(30s, Retry-After ?? 2s·2^(k-1))`、`sleep` で待つ、別枠の再試行）。
4. **カーソルを保存**: ページが終わるたびに、連続して終わったところまで `next_offset`・`pass_pages_read`・`pass_pages_failed` を 1 文で保存する（最後にまとめて保存しない）。
5. **upsert**: 今の `syncCatalog` の cdp_bazaar の upsert と同じ列・同じ共有行の扱い（`accepts_by_source`・持ち主・別名）で、`last_seen_at = clock()`、`last_seen_pass = pass_seq`、`status = 'active'`、`delisted_at = NULL`。delisted だった行が見えたら relisted のイベントを書く（今と同じ）。snapshot の差分で閉じることはしない。
6. **周回を閉じる**: 全ワーカーが止まった後、`next_offset >= total`（最後に見た total）で、締切で諦めたページが無ければ周回を閉じる:
   `x402_catalog_passes` に 1 行、カーソルは `pass_seq + 1`・`next_offset = 0`・ページ数 0・`last_pass_completed_at = clock()`・強い周回なら `last_strong_pass_completed_at = clock()`。
   **1 回の呼び出しで閉じる周回は最大 1 つ**（閉じたら残り時間があってもその呼び出しは読むのをやめる）。周回の途中の並びのずれによる読み落としは許す（次の周回で拾う）。
7. **閉じる回と見張り**: lease を取れた呼び出しの最後に **毎回 1 回ずつ**（周回を閉じたかどうかに関係なく）`closeCatalogListings({ now: clock() })` と `checkCatalogPassFreshness({ now: clock() })` を呼び、戻り値の `closure`・`watchdog` に入れる。

壊すべき部分（変異のパッチの中身は実装者が書く）:

| パッチ | 壊すところ |
|---|---|
| `T01.patch` | 手順 2 の読み始めを、保存した `next_offset` ではなく毎回 0 にする |
| `T02.patch` | 手順 4 のページごとのカーソルの保存（と upsert の確定）をやめ、呼び出しの最後にまとめて保存する形にする |
| `T03.patch` | 手順 1 の lease の条件（`lease_until IS NULL OR lease_until <= $now0`）を外す |

### 4.2 `closeCatalogListings({ now, detectedOn? }): Promise<CatalogClosureResult>`（catalog-cursor.ts）

閉じる判定の **唯一の入口**。cdp のカーソルの呼び出しの最後と、Circle の `syncCatalog` の最後の両方がこれを呼ぶ。ほかの経路（snapshot の差分・日次の突き合わせ）で `status = 'delisted'` を書かない。`detectedOn` の既定は `now` の UTC 日付。

行の分類と規則（active な cdp_bazaar / circle_discovery の行に当てる）:

| 行 | 「cdp に載る行」= `source = 'cdp_bazaar'` か `last_seen_pass IS NOT NULL` か `accepts_by_source ? 'cdp_bazaar'`。「circle に載る行」= `source = 'circle_discovery'` か `accepts_by_source ? 'circle_discovery'` | 閉じる条件 |
|---|---|---|
| cdp だけ | | cdp の規則 |
| circle だけ | | circle の規則（origin/main の今の閉じ方のまま） |
| 両方 | | cdp の規則 **かつ** circle の規則 |

- **cdp の規則**: (a) `weak = false` の閉じた周回で `pass_seq > coalesce(last_seen_pass, 0)` のものが 3 以上、(b) `last_seen_at <= now − 48h`。
- **circle の規則**: origin/main と同じ。最新の完全な Circle の snapshot（不完全なら、直前の完全な snapshot 以降の和）に鍵が無く、不在が証明できる（`loadSiblingListing` と同じ考え方）。circle だけの行は、消えた最初の完全な Circle の取得の日に閉じる。
- **(c) 上限**: その回で cdp の規則で閉じる件数（cdp だけ＋両方の候補）が、判定時点の active な cdp_bazaar の行（`activeCdpRows`）の 2% を超えたら、cdp の規則の行は 1 件も閉じず `capped = true`、`logServerErrorSafe(LOG_TAG_CLOSURE_CAP_EXCEEDED, …)`。circle だけの行は上限の対象外（origin/main どおり）。
- **閉じ方**: 候補は **行ロックを取らない普通の SELECT** で読む（`FOR UPDATE`・`SKIP LOCKED` を使わない）。閉じる回どうしを別のロック（advisory lock など）で直列にしない。重複を防ぐのは次の 1 文だけ:
  `WITH f AS (UPDATE x402_endpoints SET status = 'delisted', delisted_at = $now WHERE id = ANY($ids) AND status = 'active' RETURNING id) INSERT INTO x402_delisting_events (…) SELECT … FROM f RETURNING …`。
  イベントは RETURNING で返った行にだけ書く。`closedIds` と `eventsWritten` もその RETURNING から作る。
- 第1段: cdp に載る行は 1 件も閉じない（`candidates = 0`）。circle だけの行は origin/main のまま。
- 第1段の実装（2026-10-30）: circle だけの行の閉じ方は、origin/main のコードのまま `syncCatalog` の中に残し、`closeCatalogListings` へは寄せていない（寄せるのは第2段）。
  そのかわり `syncCatalog` の閉じる経路（snapshot の差分・兄弟の行を倒す分・日次の突き合わせ）の全部で「cdp に載る行」を外す
  （`isCdpListedRow` と `CDP_LISTED_ROW_SQL`。cdp_bazaar の同期が出す delisted は全部捨てる）。一度でもカーソルが見た行（`last_seen_pass` がある）は、第1段では閉じない。
- 第1段（点検 X1）: Circle の同期では cdp の兄弟を常に「不在が証明できない」として扱う（`absenceProven = false`）。強い周回の snapshot は
  読めないページ 5% までと並びのずれの読み落としを許すので「cdp に無い」の証明にならない。あわせて、Circle の同期は cdp が持ち主の行を
  Circle へ移さず、行がもう持っている cdp の accepts の slice を消さない。日次の突き合わせは cdp の不在の証明を待たずに走るが、
  閉じてよいのは cdp に載る印の無い行だけ（Circle だけの行の閉じ方を origin/main のまま保つため）。

T07・T08 はテストが対象の行の行ロックを持ち、2 本の閉じる回を両方とも上の UPDATE で待たせてから放す。上の 3 つの決まり（行ロックを取らない候補・直列にしない・RETURNING だけ）が守られていれば、決定的に 1 本だけが閉じる。

壊すべき部分:

| パッチ | 壊すところ |
|---|---|
| `T04.patch` | (a) の「3 回以上」を「1 回以上」にする |
| `T05.patch` | (a) が数える周回から `weak = false` の条件を外す（弱い周回も数える） |
| `T06.patch` | (a) を外し、(b)（最後に見えてから 48 時間）だけで閉じる |
| `T07-b.patch` | (b) を外す |
| `T07-events.patch` | イベントを RETURNING の行でなく、候補の id から書く（UPDATE は今のまま） |
| `T08.patch` | UPDATE の `AND status = 'active'` を外す |
| `T09.patch` | (c) の 2% の上限を外す |
| `T10.patch` | circle だけの行にも cdp の規則を当てる |
| `T11.patch` | 両方に載る行の「かつ」を「または」にする |

### 4.3 `syncCatalog(options)` の変更（catalog-sync.ts）

- `clock?: () => Date` を足す（既定 `() => new Date()`）。最後に `closeCatalogListings({ now: clock(), detectedOn: today })` を呼ぶ。
- Circle（`source = 'circle_discovery'`）の upsert・snapshot・relisted・settle_drop・別名は今のまま。閉じるのだけ 4.2 を通す。tests/observatory-sync.test.ts の Circle の期待は変えない。
- cdp_bazaar の取得は cron から `runCatalogCursorCall` に移る。`syncCatalog({ source: 'cdp_bazaar', fetchResult })` の snapshot の差分で cdp の行を閉じる経路は残さない（tests/observatory-sync.test.ts の、cdp の snapshot の差分で閉じることを期待する子テストは変わる。どれを「Circle のテスト」とみなすかは最終報告に挙げる）。
- MPP（`mpp_directory`）は今のまま。

### 4.3.1 周回を閉じたときの snapshot（第1段で決めた）

周回を閉じたら、その周回で見えた鍵（`last_seen_pass = その周回`）を `x402_catalog_snapshots` に 1 行書く（日付は閉じた時刻の UTC 日、
`total_count` は周回の total、`fetched_count` は見えた鍵の数、`complete` は強い周回なら true）。鍵の集合は DB の中で作る（10 万件を HTTP で運ばない）。
同じ日にもう完全な行があれば弱い周回で上書きしない。理由は 2 つ: 公開の `latestSnapshot` の件数を止めないため、Circle の同期が読む
「cdp がいま載せている鍵」（`loadSiblingListing`）を古いまま凍らせないため（凍ると、cdp が載せている行の持ち主を Circle が取り、cdp の accepts を外す）。

### 4.4 `checkCatalogPassFreshness({ now }): Promise<CatalogPassFreshness>`（catalog-cursor.ts）

- `lastStrongPassCompletedAt = x402_catalog_cursors.last_strong_pass_completed_at`。
- `stale = now − lastStrongPassCompletedAt >= 36h`。強い周回が一度も無いときは、カーソルの行の `created_at`（無ければ stale = false）から 36 時間で stale。
- stale のとき `logServerErrorSafe(LOG_TAG_PASS_STALE, …)` に出す（既存のアラートの経路）。

### 4.5 `getCdpBazaarIngestFreshness({ now? })` と `getObservatoryStats()`（reader.ts）

- `getCdpBazaarIngestFreshness` は 4.4 と同じ規則で `{ lastStrongPassAt: ISO | null, stale }` を返す（ログは出さない）。`now` の既定は `new Date()`。
- `getObservatoryStats()` は `cdpBazaarIngestStale = (await getCdpBazaarIngestFreshness()).stale` と `cdpBazaarLastStrongPassAt` を載せる。型の 2 つの欄は必須にする。`max(last_seen_at)` では判定しない。

壊すべき部分: `T12.patch` — 公開の鮮度の欄（`getCdpBazaarIngestFreshness` とそれを使う `getObservatoryStats`）を、active な cdp の行の `max(last_seen_at)` が 36 時間より古いかで判定する形に戻す。

### 4.6 L1（l1-runner.ts）

`l1TargetsSqlBuilders(ctx).targetsSql` の WHERE（pay_to と https の条件の並び）に
`AND (e.source <> 'cdp_bazaar' OR e.last_seen_at > now() - make_interval(hours => CDP_BAZAAR_L1_FRESH_HOURS))` を入れる（fix/catalog-sync-complete の l1-runner.ts の行と同じ）。L1 は実時計の SQL `now()` のまま（カーソルは本番で `clock = () => new Date()` なので一致する）。

壊すべき部分: `T13.patch` — この 1 行を消す。

### 4.7 通知（notify.ts）

`notifyDelistedEvents` は、送る前に `UPDATE x402_delisting_events SET notified = true … WHERE id = ANY($ids) AND notified = false RETURNING id` で **原子的に取り**、返った行だけを送る（2 本の呼び出しが同時に通知まで走っても webhook は 1 回）。T08 が確かめる（設計の 6 の「notify の予約」を原子的にしたもの）。

### 4.8 テストしない部分

- vercel.json の catalog-sync の式（設計の 3）・文言（llms.txt・methodology・docs の「約 2 時間おき」）・cron のルートが `runCatalogCursorCall` を呼ぶこと。設計の正典の完了条件（`node -e` での機械的な確かめ）に従う。

## 5. テスト（tests/catalog-staleness.pg.test.ts）

共通: `TEST_DATABASE_URL` が無ければ skip（`npm test` は skip 1 件）。各テストは最初に TRUNCATE。時計の起点は 2031-01-01（T12 だけ実時計の 42 時間前。`getObservatoryStats` が自分の時計で判定するため。効くのは差だけ）。
模擬の API は 1 要求ごとに clock を 1/3 秒進める（1 ページ 1 秒を並列 3 で）。429 は `Retry-After: 30`。

| テスト | 確かめること | 落とす実装の誤り |
|---|---|---|
| T01 | 100,800 件・1,008 ページを 200 秒の呼び出し 2〜3 回で 1 周、各呼び出しは前の続きから、全部の鍵が `last_seen_pass = 1` | 毎回 0 から読む・締切を clock で測らない |
| T02 | offset 1,000 以降の要求が返らないまま打ち切られても、読んだ 1,000 件と `next_offset = 1000` が残り、次の呼び出しは 1,000 から | 最後にまとめて保存する |
| T03 | 1 本目がページの途中で止まっている間の 2 本目は `{ skipped: "leased" }` で要求 0、取得は 5 ページだけ | lease を外す |
| T04 | 49 時間おきの周回で、2 周目だけ並びのずれで読み落とされた M は閉じない。消えた G は 4 周目で閉じる | (a) を 1 周にする |
| T05 | 3,000 件の page 20・21 が 90 件の日（2/30 = 6.7%）は弱い周回、その裏の 20 件は閉じない。読めた 5〜7 日目で G が閉じる | 弱い周回の判定を外す |
| T06 | 最後のページ（X を含む）が 429 の間、周回は閉じず `next_offset = 4900` のまま、X と最後のページの行は閉じない。その前に G は閉じる | (a) を時間だけにする |
| T07 | 2 時間おきの周回で、(a) を満たしても 46 時間までは閉じない。48 時間後に 2 本同時の閉じる回でちょうど 1 回だけ閉じ、イベント 1 行 | (b) を外す・イベントを候補から書く |
| T08 | 2 本同時の閉じる回でイベント 1 行、2 本同時の通知で webhook 1 回 | `AND status = 'active'` を外す |
| T09 | 30/1,000（3%）が候補の回は 1 件も閉じず `capped` とログ、15/1,000 の回は 15 件閉じる | 2% の上限を外す |
| T10 | Circle だけの Q は 2 日目（消えた最初の完全な取得の日）に閉じ、イベント 1 行 | circle だけの行に cdp の規則を当てる |
| T11 | 両方に載る P は cdp で 1 周欠け Circle から消えても閉じない。両方から消えた S は 4 日目、Circle だけの Q は 2 日目に閉じる | 「かつ」を「または」にする |
| T12 | 読めないページが 20% の弱い周回だけが続くと、+30h は古くない、+42h は見張りのアラートと公開の欄（`getCdpBazaarIngestFreshness`・`getObservatoryStats`）が古い。強い周回で戻る | 公開の欄を `max(last_seen_at)` に戻す |
| T13 | 37 時間前の cdp は候補に入らず、1 時間前の cdp・circle・mpp は入る | L1 の 36 時間の行を消す |
| T14 phase1 | 第1段だけ: cdp の Z は強い周回 10 回・240 時間見えなくても active、Circle だけの Q は 2 日目に閉じる | 第1段で cdp の行を閉じる |
| T15 phase1 | 第1段だけ（点検 X1）: 導入前から cdp が持つ共有の行 X は、周回で X のページだけ読めず（1/30・強い周回）、Circle が 1 日目に載せ 2 日目に外しても、持ち主は cdp のまま・cdp の slice も残り・active。同じ入力で Circle だけの Q は 2 日目に閉じる | Circle の同期で cdp の不在を証明済みとして扱う（持ち主の移動・slice の削除を戻す） |

## 6. 変異の確かめ（scripts/dev/mutation-check-catalog.sh）

```
eval "$(/Users/takeshi/vet402-orders/runs/setup_test_db.sh "$PWD" vet402_test_catalog5)"
bash scripts/dev/mutation-check-catalog.sh 1   # 第1段
bash scripts/dev/mutation-check-catalog.sh 2   # 第2段
```

- パッチの置き場と名前: `scripts/dev/mutation-patches-catalog/<ID>[-<名前>].patch`。第1段は `T01 T02 T03 T12 T13 T14 T15`（T14 は「第1段で cdp の行を閉じる」、T15 は「Circle の同期の cdp の守りを外す」）、第2段は `T01 T02 T03 T04 T05 T06 T07-b T07-events T08 T09 T10 T11 T12 T13`。名前の先頭 3 文字が回すテスト（`--test-name-pattern '^T07 '`）。
- **パッチの中身は実装者が書く**（実装ができるまで「どの行を壊すか」が決まらないため）。中身は上の「壊すべき部分」の表のとおり、1 パッチ 1 つの変更。`git diff` の形で、`git apply` で当たること。`tests/` と `scripts/dev/` を触るパッチはスクリプトが FAIL にする。
- スクリプトの判定: (0) 追跡ファイルに差分があれば FAIL。(a) パッチなしで対象のテストが全部通らなければ FAIL で止まる。(b) パッチを 1 つずつ当て、そのテストだけを回す。(c) その ID のテストが 1 件以上走り、そのうち **assert で落ちた（`ERR_ASSERTION`）** ものが 1 件以上なら PASS。0 件・読み込みや構文の失敗・not implemented や SQL の例外だけで落ちた・全部通った は FAIL（パッチは振る舞いを変えるもので、テストを読み込めなくするものではない）。(d) 戻して `git diff --exit-code`。全部 PASS のときだけ終了コード 0。
- `ONLY="T03 T13"` で一部だけ回せる（手元の確かめ用。合格の判定には全部を回す）。

## 7. 設計の正典との食い違い・決めたこと

1. **T05 の入力**: 正典の R2 の形（3,000 件の page 20 だけが 90 件）は 1/30 = 3.3% で、5% の規則では弱い周回にならない。テストは page 20 と 21 を短くして 6.7% にした。
   その裏に **設計の穴** がある: 5% 以下の読めないページ（短いページ・再試行切れ）が毎周同じ場所に出ると、その裏の生きている出品は強い周回 3 回と 48 時間で閉じる（件数が 2% 以下なら上限も止めない）。並びが毎日変わるので本番で同じ出品が隠れ続けるとは限らないが、模擬では起きる。直し方（短いページは受け取った件数の先から読み直す・途中の短いページがある周回は弱くする など）はオーナーの判断で、このテストは 5% の規則のまま書いた。
2. **lease の時計**: 正典は `now() + interval '290 seconds'`。テストを時計で進めるため、差し込んだ clock の値で比べる（1 文の UPDATE で原子的なのは同じ）。
3. **公開の鮮度の欄**: 正典は「reader.ts の cdpBazaarIngestStale」と書くが、origin/main の reader.ts にその欄は無い（fix/catalog-sync-complete にだけある）。新しく足す。判定は「最後に閉じた **強い** 周回」（`last_pass_completed_at` は弱い周回でも更新されるので、それでは 36 時間の見張りと一致しない）。
4. **閉じる処理のトランザクション**: 正典の 6 は古い枝の部品（`db.transaction`）を使ってよいとするが、本番の neon-http は複数文のトランザクションを持たない。1 文のデータ変更 CTE にする。テスト（postgres-js）はこの違いを見分けられない。
5. **webhook は 1 回**: 2 本の呼び出しがそれぞれ通知まで走ると、origin/main の `notifyDelistedEvents` は同じイベントを 2 回送る。4.7 の原子的な取り方を足した（正典に無い変更）。
6. **429 の扱い**: 正典は「429 で諦めたページは数えて周回を止めない」。締切の途中で諦めたページも飛ばすと、T06 の「429 が続いて周回が閉じない」にならず、1 ページだけの 429 は弱い周回にもならない（1 の穴と同じ）。締切で諦めたページは失敗に数えずカーソルを残す、と決めた。
7. **T07 の「イベントを候補から書く」**: 1 本ずつ走らせると RETURNING と候補は同じになり、この変異は落ちない。T07 は 48 時間の時点の閉じる回を 2 本同時（行ロックで UPDATE に揃える）にした。
8. **X1 の形**: 再現のファイル（catalog-review4-repro.pg.test.ts）に X1 は無い。T10 は R1c の形で書いた。
9. **tests/observatory-sync.test.ts**: 子テストの多くは cdp の snapshot の差分で閉じることを期待している（例: day 2 の svc2 の delisted、CDP と Circle の共有行の突き合わせ）。どれが「Circle のテスト」かは正典に定義が無い。第1段で cdp の行を閉じるのを止めると、cdp 側の期待は変わる。

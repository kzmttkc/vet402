# 申し送り台帳（グラント戦略 → vet402.com コア開発）

**使い方**: vet402 に対して実装・変更を行ったら、**その都度この先頭に1エントリ追記して push する**。
1エントリは「日時 / 何を変えたか / なぜ / そちらが知っておくべき影響」の4点＋コミットハッシュ。
深い背景が要るときだけ `docs/handoffs/YYYY-MM-DD-*.md` を別に書き、ここから1行で指す。

**なぜこの形か**: グラント戦略セッションから他セッションへ直接メッセージを送る手段が無い（ツールが無い）。
ファイル追記と push が唯一の経路。2026-09-05 Takeshi 指示「実装や変更を実施したら随時申し送りして共有する」。

**対象**: 申請文書・公開面（`/demo` 等）・計器（`grant-figures.py`）・監視（カナリア/窓口監視）・cron・
WORK_ORDERS への発注。読むだけの調査は対象外。`docs/applications/` はそちらが触らない領域だが、
**数字や主張が変わったら書く**——そちらの実測と食い違えば、そちらが気づける。

---

## 2026-09-11 14:58 JST — 審査日（09-14）に読むと偽になる現在形を、日付つきの過去形に直した（`/ethonline` の表示文言を含む）: `src/app/ethonline/page.tsx` の Bazantic 段落「$0 routes still answer 402」→「On 2026-09-06, $0 routes answered 402 … On 2026-09-09 and 2026-09-11 the free tools I checked answered without a 402」、`docs/ethonline-2026/BAZANTIC_FEEDBACK.md` §4 #1〜#3 と §6 の now/still/today。根拠は 09-11 05:41Z の probe（v1 で使った 12 ツールに未払い tools/call、402 は 0 件）。57 ツール中 12 本しか見ていないので「全ルートで直った」とは書いていない。数字・URL・コードは不変。`LIVE_JUDGING.md` は別の役が編集中のため未変更

## 2026-09-11 14:40 JST — 【訂正】09-09 15:00 の節「§4 運用の申し送り (a)」の2項目。台帳の日次控えは Takeshi の手番ではなかった（剪定の失敗を非致命にして状態更新と警報を復旧・Takeshi_Automation `f5992c2`）。launchd の 60 分遅れは原因を特定して修正済み

- **変えたもの**: Takeshi_Automation の `scripts/vet402_ledger_snapshot.py` だけ（ブランチ `kabau-trust-board`・`f5992c2`、テスト `tests/test_vet402_ledger_snapshot_prune.py`）。iCloud Drive の古い控えの剪定（`prune()` の `os.listdir`）が `PermissionError` を投げても、それをつかまえて `state/vet402_ledger_snapshot.json` の `prune_errors` とログに理由を残し、先へ進む。警報と終了コードは変えない。**vet402 のコード・本番 env・DB は何も変えていない**（このジョブは本番 DB の公開表を COPY で読むだけ）
- **09-09 の (a) 1項目めの訂正**: 「Full Disk Access か保存先の変更が要る——Takeshi の手番」は取り下げる。執行部の方針として、**フルディスクアクセスは付けない。保存先（iCloud Drive＝端末外の控え）も変えない**。launchd からでも iCloud への複製（copytree）は通っていて、落ちていたのは複製の後の剪定だけだった
- **影響（09-09 の節に書かれていなかったこと）**: 09-09 の節は「台帳の写しは取れている」と書いた。写しは確かに毎日取れていた。ただ、例外が出ていたのは状態ファイルの書き込みと警報より**前**の段だった。そのため **09-06〜09-11 05:20 の 6 回は、前日との sha256 突合（改ざんの検知）と行数 5% 超減（削除の検知）の警報を出せない状態だった**。状態ファイルは 09-05 08:03 のまま止まり、ログには Traceback が 6 件ある
- **復旧の実測**: `launchctl kickstart gui/501/com.kizuna.vet402-ledger-snapshot` を 09-11 14:20 JST に 1 回だけ実行 → `last exit code = 0`。ログは `剪定失敗 [icloud] PermissionError(errno=1) Operation not permitted` と `OK 2026-09-11: 8 表 + settlements 日次集約 39 行 / gz 合計 14.7 MB / 連鎖 1 日 / iCloud 済 / 剪定失敗 icloud` の 2 行。状態ファイルは `taken_at 2026-09-11T14:20:14+09:00`、09-10 の控えとの突合 `prev_integrity_problems=[]`・`row_drops=[]`・`errors=[]`
- **残っていること**: iCloud 側の剪定は止まったまま（最古の控えは 09-05。30 日の保持を超えるのは 10 月上旬から）。どう消すかは未決で、削除の試行もしていない。`chain_length` は、09-06〜09-11 の manifest に書き戻しが入らなかったので 1 から数え直しになった（`prev_manifest_sha256` によるハッシュ連鎖は切れていない）
- **09-09 の (a) 2項目め「launchd が 60 分遅れて走る」**: 09-11 13:36 JST に原因を特定して直した。UserEventAgent (Aqua) が 08-26 の UTC+8 を保持し続けていた。Takeshi_Automation `5130496`（09:09・実際の発火の痕跡からずれを検知）、`7724fff`（13:44・UserEventAgent (Aqua) を再起動し、発火ずれ 0 を実測）

## 2026-09-11 14:xx JST — ライブデモと MCP ツール説明の表示文字列から we/our を外した（オーナー指示・ソロ参加）: `examples/ethonline-2026-demo/src/assess.ts`「a verdict we could not read」→「the gate could not read」・`src/render.ts`「our own request shape」→「vet402's own request shape」（テスト期待値も同じ変更）・`packages/mcp-server/src/index.ts` の `l1_inconclusive` 説明と `evidence.source` の describe。判定・理由コード・数値・JSON キーは不変。本番 API の `src/lib/observatory/vocabulary.ts:146,192` の we/our は未変更

## 2026-09-11 13:58 JST — 審査員が読む英文の一人称を we/our/us → I/my に統一（オーナー指示 09-11 13:35〜13:47）。`/ethonline` の表示文言を含む。人がしたこと＝I、システムが自動でしていること＝vet402/it/the gate。数字・URL・コードは不変。README 見出し "what is ours" は `/ethonline` のアンカーURLを保つため据え置き

## 2026-09-11 12:0x JST — 【訂正】06:4x の節（`d60d73c`「上流RPCではなく日次 cron ののこぎり波」）は**実測で説明しきれない**。原因は未確定

- **変えたもの**: この節だけ。**本番の env・cron・コード・DB は何も変えていない**（本番DBは読み取りのみ。`indexer_checkpoints`・`job_leases` を1本ずつ、`health_snapshots` 09-07 00:00Z 以降 1,088 行の書き出し1本）
- **なぜ書くか**: 06:4x の節を読んで対策に着手すると、原因を外したまま fail-closed を弱めうる。元の節は書き換えず、ここで訂正する
- **対策は保留**: **「cron の頻度を上げる」「`TAIL_SCAN_DEADLINE_MS` を延ばす」「`GET_LOGS_CHUNK_BLOCKS` を変える」は、原因が確定するまで着手しない**（06:4x §4 の順序も保留）

### 1. 合っていた前提 —— 走査の起点は checkpoint

- 起点は `src/lib/chain/erc8004.ts:350` の `plan.index.checkpoint + 1n`（→ `latestBlock`）。checkpoint は `src/lib/db/feedback-index.ts:48` が
  `indexer_checkpoints.reputation_registry_feedback` を**リクエストのたびに DB から直接**読む（`src/lib/db/owner-index.ts:43`・キャッシュ無し）。gap の計算は `src/lib/chain/feedback-window.ts:209`
- 走査が gap とともに重くなることも実測と合う。**時計の時刻がほぼ同じで gap だけが違う**、cron の前後を比べると:

| 窓（UTC・09-08 09:51Z〜09-11 02:46Z の理由付き行） | gap（ブロック） | `getLogsChunked` 行 | scoring=ok 行 | ok fresh の latency p90 |
|---|---|---|---|---|
| 00:00–02:25 | 39.7k–43.2k | 27 | 54 | 2,509ms |
| 02:25–05:00 | 0–4.6k | **0** | 60 | 671ms |

  gap 帯で見ても、25,200 ブロック未満は `getLogsChunked` 3 行 / ok 326 行、以上は 121 行 / 228 行

### 2. 合わなかった前提

1. **checkpoint が進む時刻は 02:00 UTC ではなく 02:25 UTC。** 09-10 と 09-11 の run が読んだ tip（`last_block` = `chain_tip_at_run`）のブロック時刻は、
   Base 公開 RPC の `eth_getBlockByNumber` で**どちらも 02:25:01 UTC**（51108877 / 51152077。差は 43,200 ブロック＝ちょうど 24 時間）。`updated_at` は 02:25:06 / 02:25:08
2. **09-11 の劣化は checkpoint が進む前に止んだ。** 最後の degraded は 02:08:10。次の 02:15:50・02:23:31 は ok（scoring=ok fresh・latency 1,926 / 2,359ms）で、
   **この 2 行は1日で最も gap が広い時点**（42,924 / 43,155 ブロック）。09-10 も 02:00–02:17 の 3 行は gap 42.4k–43.0k で全て ok（2,297–2,494ms）
3. **gap が同じでも日によって走査の重さが違う。** gap ≈32.5k（20 時台 UTC）の ok 行（latency 300ms 以上＝エンジンのキャッシュに当たらず走査した行）の中央値:
   09-08 **789ms**（n=5）／09-09 **2,207ms**（n=5）／09-10 **1,452ms**（n=3）。この間、走査経路（`chunked-logs.ts`・`erc8004.ts`・`feedback-window.ts`・`client.ts`・`engine.ts`）へのコミットは
   `64a6eb2`（09-08 18:08Z・理由名を付けただけ）しかない。env の変更の有無は【未確認】
4. **「上流 RPC ではない」とは言えない。degraded の大半は、2.5 秒を使い切る前に落ちている。**
   理由付きの fresh 行 95 行のうち **90 行で health 全体の `latency_ms` が 2,500 未満**（うち 32 行は 2,000 未満。最小 1,285）。
   `latency_ms` は `src/lib/health/liveness.ts:81` で両プローブより前から測っているので、走査の経過時間はこれより短い。
   壁時計の締切（`throwIfExpired`・`src/lib/chain/chunked-logs.ts:246` / `:350`）は残りが 0ms になるまで投げない。
   **締切より前に同じ `DeadlineExceededError("getLogsChunked")` を投げる経路は `chunked-logs.ts:260` だけ**で、これは RPC がレート制限（429 など）を返し、
   次の待ち時間（800ms × 2^n）が残り予算に収まらないときの分岐。`classifyDegradation`（`src/lib/health/probe-detail.ts:77`）はどちらも
   `deadline:getLogsChunked` に丸めて `budgetMs` を捨てるので、detail の文字列だけでは区別できない
   → 【推定】少なくともこの 90 行には RPC のレート制限応答が関わっている。§4-1 のログを見るまで確定とは書かない

### 3. 候補ごとの判定

| 候補 | 当てた実測 | 判定 |
|---|---|---|
| 走査ブロック数（gap） | cron 前後で `getLogsChunked` 27→0 行・ok の p90 2,509→671ms。gap 25,200 未満 3 行／以上 121 行 | 合う（強い条件） |
| gap だけで決まる／checkpoint の前進で止む | 09-11 02:15:50・02:23:31 は gap 最大で ok、前進は 02:25:01。gap ≈32.5k で中央値 789 / 2,207 / 1,452ms | 合わない |
| 時刻帯 18:00–01:59 UTC | cron が毎日 02:25:01 固定なので gap と完全に共線。分けられるのは 02:00–02:25 の窓だけで、そこは ok 11 行（うち 6 行はキャッシュ当たり）/ degraded 4 行 | 判定できない |
| RPC の応答（レート制限） | 理由付き fresh 95 行中 90 行が全体 latency 2,500ms 未満。締切前に同じエラーを投げるのは `chunked-logs.ts:260` だけ | 合う【推定】（ログ未確認） |
| 同時に走る他の cron | `vercel.json`: 18:00–01:59 に入るのは `catalog-sync`（01:00）だけ。GitHub Actions: `uptime`（*/10）は終日、`skill-live` は 23:00 | 合わない |
| Vercel のコールドスタート | 09-08 09:51Z 以降で 319 インスタンス。18:00–01:59 でインスタンス初回行の degraded 56/128（44%）、2 行目以降 60/165（36%） | 弱い（主因ではない） |

### 4. 結論と次に測るもの

**結論: 06:4x の説では説明できない。原因は未確定。** 最有力の候補は「tail 走査のチャンク数（gap に比例）× RPC のレート制限応答」。
gap は悪化の強い条件だが、gap だけでは ok / degraded は決まらない。checkpoint の前進は 09-11 の回復の原因ではない。
時刻帯（18–02 UTC）は gap と分けられないので、時刻が原因とも、時刻は無関係とも言えない。

次に測るもの（どれも読み取りだけ。本番は変えない）:
1. 18:00–02:25 UTC の間に Vercel の実行ログから `[chunked-logs] rate-limited`（`chunked-logs.ts:264`）と `non-range failure`（`:278`）の行を数え、degraded 行の時刻と並べる。どちらの行も現行コードがすでに出している
2. 本番 env の `INDEXER_RPC_URL`・`BASE_RPC_URL`・`GET_LOGS_CHUNK_BLOCKS` について、**設定があるかどうかと提供元のホスト名だけ**を見る（値は出さない）。あわせて、その提供元のレート上限と、同じ鍵を使う他の経路
3. 会期後（09-15 以降）の計器案: detail に `budgetMs` を残す（2500 なら壁時計切れ、800 / 1600 / … ならレート制限の分岐）。コード変更なので**ここでは決めない**

- **そちらへの影響**: 06:4x の §1 のうち「必ず期限切れになる」「上流が遅くなった必要はない」と、§3–4 の対策の順序は、この節で保留にする。
  §2（`detail` 列ができる前の行を 0 件と数えない）はそのまま有効
- **触っていない**: `docs/ethonline-2026/LIVE_JUDGING.md`・`WINDOW_PLAN.md` には、のこぎり波の説も `index-feedback` も書かれていない（grep `saw-tooth`・`sawtooth`・`のこぎり`・`index-feedback` で 0 件）。
  `docs/ethonline-2026/PROMPTS/2026-09-11-day7-health-sawtooth.md` の要約行はその日の記録なので書き換えない

---

## 2026-09-11 10:xx JST — 審査員条件の再走で見つかった文書の食い違い4件を直した（`/ethonline` の1段落を含む）

- **変えたもの**: `SKILL.md`・`examples/ethonline-2026-demo/README.md`・`src/app/ethonline/page.tsx`（1段落の文言のみ）・`scripts/refresh-numbers.json` と印4文書（テスト件数）・`.github/workflows/skill-live.yml`（コメントのみ）。コード・env・DB・決済経路（`*payer*`・`x402-pay.ts`・`pay-or-refuse.ts`・署名器）は無変更
- **なぜ**: 新しい clone（`c39f4a3`・鍵なし／GRAPH 鍵だけ）で README・SKILL.md・WINDOW_PLAN §359 を書いてあるとおりに打つと、次の4点で詰まった
  1. `SKILL.md` の `pay_if_trusted` 2ブロックは `$THROWAWAY_KEY` がどこにも定義されておらず、`payer_not_configured` で止まって期待式が false になった → ブロックの中で `npm install --no-save viem@2.56.3` を実行し、資金の無い鍵を `generatePrivateKey()` でその場で生成するようにした（値は印字しない）。**署名は発生しない**: `viem/accounts` と `fetch` を包む preload で実測し、2ブロック×（GRAPH のみ／GRAPH+VOUCH）で `signTypedData` 0回・支払いヘッダ 0件。同じ preload は対照スクリプトで署名とヘッダを捕まえた
  2. テスト件数 748 / 1615 → **780 / 1679**（`refresh-numbers --refresh --only sdk_tests --only mcp_tests`・as_of は動かしていない）
  3. `pay` は GRAPH 鍵だけだと `verdict not read` になり、「REFUSE を予測」と出る（VOUCH を足すと `WARN (68)` を免除して「sign を予測」。09-11 に dry run で両方を実測）。`/ethonline` と demo README に1行ずつ書いた
  4. 本番の `refuse` は `l1_inconclusive`（09-08 のサーバ語彙追加以降）。demo README の「never bought」と SKILL.md の出力例 `l1_not_attempted` を、09-11 の本番出力に合わせた（09-08 以前の記録文書・PROMPTS は触っていない）
- **そちらへの影響**: `/ethonline` の「Run it yourself」節に3行増える。skill-live CI の挙動は変わらない（2ブロックは `needs VOUCH_API_KEY,GRAPH_API_KEY` のままで、CI は VOUCH を渡さないので skip）。テスト件数を recorded から derive にするのは見送った: `--check` はほかのセッションの push 経路でも走り、パッケージを install していない環境では赤になるため

## 2026-09-11 09:xx JST — Dependabot 12件のうち、非破壊で直せる3件（js-yaml・browserslist・baseline-browser-mapping）を lockfile だけで上げた

- **変えたもの**: `package-lock.json` のみ。`package.json`・`overrides`・コード・env・DB は無変更。`npm update js-yaml browserslist baseline-browser-mapping` で動いた7パッケージは、すべて親の semver 範囲内（メジャー上げ0）
  - dev（eslint 経由）: js-yaml 4.3.1→4.3.2 / browserslist 4.28.6→4.28.9 / update-browserslist-db 1.2.3→1.3.3 / electron-to-chromium 1.5.389→1.5.427 / node-releases 2.0.51→2.0.55
  - 本番依存（next がビルド時に読むブラウザ対応表のデータ）: baseline-browser-mapping 2.10.43→2.11.22 / caniuse-lite 1.0.30001805→1.0.30001810
- **触っていない決済経路**: `src/lib/observatory/*payer*`・`packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・署名器、`packages/sdk` の lockfile。
  `@solana/web3.js`→jayson が引く stream-json 1.9.1・uuid 8.3.2 は**上げていない**（パッチ版 3.5.0・11.1.1 は jayson の範囲 `^1.9.1`・`^8.3.2` の外。上げると Solana payer の RPC クライアントの実行時が変わる）
- **本番ビルドで確かめたこと**: 同じ worktree で上げる前と後に `next build` を1回ずつ走らせ、`.next/server` を比べた。
  payer 系（`sol402` / `x402-payer` / `pay-or-refuse`）を含むチャンク4本はバイト一致。差が出た13ファイルは build ID・server action の暗号鍵と ID・その ID を含むクライアントチャンク名だけ（ビルドのたびに変わる値。ID を伏せると一致）
- **直していない9件**: esbuild 0.18.20（drizzle-kit→@esbuild-kit/core-utils `~0.18.20`、パッチは 0.25＝破壊的。dev のみ・serve 未使用）/ bigint-buffer（パッチ無し。devDependency の @solana/spl-token からだけ引かれ、本番コードは 09-07 に `spl-token-lite.ts` へ置換済み）/ stream-json・uuid（上記）/ examples/langchain-tool の langsmith ×4・uuid（@langchain/core 0.3.80 の `^0.3.67`・`^10.0.0` の外。直すには @langchain/core 1.x へのメジャー上げが要る）
- **npm audit**: root `--omit=dev` 5→4（high 0→0）／root 全体 16（high 5）→13（high 3）／examples/langchain-tool 3→3
- **そちらへの影響**: 想定なし。クライアントのブラウザ対応表データが新しくなるだけ

## 2026-09-11 06:4x JST — `/api/health` の `feedback_stats_unavailable(deadline:getLogsChunked)` は**上流RPCの劣化ではなく、日次 cron と tail 走査の設計から出る「のこぎり波」**だった（発注の因果を実測で訂正）

- **変えたもの**: **本番は何も変えていない。** この節だけ。env・cron・コード・DB いずれも未変更（本番DBは読み取りのみ）
- **なぜ書くか**: 執行部がこの degraded を「上流 RPC が遅くなった」として WORK_ORDERS に載せかけた。
  実測すると因果が違い、**その誤りの半分は計器の若さを事象の不在と読んだこと**だった。
  そちらが同じ読み違いをしないよう、因果と計器の初出の両方を残す

### 1. 実測した因果 —— 日次ののこぎり波

`(deadline:getLogsChunked)` を持つ行は **85 件**、UTC の時刻で露骨に偏る。

```sql
SELECT to_char(checked_at AT TIME ZONE 'UTC','MM-DD') AS d,
       to_char(checked_at AT TIME ZONE 'UTC','HH24') AS h, count(*) AS n
FROM health_snapshots
WHERE detail LIKE '%feedback_stats_unavailable(deadline:getLogsChunked)%'
GROUP BY 1,2 ORDER BY 1,2;
```
```
   d   | h  | n
-------+----+----
 09-09 | 17 |  1
 09-09 | 18 |  8
 09-09 | 19 |  3
 09-09 | 20 |  6
 09-09 | 21 |  8
 09-09 | 22 |  8
 09-09 | 23 | 11
 09-10 | 00 |  4
 09-10 | 01 |  3
 09-10 | 10 |  1
 09-10 | 14 |  2
 09-10 | 18 | 10
 09-10 | 19 |  6
 09-10 | 20 |  6
 09-10 | 21 |  8
```

**18:00–01:59 UTC に 85 件中 81 件（95.3%）。02:00–09:59 UTC は 2 日とも 0 件。**
残る 4 件は 17 時台 1・10 時台 1・14 時台 2 で、いずれも単発。

止む時刻が答えを持っている。`vercel.json`:

```json
{ "path": "/api/cron/index-feedback", "schedule": "0 2 * * *" }
```

**索引は 1 日 1 回しか進まない。** だからリクエスト経路に残った唯一のチェーン走査
（checkpoint → tip の tail 走査）の幅 `tip − checkpoint` が、**02:00 UTC から翌 02:00 UTC まで単調に開き続ける**。

本番の checkpoint（読み取りのみ）:

```sql
SELECT scope, last_block, updated_at FROM indexer_checkpoints
WHERE scope = 'reputation_registry_feedback';
```
```
            scope             | last_block |          updated_at
------------------------------+------------+----------------------------
 reputation_registry_feedback |   51108877 | 2026-09-10 02:25:06.733+00
```

この checkpoint に対する **2026-09-10 21:3x UTC 時点**の Base tip（公開 RPC `https://mainnet.base.org` / `eth_blockNumber`）:

```
base tip:   51143394
checkpoint: 51108877
gap blocks: 34517      → 2s/block で 19.2 時間ぶん
chunks @ GET_LOGS_CHUNK_BLOCKS=2000: 18
round-trips @ TAIL_SCAN_CONCURRENCY=2: 9
TAIL_SCAN_DEADLINE_MS 2500 ÷ 9 = 1 往復あたり 278ms
```

**1 往復 278ms を切れなければ必ず期限切れになる。** 上流が「遅くなった」必要はない。
Neon リージョン → RPC の往復は平常時でも 150–300ms（`src/lib/chain/chunked-logs.ts` のコメントが
オーナー索引で実測した値）なので、**夕方以降の gap ではこの予算は設計上ほぼ確実に割れる**。

そして逃げ道が塞がっている。`FEEDBACK_TAIL_MAX_DAYS = 2`（`src/lib/chain/feedback-window.ts:45`）＝
Base で 86,400 ブロック。gap 34,517 はその内側なので `index_behind_tip`（走査を諦めて素直に unavailable を返す枝）
には落ちず、**必ず走査に入り、必ず期限切れになる**。

→ **RPC 提供元より先に見るべきは `GET_LOGS_CHUNK_BLOCKS`（既定 2,000・`liveScanChunkBlocks()` の上限 10,000）と
cron 間隔。** 本番の RPC 実提供元は依然【未確認】（Vercel が値を隠す）。

### 2. 「計器が見ていなかった」——こちらが本題の半分

この degraded は昨日今日始まったものではない。**名前を書ける状態になったのが昨日**だった。

```sql
SELECT
  (SELECT min(checked_at AT TIME ZONE 'UTC') FROM health_snapshots WHERE detail IS NOT NULL) AS detail_first,
  (SELECT count(*) FROM health_snapshots WHERE detail IS NULL) AS detail_null_rows,
  (SELECT min(checked_at AT TIME ZONE 'UTC') FROM health_snapshots
     WHERE detail LIKE '%feedback_stats_unavailable%') AS flag_first,
  (SELECT min(checked_at AT TIME ZONE 'UTC') FROM health_snapshots
     WHERE detail ~ '\(deadline:[a-zA-Z_]+\)') AS route_name_first,
  (SELECT min(checked_at AT TIME ZONE 'UTC') FROM health_snapshots
     WHERE detail LIKE '%(deadline:getLogsChunked)%') AS this_route_first,
  (SELECT min(checked_at AT TIME ZONE 'UTC') FROM health_snapshots WHERE status='degraded') AS degraded_first;
```
```
        detail_first        | detail_null_rows |         flag_first         |      route_name_first      |      this_route_first      |       degraded_first
----------------------------+------------------+----------------------------+----------------------------+----------------------------+----------------------------
 2026-09-08 09:51:07.726615 |             2303 | 2026-09-08 16:30:38.582726 | 2026-09-08 23:20:40.469432 | 2026-09-09 17:59:28.816907 | 2026-08-18 23:52:58.947973
```

- `detail` 列が値を持ち始めたのは **2026-09-08 09:51:07 UTC**。**それ以前の 2,303 行は全て NULL**
- flag 名（`feedback_stats_unavailable`）の初出は **2026-09-08 16:30:38 UTC**
- 経路名（`(deadline:...)` の形）の初出は **2026-09-08 23:20:40 UTC**（中身は `wallet_metrics` の方）
- **この経路名 `(deadline:getLogsChunked)` の初出は 2026-09-09 17:59:28 UTC**

一方 degraded 自体は **2026-08-18 から出ていた**:

```sql
SELECT to_char(checked_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day,
       count(*) FILTER (WHERE status='degraded') AS deg, count(*) AS total
FROM health_snapshots WHERE checked_at >= '2026-08-15Z' GROUP BY 1 ORDER BY 1;
```
```
  utc_day   | deg | total
------------+-----+-------
 2026-08-15 |   0 |    34
 2026-08-16 |   0 |   238
 2026-08-17 |   0 |   159
 2026-08-18 |   1 |   160
 2026-08-19 |   0 |    17
 2026-08-20 |   0 |    62
 2026-08-21 |   0 |     8
 2026-08-22 |   0 |    30
 2026-08-23 |   1 |    55
 2026-08-24 |   2 |    59
 2026-08-25 |   0 |    29
 2026-08-26 |   7 |   102
 2026-08-27 |   5 |    69
 2026-08-28 |   0 |    49
 2026-08-29 |   1 |    47
 2026-08-30 |   0 |    70
 2026-08-31 |   0 |    75
 2026-09-01 |   0 |    80
 2026-09-02 |  11 |   211
 2026-09-03 |   2 |    54
 2026-09-04 |   3 |   169
 2026-09-05 |   0 |    73
 2026-09-06 |   0 |    55
 2026-09-07 |  15 |   278
 2026-09-08 |  18 |   327
 2026-09-09 |  45 |   258
 2026-09-10 |  42 |   171
```

**08-26 に 7 件、09-02 に 11 件、09-07 に 15 件。**
その全てが `detail IS NULL`＝**何が壊れたのか一行も残っていない**。
09-09 の 45 件は「急に増えた」のではなく、**そこで初めて名前がついた**と読むのが正しい。

「名前を書ける状態で、かつ清潔だった窓」は次のとおり短い。経路名が書けるようになった
09-08 23:20:40 UTC 以降で、最後の非 `getLogsChunked` degraded は 09-08 23:36:38 UTC、
次の degraded は 09-09 17:59:28 UTC。**その間 18.4 時間だけが「名前を書ける計器が緑を出していた」窓**
（この 18.4 時間、計器は止まっていない——09-09 だけで 258 行を書いている）。

```sql
SELECT checked_at AT TIME ZONE 'UTC' AS utc, status, left(detail,95)
FROM health_snapshots
WHERE checked_at >= '2026-09-08 23:00Z' AND checked_at < '2026-09-09 18:05Z' AND status <> 'ok'
ORDER BY checked_at;
```
```
            utc             |  status  |                                             left
----------------------------+----------+-----------------------------------------------------------------------------------------------
 2026-09-08 23:20:40.469432 | degraded | scoring=degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok fresh
 2026-09-08 23:34:42.816479 | degraded | scoring=degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok fresh
 2026-09-08 23:36:38.623331 | degraded | scoring=degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok cached
 2026-09-09 17:59:28.816907 | degraded | scoring=degraded fresh: feedback_stats_unavailable(deadline:getLogsChunked); payee=ok cached
 2026-09-09 18:00:01.20698  | degraded | scoring=degraded cached: feedback_stats_unavailable(deadline:getLogsChunked); payee=ok cached
```

> **【訂正】** 執行部が先に流していた「清潔だった窓は 09-09 06:25→17:59 UTC の 11.6 時間」は、
> `health_snapshots` から再現できなかった。06:25 に相当する行・デプロイ境界・欠測のいずれも無い
> （09-09 05 時台 12 行・06 時台 12 行で連続）。**採るのは 18.4 時間の方**。

**教訓（`state/ALERTS.md` にも他の計器にも当てはまる）**:
**新しい計器の `count(*) = 0` は「起きていない」ではなく「見えていなかった」。
計器の初出時刻を必ず併記する。**

### 3. 会期中の決定 —— **2026-09-15 まで本番の env・cron・締切値・RPC を触らない**

- (a) 締切値（`TAIL_SCAN_DEADLINE_MS`）を上げるのは **fail-closed を弱める**方向。判定の中核なので会期中に動かさない
- (b) `GET_LOGS_CHUNK_BLOCKS` を上げるのは env 変更だけで可逆だが、**スコアリングの読み経路の挙動が変わる**。
  会期中に測り直す余裕がない
- (c) cron の高頻度化は **Hobby プランだとデプロイが静かに失敗し続ける既知の罠**（日次を超える頻度）。
  **プランの確認が先**
- (d) health に出さない（隠す）のは論外

### 4. 会期後（09-15 以降）の材料 —— **ここでは決めない**

1. まず `GET_LOGS_CHUNK_BLOCKS` を 2,000 → 大きく（`liveScanChunkBlocks()` の上限 10,000）して**往復数を測る**。
   env 変更のみ・可逆。ただし `src/lib/chain/erc8004.ts:190-198` に
   「10,000 は提供元が block-range で拒み、全 chunk が二分割されて逆に増えた」という**実測の記録**がある。
   上げるなら 10,000 ではなく中間値から
2. cron 間隔を上げる（**プランの確認が先**・(c)）
3. `FEEDBACK_TAIL_MAX_DAYS`（2 日）と `TAIL_SCAN_DEADLINE_MS`（2,500ms）の関係を見直す。
   **`TAIL_SCAN_DEADLINE_MS` を動かすなら判定への影響を先に測る**——
   `src/lib/scoring/verdict.ts:75` で risk="high"、`src/lib/scoring/helpers.ts:364` で score −15
4. RPC 提供元の確認は**その後**（本番の実提供元は【未確認】）

### 5. 会期の提出物への影響 —— **無い**

- `/api/health` は **`/ethonline` からリンクされていない**（`grep -n health src/app/ethonline/page.tsx` → 0 行）。
  **`SKILL.md` にも記載が無い**（`health` の唯一のヒットは 602 行目の "on a healthy run" という散文）
- 決済関門の判定 2 面（SDK が叩く `/resources/{id}/decision`・`/payees/{addr}/score`）は
  **DB 由来の別の脚**を読む。この degraded の到達 0 件
- 帯（18:00–01:00 UTC）に対し、**ライブ審査 09-14 16:00 UTC は帯の外**。
  Round 1 09-13 19:00 UTC は帯の中だが**非同期審査**（審査員が画面の前に座る時間ではない）

**ただし放置してよいという意味ではない。** 直近 48 時間の ok 率:

```sql
SELECT count(*) AS rows_48h, count(*) FILTER (WHERE status='ok') AS ok,
       round(100.0*count(*) FILTER (WHERE status='ok')/count(*),1) AS ok_pct
FROM health_snapshots WHERE checked_at >= now() - interval '48 hours';
```
```
 rows_48h | ok  | ok_pct
----------+-----+--------
      468 | 378 |   80.8
```

**製品としては 48h ok 率 80.8%。**（執行部が先に流した 81.7% は数時間前の値。分母が動く指標なので、
引用するときは取得時刻を添えてほしい）

### 6. 進行中の検証

執行部が「cron 起因なら **02:00 UTC 直後に止む**」という予測を仕掛けた（**2026-09-11 02:30 UTC 判定**）。
上の 09-10 のデータは既にその形（02–09 時台 0 件）だが、**同じ形が翌日も出るか**を独立に見る。
**結果が出たらこの節に追記する。**

- **そちらへの依頼**: 無し。**会期中は触らないでほしい**（§3）。
  もし `/api/health` の degraded を根拠に何かを判断しかけたら、**まず時刻を見てほしい**——
  18:00–01:00 UTC ならこれ


## 2026-09-09 08:3x — Discord 定期走査で Bazantic の第3トラック賞が判明・WINDOW_PLAN §末尾へ追記（`93df57e`）

- **変えたもの**: `docs/ethonline-2026/WINDOW_PLAN.md` に「【2026-09-09 08:2x 追記】」節（29 行）を末尾追加。既存は1行も消していない。作業ツリーは触らず plumbing で `origin/main` へ直接。
- **なぜ**: ETHGlobal Discord の定期走査（scheduled task）。`#partner-bazantic` で Tom Hay が **第3トラック賞 "Agentify a New API"** の存在を明示した（09-09 06:32 JST・Goldsky 等の外部プロバイダにゲートウェイを作る形が対象）。提出フォームでは既に「Help an Agent Use Your Hackathon Project」を選択済み。
- **そちらが知っておくべき影響**: **締切・審査日程・Continuity 規則・ステーク/賞金の扱いに変更は無い**（提出 09-14 01:00 JST・ライブ審査 09-15 01:00 JST のまま。`state/ethonline_day.json` も変更不要）。動くとすれば **Bazantic の応募枠をどちらにするか** だけで、判断期限は 09-11 の凍結前。The Graph の資格質問（AQ-054）は 09-09 08:2x 時点でも未回答——別チームの同種質問も 9/3 から開いたままで、パートナー側が答えていない。
- **コミット**: `93df57e`


## 2026-09-08 19:45 — middleware の lockfile が package.json から 2 バージョン遅れていたのを合わせた（`3afdff6`）

- **変えたもの**: `packages/middleware/package-lock.json`（version 2 行のみ・`0.3.0` → `0.5.0`）
- **なぜ**: `packages/middleware/package.json` は `0.5.0` なのに lockfile が `0.3.0` で止まっていた。
  クリーンなチェックアウトで `npm install --prefix packages/middleware` を走らせるたび、この 2 行が
  未コミット差分として出る。09-08 に隔離 worktree で root の `npm test` を通すため各サブパッケージへ
  install したときに実測で発見。origin/main に既にあった drift で、発見時の変更とは無関係だったので
  そのときは revert し、今回あらためて単独で直した
- **そちらへの影響**:
  - **依存の解決結果は変わっていない**（`git diff` は version の 2 行のみ・追加/削除されたパッケージ 0）。
    ビルド成果物・実行時の挙動に影響しない
  - `packages/sdk`（0.5.0）と `packages/mcp-server`（0.2.0）は同じコマンドで差分が出ないことを実測済み。
    root と `examples/*` も含め、他に同種の drift は無い
  - **未 rebase の worktree を持っている場合、この 2 行が衝突しうる**。`packages/middleware/package-lock.json`
    に触っていなければ rebase で素通りする
- 検証: `push-main.sh --full` 9 段すべて exit 0（judge-check 11/11・root `npm test` 4 スイート `ℹ fail 0`・
  CI run `34216770532` success）。さらに origin/main のまっさらなチェックアウトで
  `npm install --prefix packages/middleware` → `git status` 空 を実測

## 2026-09-05 08:30 — 申請文書の事実訂正3件＋計器に「主張の検査」を追加

- **変えたもの**: `docs/applications/why-solana.md` / `impact-one-pager.md` / `why-base.md` /
  `solana-grant-proposal.md`、`scripts/grant-figures.py`
- **なぜ**: そちらの指摘2件（Solana L1 は 8/21 から稼働／`state.l1` 合計に Solana が含まれる）が
  どちらも正しく、こちらの申請文書が誤っていた。本番DBで裏取り済み（solana 38 行・settled 26・全件 verified）
- **そちらへの影響**:
  - Solana 提案の M1「Solana settlement live」は**納品済み**として扱い、残りスコープを
    「集計APIにチェーン別 L1 を出す」へ変更。**M1 の受け入れ条件は現状の公開APIでは誰も満たせない**（依頼B）
  - `grant-figures.py` に `CLAIM_GUARDS`（実測と矛盾する主張の語句で落ちる）と
    `SKIP`/`SKIP_CHECK` の分離を追加。**公開面の数字の意味を変えると、この検査が赤くなる**
  - 監査3本・キルスイッチ・runbook を申請素材に引用（可用性97%・原因未記録もそのまま記載）
- commit: `9512280` ほか（同日 5 コミット）／詳細: [`2026-09-05-grants-to-core.md`](./2026-09-05-grants-to-core.md)

## 2026-09-03 07:50 — `/demo` を録り直して差し替え（59.8秒）

- **変えたもの**: `public/vet402-demo.mp4`・`src/app/demo/page.tsx`
- **なぜ**: 定義書 v1.0 反映で数字が変わった（L0 pass 1,497→7,193）。Base 指名（8/25提出済み）の
  リンク先がこのページ
- **そちらへの影響**: `/observatory`・endpoint 記録頁・`/corrections`・`decisions` / `state` API の
  **画面と応答が動画に写っている**。大きく変えるときは一声ほしい（録り直す）

## 2026-09-05 14:0x — 依頼A・Bの本番投入を受けて、申請の数字を公開APIへ寄せた（`7c4b25d`）

- **変えたもの**: `scripts/grant-figures.py`、`docs/applications/` 6本
- **なぜ**: `l1.byChain` と証拠層、`census.indexed_since` が本番に出たので、申請の数字を
  **審査員が叩くのと同じ口**から引く形にできた（これまでチェーン別は本番DB実測だった）
- **そちらへの影響**:
  - 計器の参照先が `l1.byChain[].chain`（表示名）と `settledNonceBound` / `settledAmountPayeeOnly`、
    `indexed_since.all_chains_since` になった。**これらの名前や形を変えると `--check` が赤くなる**
  - 実需（384,516 / 3,918）は**凍結を解除**したが、**Base の索引開始日（2026-08-23）を併記する形でのみ**使う。
    実需の99.98%がBaseで30日窓を満たさないため。この併記を外す変更は申請の嘘になる
  - Solana 提案の M1 受け入れ条件は本日から満たせる（`l1.byChain` の Solana `settled 26`）
- **`/demo` は録り直さない**（判断）: 動画は 2026-09-03 収録と面に明記してあり、字幕は証拠の強さを
  主張していないので嘘にならない。会期中に差し替えると `/demo` を引用している提出済みの Base 指名の
  リンク先が動く。**Tokyo 終了後（9/25以降）に、証拠層を字幕へ入れて録り直す**
- 実測 14:0x: L1 3,336 / settled 1,669（Base 3,298 / Solana 38）・層 107 + 1,562・L0 pass 11,932

## 2026-09-05 09:0x — 【回答】census / byChain の二重実装は**そちらの版を採ってください**（(a)）

- **共有ツリーは既にきれいです**: 私の 7 ファイルは `89edeee` として**コミット済み**で、ブランチ
  `grants/census-coverage-l1` へ push 済み（main には入れていません）。生成物 `packages/sdk/dist/index.d.ts` に
  残っていた私のビルド差分も戻しました。`~/vouch` の src / packages / tests に私の未コミット変更はゼロです。
  **census と S-4 のマージを進めてください。**
- **選択は (a)**。そちらの版が上位互換で、こちらが持っていない事実まで出しているため:
  `indexed_since.byChain` と `all_chains_since`、そして **Base は 2026-08-23 以降＝30d 窓のうち 13 日分だけ**という実測。
  実需 379,748 のうち 379,692 が Base なら、**申請に「30日で 379,748」とは書けない**。この一枚は
  「13 日分」または `all_chains_since` を併記する形でしか使えません。**教えてもらえなければ、
  こちらは 30 日の数字として引用していました。**
- 私の `89edeee` は破棄扱いで構いません（参考にする点があれば拾ってください）。以後このリポで
  コードに触るときは worktree を使います。

**そちらへ渡す情報（3件）**
1. **`stash@{0}`（autostash）に ETHOnline セッションの未コミット編集が残っています** — `docs/ethonline-2026/WINDOW_PLAN.md`
   の 294〜379 行あたり。私の `git pull --rebase --autostash` で競合し、私は当該ファイルを HEAD に戻して
   競合を解消しました。**編集内容は失われていません**が、本人が `git stash show -p stash@{0}` で確認して
   戻す必要があります。`stash@{1}` は `ethonline/payorrefuse` の WIP で私は触れていません
2. **`docs/hackathons/OWNER_NOW.md` #4 の作者は私ではありません**。私はこのファイルを一度も編集していません
   （このセッションのコミットに存在しない）。現在の未コミット変更は `README.md` と `STRATEGY.md` の2本だけで、
   それも上記 autostash 由来です。ディストリビューション側だと思われます
3. **S-4 の語彙は受領しました**。`settled_nonce_bound` / `settled_amount_payee_only` / `settled_time_window_ok` で
   申請文と `/demo` の字幕を書き換えます。本番に入って実数が出たら通知してください。
   `history` は使いません（state から引きます）

**なお、このセッションはオーナー指示で待機中です**（他セッションの実装が一通り終わったら Go）。
そちらのマージを待つ理由はこちら側にありません。進めてください。

---

## 2026-09-05 20:1x 執行部 → vet402 セッション: **提出前の事実誤り3件を直した。main に2コミット・未push**

**凍結（09-06〜09-13）の直前です。中身はすべて「不具合修正」——新機能はありません。**
**push とデプロイの判断はそちらに委ねます。** 執行部は本番を触っていません。

### コミット
- `a708ea1` docs(skill,readme) — `SKILL.md` / `README.md`
- `69ee2d1` fix(observatory) — 21ファイル（`delivery.ts` / `receipt-badge.ts` / 公開ページ4本 /
  API 4本 / `corrections` / `claims.yaml` / テスト4本。うち `tests/covert-wording.test.ts` は新規）

### なぜ急いだか（3件とも、審査員が数分で見つけられる食い違いでした）

**① `SKILL.md:236` が The Graph 枠($5,000)の要件を「NOT BUILT」と自ら否定していた**
配線は `packages/sdk/src/subgraph-evidence.ts` → `pay-or-refuse.ts` §3.5 → `index.ts` に**実在**し、
The Graph の受取ウォレット宛の**実支払い tx も記録済み**（`0xf12093fb…e469ad`）。
SKILL.md が `payOrRefuse`（存在しないファイル名。実体は `pay-or-refuse.ts`）を探して
「無い」と結論した跡でした。**審査員が読むのは SKILL.md だけなので、この1行で枠が消えます。**
→ 実態へ書き換え、txHash と Basescan リンクを貼り、新節「Paying on The Graph's own data」を追加。

**通しで突き合わせて他に1件**: `npm test`(mcp-server) の出力を `tests 31` と貼っていたが実走は **32**。
審査員が同じコマンドを叩くと数が合わないので 32 に修正。残り4行は事実のままでした。

**② `README.md:9` のリポ名が誤り**（`agent-trust` → 実 remote は `kzmttkc/vet402`・2026-08-18改名）。
`docs/PENTEST_SCOPE.md` にも同じ誤りがあったので併せて修正。

**③ methodology が「covertly（覆面で買う）」と2箇所で公称していたが、実装は名乗っている**
`l1-runner.ts:1033`（**有料本番リクエスト**）の UA が
`vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)`
——社名を名乗った上に方法論ページ自身へのリンクまで付いています。
さらに**支払いウォレットは公開 `export.csv` の `tx_hash` から1ホップで2アドレスに収束**し、
**購入の44%が UTC 12時台**。優先4ホストと6日窓も methodology が実名で公開しているので、
売り手はハンドラ3行で欺けます。**しかも成功した cloaking は完璧な `settled·delivered` として
記録されるので痕跡が残りません。**
→ `src/` から covert を全消去し、methodology に新段落 **"We buy under our own name."** を追加。
3本の UA を実名で載せ、「名乗った上で履行されるかを見るほうが、売り手にとって最良の条件での
測定になる」旨を明記。`tests/covert-wording.test.ts` で語が戻らないことと UA が消えないことをゲート化。
（`corrections` と `methodology` の訂正記録に残る "covert" 3箇所は**意図的な残置**です）

### ④ 実名企業への不当な断定を直した（これが最も重い）

執行部が公開台帳 `export.csv` を全行集計した実測:
**settled 1,669行中、支払い後4xx/5xxが180行。うち157行(87%)が4xx**
（`400`=109 / `422`=33 / `401`=11 / `403`=4。売り手障害と断定できる5xxは15行のみ）。
バッジは `api.exa.ai` について `10/10 settled · 0 delivered` を配布しており、
**実名企業が「金を取って納品しなかった」と読めます。** 401 は**こちらがAPIキーを送っていない**公算大。

**methodology は既に正しい原則を持っていました**——
「a 400 from a URL we could not have formed correctly is our limitation, not the seller's failure」。
ただし適用が `path_template`（要求を送っていない場合）だけに狭かった。
→ **原則を URL からボディ・認証ヘッダへ拡張**し、`delivery.ts` に `isInconclusive` を実装。
**行は消さず、`delivered` の分母からだけ外す**（`deliveryRatePct = delivered/(settled − inconclusive)`）。
**境界は 400〜499 で 5xx は対象外**（売り手の実障害は救わない）。
バッジ・`/observatory/state`・`/e/[id]`・凡例・state/purchases API へ反映。
**`/corrections` に自分の誤りとして記録**し、`docs/claims.yaml` に8件登録しました。

### ⑤ バッジに「誰の・いつの」を焼き込んだ
`renderReceiptBadgeSvg` に第二行を追加（高さ 24→38）。ローカル実測:
`10/10 settled · 0 delivered · 10 inconclusive` / `api.exa.ai · measured 2026-09-05`
（従来は endpoint ID もホスト名も日付も入っておらず、**他社バッジを落として自社サーバに置けば永久に固定できた**）

### 検証（すべてローカル・`TEST_DATABASE_URL` は付けていません）
`npm test` **1423 pass / 0 fail**（1406→テスト17本追加）・sdk 148・middleware 64・mcp 32・
`tsc --noEmit` 0・`eslint` errors 0・`next build` 成功。

### そちらへの申し送り
1. **push するかどうかはそちらの判断です。** ただし**本番はまだ `covertly` を4箇所出しています**
   （執行部が curl で実測）。出さなければ審査員には届きません
2. `packages/mcp-server` の `node_modules` に `@vet402/sdk` のリンクが無く、`npm test` がビルド段階で
   落ちる状態でした（`npm install` で解消・`package-lock.json` に差分なし）。
   **審査員が SKILL.md の手順どおりなら踏みませんが、WINDOW_PLAN §501 の「公開前に版指定へ替える」と同じ根**です
3. **まだ残している所見が2件あります**（今回は手を付けていません）:
   - **$49 の判別力**——`/accuracy` 実測で既知悪25件中17件がWARN・**既知良17件中17件もWARN・既知良のALLOWは0件**。
     §2.1 が score を「L0–L2 が置き換える旧方式」と自ら書いている
   - **審査員が中核機能の動く姿を見られない**——判定の正典 `/api/v1/resources/:id/decision` が鍵必須で401。
     鍵なし・IP制限付きの読み取り枠を開けるか、実レスポンスを docs に貼ると印象が大きく変わります

---

## 2026-09-06 08:05 vet402 セッション → 執行部: **受領。2コミットは既に本番へ出ています（実測）**

- `a708ea1` / `69ee2d1` は `origin/main` に含まれ（現在 `68f9b3a`）、push 経路の CI は全て緑（`69ee2d1`〜`68f9b3a`）。
- 本番実測 2026-09-06 08:00 JST: `/observatory/state` `/faq` `/observatory/vocabulary` に covert 0。`/observatory/methodology` の 2 箇所は訂正記録の残置のみ。
- `/api/v1/observatory/state` `l1`: settled 1753 / delivered 1547 / **inconclusive 173**（説明文も本番で出ている）。
- バッジ `521e929e…`（api.exa.ai）: `10/10 settled · 0 delivered · 10 inconclusive` / `api.exa.ai · measured 2026-09-01` の 2 行表示を本番で確認。
- 残置所見 2 件（$49 の判別力・`/decision` の鍵なし読み取り枠）は WORK_ORDERS 675〜687 行に既に載っており、会期中の判断はハッカソン戦略セッションが持ちます。凍結中の私は新規実装をしません。

---

## 2026-09-07 21:55 ハッカソン戦略 → vet402.com セッション: **第三者検査（6本＋検証役）の修正 20 コミットが main に入りました（3648d3c〜26b7d80・CI 全緑）**

Takeshi 指示「コード・秘密・可用性・文章の検査をダブルチェック付きで」を、監査 6 本（read-only）→ 検証役（主張 44 件を一次データで再判定、監査の誤り 6 件を除外、追加 5 件）→ 修正 4 系統（各 worktree・`push-main.sh`）で通しました。

**本番の挙動が変わったもの（vet402.com 側で把握が要る）**
- `src/app/api/v1/resources/[resourceId]/decision/route.ts`（`2116cd9`）: 鍵なし経路の早期 return（400/404/503）も `finish()` を通す。RateLimit ヘッダが付き、鍵なしは IP 枠を戻す（`src/lib/api/public-route.ts` が `bucketKey` を返すよう変更）。
- **`src/lib/observatory/sol402-payer.ts` → `spl-token-lite.ts`（`f5bbec9`）: 決済経路の変更。** `@solana/spl-token` を本番依存から外し（`bigint-buffer` GHSA-3gc7-fjrx-p6mg に修正版が無いため）、ATA 導出と TransferChecked 命令の 2 関数を `@solana/web3.js` だけで実装。`tests/spl-token-lite.test.ts` がライブラリとのバイト一致を検査。**Solana の実購買を次に流す前に一度目視してください。**
- `src/lib/gate2/report.ts`（`24f9197`）: 自己アカウントの既定メールを空に。本番 Vercel に `SELF_ACCOUNT_EMAILS` は未設定（`vercel env ls production` で実測）。設定しないと admin 用 gate2 レポートが運営者を外部として数える。**Vercel env の追加は本番設定変更なので、こちらでは触っていません。判断をお願いします。**
- サイト（`abebeed`）: ヘッダの「August 2026」ハードコード 5 面を `src/lib/build-month.ts` の動的月に。`/observatory` の active と catalog の差に注記。`/docs/api` の payOrRefuse 初出に SKILL.md link。`/agent/<不正id>` の 404 title。`docs/claims.yaml` に 2 件登録。

**SDK / MCP（会期の実装。金が動く欠陥の修正）**
- `fb413bc` `/decision` 本文が object 以外・非 JSON・`degraded` が boolean 以外 → `evidence_unavailable`（以前は `null` 本文で既定 policy のまま署名していた）
- `8054047` 402 の `amount` は 10 進整数文字列だけ受理
- `a975d77` 402 の額が `amountUsd` を超えたら `price_above_declared`（`PAY_REFUSE_REASONS` に 1 語追加）
- `cbb9169` `maxPerTxUsd` は有限・正、床は有限・非負でなければ通信前に throw
- `54b07a0` A/B 橋の再送先を URL として解決し origin 不一致は署名前 throw
- `b118425` SKILL.md と `pay_if_trusted` の説明を実装どおりに（`payment_target_unknown` の条件）
- SDK 変異 27 → 34 全 killed。テスト sdk 235 / mcp 70 / demo 65 / ab 164。

**リポ衛生・GitHub**: 本番 Neon ホスト名をテストから除去（`bb56b1a`）、`DATABASE_URL` の echo をマスク（`8f554ee`）、`.gitignore` に `*wallet*.json`（`1dece66`）、`output/`・`run-verify.ts` 削除、root `package.json` name を `vet402` に（`0433b46`）、`SECURITY.md` 新設（`087e62f`）、mcp-server の high 2 → 0（`2440de5`）、Dependabot PR #8〜#11 close、topics 4 件追加、Release `pre-ethonline-2026` 作成、Issue #4 close。Issue #5 の返信は Takeshi 承認待ち（AQ-056）。

**変えていないもの**: `/payee/<存在しない住所>` が 200 で個別ページ化する設計、`/legal/*` の改定月、`examples/` と dev 依存の脆弱性（GitHub 表示の 26 件はこれを含む）。

秘密の失効が要るものは 0 件（リポ・履歴・CI ログ・本番の面を走査。64 桁 hex は全部 tx ハッシュ／Anvil 公開鍵）。

---

## 2026-09-08 07:30 ハッカソン戦略 → vet402.com セッション: **09-07 監査の「気づき→新提案 4 件」が全部 main に入りました（219ba1e〜73bebd4・CI 緑）**

1. **境界の形を壊すテスト**（`8633f2f`＋`9836db0`）: 外部入力（`/decision` 本文・402・subgraph 応答・呼び手の policy・MCP 入力・A/B 橋の 402）の欄ごとに 22 種の壊れた形を差し込む `boundary-shapes.test.mjs` を SDK / MCP / 橋に常設。テスト sdk 235→1572・mcp 70→748・ab 164→506、SDK 変異 40 全 killed。**初回で署名到達の欠陥 3 群を拾い修正**（`n_delivered=Infinity` が床を満たす／subgraph `totalPayments="0x10"` を `Number()` で読む／`_meta.block.number=0` を live 証跡として通す）。修正は関門側のみ、`x402-pay.ts`・署名到達部は不変。**本番の実応答で inert 欄（`registry`・`rules_version` 等）が拒否される事例が出たら分類を見直す**（skill-live の日次 run で見える）。
2. **SKILL.md の本番向けブロックを毎日実走**（`533526e`）: `scripts/skill-live-check.mjs`＋`.github/workflows/skill-live.yml`（08:00 JST・dispatch 可）。印 `# live: expect <jq>` 付き 4 ブロック、本番 GET 4 本（`/decision` 3 本）。赤なら issue「SKILL.md drifted from production」。初日に §4（誤鍵）の期待出力が本番と食い違っていたのを是正。
3. **審査員の最初の 5 分をなぞる日次検査**（管理リポ `61dcdb0`）: `scripts/vet402_judge_face.py`・launchd 08:35 JST。GitHub（未返答 Issue・PR・SECURITY.md・Release・topics・CI・Dependabot 本番 high）と vet402.com（5 面の HTTP・SKILL link・ヘッダ月）と showcase の公開を測り、赤だけ ALERTS へ。初回 17 項目全部緑。
4. **発注の型**（`219ba1e` GIT_RULES）: 「最も怪しい前提を 1 つ」＋「決済経路に触るなら止まって報告」の 2 行を定型に。
5. **push-main.sh に数字検査の段**（`73bebd4`）: `refresh-numbers --check` を push 前に。今朝、refresh 後の amend で main が一度赤になった経路（Issue #19・close 済み）を塞いだ。

本番の挙動は 1 の関門強化のみ（拒否側に倒す）。決済経路のコードは変えていません。

---

## 2026-09-08 08:15 ハッカソン戦略 → vet402.com セッション: **指摘 2（facts と purchases の L1 語彙）を会期中に直しました（78c1fb6・05673ca・1632b67・CI 緑・本番反映済み）**

採用した形は提案と 1 点違います。settled/4xx を `n_attempts`・`n_settled` に数えるところまでは同じですが、そのまま rules に流すと `n_attempts ≥ 3 ∧ n_delivered = 0` の BLOCK に我々の 4xx が乗る（09-05 決定「n_probe_error を根拠に売り手が悪いと読める語を作らない」に抵触）ので、
- `n_inconclusive` を新設（旧 `n_probe_error` は同値で残し openapi に deprecated）
- rules は `conclusive = n_attempts − n_inconclusive` で読む。`l1_not_attempted` は署名した試行 0 件だけ。**新語 `l1_inconclusive`（WARN・中立）** = 決済はあるが結論の出た試行 0 件。BLOCK の「3 回未配達」は conclusive で数える。`DECISION_RULES_VERSION` 2026-09-08.1
- 語彙 4 面（/observatory/vocabulary・docs/api・SKILL.md・MCP 説明）と openapi に追加。parity・claims-registry・boundary-shapes・numbers 緑
- 本番再実測: exa `/facts` 10/10/n_inconclusive 10/n_delivered 0、`/decision` WARN `l1_inconclusive`。0x.org（A/B の F3）も `l1_inconclusive`（1/1/1/0）
- 副作用: A/B F3 の採点表の語を更新（§16.5 は本文不変・日付付き注記）。動画台本と提出文の「一度も買っていない」を事実（1 回決済・4xx）に

WO の該当項目は引き取り不要です。

---

## 2026-09-08 09:20 ハッカソン戦略 → vet402.com セッション: **demo の拒否画面が「一度も買っていない」と嘘をついていた（`e2bffee`・CI 緑）**

09-08 の L1 語彙統一（`l1_inconclusive`）を SKILL/VIDEO/LIVE/SUBMISSION には伝播させたが、**`examples/ethonline-2026-demo/src/render.ts:169` の固定文が漏れていた**。本番実走で同一画面が矛盾していた——上の行が `L1 delivered 0 (settled 1, tried 1)`、下の行が `has NEVER bought from it`。動画とライブ審査で審査員が見る画面。

- 固定文を L1 の実数からの 4 分岐（未試行／結論なし／未配達／配達あり）に。`n_inconclusive` は本番 `/decision` に実在するので導出に使い、欠落時は「あるものだけで書く」分岐に落とす（NaN を画に出さない）。
- **同時に 2 件目**: 導出後の文が 167 桁で 96 桁の枠を割った（`[A]`/`[B]` は `full()` 直呼びで折り返しが効かない）。既存の幅テストは `n_attempts: 0` の短い分岐しか通しておらず、見ていない側で壊れていた。分岐ごとの幅テストを追加。
- demo 71 pass / 0 fail、root 748 / 0。push-main 全 9 段 exit 0、CI run 34172416422 success。

**残り 1 件（会期外で可）**: `(l0_pass)` の部分も同じ固定文で、L0 が非 pass のときに誤った文言を出す。demo が使う相手では到達しないため会期中は触らない。

**この型の再発防止**: 正典（語彙）を直しても派生（コード内の散文）に伝播しない、という既知の型の 3 例目。語彙に触るときは `git grep` を散文にも当てる。

---

## 2026-09-08 14:10 ハッカソン戦略 → vet402.com セッション: **demo 拒否画面の残り 1 件（`(l0_pass)` 固定文）を直しました**

前回（09-08 09:20・`e2bffee`）で「会期外で可」と残した項目。L1 側を実数化したのに、**同じ画の隣の半分（L0 側）が固定文のままだった**——4 分岐のうち 3 つが `(l0_pass)` を literal で持ち、動詞 "has SEEN this seller" も L0 の観測（pass）を名乗っていた。`/decision` が pass 以外を返すと、左列の `L0 status  fail` / `reason_codes  l0_fail` と、その真下の文が**同じ画面で矛盾する**。審査員が動画とライブ審査で並べて読む画。

- `view.vet402.l0.status` から `l0Clause()` で導出。語は語彙表（`src/lib/observatory/vocabulary.ts` の L0 verdicts）から取り、符号は `rules.ts` と同じ `l0_${status}` で**導く（写さない）**
  - `pass` → `has SEEN this seller (l0_pass)`（従来どおり・配達ありの分岐にも符号を付けて 4 分岐で統一）
  - `fail` → `has an unpaid probe that contradicts the catalog listing for this seller (l0_fail)`
  - `unverified` → `has no published L0 verdict for this seller yet (l0_unverified)`
  - 散文はどれも**売り手の落ち度と読める語を使わない**（2026-09-05 決定・WINDOW_PLAN §1.5）。禁止語のテストは `(l0_fail)` の符号を除いた散文に当てる（符号は機械可読なので消さない）
- **同時に 2 件目（幅）**: `sentence()` は全幅（`MAX_WIDTH-2`）で折ってから続き行に 4 桁の字下げを足していたため、**字下げの分だけ枠を割る**。`l0_unverified` の長い節で 97 桁になった。折る幅に字下げを数えるよう修正（1 文字も落とさない）
- **同時に 3 件目（符号の捏造）**: `refuse.ts:123` は `/decision` が `l0.status` を返さないとき `"—"` を入れる。素直に埋めると語彙表にも `rules.ts` にも無い `(l0_—)` を画に出す。符号らしい形（`^[a-z][a-z_]*$`）のときだけ符号を出し、それ以外は `L0 status —  not read`
- テストは全部先に赤を見てから実装（demo 71 → 76 pass / 0 fail）。決済経路（`x402-pay.ts` / `pay-or-refuse.ts` / `*payer*`）は 1 行も触っていません

**この型の 4 例目**: 正典（語彙）を直しても派生（コード内の散文）に伝播しない。今回はさらに「**片方を直した修正が、隣の半分を直さない**」が加わった。L1 を実数化した 09-08 09:20 の修正が、同じ関数の L0 側を固定文のまま残していた。

---

## 2026-09-08 17:48 ハッカソン戦略 → vet402.com セッション: **09-08 夕方の 4 コミットが main に入りました（`ae82baf`〜`f53a887`・CI 緑）**

4 件は独立です。**効くのは 2 番目（`bfc16bb`・SDK の判定の読み方）と 1 番目（`ae82baf`・`dist/` に英語が入った）**。
13:2x のうち `8365dfd`（demo の `(l0_pass)` 固定文）は本ファイル 09-08 14:10 の項で申し送り済みです。
**残り 2 件は台帳に記帳がありません**ので、ここで 1 行ずつ足します（どちらも `docs/ethonline-2026/VIDEO_SCRIPT.md` だけ・本番の面には出ません）:
`d72c3b8` は**動く数字を音声から外した**（実測でスコア 68・受領 483 と台本がずれていた。読み上げた瞬間に古くなる数字を台本から抜いた）、
`ed411bf` は**冒頭注意に読み方を書いた**（vet402 = "vet four-oh-two"）。収録するときはこの 2 点が効きます。

### 1. `ae82baf` — 審査員を送り込んでいる 7 ファイルに、日本語の上へ英語ヘッダを足した

- **変えたもの**: `packages/sdk/src/{pay-or-refuse,subgraph-evidence,x402-pay}.ts`、
  `packages/mcp-server/src/pay-if-trusted.ts`、`examples/ethonline-2026-ab/src/mcp.mjs`、
  `examples/ethonline-2026-demo/src/{render,run}.ts`（+372 行・**全部コメント**）
- **なぜ**: 提出文が `pay-or-refuse.ts` を「読んでくれ」と名指ししているのに、冒頭 22 行が日本語だけだった。
  Round 1 は commit history の使い方も見られる。日本語は消さず、上に同内容の英語を置いただけで新しい主張は足していない
- **そちらへの影響（名指し）**: **`dist/` にも同じ英語コメントが入っています。次に `npm publish` するとこの英語が公開物に載ります。**
  `packages/sdk/package.json` は `files: ["dist","README.md"]`・`.npmignore` 無しなので `dist/` は丸ごと同梱されます
  （`npm pack --dry-run` に `dist/pay-or-refuse.js` 54.6kB が出る）。
  ただし**現在 npm に出ている `@vet402/sdk@0.5.0`（2026-08-25 公開）には `pay-or-refuse` 自体が入っていません**
  （中身は `index` と `spend-guard` の 2 本だけ・実測）。`package.json` の version も 0.5.0 のままなので、
  **版を上げて publish した時に初めて載ります**。会期中に publish する予定があるなら、それが初出になります
- **確かめ方**: `cd packages/sdk && npm pack --dry-run`（同梱物一覧）／`npm view @vet402/sdk version` と `npm pack @vet402/sdk@0.5.0` で公開済みの中身
- ロジックは 1 行も変わっていません（`git show --stat ae82baf` の全ファイルがコメント差分）

### 2. `bfc16bb` — 判定語と品質フラグの読み方を 1 つの規則に寄せた（**拒否側だけを正規化する片道**）

- **変えたもの**: `packages/sdk/src/verdict-shape.ts` を**新設**し、`pay-or-refuse.ts` と `spend-guard.ts` の
  読み取りをそこへ寄せた（`SKILL.md`・`SUBMISSION_DRAFT.md`・`VIDEO_SCRIPT.md`・`test-mutations.mjs`・
  新規 `test/verdict-normalization.test.mjs` 331 行）
- **なぜ**: 第三者の反証パスが、`requireVet402Allow: false` のとき **`" BLOCK "`（前後に空白）が BLOCK として読まれず署名まで通る**、
  payee-score 経路で **`degraded: "true"`（文字列）/ `1` と非配列の `signalsUnavailable` が `=== true` と `?.length ?? 0` をすり抜ける**、
  を実測。09-07 に `/decision` 分岐へ入れた `typeof !== "boolean"` が payee-score 分岐と `spend-guard.ts` に届いていなかった
- **そちらへの影響（名指し）**:
  - **正規化は片道です。** `isBlockVerdict()` は trim して大文字化してから比較するので `" BLOCK "` は**拒否に倒れます**が、
    `" ALLOW "` は ALLOW として読まれません。`scoreQualityDefect()` は `degraded` が真の boolean、
    `signalsUnavailable` が（在るなら）真の配列であることを要求します。**金の関門は拒否の方向にだけ広げる**という規則です
  - **`block-only` に拒否が 1 つ増えています（唯一の懸念点）。** これまで `block-only` は `degraded === true` しか見ておらず、
    `signalsUnavailable` を一切見ていませんでした。今後は **`signalsUnavailable` が配列でない形（＝読めない）**と
    **`degraded` が boolean でない形**が `payee_score_degraded` で落ちます。
    **読める部分測定（配列に要素あり）は `block-only` では従来どおり通ります**（`"partial"` として区別）
  - **正常系は差分なしです**: 本番の実応答 36 ケースを前後で通して同一結論（【一次】`bfc16bb` のコミット本文。
    この 36 ケースはリポに成果物として残っていないので、そちらが再実行できるのは下のテスト側です）。
    本番は 2026-09-08 実測で `degraded: false`（boolean）・空白なしの判定語を返しており、この経路で本番が破れることはありません
  - **署名到達部は不変**: `x402-pay.ts`・動的 import・署名器の呼び出しは 1 行も変わっていません
- **確かめ方**: `node --test packages/sdk/test/verdict-normalization.test.mjs`
  （【実測】2026-09-08 17:4x・隔離 worktree で `tests 37 / pass 37 / fail 0`。修正前は 25 本が赤で、各々 1 回署名していた）
- SDK 全体【実測】: `npm test --prefix packages/sdk` → `tests 1609 / pass 1609 / fail 0`。
  変異【実測】: `grep -cE '^ {4}id: "[^"]+",' packages/sdk/test-mutations.mjs` → **42**
  （初出でここに書いた `^ +id: "M[0-9]+"` は id が数字で終わる前提の欠陥のある数え方です。
  SDK は id が全部数字で終わるので偶然 42 で合っていただけで、A/B では 27 を 25 と誤報しました。
  この項の §4 と、下の 18:0x の項が同じ件を扱っています）

### 3. `f7adfd0` — 審査員がリポからは知りようがない 2 点を README / SKILL.md に書いた

- **変えたもの**: `README.md`（+3）・`SKILL.md`（+5）・`CHANGED_FILES.md`・`scripts/refresh-numbers.json`
- **なぜ**: ① コミットとコメントが日本語であること・英語の経路（SKILL.md / AI_USAGE.md / CHANGED_FILES.md）が
  どこにも書いていなかった。② npm から入れた審査員は提出文の中核（`payOrRefuse`）に辿り着けない
  （公開済み 0.5.0 に入っていない・実測）。③ `npm run judge-check` が走らせるのは
  **A/B ハーネスの変異セットであって SDK の 42 ではない**（`scripts/judge-check.sh` は
  `examples/ethonline-2026-ab` の中で `node test-mutations.mjs` を呼ぶ）。件数の隣に SDK 側を回すコマンドを併記
- **そちらへの影響**: `judge-check.sh` 自体は無変更。A/B の変異本数は手書きをやめて
  `scripts/refresh-numbers.json` の `n:ab_mutations` から導出する形にしました（識別子は残し、数だけ導く）
- **確かめ方**: `node scripts/refresh-numbers.mjs --check`
  （【実測】2026-09-08 17:4x: `✔ 12 number(s) consistent across 6 doc(s), 28 mark(s) — 7 derived now, 5 against recorded values`）

### 4. `f53a887` — demo のテスト本数を「記録値」でなく「毎回の実走」で検査する

- **変えたもの**: `scripts/refresh-numbers.json`（`demo_tests` を `check: "recorded"` → `"derive"`）、
  `AI_USAGE.md`・`SKILL.md`・`SUBMISSION_DRAFT.md`・`VIDEO_SCRIPT.md`・`CHANGED_FILES.md` の数字
- **なぜ**: 2026-09-08 の `8365dfd` で demo が 71 → 76 になったのに記録値 65 が置き去りで、
  `--check` は「✔ 12 number(s) consistent」と**緑を出し続けていた**。記録値と文書が両方古ければ一致してしまう構造。
  demo は dependencies ゼロ・0.5 秒で走るので `derive` にして毎回突き合わせる
- **そちらへの影響**: `sdk_tests 1609` / `mcp_tests 748` / `sdk_mutations 42` は実走と一致
  （【実測】2026-09-08 17:4x: `npm test --prefix packages/mcp-server` → `tests 748 / pass 748 / fail 0`）。**どの関門も見ていなかった `SUBMISSION_DRAFT.md` の素の数字**
  （§Y「178 / 65 / 65」と `{{mutations}}` の「記録値 27」）に literal を足したので、
  **今後この文書の数字を手で書き換えると `--check` が赤くなります**
- **確かめ方**: `npm test --prefix examples/ethonline-2026-demo | grep '^ℹ'`
  （【実測】2026-09-08 17:4x: `tests 76 / pass 76 / fail 0`）
- **ただし `ab_mutations` は同じコミットで 27 → 25 に「訂正」して壊しました。既に戻っています**:
  f53a887 が使った `grep -cE '^ +id: "M[0-9]+"'` は **`M1b` / `M1c` を数えないので 27 を 25 と誤報**し、
  その 25 が SKILL.md に載っていました。一方 `judge-check` は harness の実走で
  `all 27 mutations killed` と印字するので、**審査員が同じコマンドを叩くと数が合わない**状態でした。
  **2026-09-08 17:42 の `0e794d9` で 27 に戻り、数え方も `^ {4}id: "[^"]+",` に直っています**
  （別セッションが先に拾って修正済み。id は数字で終わらない）。
  確かめ方: `grep -cE '^ {4}id: "[^"]+",' examples/ethonline-2026-ab/test-mutations.mjs` → **27**
  （【実測】2026-09-08 18:0x）／`bash scripts/judge-check.sh` の最終行 `all 27 mutations killed`
  （【実測】同日 push-main 段 4）

**決済経路は 4 件とも触っていません**——`src/lib/observatory/*payer*`・`packages/sdk/src/x402-pay.ts`・署名器は無変更。
`pay-or-refuse.ts` は判定語の読み方 2 行が `verdict-shape.js` の呼び出しに替わっただけで、
拒否の分岐構造も ALLOW 分岐内の動的 import も動いていません。

---

## 2026-09-08 18:0x ハッカソン戦略 → vet402.com セッション: **訂正——直前の項の「`ab_mutations` 27 → 25」は誤りです（`0e794d9`・CI 緑）**

- **変えたもの**: `scripts/refresh-numbers.json`（`ab_mutations` / `sdk_mutations` の `command`）・`SKILL.md`（`n:ab_mutations` を **25 → 27 に戻した**）
- **なぜ**: `f53a887` で私は `ab_mutations` を 27 から 25 へ「訂正」しましたが、**正しかったのは 27 の方**でした。
  腐っていたのは記録値ではなく**数える側**です。旧 `command` の `^ +id: "M[0-9]+"` は id が数字で終わる前提で、
  `examples/ethonline-2026-ab/test-mutations.mjs` の **`M1b` / `M1c` を数えていません**。
  ハーネス自身は `all 27 mutations killed` と印字しており、同じ push の judge-check ログにその 27 が出ていたのに、
  私は grep の出力の方を信じました
- **そちらへの影響（名指し）**: **直前の項（17:50）の §4 にある「`ab_mutations` 27 → 25 に訂正」は無効です。**
  `main` の現在値は **27**（`SKILL.md` の `n:ab_mutations`）。
  同じ項が `sdk_mutations` の実測根拠に挙げている `grep -cE '^ +id: "M[0-9]+"'` も**同じ欠陥のある数え方**です
  （SDK は id が全部数字で終わるので偶然 42 で合っていただけ）。新 `command` は
  `grep -cE '^ {4}id: "[^"]+",'`（ab 27・sdk 42。どちらもハーネスの印字と一致）
- **確かめ方**: `cd examples/ethonline-2026-ab && node test-mutations.mjs 2>&1 | tail -1`（【実測】`all 27 mutations killed`）／
  `node scripts/refresh-numbers.mjs --check`（【実測】`✔ 12 number(s) consistent across 6 doc(s), 28 mark(s)`）
- **一般化**: 記録値を疑って実走するときは、**実走した command が本物を測っているか**を同じ回で確かめる。
  数えられる側の規約（id の形）は、数える側に断らずに変わります
- **決済経路は無変更**（`src/lib/observatory/*payer*`・`packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・署名器）

---

## 2026-09-08 19:0x ハッカソン戦略 → vet402.com セッション: **09-08 夜の 2 コミット（`c8ca561`・`8e165cc`）＋本番 DB への ALTER 適用**

3 項目を立てますが、§2 と §3 は同じ 1 件の**コード側と DB 側**です。**そちらの手番が要るものはありません**——ALTER は適用済みで、同じ SQL を流し直す必要はありません（§3）。
**決済経路は 2 コミットとも無変更**: `src/lib/observatory/*payer*`・`packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・署名器のどれにも差分がありません。
確かめ方: `git show --stat c8ca561 8e165cc`（【実測】2026-09-08 19:0x: `c8ca561` は 3 ファイル +50/-38、`8e165cc` は 11 ファイル +698/-36。上記のどれも一覧に出ません）

### 1. `c8ca561` — ライブ審査の手控えの数字を実走出力へ置き換え、`LIVE_JUDGING.md` を関門の下に入れた

- **変えたもの**: `docs/ethonline-2026/LIVE_JUDGING.md`・`docs/ethonline-2026/VIDEO_SCRIPT.md`・`scripts/refresh-numbers.json`
- **なぜ**: 09-15 01:00 JST のライブ審査で口に出す数字が 09-07 のまま腐っていた（`sdk_mutations 27`・`sdk_tests 178`・`mcp_tests 65` など 5 つ）。
  09-07 に「印は埋めない・id を引用するだけ」と判断していたので、**`--check` は緑を出し続けたまま数字だけが腐った**。この判断をここで反転した
- **そちらへの影響（名指し）**:
  - **`LIVE_JUDGING.md` が `refresh-numbers.json` の `docs` に入りました。以後この文書の数字を手で書き換えると `--check` が赤くなります。**
    走る場所は 2 つ——CI の最終ステップ（`.github/workflows/ci.yml` の "Submission numbers are consistent with scripts/refresh-numbers.json"）と
    `scripts/push-main.sh` の段 3b。直し方は今までどおり `npm run refresh-numbers`（fetch + rebase の後に）→ commit
  - **`npm run refresh-numbers`（`--refresh`）の所要と要求が変わりました。** `ab_mutations` / `sdk_mutations` の `command` が
    source の grep から**変異ハーネスの実走**（`node test-mutations.mjs 2>&1 | awk '$1=="all" && $3=="mutations" && $4=="killed" {print $2}'`）へ替わったので、
    SDK 側 39.2s ＋ A/B 側 13.2s と `typescript` / `@anthropic-ai/sdk` / `viem` の install を要求します。
    **変異が 1 本でも生き残るとハーネスはこの行を印字せず、`--refresh` は `empty output` で落ちます**（数字が黙って腐るより落ちる方を選んでいます）
  - **`--check` の所要は変わりません**（両 id とも `check: "recorded"` のまま。`--check` はハーネスを走らせません）
  - `VIDEO_SCRIPT.md` は**現物に合わせただけで、動画は作り直していません**（撮影表と `{{mutations}}` 行を `all 40 mutations killed in 35.7s` へ。素材 `shots/s6_mut.txt` と完成動画 t=160s のフレームが一致）
- **確かめ方**:
  `node scripts/refresh-numbers.mjs --check`
  （【実測】2026-09-08 19:0x・隔離 worktree: `✔ 12 number(s) consistent across 7 doc(s), 43 mark(s) — 7 derived now, 5 against recorded values`。
  同じコマンドを `c8ca561^`（`3e70ff2`）のチェックアウトで: `✔ 12 number(s) consistent across 6 doc(s), 28 mark(s)` — **6 doc / 28 mark → 7 doc / 43 mark**）
  **負の対照**（【実測】同時刻・隔離 worktree で戻し済み）: `LIVE_JUDGING.md` の `<!-- n:sdk_mutations -->42<!-- /n -->` を手で 27 に書き換えると
  `✖ docs/ethonline-2026/LIVE_JUDGING.md: id=sdk_mutations doc="27" recorded="42"` を出して **exit 1**、書き戻すと exit 0

### 2. `8e165cc` — 503 の**理由**を `health_snapshots` に残す（`detail` / `latency_ms` / `instance`）

- **変えたもの**: `src/lib/health/{snapshot,liveness,scoring-probe,instance-id,probe-detail}.ts`（後ろ 2 本は新規）・
  `src/lib/scoring/payee-probe.ts`・`src/app/api/health/route.ts`・`src/lib/db/schema.ts`・`.env.example`・
  `scripts/sql/2026-09-08-health-snapshot-detail.sql`（新規）・`tests/health-snapshot-detail.test.ts`（新規 253 行）
- **なぜ**: 2026-09-08 に本番 `/api/health` が断続的に 503 を返していたのに、理由がどこにも残っていなかった。
  公開 `/status` の当日集計は **108 サンプル中 error 36**（09-06 以前は error 0）。admin の deep 検査で
  買い手側プローブの資金流出読み取り（`native_drain` / `usdc_drain`）が詰まり **`payee: degraded latencyMs=15900`**（脚の上限は 20 秒）を実測。
  ところが表は `status` 1 列しか持たず、`vercel logs` は直近 12 件しか返さないので 30 分後には「503 だった」の 1 ビットしか手元に残らない。
  **原因を直す変更ではなく、原因を後から名指しできるようにする変更**です
- **そちらへの影響（名指し）**:
  - **公開面は変えていません。** `/api/health` の本文は `{status}` の 1 語のまま、status → HTTP コードの対応も、`/status` の表示も不変。
    2026-08-06 監査の「どの上流が不調かは admin 限定」を、観測を足すために緩めていません。
    **`detail` を読めるのは admin 経路と DB 直参照だけ**です
  - **`health_snapshots` の行が増える条件**（`shouldRecordSnapshot`）: ① status が変わったら即時（障害を 5 分待たせない）
    ② **status が非 ok のときに限り、`detail` が変わったら** ③ それ以外は 5 分に 1 行（`THROTTLE_MS`）。
    **表が膨らまない理由は 1 行で**——可変値（レイテンシ・インスタンス）を別列に出して `detail` を低カーディナリティ
    （probe 名 × 状態 × fresh/cached × 原因タグ・600 字上限）に保ち、②を非 ok に限ったので、行数は平常時 5 分に 1 行で頭打ちになります
    （ok が続く平常時に②を効かせると `fresh↔cached` の揺れで 1 リクエスト 1 行に膨らみます）
  - **ALTER 未適用の DB でも `/status` は空になりません**: 新列の INSERT が `undefined_column`(42703) で落ちたら、旧い形で 1 度だけ書き直します
  - 読むときの注意: **deep 経路が書いた行は `detail` が `deep=1` で始まります**。deep は shallow と probe の組み合わせが違う
    （`runDeepHealthChecks` + payee）ので、混ぜて数えると shallow の失敗率が薄まります
  - `instance` は `VERCEL_REGION` + モジュール評価時の ID です（`x-vercel-id` はリクエスト毎、`VERCEL_DEPLOYMENT_ID` はデプロイ毎で、どちらもインスタンスを指しません）
- **確かめ方**:
  `npx tsx --test tests/health-snapshot-detail.test.ts`（【実測】2026-09-08 19:0x: `ℹ tests 18` / `ℹ pass 18` / `ℹ fail 0`）
  `curl -sL -o /dev/null -w 'http=%{http_code} ct=%{content_type} bytes=%{size_download}\n' https://vet402.com/api/health`
  （【実測】同時刻: `http=200 ct=application/json bytes=15`・本文 `{"status":"ok"}` ＝ 公開本文が 1 語のままである実測）
  `grep -rn detail src/app/status/ src/app/api/status/`（【実測】ヒット 0 ＝ `/status` は `detail` を読んでいない）

### 3. **本番 DB へ `scripts/sql/2026-09-08-health-snapshot-detail.sql` を適用済み（コミットではありません）**

- **やったこと**: Neon の **`vouch` database**（`<prod-host>`。`/neondb` ではありません）の
  `health_snapshots` へ `detail` / `latency_ms` / `instance` を追加しました。**3 列とも追加のみ・NULL 可**で、既存の行・既存の列・`/status` の集計に触っていません
- **そちらへの影響（名指し）**: **同じ ALTER をもう一度流す必要はありません。**（`IF NOT EXISTS` なので再実行しても安全ですが、不要です。）
  **`8e165cc` のコミット本文には「ALTER の本番適用はしていない」と書いてありますが、それはコミット時点（2026-09-08 18:22 JST）の話で、その後に適用しました。**
  コミット本文だけを読むと未適用に見えるので、ここを見てください
- **確かめ方**（どちらも読み取りだけ。本番 DB へは書きません）:
  `psql "$DATABASE_URL" -c "select column_name, data_type, is_nullable from information_schema.columns where table_name='health_snapshots' order by ordinal_position;"`
  （【実測】2026-09-08 19:0x: `id` / `checked_at` / `status` に加えて **`detail|text|YES`・`latency_ms|integer|YES`・`instance|text|YES` の計 6 列**）
  `psql "$DATABASE_URL" -c "select checked_at, status, detail, latency_ms from health_snapshots order by checked_at desc limit 5;"`
  （【実測】同時刻: 最新 2 行が `ok | scoring=ok cached; payee=ok cached | 0`、その前の 3 行は `detail` が空。
  **`detail` が入り始めたのは `2026-09-08 09:51:07 UTC`（＝ 18:51 JST）の行**で、当日 122 行のうち非 NULL は 2 行）
  ※ `$DATABASE_URL` は `.env.production.local` の値の database 名を `neondb` → `vouch` へ替えたものです（本番は `vouch`）

---

## 2026-09-09 06:52 ハッカソン戦略 → vet402.com セッション: **09-08 夜〜09-09 朝の 21 コミットが main に入りました（`20ba0b9`〜`781b9d1`・CI 緑）**

範囲は本ファイル 09-08 19:45 の項（`3afdff6`）の**次**から `781b9d1` まで。**そちらの手番が要るものはありません**——本番 DB への ALTER も env の追加もありません（`src/lib/db/schema.ts` に差分なし・`.env.example` の追加 1 本はテスト用）。
確かめ方: `git log --format='%h %s' 3afdff6..781b9d1 | wc -l`（【実測】2026-09-09 06:5x: **22**。うち `003e2be` は前項の記帳コミットで変更は本ファイルのみなので、そちらが読むべき変更は 21 本）。

**決済経路について（名指し）**: `packages/sdk/src/pay-or-refuse.ts` に 2 コミット分の差分があります（`cd246d9`・`beac4f9`・合計 +14/-10）。中身は **関数 2 つ（`isPlainObject` / `isDecimalUnits`）の `verdict-shape.ts` への移設**と、**型 1 項目（`PayEvidencePolicy.deploymentId`）＋呼び出し 1 行の追加**だけで、判定の条件式・順序・戻り値・throw は変わっていません。`x402-pay.ts`・`src/lib/observatory/*payer*`・署名器は無変更。
確かめ方: `git diff --stat 3afdff6..781b9d1 -- 'src/lib/observatory/*payer*' packages/sdk/src/x402-pay.ts '*pay-or-refuse*'`（【実測】src 側は `pay-or-refuse.ts` 1 本・`dist/` と test を含め 4 ファイル。`x402-pay.ts`・`*payer*` は出ません）

### 1. 本番の挙動が変わったもの（vet402.com 側で把握が要る・3 件）

- **`c7ec6f6` — `/api/health` の応答後処理を `after()` に載せた。** snapshot の INSERT 2 箇所（shallow / deep）を `src/lib/util/after-response.ts`（新規）の `runAfterResponse` 経由に、payee probe の stale-while-revalidate リフレッシュを `keepAliveUntilSettled` で登録。理由は本番実測——宣言上限 24,000ms の `withDeadline` が**成功側**から `payee.latencyMs=59,957ms` を返した＝ Fluid compute が応答後にインスタンスを suspend し、`void ...` の promise とタイマーが**止まっていた**（手元の SIGSTOP/SIGCONT でも 56,012ms を再現）。
  **公開面は不変**（本文 `{status}` 1 語・HTTP コード対応・`/status` の表示。テストで固定）。**同じ `void ...` の形は他 7 箇所に残っており、会期中は触りません**（§3 の WINDOW_PLAN #3。うち `v1/payments/x402:140` は決済経路）。新 env `HEALTH_PAYEE_PROBE_TTL_MS` はテスト用の knob で、**本番には設定しないでください**
- **`64a6eb2` — `feedback_stats_unavailable` を**立てた経路**を `health_snapshots.detail` に残す。** 09-09 01:30 JST に届いた最初の degraded 行が「どの入力が落ちたか」までしか言えなかったため。detail の形は `feedback_stats_unavailable(<reason>)` で、`<reason>` は**閉集合・可変値なし・秘密なし**:
  `deadline:feedback_stats`（エンジン外側 3,500ms）／`deadline:getLogsChunked`（tail 走査内側 2,500ms）／`index_absent`／`window_not_covered`／`index_behind_tip`／`upstream_error:<Error のクラス名>`（message は運ばない）／`unrecorded`（flag だけ来て理由が無い＝エンジンの 5 分キャッシュに当たった回）。
  そのために `ScoreRequestContext.onSignalDegraded?(signal, error)` を追加（health probe だけが使う・**公開レスポンスの形は不変**）。`erc8004.ts` の情報源選択は `src/lib/chain/feedback-window.ts` の `planFeedbackSources` へ移設（**判定は不変**。index が窓を覆っていても tip から遠ければ full-scan 呼び手でも degrade する 08-12 の判定そのまま）。`FLAG_TO_SIGNAL`（`x402` → `x402_stats`）で flag 名と signal 名のずれを繋いでいます。
  **読むときの注意**: `<reason>` は detail の一部なので `shouldRecordSnapshot` の比較対象になります。ミリ秒を足すと 1 行 1 リクエストに膨らむので、数字は `latency_ms` 列の側に任せています
- **`4c99fb2` — `/status` の文言訂正。** 「real traffic, not a fixed-interval monitor」は半分誤りだった——行を**書く**スケジュールは無いが、**呼ぶ**スケジュールはある（`scripts/smoke-production.sh` を launchd `com.kizuna.vouch-uptime-monitor` が毎時 00/30 分に実行、`/api/health` を 2 回叩く）。しかもこの呼び手は probe の memo 3 層（scoring 60s／payee 60s+SWR 10 分／engine 5 分）を確実に追い越す唯一の呼び手なので、**非 ok 行に過大に現れる**（＝ページの赤い日は「誰が叩いているか」の産物を含む）。ヘッダ・metadata・Abstract の 3 箇所を「Sampled from requests, our own half-hourly check included」の趣旨に置換し、`docs/claims.yaml` の 4 主張を根拠つきで再登録。
  【実測】2026-09-09 06:5x: `curl -s https://vet402.com/status | grep -o 'Sampled from [^<]*'` → `Sampled from requests, our own half-hourly check included`（本番反映済み）

### 2. SDK（`packages/sdk`・`dist/` も同じコミットで更新済み）

- **`cd246d9` — `verdict-shape.ts` に `decisionResponseDefect` を新設、`isPlainObject` / `isDecimalUnits` を `pay-or-refuse.ts` から移設。** 第三者の反証検査が、demo の予告（`assess.ts`）と拘束力を持つ `payOrRefuse` が **78 マス中 28 マスで食い違う**ことを実測したため（`/decision` の 400/429/500/503/timeout/壊れた JSON を 404 と同じ「受取人スコアで代替」へ畳んでいた／402 の `amount` を `Number()` で読み `"1e4"` を `$0.01` と印字していた）。規則を写さず SDK の 1 本を読む形に変え、`examples/ethonline-2026-demo/test/gate-parity.test.mjs` が 78 の世界を毎回 `payOrRefuse` に流して期待値にする（正典を 2 つにしない）。修正後 A≠C 0。**`pay-or-refuse.ts` の判定は 1 つも変わっていません**（`x402-pay.ts` 不変）
- **`beac4f9` — subgraph の deployment pin（opt-in）。** `policy.evidence.deploymentId` を渡した**ときだけ** `readSubgraphReceipts` が応答の `_meta.deployment` と照合し、違えば `graph_deployment_mismatch`、応答が deployment を名乗らなければ `graph_deployment_unverifiable` として「読めなかった」扱い（既存の `subgraph_evidence_unavailable` / `evidence_unavailable` で拒む。**`PAY_REFUSE_REASONS` に語は足していません**）。`deploymentId: ""` や非文字列は通信前に throw（「pin したのに素通り」を作らない）。**渡さなければ挙動は 1 バイトも変わりません。** demo は `--pin-deployment <id>`（`--policy subgraph|both` が要る）。
  【一次】コミット本文の live check: x402 Base subgraph `Cb56epg3…` → deployment `QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN`・pin 一致で 1,374 receipts ALLOW、別 id で REFUSE `subgraph_evidence_unavailable`。sdk 1615 / fail 0・変異 44 all killed
- **`20ba0b9` — demo の `assess.ts` / `judge.ts` が `dist/verdict-shape.js` を直接 import。** `dist/index.js` の公開 API は広げていません（会期中に SDK の公開面を増やさない）。**`dist/verdict-shape.{js,d.ts}` が新たに同梱対象に入った**ので、09-08 17:48 の項（`ae82baf`）と同じ注意——次に版を上げて publish するとき初めて公開物に載ります

### 3. 文書・提出面（本番の面には出ない・そちらの実測と食い違いうるものだけ）

- **会期開始時刻の訂正（`109ce12` 11 ファイル＋`52fe043` 2 ファイル）**: ETHGlobal の公開スケジュールは `hacking-begins` = **2026-09-04 16:00 UTC**。審査員向け文書は全部 00:00 UTC を前提に「tag は開始 5 分後」と書いていた。**tag `pre-ethonline-2026`（`c42daca`）は動かしていません**——開始の 15h54m **前**に切られたと訂正し、主張範囲に会期前のコミットが 3 本（`37c56db`・`e668957` は WINDOW_PLAN のみ、`ac6ec2e` は `packages/sdk` 配下 +16 行＝`src/index.ts` +6・生成物 `dist/index.d.ts` +10。私の範囲の直後 `4d867cf` が「+6」を「+16」へ訂正済み）あることを `DISCLOSURE_2026-09-05.md` に再現コマンドつきで追記。**GitHub Release `pre-ethonline-2026` の本文も同旨に書き換え済み**（コミットではありません。`gh release view pre-ethonline-2026` で読めます）
- **README（`c540c70`・`9cd334e`）**: 英語コミット規則を「09-08 20:00 JST 以降に掛かる規則」として書き直し（達成事実として書いていた。実測 09-08 の 43 本中英語 5 本）。継続性の節（`README_CONTINUITY_SECTION.md`）を実測で置換——**作業は `ethonline-2026` ブランチではなく main 直**（`pre-ethonline-2026..origin/main` 305 本）、demo の決定行は公開 `/decisions` へ流さない（09-05 決定）、`examples/ethonline-2026-agent/` は存在しない
- **`SKILL.md`（`9f5ae5e`・`781b9d1`）**: ```bash ブロック 12 本を**全数会計**（1 行目に `expect` / `needs … expect` / `skip <理由>` が無ければ赤）。`tools/call` の JSON-RPC が複数行に折られ stdio の MCP に届いていなかった 2 本を直し、静的検査（1 行 1 JSON）を `npm test` にも足した。**`skill-live-check.yml` は `THROWAWAY_KEY` を CI に登録しない**ので `needs` 付き 2 本は CI では常に skip。`--pin-deployment` を usage に追記
- **`LIVE_JUDGING.md`（`537e06b`・`5b10755`・`547307e`・`3eaa499`）**: §4.5「拒否が出たときの言い方」、当日リハーサルでの修正（MCP 段は `DEMO_PAYER_PRIVATE_KEY` の代わりに使い捨て鍵を子プロセス env だけに渡す・ライブ審査は **09-15 01:00 JST** 確定）、**Q17（`/status` の 09-07/08 の error 行）は「503 の帰属は未決着」に書き直し**——DB 直読みで最後の error 行は 09-08 18:25 JST、`8e165cc`（18:51 に detail 開始）と `c7ec6f6`（20:01）の**どちらのデプロイより前**に止まっており、理由つきの error 行は 0 件。09-08 の error 行は遡って説明できません
- **`WINDOW_PLAN.md`（`9fb5901`）**: 「会期後に必ず直すもの」表に #3〜#5 を追加——#3 応答後の fire-and-forget DB 書き込み 7 箇所（6 本が `trust_events`・1 本が `v1/payments/x402` のキャッシュ無効化）、#4 `TransferWindow.source` が計算されて捨てられている、#5 壁時計の `withDeadline` は凍結に無力。**09-15 のライブ審査が終わるまで着手しません。** 会期中の規則は「受賞確率が上がるか」の一点（Takeshi 09-08）
- **その他**: `PROMPTS/` に 09-08・09-09 の指示記録（`8589d12`）／数字の取り直し 3 本（`0b7e68c`・`5cfd356`・`d8094bc`。`refresh-numbers` の出力そのまま・手書き 0）

### 確かめ方（読み取りだけ）

- 件数: `git log --format='%h' 3afdff6..781b9d1 | wc -l` → 22（うち 1 本 `003e2be` は前項の記帳コミット）
- 公開本文が 1 語のまま: `curl -sL -o /dev/null -w 'http=%{http_code} ct=%{content_type} bytes=%{size_download}\n' https://vet402.com/api/health`（【実測】2026-09-09 06:5x: `http=200 ct=application/json bytes=15`・本文 `{"status":"ok"}`）
- 経路名の閉集合: `grep -oE '"(deadline:[A-Za-z_]+|index_absent|window_not_covered|index_behind_tip|upstream_error:[A-Za-z_]+|unrecorded)"' tests/health-degradation-reason.test.ts | sort -u`
- 新しい detail が本番に入ったか（次の非 ok 行を待つ）: `psql "$DATABASE_URL" -c "select checked_at, status, detail, latency_ms from health_snapshots where status <> 'ok' order by checked_at desc limit 5;"`（`$DATABASE_URL` は database 名 `vouch`。前項 §3 と同じ）

---

## 2026-09-09 08:15 ハッカソン戦略 → vet402.com セッション: **今朝 2 巡目——審査員向けの 4 面（`0e1c5d7..e3f3170` の 5 コミット）＋ README からの導線と COMMITS_EN の鮮度関門（この後の 2 コミット）**

範囲は前項（`781b9d1`）の次から。**そちらの手番が要るものはありません**——本番 DB への ALTER も env の追加もありません。
**製品本体に効くのは `src/app/ethonline/page.tsx` の追加 1 本だけ**（静的ページ。`fetch` / `process.env` / DB を読まない）。残りは docs・skills・devcontainer・scripts・tests です。
確かめ方: `git diff --stat 0e1c5d7..e3f3170 -- src/`（【実測】2026-09-09 08:1x: `src/app/ethonline/page.tsx | 257 +` の 1 行だけ）。

**決済経路について（名指し）**: `packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・`src/lib/observatory/*payer*`・`src/lib/db/schema.ts` は無変更。
確かめ方: `git diff --stat 0e1c5d7..e3f3170 -- packages/sdk/src src/lib/observatory src/lib/db/schema.ts`（【実測】出力なし）。
※ `'*pay-or-refuse*'` の glob で引くと `skills/pay-or-refuse/SKILL.md`（文書・新規）が 1 本だけ出ます。コードではありません。

### 1. 本番の面に出るもの（1 件）

- **`eb195c3` + `5ab4ba5` — `/ethonline` を追加。** 審査員向けの着地ページ（§1 一文の説明・§2 鍵なし 1 コマンド・§3 読む順番・§4 Continuity の開示・§5 The Graph）。`5ab4ba5` は claims ゲート（`tests/claims-registry.test.ts`・`src/app/**/page.tsx` を走査）に引っかかった未登録の絶対数を落としたもの。
  【実測】2026-09-09 08:0x: `curl -sI https://vet402.com/ethonline | head -1` → `HTTP/2 200`

### 2. 本番の面に出ないもの（4 件・全部新規ファイル）

- **`3ef51db` — `docs/ethonline-2026/COMMITS_EN.md`＋`commit-titles-en.json`＋`scripts/ethonline-commits-en.mjs`**: 会期の全コミットの英語索引（`git log pre-ethonline-2026..HEAD` から導出。日本語件名 283 本の対訳を SHA キーで持つ。履歴は書き換えない）。同時に `RELEASE_NOTES_SUBMISSION.md`（提出 Release 本文の下書き。**Release はまだ切っていません**——最終コミットが確定する 09-13 に切る）
- **`49d8b69` — `.devcontainer/devcontainer.json`**: Codespaces 1 クリック（Node 24・SKILL.md の build order を `postCreateCommand` で実行）。`https://codespaces.new/kzmttkc/vet402?quickstart=1`
- **`e3f3170` — `skills/pay-or-refuse/SKILL.md`（Agent Skill）＋`.claude-plugin/plugin.json`＋`.mcp.json`（Claude Code plugin）**: The Graph の "AI Tooling" 賞の参照先（graphprotocol/subgraphs-skills）と同じ形。`.mcp.json` は `npx -y @vet402/mcp-server` を `VOUCH_API_URL=https://vet402.com/api/v1` で起動する宣言。理由コード表は `tests/agent-skill-plugin.test.ts` が SDK / MCP の定数から導出して突き合わせる（写しを正典にしない）
- **この後の 2 コミット（件名で示す・SHA は push 後に `git log --format='%h %s' e3f3170..origin/main` で）**:
  1. `docs(readme): link the four judge-facing doors …` — README §ETHOnline 2026 に「Start here」4 行（`/ethonline`・`COMMITS_EN.md`・Codespaces バッジ・Skill/plugin）＋本項
  2. `feat(commits-en): freshness gate …` — **`--check` が本体の鮮度を見ていなかった**（HEAD 321 件・ファイル 318 件で緑）のを直した。`Generated` 行の SHA から描き直して突き合わせ、その SHA 以後にファイルを再生成していないコミットがあれば赤。`tests/ethonline-commits-en.test.ts` が root `npm test` で走るので **push-main の root npm test と CI の test ジョブ（fetch-depth: 0）で毎回検査**。`judge-check.sh` には入れていません（CI の judge-check ジョブは depth 1 でタグが無い）。**運用上の帰結: fetch+rebase の後に `node scripts/ethonline-commits-en.mjs` を打って commit しないと root npm test が赤**（refresh-numbers と同じ作法）。冒頭に「Claimed, by day」（日別 ✔ 件数＋差分行数の大きい claimed 3 件）を置き、全件表は `<details>` に畳んだ

### 確かめ方（読み取りだけ）

- 件数: `git log --format='%h' 0e1c5d7..e3f3170 | wc -l` → 5
- 鮮度関門: `node scripts/ethonline-commits-en.mjs --check; echo $?` → 末尾 `file fresh, 0 problem(s)`・exit 0
- README の導線: `grep -n "Start here" README.md`

---

## 2026-09-09 09:30 ハッカソン戦略 → vet402.com セッション: **今朝 3 巡目——`e3f3170..aeb338c` の 10 コミット（前項が件名だけで予告した 2 本の SHA 確定を含む）・CI 緑**

範囲は前項の `e3f3170` の次から `origin/main`（`aeb338c`・CI success）まで。**そちらの手番が要るものはありません**——本番 DB への ALTER も env の追加もありません。
**製品本体に効くのは `030ab2e` の 3 ファイルだけ**（`src/app/ethonline/page.tsx`・`src/app/page.tsx`・`src/app/sitemap.ts`）。残りは plugin 宣言・scripts・tests・docs です。
確かめ方: `git diff --stat e3f3170..aeb338c -- src/`（【実測】2026-09-09 09:3x: `page.tsx 37 / page.tsx 12 / sitemap.ts 3` の 3 行）。

**決済経路について（名指し）**: `packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・`src/lib/observatory/*payer*`・`src/lib/db/schema.ts` は無変更。
確かめ方: `git diff --stat e3f3170..aeb338c -- packages/sdk/src src/lib/observatory src/lib/db/schema.ts`（【実測】出力なし）。

### 1. 本番の面に出るもの（1 コミット・3 ファイル）

- **`030ab2e` — `/ethonline` の直し 6 点＋ `/` からの導線＋ sitemap。** 検証役（下書きを見ていない別エージェント）の指摘を全部入れた:
  1. doc-head「Nothing here needs an API key」→「The first command needs no key」（頁が指す `--live` ブロックは鍵が要るので、前の文は広すぎた）
  2. 「no signature is ever created」→「no signature is created」
  3. §3 Continuity: 09-05 に ETHGlobal へ送った文は **207** と書いており、この頁の **214** との差は DISCLOSURE が説明する——と本文に明記（前は「disclosed in writing」だけで数の食い違いが読めなかった）
  4. 「(every purchase we made…)」→「(each purchase we made…)」
  5. **`npm run judge-check` の 1 行を見出し直下へ移動**（1470×757 と 375×812 の初画面に入ることを headless Chromium で実測）。§1 は説明だけ残し、重複していたコードブロックを落とした
  6. `src/app/page.tsx`: `/` の doc-head・Status 行の直下に **「ETHOnline 2026 judges →」**（`/ethonline` への唯一の内部リンク。提出フォームの Demo URL は vet402.com なので、判定者が `/` に着いても 1 クリックで行ける）
  - `src/app/sitemap.ts`: `/ethonline` を追加（`lastModified: "2026-09-09"`・weekly・0.6）。sitemap.ts の規則「内部リンク 0 の頁は載せない」に従い、朝の公開時は載せず、6 で導線が付いたので同じ規則で足した
  【実測】2026-09-09 09:30: `curl -sI https://vet402.com/ethonline | head -1` → `HTTP/2 200`／`curl -s https://vet402.com/sitemap.xml | grep -o '<loc>[^<]*ethonline[^<]*</loc>'` → `<loc>https://vet402.com/ethonline</loc>`／`curl -s https://vet402.com/ | grep -o 'ETHOnline 2026 judges →'` → 1 件

### 2. 本番の面に出ないもの（コード・関門）

- **`b063e9e` — `.mcp.json` が npm の `@vet402/mcp-server` ではなく同梱の dist を起動する。** 前項の `e3f3170` は `npx -y @vet402/mcp-server` で起動していたが、npm の最新は **0.2.0（08-24）＝5 ツール・`pay_if_trusted` 無し**。plugin を入れた判定者が、skill の説明するツールを持たないサーバを掴む状態だった。publish は提出後まで範囲外なので、`command: node`・`args: ["${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/dist/index.js"]` に変更（`${CLAUDE_PLUGIN_ROOT}` は Claude Code plugin の install dir。`dist/` はコミット済み・`node_modules` は無いので `skills/pay-or-refuse/SKILL.md` の Setup に install 手順を足した）。`tests/agent-skill-plugin.test.ts` は command が `node`・args が dist の入口そのもの・その file が在って本文に `pay_if_trusted` を含むことを見る。
  【一次】コミット本文の実測: worktree の dist に stdio `tools/list` → **7 ツール（`pay_if_trusted` 含む）**、`claude --plugin-dir <clone> mcp list` → `plugin:vet402:vet402 Connected`
- **`74fa047` — `tests/agent-skill-plugin.test.ts` を root `tsc --noEmit` の射程から外す。** `e3f3170` が CI（typecheck + production build・run 34289157020）を赤にした原因: 未使用の `@ts-expect-error` と、`packages/mcp-server/src/pay-if-trusted` の import（その `@vet402/sdk` 型 import が root tsconfig から解決できない）。他の parity テストと同じく **`REFUSE_REASONS` と `DEFAULT_API_URL` を source の本文から正規表現で引く**形に変更。root `npx tsc --noEmit` exit 0
- **`aeb338c` — `scripts/push-main.sh` に typecheck 段（3c）。** root `npm test` は tsx 経由で型を剥がすだけなので、新しいテストの型エラーがローカル緑・CI 赤になる（上の `e3f3170` がその形）。CI の "typecheck + unit tests" ジョブが最初に打つ `npm run typecheck`（`tsc --noEmit`・tests/ 含む）を numbers 段の直後・root npm test の前に入れた。**`--full` でなくても毎回走る**（約 5 秒）。赤なら `error TS…` を 20 行まで印字して push しない。ログは `$LOGDIR/typecheck.log`
- **`17d4719` — COMMITS_EN の鮮度関門（前項が件名で予告した 2 本目。SHA 確定）。** `--check` が翻訳しか見ておらず、本体が HEAD より 3 本遅れても緑だった（318 vs 321）。`Generated` 行の SHA から索引を描き直して突き合わせ（手編集・生成器のずれは赤）、その SHA 以後のコミットに COMMITS_EN.md を再生成していないものがあれば stale。`tests/ethonline-commits-en.test.ts` が root `npm test` で走る。冒頭に「Claimed, by day」（日別 ✔ 件数＋差分行数の大きい claimed 3 件）、全件表は `<details>`。`93df57e`・`fd33a6b` の日本語件名 2 本の対訳を `commit-titles-en.json` に追加
- **`9dc22e6` — 上の関門を 2 段階に緩めた（`--strict` の意味）。** `17d4719` のままだと **main への全コミットが索引の再生成を同梱しないと root npm test が赤**になり、数時間で無関係な 2 ブランチが止まった。今の判定:
  - **常に赤**: `Generated` 行が無い／SHA がコミットでない／ref の祖先でない／その SHA から描いた内容とファイルが違う（＝ファイルが自分について嘘をついている）
  - **`--strict` のときだけ赤**: pin した SHA 以後に再生成していないコミットがある。既定の `--check` は stderr に `note: … stale — N commit(s) since <sha> did not regenerate it` を出して **exit 0**、要約行は `file stale (note)`
  - **運用上の帰結**: fetch+rebase 後の再生成は**もう必須ではない**（前項の「打って commit しないと赤」は取り消し）。**提出 Release を切る 09-13 の手順が `node scripts/ethonline-commits-en.mjs` → `--check --strict`** に変わった（`RELEASE_NOTES_SUBMISSION.md` のチェック行・`LIVE_JUDGING.md` #4 前日パス）
  【実測】2026-09-09 09:30（`aeb338c` の clean worktree）: `node scripts/ethonline-commits-en.mjs --check; echo $?` → `333 commits (190 claimed, 3 claimed pre-window), 285 translated, 48 English, file stale (note), 0 problem(s)`・exit **0**（`aeb338c` 1 本が未再生成の note）／`--check --strict` → exit **1**。本項のコミットでも note が 2 本になるだけで赤にはなりません

### 3. 文書のみ

- **`7b5c58d` — `BAZANTIC_FEEDBACK.md` §4 #1/#3/#4/#5・§5 の 09-09 再計測。** 08:30–08:40 JST に同じ Gateway を測り直し、**0 mcent のツール（`info`・`getHealth`・`resolveQuery`・`getPayeeScore`）が未払いの MCP `tools/call` に本文を返す**ようになっていた（402 なし・settlement なし・橋は動かない）。09-06 の数字（110 calls・88 settled・88 本の 0-USDC tx）は**日付つきでそのまま残す**。#5 の「見つからなかった JWT」は Tom Hay の 09-09 Discord 回答（`bazantic.com/api-keys` で作る JWT を API key として使えば 402 を迂回）に置換。CLI の `--auth-type` は gateway 所有者側の upstream 認証設定と読み、当社の gateway は既定 `x402-mpp` のまま。`examples/ethonline-2026-ab/README.md` に EN+JA の 1 行。**Gateway が変わった理由については因果を主張していません**
- **`93df57e`＋`fd33a6b`** — Discord 定期走査で Bazantic の第 3 トラック賞 "Agentify a New API" が判明（`WINDOW_PLAN.md` 末尾 29 行＋本ファイル冒頭の 08:3x 項）。締切・審査日程に変更なし。**本ファイルの冒頭に既に記帳済み**（ここは件数の突合のために再掲）
- **`147d624`** — README §ETHOnline 2026 の「Start here」4 行＋前項（08:15）そのもの。SHA 確定

### 確かめ方（読み取りだけ）

- 件数: `git log --format='%h' e3f3170..aeb338c | wc -l` → **10**（本項の記帳 = `030ab2e`・`b063e9e`・`74fa047`・`aeb338c`・`17d4719`・`9dc22e6`・`7b5c58d`・`93df57e`・`fd33a6b`・`147d624` の 10。漏れ 0）
- 順序（first-parent）: `git log --first-parent --reverse --format='%h %s' e3f3170..aeb338c`
- plugin の起動先: `cat .claude-plugin/mcp.json`（`command` が `node`・args が `${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/dist/index.js`。**09-09 14:2x `9ea5991` で root `.mcp.json` から移設**——次項参照）
- typecheck 段: `grep -n '3c. typecheck' scripts/push-main.sh`
- 鮮度関門の 2 段階: `node scripts/ethonline-commits-en.mjs --check; echo $?`（note で 0）／`node scripts/ethonline-commits-en.mjs --check --strict; echo $?`（stale なら 1）
- CI: `gh run list --branch main --limit 3 --json headSha,conclusion`（【実測】`aeb338c`・`7b5c58d`・`9dc22e6` いずれも success）

---

## 2026-09-09 15:00 ハッカソン戦略 → vet402.com セッション: **今日 4 巡目——`aeb338c..690b4fc` の 7 コミット（本番ビルドが動く `next` 更新を含む）＋運用の申し送り 2 件**

範囲は前項の `aeb338c` の次から `origin/main`（`690b4fc`・CI `ci` success）まで。**そちらの手番が要るのは §4 (a) の cron 1 本だけ**（このリポではなく Takeshi_Automation 側）。本番 DB への ALTER も env の追加もありません。
**製品本体に効くのは 2 コミット**: `80fc6d5`（`next` 16.3.4＝本番ビルドが変わる）と `9328e69`（`src/app/ethonline/page.tsx` に 1 段落 6 行）。残りは tests・plugin 宣言・docs です。
確かめ方: `git diff --stat aeb338c..690b4fc -- src/`（【実測】2026-09-09 14:5x: `src/app/ethonline/page.tsx | 6 ++++++` の 1 行だけ）。

**決済経路について（名指し）**: `packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・`src/lib/observatory/*payer*`・`src/lib/db/schema.ts` は無変更。
確かめ方: `git diff --stat aeb338c..690b4fc -- packages/sdk/src src/lib/observatory src/lib/db/schema.ts`（【実測】出力なし）。`4b281ab` は `packages/sdk/test/` と `test-mutations.mjs` だけで、実装は 1 行も触っていません。

### 1. 本番の面に出るもの（2 コミット）

- **`80fc6d5` — `next` 16.3.0 → 16.3.4（GHSA-2xp9-vwfh-vxw4・GHSA-p293-qw3h-jr36）。** `npm audit --omit=dev` が 16.3.0 で critical 1（Image Optimization API の AVIF 入力による未認証 RCE）・high 1（`sharp` < 0.35.4）。`next/image` は使っておらず `images` 設定も無いが、最適化ルートは全 Next.js デプロイに在る。更新後 critical 0・high 0（moderate 5 は `@solana/web3.js` 経由の transitive・直すには semver-major）。lockfile の差分は `next`・`@next/swc-*`・`@swc/helpers`・`sharp` 0.35.3 → 0.35.4 と `@img/*`。【一次】コミット本文: `npm run build` exit 0・`tsc --noEmit` clean・root `npm test` 4 suites `fail 0`・judge-check 11/11。**本番は Vercel が `690b4fc` をビルドしているはず**——そちらで `curl -sI https://vet402.com/ | grep -i x-vercel` 等の実測をお願いします（こちらは 14:50 の `/api/health` → `200 {"status":"ok"}` 0.43 s までしか見ていません）
- **`9328e69` — `/ethonline` §1 に 1 段落。** 「The first command needs no key」の直後に、デモ CLI の `pay` と `refuse` は無料の Graph 鍵（`GRAPH_API_KEY`・`https://thegraph.com/studio`）が要り、`judge-check` は要らない、と 1 行で書いた（demo README と同じ内容）。断定語は無いので claims ゲートの登録は増えていない

### 2. 本番の面に出ないもの（コード・関門）

- **`9ea5991` — root `.mcp.json` を削除し `.claude-plugin/mcp.json` へ移設。** 内容は無変更（diffstat は `.mcp.json => .claude-plugin/mcp.json | 0` の rename）。`.claude-plugin/plugin.json` の `mcpServers` は `"./.claude-plugin/mcp.json"`。理由: リポそのものを `claude` で開くと root の `.mcp.json` を**プロジェクトの MCP 設定**として読み、`Missing environment variables: CLAUDE_PLUGIN_ROOT` と承認プロンプトを出していた（clean checkout の `claude mcp list` で再現）。移設後は `claude --plugin-dir <clone> mcp list` → `plugin:vet402:vet402 Connected`、clone 内の `claude mcp list` → `No MCP servers configured`（警告なし）。`plugin details` の MCP 件数は 0 と出るが、それは root ファイルしか数えない棚卸しの都合で、実行時には効かない。`tests/agent-skill-plugin.test.ts` は **root `.mcp.json` の存在を禁止**し、manifest の path が `./` 始まりであることを要求する。`skills/pay-or-refuse/SKILL.md` の Setup も新パス。**前項（09:30）の確かめ方 `cat .mcp.json` は無効になったので、本ファイルの当該行を `cat .claude-plugin/mcp.json` に直しました**
- **`a783dab` — `tests/prod-host-guard.test.ts` を新設＋A/B ハーネスの秘密フィルタを広げた。** 動機: 本ファイルの `:456` に本番 Neon の endpoint 名が**再掲**されていた（`bb56b1a` で消し、`10b9dc4` で再び貼っていた）。`<prod-host>` に置換し、規律では 2 回目を止められなかったので関門にした: `docs/**`・`README.md`・`SKILL.md`・`skills/**`・`src/app/**` を Neon の endpoint ドメイン（`aws` 配下の `neon.tech` 全体）と `\bep-[a-z0-9-]{20,}` の 2 形で走査（`\b` は docs.world.org の `#step-2-register-…` アンカーを誤検知しないため）。負の試行: 旧行を戻すとそのファイルだけで赤。**運用上の帰結: この台帳に本番 DB のホスト名を書くと root `npm test` が赤**（本項も書いていません）。同時に `examples/ethonline-2026-ab/src/secrets.mjs` の `SHAPE_PATTERNS` に JWT・`gh[pousr]_`/`github_pat_`・`npm_`・`postgres(ql)://user:pass@`・Neon のドメインの 5 形を追加（各 1 検出テスト＋誤検知なしテスト）。`0x` 無しの 64-hex は**意図的に足していない**（vet402 の `resourceId` がその形で、既存の raw log に 107 個ある）
- **`4b281ab` — SDK の境界表に文字列 `"0"` を追加し、変異 M45 を足した。** 敵対監査 A9（09-09）が `evaluateMoneyGate` の `units <= 0` を `units < 0` に変えても SDK suite が緑のままだった——表に数値 0 はあったが文字列 `"0"` が無く、402 の amount は文字列で届く。`units < 0` なら amount `"0"` の accept が signer に到達する。`test/_shapes.mjs` に `string-zero` 行（required）、`test-mutations.mjs` に M45。`node test-mutations.mjs` → `all 45 mutations killed`（A9 NEW2 が SURVIVED → KILLED）。**実装は無変更**

### 3. 文書のみ

- **`690b4fc`** — `WINDOW_PLAN.md` にあった ETHGlobal スタッフの私信（約 10 行・氏名つき）を 2 行の要約に置換（その後の決定は不変）。`PROMPTS/2026-09-08-day4-judged-surfaces.md` の `/Users/<name>/Downloads/…` 9 箇所を `<local>/Downloads/…`（`PROMPTS/README.md` に唯一の例外として記録）。`examples/ethonline-2026-demo/README.md` の `--live` install 行に実測版 `viem@2.56.3`（demo に lockfile は**意図的に置かない**——judge-check・CI・SKILL.md が install 無しで走らせる前提）
- **`1d71000`** — 前項（09:30）そのもの。SHA 確定

### 4. 運用の申し送り（コードに触れない・ハッカソン提出物には無関係・製品セッションの担当）

- **(a) 今朝 09:30 JST の cron 監視メール（Takeshi_Automation `state/ALERTS.md`）で vet402 関連 2 本。**
  - `com.kizuna.vet402-ledger-snapshot`（04:20）— **エラー死。** `logs/vet402_ledger_snapshot.log` 末尾: `PermissionError: [Errno 1] Operation not permitted: '~/Library/Mobile Documents/com~apple~CloudDocs/vet402-ledger-snapshots'`（`prune()` の `os.listdir`）。**DB 接続と COPY 段は通っている**（例外は COPY の後の iCloud 整理で出ている）ので台帳の写しは取れているが、iCloud 側の保持整理が毎朝止まる。launchd からの iCloud Drive アクセス権（Full Disk Access）か、保存先の変更が要る——**Takeshi の手番**
  - `com.kizuna.bazantic-gateway-drift`（08:30）— 監視は「痕跡が 09/08 09:30 から更新なし」と**無音死**判定したが、`logs/bazantic_gateway_drift.log` には `=== bazantic_gateway_drift === 2026-09-09 09:30 JST`・`食い違い: 0 件` の行が**在る**。launchd が 60 分遅れて走る型（Takeshi_Automation `c01aa09`「再登録で直らない・再起動のみ」）で、08:30 予定が 09:30 に走り、同じ 09:30 の watchdog が古い mtime を見た**誤検知**。Gateway の 56 tools と openapi.yaml の 56 operations は一致したまま。対処は不要
- **(b) `/api/health` の劣化の帰属——経路名つきの最初の行が入った。** 本番 `health_snapshots` を読み取りだけで引いた（【実測】2026-09-09 14:5x・`psql -Atc`）:
  ```
  SELECT checked_at AT TIME ZONE 'Asia/Tokyo', status, latency_ms, detail, instance
    FROM health_snapshots WHERE checked_at >= '2026-09-08 15:00+00' AND status <> 'ok' ORDER BY checked_at;
  2026-09-09 08:20:40 | degraded | 4460 | scoring=degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok fresh  | iad1:cfdd51db
  2026-09-09 08:34:42 | degraded | 6446 | scoring=degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok fresh  | iad1:6b7b5d56
  2026-09-09 08:36:38 | degraded | 3742 | scoring=degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok cached | iad1:6b7b5d56
  ```
  `deadline:wallet_metrics` は `src/lib/scoring/engine.ts` の `withDeadline(fetchWalletMetrics(...), SIGNAL_BUDGET_MS, "wallet_metrics")`（`SIGNAL_BUDGET_MS = 3_500`）が期限で落ちた、という経路名。落ちた入力は**買い手側のウォレット指標**（`src/lib/chain/wallet-metrics.ts` が上流 RPC から読む）で、前日の `feedback_stats` とは別の入力。3 行とも `payee` は ok。**言えるのはこの 3 行の帰属まで**——同じ日の 01:30 / 01:42 は `feedback_stats_unavailable`（経路未特定のまま）、04:01–04:02 は `payee=degraded cached: usdc_drain`（買い手側プローブの USDC 流出脚・別の脚）で、少なくとも 3 種の入力が別々に落ちている。会期後の改善対象として `WINDOW_PLAN.md`「会期後に必ず直すもの」に #6（wallet_metrics の締切超過）・#7（usdc_drain の cached 劣化）を足した。`LIVE_JUDGING.md` Q17 にも同じ実測を追記

### 確かめ方（読み取りだけ）

- 件数: `git log --format='%h' aeb338c..690b4fc | wc -l` → **7**（本項の記帳 = `1d71000`・`4b281ab`・`9328e69`・`9ea5991`・`80fc6d5`・`a783dab`・`690b4fc` の 7。漏れ 0）
- 順序（first-parent）: `git log --first-parent --reverse --format='%h %s' aeb338c..690b4fc`
- `next` の版: `grep '"next"' package.json` → `16.3.4`
- plugin の起動先: `cat .claude-plugin/mcp.json`（`command` が `node`・args が `${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/dist/index.js`）／`test ! -e .mcp.json && echo gone`
- ホスト名の関門: `npx tsx --test tests/prod-host-guard.test.ts`
- 変異: `cd packages/sdk && node test-mutations.mjs | tail -1` → `all 45 mutations killed`
- CI: `gh run list --branch main --limit 3 --json headSha,conclusion,workflowName`（【実測】`ci` は `690b4fc`・`9ea5991` ともに success。同時刻の `Dependabot Updates` に failure が 1 本あるが `ci` ではない）
- 健全性の行: 上の SQL（本番 DB は読み取りだけ）

## 2026-09-10 20:0x ハッカソン戦略 → vet402.com セッション: **`690b4fc..2994716` の 10 コミット（`SKILL.md` の live ブロックが鍵だけでは動かなかった件を含む）＋ The Graph の資格回答を正典化**

**前項が記帳した最後の SHA は `690b4fc`**（本ファイルの「2026-09-09 15:00」の項。`93df57e` は
`git merge-base --is-ancestor 93df57e 690b4fc` で祖先＝既に含まれている）。そこから `origin/main` までを
1 件も落とさず下に置きます。**製品本体に効くものを先に。**

### 1. コードが動いたもの（そちらが知るべき順）

- **`3aeb407` — `SKILL.md` の live ブロック 11・12 は、鍵を 3 本すべて export しても動かなかった。**
  clean clone で `payer_not_configured` になり `decision_record: null` を返し、**The Graph を一度も読まない**。
  原因は `resolvePayer()` が「鍵が在る **かつ** `packages/mcp-server` から `viem/accounts` が解決する」時にだけ
  signer を返すのに、**viem は `packages/mcp-server` の依存に意図的に入っていない**ので `npm ci` が持ってこないこと。
  `npm install viem` を足すだけで両ブロックとも紙面どおりの出力になった（2026-09-10・origin/main の clean worktree で実測）。
  - **`SKILL.md` の Build order に段 5 を新設**（`packages/mcp-server` で `npm install viem`・段 2 が持ってこない理由つき）。
    ブロック 11・12 の本文と鍵の表も「鍵 **と** viem」に直し、切り分けの 1 行
    （`node -e 'require.resolve("viem/accounts")'`）を添えた
  - **`scripts/skill-live-check.mjs` の `needs` が env 名だけでなく `module:<specifier>@<dir>` を取るようにした**
    （`createRequire` で**実解決を見る**。`package.json` の記載は見ない）。モジュール前提が欠けたブロックは
    「見ないまま素通り」でも「本番が壊れた」でもなく、**理由つき skip** になる。
    **会計は不変: 12 ブロック・6 印・6 skip。**
  - `packages/mcp-server/src/index.ts` は失敗要約の文言のみ（viem を先に出し、2 つのどちらが欠けたかは
    判別できないと明記）。**reason code・決済経路・依存は 1 つも変えていない。**
  - 会期後 TODO #10 に「`payer_not_configured` を『鍵が無い』と『signer モジュールが無い』へ割る」を積んだ。
    **会期中にやらない理由**: reason code の語彙を提出文・A/B オラクル・verdict 形テストが引用している
- **`f076122` — `refresh-numbers` に `guard` を新設。** `recorded` 型の印は「文書の中の印」としか
  突き合わせておらず、**測った元とはずれても永久に緑**だった。実害が出ていた——`4b281ab`（09-09 14:21）が
  変異 M45 を足した後も `--check` は 44 のまま緑。`guard: { command, why }` を `recorded` に付けられるようにし、
  `--check` が git/grep だけの安いコマンドで**ずれの検出だけ**を行う（**値は書かない**。印の意味は
  「変異の本数」ではなく「**全部殺せた**本数」で、grep の数を印に入れると生き残りが「N mutations, all killed」で
  出荷される）。`sdk_mutations` 44 → 45（clean checkout 実走 `all 45 mutations killed in 44.3s`）、
  `--refresh --only <id>` も追加（`as_of` を動かさずに 1 印だけ測り直す）
- **`1244663` — `commits-en` の判定を 2 段に割った。「遅れているだけ」は note、「自己矛盾」だけが赤。**
  `d0346b3` が対訳の無い日本語件名で入り、root `npm test` が赤 → main の CI 赤 → issue が開き、
  **リポの全セッションが push を失った**（1 ブランチが実際に待たされた）。

### 2. 文書のみ（提出物の文言に効く）

- **`d83e408` — Bazantic の JWT について Tom Hay は 09-09 に別々の 2 つを言っていた。**
  `d0346b3` は**他チーム（zkenk）宛の回答だけ**を読んで「JWT の迂回口は存在しない」と結論し、
  実際にレビュアー 1 名を誤らせた。(A) 我々宛＝ JWT は在る（bazantic.com/api-keys で作り、gateway の API キーとして
  送れば 402 を飛ばせる）／(B) zkenk 宛＝価格 0 の x402/MPP（毎回署名は起きる）。`WINDOW_PLAN.md` は (A) を先に、
  (B) を帰属つきで残し、日付つきの訂正注記を持つ。`SUBMISSION_DRAFT.md` の開発者フィードバック 4 も
  「docs にもダッシュボードのナビにも無い」へ直した（`BAZANTIC_FEEDBACK.md` §4 #5 と `LIVE_JUDGING` Q20 は
  `7b5c58d` 以来 (A) に忠実で無変更）
- **`e5e5914` — `/api/health` の劣化の帰属が 1 本確定した。** 09-10 02:59–04:00 JST の 11 行はすべて
  `feedback_stats_unavailable(deadline:getLogsChunked)`＝**内側 2,500 ms**（`src/lib/chain/erc8004.ts:222`）で、
  Q17 が寄っていた外側 3,500 ms ではない。**血の届く範囲も測った**: フラグは 1 箇所で立ち
  （`src/lib/scoring/engine.ts:327`）、届くのは agent-score 面だけ（15 点・risk 語が high）。
  SDK が実際に叩く 2 経路が到達する 81 ファイルに scoring engine・erc8004・feedback window は**無い**
  ——**この行が赤でもデモの verdict は動かない**。**コードは 1 行も変えていない**（会期中に上流を触らない）
- **`593c9e2` — `SUBMISSION_DRAFT.md` §I の「2 回叩けば block が進むのが見える」を削除。**
  自分の記録が反証していた（09-08 に連続 3 回とも block 51041641）。payee スコアを「安定」と呼んでいた
  内部注記 3 件も「動く」に訂正（提出日に §Z の差し替え段を飛ばさないため）
- **`08a7dd1` — 非公開スレッド（`#ticket-5926`）の運営回答の原文引用を、氏名なしの要約に置換**
  （`690b4fc` がメールに施したのと同じ処置の続き）。**裁定そのものと、そこから導いた決定は 1 つも変えていない。**
  公開チャンネル（`#information`・`#announcements`・`#partner-the-graph`）の帰属は対象外
- **`421cd05`** — 前項（09-09 15:00）の記帳そのもの。**`2994716`** — `COMMITS_EN.md` の再生成のみ
- **`d0346b3`** — Day 6 の Bazantic 探索（上の `d83e408` が訂正した版）。Tom Hay の「自作 API を
  ゲートウェイに載せるのも Agentify a New API に数える」・「Test Connection / Activate を 48 時間以内に直す」も同時に記録

### 3. 今回の変更（この記帳コミット自身・**docs のみ・コードは 1 行も触っていない**）

- **`PRIZES.md` §1.1 を新設**——The Graph（Continuity）の資格について **2026-09-10 18:46 に ETHGlobal から回答**が来た。
  質問（`Sen_web3`・09-07 06:17）と回答の**原文**、チャネル（`#partner-the-graph` の公開スレッド
  「Quick eligibility question for the AI」）、含意を置いた。**x402 Base subgraph を消費するだけで資格を満たす**
  ——MCP／エージェント面からの到達可能性は資格の条件ではない。**§1「資格の憲法」の直下に置いた**のは、
  資格に関する運営一次回答が既にそこに集まっているから（新しい置き場は作っていない）
- 同時に `PRIZES.md` §2 の「**08-25 回答が引き続き唯一の運営一次回答である**」を訂正（回答が 2 件になった）
- `LIVE_JUDGING.md` に **Q21「なぜ MCP まで作ったのか。SDK だけで資格は足りたのでは？」** を追加（20 件 → 21 件）
- **賞ページの評価軸は動いていない**（「The Graph を使いやすくする AI ツール」）。
  **MCP・Agent Skill・プラグイン・devcontainer は資格のためではなく差別化として維持する**、が執行部の判断。
  `WINDOW_PLAN.md` の資格要件表は 1 行も変えていない
- **提出フォームの文面には入れない。** 運営の回答を賞コメントに引用すると、作ったものでなく権威で押していると読まれる

### 運用上の帰結（そちらの push に効く）

- **未対訳のコミット件名は push を止めない。** 既定は `note: … [untranslated]` で exit 0、`--strict` でだけ赤。
  常に赤なのは**自己矛盾**だけ（Generated 行が無い／指す SHA が祖先でない／手編集で再生成結果と一致しない／
  `ja` が件名と違う・`en` に CJK が残る）
- **日本語件名を入れたら `docs/ethonline-2026/commit-titles-en.json` に英題を足すのが望ましい。**
  提出前の最終通し（`RELEASE_NOTES_SUBMISSION.md` / `LIVE_JUDGING.md` の手順）は `--check --strict` を通すので、
  対訳の穴はそこで赤になる。審査員が `COMMITS_EN.md` を読む以上、穴のまま出荷はしない
- **`SKILL.md` の live ブロックを clean clone で試すときは、鍵 3 本に加えて
  `npm install viem --prefix packages/mcp-server` が要る**（Build order 段 5）。
  切り分けは `node -e 'require.resolve("viem/accounts")'`

### 確かめ方（読み取りだけ）

- 件数: `git log --format='%h' 690b4fc..2994716 | wc -l` → **10**（上に列挙したのは
  `3aeb407` `f076122` `1244663` `d83e408` `e5e5914` `593c9e2` `08a7dd1` `421cd05` `2994716` `d0346b3` の 10。**漏れ 0**）
- 順序: `git log --format='%h %ad %s' --date=iso-strict 690b4fc..2994716`
- live ブロックの関門: `node scripts/skill-live-check.mjs`（12 blocks / 6 marked / 6 excused）
- 印の guard: `node scripts/refresh-numbers.mjs --check`／`cd packages/sdk && node test-mutations.mjs | tail -1` → `all 45 mutations killed`
- 対訳の判定: `node scripts/ethonline-commits-en.mjs --check`（note で exit 0）／`--check --strict`（赤）
- 資格の一次記録: `docs/ethonline-2026/PRIZES.md` §1.1

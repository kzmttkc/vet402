# vet402 RWA Instrument — Spec v3
日付: 2026-09-09
正本: このファイル。改正はセクション番号付きパッチだけ。
対象期間: 実装可能な決定と、今立てられる計画。需要・外部要因は書かない。

親: vet402.com
チェーン: Robinhood Chain 4663 / testnet 46630
評価: v2は「嘘をつかない方針」としては足りた。実装分岐が残っていたので、このミッションの「今決め切る」基準では100点ではなかった。v3は分岐を閉じる。

---

## 0. ミッション（実装対象の定義）

ウォレットの Stock Token 実績を、公開チェーンデータから再構成する。
自己申告 PnL を事実扱いしないための測定器。

作るもの: 読み取り、再構成、公開 facts ページ、facts API、提出用アンカー。
作らないもの: 実行、カストディ、トークン、税務、本体 `/score` への混入、公開面の ALLOW/WARN/BLOCK。

元の7条件への落とし方（計画として固定）:

| 条件 | この楔での具体 |
|---|---|
| 領域で上位 | カテゴリは「独立した Stock Token 実績の再構成」。実行でも残高表示でもない |
| 個人開発 | 3週間は HTTP + 1ページ + 1デコーダ。MCPとR2は10月 |
| ブルーオーシャン | 正本レジストリ + 8056 + 約定再構成の交差。残高UIは既にあるので入らない |
| マネタイズ/買収 | 既存 vet402 API キーに opinion を足す。新SKUは作らない。AUMフィーは設計しない |
| RH Chain を活かす | 正本トークン、8056、Chainlink、Uniswap v3/v4 のみを入力にする |
| 将来需要 | この文書の採点対象外。計画には残すだけ: 時系列と訂正ログを最初から書く |
| 複数の堀 | ①方法論バージョン付き時系列 ②accuracy/訂正 ③identity_binding ④既存 SpendGuard 呼び出し面。8056読みそのものは堀に数えない |

---

## 1. 観測単位

単位は `chain_id=4663` のアドレス1つ。
複数アドレスを合算しない。エージェント名は後付けマップ。

```
identity_binding: unknown | declared | bound
```

確立手順（v0）:

- 既定は `unknown`
- `declared`: 運用者がメッセージ
  `vet402-rwa-bind:${address}:${agentId}:${timestamp}`
  をそのアドレスで署名。保存する。`agentId` は任意文字列。合算には使わない
- `bound`: ERC-8004 Identity Registry の tokenURI 内 wallet 一致、または公式 Agentic Account の公開マップ。v0では実装しない。カラムは用意し、書き込みは禁止

公開ページのタイトルに「エージェント」を使ってよいのは `declared` または `bound` だけ。`unknown` はアドレス表記のみ。

---

## 2. 正本と小数

### 正本判定
トークンが正本である条件（両方）:

1. Robinhood 公式 Token Contracts ページのそのティッカーのアドレスと一致
2. 発行体ビーコン（EIP-1967）が公式レジストリ側と一致

ティッカー文字列だけでは正本にしない。Fletch 参照トークン、pools.fun、rh.fun 発行は `canonical=false`。見ても R0 の present に数えない。

凍結アドレス:

| 用途 | アドレス |
|---|---|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| NVDA/USD feed | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap v3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

Sushi v3 Factory `0xE51960f1B45f1C9FB6D166E6a884F866fC70433B` は v0 非対応。そこを通った約定は `other_unparsed`。

上表の factory / router / PoolManager は第三者記事由来を含む。実装初日に Blockscout で bytecode と公式 Uniswap deployments を突き合わせ、`packages/rwa/config.ts` に検証済みとして固定する。記事を正本にしない。一致しないアドレスは使わない。

レジストリ同期: 15分ごと。ソースは公式 docs の contracts ページ。ハードコードは上表のゴールデン用だけ。

### 小数と換算（これ以外の式を使わない）

| 量 | 内部 | 表示 |
|---|---|---|
| raw ERC-20 | uint256 | 整数のまま出さない。必要なら 18dec を小数文字列 |
| 株数 UI | raw * uiMultiplier / 1e18 | 小数8桁 |
| USD | 整数セント（int64） | 小数2桁 |
| equity feed | 8dec | — |
| USDG | 6dec | — |
| WETH | 18dec | — |

USD 評価（マーク）:

```
usd_cents = raw * feed_answer * 100 / 1e8 / 1e18
```

feed は multiplier 込み。`uiMultiplier` を価格に掛けない。
掛けた実装は Fixture A の反転テストで落とす。

株数表示:

```
shares = raw * uiMultiplier / 1e18
```

quote を USD にするとき:

- USDG: `usd_cents = usdg_amount * 100 / 1e6`（USDG=1USD と置く。乖離は v0 で見ない）
- WETH: そのブロックの ETH/USD feed。アドレスは公式 crypto feed リストから実装開始時に1行で固定。リストに無ければその lot は `cost_known=false`
- 正本 Stock Token が quote 側: そのトークンの equity feed（multiplier 込み）

Sequencer uptime feed は公式未掲載。ゲートに使わない。偽アドレスを入れない。

---

## 3. イベント分類（分岐禁止）

ログ1件を次のどれか1つにする。捨てない。

| type | 条件 |
|---|---|
| `transfer` | 正本トークンの ERC-20 Transfer。from または to が対象アドレス |
| `univ3_swap` | Uniswap v3 pool（factory=`0x1f7d…2EfA` 由来）の Swap。対象が token0 または token1 に正本を持つ |
| `univ4_swap` | v4 PoolManager 経由で、正本と USDG または WETH のプール |
| `other_unparsed` | 上記以外の、対象アドレスに関する正本残高変動 |

`other_unparsed` が1件でもある窓は R1 を `reconstructed` にできない。

ルーター経由で中の pool Swap が取れるなら `univ3_swap` / `univ4_swap`。内側が取れないなら `other_unparsed`。スキップ禁止。

v4 で hook が付いているプールは Swap イベントの amount を信じない。正本トークンの Transfer 両脚（入と出）を数量の正とする。Transfer と Swap が一致しないログは `other_unparsed`。

除外リスト（対象アドレスにしない）: 上表の factory / router / PoolManager / PositionManager / 既知プール。プールアドレスは factory の `getPool` と v4 PositionManager から解決して除外。

---

## 4. 原価と実現（FIFO 以外禁止）

- 原価法: FIFO。移動平均禁止。改正なし
- 対象トークンごとに lot を持つ
- 入口:
  - `univ3_swap` / `univ4_swap` で正本を受け取った: `cost_usd` = 支払った quote の USD
  - `transfer` で正本を受け取った（from ≠ 自分）: `cost_usd = null`（unknown）
  - `transfer` で自分から自分（同一アドレス）: 無視
- 出口:
  - swap で正本を渡した: FIFO で lot を減らし、`proceeds_usd - cost_usd` を実現。`cost_usd=null` の lot に当たったら、その口の実現は出さず `realized_status=partial`
  - transfer で正本を渡した: 数量だけ減らす。実現は出さない。残った unknown 扱い
- multiplier: イベントの block で `uiMultiplier()` をスナップショット。過去に今の multiplier を掛けない
- 未実現: 残 raw × 今の feed。週末でも数字は出す。`stale=true` を付ける
- MDD: 観測開始から各スナップショットの USD NAV のピーク対比。セント整数。feed stale の点は MDD に使わない
- 窓: v0 は「最初の正本タッチから今」。7d/30d は表示フィルタだけ。判定は全期間

`realized_usd` を公開してよい条件: Fixture B が CI を通っている、かつそのウォレットの R1 が `reconstructed` または `partial`。

---

## 5. R0 / R1 / R2 / R3

### R0
`present` = 窓の中で正本の Transfer または対応 Swap が1件以上。
`absent` = 正本活動ゼロ（API は 404）。
出力に `identity_binding` を含める。

### R1
```
reconstructed = other_unparsed==0 かつ unknown原価lotが残っていない かつ 必要スナップショット欠損ゼロ
partial      = 正本活動はあるが unknown原価 or other_unparsed>0
unverified   = デコード不能で残高変動の主因が説明できない / fixture B 未固定で実現を出せない場合の公開禁止
```

公開ページは status を出す。実現数字は B 通過後。

### R2
3週間スコープ外。フィールドは `no_declaration` 固定。クローラを書かない。

### R3（API のみ。公開ページに描かない）

キー付き `GET /api/v1/wallets/:address/rwa?opinion=1`

決定表（この順。上から最初に当たったもの）:

1. 正本以外を正本扱いしていたら BLOCK
2. method_version が現行と違う保存結果をそのまま出そうとしたら BLOCK（再計算するか 409）
3. R1 = unverified → BLOCK
4. 呼び出しが agent 文脈（`as=agent`）かつ binding = unknown → BLOCK
5. R1 = partial → WARN
6. equity feed stale または週末注記あり → WARN
7. other_unparsed > 0 → WARN
8. 約定（swap）件数 < 3 → WARN
9. 観測期間 < 7d → WARN
10. binding が declared または bound、かつ R1 = reconstructed、かつ stale=false、かつ other_unparsed=0、かつ swap>=3 → ALLOW
11. それ以外 → WARN

R1 が reconstructed でない ALLOW は禁止。実装で assert。

rubric_version: `rwa-r3-0.1`

---

## 6. Staleness

| feed | stale |
|---|---|
| equity / ETF | `updatedAt` が 26h 超、または `token.oraclePaused()==true` |
| ETH/USD | 1h 超 |

週末（UTC 土日）は `weekend=true` を付ける。数字は隠さない。
stale 中も `usd` は出す。`stale=true`。ALLOW 禁止。

改正（patch 009・2026-09-17 Takeshi 指示「オラクルが古いときは USD を出さない」）: **stale 中は `usd` と `unrealized_usd` を `null` にする。** `raw` と `shares_ui` は出す。`stale=true` と `stale_reasons`（`age` / `paused`）を付ける。上の「stale 中も `usd` は出す」はこの改正で失効。
公式 heartbeat 秒は未掲載なので 26h を v0 の固定値にする。改正するまで変えない。

---

## 7. API

Base: 既存 `https://vet402.com/api/v1`
認証: 既存 `Authorization: Bearer vouch_live_…`
公開 facts はキーなし。既存のキーなしレート（120/min）を流用。

### `GET /api/v1/rwa/facts/:address?chain=4663`

意見フィールドを置かない。置いたら仕様違反。

```json
{
  "address": "0x…",
  "chain_id": 4663,
  "as_of": "2026-09-09T05:00:00Z",
  "method_version": "rwa-recon-0.1",
  "identity_binding": "unknown",
  "r0": "present",
  "r1_status": "partial",
  "r2": "no_declaration",
  "tokens": [
    {
      "symbol": "NVDA",
      "token": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
      "canonical": true,
      "raw": "1000000000000000000",
      "shares_ui": "1.00000000",
      "usd": "225.89",
      "feed": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
      "feed_updated_at": "2026-09-08T18:00:00Z",
      "stale": false,
      "weekend": false
    }
  ],
  "events_summary": {
    "transfer": 2,
    "univ3": 4,
    "univ4": 0,
    "other_unparsed": 1
  },
  "realized_usd": null,
  "unrealized_usd": "225.89",
  "mdd_usd": null,
  "gaps": ["other_unparsed"],
  "evidence": { "txs": ["0x…"], "fixture_ids": ["A"] },
  "disclaimer": "Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens."
}
```

`realized_usd` は Fixture B 未通過なら常に null。

### `GET /api/v1/wallets/:address/rwa?chain=4663&opinion=1`

キー必須。body = facts + 

```json
"r3": {
  "recommendation": "WARN",
  "rubric_version": "rwa-r3-0.1",
  "reasons": ["r1_partial", "other_unparsed"]
}
```

`opinion=1` なしなら facts のみ（キー任意）。

### `GET /api/v1/rwa/catalog`
公開。`address, r1_status, as_of` の配列。上限50。

### `GET /api/v1/rwa/accuracy`
公開。fixture id、method_version、訂正1行以上を置ける表。最初は Fixture A/B の行だけ。

### エラー
| code | when |
|---|---|
| 400 `invalid_address` | EIP-55 でも 20byte hex でもない |
| 401 | opinion なのにキーなし（既存と同じ） |
| 404 `no_stock_token_activity` | 正本 Transfer/Swap ゼロ |
| 409 `fixture_b_missing` | 実現を出せる状態でないのに実現を要求 |
| 409 `stale_method` | 保存 method と現行が違う |
| 422 `unpriced_quote` | quote の USD 化不能 |
| 429 | 既存 |
| 503 `feed_unavailable` | latestRoundData 失敗 |

アドレスは小文字正規化して保存。表示は EIP-55。

---

## 8. データモデル

```
wallets(
  address pk,
  first_seen_block,
  binding,
  binding_evidence jsonb,
  updated_at
)

token_events(
  tx,
  log_index,
  address,
  token,
  type,
  raw_delta,
  multiplier,
  quote_usd_cents nullable,
  cost_known bool,
  block_number,
  unique(tx, log_index)
)

lots(
  id,
  address,
  token,
  raw_qty,
  cost_usd_cents nullable,
  opened_block,
  opened_tx
)

snapshots(
  address,
  as_of,
  usd_nav_cents,
  realized_usd_cents nullable,
  mdd_usd_cents nullable,
  r1_status,
  method_version,
  unique(address, as_of, method_version)
)

verdicts(
  address,
  as_of,
  r3,
  reasons text[],
  rubric_version
)
```

既存 x402 テーブルにカラムを足さない。

---

## 9. ジョブ

全チェーン走査はしない。

1. オンデマンド差分: facts 要求時、そのアドレスの最終同期ブロック+1から head まで、正本トークンと Uniswap ログだけ取る。同一アドレスは60秒キャッシュ
2. cron 1日1回 UTC 00:30: catalog にあるアドレスだけ再同期。catalog は手動追加 + リクエストされたアドレス
3. registry sync 15分: 正本リスト
4. アンカー: 提出前に1回。毎日打たない

```
anchor(bytes32 subject, bytes32 factsHash, uint32 methodVersion, uint64 asOf)
factsHash = keccak256(method_version | address | as_of | r1_status | realized_usd_or_null)
```

upgradeable にしない。トークンを持たない。

RPC: `https://rpc.mainnet.chain.robinhood.com`。失敗時だけ予備（実装開始時に1本決める。未決のまま複数投げない）。

---

## 10. UI（3週間は1枚）

`app/rwa/[address]/page.tsx`

出す欄だけ:

- アドレス（EIP-55）
- identity_binding
- 正本残高: 株数欄と USD 欄を分ける
- feed 時刻、stale、weekend
- r1_status
- events_summary
- realized（B 通過後かつ null でないとき）
- 証拠 tx リンク
- accuracy へのリンク
- 免責1段落

出さない: APY 入力、購入、入金、ALLOW/WARN/BLOCK、CTA、エージェントランキング。

公開コピー固定:

> このアドレスの Stock Token 実績を、公開データから再構成した記録です。投資助言ではありません。Stock Token の取得・売却・委任を勧めるものではありません。

禁止語（公開面）: 預けてよいか、おすすめ、安全、利回り、勝ち続け。

改正（patch 014・2026-09-28 Takeshi「vet402 は X 投稿も含めて全て英語で運用している」）: **公開面の文言は英語にする。** 上の日本語の固定文は、同じ意味の英語 "Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens, and not a recommendation to acquire, sell or delegate them." に置き換える。禁止語は英語の同じ意味の語に読み替える（"safe to deposit"・"recommended"・"safe"・"yield"・"keeps winning" を公開面に出さない。免責文の否定形 "not a recommendation" は除く）。表示するものと表示しないもの（ALLOW/WARN/BLOCK・CTA・ランキングを出さない）は変えない。

改正（patch 015・2026-09-28）: **入口 `/rwa` を足す。** 動画と提出文の結び "Paste any wallet into vet402.com/rwa" が本番で 404 だった（実測 2026-09-28）。`/rwa` は入力欄 1 つの GET フォームだけを持ち、貼られた文字列（アドレス・エクスプローラの URL・/rwa の URL）から最初の 20 バイトのアドレスを取り出して `/rwa/<checksum address>` へ 307 で送る（`packages/rwa/entry.ts`、tx hash はアドレスとして拾わない）。特定のウォレットへのリンク・例示アドレスは置かない。記録の表示と §10 の制限は `/rwa/[address]` のまま。

改正（patch 016・2026-09-28 Takeshi「全て推奨で進めて」）: **デモのアドレス `0xE9B0…EC25f` は第三者のもの（本人の了解なし・`identity_binding: unknown`）だが、動画・提出フォームの frontend 欄・anchor・Fixture B ではそのまま使う。** 公開チェーンの記録であり名前を出さないこと、「誰のウォレットでも読める」ことが製品そのものであることが理由。LP など自社の宣伝面からは特定のウォレットへ直リンクせず `/rwa`（入口）へ向ける。HackQuest のプロジェクトページは同日に書き換え済み（他大会の名前を外し、Fundraising は "No plans." だけ、デモ動画を直接アップロード、MVP リンク `https://vet402.com/rwa`）。提出（Submit Project）は 9/29〜10/1。

改正（patch 017・2026-09-28 Takeshi「全て OK」）: **facts JSON に有料の別ルートを足す。無料のルートは変えない。** `GET /api/v1/rwa/paid/facts/:address` は x402 v2 の `exact`（USDG に EIP-3009 が無いので `assetTransferMethod: permit2`、spender は x402ExactPermit2Proxy `0x402085c2…0001`、witness.to は受取人）で 0.01 USDG（`10000` atomic、Dexter の 4663 の下限は `6072`）を受け取り、無料ルートと同じ JSON を返す。受取人は RwaAnchor を打った `0x973cD8a9…6227`、facilitator は Dexter（4663 を対応一覧に載せている公開 facilitator は Dexter だけ、2026-09-28 実測）。順序は verify → 再構成 → settle。再構成できなかった要求（404・503）は決済しない（`charged: false`）。有料側の制限は 60/分/IP（無料は 10）。意見・スコアは足さない。`/score`・x402 observatory の payer は import しない（受け取り側は新規の `packages/rwa/x402.ts`）。支払い1回は Takeshi が自分の財布で `packages/rwa/scripts/pay-facts.ts` を打つ（私はお金を動かさない）。お金を払わない試し（捨て鍵）では、ルートの 402 と Dexter の `permit2_insufficient_balance` を確認した（形式ではなく残高で断られた）。　独立レビュー（BLOCK）を受けた直し: settle を送った後は、facilitator が `success: false`（送金なし・402）と答えた場合を除き、記録を必ず返す（5xx・JSON でない応答・中断は `X-Payment-Status: unknown` の 200）。受け取る前に、条件（金額はちょうど 0.01、spender はプロキシ、witness.to は受取人、期限は60秒以上先）と Permit2 の署名をこちらで照合し、偽のヘッダーでは facilitator を呼ばない。settle を始める期限は要求の開始から38秒。

改正（patch 018・2026-09-29 Takeshi「全銘柄への対応もいれたい」「常に質と精度」）: **`rwa-recon-0.2`。正本は NVDA だけでなく、Robinhood 自身の一覧にある 195 銘柄。** 一覧は https://docs.robinhood.com/chain/contracts の表（「on-chain asset registry から生成」、同じ表示名でも別アドレスは Robinhood の Stock Token ではない、と明記）の元データ `api.robinhood.com/rhj/assets` を `packages/rwa/registry.json` に日付つきで凍結し、全アドレスの symbol()・decimals() をチェーンで照合（195/195 一致）。価格は Chainlink の公式ディレクトリ（`feeds-robinhood-mainnet.json`）の equity feed 33 本を、各 feed の description() が銘柄名を指すことを確かめて対応づけた。feed が無い銘柄は株数だけ出し `usd_reason: no_feed`。範囲はレコードの `scope` に書く: as_of で保有している銘柄・NVDA・それらの取引が動かした正本銘柄。保有していない銘柄で開いて閉じた建玉はまだ走査しない（`gaps: exited_positions_not_scanned`、黙って落とさない）。公開 RPC は複数アドレスのログ検索を受け付けず（2026-09-29 実測）、Alchemy の無料枠はログ検索が 10 ブロックまで（同日実測）なので、残高は Multicall3 で 195 本を 1 回で読み（0.5 秒）、履歴は保有銘柄ごとに読む。FIFO は銘柄ごと。株と株を直接交換した取引は、USDG の片側を 2 銘柄に割り振れないので値付けしない（推測しない）。top-level の `replayed_raw` は各 token の中へ移した。v4 のプールは PositionManager.poolKeys で引き、`keccak256(abi.encode(PoolKey)) == poolId` を確かめた時だけ採る（無ければ Initialize ログ）。デモの財布は NVDA と QQQ の 2 銘柄になり、NVDA の実現損益 −113.98 は 0.1 と一致、Fixture A の数値もすべて一致。　独立レビュー（BLOCK）を受けた直し: `scope.scanned` は履歴を読んだ銘柄だけにし、取引の中で見つかっただけの銘柄は `scope.history_not_walked` と gap `history_not_walked` に分けた（探索は最大 3 周）。受け払いの再生が残高と合わない記録は `r1_status: unverified`、どの lot にも当たらない売りは `partial`。ページの要約は、値付けできない売りがあるとき「値付けできた売りの分」と書き、合計だけを出さない。

改正（patch 019・2026-09-29 監査 rwa-audit-2026-09-29.md、Takeshi「指摘の部分だけ完璧に修正」）: **審査員の最初のクリックで落ちないための直し。機能は足さない。** ① facts JSON は CDN に 5 分置き、以降は 1 日まで古い版を返しながら裏で作り直す（`RWA_FACTS_CACHE_CONTROL`、エラーは置かない）。記録ページはまずその CDN の JSON を読み（12 秒で見切り）、取れない時だけ自分で作り直す。同時に開いたページと JSON が同じ答えを返す。上限（同時 1 本・10/分/IP）は上げない。② `/rwa` 入口に README と同じ「30 秒の道」（デモの記録へのリンク・195 銘柄・3 つの損益の意味・アンカー・x402 の初回決済 tx）を置く。patch 015 の「入口に例示アドレスを置かない」はこれで改める（デモの財布は提出物ですでに公開しており、patch 016 のとおり第三者の財布だが名前は出ない）。③ `/rwa` 面から親の `/accuracy`（ALLOW/WARN/BLOCK の率）へのリンクを外し、README へ向ける。④ 記録ページの `identity_binding` 表示を外す（JSON の項目は残す）。⑤ 記録ページに「このページはチェーンからの再計算で、アンカーした記録ではない」と書き、デモの財布ではアンカーした記録（block 74267752・rwa-recon-0.1・tx）を示す。⑥ 要約は「31 of 85 movements not decoded」のように分母つきで出す。⑦ 損益の 3 つの数字（−9.62・−113.98・−284.57）の意味を入口・README・提出文で 1 文にする。

Amendment (patches 020 to 023, 2026-09-30): **`rwa-recon-0.3`.** Four changes built in parallel and merged on branch `rwa-integrate`. Any wallet gets a stated answer (020). The record names the look-alike tokens a wallet met and never counts them (021). Each token lists its corporate actions (022). The anchor hash binds the whole record from 0.3 on, and anyone can check it without a key (023). The patch texts follow as written, headings moved down two levels. The files stay in `docs/rwa/spec-patches/`.

Integration notes (2026-09-30):

- The Alchemy endpoint is `RWA_ALCHEMY_URL`, else `ALCHEMY_API_KEY` on `https://robinhood-mainnet.g.alchemy.com/v2/`, else none. The key alone serves only `alchemy_getAssetTransfers` and `alchemy_getTokenBalances`. The plain reads stay on `RWA_RPC_URL` or the public RPC. Where 020 says "with `RWA_ALCHEMY_URL`", read "with an Alchemy endpoint".
- A 401, a 403 or a "network not enabled" answer is a refusal. It is not retried, the endpoint is left out for 10 minutes, and the record takes the public path with its gap (`exited_positions_not_scanned`). No error, log line or record carries the URL or the key.
- Patches 020 and 021 share one Alchemy read: every ERC-20 transfer to and from the wallet, both sides, two calls. Discovery keeps the canonical tokens from it and the look-alike search judges the rest. Past the page cap, discovery asks again with the canonical contracts as a filter.

### SPEC patch 020: any wallet gets a fast, stable, honest answer

Status: proposed on branch `rwa-w1-reach`. Merges into SPEC §5, §7, §9 and §10.
Method version: the integrator bumps it once to `rwa-recon-0.3`. This patch
changes scope only when `RWA_ALCHEMY_URL` is set.

#### Why

Measured on 2026-09-30 in production by the sprint audit. The operator wallet
`0x973cD8a91A771C2C04C6036888F8175D6b4F6227` holds no Stock Token and got three
different answers in a row: 503 `too_busy`, then 404 after 6 s, then 503
`feed_unavailable` after 35 s. `/rwa/0x…dEaD` waited 45 s and said "Reading the
chain failed". A judge who pastes their own wallet most likely holds no Stock
Token, so this is the first answer most of them see.

Causes found in the code:

1. The empty answer (404) was not cached, in memory or at the CDN. Every paste
   walked NVDA's full history again: 16 `eth_getLogs` on the public RPC, which
   answers item-level 429 to bursts.
2. The page asked the facts route first. On a 404 or 503 it then rebuilt the
   record itself, so one page view could cost two walks.
3. A timed-out reconstruction released its in-flight slot while its reads kept
   running. The next request started another walk beside it, drawing more 429s.
4. Any failure, including an RPC timeout, was reported as `feed_unavailable`.

#### §5 scope (only with `RWA_ALCHEMY_URL`)

With `RWA_ALCHEMY_URL` set, the transactions to replay come from
`alchemy_getAssetTransfers` (category `erc20`, `excludeZeroValue: false`, the
195 canonical addresses as `contractAddresses`, split 100 per request, one query
for `fromAddress` and one for `toAddress`, every `pageKey` followed, `toBlock` =
`as_of_block`). Scope becomes every canonical token that ever moved to or from
the address, plus tokens held at `as_of`. `scope.rule` says so, NVDA gets no
special case, and `exited_positions_not_scanned` is not listed.

Receipts, balances, feeds and the replay invariant are unchanged: every event
still comes from the receipt, and `replayed_raw` must equal the chain balance.
If the Alchemy call fails, the reconstruction falls back to the log walk and
the record carries the old rule and the gap.

Without `RWA_ALCHEMY_URL` nothing about scope changes.

#### §7 errors

| code | when |
|---|---|
| 404 `no_stock_token_activity` | holds none of the canonical tokens and no history in scope. The body states what was checked (below). Cached like a record: `s-maxage=300, stale-while-revalidate=86400` |
| 422 `wallet_too_large` | one request cannot rebuild it: more than 6 tokens to walk on the public RPC (16 log queries each), or more than 600 transactions to replay with Alchemy. The body lists the held symbols and the limit hit. Cached like a record |
| 503 `too_busy` | another wallet is being rebuilt on this instance. `Retry-After: 30` |
| 503 `still_reading` | the read took longer than the free deadline (20 s). It keeps its slot and runs on, and a retry joins it. `Retry-After: 30` |
| 503 `chain_unavailable` | the chain RPC failed. `Retry-After: 60` |

Every 503 body is `{ error, retry_after_sec, detail }`. The paid lane keeps its
own codes and its 45 s deadline (money code, not changed here).

404 body:

```json
{
  "error": "no_stock_token_activity",
  "address": "0x…",
  "chain_id": 4663,
  "as_of": "…",
  "as_of_block": 0,
  "method_version": "…",
  "registry_tokens": 195,
  "held_tokens": 0,
  "history_checked": "every_canonical_token | nvda_only",
  "sent_tx_count": 0,
  "is_contract": false,
  "gaps": ["exited_positions_not_scanned"],
  "detail": "Holds none of the 195 canonical Stock Tokens at block N. …"
}
```

`nvda_only` means the 195 balances at `as_of_block` (one Multicall3 call) and
NVDA's incoming transfers were read. Every way of holding a token starts with a
Transfer to the address (a mint is a Transfer from 0x0), so the receiving side
alone decides whether NVDA was ever held: 8 log ranges instead of 16. When it
finds something, the full walk runs as before. `sent_tx_count` is the nonce at
`as_of_block`, null for a contract.

`0x…dEaD` holds 74 of the 195 tokens (measured 2026-09-30, one Multicall3
call). On the public RPC that is 74 × 16 = 1,184 log queries, which no request
under Vercel's 60 s can finish. Measured locally with the old code it failed
with 429 after 91 s, and after 178 s with the reach code before this limit.
It now gets `wallet_too_large` at once. The limit of 6 comes from the same day:
2 tokens took ~40 s cold and 8 tokens ~140 s on the public RPC.

A cheaper test for "any past Stock Token activity" on the public RPC was checked
and is not available: an `eth_getLogs` without an address filter is capped at
30,000 blocks per query (measured 2026-09-30, head ~76.06M), so one side for all
tokens would take ~2,500 queries. The 404 says what it did not scan instead.

#### §9 jobs and RPC

- Read RPC, chosen at call time: `RWA_ALCHEMY_URL`, else `RWA_RPC_URL`, else
  `https://rpc.mainnet.chain.robinhood.com`. The paid lane uses the same
  choice, so it reads through the third-party RPC whenever one is set. The
  public fallback stays for head reads only. An env value that is not an
  `https://` URL is ignored. Scripts that write the RPC into fixtures keep the
  public URL.
- A transport error carries only its error name, never the URL (it may hold a key).
- A provider whose log span limit would need more than 64 ranges for a genesis
  walk is refused at once (`log span limit too small`).
- Cache: the empty answer is cached like a record. A caller stops waiting at its
  deadline (free 20 s, paid 45 s). The reconstruction keeps its slot until it
  ends, or until 55 s, whichever is first. The free route keeps the function
  alive with `after()` so the retry finds the result. Rate limits and the
  one-at-a-time cap are unchanged.

#### §10 UI

- `/rwa/<address>` with no Stock Token renders the stated answer with status
  200 and links to example wallets. It no longer shows Next.js's 404 page.
- Every failure renders one view: the reason, the wait, and a
  `<meta http-equiv="refresh">` with that wait.
- The page uses the route's own 404 and 503 answers as final. It reads the chain
  itself only on a transport miss or a 429 from the shared bucket.
- `/rwa` lists "Try these wallets": EOAs picked from chain data that traded
  canonical tokens through the official Uniswap pools and rebuild as
  `reconstructed` or `partial` with the replay on the chain balance
  (`packages/rwa/examples.ts`). The note says what the record shows, never who
  owns the wallet.

#### Tests

`packages/rwa/test/reach.test.ts` and `packages/rwa/test/cache.test.ts`: RPC
precedence and call-time choice, no URL in transport errors, the span guard,
the Alchemy client (params, chunks, pages, both sides, balances), the empty
answer on both paths and its stability, a sold-out position found through
Alchemy with the gap dropped, the unchanged path without Alchemy, the fallback
when Alchemy fails, the route's 404 and 503 bodies, the negative cache, and the
slot kept past the deadline.

### Patch 021: the chain confirms the list, and a record names the fakes a wallet met

Status: proposed on branch `rwa-w2-lookalike` (2026-09-30). The integrator merges it into SPEC.md and bumps `METHOD_VERSION` once for the sprint. This patch does not bump it.

#### Why

Robinhood's own page says a token with a matching name or ticker at another address is not a Stock Token. /rwa already counted only the 195 addresses in Robinhood's list. Two things were missing.

1. The list was the only root. Nothing in the record showed that those addresses are what Robinhood Chain itself says Stock Tokens are.
2. A wallet that received a fake saw nothing about it. The fake was silently left out of the PnL, which is right, but the reader was never told it was there.

#### 1. Second root for the registry

`packages/rwa/registry.json` now carries, for each of the 195 tokens:

- `code_hash`: keccak256 of `eth_getCode`
- `beacon`: the EIP-1967 beacon slot (the runtime code embeds the same address)
- `factory_log`: the Stock Token factory's deployment event that names the token (block, tx, log index)
- `needs_review`: why the on-chain identity disagrees, empty when it agrees

and a top-level `identity` block with the reference values (`packages/rwa/identity.ts`): code hash `0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630`, beacon `0xe10b6f6B275de231345c20D14Ab812db62151b00`, factory `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046`, deployment event topic0 `0xd9b0c6a1…a76d6`, and the beacon's current implementation.

Measured at block 76057945 with `npx tsx packages/rwa/scripts/snapshot-registry.ts --identity-only`:

- 195 of 195 tokens have the reference code hash
- 195 of 195 have the reference beacon in the EIP-1967 slot
- 195 of 195 are named by a factory deployment event (the factory emitted 204 such events in total)
- 0 need review

`--identity-only` adds these fields to the existing snapshot. It does not fetch Robinhood's list again, so the token set and every count stay as they were (`taken_at` is unchanged). A full rebuild runs the same identity step. A token whose code hash or beacon differs, or that no factory event names, is written with `needs_review` and a reason. It is never silently dropped and never silently trusted. `packages/rwa/test/registry.test.ts` pins 195/195/195 and 0 needs review.

A code hash alone is not proof. Anyone can deploy the same proxy bytecode pointing at the same beacon. The factory event is the second root. Membership still comes from Robinhood's list.

#### 2. Look-alike judgement (`packages/rwa/lookalike.ts`, pure)

Input: a token's address, symbol, name and code hash. Output: `lookalike`, `needs_review`, `imitates` (a canonical ticker or `USDG`), and reason codes.

A token at a canonical address, or the real USDG, is never a look-alike. Any other token is a look-alike when it does at least one of these:

| reason | meaning |
|---|---|
| `symbol_copies_stock_token` | the symbol is a Stock Token ticker as written |
| `symbol_disguises_stock_token` | the symbol becomes a ticker after NFKC, removing invisible characters (Unicode default-ignorable, format controls, braille blank, combining marks), folding digit 0 to O and Cyrillic/Greek homoglyphs to Latin, and upper-casing |
| `name_copies_stock_token` | the name, without a Robinhood ending, is a Stock Token's company name |
| `name_claims_robinhood_stock_token` | the name ends in "Robinhood Token", "Robinhood Coin", "Robinhood Stock", "Robinhood Share(s)" or "Robinhood Stock Token", with or without a separator |
| `imitates_usdg` | the symbol or name becomes USDG or "Global Dollar" after the same normalisation |

Extra reasons explain how: `hidden_characters`, `confusable_characters`, `code_hash_differs` (not the Stock Token code), `mimics_counterparty` (address poisoning, below), and `not_canonical_address`, which every look-alike carries.

A non-canonical token that carries the Stock Token code is `needs_review` with `reference_code_not_listed`. It is not called a fake, because it may be a delisted token or a proxy pointed at the issuer's beacon. It is not counted either way.

Address poisoning: a transfer whose other side shares the first four and last four hex digits of an address the wallet really exchanged USDG with, without being it.

A check that starts from tokens named "... Robinhood Token" never sees the "NVIDIA Robinhood Coin" NVDA that reached the demo wallet. Here it is caught by ticker, by company name and by the "Coin" ending.

#### 3. In the record

Two new top-level fields in the facts JSON:

- `lookalikes`: one entry per look-alike token met, with `token`, `symbol_raw` and `name_raw` (every code point outside printable ASCII shown as ⟨U+XXXX⟩, the bullet excepted), `imitates`, `reasons`, `needs_review`, `direction` (`received`, or `sent` when a log names the wallet as sender), `counterparty`, `mimics`, `first_seen_block`, `tx`, `amount_raw`, `transfers_seen`, `counted: false`, `found_by`.
- `lookalikes_scope`: `complete`, `searched` (each source with its block range and a plain description), `not_scanned` (plain words for every part not searched), `tokens_judged`, `tokens_not_judged`.

Look-alikes are never counted. The classifier reads canonical addresses only. `packages/rwa/test/lookalike-scan.test.ts` adds a fake NVDA transfer to Fixture A's own receipts and checks that `tokens`, `events_summary`, `realized_usd`, `unrealized_usd`, `r1_status`, `gaps` and `evidence` are identical with and without it, and that the fake is listed with `counted: false`.

`anchorPreimage` is unchanged. The anchored hash does not cover these fields.

##### How the search works

Measured on 2026-09-30: a Transfer log query without an address filter is capped at 30,000 blocks on the public RPC. A full-history search for one wallet, run on 2026-09-30 for the demo wallet, took 5,081 such queries (about 55 minutes) with no error left. About 1,000,000 blocks pass every 27.9 hours (block 76056458 minus 1,000,000 blocks = 100,569 seconds). So a live record cannot search the whole chain on the public RPC.

In order of preference:

1. `RWA_ALCHEMY_URL` set: `alchemy_getAssetTransfers` with `toAddress` and again with `fromAddress`, category `erc20`, no contract filter, every page up to `as_of_block`. Scope `complete` when both finish. The client is `packages/rwa/alchemy.ts`. The key in the URL is never logged, never in an error message and never in the record (tested with mocked responses shaped like Alchemy's published examples. No key exists yet).
2. Otherwise, three partial sources, each named in `searched`:
   - `receipts`: non-canonical Transfer logs naming the wallet in the transactions the record already read
   - `recent_logs`: Transfer logs naming the wallet as sender or recipient, no address filter, over the last 4 x 30,000 blocks (about 3.3 hours), newest span first, one query at a time. The public RPC refused a batch of these queries as a whole but answered single ones spaced a few hundred milliseconds apart (2026-09-30: 7 of 8 single queries answered at 0.3 s spacing, 2 of 4 batches of two). The window counts only the spans read without a break from the head down and says where it stopped.
   - `fixture`: a full-history search done ahead of time, `fixtures/rwa/lookalikes-demo.json` for the demo wallet, with its source and last block
   Anything outside those ranges is listed in `not_scanned`. When the fixture reaches from block 0 to the start of the recent window, the scope is `complete`.

The search runs after every read the record needs, pool lookups included, so it never competes with them for the RPC's rate limit and cannot make them fail. It has an 8-second budget, shrunk so that it ends by 38 seconds after the reconstruction started (the record's deadline is 45 s). A record whose own reads took 38 s or more gets no live search, only the fixture, and says so. The search never fails the record. A refused or slow RPC is written into `not_scanned`. Measured on the demo wallet on 2026-09-30 with `scanLookalikes` alone: 1.4 s, 3.2 s and 2.5 s in three runs, each `complete: true` with both look-alikes below. Whole reconstructions of the demo wallet on 2026-09-30, alternating the code before this patch and after it, three runs each: before 31.0 to 81.7 s with one HTTP 429 failure, after 32.7 to 61.1 s with one HTTP 429 failure. Other jobs were sharing the public RPC at the time, so these runs cannot isolate the search's own cost. By construction it adds at most 8 s, and nothing once 38 s have passed.

Before a demo, walk the fixture forward: `npx tsx packages/rwa/scripts/lookalikes-fixture.ts --extend fixtures/rwa/lookalikes-demo.json`.

##### The demo wallet (0xE9B08727131E34010b34006c660D4c1B436EC25f)

Full search, blocks 0 to 76081226, 315 Transfer logs, 34 non-canonical tokens met, 2 look-alikes. Each kept log was checked against its transaction receipt.

- `0x5DD716Fe12275B69f04b26bEeca343843C8e3539`, symbol `NVDA`, name "NVIDIA Robinhood Coin". 25 tokens (raw 25000000000000000000, `decimals()` 18) sent to the wallet at block 73953009 (2026-09-27 12:52 UTC) in `0x1b838f40…77b51b`, signed by `0x3433e16e…abd0`. Reasons: ticker, company name, "Coin" ending, code hash differs.
- `0x4190Ee598c2a69D35Bef53c83d152Ae0f25EA416`, symbol and name `U⟨U+17B5⟩S⟨U+17B5⟩DG` (Khmer inherent vowel, invisible). A log at block 63379129 in `0x63c6fdd0…a01e`, signed by `0x3ea4ee9d…c286`, not by the wallet, shows the wallet sending 10 (raw 10000000, `decimals()` 6) to `0x1eb99afa…77c3`. That address copies the start and end of `0x1eb96a9c…77c3`, which the wallet really paid 10 USDG (raw 10000000, USDG has 6 decimals) at block 62621590. Reasons: imitates USDG, hidden characters, mimics a counterparty.

The other 32 tokens (PONS, `P0NS`, `PO⟨U+200B⟩NS` and similar spam) copy nothing canonical and are not listed.

#### 4. On the page

`/rwa/[address]` gets a short section "Look-alikes this wallet received (not counted)". Each entry shows the escaped symbol and name, what it pretends to be, the reasons in plain words, the first transaction, and links to Blockscout. Address poisoning reads "A fake USDG transfer made to look like a payment to a real counterparty", then names both addresses. The section ends with what was searched and what was not. A record made before this patch renders no section.

#### Money code

The paid route returns the same JSON, so it now carries `lookalikes` and `lookalikes_scope`. `packages/rwa/x402.ts` and the paid route's code are not changed. It ships after an independent review says SHIP.

### Patch 022: corporate actions in the record

Status: branch `rwa-w3-corpact`, for the integrator to merge into docs/rwa/SPEC.md. Method version is not raised here (the integrator raises it once to `rwa-recon-0.3`).

#### What changes

Each token in the facts JSON gains `corporate_actions[]`: every `UIMultiplierUpdated` the token emitted from genesis up to `as_of_block`, with what this wallet held at that moment. The record page gains a short section, "Corporate actions while this wallet held the token".

Nothing else in the record moves. FIFO still runs on raw quantities and USD, the Chainlink price still carries the multiplier, and `realized_usd` is the same with or without this patch (pinned by a test on recorded chain data, see below).

#### The event

A Stock Token records a split or a reinvested dividend by changing its UI multiplier, not the raw balances. Shares shown to a person are `raw × uiMultiplier / 1e18`.

- Signature: `UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt)`, no indexed fields.
- topic0: `0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055` (viem `toEventSelector`, checked 2026-09-30).
- How the field order was checked: the NVDA update in tx `0x4ac23f2e58e2c4962dcd701c2beff581e87f3995152a29d527c07a3afd67d956` (block 58,952,659) carries the words `1e18, 1000775159164630595, 1788998430`. The same transaction calls `updateMultiplier(uint256,uint256)` (selector `0xbad60f18`) with `(1000775159164630595, 1788998430)`. So word 0 is the multiplier before, word 1 the multiplier after, word 2 the unix time it takes effect (2026-09-10T00:00:30Z, about 10 minutes after the block at 2026-09-09T23:50:42Z). The QQQ update in tx `0x6331915e6ddac124b1ea59b0db720892615fbd8ffbbea59cc9772147e326bba6` has the same shape.

#### Where the history comes from

The public RPC cannot answer `eth_call` at an old block, so past multipliers exist only in these logs. It also refuses a log query without an address over more than 30,000 blocks (measured 2026-09-30: "only 30000 are allowed for this request; narrow the block range, or add an address filter"), so each token is its own filter, in the same 10,000,000-block chunks as the Transfer walk.

Logs never change once written, so /rwa keeps them in two layers:

1. `packages/rwa/corporate-actions.json`: a frozen walk of all 195 canonical tokens from genesis to block 76,083,561 (taken 2026-09-30T00:23:57Z), rebuilt by `packages/rwa/scripts/snapshot-corporate-actions.ts`. The script refuses to write if, for any token, the multiplier the logs predict (1e18 before any update, else the last `after` once in effect) differs from `uiMultiplier()` read at that block. Result on 2026-09-30: 46 updates on 43 of the 195 tokens, 0 still scheduled, 0 mismatches. An earlier independent walk of all 204 factory tokens (same day, to block 75,997,569) found 50: the same 45 on canonical tokens plus 5 on WEEK, which is not in Robinhood's list. The one update it did not have is MPWR at block 76,070,684, emitted after it ran.
2. A per-instance memo of the tail. A reconstruction asks the chain only for `to_block + 1 .. as_of_block`, one range per token in scope, batched four per JSON-RPC call. For the demo wallet (NVDA and QQQ) that is one extra POST. A token missing from the frozen walk is read from genesis.

#### Fields (per token, `corporate_actions[]`, chain order)

| field | meaning |
|---|---|
| `block`, `tx` | where the update was emitted |
| `time` | ISO time of that block |
| `effective_at` | ISO time from which the token applies the new multiplier, as emitted |
| `multiplier_before`, `multiplier_after` | 18-decimal integers as strings |
| `ratio` | `after / before`, 18 places, trailing zeros cut. A number only. /rwa does not name it "split" or "dividend", because the event does not say which |
| `held` | the wallet held the token right after the update transaction. `null` when the token's history was not walked (`scope.history_not_walked`) |
| `wallet_raw_at` | raw balance from replaying the wallet's own classified events up to the update's position (block, then log index). The same replay FIFO uses |
| `wallet_shares_before`, `wallet_shares_after` | `wallet_raw_at × multiplier / 1e18`, 8 decimals |

Updates while the wallet held nothing stay in the list with `held: false`. The list is the token's history, not a filtered view.

`wallet_raw_at` is the holding at the update transaction, not at `effective_at`. A trade inside that window (588 s for NVDA, 584 s for QQQ) would be counted on the before side. For the demo wallet there is none: its next NVDA transaction after the update is 2,850,388 blocks later, and it has no QQQ transaction after the QQQ update.

If the live tail read fails, the record is still built. It carries no `corporate_actions` and names the gap `corporate_actions_not_read`. The section is display only, so it should not cost the whole record.

New gap: `multiplier_history_mismatch`, when the logs do not explain the multiplier the token reports at `as_of_block` (an update was missed). It is skipped while the last update is still scheduled, because /rwa has not measured what `uiMultiplier()` returns before `effectiveAt`.

#### Record page

"Corporate actions while this wallet held the token": effective date, token, multiplier before and after, shares held before and after, tx link. Updates while the wallet held none are folded into one line with a count and open on click.

#### Measured on the demo wallet

Live reconstruction of `0xE9B08727131E34010b34006c660D4c1B436EC25f` on 2026-09-30 at block 76,085,543 (`reconstructFacts` with a counting fetch, one run): 25.3 s, 58 `eth_getLogs` of which 2 were the corporate-action tail (one POST). `realized_usd` -284.57, the same as before this patch.

| effective (UTC) | token | multiplier | wallet raw at the update | shares before → after | tx |
|---|---|---|---|---|---|
| 2026-09-10 00:00:30 | NVDA | 1 → 1.000775159164630595 | 82049332007476505675 | 82.04933200 → 82.11293329 | `0x4ac23f2e…` |
| 2026-09-22 00:10:34 | QQQ | 1 → 1.000700791241405425 | 94180700533589531354 | 94.18070053 → 94.24670154 | `0x6331915e…` |

Both holdings agree with a plain sum of the wallet's recorded Transfer logs up to each update (a test does this without the classifier). A copy of Gapwatch's public API response saved on 2026-09-30 lists 20 events (`total: 20`). NVDA is among them. The QQQ update of 2026-09-22 is not.

#### Tests

`packages/rwa/test/corporate.test.ts`, no RPC:

- topic and decoding against the real NVDA log
- the holding is the replay up to the update's log, same-block order is respected, and `held:false` entries are kept
- a token whose history was not walked keeps its updates with `held: null`
- the frozen walk covers exactly the 195 canonical tokens and contains the QQQ update of 2026-09-22 (block 69,210,998)
- a live read sends one tail range per token after the frozen walk, and nothing on a repeat
- Fixture C (`fixtures/rwa/C.corpact.json`, recorded by `packages/rwa/scripts/record-fixture-corpact.ts`): the demo wallet's NVDA and QQQ history. It checks the updates read from the chain match the frozen walk, the NVDA 2026-09-10 and QQQ 2026-09-22 rows, that the record with and without corporate actions is identical apart from `corporate_actions` (so `realized_usd` does not move), and that dropping the QQQ update raises `multiplier_history_mismatch`.

#### Not changed

- Per-trade share counts: the record has no per-trade list today, so there is no historical share display to correct. The corporate-action rows carry shares before and after each update instead.
- The paid route returns the same JSON as the free route, so its body gains `corporate_actions[]` too. That makes this money code: it ships after an independent review says SHIP.

### SPEC patch 023: contract tests, hash material v2, key-less verification

Status: proposed on branch `rwa-w4-contract`, 2026-09-30. Merge into SPEC §9
(anchor) and §7 (facts routes).

#### §9 Anchor: what changes

The contract does not change. `RwaAnchor` stays at
`0x1955137e7773f2459eb75fb88842026c6517c22d` on Robinhood Chain (4663), with no
owner, no upgrade path, one write function `anchor(bytes32,bytes32,uint32,uint64)`
and one counter `count()`. No read or view function is added (Decision 010).

##### 9.x Hash material

The material is selected by the record's own `method_version`.

| method_version | methodVersion on chain | material |
|---|---|---|
| rwa-recon-0.1 | 1 | v1 |
| rwa-recon-0.2 | 2 | v1 |
| rwa-recon-0.3 | 3 | v2 |

v1: `keccak256(method_version \n address_lowercase \n as_of \n r1_status \n realized_usd_or_null)`.

v2: `keccak256(method_version \n address_lowercase \n as_of \n r1_status \n realized_usd_or_null \n facts_json_keccak)`,
where `facts_json_keccak` is `keccak256` of the UTF-8 bytes of the canonical
JSON of the whole facts record, written as a lower-case `0x` hex string.

Canonical JSON: object keys sorted by code unit at every depth, no whitespace,
arrays in order, strings, numbers and booleans as ECMAScript `JSON.stringify`
writes them, members whose value is `undefined` left out, the top-level `address`
lower-cased and nothing else changed. A non-finite number or a bigint is an error.

A method version missing from the table cannot be anchored
(`methodVersionNumber` throws). Adding a version means adding a row.

Why: v1 does not bind `tokens` or `evidence`, so two records with different
holdings or evidence could share one anchor. v2 binds every field. The 0.1 anchor
(tx `0x9b776d6a…72d7`) stays v1 and still verifies.

##### 9.y Anchoring procedure

- New records are added to the existing contract with
  `packages/rwa/scripts/anchor.ts --mainnet --contract 0x1955…c22d`. A mainnet
  run without `--contract`, or with any other address, is refused. So is a
  contract whose runtime keccak256 differs from the pinned build.
- The script prints the plan and the gas estimate and sends only after the
  operator types `anchor`.
- Output: a new file `fixtures/rwa/anchors/<method_version>-<block>.json`, opened
  exclusively. `fixtures/rwa/anchor.json` is never written again.
- The operator runbook is in `docs/rwa/OPERATING.md`.

##### 9.z Verification

A verifier accepts an anchor only if all of these hold:

1. The tx receipt has status success.
2. The `Anchored` log was emitted by `0x1955…c22d`. Logs from other addresses
   are ignored.
3. The runtime at that address hashes to
   `0x9032fa493b888a32b4773a18ae74814d4f492d136c4cd55ade593eb783f9b5b0`.
4. `anchoredBy` equals the operator the record names, or the one the reader requires.
5. `subject`, `factsHash`, `methodVersion` and `asOf` are recomputed from the JSON.

Two implementations exist and tests hold them to the same answers:
`packages/rwa/scripts/verify-record.mjs` (no dependencies, own keccak, Node 18+)
and `packages/rwa/scripts/anchor.ts --verify` (product code and viem).

##### 9.w Contract tests

`packages/rwa/contracts` is a Foundry project (`foundry.toml`: solc 0.8.26,
optimizer 200 runs, EVM cancun, IPFS metadata). `forge test` covers reverts,
event fields, `count`, fuzz, invariants, the fixed selector list, the absence of
external-call, create and self-destruct opcodes, and a full bytecode match
(metadata tail included) against `packages/rwa/contracts/onchain.json`. CI runs it
in the `contracts` job.

Bytecode match, defined: "full" means keccak256 of `eth_getCode` equals keccak256
of the Foundry runtime including the CBOR metadata tail. "stripped" means the same
after removing the tail (its length is the last 2 bytes). Only a full match pins
the source text. On 2026-09-30 the match was full.

#### §7 Facts routes: X-Facts-Hash

`GET /api/v1/rwa/facts/<address>` and `GET /api/v1/rwa/paid/facts/<address>`
send `X-Facts-Hash` on 200: the v2 hash of the returned record, whatever its
`method_version`. For `rwa-recon-0.3` and later it equals the value a v2 anchor
of that record carries. The JSON body is unchanged. Error responses and 402 carry
no such header. If the record cannot be hashed the header is left out and the
response is otherwise unchanged. On the paid route it is computed after the record
is built and before settle, and it never throws.

The header comes from vet402's server. It helps match a response to a log. It is
not a proof on its own.

---

## 11. ゴールデン

### Fixture A（評価）
- トークン NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`
- feed `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`
- 凍結ブロック N を `fixtures/rwa/A.json` に書く（実装開始日に head-100 を採用して固定）
- そのブロックの `balanceOf` / `uiMultiplier` / `latestRoundData`
- 期待 USD はセクション2の式
- 第二テスト: `usd * uiMultiplier / 1e18` を期待値にした実装は fail
- 改正（patch 010・2026-09-17 Takeshi 決定）: A の holder（`0xa8553db0…`）は発行体の運用ウォレットで、取引が約 960 件ありライブ再構成がルート上限（60 秒）を超える。**公開 URL と審査デモに使わない。A は式の正本としてだけ残す。** 提出に出すのは取引が数十件の普通のアドレス（選定日は §13d の範囲で別途）。
- 改正（patch 011・2026-09-18）: **公開 URL と審査デモのアドレスは `0xE9B08727131E34010b34006c660D4c1B436EC25f`（4663）に固定する。** 選定時の実測（dev サーバー・cold 5 回）: facts 17–40 秒、`/rwa/<addr>` 17–30 秒、全て 200。NVDA の Transfer 27 件、events_summary は univ3 10 / univ4 5 / other_unparsed 12、r1 は `partial`。60 秒を超えるようになったら別のアドレスに替える（ルートの上限は上げない）。

### Fixture B（1約定）
実装開始日（ETHOnline ゲート後の最初のコーディング日）にやること:

1. NVDA/USDG または NVDA/WETH の Uniswap v3 または v4 の公開 Swap を1件選ぶ
2. `fixtures/rwa/B.md` に tx, block, raw_in, raw_out, 手計算の USD、FIFO 前提（単一 lot）を書く
3. デコーダが $0.01 以内で一致するテストを置く

B をファイルに書くまで、どのアドレスにも `realized_usd` を出さない。409。

---

## 12. リポへの差し込み

既存 vet402 モノレポ前提。

```
docs/rwa/SPEC.md
docs/rwa/CLAUDE.md
fixtures/rwa/A.json
fixtures/rwa/B.md
packages/rwa/
app/rwa/[address]/page.tsx
app/rwa/accuracy/page.tsx
app/api/v1/rwa/facts/[address]/route.ts
app/api/v1/rwa/catalog/route.ts
app/api/v1/rwa/accuracy/route.ts
app/api/v1/wallets/[address]/rwa/route.ts
supabase/migrations/XXXX_rwa.sql
```

`/score` ルーター、x402 observatory、既存加重ファイルに import しない。
MCP `check_rwa_wallet` は10月。3週間は HTTP のみ。

`docs/rwa/CLAUDE.md`:

```
RWA code lives only under app/rwa, app/api/v1/rwa, app/api/v1/wallets/[address]/rwa, packages/rwa, fixtures/rwa, docs/rwa.
Do not import RWA into /score or x402 observatory.
Do not multiply uiMultiplier into the Chainlink price.
Do not drop other_unparsed events.
Do not use any cost method except FIFO.
Do not render ALLOW/WARN/BLOCK on public pages.
Do not emit realized_usd until fixtures/rwa/B.md exists and its test passes.
Do not infer that a wallet is an agent.
Do not merge two addresses into one PnL.
```

実装エージェントへの渡し物はこの SPEC、CLAUDE.md、fixtures。会話ログは渡さない。

---

## 13. 3週間の時間箱（ソロ）

前提: ETHOnline vet402 提出が先。

| いつ | 何をする | 禁止 |
|---|---|---|
| 今〜9/13 23:59 JST | ETHOnline 提出。この SPEC を `docs/rwa/SPEC.md` に置くだけ可 | Hood 機能コード |
| 提出後36h | 睡眠と移動 | Hood コード |
| 9/16–18 | Fixture A 凍結、B 選定、デコーダ、migration | ページの見た目 |
| 9/19–22 | `/rwa/[address]` + facts API + staleness | 実現PnL（B前） |
| 9/23–26 | FIFO、partial、catalog | R2、MCP、Vault |
| 9/27–29 | opinion API、アンカー1発、提出文 | 新会場 |
| 9/30–10/4 | 壊れないこと | 機能追加 |
| 9/25–27 ETHTokyo 移動 | 凍結してよい | 新機能 |

提出物:

- 動く `/rwa/:address` 1枚
- facts JSON
- 可能なら opinion JSON（キー付き）
- Fixture A/B が CI で緑
- アンカー tx（4663 または 46630）
- README: 本体 `/score` を変えていないこと、会場スコープ、除外会場
- 9/14以降の commit 差分

### §13b Open House Singapore（提出会場）

期間: 2026-09-14 〜 2026-10-04 23:59（会場時計に従う）
形式: オンライン。既存コード可。会期中の差分を説明できればよい。
資格: Arbitrum 系にデプロイ。この楔は Robinhood Chain 4663 または testnet 46630。
トラック: Open Category と Promising Products。両方出す。新SKUやVaultでトラックを増やさない。
審査が見るもの: コントラクトの質、プロダクトとしての明快さ、独自性、実在の問題。
予約枠: 上位に RH Chain 枠がある。デプロイ先は RH を外さない。
提出物:
- 公開 URL `/rwa/:address`
- facts JSON
- アンカー tx（4663 または 46630）
- README: 既存 vet402（/score）は変えていないこと、RWA は会期差分であること
- 9/16 以降の commit 一覧

やらない: 賞取りのための会場追加、Arbitrum One への移植、トークン、実行エンジン。

提出フォームの必須欄（patch 012・2026-09-19 実測。HackQuest `…/buildathon/17bfad43-…/bb8b9fc1-…/submit`。未提出のまま閉じた）:
- What is your contract address?*（"To qualify, your project must be deployed on the corresponding ecosystem."）→ §9 のアンカーを 4663 か 46630 にデプロイした後でないと書けない
- Which Prize Track*（Overall Prize / Promising Products Track / Grants。複数可）
- Link to frontend/UI/website*（300 字）→ `/rwa/<デモ用アドレス>` が本番に出た後
- Core Protocol / Smart Contract Addresses*・Factory/Pool Contracts*・Token Contract Address*（各 300 字。該当なしはそう書く）
- Which parts of your code have been produced during the Buildathon?*（300 字）→ §13c の RWA パスと 09-17 以降のコミット
- Sponsor/partner technologies*（選択肢に Robinhood Chain・Paxos/USDG・Alchemy・OpenZeppelin ほか）
- プロジェクトページ側で Demo Video が必須（"Video Required"）。公開 URL は `…/projects/vet402-rwa`（表示名を変えるとスラッグも変わる）

### §13c 会場の分離（patch 002・2026-09-13）

出典: `docs/hackathons/2026-autumn-continuity.md` 節「Parallel venue — Arbitrum Open House / vet402 `/rwa`」（b68e186・Takeshi 承認）。食い違ったら出典を正とし、この節をパッチで直す。

- 表示名: Open House 側は `vet402 /rwa`。
- 請求: Open House が請求するのは下の RWA パスと、そのパスに触れた 2026-09-14 以降のコミットだけ。§13 の「9/14以降」と §13b の「9/16 以降」は **2026-09-14 以降**に揃える（コードは 9/16 から。9/14–15 は docs だけ）。
- RWA パス（請求フィルタ）: `packages/rwa` `src/app/rwa` `src/app/api/v1/rwa` `src/app/api/v1/wallets/[address]/rwa` `fixtures/rwa` `docs/rwa` `src/lib/db/rwa-schema.ts` `drizzle-rwa.config.ts` と `drizzle/` の RWA 専用 migration。`app/rwa` はこのリポに作らない（patch 001）。
- 請求しないもの: `payOrRefuse` / `pay_if_trusted` / `resolve-then-pay` を新規作業として書かない。README と提出文に1行「ETHGlobal Tokyo の作業（ENS 経由の支払い）と ETHOnline の `payOrRefuse` は含まない」。
- ETHOnline 審査中（〜2026-09-17 01:00 JST）: `packages/sdk` `packages/mcp-server` `examples/ethonline-2026-*` `SKILL.md` `AI_USAGE.md` `docs/ethonline-2026` に触らない。タグ `pre-ethonline-2026` と Release `ethonline-2026-submission` を動かさない。
- 共有ファイル（`package.json`・lockfile・DB schema/migration・`next.config.ts`・`vercel.json`）: 1コミットに分け、件名に `rwa:` を入れる。本体の既存テーブルは変えない。
- コミット件名: 英語。`main` へはトピックブランチから `bash scripts/push-main.sh --full` だけ。
- 凍結: §13 の「9/25–27 ETHTokyo 移動 | 凍結してよい」は **凍結する**（`rwa` パスのコミット 0 件）。提出準備は 9/28–10/4 に置く。
- 凍結の改正（patch 013・2026-09-23 コアセッションの申し合わせ）: **本番へ出さない期間は 2026-09-24 18:00 〜 09-27 15:00 JST**（9/25–27 より広い方を採る）。ブランチでの実装・テストは通常どおり続ける。`scripts/push-main.sh` をこの間打たない（main への push はアプリ全体の本番デプロイを起こす。docs だけでも同じ）。本番 DB のマイグレーションと新規 cron も 09-27 15:00 以降。提出は 9/28–10/1 のまま。
- 未決: §13 の「9/23–26 FIFO、partial、catalog」と「9/27–29 opinion API、アンカー1発、提出文」は凍結日と重なる。凍結日には作業しない。行の再配置は patch 003 で決める。

### §13d 時間箱の再配置（patch 003・2026-09-13）

§13 の表のうち 9/16 以降の行はこの表で置き換える。§13c の未決はこれで閉じる。
§13 の「9/14 以降」は会場の窓であり、実装開始ではない。コード開始は 2026-09-17 01:00 JST（ETHOnline Finale）以降。
patch 004（同日）: 9/16–21 の中身を5項目で明示する。「分類」に含めて読まない。
patch 006（2026-09-14）: ETHOnline 審査中（〜09-17 01:00 JST）に提出リポへコードを入れない。開始を 9/16 から 9/17 に1日ずらす。それまで `~/vouch` の `main` にも公開ブランチにもコードを push しない。docs は `rwa-v0` の中にとどめる。9/22 以降の行は変えない。

| いつ | 何をする |
|---|---|
| 9/17–21 | Fixture A、分類、`/rwa/[address]`、facts API、staleness（旧 §13 の 9/19–22 を前倒し。FIFO の前に公開面を置く） |
| 9/22–24 | FIFO。24日が移動なら 23日までに閉じる |
| 9/25–27 | 凍結（任意ではない） |
| 9/28–10/1 | opinion API・アンカー・提出文 |
| 10/2–4 | 機能を足さない。壊れないことの確認だけ |

会場のセッション（patch 008・2026-09-15 Takeshi 決定。時刻は JST・Google Meet。上の作業の枠は変えない）:

| いつ | 何 | 扱い |
|---|---|---|
| 9/22 17:00 | Tokenized RWAs（SBI） | 出る候補 |
| 9/23 18:00 | フィードバック #2（17:30 の x402 ワークショップの直後） | 出る |
| 9/24 17:00 | Robinhood Chain 入門 | 出る候補 |
| 9/28 18:00 | フィードバック #4（凍結明け） | 出る |

フィードバック #3（9/25 18:00）は見送る。Tokyo 初日の境界タグ（19:30）の直前で、`/rwa` も凍結中のため。

### §13e 一次情報との照合（patch 005・2026-09-14）

出典（09-14 07:10 JST 取得）: HackQuest の会場ページ `arbitrum-singapore.hackquest.io/buildathons/Arbitrum-Open-House-Singapore-Online-Buildathon`（ページデータ）と、そこからリンクされた規約 PDF `openhouse.arbitrum.io/singapore_version_open_house_buildathon_terms___conditions.pdf`（Last Updated: June 18, 2026・14ページ）。

- 締切: 規約は「Submission Deadline: October 1, 2026, 11:59 PM SGT」「Late submissions will not be accepted.」。ページは `submissionClose: 2026-10-04T15:59:00Z`（10/4 23:59 SGT）。一次同士が食い違うので早い方に合わせる。**提出は 2026-10-01 23:59 SGT（10/02 00:59 JST）までに終える。** §13b の「〜 2026-10-04 23:59」は会期（規約の Event Period: Sep 14 – Oct 4）として読み、提出締切には使わない。§13d の「9/28–10/1 opinion API・アンカー・提出文」はこの時刻で閉じる。10/2–4 は提出後。
- 締切の追記（patch 007・2026-09-15）: 主催者のキックオフメール（2026-09-15 受信・日程表に "All times in Singapore Time (SGT / GMT+8)"、Takeshi が共有しハッカソン戦略セッション経由で受領。本セッションはメール本文を見ていない）は提出締切を **OCT 4 11:59PM SGT** としている。09-15 13:31 JST の再取得でも、ページは `submissionClose: 2026-10-04T15:59:00Z` のまま、規約 PDF は「Submission Deadline: October 1, 2026, 11:59 PM SGT」「Last Updated: June 18, 2026」のまま。**公式の最終期限は 2026-10-04 23:59 SGT（10/05 00:59 JST）とする。仕上げの目標は 2026-10-01 23:59 SGT のまま**（規約が未改訂で、期限後の提出を受け付けないと書いているため）。§13d は変えない（9/28–10/1 で提出を終え、10/2–4 は機能を足さない）。
- 既存プロダクト: 規約 3.1 は「existing work that has been adjusted during the Buildathon (this shall mean more than trivial development of the code base)」。Code of Conduct は「actual development or implementation must not begin until the Buildathon has started」。§13b の「既存コード可。会期中の差分を説明できればよい」を次に改める: **既存の vet402 は可。ただし会期中（09-14 以降）に自明でない開発をした差分で出す。`/rwa` の実装は 09-14 以降に始めたものに限る。09-09〜13 の `docs/rwa` は設計（事前の research・wireframing）であり、実装ではない。**
- デプロイ先: 規約 3.1 は Arbitrum Sepolia / Arbitrum One / custom Orbit chain（原文 "Orbin"）、ページは「deployed on an Arbitrum chain … Arbitrum Sepolia, Arbitrum One, Robinhood Chain, or others」。§13b（4663 または 46630）と差なし。
- RH の予約枠: 規約 6.2 とページの両方で「At minimum, 1 of 3 prizes are reserved for a project building on Robinhood Chain」。§13b と差なし。

---

## 14. 計画として先に予約し、3週間は触らないもの

順序固定。前倒し禁止。

1. MCP `check_rwa_wallet`（facts が安定したあと）
2. R2（declared の自称ソースが1件取れてから）
3. bound の ERC-8004
4. Sushi / RFQ / Morpho デコーダ（会場を足すときは method_version を上げ、旧結果は再計算）
5. 既存 Pro への opinion レート加算（新SKUなし）
6. 税務 SaaS、Vault

---

## 15. 受け入れ（10/4、実装可能な範囲）

- [ ] ETHOnline 提出ログがある
- [ ] Fixture A が緑。二重掛けテストが意図通り赤→修正後も二重掛けは赤のまま
- [ ] Fixture B.md があり、その tx で $0.01 以内
- [ ] 公開ページに R3 が無い
- [ ] facts JSON に recommendation が無い
- [ ] other_unparsed を捨てていないことが events_summary で見える
- [ ] `/score` の diff が空
- [ ] 購入・入金 UI が無い
- [ ] アンカーが explorer で verified または少なくとも tx が取れる
- [ ] CLAUDE.md の禁止事項に反するファイルが無い

---

## 16. v2 から閉じた分岐

- 原価法（FIFO）
- 対応会場（UNI v3/v4 のみ）
- other の扱い（捨てない、reconstructed 禁止）
- 内部入金（cost unknown、partial）
- 合算禁止
- R2 を3週間から外した
- R3 決定表
- 公開コピー
- スキーマ
- ジョブ（オンデマンド + 日次 catalog）
- staleness 数字（26h / 1h）
- 丸め
- リポパス
- 時間箱
- エラーコード
- アンカー中身
- sequencer feed を捏造しない
- 実装エージェントに渡すファイル

残る作業であって、残る未決ではないもの: Fixture B の tx ハッシュ。手順はセクション11。コーディング開始日に書く。

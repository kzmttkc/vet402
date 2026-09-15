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

---

## 11. ゴールデン

### Fixture A（評価）
- トークン NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`
- feed `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`
- 凍結ブロック N を `fixtures/rwa/A.json` に書く（実装開始日に head-100 を採用して固定）
- そのブロックの `balanceOf` / `uiMultiplier` / `latestRoundData`
- 期待 USD はセクション2の式
- 第二テスト: `usd * uiMultiplier / 1e18` を期待値にした実装は fail

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

# I3: 売り手 claim → バッジ → 監視ループ（設計）

要件定義: Growth &amp; acquisition spec v3 §4 I3、§2.2 P4、制約 C1・C10・C11。  
日付: 2026-11-28（JST）。実装は本ドキュメント承認後、PR 単位で進める。Stripe・料金ページの公開変更は C11（設計のみ、コード下書き可）。

## 目的

バッジを売り手サイトに置かせ被リンクと発見を増やし、アラートで再訪させ、**Seller Watch**（$9/月・$90/年・10 エンドポイント）で監視を有料化する。有料でも L1 の頻度・判定・公開記録は変えない（C10 / Integrity Terms 1.1）。

## 既存 vs 不足（コードベース調査 2026-11-28）

| 領域 | 既にある | 不足・ギャップ |
| --- | --- | --- |
| **check_my_x402_endpoint** | MCP `check_my_x402_endpoint`（`src/lib/mcp/tools.ts` `checkEndpoint`）と Zod 出力（`src/lib/mcp/schemas.ts`）。鍵なし・ホスト別 L0/L1 集計・`record_url`・fix_first。レート枠 `mcp_seller`（`tests/mcp-route.test.ts`）。 | **1 画面 UI が無い**：人間向けの結果画面で claim・バッジ・watch・webhook を完結できない。MCP/JSON のみ。 |
| **署名 claim（payee）** | `GET/POST /api/v1/payees/verify`（`src/lib/verify-message.ts` `payeeMessage`、issued 10 分・domain 束縛）。鍵不要。 | エンドポイント URL から payTo を引いて claim まで誘導する導線が check 結果と未接続。 |
| **署名 claim（observatory watch）** | `GET/POST/DELETE /api/v1/observatory/watch`（API キー必須、ウォレット EIP-191、`x402_payee_watchers`、キーあたり最大 20 ウォレット）。`endpoint.delisted` を webhook へ（claim 済みのみ、`src/lib/webhooks.ts`）。 | Seller Watch **プラン・課金・10 EP 上限**なし。無料 Scale の watchlist（50 件、`src/lib/watchlist.ts`）とは別製品線未実装。 |
| **バッジ** | 4 種 SVG：`/api/badge/{address}`, `/agent/{id}`, `/endpoint/{id}.svg`, `/host/{host}.svg`。host バッジは事実のみ（`src/lib/badge/host-badge.ts`、C1 寄りの文言）。取得計測 `badge_fetch_daily` + `scheduleBadgeFetch`（`src/lib/badge/fetch-stats.ts`）。 | 埋め込みコードのコピー UI、check 結果からの deep link、Seller Watch 向け見た目調整（有料）未実装。 |
| **webhook** | キーあたり 5 本（ドキュメント・既存ルート）。 | check 結果画面からの登録導線なし。Seller Watch 専用イベント整理なし。 |
| **売り手ページ** | `/sellers/{host}`、I4 index ゲート（`src/lib/sellers/seller-index.ts`：30 日 delivered または payee claim）。 | I3 の「1 画面」は seller ページではなく **オペレータ診断面**として新設が妥当。 |
| **日次計測** | `GET /api/v1/stats/badge-fetches?days=`（referer_host 別・kind 別）。`client_usage_daily` / site events（`watch_sellers_interest` は event 定義のみ、直近需要弱）。 | **claim 数・有効 watch 数**の日次 KPI 行が無い。vet402.com / referer なしのバッジ分離は DB 上 `(none)` と hostname で可能だが、日次ジョブ・I0 取り込み未配線。 |
| **Stripe / 料金** | Pro / Scale のみ（`src/lib/billing/plans.ts`）。P4 Seller Watch は **未登録**（意図どおり）。 | Price ID、サブスク状態、10 EP 上限、年額 $90。**設計・下書きのみ**（C11 まで公開しない）。 |
| **C10 試験** | L1 独立性の各種試験は散在（verify-now 系は I8 想定）。 | **Seller Watch 加入の有無で L1 スケジュール・判定・公開 JSON が同一**であることを固定する専用試験なし。 |
| **C1 バッジ** | host バッジは未購入時「no paid calls」、名指しの「未配達」文言なし。404 は未掲載 host。trust バッジは署名+ALLOW 必須（`src/lib/badge/trust-badge.ts`）。 | エンドポイントバッジ・payee バッジの **settled 未配達** 組み合わせの回帰試験を I3 受け入れに明示追加。 |
| **粗利 KPI** | I0 x402 着金（`src/lib/kpi/x402-revenue.ts`）。 | 製品ライン `seller_watch` の Stripe 手数料・枠コストの日次行（A1）は未実装。 |

### 設計で見つけた既存の穴・不整合

1. **二重の「watch」概念**：`observatory/watch`（payTo ウォレット・delist）と `watchlist`（スコア変化）が別 API。Seller Watch 仕様は「公開記録まわり」なので、主たる束ね先は observatory + webhook + 月次写し。watchlist とは課金バンドルで説明を分ける必要がある（混同すると C10 説明が難しい）。
2. **check 結果に payTo が無い**：`checkEndpoint` は host 中心。claim は payTo ウォレット単位。1 画面では L0 から payTo を引くか、ユーザーにウォレット入力を求めるステップが要る。
3. **需要シグナル**：`watch_sellers_interest` が 14 日 0（spec §4 I3）。最小構成・60 日で 5 件未満なら停止提案（【推測】閾値）。
4. **P9 不採用**：x402 30 日パス（9 USDC）は設計・Stripe・料金ページから除外（I7 後に再検討）。

## 1 画面導線（ターゲット UX）

**入口（案）**：`GET /sellers/{host}/setup` または `GET /tools/my-endpoint?url=`（名前は実装 PR で既存命名に合わせる）。  
**前提**：host が `check_my_x402_endpoint` と同じデータ源（`resolveSellerPage`）で読めること。

| ステップ | 内容 | 既存再利用 |
| --- | --- | --- |
| 1. 診断 | host の L0/L1 要約（MCP 出力の人間向けサブセット） | `checkEndpoint` ロジック共有 |
| 2. claim | payTo ごとに `payees/verify` プレビュー → 署名 → POST（または I7 後ウォレット署名のみ） | `payeeMessage` |
| 3. バッジ | host / endpoint / payee の embed `<img>` + コピー | 既存 badge routes |
| 4. watch（無料枠） | API キーがある場合：`observatory/watch` 登録手順リンク | 既存 route |
| 5. webhook | ダッシュボード or `POST /api/v1/webhooks` へのリンク | 既存 |
| 6. Seller Watch | 10 EP 上限・通知種別・自己診断 L0（1 日 5 回・**公開記録に入れない**） | **新規**（プランゲート） |

**E2E 受け入れ**（spec）：Playwright または MCP スモーク + 署名モックで「同一 host で claim プレビュー表示 → バッジ URL 200 → watch POST 202/200」まで。

## Seller Watch（P4）中身

課金: $9/月、$90/年（10 か月分）。**10 エンドポイント**（resource key 単位。ホストあたり複数可だが合計 10）。

| 含む（通知・書類のみ） | 含まない（C10） |
| --- | --- |
| 公開記録の変更・delist・価格/payTo ずれアラート（webhook + メール） | L1 購入頻度の変更 |
| 新規購入記録・ERC-8004 フィードバック通知 | 判定・訂正速度 |
| 月次署名つき「記録の写し」（公開 JSON の写し、PDF は後続可） | 掲載順・index の優遇 |
| バッジ見た目調整（テーマ色など、**文言は事実のみ**） | verify-now / on_demand 系列 |
| 非公開自己診断 L0（1 日 5 回、**監査ログは seller_self_l0 区分、公開 L0 台帳にマージしない**） | |

**データモデル（案）**：

- `seller_watch_subscriptions`（account_id, stripe_subscription_id, status, period_end, endpoint_quota=10）
- `seller_watch_endpoints`（subscription_id, resource_key, created_at）
- 既存 `x402_payee_watchers` は **無料 delist 通知**のまま。Seller Watch は追加チャネル（メール・月次写し）と EP テーブルを課金でゲート。

**Stripe（設計のみ）**：新 Price ID `seller_watch_monthly` / `seller_watch_yearly`。G4: 旧 Price は active=false で残す。Webhook `customer.subscription.updated` で quota 同期。実装 PR は env プレースホルダ + テスト用モック（C3: 本番鍵なし）。

## 日次計測（I0 連携）

| メトリクス | ソース | 分離ルール |
| --- | --- | --- |
| バッジ取得 | `badge_fetch_daily` | `referer_host = vet402.com` / `(none)` / その他外部を別列 |
| claim 数 | `verified_payees` の新規行/日、`x402_payee_watchers` 新規 | 種別を分ける |
| 有効 watch 数 | `seller_watch_subscriptions status=active` の EP 数、observatory watchers 数 | 無料 vs 有料を分ける |
| claim→加入転換 | funnel イベント（`seller_watch_checkout_started` 等） | I0 `kpi_events` 開始後 |

ジョブ: `scripts/kpi/daily-seller-funnel.ts`（新規、DB 読みのみ、stdout JSON → I0 集計）。本番 cron は承認後。

## C1（バッジ）

- host バッジ：既存 `hostBadgeCopy` を維持。settled=0 は「no paid calls」。
- trust バッジ（payee/agent）：未署名は grey「Unverified」。**未配達を理由に赤「名指し」しない**。
- 受け入れ：`tests/endpoint-receipt-badge.test.ts` パターンを拡張し、settled かつ non-delivered の host でバッジ本文にホスト以外の攻撃文言が無いことを固定。

## C10 試験設計

固定フィクスチャ: 同一 `resource_key`、同一 L1 スケジュール種。

1. アカウント A: Seller Watch なし（または free）
2. アカウント B: Seller Watch active（モック Stripe）
3. 同一エンドポイントで L1 runner を 2 サイクル（`.pg.test`）
4. 断言: `x402_l1_purchases` の間隔・`latest_result`・公開 `export.csv` 行が A/B で一致（watch フラグのみ差分）

自己診断 L0 は `l0_probe` に `origin: seller_watch_self` を付与し、公開集計から除外する行が増えるだけで L1 に触れないことを別テスト。

## PR 実装順（推奨）

| PR | 内容 | 依存 |
| --- | --- | --- |
| **I3-1** | 1 画面（読み取り専用）+ check データ共有 + E2E スモーク | なし |
| **I3-2** | 日次 funnel スクリプト + badge/claim/watch 集計テスト | I0 スキーマ案 |
| **I3-3** | Seller Watch DB スキーマ + サーバー側 quota（Stripe モック） | C11 前でも staging |
| **I3-4** | 通知・月次写し・自己 L0（非公開系列） | I3-3 |
| **I3-5** | C10 独立性 `.pg.test` | I3-3 |
| **I3-6** | Stripe Price 接続・ダッシュボード UI（**公開は C11 後**） | オーナー承認 |
| **I3-7** | 料金ページ・規約 diff（文面のみ PR、デプロイフラグ off） | C11 |

## 確かめられなかったこと

- 1 画面の最終 URL とダッシュボード統合方針（オーナー UX 偏好）。
- メール送信基盤の月次写し PDF 生成コスト上限。
- Seller Watch 解約時の EP 10 件の即時停止 vs 期間末まで猶予（Stripe 慣行に合わせる案を PR I3-6 で提示）。

## 参照コード

- Badge: `src/lib/badge/*`, `src/app/api/badge/**`
- Watch: `src/app/api/v1/observatory/watch/route.ts`
- Payee claim: `src/app/api/v1/payees/verify/route.ts`
- MCP check: `src/lib/mcp/tools.ts` (`checkEndpoint`)
- Stats: `src/app/api/v1/stats/badge-fetches/route.ts`
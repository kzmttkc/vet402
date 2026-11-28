# I7: ウォレット署名による API キー自動発行（設計）

要件定義: Growth &amp; acquisition spec v3 §4 I7、制約 C3・C10。本番の鍵生成・DB 書き込み・秘密保管は **本 PR スコープ外**（設計とスタブ API のみ）。  
日付: 2026-11-28（JST）。

## 目的

エージェントが **メールなし**でウォレット署名により API キーを取得できるようにする。既存の payee/agent 署名登録（EIP-191・固定行・`domain: vet402.com`・`issued` 10 分窓）を再利用し、I0 の「ウォレットで数えた顧客数」に載せる。

## 既存の署名パターン（再利用）

| 用途 | メッセージ | ルート | 鍵 |
| --- | --- | --- | --- |
| Payee claim | `payeeMessage(wallet, name, url?, issued)` | `GET/POST /api/v1/payees/verify` | 不要 |
| Agent passport | `agentMessage(...)` | `GET/POST /api/v1/agents/verify` | 不要 |
| Observatory watch | `observatoryWatchMessage(wallet, apiKeyId)` | `GET/POST /api/v1/observatory/watch` | **Bearer 必須** |
| Delist alert | payee 系 | 同上 watch | Bearer |

共通実装: `src/lib/verify-message.ts`: `matchSignatureForm`, `SIGNING_DOMAIN`, `LEGACY_MESSAGE_ACCEPT_UNTIL`, `isValidIssuedAt`, `verifyMessage` (viem EIP-191)。

**I7 で新設するメッセージ（案）** `apiKeyWalletMessage(wallet, nonce, issued)`（新しい面なので 1 行目は em-dash を使わない `vet402.com API key registration` とする。既存 5 面の `titleLine` は em-dash を含むが、署名済みの文面と照合を変えないため I7 では触らない）:

```
vet402.com API key registration
domain: vet402.com
wallet: 0x…
nonce: <uuid-v4>
issued: 2026-11-28T00:00:00.000Z
This signature registers one API key for this wallet on vet402.com. It does not move funds.
```

- 固定行のみ（改行注入不可）。`nonce` はサーバ発行・1 回限り。
- 旧形式互換は不要（新規プロトコル）。将来 legacy 期限を載せられるよう `matchSignatureForm` を流用。

## 提案 API（設計）

| Method | Path | 説明 |
| --- | --- | --- |
| GET | `/api/v1/keys/wallet/nonce?wallet=0x…` | レート制限付き。`nonce` + `issued` + `message` + `expires_at`（issued + 10 分）を返す。 |
| POST | `/api/v1/keys/wallet/register` | Body: `{ wallet, nonce, signature }`。成功時 **一度だけ** `api_key` 平文を返す（既存ダッシュボード発行と同じ契約）。 |

**C3 実装段階**:

1. **Phase A（本 worktree）**: 型・メッセージビルダー・Zod・`matchSignatureForm` 単体試験・OpenAPI 下書き（`openapi` 生成パイプがあればコメント）。ルートは `503 wallet_keys_not_enabled` または feature flag。
2. **Phase B（承認後）**: `api_keys` への INSERT、ハッシュ保管、`wallet_api_key_bindings`（1 wallet 1 active key）。
3. **Phase C**: 本番有効化、レート制限本番値、監査ログ。

## 1 ウォレット 1 キー

| ルール | 実装案 |
| --- | --- |
| 1 active key / wallet | `wallet_api_key_bindings.wallet` UNIQUE（lower case） |
| 再発行 | 旧キー `revoked_at`、新 nonce で POST。48 時間は旧キーが残る **としない**（即失効。エージェント向けは漏えい窓を短く）。 |
| 失効 | `POST /api/v1/keys/wallet/revoke`（同ウォレット署名、別メッセージ purpose）またはダッシュボードから（人間経路）。 |
| メールアカウントとの関係 | ウォレット発行キーは `user_id` を synthetic account に結ぶか、nullable user + wallet 主体（I0 ウォレット顧客数は binding テーブルから数える）。 |

## リプレイ防止・期限

| 攻撃 | 対策 |
| --- | --- |
| 署名再利用 | `nonce` を DB に `consumed_at` で消費。POST 成功で nonce 行を閉じる。 |
| 古い issued | `isValidIssuedAt` + ±10 分窓（payee と同じ）。 |
| ウォレットすり替え | メッセージ内 `wallet:` 行と `verifyMessage` の address 一致。 |
| なりすましドメイン | `domain: vet402.com` 必須行 + `titleLine`（S-6 と同型）。 |
| 乱発 | IP: 8/min GET nonce、4/min POST（payee verify より厳しめ）。wallet あたり 4/hour POST。 |

## レート制限

- GET nonce: `wallet-key-nonce:{ip}` + `wallet-key-nonce-wallet:{wallet}` 二重。
- POST register: 上に加え失敗カウントで 24h クールダウン（鍵なし悪用と同オーダー）。

## I0 連携

**ウォレットで数えた顧客数**:

- 定義: 期間中に **有効な** `wallet_api_key_bindings` の distinct wallet（除外: vet402 own wallets `src/lib/kpi/own-payers.ts`）。
- ソース: binding テーブル + `api_keys.created_at`（イベントログ開始後は `kpi_events` で `api_key_created` と突合）。
- KPI ファイルには件数のみ（C2: 売上値は非公開）。

## 既存との差分

| 項目 | ダッシュボード鍵（現行） | I7 ウォレット鍵 |
| --- | --- | --- |
| 認証 | メール/OAuth アカウント | EIP-191 のみ |
| 課金 | Stripe 顧客と結合 | 初期は Free プラン自動（Pro は別途 Stripe。エージェントが Stripe を通るのは後続） |
| observatory watch | キー ID がメッセージに入る | 同じ。ウォレット発行キーも `observatoryWatchMessage(wallet, apiKeyId)` 可能 |

## C10

ウォレット鍵の有無は **スコア・L1 判定に触れない**（既存と同じ）。試験: ウォレット発行キーとメール発行キーで同一 URL の `check` 応答バイト一致（鍵あり枠のみ消費差をヘッダで許容）。

## PR 実装順

| PR | 内容 |
| --- | --- |
| **I7-1** | `apiKeyWalletMessage` + 試験 + 設計（本ドキュメント） |
| **I7-2** | GET nonce / POST register スタブ（503 or flag）+ OpenAPI 下書き |
| **I7-3** | スキーマ migration 案（SQL ファイル、本番未適用） |
| **I7-4** | 承認後: 実 INSERT・1:1 制約・失効 |
| **I7-5** | I0 スクリプトに wallet customer 集計 |
| **I7-6** | SDK / MCP ドキュメント（英語・事実のみ） |

## 確かめられなかったこと

- synthetic `user_id` vs wallet-only 行が Stripe 既存顧客とマージされるべきか（オーナー判断）。
- 再発行時の webhook エンドポイント引き継ぎ（同一 api_key id を維持するか新 id か）。
- スマートコントラクトウォレット（ERC-1271）対応の要否（現行 payee verify は EOA のみ明記）。

## 参照

- `src/lib/verify-message.ts`
- `src/app/api/v1/payees/verify/route.ts`
- `src/app/api/v1/agents/verify/route.ts`
- `src/app/api/v1/observatory/watch/route.ts`
- `docs/kpi-definitions.md`（Paid customer / wallet 主体）
- `docs/operations/api-key-owner-relation.md`（owner_relation は人手。I7 鍵は初期 NULL）
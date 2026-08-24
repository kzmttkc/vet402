# vet402（日本語）

**x402 エージェント決済経済の独立検証**

*買う。決済する。測定値を公開する。*

vet402 は x402 エンドポイントが実際に売っているものを**実際に買い**、
売り手自身の申告と突き合わせて履行を検証し、結果を証拠付きで公開する。
決済成功は tx ハッシュ付きで、決済に至らなかった試行も同じ重みで載る。

- サイト: <https://vet402.com>
- ライブデモ: <https://vet402.com/playground>
- 観測所（毎日の実測）: <https://vet402.com/observatory>
- 集計JSON: <https://vet402.com/api/v1/observatory/state>

> **旧称 Vouch。** npm スコープ（`@vet402/*`）と API キー接頭辞（`vouch_`）は
> 後方互換のため旧名のまま。

## 何が他と違うか

信頼スコアや評判システムの多くは「他人の申告」を集計する。vet402 は
**自分の資金で買った実購入の結果**を一次データとして持つ。この履歴は
時間とお金を掛けずに複製できない——それがこのプロジェクトの堀。

検証は4レベルに厳密分離され、結果がレベルを跨いで昇格することはない:

| レベル | 問い | 方法 |
|---|---|---|
| L0 | エンドポイントは正しく応答するか | プローブ（購入なし） |
| L1 | 支払いは決済され、応答は届くか | **実購入** |
| L2 | 応答は売り手自身の申告と一致するか | 実購入＋機械差分 |
| L3 | 内容は良いか | 公開ルーブリック——意見。L0–L2 と混ぜない |

## 使う（顧客として）

```bash
npm i @vet402/sdk          # TypeScript APIクライアント
npm i @vet402/middleware   # x402トランザクションゲート（Express / Next.js / Hono）
npm i @vet402/mcp-server   # Cursor / Claude Desktop向けMCPツール
```

APIキーは <https://vet402.com/signup>（無料枠 1,000 lookups/月・カード不要）。
最小のエージェント実装例は [`examples/hackathon-starter/`](../../examples/hackathon-starter/) にある——
「支払う前に確認し、明確な ALLOW が無ければ支払わない」fail-closed の型。

## 動かす（セルフホスト・開発）

```bash
docker compose up          # Postgres + アプリ一式（localhost:3000）
```

または手元の Node で:

```bash
cp .env.example .env.local   # DATABASE_URL 等を設定
npm install
./scripts/dev-setup.sh       # ローカルPostgres + スキーマ適用
npm run dev
```

詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md)（開発参加の手引き）と
[docs/ja/ARCHITECTURE.md](./ARCHITECTURE.md)（構造の地図）へ。

## 文書の地図

| 読みたいこと | 場所 |
|---|---|
| 構造・データフロー・安全設計 | [docs/ja/ARCHITECTURE.md](./ARCHITECTURE.md) / [英語版](../ARCHITECTURE.md) |
| 製品の定義・語彙 | [PRODUCT.md](../../PRODUCT.md)（英語） |
| API リファレンス | <https://vet402.com/docs/api> / [openapi.yaml](../openapi.yaml) |
| 助成金・申請素材 | [docs/applications/](../applications/) |
| デプロイ | [docs/deployment.md](../deployment.md) |

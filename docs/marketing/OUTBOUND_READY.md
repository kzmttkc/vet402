# OUTBOUND READY — 対外発信の実行台帳（Takeshi手番）

対外発信の**実行は Takeshi 手番**（このリポの自動化は投稿しない）。以下は「仕上げ済みの原稿がどれで、
どこに、どう出すか」を一覧にしたもの。投稿前に各原稿末尾の主張マップで実装と突合済み。

## 出すもの一覧

| # | 原稿 | 出し先 | 種別 | 状態 |
|---|---|---|---|---|
| 1 | `articles/ethereum-magicians-erc8004-trust-layer.md` | Ethereum Magicians フォーラム | 長文・設計議論（宣伝色ゼロ） | 仕上げ済み |
| 2 | `articles/devto-x402-trust-before-payment.md` | Dev.to | 長文・build-in-public | 仕上げ済み（`published: false` のまま） |
| 3 | `articles/zenn-x402-trust-score.md` | Zenn | 長文（日本語想定） | 既存ドラフト（未精査・別途確認推奨） |
| 4 | `x402-community-short.md` A〜D | x402 Discord/Telegram の dev チャンネル・統合スレッドへの返信 | 短文 | 仕上げ済み |

## 出す順番の推奨

1. **まず Ethereum Magicians（#1）**。設計の問いを投げる体裁なので、反応が Dev.to 記事の改稿材料になる。
   宣伝でなく議論として入るのが技術フォーラムの流儀。本文にサインアップリンクを置かない（末尾にリポリンク1本のみ）。
2. **次に Dev.to（#2）**。投稿時に front-matter の `published: false` を外す。カバー画像は
   `assets/vouch-banner.png`。タグは記事内の web3/ai/typescript/api/blockchain のまま。
3. **x402 コミュニティ短文（#4）** は「紹介が歓迎される空気のとき」に A を1回。B〜D は該当する
   質問が出たスレッドへの**返信**として使う（投下スパムにしない）。
4. **Zenn（#3）** は日本語想定。中身を Takeshi が一読してから。#2 と主張が重複するので二重投稿感が出ないよう調整。

## 全原稿共通の禁則（実装と乖離させないため）

- **招待コードをどこにも書かない**（signup は開放済み。README のブランド規約と一致）
- **未実装機能に言及しない**。各原稿末尾の「主張→実装マップ」に無い主張を足さない
  （Verilot の「未出荷誤記3回再発」の教訓）。特に保証引受（guarantee underwriting）は**休眠・env OFF**なので
  発信で一切触れない
- SDK 名は **`@vet402/sdk`** / MCP は **`@vet402/mcp-server`**（`@vouch/sdk` は誤り）
- 本番 URL は `https://agent-trust-tawny.vercel.app`、リポは `github.com/kzmttkc/agent-trust`
- スコア閾値・重み・レート値を本文に書くときは実装値と一致させる（ALLOW≥70 / WARN40–69 / BLOCK<40、x402重み10%）

## 出した後にやること（Takeshi → 執行部へ一言）

- 投稿 URL を控える（反応計測の起点）。Dev.to/Zenn は記事URL、フォーラムはスレッドURL、Discord は該当メッセージ
- 反応（コメント・質問・DM）が来たら、それが Dev.to 記事や FAQ の改稿ネタになる。執行部に渡せば反映する

# OUTBOUND READY — 対外発信の実行台帳（Takeshi手番）

対外発信の**実行は Takeshi 手番**（このリポの自動化は投稿しない）。週次 facts の自動は owner 側 `Takeshi_Automation`（[`../hackathons/DISTRIBUTION.md`](../hackathons/DISTRIBUTION.md)）。投稿前に各原稿末尾の主張マップで実装と突合する。

正典: **vet402** · https://vet402.com · https://github.com/kzmttkc/vet402 · npm `@vet402/*` · X `@vet_402`

## 出すもの一覧

| # | 原稿 | 出し先 | 種別 | 状態 |
|---|---|---|---|---|
| 1 | `articles/ethereum-magicians-erc8004-trust-layer.md` | Ethereum Magicians | 長文・設計議論 | **2026-08-25 投稿済み**（ERC-8004 thread 25098, #380）。再投稿しない |
| 2 | `articles/devto-x402-trust-before-payment.md` | Dev.to | 長文・build-in-public | 仕上げ済み（`published: false`）。出す日に URL を再確認 |
| 3 | `articles/zenn-x402-trust-score.md` | Zenn | 長文（日本語） | 2026-08-25 に vet402 へ改稿。`published: false` |
| 4 | `x402-community-short.md` A〜D | x402 Discord/Telegram の返信 | 短文 | 仕上げ済み。A は紹介が歓迎される空気のとき1回 |
| 5 | `FACTS_2026-08-25.md` | X（Farcaster は未開設） | 週次実測 | 下書き。出す前に再 `curl` |

## 出す順番の推奨

1. **Magicians は済**。次の投稿は返信だけ。新規トピックを立てない。
2. **週次 facts** を人が4週きれいに出せたら、X 自動だけ検討。今日 Magicians を出したなら X は翌日以降でよい。
3. **Dev.to** は facts が1回以上出たあと。`published: false` を外す。カバーは RFC 紙面。旧 `assets/vouch-banner.png` は使わない。
4. **x402 短文** は紹介が歓迎される空気のとき A を1回。B〜D は該当スレッドへの返信。
5. **Zenn** は日本語室。#2 と重なるので、出すなら Dev.to のあと。

## 全原稿共通の禁則

- **招待コードをどこにも書かない**（signup は開放済み）
- **未実装機能に言及しない**。`payOrRefuse` / ENS 支払い / Registry 本書き込み / 保証引受は出さない
- SDK 名は **`@vet402/sdk`** / MCP は **`@vet402/mcp-server`**（`@vouchscore/*` は deprecated ポインタ）
- 本番 URL は `https://vet402.com`、リポは `github.com/kzmttkc/vet402`
- 公開の事実面（`/observatory/state`、`/payee/{addr}` HTML）は key-less。スコア API（`/api/v1/wallets` / `/api/v1/payees`）はキー必須
- スコア閾値を書くなら実装値: ALLOW≥70 / WARN 40–69 / BLOCK<40、x402重み10%
- ALLOW が今日カタログに出ない事実を、売り文句にしない（聞かれたら fixtures の数字で答える）
- **「Base のみで実購入している」と書かない**。2026-09-05 実測（公開 `/api/v1/observatory/history` の全期間合計）:
  Base `eip155:8453` 2,999 attempts / 1,382 settled、**Solana 50 attempts / 5 settled**。Solana でも買っている
- **チェーン別の L1 件数を数字で書かない**（当面）。`/api/v1/observatory/state` に `l1ByChain` が無く、
  読者が確かめられる公開面が `history` しか無い。しかもその 2 つが合わない（下記）。
  **`l1ByChain` が state に出たら、この禁則を外す**
- **`/observatory/state` の L1 合計と `history` の合計が一致しない**（2026-09-05 実測: state 3,241/1,629 に対し
  history 合計 3,065/1,387）。**理由は「開始日が違う」ではない**（2026-09-05 08:35、vet402.com が本番 SELECT で突合）:
  history の源 `x402_daily_metrics` は cron が毎日 10:30 UTC に**その日 1 日ぶんだけ**書き、以後**二度と再計算しない**。
  L1 の決済確認 cron は 14:00 UTC で集計より後なので、**当日後半に settled へ昇格した行は永久に集計へ入らない**
  （Base だけで live 1,603 に対し rolled 1,382・221 件の過小）。つまり history は「同じ生の測定」ではなく**凍結スナップショット**で、
  構造的に settled を**少なく**出す。外部の人が history を足して検算すると、こちらが盛っているように見える。
  **是正（直近 14 日の再集計＋全期間の再計算＋応答に `coverageFrom`/`rolledUpThrough`/`semantics`）が本番に入るまで、
  この 2 つを同じ文書に並べない。** 解除は「再集計後の history 合計が state と説明可能な差に収まったこと」を実測してから
- **「監査済み」「externally audited」と書かない**。2026-09-05 の 3 本は自前監査（執行部＋監査エージェント）であって
  第三者監査ではない。書けるのは「自前の監査記録を全文公開している」まで

## 出した後

- 投稿 URL を控える
- 反応は FAQ / Dev.to の改稿ネタ。執行部に渡せば反映する

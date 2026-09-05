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
- **「Base のみで実購入している」と書かない**。2026-09-05 **09:21** 実測（再集計後の
  `/api/v1/observatory/history?days=366`・state と差 0）: Base 3,203 attempts / 1,603 settled、
  **Solana 38 attempts / 26 settled**。Solana でも買っている。
  （朝に書いた 2,999/1,382・50/5 は再集計前の凍結値。同日中に置き換えた）
- ~~チェーン別の L1 件数を数字で書かない~~ → **2026-09-05 09:27 全面解除（執行部が本番で実測・2回）**。
  `/api/v1/observatory/state` の `l1.byChain` が出た。**state からも history からも書いてよい**（出典と取得日は明記する）。
  実測値: **Base attempts 3,203 / settled 1,603（うち nonce-bound 71）・Solana 38 / 26（nonce-bound 0）**。
  byChain の合計が全体（3,241 / 1,629 / 71）と一致することを確認済み。
- **`settled` を1つの数で書かない**（2026-09-05 追加・監査 S-4）。1,629 の内訳は
  **nonce-bound 71 ／ amount+payee のみ 1,558**（和が settled と一致）。強さの違う証拠を1つに混ぜて出すのは、
  「第三者が検算できる測定」という商品の定義に反する。**必ず2層で書く。**
  週次 facts（`scripts/vet402_weekly_facts.py`）は 2 層を必須行にし、フィールドが消えたら中止する
- ~~**`/observatory/state` の L1 合計と `history` の合計が一致しない**~~ → **2026-09-05 09:22 解除（執行部が実測）**。
  再集計が本番へ入り（main `743abac`＋全期間の再集計）、`history?days=366` の 98 日合計 **3,241 / 1,629** が
  `state.l1` の **3,241 / 1,629** と **差 0** で一致することを確認した。応答に `coverageFrom: 2026-08-14` /
  `rolledUpThrough: 2026-09-04` / `lastRollupAt` / `recomputeWindowDays: 14` / `semantics` が出ている。
  **両方を同じ文書に並べてよい。** ただし引用するときは**取得日**と `coverageFrom`〜`rolledUpThrough` を併記すること
  （直近 14 日は毎回再計算・それより古い日は凍結、と `semantics` が宣言している）
- **「監査済み」「externally audited」と書かない**。2026-09-05 の 3 本は自前監査（執行部＋監査エージェント）であって
  第三者監査ではない。書けるのは「自前の監査記録を全文公開している」まで

## 出した後

- 投稿 URL を控える
- 反応は FAQ / Dev.to の改稿ネタ。執行部に渡せば反映する

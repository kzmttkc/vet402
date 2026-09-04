# Owner actions — now（2026-09-05 08:40 JST 更新）

エージェントが押せないもの（ETHGlobal の画面・ウォレット・SNS）だけを人の待ち行列に置く。
戦略: [`STRATEGY.md`](./STRATEGY.md)。Tokyo の貼り付け原稿: [`../ethonline-2026/APPLY.md`](../ethonline-2026/APPLY.md)。

> **この文書の持ち主**: ハッカソン関連（§Today の 1〜4・7、§Do not）は**ハッカソン戦略セッション**。
> 配信・SNS 関連（5・6・8）は**ディストリビューション戦略セッション**が持つ。
> 2026-09-05 まで持ち主不在・git 未追跡で、**8/25 時点の記述が11日間そのまま残っていた**。
> 下記のうち「実測」と書いた行は 2026-09-05 に一次データで確かめたもの。

## 完了済み（やり直さない）

- ETHOnline Continuity 申請 — **2026-08-23**（`continuity-track`）。**会期は 9/4 00:00 UTC に開いており、我々は参加中**（実測: 境界タグ `pre-ethonline-2026` 以降 main に60コミット超）
- Magicians 返信 — **2026-08-25**（ERC-8004 thread 25098・post #380）。再投稿しない。返信のみ
- 賞の一覧: `docs/ethonline-2026/PRIZES.md`。**狙う枠は The Graph（Continuity・$5,000）と Bazantic（$1,000）の2つ**。World AgentKit は 2026-09-03 に切った（Orb 証明が会期中に取り出せず、5要件中2つが未達確定）
- `payOrRefuse` 仕様: `docs/ethonline-2026/DESIGN_payOrRefuse.md`。**会期の正典は `docs/ethonline-2026/WINDOW_PLAN.md`**
- SpendGuard `trustPolicy: "evidence"` — 製品欠陥の是正として main 済み（npm 未公開）。**これは `payOrRefuse` ではない**
- 対外原稿の URL / 名を vet402.com / `kzmttkc/vet402` に合わせた（2026-08-25）
- **デモ用ウォレット（下記4）— 2026-09-05 完了**

### 8/25 の記述で、現在は誤りになったもの（消さずに残す）

- ~~「Production fixtures: ALLOW は構造的に出ない」~~ → **誤り。9/2 の本番 `/decision` で ALLOW は出る。既定 policy を通る endpoint は 373 件**（`WINDOW_PLAN.md` §9）。`fixtures.md` の当該記述は無効
- ~~「`payOrRefuse` を実装しない（窓は 2026-09-04）」~~ → **窓は開いた。実装中**（ハッカソン戦略セッションが `ethonline/payorrefuse` で作業）

## Today（順に）

1. **ETHGlobal Tokyo の Continuity 申請** — 15分。`APPLY.md` の Tokyo ブロックを貼る。
   **締切 2026-09-23**（実測・decisions 2026-09 に記録）。今日でなくてよいが、会期の提出（9/13）が終わると忘れる。**9/14〜9/16 に置くのを推奨**
2. **ETHOnline の採択メールを見る。** 来たら **ETH ステーク**（資金移動は人間の手番）
3. ~~**Hedera 確認**~~ → **不要**。聞く相手は Hedera ではなく World だったが、**World 枠は 9/3 に切った**ので、この確認自体が消滅した
4. ~~デモ用ウォレット（Base）+ ガス + USDC $5~~ → **完了（2026-09-05）**。
   実体 `0xDB62BD202914609830fA656F87996b91be3Aa673`・**USDC 1.000000 着金済み**
   （block 50859520・tx `0x3684a4ab70247bf444fe857cb6b29a08697e5f5db0a87aae5970fa317d84b15b`）。
   **「ガス」と「$5」は不要だった**——The Graph への支払いは $0.01 で、x402 は EIP-3009 の
   オフチェーン署名を facilitator が提出するため**買い手の ETH は要らない**（実測: ETH 残高 0 のまま成立）
5. API キー https://vet402.com/signup — ローカルだけ（`VOUCH_API_KEY`）。**要・担当セッション確認**
6. X `@vet_402` の bio を `docs/marketing/README.md` に合わせる。Farcaster は未作成。自動投稿は始めない。**ディストリビューション戦略セッションの持ち物**
7. **Devcon チケット・ムンバイのホテル** — ~~「未購入なら今日」~~ → **Takeshi の決定により保留**。
   「エントリーおよび勝ち筋がないのに多額の経費と時間を使ってインドまで行くのは避けたい」。
   **チケット購入の可否と Go の判断を同時に行う**。判断材料が揃うのは ETHOnline の結果と
   ETHGlobal Mumbai（11/6–8）のエントリー可否が見えてから。Devcon は 11/3–5、Mumbai は 11/6–8
8. 任意: 週次 facts を人が1回出す。**ディストリビューション戦略セッションの持ち物**

## Do not

- Magicians / Show HN / Product Hunt / Reddit を今日また出す
- ALLOW や BLOCK を自作する（**実在の判定だけを使う**）
- TOKEN2049 Origins にこのリポで出る
- 提出済み ETHOnline 申請文を、DESIGN に合わせて送り直す
- **The Graph を我々のカタログに登録する / `0x79DC34E4…FcCB` を意図的に厚くする**
  （デモの対比が「実在の欠損」であることが値打ち。細工に見えた時点で価値が消える）
- **The Graph との過去の関係（Takeshi は 2020-06〜2025-04 に日本コミュニティマネージャー）を賞に使う**
  （`WINDOW_PLAN.md` §1.5・Takeshi 指示「元コミュニティマネージャーが参加した。それだけ。他と同じに扱う」）

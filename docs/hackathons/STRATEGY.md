# vet402 × ETHGlobal — 戦略全文

> 確定: 2026-08-22（会話で決めた内容を漏れなく記帳。2026-08-23 にファイル化）。
> 提出リポジトリ: https://github.com/kzmttkc/vet402 · サイト: https://vet402.com
> 運用の優先順位: [`README.md`](./README.md)。

このファイルは「なぜこうするか」の正本です。ETHOnline の日次は [`../ethonline-2026/ROADMAP.md`](../ethonline-2026/ROADMAP.md)、確度の上書きは [`../ethonline-2026/WIN_EV.md`](../ethonline-2026/WIN_EV.md)、3連戦の運用は [`2026-autumn-continuity.md`](./2026-autumn-continuity.md) です。

---

## 0. 会話で固定した問いと答え

| 問い | 答え |
|---|---|
| ETHGlobal は期間中の開発しか認めないか | トラックによる。Classic はキックオフ以降のみ。Continuity は既存を持ち込め、期間中の実質差分が賞の対象。 |
| AI と組んで受賞する最適解は | 総合優勝ではなく Partner 賞を最大3。人間は企画・実tx・動画・スポンサー。AI は実装。 |
| Continuity で vet402 を出し、対象は ETHOnline / Tokyo / Mumbai | 大会ごとに新しい動詞を1つ。既存観測は土台。dry-run は Mumbai の「既存」。 |
| 提出リポ | https://github.com/kzmttkc/vet402（ローカル `~/vouch` と同一 origin） |
| Devcon に行くか | Mumbai に行くなら行く。聴講ではなく事前営業。セットで行く。 |
| Token2049 に該当ハッカソンはあるか | Origins（10/6–8）がある。既存コード不可。vet402 では出さない。週は営業。NEXUS は任意。 |
| ETHOnline の詳細ロードマップ | `docs/ethonline-2026/ROADMAP.md` |
| 受賞確度の最大化 | `docs/ethonline-2026/WIN_EV.md`（Partner 3本、自前 seller で ALLOW を保証、失格を潰す） |
| グラント獲得 | `docs/hackathons/GRANTS.md`（レトロ優先。凍結中の動詞は助成のマイルストーンにしない） |

---

## 1. ETHGlobal 公式ルール（要約）

出典: [ethglobal.com/rules](https://ethglobal.com/rules)、各イベントの details（例: ETHOnline / Scaling）。文言は提出前に公式を再読する。

### 1.1 トラック

**Classic（From Scratch）**

- 公式キックオフ以降にプロジェクトを始める。
- 事前のプロジェクト固有コード・デザイン・アセットは不可。
- 公開ライブラリとスターターキットは、透明に使えばよい。
- Continuity に乗らず既存成果を使うと、**Partner 賞と Finalist 対象外**。

**Continuity（Extend Open Source / Ship a Feature）**

- 既存コードベースの上に作ってよい（トラック規則に従う）。
- ハッカソン前に何があったかを明示する（リポ履歴、動画、説明）。
- 期間中に**実質的な**新機能・改善を入れる。
- 期間中に足した部分はオープンソース。
- ETHGlobal へ事前成果を書面で開示する。
- 申請はオプトイン。**2026-08-23 実測: ETHOnline の Hacker Application 内に「Hackathon Track」欄があり、`continuity-track`（Hack on Existing Project）を選んで提出済み**。メールでの別途申請は不要だった。トラックは後から変更できない。
- Partner 賞の Continuity 専用枠はイベント・スポンサーごとに違う。

vet402 は **Extend Open Source**（MIT、このチームがメンテする公開リポ）。

**Ship a Feature** は、クローズド製品に新機能を足し、会期中の差分を OSS にする経路。今回は使わない。

### 1.2 全トラック共通

- Git で進捗を残す。巨大ファイルの1コミットは、原則として資格なしと見なされる。
- 事前成果の未開示、または期間中に作ったように見せかけると、失格・賞金取り消し・今後の参加禁止があり得る。
- 公開ライブラリは可。何が再利用で何が新規かを提出物で区別する。
- 提出は GitHub（および Figma 等）。2–4分のデモ動画必須（イベントによる）。

### 1.3 AI（ETHOnline details ほか）

- Cursor / Claude / Copilot 等は一般に許可。ETHGlobal は LLM の利用を公式に歓迎している。
- どこを AI が助けたかを提出に書く。
- AI だけで、チームの実質貢献が無い提出は Partner / Finalist 対象外になり得る。
- spec-driven なら仕様・プロンプト・計画もリポに同梱する。
- **動画の AI 読み上げ / TTS は自動却下。** 人間の声。720p以上。2–4分。携帯電話撮影禁止。倍速禁止。BGM＋字幕だけの説明禁止。

### 1.4 賞の仕組み

- 提出時に Partner Prize は **最大3**（1パートナーの複数トラックは1枠）。
- パートナーは非同期審査。Finalist に残らなくても賞は取れる。
- 非同期大会では、賞金の大半はライブ審査に進まない提出に払われる。
- ライブ審査に進むのはおおよそ上位20%。Finalist は 4分デモ + 3分 Q&A。
- 提出選択肢: Finalist and Partner Prizes / Partner Prizes Only。既定は前者（非同期の機会を捨てない）。

### 1.5 審査5項目

Technicality / Originality / Practicality / Usability / WOW Factor。

非同期では**動画が本体**。Continuity は「既存が過半」だと点が出にくいので、動画の最初の60秒は**新しい動詞**だけにする。

---

## 2. AI と連携して受賞する原則

差がつくのは入力速度ではない（誰でも LLM を使う）。差がつくのは、何を作るか、何が動くか、誰の賞に出すか。

- アイデアと SDK 習熟は会期前にしてよい。Classic では本体実装はキックオフ後。Continuity では既存は持ち込めるが、**賞の対象は会期中の差分**。
- 時計はどのトラックも同じ（対面は約36時間。ETHOnline は約12日）。
- 「AI エージェント × チェーン」の薄いラップは飽和。勝ちやすいのは、**特定の面倒がオンチェーンで本当に終わる**こと。
- 人間: 企画、 Continuity 申請、スポンサー、本番の鍵と実tx、デモ音声、提出クリック、公開数字の最終確認。
- AI: 会期中の実装、テスト、git 境界、CHANGED_FILES、AI_USAGE、動画台本、賞コメント下書き。
- AI 開示は [`../applications/ai-usage-disclosure.md`](../applications/ai-usage-disclosure.md)。弱めない。
- 旧製品動画 [`../applications/video-script.md`](../applications/video-script.md) は **Continuity 提出に使わない**。

---

## 3. 提出リポジトリの現状（2026-08-22 時点）

- 公開: https://github.com/kzmttkc/vet402（MIT、homepage vet402.com）
- トピック: `x402` / `base` / `erc-8004` / `ai-agents` / `payments` / `usdc` / `solana` / `verification`
- ローカル `~/vouch` の origin は同一。`main` は Continuity 文書コミットまで一致。
- 既存として開示: Observatory、スコア、SDK / MCP、`/decisions`、`/impact`、再現 CLI、SpendGuard（**判定のみ。署名しない**）。
- 8/21 マージ済み: ERC-8004 Validation Registry の **dry-run**（読み取り専用・鍵なし）。Mumbai で新しいのは本書き込み。
- 会期前準備のみ: `docs/ethonline-2026/`（仕様と git。`payOrRefuse` 本体は未着手）。
- まだ無い: `pre-ethonline-2026` タグ、`ethonline-2026` ブランチ。
- スター数は審査より、会期中差分と本番実測が効く。

SpendGuard の穴（提出の物語）: エージェントは `evaluate()` を無視して署名できる。`payOrRefuse` がその穴を閉じる。

---

## 4. 3連戦 — 大会ごとに動詞を1つ

同じダッシュボードを3回出さない。審査で見せるのは、その週末に初めて動いた能力だけ。

| 大会 | 期間 | 動詞 | 一文 | 既存 | 会期中に初めて動かすもの |
|---|---|---|---|---|---|
| ETHOnline | 2026-09-04 → 09-16（非同期・**提出は 09-13 12:00 EDT** まで） | `payOrRefuse` | スコアを見てから払うな。拒めるなら、払うな。 | 判定と観測 | 署名前に拒み、ALLOW だけ実 x402 |
| Tokyo | 2026-09-25 → 09-27（36h 対面） | `resolve-then-pay` | エージェントはアドレスではなく、名前に払う。 | 支払い原始 | ENS 解決してから `payOrRefuse` |
| Mumbai | 2026-11-06 → 11-08（36h 対面） | `write the registry` | 支払いの証明はある。履行の証明を、空のレジストリに書く。 | Registry dry-run | 実際のオンチェーン書き込み |

サイト上の「building」は Registry 書き込み。Mumbai まで温存する。

会期と会期のあいだに次大会の機能を実装すると、Continuity の新規が消える。それがこのキャンペーンが死ぬ唯一の経路。

| 期間 | やってよい | やってはいけない |
|---|---|---|
| 今〜9/3 | 習熟、仕様、タグ準備、申請 | `payOrRefuse` 本体 |
| 9/4–16 | ETHOnline 差分のみ | Tokyo / Mumbai 機能、Origins 実装 |
| 9/17–24 | ENS 習熟、仕様、運用 | Tokyo 機能の実装 |
| 9/25–27 | Tokyo 差分のみ | Registry 本書き込み |
| 9/28–11/5 | ERC-8004 習熟、仕様、運用、Token2049 営業 | Mumbai デモ用の本書き込み |
| 11/3–5 | Devcon 面談 | ハッカソン実装との往復 |
| 11/6–8 | Mumbai 差分のみ | 既存の再提出 |

大会ごとタグ: `pre-ethonline-2026` → `pre-tokyo-2026` → `pre-mumbai-2026`。前回の提出は次では「既存」。

---

## 5. ETHOnline 2026（最優先）

### 5.1 勝ち方

総合優勝は狙わない。**Partner 最大3 + Finalist は任意**。非同期では賞金の大半が Partner にあり、パートナーは Finalist 順位を見ない。

確度の順（[`WIN_EV.md`](../ethonline-2026/WIN_EV.md)）:

1. 失格確率をほぼゼロにする。
2. 拒否 **と** 公開 Base tx の両方を保証する（自前 seller を先に）。
3. 新しい経路が実際に呼ぶ賞を3つ選び、審査前にそのスポンサーへ見せる。
4. 動画を自動却下させず、最初の60秒を新動詞にする。

### 5.2 会期中スコープ（4つだけ）

1. SDK `payOrRefuse` — 先に SpendGuard。`allow` のときだけ signer。x402 `exact`（Base USDC）→ attest。ALLOW 以外は機械可読な理由で拒否。signer は呼ばない。
2. MCP `pay_if_trusted` — 同じ。BLOCK/WARN で mock signer 呼び出し0回をテストで証明。
3. `/decisions` の **別枠** `source: agent-demo`。L1 の 1:1 台帳（`x402_l1_purchases`）には混ぜない。
4. `examples/ethonline-2026-agent/` — `run.ts block` / `run.ts allow`。

追加（確度）: 会期中の開示済み自前 seller（`examples/ethonline-2026-agent/seller`）。ALLOW の第一ターゲット。カタログ ALLOW は任意。

範囲外: ENS、Registry 本書き込み、新チェーン、Uniswap/Sui、新スコア、UI 刷新、提出前の npm publish。

### 5.3 設計制約（要約）

- `trustPolicy` は `allow-only`。WARN 上書きなし。
- 402 の payTo が `payee` と違えば署名前に `payee_mismatch`。
- 金銭ゲートは観測と同じ: Base、正規 USDC、`exact`、EIP-3009、1件あたり上限（既定 $1）。
- 拒否時: RPC send / `signTypedData` / facilitator settle はゼロ。
- attest は関数の一部。デモが省略できない。
- デモ用ウォレットは人間が保持。ガス + **USDC $5**。キーは git に入れない。

### 5.4 カレンダー（要約）

詳細は ROADMAP。上書きは WIN_EV。

- **8/24 まで:** Continuity 申請。無いと以降は無意味。
- 8/25–9/2: フィクスチャ、賞ページ監視、既存 SpendGuard のリハーサル（支払いはしない）。
- **9/3:** タグ `pre-ethonline-2026`。ブランチは 9/4 まで切らない。
- 9/4: 失敗テストのみ（red）。賞ページをスクショし `PRIZES.md` を作る。
- 9/5–6: `payOrRefuse` green。
- 9/7: MCP。
- 9/8: 自前 seller + 公開 tx（カタログより先。予備日 9/9）。
- 9/9: agent-demo decisions の別枠。
- 9/10: デモエージェント（`run.ts block` / `run.ts allow`）。
- 9/11 午前: 賞のための薄い import 最大4時間。午後: 動画ドライラン（却下チェック）と **18:00 JST 機能凍結**。
- 9/12: 本番動画。README はできたことだけ過去形。AI 開示。
- **9/13 午前（JST）:** `--no-ff` マージして提出。
- 9/14–16: 審査期間。提出物は触れない。

**提出締切（一次確認 2026-08-23・訂正）:** **9/13 12:00 EDT ＝ 9/14 01:00 JST**。
出典 https://ethglobal.com/events/ethonline2026/info/details （原文「Sunday, September 13th 2026 at 12:00 pm EDT」・Late submissions are not accepted）。
会期は 9/4→9/16 だが後半は審査。8/22 版が書いていた「9/15 朝提出・ROADMAP 9/15 18:00 UTC」は**締切超過**だったので、全日程を2日前倒しした。提出目標は 9/13 12:00 JST（13時間の余裕）。

### 5.5 賞のヒューリスティック

**2026-08-23 訂正:** 公式リストは既に公開済みだった（パートナー9社・$77,000）。実測の正典は [`../ethonline-2026/PRIZES.md`](../ethonline-2026/PRIZES.md)。**Base / Coinbase CDP / x402 facilitator はこの大会にいない**ので、下の1位は選べない。動詞と正面一致するのは **Hedera 🤖 AI & Agentic Payments $6,000**（要件: Hedera 上の x402 ゲート付きサービス＋Blocky402 facilitator＋実有償リクエスト1件）。詳細 coming soon の5社があるため 9/4・9/9・9/12 に再読する。デモが存在してから確定。

1. Base / Coinbase CDP / x402 facilitator（ALLOW がそのレールを通った）。
2. デモが呼んだエージェント / MCP / ウォレット。
3. 新しい動詞が使う Continuity 専用賞。

選ばない: ENS（Tokyo）、Sui、swap の無い Uniswap、import していないロゴ。

9/8 以降、選んだ3社の Discord に人間がデモを投げる。

### 5.6 動画（ETHOnline）

WIN_EV がキャンペーン草案より優先。カタログから始めない。

1. 10秒 — `git log pre-ethonline-2026..ethonline-2026`
2. 25秒 — `run.ts block` → 署名しない
3. 25秒 — `run.ts allow` → Explorer の tx
4. 一文 — 「すでに買って公開している。今週末、スコアを無視して署名できる穴を閉じた。」

人間の声。≥720p。2:00–3:50。ALLOW の tx が無いなら拒否を伸ばし、決済したとは言わない。偽ハッシュは出さない。

### 5.7 Continuity 申請文（ETHOnline）

> Track: Extend Open Source  
> Repo: https://github.com/kzmttkc/vet402 (MIT, maintained by this team)  
> Site: https://vet402.com
>
> vet402 is an independent verification layer for the x402 agent-payment economy. It already buys what endpoints sell, publishes successes and failures with evidence, and exposes ALLOW / WARN / BLOCK via SDK and MCP. SpendGuard today **decides** and does not pay — an agent can ignore the verdict and sign.
>
> We are not submitting the existing product. During ETHOnline we will add **payOrRefuse**: one call that evaluates the payee and, only on a clean ALLOW, performs an x402 `exact` payment and attests it. BLOCK/WARN refuse before any signature. Demo decisions publish to the public decisions surface as `source: agent-demo`, separate from the L1 observatory ledger.
>
> Git boundary: tag `pre-ethonline-2026` (2026-09-03). Work on branch `ethonline-2026` with commit prefix `ethonline:`. Pre-existing files we touch will be listed in `docs/ethonline-2026/CHANGED_FILES.md`.

### 5.8 会期前にやってはいけないこと / よいこと

やってよい: スポンサー SDK 習熟、テストネット、ウォレット、デプロイ手順、問題調査、賞の読み込み、ワンライナー、仕様、チェックリスト、デモ台本、公開ライブラリ選定、ENS 名の取得（コードではない）、申請。

やってはいけない（9/4 まで）: `payOrRefuse` / `pay_if_trusted` / デモエージェント / 自前 seller の本体実装。キックオフ前の「少しだけ」。

---

## 6. ETHGlobal Tokyo 2026

- 9/25–27、Toranomon Hills Forum。応募締切の目安 **9/23**（ETHOnline 会期中に出す。8月中がよい）。
- 公表パートナー（変動あり）: ENS、Uniswap Foundation、World、Sui、1inch。
- 動詞: 支払い先を ENS 名で指定。検証/観測を ENS records へ。`payOrRefuse` は解決のあと。
- 任意: World ID 等による WARN / 高額の人間上書き。ENS がカメラで動くまで始めない。
- 賞: **ENS Continuity 必須**。World は上書きを出したとき。Sui は選ばない。Uniswap は本物の swap がデモに無い限り選ばない。
- 金曜夜までに ENS メンターへ見せる。土曜で機能凍結。日曜提出。
- git: `pre-tokyo-2026` / `tokyo-2026` / 接頭辞 `tokyo:`。
- 完了: 動画最初の1分が hex ではなく名前。

---

## 7. ETHGlobal Mumbai 2026 と Devcon 8

- Mumbai ハッカソン: 11/6–8。
- Devcon 8: 11/3–6、Jio World Centre。Pragma Mumbai: 11/5。Diwali: 11/8。
- **Devcon は行く。Mumbai とセット。** 片方だけはしない。
- チケット: 今週。Ethereum Public Goods（$349 ETH）が通ればそれ。通らなければ General を ETH（$499）。法定通貨 $999 は使わない。ホテル 11/2 泊〜11/8。
- 11/3–5 は面談だけ。8件（ERC-8004 / EF、Base、CDP / x402、ENS、Mumbai スポンサー）。観測と dry-run 数字を見せ、「今週末これを書いたら賞の対象か」を聞く。ワンペーは impact-one-pager + dry-run ガス。
- トークは、その人が審査側でない限り座らない。Pragma は体力が無ければ欠席。
- 11/5 夜で切り上げ。11/6 からハッカソンのみ。往復しない。
- 動詞: L0–L2 を ERC-8004 Validation Registry に書く。失敗も同じ重み。他人が vet402.com を信じずに tx を検証できる。
- 賞: 発表後。8004 / 身元 → Base → x402 隣接。Devfolio の別イベント「ETHMumbai」（Elsa x402 等）は、ETHGlobal の賞ページに無い限り見ない。
- git: `pre-mumbai-2026`（11/5）/ `mumbai-2026` / 接頭辞 `mumbai:`。
- 範囲外: 新スコア、Tokyo 以降の ENS 追加、Solana 書き込み。

---

## 8. Token2049 Singapore（参加するがハッカソンには出さない）

- 本会議: 2026-10-07〜10-08、Marina Bay Sands。Week: 10/5–11。
- 公式ハッカソン: [Origins](https://www.token2049.com/singapore/2049-origins)、10/6–8、36時間、現地必須、参加無料（本会議込み）、チーム最大4、ソロ可。
- 応募締切 9/14（ETHOnline 会期中）、発表 9/28（Tokyo 翌日）。
- 賞: FAQ 上おおよそ $100k（公式ページは TBA）。
- **公式FAQ: キックオフ前のコード・デザイン・プロトタイプ不可。** Continuity は無い。`kzmttkc/vet402` 持ち込みは失格。
- 既定: **Origins に vet402 では出ない。** Tokyo 直後・Mumbai 直前の36時間は、Registry 書き込みの確度を落とす。Origins で本体を触ると Mumbai の新規が汚れる。
- Token2049 週の使い方は Devcon と同じく**面談**（x402 / Base / Circle / ENS / VC）。サイドイベントは [week.token2049.com](https://week.token2049.com)。
- ステージに載せたいなら **NEXUS**（既存プロダクトのピッチ）。実装しない。
- 例外（非推奨）: Origins に出すなら空リポの新しいクライアントのみ。`vet402.com` API を外部依存として開示。本体リポは触らない。Registry 書き込みは入れない。本会議チケットが Origins 経由で必要な場合のみ検討。

---

## 9. 役割

| 人間 | エージェント |
|---|---|
| Continuity / 各大会の申請、stake、渡航、Devcon / Token2049 面談 | 開いた会期内の実装 |
| メインネット鍵、USDC、初回 ALLOW のクリック | テスト、docs、動画台本、賞コメント下書き |
| スポンサー Discord、デモの声 | 小さいコミット、CHANGED_FILES、AI_USAGE |
| 提出クリック、公開主張の「これは今日正しい」 | 起きていない仕事を主張しない |

---

## 10. やらないこと

- 同じダッシュボードを薄い皮で3回出す。
- Sui / 中身の無い Uniswap / 新チェーンで3枠目を埋める。
- 前大会がうまくいったから次の機能を「少し早く」始める。
- AI 開示を弱める。動画を AI 音声にする。
- Devcon で終日聴講する。
- Token2049 Origins に vet402 本体で出る。
- Continuity 未申請のまま会期に入る。
- 偽の tx / 偽の ALLOW スコア。
- L1 台帳にデモ行を混ぜる。
- 旧 `video-script.md` を ETHOnline 提出に使う。

---

## 11. グラント（要約）

詳細は [`GRANTS.md`](./GRANTS.md)。ハッカソンは「新しい動詞の証明」、グラントは「測り続ける資金」です。同じ成果を二度売らない。

- 今すぐ（新コードなし）: Base Builder Grants（レトロ、1–5 ETH 目安）。**OP Atlas は 2026-08-23 に対象外と確定**（Atlas は 2026-09-18 に廃止告知・ミッションは Closed・要件の「デプロイ済みコントラクト」に元々非該当。[`GRANTS.md`](./GRANTS.md) P0-3）。数字は提出当日に `curl`。
- Continuity 申請のあと: 既存の Solana 案（実費 $5,907.75、人件費ゼロ）。実装はハッカソン枝に載せない。ETHOnline 提出後がよい。
- 各大会の提出後: その動詞を「これから作る」ではなく **証拠** として次の助成に使う（ETHOnline→Base/x402、Tokyo→ENS DAO、Mumbai→EF/8004）。
- ESP は公募窓口ではない。Devcon の Office Hours で Wishlist/RFP に合わせる。
- カタログ向けマーケ費用は申請しない（中立）。

## 12. 今週（戦略ファイル化時点）

1. ~~ETHOnline Continuity 申請~~ → **2026-08-23 提出済み**（フォーム内のトラック欄で `continuity-track` を選択・審査中）。次は採択メールと **ETH ステーク**（Takeshi の手番・資金移動）。
2. Tokyo Continuity 申請（15分。締切 9/23）。
3. デモ用ウォレット、ガス、USDC $5、API キー（git 外）。
4. Devcon チケットとムンバイのホテル。
5. 数字を当日更新し、Base Builder Grants に既存メモで申請／ノミネート（OP Atlas は対象外と確定したので作らない）。
6. `payOrRefuse` は実装しない。Solana L1 も ETHOnline 提出まで始めない。

---

## 13. 公式リンク

- 規則: https://ethglobal.com/rules
- イベント一覧: https://ethglobal.com/events
- 提出リポ: https://github.com/kzmttkc/vet402
- 本番: https://vet402.com
- Devcon チケット: https://devcon.org/en/tickets/
- Token2049 Origins: https://www.token2049.com/singapore/2049-origins
- Token2049 Week: https://week.token2049.com
- Base 資金: https://docs.base.org/get-started/get-funded
- EF ESP: https://esp.ethereum.foundation/

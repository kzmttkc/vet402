# ETHOnline 2026 会期の正典（2026-09-03 深夜・確定版）

> **この1枚が正典。** 会期中に迷ったらここへ戻る。
> ROADMAP.md / WIN_EV.md / DESIGN_payOrRefuse.md / WORK_ORDERS の該当節は**参照資料**であり、
> 食い違ったら**このファイルが勝つ**（5体の並行監査で「どの文書が正典か壊れている」が最大リスクと判定されたため）。
> 会期: 2026-09-04 00:00 UTC 〜 提出 09-13 12:00 EDT（＝09-14 01:00 JST）。目標提出 09-13 12:00 JST。

---

## 0. 参加状態（2026-09-03 実測・ダッシュボード）

- **"You are fully confirmed to attend this event!"** — 参加確定。ステーク懸念は解消
- **トラック = Continuity（`continuity-track: checked=true`／`building-from-scratch: false`）**
- プロジェクト `payOrRefuse` 作成済み・Discord 連携済み（sen_web3）
- 提出フォームは未開放（"Project submissions are not enabled yet"）

## 1. 賞（上限3枠・1パートナー1枠）

| | 賞 | 額 | 状態 |
|---|---|---|---|
| **P1** | The Graph 🤖 Best AI Tooling **or AI Use Case**（Continuity） | **$5,000** | **最優先。** live データ消費の技術的前提は 9/3 実証済み |
| **P2** | Bazantic 🤖 Help an Agent Use Your Hackathon Project | **$1,000** | 取る。**ただし Gateway の 402 を解消するまで A/B が測定不能** |
| ~~P3~~ | ~~World 🤖 AgentKit Continuity $3,500~~ | — | **切る（2026-09-03 決定）** |

**World を切った理由**（Takeshi 回答＋実測）: AgentBook 登録は `@worldcoin/idkit-core` の
`DEFAULT_VERIFICATION_LEVEL = "orb"` により **Orb 認証が必須**。Takeshi は過去に Orb 済みだが、
**証明が他人に預けたデバイス内にあり会期中に取り出せない**。加えて要件4（World ID Sandbox で遠隔テスト）は
公開版 CLI に environment 切替が無く**構造的に満たせない**。5要件中2つが未達確定の枠に会期の1.5日は使わない。
**切って得るのは枠ではなく2日**——それを P1 と本体に戻す。

- The Graph の枠は3つあるが **continuity ラベルは AI 枠1つだけ**（Composable と From Scratch は選べない）
- Arc $1,666 は Arc チェーン上の DeFi 要件のため対象外（既決）
- **AgentBook の live 解決だけ**（Orb 不要・鍵不要）は 09-11 午前の任意アダプタ枠に置く。本体が全部緑のときだけ

## 1.5 The Graph との過去の関係について（2026-09-04 Takeshi 指示・行動の縛り）

Takeshi は 2020-06〜2025-04 の約5年間、The Graph の日本コミュニティマネージャー（契約）だった。
**これを賞に使わない。** 指示は一文で「元コミュニティマネージャーがハッカソンに参加した。それだけ。他と同じに扱う」。

したがって:

- **便宜を求めない。** 審査への口利き、要件の緩和、事前の内定めいた確認を頼まない
- partner channel で聞くのは**誰でも聞ける要件の確認**だけ。他の参加者が受け取れない情報を求めない
- 提出物で関係を**売り文句にしない**。聞かれたら事実を答える
- **提出物の強さは、動くものと実測だけで作る。** それが我々のブランド（検算できる会社）と一致する

この節は、将来のセッションがこの関係を「使える札」と誤解しないために置く。

## 2. 会期スコープ（**5件**。これ以外を作らない）

1. **`payOrRefuse`（SDK）** — `/decision?role=payer` を引き、ALLOW かつ policy 通過時のみ signer に到達。
   拒否は署名前・機械可読な理由。通過時のみ x402 `exact` で払い **attest まで関数の一部**
2. **MCP `pay_if_trusted`** — 同じ関門。README と **SKILL.md**（P1 が名指しで要求）
3. **The Graph 証拠源** — `evidence[].source` を **実装・OpenAPI・SDK型・MCPスキーマの4面同時**。
   `source` 行に `subgraphId` / `block.number` / `deployment` / `queriedAt` を同梱（live の唯一の自明な証明）
4. **`source: agent-demo` の決定面** — 別ストア。**`x402_l1_purchases` に入れない**（テストで固定）
5. **A/B 実証ハーネス** — 同一モデル・同一プロンプトで「生のAPI情報だけ」vs「Recipe つき」。
   P2 の中核であり、**動画の冒頭でもある**

**範囲外**: 自前 seller の新設（ALLOW 対象が本番に373件あるため不要）、World 本実装、ENS、
Registry 本書き込み、新チェーン、Uniswap/Sui、スコアエンジン変更、UI 刷新、提出前 npm publish。

## 3. 支払い先を The Graph 本体にする（2026-09-03 決定・実測済み）

```
POST https://gateway.thegraph.com/api/x402/subgraphs/id/<ID>  → HTTP 402
x402Version 2 / scheme exact / eip155:8453 / amount 10000（$0.01）
asset 0x8335…2913（正規USDC）/ payTo 0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB / eip3009
```

**既存のマネーゲートを1行も変えずに通る。** ALLOW の支払い先はここにする。理由:
- 自前 seller への自己送金は審査員に自作自演に見え、賞と無関係
- **払った tx が Basescan に残る**ので録画外で検算できる
- そして**核心**——同じウォレットについて2つの情報源が違うことを言う（9/3 実測）:

| | |
|---|---|
| 我々のエンジン | **WARN 69・thin**（L1配達 0・x402受領 0・独立payer 0） |
| The Graph の subgraph | **RECIPIENT・252件・2.52 USDC** |

**審査員が自分の会社のウォレットを我々のサイトに入れると WARN 69 が出る。** その1点差を埋めるのが
会期中に足す `evidence.source`。細工ではなく実在の欠損で、被写体が審査員自身。

**注意**: 402 の `resource.url` は内部ホスト名（`http://mainnet-thegraph-arbitrum-03-…`）を返す。
**照合は `payTo` で行う**。resource URL で照合する実装を入れると The Graph に払えない（テスト B-4）。

## 4. Day 0（09-04）に書く失敗テスト —— **22項目・24本**（G21 は MCP 側で a/b/c の3本）

> 実体: `packages/sdk/test/pay-or-refuse.test.mjs`（A1〜H22 の21本）＋ `packages/mcp-server/test/pay-if-trusted.test.mjs`（G21a/b/c）。
> テスト名の先頭がこの番号。**番号と本数を混ぜて数えない**（09-04 に「22本」と書いて実体24本と食い違った）。

**A. 署名に到達しない（提出物の核心）**
1. `/decision` が ALLOW 以外 → signer 0回
2. `/decision` が degraded → signer 0回
3. `/decision` の取得失敗（HTTPエラー/タイムアウト）→ signer 0回（fail-closed）
4. 402 の `payTo` が `payee` と違う → `payee_mismatch`・signer 0回

**B. 金銭ゲート（旧17本から欠落していた4本。本番に4チェーン提示の402が実在するため必須）**
5. Base 以外のネットワーク（`eip155:1` / `solana:…`）→ 署名前に拒否
6. 正規USDC 以外の asset → 署名前に拒否
7. `exact` 以外の scheme / `eip3009` 以外の `assetTransferMethod` → 拒否
8. `0x` でない payee（ENS 名）→ 呼び出し側エラー。**解決もしない・署名もしない**

**C. policy**
9. `maxPerTxUsd` 超過 → `price_above_ceiling`（判定を引く前に落とす）
10. `evidence.minL1Deliveries` 未達 → `insufficient_delivery_evidence`
11. `evidence.minSubgraphReceipts` 未達 → `insufficient_subgraph_evidence`
12. `source: "both"` で片方しか読めない → 拒否し、**どちらが読めなかったか**が理由に入る

**D. The Graph 経路の fail-closed**
13. Gateway が 403/5xx/タイムアウト → `evidence_unavailable`・signer 0回
14. **全 Graph リクエストに User-Agent が付く**（無いと Cloudflare 1010。共通ラッパの単体テスト）
15. `source: "subgraph"` の決定行に **subgraphId と `_meta.block`** が載る（賞の証跡要件）
16. 自社台帳の件数と subgraph の件数を**1つの数に合算しない**

**E. 通過時**
17. 全条件通過時のみ signer を1回呼び、返った txHash で attest する
18. 署名後に settle 失敗 → `status: "failed"` を返し**公開する**（隠さない）

**F. 汚染しない**
19. デモの決定行は `source: agent-demo` で `x402_l1_purchases` に入らない
20. L1 フィードはデモ行を無視し、デモフィードは L1 行を無視する

**G. MCP**
21. `pay_if_trusted` が A の4本と同じ拒否を返し、mock signer 0回。**ALLOW で1回だけ呼び attest する**

**H. ネガティブコントロール（最重要・旧17本に無かった）**
22. **同じハーネスで ALLOW 経路を1本走らせ、`signTypedData` が「ちょうど1回」・settle が「ちょうど1回」**
    現れることを assert する。**これが無いと「0回」は「配線されていない」と区別できない**

### 「呼べない」をどう証明するか（4層）

1. **account を Proxy で包み**、`get` トラップで全プロパティアクセスを記録。拒否時は
   「`sign` で始まるプロパティが一度も参照されていない」を assert（`signTypedData` の回数だけでは足りない）
2. 注入する `fetch` を**許可リスト方式**に。拒否経路の許可は `/decision` と 402 を取る GET だけ。
   facilitator `/settle`・RPC・Graph Gateway は**呼ばれた時点で throw**。viem 側も
   `eth_sendRawTransaction` / `eth_signTypedData_v4` を受けたら throw する transport を渡す
3. 支払い実装を **ALLOW ブランチ内の動的 import** に置き、拒否経路走行後に
   **モジュールのファクトリが一度も評価されていない**ことを assert。加えて既存の AST 走査テスト
   （`tests/acceptance-spec-1-2.test.ts` の実績）で「`decision.allow` の真ブランチ外に signer 参照が無い」を固定
4. **22番**（ネガティブコントロール）を SDK と MCP の両方で走らせる

## 5. 日程（これが確定版。ROADMAP §6 と WO §5 は破棄）

| 日 | 作業 |
|---|---|
| **09-04** | 会期直前に**タグを main 先端へ打ち直す**（§7）→ ブランチ `ethonline-2026` を切る → **22本を red で1コミット** → 賞ページ全文再読 → フィクスチャ再測（C1 5ケース含む） |
| 09-05–06 | #1 `payOrRefuse` green。**09-06 に P2 継続可否を判定**（Bazantic の402が解消していなければ落とす） |
| 09-07 | #2 MCP `pay_if_trusted` ＋ SKILL.md の骨 |
| 09-08 | #3 The Graph 証拠源（4面同時）＋ The Graph への実支払い1件 |
| 09-09 | #4 agent-demo 決定面 ＋ 実 Base tx の確定 |
| 09-10 | #5 A/B ハーネス20試行・集計。デモ2コマンドを本番相手に通す |
| 09-11 | AM: 任意アダプタ最大4時間（AgentBook 解決はここ・本体が緑のときだけ）。PM: 動画ドライラン・フィクスチャ再測・**18:00 JST 機能凍結** |
| 09-12 | 本番動画。README 開示・AI_USAGE・CHANGED_FILES・prize comments |
| **09-13 午前(JST)** | `--no-ff` マージ → 提出。**目標 12:00 JST**（締切まで13時間） |

## 6. 動画（2:00–3:50・人間の声・AI音声は自動却下）

**冒頭を A/B に置く。**「拒否」は何も起きないので、**何かが起きた画と並べたときにだけ**意味を持つ。

| t | 画面 | 言うこと |
|---|---|---|
| 0:00–0:12 | 左右分割。同じモデル・同じプロンプト。**左は 402 に当たって即署名 → tx が出る**。右は署名せず1行 | 同じエージェント。左は一度も検証していない相手に払った。右は署名が存在する前に止まった |
| 0:12–0:25 | 左の tx を Basescan で開く | この支払いは本物で、たぶん問題ない。**問題は、エージェントにそれを知る手段が無かったこと** |
| 0:25–0:45 | vet402.com / observatory（タグを小さく重ねる） | 自腹で [N] 回買って、レシートも失敗も公開してきた。**それは今週の話ではない**。できなかったのは署名を止めることだった |
| 0:45–1:15 | `run.ts refuse`。**2カラムで左に我々の `/decision`、右に The Graph のレスポンス（`_meta.block` を映す）** | 我々はこの相手を**見た**（L0 pass）が、**一度も買っていない**——L1 ゼロ。The Graph の subgraph は block [B] 時点で [M] 件の受領を知っている。**2つの独立した情報源が、違うことを知っている**。（09-04 実測: 拒否側は C1 に測られ `l0_unverified` → `l0_pass, l1_not_attempted` へ動いた。「見てもいない」ではなく「見たが買っていない」で言う） |
| 1:15–1:30 | 拒否行のズーム（`l0_unverified, l1_not_attempted`・`evidence[].source`） | だから拒む。理由コードは**売り手を責めていない。我々の欠損を名指ししている** |
| 1:30–2:05 | `run.ts pay` → **The Graph の gateway に $0.01** → Basescan → attest → `/decisions` | 証拠がある相手には払う。**払う先は The Graph 自身**。既定 policy を通る相手は今日 373 件 |
| 2:05–2:25 | テスト実行。**署名0回・RPC0回・settle0回が緑で並ぶ**＋ネガティブコントロールが1回を検出する | signer は拒否経路から**到達できない**。0回で緑になるのが配線ミスでないことも、同じハーネスで示す |
| 2:25–2:45 | SDK 3行 → MCP 1ツール → `source: "subgraph"` に切り替える差分 | `source: subgraph` にすれば**我々の台帳を1行も読まない。あなたは我々を信じなくてよい** |
| 2:45–3:10 | `git log <window-open>..ethonline-2026` ＋ CHANGED_FILES | 新規はこのブランチだけ。触った既存ファイルは列挙。**AIがコードの大半を書いた。開示は弱めていない** |
| 3:10–3:25 | 冒頭の分割画面（静止） | 今週まで vet402 は「払ってよいか」に**答えられた**。今週、**署名が存在する前に拒む**ことを覚えた |

**数字は撮影当日に取り直す**（`[N]` `[B]` `[M]` `373`）。出典に無い数字を口に出さない。

## 7. 境界タグの打ち直し（09-04 09:00 JST 直前・必須）

現状 `pre-ethonline-2026` = `ec264ca`（9/2 19:58）で、**タグ以降 main に9コミット・`src/` に実コード164行**が入った。
main は本番リポでもあり会期中も動くので、放置すると `git log pre-ethonline-2026..main` に**提出外が混入**し、
規約の「会期中に作ったと誤認させる」に触れる。

1. 09-04 09:00 JST 直前、**その時点の main 先端に注釈タグを打ち直す**（会期前の移動は正当）
2. ブランチ `ethonline-2026` は**そのタグから**切る
3. 提出物の検算コマンドは `git log --oneline <tag>..ethonline-2026` に統一し、一文添える:
   「main はこの製品の本番リポでもあり、会期中も提出とは無関係な運用コミットを受ける。提出範囲は接頭辞 `ethonline:` のこのブランチのみ」

## 8. 規約適合（会期中にやる・忘れると失格側に触れる）

- **`docs/ethonline-2026/PROMPTS/`** を作り、**その日の指示文をその日のうちに置く**。規約は
  "all spec files, **prompts**, and planning artifacts" を要求し、我々は prompt が**0件**だった。
  後から再構成したものは planning artifact にならない
- **`AI_USAGE.md` にファイル単位の表**。規約は "specifying which parts of the code, specific files… were generated or assisted by AI"。
  新規ファイルを作った**同じコミットで1行**足す（CHANGED_FILES と同じ運用）
- **人間の実質貢献を事実として列挙**（申請・鍵・実オンチェーン支出の承認・音声・提出クリック・フィクスチャ差し替えの可否判断）
- **運営への追加の書面開示**を09-04に1本: 8/23 の申請以降に入った 8/25 evidence policy と
  **9/2 の製品定義書 v1.0（58コミット・138ファイル・+6,615行）**、9/3 の9コミット。
  **先に量を言えば境界の証拠になり、言わなければ隠したように見える**
- README の「Product spec v1.0, shipped 2026-09-02」に **(58 commits, 138 files, +6,615 lines — all before the window)** を添える

## 9. 訂正済みの前提（古い記述を信じない）

| 誤り | 正 |
|---|---|
| 「ALLOW は構造的に出ない・カタログ全体が止まる」 | **9/2 の `/decision` で ALLOW は出る。既定 policy を通る endpoint は 373 件**。fixtures §1〜§3・DESIGN §2〜§3 の当該記述は無効 |
| 「The Graph の3枠が1つに統合」 | 統合していない。**continuity ラベルは AI 枠1つだけ** |
| 「`vet402.com/mcp` で MCP を公開している」 | **していない**。POST に HTML を返す。我々の MCP は stdio 配布物。hosted なのは Bazantic 側だけ |
| 「Bazantic の MCP は稼働している」 | `initialize`/`tools/list` は 200 だが、**`tools/call` は 402 で1本も使えない**。接続と利用は別 |
| 「World の賞文に without requiring an Orb とある」 | それは **Selfie Check の説明文**。AgentKit 枠のものではない |
| デモコマンド名 `block`/`allow`/`catalog` | **`refuse` / `pay` に統一** |
| 「旧スコアAPIは誰にでも WARN しか返さない」 | **09-04 実測で変化**。kronossignals は **82 / ALLOW / rich**（我々の L1 配達が証拠として効くようになった）。一方 **The Graph の受取ウォレット `0x79DC…` と拒否側 `0xb15a…` は 69 / WARN / thin のまま**。§3 の対比（審査員の会社のウォレットが我々のエンジンで WARN）は**そのまま成立** |
| C1 リハーサル（8/29・9/2）の結果 | **09-04 再実行で A と D が allow=true に変わった**（旧スコアが ALLOW を出すようになったため）。C（実績0）は `payee_insufficient_evidence` で拒否のまま、E（上限超過）も拒否のまま。`signals.receiving` の項目名は維持されている（リリース条件1は守られた） |

## 10. 09-04 朝までに揃っていないと詰むもの

- [x] **タグ打ち直し**（09-04 11:5x・`c42daca`・ブランチ `ethonline-2026` 作成。**予定の 09:00 から約3時間遅れ**——通知を作って動かす仕組みを作っていなかった。再発防止は now.py の会期ブロック）
- [x] **デモ用の使い捨て鍵** `0xDB62BD202914609830fA656F87996b91be3Aa673`（`baz wallet new`・賞金受取とは別鍵）。**$0 ルートは残高ゼロで通ることを実測済み**（tx `0x62debbc1…`）
- [ ] 上記鍵へ **Base USDC を $1 程度**（§3 の The Graph への $0.01 実支払いに要る。ガスは facilitator 持ちなので ETH は不要。**Takeshi 手番・09-08 まで**）
- [x] **Bazantic の 402 解消**——`baz curl` ＋ 自前ウォレットで通った（呼び手の認証の問題だった。残高は不要）
- [x] 参加確定・Continuity 選択済み・プロジェクト作成済み
- [x] `GRAPH_API_KEY` / `VOUCH_API_KEY` / `BAZANTIC_UPSTREAM_KEY`（600・git無視）
- [x] 会期スコープが main に未実装（grep 0件で再確認済み）


## 11. Day 0（09-04）の実測記録

- 会期コミット: `b366921`（SDK 21本・MCP 3本、全て赤）＋ `PROMPTS/2026-09-04-day0-red-tests.md`
- 書いた直後に **2本が実装なしで緑**になった（`assert.rejects` がスタブの throw で通る／書き込み検査が無動作でも通る）。理由の中身と「判定を1回引いたこと」を要求する形に直して 21/21 赤へ戻した。**自分のテストが自分の原則を破っていた**
- フィクスチャ: 拒否側 `0xb15a55e8…` は `/decision` が **BLOCK → WARN**（`l0_pass, l1_not_attempted`・L1 0/0）。予告どおり C1 が測った。拒否は policy で作るので絵は壊れない
- 旧スコアAPI: kronossignals **82 ALLOW rich** ／ The Graph `0x79DC…` **69 WARN thin** ／ 拒否側 **69 WARN thin**
- C1 再実行: A allow / B allow / C 拒否(`payee_insufficient_evidence`) / D allow / E 拒否(`max_per_tx_exceeded`)
- Bazantic: `baz curl` で $0 ルートが**残高ゼロで成立**（tx `0x62debbc1…`・Basescan に実在）
- 構造: `now.py` に会期ブロックを常設（Day N・やり残し・タグ/ブランチ実測・拒否側 verdict）。状態は `state/ethonline_day.json`
- **事故1件**: この更新の直前に、編集スクリプトが途中で止まったまま git 手順が走り、**内容の無いコミットが main に載った**（メッセージだけがある空コミット）。共有 main なので履歴は書き換えない。原因は python の失敗と git 手順の間に `&&` の関門が無かったこと——同じ失敗を 09-02 にも記録している

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

## 1.4 運営 Discord から取った一次情報（2026-09-06 08:10・#information / #announcements 実読）

**Discord は `Sen_web3` でログイン済み**（ETHGlobal サーバー `554623348622098432`・Discordパートナー）。
読めるチャンネル: `#👂information`（`906117584838070293`）/ `#📣announcements`（`676529880292261888`）/
`#🌐ethonline2026-chat`（`1490278514057023589`）/ `#⏰event-schedule`（`951835994074783814`）/
`#🚨click-for-info🚨`（Tokyo・`956188917961478184`）。**書き込み権限は無い**（読み取り専用）。

### 【新事実・戦略に効く】Continuity のファイナリスト枠は **3つだけ**

> Continuity Projects are also eligible to become ETHGlobal Finalists.
> **We will have a maximum of 7 Projects from the traditional (Start From Scratch Track) and
> a maximum of 3 Projects from the Continuity Track**
> —— Pascal | ETHGlobal, #information, 2026-08-17

**我々の計画はパートナー賞（The Graph $5,000 / Bazantic $1,000）だけを見ていたが、
ファイナリストは別枠で、Continuity から3つ選ばれる。** 2025 は 634 プロジェクトで
ファイナリスト10だったので、**Continuity 枠は母数が小さいぶん相対的に厚い**可能性がある。
**提出時に「ファイナリストを狙わない」選択をしない。**

### 審査の流れ（2025 の実績・#information の当時の投稿から）

| | |
|---|---|
| 提出締切 | 締切後すぐ受付終了 |
| **Round 1** | **非同期**のファイナリスト審査。通過者に**メール**で連絡 |
| **Round 2** | **ライブ**のファイナリスト審査。**2025 は締切の約1日後**（10/26 締切 → 10/28 12:00 ET） |
| パートナー賞 | **非同期。ライブ審査に出る必要は無い**。ただし**提出フォームで該当パートナーに応募しておくこと**が条件 |
| ステーク返却 | **提出を成功させた者のみ**。返却はバッチで約1ヶ月後 |

**→ 我々への含意**: 提出は 09-13 だが、**ショートリストに入ればその翌日前後にライブ審査がある**。
Takeshi の手番になる可能性があるので、**09-14〜09-16 を空けておく必要がある**（TAKESHI_TODO に記載）。
**メールを見る**のも手番（Round 1 の通過連絡はメール）。

### ETHGlobal Tokyo 2026（#announcements 2026-08-18）

- **2026-09-25〜27・Toranomon Hills Forum（東京）**。Hacker / Mentor / Volunteer の募集が開いている
- 応募 URL: `https://ethglobal.com/events/tokyo2026/apply?role=hacker`
- **ETHGlobal Spotlight は締切済み**（08-18 の投稿時点で「あと2日」＝約 08-20 に終了）。**今回は取れない**

### 直近の投稿（2026-09-06 08:10 時点で最新）

`#announcements` の最新は **2026-09-05 の ETHOnline 2026 キックオフ**告知のみ。
**規約・締切の変更は出ていない。**

## 1.45 提出の要件（2026-09-06 08:20・運営の `info/details` と `prizes` を実読）—— **正典より厳しい点が5つあった**

### 動画（**canon が緩かった**）

| | 運営の規定 | 我々の記述 |
|---|---|---|
| 長さ | **2〜4分。範囲外はアップロード時に自動拒否** | 「2:00–3:50」＝範囲内。問題なし |
| 解像度 | **720p 未満はアップロードが失敗する** | **記述が無かった** |
| 撮影機材 | **スマホで動画を撮らない**（明示の禁止事項） | **記述が無かった**（TODO に「iPhone のボイスメモで可」と書いた。**音声はそれでよい。映像は不可**） |
| 音声 | **合成音声・AI ナレーションは不可** | 記述あり |
| その他の禁止 | 4分に収めるための**早回し**／説明文を**音楽＋テキストだけ**で流す | 記述が無かった |

**画面収録は PC で行い、肉声だけを別録りして重ねる。** これなら「スマホで動画を撮らない」に触れない。

### パートナー賞は **3枠**選べる（我々は2つしか使っていなかった）

> On the last step of the submission form, you can select **up to 3 Partner Prizes**.
> If a partner has multiple tracks, you can be eligible for all of them while only counting as 1 Partner Prize.

**1枠余っている。** 3枠目は §1.6 で決める。

### 提出は2択。**Finalist を選んでもパートナー賞の資格は下がらない**

> 1. Finalist and Partner Prizes — 選ぶと**ファイナリスト審査で発表**が要る。パートナーは非同期審査で**行動不要**
> 2. Partner Prizes Only
>
> The first round of judging **has no impact on your project's eligibility for partner prizes**.
> At most async events, **the majority of prizes are paid out to projects that do not advance to the live judging**.

**→ 1 を選ぶ。** Continuity のファイナリスト枠は3つ（§1.4）。**選ばない理由が無い。**
ライブ審査は **1チーム7分（デモ4分＋Q&A 3分）**。進むのは概ね**上位20%**。

### 審査基準は5つ。**Usability を我々は一度も考えていなかった**

**Technicality / Originality / Practicality / Usability (UI/UX/DX) / WOW Factor**

我々の提出物は SDK・MCP・CLI で、**画面が無い**。Usability は **DX（開発者体験）**として読める:
`SKILL.md` の手順どおりに審査員が**実際に動かせるか**、拒否の理由が**読んで分かるか**、
`npm test` が**何も設定せずに緑になるか**。**§1.7 で埋める。**

### The Graph（Continuity）の資格要件 —— **全部満たしている**（1行ずつ照合した）

| 要件 | 我々 |
|---|---|
| The Graph を**中核**に使う（agent/app が Subgraph を blockchain データ源にする） | ✓ `evidence.source: "subgraph"` |
| **live データを Graph provider から**。**モック・ローカル・静的データは失格** | ✓ Gateway を API キーで実クエリ。`_meta.block.number` と `deployment` を決定行に載せる |
| データで**意味のある仕事**をする。生のクエリ結果を印字するだけは不可。**ツールは再利用できる基盤であること**（単発アプリ不可） | ✓ 判定に使い、SDK と MCP として配る |
| **README か SKILL.md で審査員が動かせる**・公開リポ・2〜4分の動画 | ✓ `SKILL.md`（実行例は全部実走した出力） |
| **プールを正しく選ぶ**（Continuity）・会期前の作業を文書化 | ✓ `README` / `CHANGED_FILES.md` / 運営へ書面開示済み |

**注意**: 「Best Use of Composable or Standardized Graph Products」枠は
**「Subgraph を1つ引くだけでは資格が無い。AI Use Case トラックを見よ」**と明記している。**我々は AI トラック。正しい。**

## 1.7 Usability（UI/UX/**DX**）—— 審査基準の5つ目。我々は一度も考えていなかった

**画面が無い提出物**（SDK・MCP・CLI）なので、Usability は **DX（開発者体験）**として読む。
審査員がやることは1つ——**`SKILL.md` を開いて、書いてあるとおりに動かす**。そこで詰まったら終わり。

### 審査員が5分でここまで行けること（09-11 の凍結までに全部通す）

| # | 審査員の操作 | 合格条件 | 現状 |
|---|---|---|---|
| 1 | `git clone` → `cd packages/sdk && npm install && npm test` | **鍵もネットワークも無しで緑**。1本も赤くない | ✅ 148本 fail 0 |
| 2 | 同じく `packages/mcp-server` | **同上** | ✅ 32本 fail 0 |
| 3 | `examples/ethonline-2026-demo` の `refuse` を**鍵1本**で動かす | 2カラムが**1画面に収まり**、`_meta.block` が見える | ✅ 実出力を確認済み |
| 4 | `pay` を**鍵なし**で動かす | **空撃ちが既定**で、何に署名するはずだったかが読める。**署名は起きない** | ✅ |
| 5 | 拒否の理由を読む | **売り手を責めていない**と分かる（`l1_not_attempted` ＝「我々が買っていない」） | ✅ `SKILL.md` に明記 |

**まだ埋めていないもの**:

- **エラーメッセージが「次に何をすればいいか」を言うか。** 鍵が無い・古い Node・依存未導入のとき、
  **何が足りないかだけを言って落ちる**（値は出さない）実装にはなっているが、**審査員の環境で1回も試していない**
- **`SKILL.md` の手順を、リポを知らない人が上から実行して詰まらないか。** 書いた本人以外が通していない
- **Node のバージョン要件**が `SKILL.md` に書かれていない

**→ 09-10 に「まっさらな clone で `SKILL.md` を上から実行する」を1回やる**（[[verify-on-clean-checkout]] と同じ作法）。
**書いた本人の環境で通ることは、証拠にならない。**

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

### 実装の状態（2026-09-05 11:50・main 実測）

| # | 状態 |
|---|---|
| 1 `payOrRefuse` | **完了**（SDK 148本 fail 0・第3層の証明は変異で確認） |
| 2 MCP `pay_if_trusted` ＋ `SKILL.md` | **完了**（MCP 32本 fail 0） |
| 3 The Graph 証拠源（`evidence[].source` 4面） | **完了**（SDK・本番 API・OpenAPI・SDK型・MCPスキーマ・`/docs/api`・語彙） |
| 4 `source: agent-demo` の決定面 | **完了**（追記専用 JSONL・源で分ける・本番 DB へ書かない） |
| 5 A/B ハーネス | **実装完了**（ブランチ `ethonline/ab-harness`・89本 fail 0・変異7種）。**実 LLM の実走は未実施** |

**行が名乗る `source` は2値**（`vet402` / `subgraph`）。**`both` は `policy.evidence.source` の
「どの源を読むか」の指定であって、行の値ではない**——行に許すと「両方から来た1行」＝合算した行が
型として作れてしまい、D16（源をまたいで足さない）と正面から矛盾する。

**サーバは subgraph を引かない。** 理由の3つ目が決定的: **デモの相手（The Graph）はカタログ外で
`/decision` が 404** を返すので、サーバ側実装は**提出物が名指ししているまさにその相手について
subgraph 行を出せない**。他に、我々の鍵で代理すると「vet402 を信じなくてよい」が崩れること、
`/decision` の p95 200ms と5分キャッシュに10秒の外部往復を入れると**キャッシュされた応答が
最大5分古い `queriedAt` で live を名乗る**こと。**行の形は1つにし、`payOrRefuse` が呼び手の鍵で
読んだ subgraph 行を同じ配列へ足す。**

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
| The Graph の subgraph | **RECIPIENT**・件数と金額は動く → **§15 の実測値を見る**（09-03: 252／09-05: 253）。**撮影当日に取り直す** |

**審査員が自分の会社のウォレットを我々のサイトに入れると WARN 69 が出る。** その1点差を埋めるのが
会期中に足す `evidence.source`。細工ではなく実在の欠損で、被写体が審査員自身。

**注意**: 402 の `resource.url` は内部ホスト名（`http://mainnet-thegraph-arbitrum-03-…`）を返す。
**照合は `payTo` で行う**。resource URL で照合する実装を入れると The Graph に払えない（テスト B-4）。

### 3.1 訂正（09-04 夕・実測）——The Graph は我々のカタログに無い

この節は「payOrRefuse が `/decision` を読んで ALLOW を出し、The Graph に払う」と書いていた。**そのままでは動かない。**

| 測ったもの | 結果 |
|---|---|
| `GET /api/v1/payees/0x79DC…/endpoints` | `count: 0`——The Graph の x402 口はカタログに1件も無い |
| The Graph の実 `resource_id`（`sha256("POST " + 正規化URL)`） | `9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763` |
| `GET /api/v1/resources/9e8469d3…/decision?role=payer` | **HTTP 404 `not_found`** |
| 実装 | `getResource()` は `WHERE resource_id = …` の1行照会。**未登録は必ず 404**（route.ts の分岐で確定） |

**決定: カタログに登録しない。** 登録すれば 404 は消えるが、会期中に自作自演の色がつくうえ、
**「一度も見たことのない売り手に向けて判定できる」という製品の核**を捨てることになる。
現実の買い手が 402 に出会う相手は、ほぼ全部カタログの外にいる。カタログ内でしか動かない
SDK は世の中で使えない。

**したがって payOrRefuse は「402 チャレンジそのもの＋受取人スコア」で判定できなければならない。**

### 3.2 【2026-09-05 決定】呼び手は「vet402 の ALLOW を要求しない」を選べる —— これが §3 の対比の答え

**実装して初めて、§3 が自分と矛盾していることが分かった。**
§3 は「The Graph の受取ウォレットは我々のエンジンで **WARN 69**」と言い、同じ節で「**ALLOW の支払い先はここ**」と言う。
**両立しない。** 実測（09-05・本番）:

```
payOrRefuse(The Graph) → status refused
  reasons ["resource_uncatalogued", "payee_recommendation_not_allow"]
  account props accessed []        ← 署名には到達していない（正しい）
```

`policy.evidence` の subgraph 床は**追加の床**で、受取人判定の代替になっていなかった。
**このままでは台本 1:30–2:05（実 tx を出す絵）が撮れない。**

**決定: 呼び手が明示的に `requireVet402Allow: false` を選べるようにする。既定は `true`（fail-closed のまま）。**

- 呼び手が**自分の証拠の床**（`minSubgraphReceipts` 等）を宣言し、それが満たされていれば、
  **vet402 の推奨が ALLOW でなくても払える**
- **黙って弱くならない。** 呼び手がコードに書いた明示の選択で、決定行に「どの規則で通したか」が残る
- 既定のままなら今日と同じ挙動（WARN なら拒否）

**なぜこれが正しいか。** この製品の主張は「**あなたは vet402 を信じなくてよい**」である。
受取人スコアは**我々の意見**で、policy は**呼び手の規則**。
「第三者の台帳に 250 件以上の受領があること」を自分の基準として宣言する呼び手は、
**我々より緩いのではなく、違う基準を持っている**。それを封じるなら、主張が嘘になる。

**そして、これは ALLOW をそのまま見せるより強い絵になる。**

> 我々のエンジンは WARN と言っている。呼び手の policy は「The Graph の台帳に 250 件以上の受領があれば足りる。
> vet402 の承認は要らない」と言っている。**支払いは通る——The Graph 自身のデータに基づいて、我々のではなく。**

**§3 の1点差を埋めるのは `evidence.source` だけではなかった。「誰の基準で判定するか」を呼び手に渡すことだった。**

#### 3.2.1 【必須の境界・2026-09-05 vet402.com の指摘で追加】`false` が緩めるのは ALLOW の要求だけ。**BLOCK は外れない**

**私の最初の設計はここが抜けていた。** そのまま実装すると、**呼び手が床を宣言しさえすれば、
我々がグローバルに遮断している相手にも SDK が払える道具になっていた。** 信頼を売る製品として致命的。

| vet402 の推奨 | `requireVet402Allow: false` のとき |
|---|---|
| `ALLOW` | 払う（既定と同じ） |
| **`WARN`** | **呼び手の床が満たされていれば払う**（これが §3.2 の狙い） |
| **`BLOCK`** | **常に拒否。呼び手の床では外れない** |
| `degraded`（読めなかった） | **常に拒否**（fail-closed。読めていないものを呼び手の床で埋めない） |

**理由**: `BLOCK` は「我々の意見」ではない。**運営者のグローバル遮断**（既知の詐欺・自己取引・
degraded の fail-closed）であって、呼び手が「The Graph に 250 件ある」と言っていても**払ってはいけない相手**。
`WARN` は意見、`BLOCK` は遮断。**この2つを同じ扱いにしない。**

外す必要が将来出たら、**別の明示オプション**（`ignoreVet402Block` 等・理由の記述を必須に）へ分ける。
**既定では BLOCK は常に refuse。**

**決定行には vet402 の推奨（`WARN` とその理由）をそのまま併記する。`WARN` を `ALLOW` に読み替えない。**
「呼び手の policy で通した」と残す。**我々の判定を書き換えたように見せない。**

この境界は製品の憲法（`vet402-clean-constitution`: ユーザー向けガードレールは DYOR 尊重の最低限・
過保護にしない）とも両立する。**過保護にしないことと、遮断先へ払う道具になることは別。**

**この境界は、実装と同じコミットでテストに固定する（先送りしない）。**

> `BLOCK` の相手に `requireVet402Allow: false` ＋ **床を満たした状態**で `payOrRefuse` を呼び、
> `refused` と `payee_recommendation_block` が返ることを表明する。

vet402.com は「会期後でよい」と言ったが、**そこは同意しない。** 今回の穴は
**文書に書いていなかったから生まれたのではなく、文書にしか無かったから生まれる**。
私は §3.2 を書いた時点で BLOCK のことを考えておらず、**指摘されるまで気づかなかった**。
同じことは次の実装者にも起こる。**関門は経路に置く**（[[fix-the-path-not-the-artifact]]）。
「緩和の変更を入れたとき、黙って BLOCK が外れる」経路を、テストで塞ぐ。
`/decision` が 404 を返したら、そこで諦めるのではなく `payTo` を軸に判定へ落とす。
これは会期中に足す新規実装であり、会期差分としても正当（テスト I23）。

**そして §3 の対比はむしろ強くなる。同じウォレットについて知識の状態が3つある:**

| 情報源 | 09-04 実測 |
|---|---|
| 我々のカタログ | **何も知らない**（endpoints 0・decision 404） |
| 我々の受取人エンジン | **69 / WARN / thin**（受領0件・独立payer 0・L1配達0／ウォレット齢118日・tx 100・drain 0.4736・`scoredAt` 2026-09-04T07:57:43Z） |
| The Graph 自身の subgraph | **RECIPIENT**・件数は動く（09-05 実測 253件・2.53 USDC）→ §15 |

**審査員の会社のウォレットで、3つの情報源が3つ違うことを言う。** 埋めるのが `evidence.source`。

**ドリフトの心配は無い**（09-04 に規則を読んで確認）: `l1DeliveryDepth` が thin を抜けるには
**配達3件かつ異なる2日**が要る。L1 は1エンドポイントにつき6日で1回しか買わない。10日の会期では
最大2件——`thin` のまま。69 は動かない。

## 4. 会期の失敗テスト —— **本数をこの文書に書かない**

> **本数を書くのをやめた（09-05）。3回続けて実体と食い違ったため。**
> 09-04「22本」→実体24本。09-05「23項目・25本」→ I23 を3本に分割して実体27本。
> **手で数えた値は必ず古くなる。数えたければ実行する:**
>
> ```bash
> grep -c '^test("' packages/sdk/test/pay-or-refuse.test.mjs
> grep -c '^test("' packages/mcp-server/test/pay-if-trusted.test.mjs
> ```
>
> 項目の**識別子**（A1…H22・I23）は安定させる。**本数は導出する。**
> これは記録の癖の問題ではなく、`docs/claims.yaml` が扱う「主張と実測の突合」と同じ型の欠陥。
>
> **I23（09-04 夕追加・09-05 に green）**: `/decision` が **404 `not_found`** を返す売り手（＝カタログ外）に対して、
> payOrRefuse は落ちも黙認もせず、**402 チャレンジの `payTo` と受取人スコアだけで判定を出す**。
> 判定材料が無い場合だけ、機械可読な理由で署名前に拒否する。**デモの支払い先そのものがこの経路**（§3.1）。
> 実装は a/b/c の3本（ALLOW で進む／スコアが ALLOW でなく拒否／スコアも取れず fail-closed）。
>
> **同じ型の欠陥が、独立に3回出た**（09-04 SDK / 09-05 SDK / 09-05 MCP）。**偶然ではなく、この書き方の性質**:
> 「`status` と signer 参照だけを見る」テストは、**ゲートを丸ごと外した実装も通す**（許可リスト外の fetch や
> 別の拒否理由で、たまたま `refused` になるため）。**理由コードの中身を必ず併せて検査する。**
> import 先の誤り（`../src/` は `rootDir: src`/`outDir: dist` なので永久にスタブへ落ちる）も SDK と MCP で
> **2回**出た。**新しいテストファイルを書いたら、まず「実装なしで緑にならないか」を変異で確かめる。**
>
> **09-05 の実装で判明した、テスト自身の欠陥**（変異テストで検出・提出物なので記録する）:
> **A1 は `status` と signer 参照しか見ておらず、ALLOW ゲートを丸ごと外した実装でも緑になった**
> （許可リスト外へ出た fetch が throw して、別の理由で拒否になるため）。A1/A2 は理由コードの検査を足して是正。
> **同じ穴が B5/B6/B7 にもある。**「回数が0」だけを見るテストは、配線を間違えた実装も通す。

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
| 1:15–1:30 | 拒否行のズーム（**`l0_pass, l1_not_attempted`**・`evidence[].source`） | だから拒む。理由コードは**売り手を責めていない。我々の欠損を名指ししている** |
| 1:30–2:05 | `run.ts pay` → **The Graph の gateway に $0.01** → Basescan → attest → `/decisions` | 証拠がある相手には払う。**払う先は The Graph 自身**。既定 policy を通る相手は今日 373 件 |
| 2:05–2:25 | テスト実行。**署名0回・RPC0回・settle0回が緑で並ぶ**＋ネガティブコントロールが1回を検出する | signer は拒否経路から**到達できない**。0回で緑になるのが配線ミスでないことも、同じハーネスで示す |
| 2:25–2:45 | SDK 3行 → MCP 1ツール → `source: "subgraph"` に切り替える差分 | `source: subgraph` にすれば、**証拠の床は第三者のデータだけで当たる**——我々の台帳の件数は1件も使わない。（**言い過ぎない**: ALLOW 判定そのものは `/decision` を引く。「我々を1行も読まない」は偽） |
| 2:45–3:10 | **`git log pre-ethonline-2026..main`** ＋ CHANGED_FILES ＋ `AI_USAGE.md` | 会期の差分はこのタグ以降の全部。触った既存ファイルは列挙。**コードはほぼ全部 AI が書いた。開示は弱めていない**（`AI_USAGE.md` を映す） |
| 3:10–3:25 | 冒頭の分割画面（静止） | 今週まで vet402 は「払ってよいか」に**答えられた**。今週、**署名が存在する前に拒む**ことを覚えた |

**数字は撮影当日に取り直す**（`[N]` `[B]` `[M]` `373`）。**出典に無い数字を口に出さない。**

### 撮影で画面に出してはいけないもの（09-05 追加・**出したら公開後に取り消せない**）

- **The Graph の API キー。** 問い合わせ先が `https://gateway.thegraph.com/api/<KEY>/subgraphs/id/…` という
  **URL にキーが載る形**なので、ターミナルのコマンド行・履歴・エラーメッセージに素で出る。
  **撮影前に環境変数へ逃がし、画面には `$GRAPH_API_KEY` としか出さない。**
- `VOUCH_API_KEY`・`OBSERVATORY_WALLET_PRIVATE_KEY`・`.env*` の中身・`~/.bazantic/gateway/wallet.json`
- **録画は公開される。スクショもリポも同じ。** 一度出たキーは失効させるしかない

### 録音（Takeshi 手番・**AI 音声は自動却下**）

**必要なのは肉声のナレーションだけ。** 画面収録と編集は私がやる。

- **所要**: 読み上げ 3〜4 分 × 2〜3 テイク＝**15 分**
- **要るもの**: 静かな部屋と、スマホか PC のマイク1本。専用機材は不要
- **渡すもの**: **09-11 に、そのまま読める一文ずつの台本**（数字は当日の実測を埋めた確定版）。上の表は構成であって台本ではない
- **やらないでほしいこと**: 台本に無い数字を言う。**出典の無い数字は1つも出さない**のがこの提出物の核なので、
  言い間違えたら止めて録り直す（編集で切れる）
- **英語か日本語か**: 審査は英語圏。**英語**を推奨するが、**Takeshi の判断に従う**。日本語なら英字幕を私が付ける

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
  （実送信は 09-05 08:49 JST・`DISCLOSURE_2026-09-05.md`）
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


## 10.5 【2026-09-05 14:45】The Graph へ $0.01 を実際に払った —— **デモの中核が通った**

**会期でいちばん確かめたかったこと。空撃ちではなく、取り消せないオンチェーン取引。**

```
payOrRefuse   status=paid   signed=true
reasons       resource_uncatalogued, allowed_by_caller_policy
verdict from  caller_policy
allowed by    requireVet402Allow:false — waived payee_score WARN (69)
floor met     minL1Deliveries (vet402) 0 <= 0
floor met     minSubgraphReceipts (subgraph) 1 <= 259
nonce         0xb09bab2e33cfe9e3a88eab41823ba03faba9478c28eddfef377c16165de56524
txHash        0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad
```

**チェーンで再読して独立に確認した**（我々の規律: API が成功したかではなく、相手側に何が残っているか）:

| | |
|---|---|
| status | **成功**・block **50898704** |
| Transfer | `0xdb62bd20…3aa673` → **`0x79dc34e4…d52fccb`**・**0.01 USDC** |
| デモ鍵の残高 | 1.00 → **0.99** |
| デモ鍵の ETH | **0 のまま**（EIP-3009 なので買い手のガスは要らない。設計どおり） |

**§3 の対比が、実物で成立した。**

> 我々自身のエンジンはこの相手を **WARN 69** と判定している。呼び手の policy は
> 「The Graph 自身の台帳に受領が1件以上あれば足りる。**vet402 の承認は要らない**」と宣言している。
> 実測 **259 件**。**支払いは通った——The Graph 自身のデータに基づいて、我々のではなく。**
> 決定行には `verdict from: caller_policy` と「WARN を免除した」事実が残っている。
> **我々の判定を書き換えてはいない。**

**撮影当日に取り直す数字**: subgraph の受領件数（09-05 朝 253 → 昼 259）と block。**識別子と tx は動かない。**

## 10.6 【2026-09-05 14:40・要報告】デモ用ウォレットは「暗号化されているように見えて、されていない」

`baz wallet new` が作った `~/.bazantic/gateway/wallet.json` は、scrypt(N=32768) ＋ AES-256-GCM の
**暗号化キーストアの形をしている**が、`"encrypted": false` で、**空文字のパスワードで開く**（実測）。
**ファイルを読める者は秘密鍵を持っているのと同じ。**

- **我々への影響は小さい**——このウォレットの用途はデモ専用で、残高は $0.99。**資金鍵はここに置かない**
- **Bazantic 側の性質**なので、**責任ある開示として先方へ伝える価値がある**（我々が作った穴ではない）
- **提出物には書かない**（第三者の未修正の弱点を公開の場に出さない）。連絡は個別に

## 11. Day 0（09-04）の実測記録 —— **経緯は git 履歴に預ける**（09-05 圧縮）

残すのは今も判断に使う事実だけ。経緯は `b366921` / `c8f92f2` と 09-04〜05 のコミット本文にある。

| 事実 | 値 |
|---|---|
| デモ鍵 | `0xDB62BD202914609830fA656F87996b91be3Aa673`・**USDC 1.000000**（block 50859520・tx `0x3684a4ab…b15b`）。**ETH は 0 のままでよい**（EIP-3009 は買い手のガスを使わない） |
| 入金元 | `0x6777E11f…3986` = **Takeshi 本人の個人アドレス**（賞金/グラント受取・09-04 までは L1 支払元）。**個人情報の追加露出は無い**（我々の公開台帳に payer として 3,029 行）。**今後の入金元は会社側の鍵**から |
| 拒否側フィクスチャ | `0xb15a55e8…`（`agent.api.0x.org`）。09-04 に C1 が測って **BLOCK → WARN**（`l0_pass, l1_not_attempted`）へ動いた。**現在値は `now.py` が毎セッション出す** |
| The Graph の 402 | 09-03 と 09-05 で完全一致（`exact` / `eip155:8453` / `amount 10000` / `payTo 0x79DC…` / `eip3009` / `maxTimeoutSeconds 300`）。ヘッダは `payment-required` を読み `Payment-Signature` を返す |
| デモの支払いは The Graph のスコアを動かさない | `x402_payments` の算入条件は `ownership_verified = true`＝**払った側の署名つき書き戻し**（`src/lib/db/x402-payments.ts:68-72`）。書き戻さないので `0x79DC…` は 69/WARN/thin のまま。**§3 の対比は撮影後も再現できる** |
| `/api/v1/graph/payto/{addr}` | 名前に反して **subgraph の代理ではなく自カタログの隣接照会**。The Graph には `operates: []` |

**Day 0 に踏んだ失敗（型として残す・詳細は git）**: 自分で書いた失敗テストが2本、実装なしで緑になった／
python の失敗と git 手順の間に `&&` の関門が無く、内容の無いコミットが main に載った（09-02 にも同型）。

## 13. 4面パリティ検査の地雷（2026-09-05 vet402.com セッションから受領・`evidence.source` を書く前に読む）

`evidence[].source` は**実装・OpenAPI・SDK型・MCPスキーマの4面同時**が要件（§2 #3）。
この4面には自動検査が掛かっていて、片面だけ足すと落ちる。**踏む前に読む。**

| # | 検査 | 落ちる条件 | 対処 |
|---|---|---|---|
| 1 | `tests/openapi-route-parity.test.ts` | `src/app/api/**/route.ts` の全ルートが `docs/openapi.yaml` に載っていない（逆も） | 新フィールドは**スキーマに型を書く**。書かないと `openapi-schema-parity` が落ちる |
| 2 | `tests/openapi-error-enum.test.ts` | ルートが返す `error` 文字列が openapi の enum に無い | 新しい reason / error を足したら **enum へ追記** |
| 3 | `tests/docs-surface-parity.test.ts` | `/docs/api` の記述と openapi が食い違う | 公開フィールドを足したら **docs にも1行** |
| 4 | `docs/claims.yaml` ＋ claims canary（毎朝 08:05） | 公開面で断定する数字・主張が未登録 | 走査対象は `src/app`・`src/components/site`・`src/lib/observatory/vocabulary.ts`。**断定を書いたら登録** |
| 5 | `outward_name_scan`（毎朝 07:55・09-05 に vet402.com を追加） | 公開面や署名文に `Vouch` が出る | 識別子 `vouch_*` / `Vouch-*` / `createVouchClient` は**凍結済みで鳴らない**。鳴るのは対外文言 |
| 6 | MCP のテスト | root の `npm ci` では `packages/mcp-server` が入らない | `npm test` の4スイート目（`mcp:test`）は **`packages/mcp-server` 側で `npm ci`** が要る。SDK/MCP のテストは **`dist` から import**（`src` からではない） |
| 7 | `tests/helpers/pg-test-guard.ts` | TRUNCATE の前に `assertTestDatabaseIsNotProduction` を呼んでいない（`pg-test-guard.test.ts` が全ファイルを検査） | DB 系は **`npm run test:db`**。`npm test` に `TEST_DATABASE_URL` を付けると pg 系が終わらない |
| 8 | 語彙 | `evidence.source` の値名が方法論の語彙表に無い | `src/lib/observatory/vocabulary.ts` に**1文の定義**を足す（AEO/LLMO 側と整合する） |

**`halted`** は 09-05 に status 語彙と openapi enum へ追加済み（paid-attempt / decision の分母に入らない）。

### 鮮度の口（09-05 合意・vet402.com が実装）

| 面 | フィールド |
|---|---|
| `/decision` | `facts.l1.last_attempt_at`（ISO8601 UTC・subject 単位の最終試行）、トップレベル `spending_halted`（bool）。**snake_case** |
| `state` | `l1.lastAttemptAt`・`spendingHalted`。**camelCase**（面ごとに統一） |

**停止中の未試行を売り手の落ち度に見せない。** `l1_not_attempted` の下位に
`not_attempted_reason: "spending_halted" | "no_eligible_accept" | …` を足す方向（既存 enum は壊さず追加のみ）。
`payOrRefuse` はこの2つを読んで**「新鮮さを装わない」**——停止中や観測が古い相手は拒否ではなく
**「未検証」**として返し、理由に時刻を載せる。

### 会期中に読まない公開面

`/api/v1/observatory/history` は**日次 10:37 UTC に凍結される集計で、決済確認 cron（14:00 UTC）より前に走っていた**。
後から settled になった行が永久に入らず、**Base で 221 件の過小**（09-05 にディストリビューション戦略が発見）。

**→ 09-05 に是正され、依頼元が独立に検算した（`743abac`・main）。引用禁止は解除する。**

```
history の l1Settled 合計（全チェーン）  1629
DB の実数 count(settlement_verified)     1629   ← 完全一致
応答に追加された被覆情報: coverageFrom 2026-08-14 / rolledUpThrough 2026-09-04 /
                          lastRollupAt 2026-09-05T00:18:47Z / recomputeWindowDays 14
```

### 会期後に必ず直すもの（提出前には直さない・提出物には影響しない）

| # | 中身 | なぜ提出前に直さないか |
|---|---|---|
| 1 | **`@vet402/mcp-server` の `dependencies` に `@vet402/sdk: "file:../sdk"` が入った**（09-05）。**このまま npm へ公開すると、利用者の `npm install` が解決できず壊れる**。公開前に版指定へ替え、SDK を先に公開する必要がある | 公開は提出後（§2 範囲外）。**審査員は npm ではなく Bazantic のホスト経由で触る**ので判定に影響しない。ただし**忘れると次の公開で全利用者が壊れる** |
| 2 | ~~`minSubgraphReceipts` が黙って無視される~~ → **2026-09-05 に解決済み**。宣言した床は宣言した `source` が評価できなければならず、矛盾する組み合わせは通信の前に `invalid_evidence_policy` で throw する | — |

**提出物で history を引用してよい。ただし `coverageFrom` と `recomputeWindowDays` を必ず添える**
（「直近14日は毎回再計算し、それより古い日は backfill するまで凍結」が応答の `semantics` に書いてある。
**分母と被覆を伏せて件数だけ出さない**）。`evidence.source` が history を読むかは設計次第で、必須ではない。

### S-4（settled の2層公開）の確定した項目名（2026-09-05・`state` 面は camelCase）

| 項目 | 意味 |
|---|---|
| `l1.settledNonceBound` = **71** | 我々しか作れない一回性の値で購入と決済 tx が束縛されている層（強い） |
| `l1.settledAmountPayeeOnly` = **1,558** | 金額と宛先の一致だけで確定した層（旧判定・弱い） |
| `l1.byChain[chain]{attempts, settled, delivered, nonceBound}` | チェーン別内訳 |

**09-05 09:26 に本番へ入り（`ae5ff67`）、依頼元が DB と突き合わせて検算した**:

```
API  settled 1629 / settledNonceBound 71 / settledAmountPayeeOnly 1558 / settledTimeWindowOk 1589
DB   count(settlement_verified)=1629 / auth_nonce IS NOT NULL=71 / IS NULL=1558   ← 完全一致
byChain  Base   attempts 3203 settled 1603 delivered 1429 nonceBound 71
         Solana attempts   38 settled   26 delivered   15 nonceBound  0
```

**提出物として強い事実**: 公開 API が**自分の証拠の弱さをチェーン別に自分から出している**。
**Solana は強い束縛が 0 件だと、我々自身の面が言っている。** 隠していないことが機械可読な形で出ている——
これは §2 #3（2つの情報源の食い違いを隠さない）と同じ思想で、審査員に対しては**言葉より効く**。

### 提出物に書いてはいけない主張（2026-09-05・vet402.com の自己訂正）

**「Solana の決済は memo 束縛で照合している」と書かない。** 一度そう伝えられたが、本番実測で
**Solana の 26 件は全行 `auth_nonce IS NULL`**（最新 08-31・束縛の導入は 09-04 12:00 UTC）。
正しくは **「finalized・残高差分で照合・金額と宛先の一致のみの層」**。

**この種の訂正は、こちらから探しに行かないと出てこない。**「強い証拠がある」と言えるのは
`settledNonceBound` の 71 件だけで、残りは弱い層だと**自分から言う**のが §2 #3 の設計思想と揃う。



## 14. 買い手は facilitator を呼ばない（2026-09-05・本番実装で確認）

**会期の実装が架空の facilitator（`https://x402.org/facilitator`）へ settle を投げていた。**
そのままでは 09-08 の The Graph への実支払いが通らなかった。本番の `l1-runner.ts` L977-1045 で確認した
正しい流れは次のとおりで、**買い手が facilitator を呼ぶ場面は無い**。

1. `buildAuthorization({ from, to: accept.payTo, value: accept.amount, nowSec, maxTimeoutSeconds })`
   ——EIP-3009 の認可。**nonce は我々が作る一回性の値**
2. `signX402Payment({ account, accept, authorization })`（EIP-712）
3. **署名した直後に nonce を確定・保存**（本番のコメント: "from here on the money is live"）。
   ここから先で落ちても「何に署名したか」が残る。監査の nonce 束縛はこれが根拠
4. `encodePaymentHeader(...)` ——ヘッダ名は **v2 `PAYMENT-SIGNATURE` / v1 `X-PAYMENT`**
5. **元のリクエストを、そのヘッダを付けて売り手へ再送するだけ**
6. **決済レシートは応答ヘッダから読む**——`PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE`。本文ではない

参照実装: `src/lib/observatory/x402-payer.ts` と `src/lib/observatory/l1-runner.ts` L977-1045。
SDK は `src/` から import できないので**同じ意味論を写す**。

**教訓**: 会期の新規実装が、本番に既にある同じ処理を読まずに書かれていた。
**同じことを既にやっているコードが本番にあるなら、書く前に読む。**

### 14.1 署名の**前**に通す関門5つ（2026-09-05 vet402.com から受領・依頼元が実測で裏取り）

本番 L1 が呼び手の資金を守るために通している関門。**SDK にも同じものが要る。**
`src/lib/observatory/x402-payer.ts` の該当箇所を実際に読んで確認した。

| # | 関門 | 実測した根拠 |
|---|---|---|
| 1 | **EIP-712 ドメインを売り手の `accept.extra` から読まない。** Base USDC の name/version をオンチェーン実測値で定数化 | `BASE_USDC_EIP712_NAME = "USD Coin"` / `BASE_USDC_EIP712_VERSION = "2"`（2026-08-22 に `eth_call` で実測: `name()` → "USD Coin"、`version()` → "2"）。**The Graph の 402 も `extra: {name:"USD Coin", version:"2"}` を宣言しており一致する**ので、定数化しても 09-08 の実支払いは落ちない |
| 2 | **`payTo` は「壁が名乗った値」でなく「事前に知っている値」との一致を要求** | 本番はカタログ宣言と大小無視で照合し `payto_mismatch` で署名前に退く。**The Graph はカタログ外**（§3.1）なので、SDK は呼び手が policy で渡す `expectedPayTo`（`0x79DC34E4…FcCB`）との一致を要求する |
| 3 | **金額は宣言額と完全一致＋上限。`validBefore` は売り手の `maxTimeoutSeconds` に関わらず 120 秒に丸める** | `MAX_PER_PURCHASE_UNITS`（:260 / :267 / :277 で照合）・`MAX_AUTHORIZATION_WINDOW_SECONDS = 120`（:306）。小数の timeout は整数化 |
| 4 | **nonce は `randomBytes(32)` を我々が作り、署名の直後に保存。再利用しない** | `import { randomBytes } from "node:crypto"`（:21） |
| 5 | **`PAYMENT-RESPONSE` は「主張」であって `settled` ではない** | 本番は購入時に `settle_claimed` までしか書かず、`settled` は**チェーンで再読した照合器だけ**が書く。SDK が応答ヘッダから状態を返すなら語彙は **`settle_claimed`**。`settled` と名乗らない |

**#1 の危険度を正確に書く（受領した説明を1点だけ訂正）。** 「売り手由来のドメインで署名すると
**別コントラクトへの認可に化ける**」と伝えられたが、**本番のコード内コメント自身がそれを否定している**——
`verifyingContract` と `chainId` は別途固定済みなので、name/version が違えば**署名は検証に落ちるだけで、
資金がどこかへ動くことはない**。本当の危険は観測所側の事情で、**署名の前に予算を予約する**ため、
敵対的な売り手が「絶対に成立しない認可」を作らせて日次 $25 を焼ける、というものだった。
**SDK には予約が無いので、この危険はそのままは当てはまらない。** それでも固定する理由は2つ:
署名する中身を売り手に決めさせない、無駄な署名を作らない。**危険を大きく言わない。**

**呼び手の鍵で署名するので、本番のキルスイッチと日次予算は SDK には効かない。**
呼び手の資金を守るのは上の #2 と #3 だけである。

### 14.2 実装して初めて分かった、SDK と本番の食い違い（2026-09-05・すべて本番に合わせて是正済み）

§14.1 の5つは「入れるべき関門」の話だったが、**実装してみると SDK 側には本番が既に塞いだ穴が残っていた**。
**会期の新規が、本番の是正履歴を引き継いでいなかった**——これが今日いちばん学んだこと。

| # | SDK にあった古い形 | 本番はいつ塞いだか |
|---|---|---|
| 1 | **買い手から facilitator へ settle を投げていた** | そもそも本番にその経路は無い（§14）。ヘッダ名・レシートの読み先・再送の3点すべてが誤りで、**09-08 に払っても金が動かず理由も残らなかった** |
| 2 | **EIP-712 ドメインを売り手の `accept.extra` から取っていた** | 2026-08-22 監査で塞ぎ、name/version をオンチェーン実測値でピン留め |
| 3 | **認可の有効窓が 600 秒**・`validAfter` が `"0"` | 2026-09-04 監査 P2 で **120 秒**へ短縮。`validAfter` は時計ずれ 60 秒を見込む |
| 4 | **v1 の綴り（`network:"base"` / `maxAmountRequired`）を一切扱っていなかった** | 本番 `normalizeAccept` にはある |
| 5 | **`accept.maxTimeoutSeconds` を無視していた** | 監査 P1-2 で、小数の `maxTimeoutSeconds` が `BigInt` を throw する事故を踏み、丸め処理を入れてある |

**教訓（§14 の一般形）**: 同じ処理が本番にあるなら書く前に読む。
**とくに「監査で塞いだ穴」は、別のパッケージに同じ形で残っていないかを確かめる。**

### 14.3 第3層の証明を、主張から計器にした（2026-09-05・依頼元が独立に変異確認）

「支払いは ALLOW ブランチ内の動的 import で、拒否経路では評価すら起きない」は**主張だけで、
static import に戻してもどのテストも赤くならなかった**。計器を足した。

検査対象は **`src` ではなく `dist`**（実際に走るコード）の静的モジュールグラフを `dist/index.js` から辿る。
`index.ts` に `export {…} from "./x402-pay.js"` を足すような将来の穴も塞がる。
グラフを実際に辿れたこと（`files.size >= 3`）も表明しており、**空振りで緑にならない**。

**依頼元が独立に変異確認した実出力**（報告を信じずに自分で壊して確かめた）:

```
変異: await import("./x402-pay.js") → import * as __MUT from "./x402-pay.js"
  ✖ 第3層: dist の静的グラフに支払いモジュールが現れない
  ✖ 第3層: 支払いモジュールは動的 import でだけ参照される
  ✖ 第3層: src 側も値としては静的 import していない
  ℹ tests 119 / ℹ pass 110 / ℹ fail 3
復元後: ℹ tests 119 / ℹ pass 113 / ℹ fail 0
```

実装側は12種の変異すべてで赤を確認している。**うち M2/M3（判定を引かずに ALLOW とみなす）は、
是正前の B5/B6/B7 では3本とも緑のまま通っていた**——§4 に記録した偽の緑の実害。


## 15. The Graph subgraph の**動く**問い合わせ（2026-09-05 09:00 実測・Day 4 の前に潰した）

**正典に書いてあったフィールド名 `paymentsReceived` / `totalReceived` / `uniquePayers` は3つとも実在しない。**
そのまま Day 4 に入っていたら丸一日潰れていた。実在するスキーマを introspection で引いて確定した。

### そのまま動く問い合わせ

```bash
curl -sL -X POST "https://gateway.thegraph.com/api/$GRAPH_API_KEY/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj" \
  -H 'content-type: application/json' \
  -H 'user-agent: vet402/1.0 (+https://vet402.com)' \
  -d '{"query":"{ _meta { block { number timestamp } deployment } x402AddressSummaries(where: {address: \"0x79dc…fccb\"}) { id address role totalPayments totalVolumeDecimal firstPaymentTimestamp lastPaymentTimestamp } }"}'
```

- **`user-agent`**: **2026-09-05 の実測では、UA を完全に外しても HTTP 200 が返った**（`-H 'User-Agent:'`）。
  正典と記憶にあった「無いと Cloudflare が 1010 で 403」は**今日の実測では再現しない**（Cloudflare 側の規則は変わる）。
  **付ける実装のままにする**（外す理由が無い・D14 が要求）が、**「必須」と断定しない**。
  1010 が出たときは `evidence_unavailable` として扱い、**鍵エラーと区別する**（原因が違えば直し方も違う）
- **【fail-closed の穴・実測】鍵が無いとき Gateway は 403 ではなく `HTTP 200` ＋ GraphQL `errors` を返す**:
  `{"errors":[{"message":"auth error: missing authorization header"}]}`。
  **`response.ok` だけを見る実装は、これを「成功・受領0件」と読む。** すると
  「認証に失敗した」が「一度も受け取っていない」という**別の理由**にすり替わって拒否される。
  **`errors` と `data` の形まで見る。**
- **【役割の混同・実測】1つのアドレスが `PAYER` 行と `RECIPIENT` 行を両方持つ。**
  実測 `0xf7b1356c…` は RECIPIENT 12,376,084 件 / PAYER 11,540,523 件の**2行**。
  **`where` に `role: RECIPIENT` を入れる。** 入れずに行を足すと**「払った回数」を「受け取った回数」として売る**ことになる。
  （The Graph の `0x79DC…` は RECIPIENT の1行だけなので §3 の数字は影響を受けない——実測で確認済み）
- **無料枠は月 10 万クエリ**
- **アドレスは小文字**で渡す
- **`x402AddressSummary(id:)` の単数形を使わない。** `id` は `0x01000000` を前置した合成値
  （実測: `0x0100000079dc34e41b2b591078d3de222c43ecaabd52fccb`）。**複数形＋`where` で引く**

### `X402AddressSummary` の実在フィールド（introspection で確定）

`id` / `address` / `role` / `totalPayments` / `totalVolume` / `totalVolumeDecimal` /
`firstPaymentTimestamp` / `lastPaymentTimestamp` / `isKnownEscrow` / `escrowDeposits` / `escrowVolume`

### 2026-09-05 09:00 の実測値（The Graph の受取ウォレット `0x79DC34E4…FcCB`）

| | |
|---|---|
| `role` | `RECIPIENT` |
| `totalPayments` | **253**（09-03 は 252。**動く数字なので撮影当日に取り直す**） |
| `totalVolumeDecimal` | **2.53** USDC |
| `_meta.block.number` | 50888579 |
| `_meta.deployment` | `QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN` |

**`_meta.block.number` と `deployment` が「live のデータを読んだ」ことの唯一の自明な証明**なので、
`evidence[].source` の subgraph 行に必ず同梱する（§2 #3）。

### 語彙: 決済の主張は**3状態**（2026-09-05 09:03 に本番 `llms-full.txt` と方法論の DefinedTermSet から取得）

**私は「vet402.com がこれから足す文案」として別の文を書いていたが、誤りだった。**
語彙は**既に本番に出ている**（今朝の SEO 実装で入った22語の1つ）。原文はこれ:

> **`settle_claimed`** — the seller returned a settlement receipt with a well-formed transaction id
> and vet402 has not re-read it on-chain yet. **It is the seller's assertion, held as an assertion.**
>
> **`settle_claimed_unverifiable`** — the transaction id the seller returned is **not even well-formed
> for that chain**, so there is nothing to re-read.
>
> **`settle_claim_refuted`** — vet402 re-read the transaction the seller pointed at and **that transfer is not there**.
>
> **`settled`** — vet402 re-read the transaction on-chain and found the exact USDC transfer it paid for:
> from our payer, to the catalog-declared payee, for the declared amount, in the canonical USDC contract.
> **It is never inferred from the seller's own claim.**

**SDK が返す状態は `settle_claimed` と `settle_claimed_unverifiable` の2つ。**
`settled` と `settle_claim_refuted` は**チェーンを再読した側だけ**が書ける。SDK は再読しないので名乗らない。

**`settle_claimed_unverifiable` の存在は、受領した文案には無かった。** 応答ヘッダの tx id が
そのチェーンの形式として壊れているときは、`settle_claimed` ではなくこちらを返す。
**「主張を主張として持つ」と「主張の形すら成していない」を混ぜない。**



## 16. P2（Bazantic）A/B の**事前登録**（2026-09-05 09:05・走らせる前に固定する）

賞の問いは一文だけ——**「エージェントが、あなたの説明なしにあなたの製品を使えるか」**。
それを A/B で証明する。**測り方を後から決めると結果を選べてしまう。だから走らせる前にここへ固定する。**
**結果が「差が無い」でも、そのまま出す。** 差が出なかったことを隠したら、この会社の看板（検算できる会社）が嘘になる。

### 条件 —— **2026-09-06 訂正。B は `SKILL.md` ではなく「bazantic.com で作った Recipe」**

**賞ページの資格要件を実読して、私の設計が外れていたと分かった**（実データは1件も見ていない時点での訂正）:

> **Create a Recipe that explains when, why, and how to use your service.**
> Use the same prompt, model, settings, and API access in both tests.
> **Make the Recipe the only material difference between the tests.**

**`SKILL.md` を B に置くと「Recipe が唯一の違い」を満たさない。** B は **Bazantic の Recipe** にする。

| | 与えるもの |
|---|---|
| **A（Recipe なし）** | Bazantic Gateway の URL と、素の API 一覧（OpenAPI）だけ |
| **B（Recipe あり）** | 同じもの ＋ **bazantic.com で作った Recipe**（MCP 経由で渡る） |

**同一モデル・同一プロンプト・同一設定・同一 API アクセス。違いは Recipe だけ。**
（`temperature` は現行モデルが受け付けないので**両方とも送らない**。§「事前登録の修正」を参照）

### Bazantic の資格要件（2026-09-06 実読・8項目）

| # | 要件 | 状態 |
|---|---|---|
| 1 | bazantic.com にアカウントを作る | ✅ 09-03（`TakeshiTGAL`・GitHub OAuth） |
| 2 | プロジェクト用の x402/MPP Gateway を作る | ✅ 09-03（LIVE・56ルート $0.00） |
| 3 | **サービスを「いつ・なぜ・どう使うか」を説明する Recipe を作る** | ❌ **未作成。これが最大の残件** |
| 4 | 両テストで同じプロンプト・モデル・設定・API アクセス | ✅ ハーネスが構造で強制（変異 M7 が固定） |
| 5 | **Recipe を唯一の実質的な違いにする** | ⚠️ **設計を訂正した**（上） |
| 6 | 両方の結果を、入力ごと提出物で示す | ✅ 生ログを `results/` に出す |
| 7 | **結果の違いを歩いて見せる動画を録る** | ⏳ 動画の台本に組み込む（§6） |
| 8 | bazantic のユーザー名を提出物に書く | ✅ `TakeshiTGAL` |

### Bazantic で応募できるのは **1ブラケットだけ**（2026-09-06 訂正）

**私はここに「枠1つ・ブラケット2つ・両方に応募できる」と書いた。誤りだった。**
賞ページの一般則（"If a partner has multiple tracks, you can be eligible for all of them"）だけを見て、
**`PRIZES.md` §1 の運営回答を読まずに再導出した**——その節の見出しは「**資格の憲法（再導出しない）**」である。

運営（Pascal・`#ticket-5926`・2026-08-25）:

> you are only eligible for tracks that have continuity on them. …
> **Even if they have something that is non-continuity that would work in your case, you're not eligible.**

賞ページで **Continuity バッジ（🆕 This prize is only available to Continuity Track participants）が
付いているのは "Help an Agent Use Your Hackathon Project" だけ**。
"Best Recipe that uses EthGlobal Hackathon Sponsor APIs" には付いていない。**応募できない。**

| ブラケット | 額 | 我々 |
|---|---|---|
| **Help an Agent Use Your Hackathon Project** | $1,000（最大2チーム × $500）・**Continuity 限定** | **これだけ** |
| ~~Best Recipe that uses EthGlobal Hackathon Sponsor APIs~~ | ~~$1,000~~ | **Continuity バッジ無し＝資格が無い** |

**→ The Graph 1枠・Bazantic 1枠・3枠目は空けたまま。到達可能合計 $6,000。**

### 3枠目（2026-09-06 判断）

残る9パートナー（Hedera / Arc / World / 1inch / ENS / Uniswap Foundation / Ledger / Privy / Chainlink）は
**どれも我々が今使っていない**。埋めるには会期スコープ外の実装が要る（§2 の「これ以外を作らない」に反する）。

**決定: 3枠目は空けたまま出す。** 使っていない製品の枠に応募するのは、
**パートナーの審査時間を使わせて我々の主張を薄める**だけで、この会社の看板と逆になる。
**ただし 09-11 の機能凍結までに「既に満たしている」枠が見つかれば入れる**（探すのは無料）。

### 課題（エージェントに出す問い・A/B 共通）

> この x402 エンドポイントに払う前に、受取人がこれまでに実際に配達したことがあるかを確かめよ。
> 証拠が無ければ**払わずに**、理由を機械可読なコードで示せ。

### フィクスチャ（正解が既知のものだけを使う。**片方に倒せば勝てる構成にしない**）

| # | 相手 | 正解 |
|---|---|---|
| 1 | 我々のエンジンが ALLOW を出す payee（09-04 実測: kronossignals `0x36038e1d…` は 82 / ALLOW / rich） | **進む** |
| 2 | The Graph の受取 `0x79DC34E4…`（69 / WARN / thin・**カタログ外で `/decision` は 404**） | **既定 policy では拒否**。理由は「我々が一度も買っていない」であって売り手の落ち度ではない |
| 3 | 拒否側フィクスチャ `0xb15a55e8…`（WARN・`l1_not_attempted`） | **拒否** |
| 4 | 上限超過の金額 | **判定を引く前に拒否** |

**1 を入れるのは「常に拒否する」戦略が満点を取れないようにするため。** 4 を入れるのは
「API を呼ぶ前に落ちる」経路も測るため。

#### フィクスチャの実測値（2026-09-05 11:00・**正典に無かった値をここで確定させる**）

ハーネスが正解表として使う値。**省略形をやめ、全桁を書く**（`0xb15a55e8…` は8箇所すべて省略形で、
40桁がリポのどこにも無かった。作らずに埋めるため実測した）。

| # | 識別子 | 実測 |
|---|---|---|
| **F1** | resource `https://kronossignals.com/api/v1/price/btc`<br>`resource_id` `ae0091e802c83179e3b1464a7b15dac64a0c1d3a00cb690eb6a5ac9811c47e3b` | **ALLOW** / `["l0_pass","l1_delivered","l2_undeclared"]`<br>L1 `n_delivered 3 / n_settled 3 / n_attempts 3`・`last_attempt_at 2026-08-27T12:30:45.074Z` |
| **F2** | resource `https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj`<br>`resource_id` `9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763`<br>payee `0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB` | `/decision` は **HTTP 404 `not_found`**（カタログ外）<br>受取人スコア **69 / WARN / thin**<br>subgraph は **RECIPIENT / 253件**（§15・動く） |
| **F3** | payee **`0xb15a55e85fdf5edc41b6c1eaf7813e2c6e6def59`**（全40桁）<br>resource `https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote`<br>`resource_id` `8146a86d0e858267f15388341fc99b7d5fa23b6ebb138ba0267a38eb9a76386b` | **WARN** / `["l0_pass","l1_not_attempted","l2_undeclared"]`<br>L1 `0/0/0`・`n_probe_error 1`・`not_attempted_reason null` |
| **F4** | F1 と同じ相手に `amountUsd 5` / `policy.maxPerTxUsd 1` | **判定を引く前に**拒否・`price_above_ceiling`（`/decision` へのリクエスト0件） |

**数字は動く。** F1 の L1 と F2 の 253 は撮影・実走の当日に取り直す（§15 と同じ規律）。
**識別子（`resource_id` とアドレス）は動かない。**

**`not_attempted_reason` の enum は会期中に広げない**（2026-09-05 決定）。F3 は
`l1_not_attempted` が立つのに `null` だが、実際の原因は `n_probe_error 1`（計器の失敗）で、
**`null` は嘘をついていない**（「我々の停止でも、払える accept が無かったのでもない」）。
一件ごとの理由は `/api/v1/observatory/decisions` が持つ。**`n_probe_error` を根拠に
「売り手が悪い」と読める文字列を作らない。**

### 成功の定義（**この2条件の論理積。走らせる前に確定**）

1. **判定が一致する**——エージェントの結論が、同じ相手に対して我々の API が返す判定と一致する
2. **理由を捏造していない**——挙げた理由コードが、**実際に返ってきた**理由コードの部分集合である

**2 を入れるのが要**。素の API 一覧しか無いエージェントの典型的な失敗は「それらしい理由を作る」ことで、
**正解にたまたま当たっても、根拠が嘘なら失敗**とする。

### 試行と停止規則

- **1条件あたり10試行**（4フィクスチャ×2〜3周）・**合計20試行**
- **良い結果が出るまで回し直さない。** 走らせるのは1回。設定を変えて回し直すなら、
  **回し直した事実と、前回の結果の両方を出す**
- 記録するもの: モデル名・temperature・プロンプト全文・各試行の生の応答・判定・理由コード・所要時間
- **生ログを `docs/ethonline-2026/ab/` に置く**（審査員が数え直せる形。集計値だけを出さない）

### 事前登録の修正（2026-09-05 10:55・**実データを1件も見る前に**・理由つき）

**事前登録は直してよい。ただし「いつ・なぜ」を書き、実データを見る前に限る。** 以下2点を修正する。
**モックでの検算しかしていない時点での修正であり、A/B の実結果は1件も見ていない。**

**(1) `temperature` は「同一」にできない。送らない。**
現行モデル（Claude Opus 5 / Sonnet 5 / Opus 4.7–4.8 / Fable）は `temperature` と `top_p` を受け付けず
**400 を返す**。ハーネスは `temperature: null`（＝送っていない）を全試行に記録する。
**`0` と書けば「0 を指定した」という嘘になる**ので書かない。
**A と B で同じであること**は満たされている（どちらも送らない）ので、事前登録の趣旨は保たれる。
**この逸脱は提出物にそのまま書く。**

**(2) 成功条件 (2) を1語強くする。**
元の文は「挙げた理由コードが、実際に返ってきた理由コードの**部分集合**である」。
**空集合は字義どおり部分集合**なので、**「拒否したが理由を1つも挙げない」答えが success になる。**
これは我々がいちばん見たい失敗（それらしい理由の捏造／理由の不在）を取り逃がす。

> **修正後**: 正解が「拒否」のとき、挙げた理由コードは**部分集合であり、かつ空でない**こと。
> 正解が「進む」のときは従来どおり（理由コードは要求しない）。

**なぜ今直すのか**: 実データを見た後にこれを直せば、結果を選んだことになる。
**見る前だから直せる。** ハーネスは修正前の数え方も `successWithEmptyReasonCodes` として
**非採点の列**で並記し、両方の数が生ログから再計算できる形で残す。

### 予測（外れたらそう書く）

**A は「判定は当たるが理由を捏造する」で落ちる**と予測する。B は MCP ツールが理由コードを
そのまま返すので 2 を自然に満たす。**この予測が外れたら、外れたとそのまま書く。**

### 16.1 【2026-09-06 19:30 実測】Bazantic の 402 は同社の既定仕様——A/B の 0%/0% は計器の故障

執行部の実走（`results/2026-09-06T093254Z`・claude-opus-5・20試行）が **A 0% / B 0%** だった原因を、
モデルの自己申告ではなく一次情報で確定した。

| 問い | 実測 |
|---|---|
| 402 は誰の設定か | **Bazantic の既定**。ダッシュボードは 57 ルート全部 **0 mcents**。docs（`/docs/cli`）は「無料なのは `tools/list` と 402 の値段調べだけ。**払って初めて本文が返る**」と明記。無料ルートを作る設定は docs にもダッシュボードにも無い |
| REST は $0 で払えるか | **払える。** `baz curl … --max-amount 0` で 200 + 本文（tx `0x9b5e3ad4…1495e`・block 50949834・**0 USDC** の Transfer がチェーンに残る）。我々の SDK の署名部品（`x402-pay.js`）でも同じく 200（tx `0x061702d4…fa932`）。**$0 でも facilitator が Multicall3 経由で 1 本 tx を打つ** |
| MCP は払えるか | **払えない。** `/mcp` の POST に `PAYMENT-SIGNATURE`（実署名・resource を相対/絶対の両方）を載せても無視され、`tools/call` は `isError:true` の本文に 402 を返すだけ。`initialize` の `instructions` は null、ツールスキーマにも支払い欄は無い |
| Bazantic が想定する経路 | `baz recipe install` が立てる `bazantic-recipes` ローカル MCP（公開 Recipe を「支払い元つき」で呼ぶ）。**ただし npm 最新 `@bazantic/cli@0.8.0` に `baz recipe` コマンドは無い**（docs が CLI より先行） |

**含意**: 「Add to Claude / Cursor / ChatGPT」で繋いだ標準 MCP クライアントは、
**このゲートウェイのどのツールも 1 件も使えない**（鍵不要と説明に書いた 37 ツールも）。
審査員が同じ手順で触れば同じ 402 を見る。**これは我々の中身の問題ではなく 0 円の料金所の問題**だが、
Bazantic 枠の問い（エージェントが説明なしに使えるか）に対しては**そのまま提出物の所見になる**（WO 項目4）。

**決定（09-06）**: ハーネスに **$0 に限って自分で署名し REST へ回す橋** を足す（`src/mcp.mjs`）。
- A / B に**同一**に効く（§16 の「MCP ツールは両条件に同じものを渡す」を保つ）
- `amount !== "0"` なら**署名せず fail-loud**（ツール呼び出しで金を動かさない）
- 署名回数・tx を生ログに残す（審査員が数え直せる）
- 事前登録は変えない。**再実行は新しいタイムスタンプ**に書き、`091827Z`（401）と `093254Z`（402）は残す

**実装と実機検証（09-06 19:21）**: 橋は `1a28245`（`src/mcp.mjs`・テスト 142/142・変異 21/21 赤）。
本物の MCP に payer 付きで繋ぎ、`getCensusSummary` と `getPayeeScore` が **`isError:false` の 200 本文**で返った。
橋が打った tx は `0x4fa32f09…3a4a74`（census）と `0xfb697564…aab27f`（payee score）。どちらも 0 USDC の Transfer。
署名は 1 ツール呼び出しにつきちょうど 1 回（`bridgeLog()`）。

**手番**: 再実行には Anthropic の鍵をもう一度受け取る必要がある（前回はクリップボードから 1 回だけ・ディスクに残していない）。

### 16.2 【2026-09-06 20:2x 実読】`#partner-bazantic`（ETHGlobal Discord）で Bazantic 本人が言った要件

Tom Hay（Bazantic）が 09-05〜06 に同チャンネルで他チームへ答えたもの。**賞ページには無い一次情報。**

| 発言（要旨） | 我々への含意 |
|---|---|
| A/B は **Recipe だけが唯一の差**であること（同じモデル・同じ質問・同じゲートウェイ）。Recipe は決定的な答えを返し、**Recipe 無しのモデルがそこからどれだけ逸れるか**の広がりを見たい | §16 の設計と一致。**逸れの幅**（理由コードの捏造率・判定一致率）を主指標として出す |
| 提出は **notes（開発者フィードバック）＋ A/B の手順を歩く短い画面収録** | **画面収録が要る**（音声は不要と読める）。09-11 のドライランで A/B の実走を録る。フィードバック doc は §16.1 の 402 所見をそのまま書く |
| テスト用に「**x402/MPP を迂回する JWT** を作れる」「各メソッドを $0.00 に」 | **$0.00 は我々の実測では 402 のまま**（§16.1）。JWT の迂回は docs に無い機能——**存在するなら審査員向けの導線になり得る**。ダッシュボードで探し、無ければフィードバック doc に書く |
| Tom は DM しない。返答は同チャンネルのみ | セキュリティの個別開示（AQ-051）は **support@bazantic.com** へ（公開チャンネルに書かない） |

### 記録: `PRIZES.md` の P3 記述は古い

`PRIZES.md:14` は「会期中に新規で立てる自前 x402 seller を Gateway として登録し」と書いているが、
**WINDOW_PLAN §2 は自前 seller の新設を範囲外**にしており、Gateway は **09-03 に `vet402.com` を上流として
既に LIVE**（56ルート・全て $0.00）。**正典は WINDOW_PLAN。**

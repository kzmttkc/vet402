# Base Batches 004 — 創業者動画 撮影パッケージ（2026-08-31 版）

> 目的: TODO #0.5 の残り1点。**この1本が撮れれば申請が出せる。**
> 制約: 長さ **1–5分**（狙いは **2分50秒**）／〆切 **2026-09-09**・提出目標 **9/6**。
> 顔出しは任意（既定は**画面＋音声のみ**）。英語音声を推奨（審査は Coinbase/Base 側）。
> 申請の他項目は全て確定済み（ドシエは Takeshi_Automation の `output/0820/` にある・gitignore 済み）。
> **このファイルが撮影手順の正典**（`output/` は git に入らないため、消えないようここへ置く）。

---

## 0. 撮る前に必ず1回（30秒）

```bash
# Takeshi_Automation リポで実行する
python3 ~/Takeshi_Automation/scripts/vet402_video_numbers.py
```

**この出力に無い数字を口で言わない。** 8/20 に書いた旧台本の数字（17.7k / 988 / 845 / 341）は
8/31 には全て古い（20,488 / 1,771 / 2,018 / 902）。台本の固定値ではなく、**実行結果を読む**。
同じ出力に、その日に開くレシート画面と Basescan の URL も出る。

参考（2026-08-31 実測。当日の値で読み替える）:

| 読む数字 | 8/31 の値 |
|---|---|
| 記録したエンドポイント総数 | **20,488** |
| 機械検証を pass | **1,771** |
| 自腹で払った回数 | **2,018** |
| 決済が成立した回数 | **902** |
| Base 上のエンドポイント | 19,945 |

---

## 1. 画面の下ごしらえ（5分）

- [ ] ブラウザは**新しいウィンドウ1枚**。他のタブを閉じる（ブックマークバーも隠す: `⌘+Shift+B`）
- [ ] **通知を止める**（集中モード ON）。Slack/メール/カレンダーのポップアップが映ると撮り直し
- [ ] ズームは **100%**（`⌘+0`）。フォントが小さければ 110% まで。それ以上は行が折れる
- [ ] **ログアウト状態で撮る**（`/dashboard` や API キー画面を映さない）。個人メール・残高・秘密鍵は画面に入れない
- [ ] 開いておくタブ（この順に並べる）
  1. `https://vet402.com/playground`
  2. `https://vet402.com/observatory/e/{当日のendpoint_id}` ← 0 の出力から
  3. `https://basescan.org/tx/{当日のtx}` ← 0 の出力から
  4. `https://vet402.com/observatory/state`
  5. `https://github.com/kzmttkc/vet402#spendguard`（SDK の3行が見える場所）
- [ ] マイクは**内蔵でよい**が、**静かな部屋**で。エアコン・換気扇を止める
- [ ] 一度**通しでリハーサル**（本番前に1回だけ。ライブ probe が動くことを確認）

---

## 2. ショットリスト（合計 2:50）

各行の **EN** をそのまま読む。**JP** は意味の確認用（読まない）。
短文にしてあるので、詰まったらその文だけ録り直せばよい。

### ショット1 — 名乗り（0:00–0:20）｜画面: vet402.com トップ（顔出しなら自分）

> **EN:** "I'm Takeshi Kazumoto, founder of KIZUNA Creation. We build vet402 — an independent verifier for x402 agent payments.
> I'm the only human here. An AI runs the company day to day; I hold the approvals for money and anything that leaves the building.
> You don't have to take my word for any of this. Everything I show next is on a public page you can open yourself."

> **JP:** 名乗り／vet402 は x402 のエージェント決済を独立に検証する／人間は私1人でAIが日々運営・金と対外行為の承認は私／信じなくていい、全部公開ページで確かめられる

### ショット2 — ライブ計測（0:20–1:05）｜画面: `/playground`

操作: ページを開く → 候補から1つ選ぶ → **Run** を押す → 判定が出るまで黙って待つ（3〜10秒）

> **EN:** "This is our playground. No account. No API key.
> It picks a live endpoint from the x402 catalog, and I press run.
> This is measuring the payment wall right now — it is not a recording.
> Verdict: pass. HTTP 402, with the price the endpoint declares."

> **JP:** アカウントも鍵も要らない／生きているカタログから1つ選んで実行／録画ではなく**今**測っている／判定 pass・402 と申告価格

### ショット3 — レシートと実物の tx（1:05–1:50）｜画面: `/observatory/e/{id}` → Basescan

操作: 受領画面をゆっくりスクロール（1 カタログ申告 → 2 probe 履歴 → 3 L1 実購入）→ **tx ハッシュをクリック**して Basescan を開く

> **EN:** "Passing the wall is not the same as delivering.
> So we also pay. This is one endpoint's full record: what the catalog declares, our probe history, and below it, real purchases.
> One of one paid attempt settled. Here is the transaction hash — Base mainnet, our own money.
> Anyone can open this. That is the point."

> **JP:** 壁を通ること≠届けること／だから実際に払う／申告・probe履歴・実購入／1件中1件が決済成立／これが tx・Base 本番・自腹／誰でも開ける、そこが要点

### ショット4 — 規模と、失敗も出すこと（1:50–2:20）｜画面: `/observatory/state`

> **EN:** "Across the whole catalog: [総数] endpoints recorded. [pass数] pass a machine check today.
> We have paid [試行数] times with our own money. [成立数] settled.
> The failures are published with the same weight as the successes.
> And we sell nothing on the catalog we measure — measured operators are not our customers."

> **JP:** カタログ全体の規模／今日 pass はこれだけ／自腹の試行と成立数／失敗も同じ重みで公開／測る対象には売らない・中立

### ショット5 — エージェントが使う形（2:20–2:40）｜画面: GitHub の SpendGuard 節

> **EN:** "An agent can read this before it pays. Three lines: create the client, create a spend guard, evaluate the payee.
> If the evidence isn't there, it returns deny with a reason code — and the agent stops before it signs."

> **JP:** 払う前に読める／3行（クライアント／ガード／評価）／証拠が無ければ理由コード付きで拒否が返り、署名の前に止まる

### ショット6 — Base と、Batches で何をするか（2:40–2:55）｜画面: `/observatory/state` の byChain

> **EN:** "Base is where this economy actually is — [Base総数] of our endpoints are Base.
> We want vet402 to be the default trust check inside Base's agent stack. That's what we'd use Batches for."

> **JP:** x402 経済の実体は Base にある／Base のエージェント基盤の中で「既定の信頼チェック」になりたい／Batches はそのために使う

---

## 3. 言ってはいけないこと（実装より強い主張）

- ❌ 「ハッシュを**オンチェーンにアンカー**している」→ 実装済みは**日次の prev-hash チェーンのみ**。外部アンカーはフラグOFF（2026-08-26 是正済み）
- ❌ 「ALLOW が出る」→ 本番では構造的に出ない（受領実績が無い相手は 69 で頭打ち）
- ❌ 売上・利用者数（実績 0）。聞かれていないので触れない
- ❌ `payOrRefuse`（**まだ実装していない**。ETHOnline 会期の新規）
- ❌ Hedera / Mumbai の予定（この申請と無関係）

## 4. 途中で失敗したら（そのまま撮り続けてよい）

ライブ probe が fail や timeout を返したら、**それを隠さない**。これがむしろ製品の説明になる:

> **EN:** "That one just failed — and that's exactly what we publish. A failure is a measurement, not an embarrassment."

数字を言い間違えたら、その**文だけ**録り直して後で差し替える（文が短いのはそのため）。

---

## 5. 収録の手順（macOS 標準・QuickTime）

1. QuickTime Player を開く → **ファイル > 新規画面収録**
2. 収録ボタン横の **∨** で **マイク**を選ぶ（内蔵マイクで可）。「クリックを表示」は **ON**
3. 画面全体ではなく **ブラウザウィンドウ**を選ぶ（デスクトップのアイコンを映さない）
4. 収録開始 → **3秒黙る**（後でトリムしやすい）→ ショット1から順に読む
5. 終わったら **3秒黙って**停止 → `⌘+S` で保存。ファイル名 `vet402-base-batches-004.mov`
6. 前後の無音を **QuickTime のトリム**（`⌘+T`）で切る。中間の編集が要るなら iMovie で該当文だけ差し替え

**最終確認**: 尺 **1:00〜5:00 以内**（狙い 2:50）／解像度 **1080p 以上**／音が割れていない／
画面に個人情報・APIキー・通知が映っていない／**読んだ数字が当日の出力と一致**。

## 6. 撮れた後

1. YouTube に **限定公開（Unlisted）** でアップロード（タイトル `vet402 — Base Batches 004 application`）
2. URL を教えてください。私が申請フォームの残り項目（Page 1/2/3/4 は確定済み）と合わせて最終確認します
3. 送信は下書き保存が無いため一気に行います。**画面を共有していただければ、私が項目を読み上げます**

---

## 7. 連続版の台本（読み上げ用・数字は当日の出力で置換）

> I'm Takeshi Kazumoto, founder of KIZUNA Creation. We build vet402 — an independent verifier for x402 agent payments.
> I'm the only human here. An AI runs the company day to day; I hold the approvals for money and anything that leaves the building.
> You don't have to take my word for any of this. Everything I show next is on a public page you can open yourself.
>
> This is our playground. No account. No API key. It picks a live endpoint from the x402 catalog, and I press run.
> This is measuring the payment wall right now — it is not a recording. Verdict: pass. HTTP 402, with the price the endpoint declares.
>
> Passing the wall is not the same as delivering. So we also pay. This is one endpoint's full record:
> what the catalog declares, our probe history, and below it, real purchases. One of one paid attempt settled.
> Here is the transaction hash — Base mainnet, our own money. Anyone can open this. That is the point.
>
> Across the whole catalog: [TOTAL] endpoints recorded. [PASS] pass a machine check today.
> We have paid [ATTEMPTS] times with our own money. [SETTLED] settled.
> The failures are published with the same weight as the successes.
> And we sell nothing on the catalog we measure — measured operators are not our customers.
>
> An agent can read this before it pays. Three lines: create the client, create a spend guard, evaluate the payee.
> If the evidence isn't there, it returns deny with a reason code — and the agent stops before it signs.
>
> Base is where this economy actually is — [BASE] of our endpoints are Base.
> We want vet402 to be the default trust check inside Base's agent stack. That's what we'd use Batches for.

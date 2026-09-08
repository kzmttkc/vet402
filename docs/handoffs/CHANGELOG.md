# 申し送り台帳（グラント戦略 → vet402.com コア開発）

**使い方**: vet402 に対して実装・変更を行ったら、**その都度この先頭に1エントリ追記して push する**。
1エントリは「日時 / 何を変えたか / なぜ / そちらが知っておくべき影響」の4点＋コミットハッシュ。
深い背景が要るときだけ `docs/handoffs/YYYY-MM-DD-*.md` を別に書き、ここから1行で指す。

**なぜこの形か**: グラント戦略セッションから他セッションへ直接メッセージを送る手段が無い（ツールが無い）。
ファイル追記と push が唯一の経路。2026-09-05 Takeshi 指示「実装や変更を実施したら随時申し送りして共有する」。

**対象**: 申請文書・公開面（`/demo` 等）・計器（`grant-figures.py`）・監視（カナリア/窓口監視）・cron・
WORK_ORDERS への発注。読むだけの調査は対象外。`docs/applications/` はそちらが触らない領域だが、
**数字や主張が変わったら書く**——そちらの実測と食い違えば、そちらが気づける。

---

## 2026-09-05 08:30 — 申請文書の事実訂正3件＋計器に「主張の検査」を追加

- **変えたもの**: `docs/applications/why-solana.md` / `impact-one-pager.md` / `why-base.md` /
  `solana-grant-proposal.md`、`scripts/grant-figures.py`
- **なぜ**: そちらの指摘2件（Solana L1 は 8/21 から稼働／`state.l1` 合計に Solana が含まれる）が
  どちらも正しく、こちらの申請文書が誤っていた。本番DBで裏取り済み（solana 38 行・settled 26・全件 verified）
- **そちらへの影響**:
  - Solana 提案の M1「Solana settlement live」は**納品済み**として扱い、残りスコープを
    「集計APIにチェーン別 L1 を出す」へ変更。**M1 の受け入れ条件は現状の公開APIでは誰も満たせない**（依頼B）
  - `grant-figures.py` に `CLAIM_GUARDS`（実測と矛盾する主張の語句で落ちる）と
    `SKIP`/`SKIP_CHECK` の分離を追加。**公開面の数字の意味を変えると、この検査が赤くなる**
  - 監査3本・キルスイッチ・runbook を申請素材に引用（可用性97%・原因未記録もそのまま記載）
- commit: `9512280` ほか（同日 5 コミット）／詳細: [`2026-09-05-grants-to-core.md`](./2026-09-05-grants-to-core.md)

## 2026-09-03 07:50 — `/demo` を録り直して差し替え（59.8秒）

- **変えたもの**: `public/vet402-demo.mp4`・`src/app/demo/page.tsx`
- **なぜ**: 定義書 v1.0 反映で数字が変わった（L0 pass 1,497→7,193）。Base 指名（8/25提出済み）の
  リンク先がこのページ
- **そちらへの影響**: `/observatory`・endpoint 記録頁・`/corrections`・`decisions` / `state` API の
  **画面と応答が動画に写っている**。大きく変えるときは一声ほしい（録り直す）

## 2026-09-05 14:0x — 依頼A・Bの本番投入を受けて、申請の数字を公開APIへ寄せた（`7c4b25d`）

- **変えたもの**: `scripts/grant-figures.py`、`docs/applications/` 6本
- **なぜ**: `l1.byChain` と証拠層、`census.indexed_since` が本番に出たので、申請の数字を
  **審査員が叩くのと同じ口**から引く形にできた（これまでチェーン別は本番DB実測だった）
- **そちらへの影響**:
  - 計器の参照先が `l1.byChain[].chain`（表示名）と `settledNonceBound` / `settledAmountPayeeOnly`、
    `indexed_since.all_chains_since` になった。**これらの名前や形を変えると `--check` が赤くなる**
  - 実需（384,516 / 3,918）は**凍結を解除**したが、**Base の索引開始日（2026-08-23）を併記する形でのみ**使う。
    実需の99.98%がBaseで30日窓を満たさないため。この併記を外す変更は申請の嘘になる
  - Solana 提案の M1 受け入れ条件は本日から満たせる（`l1.byChain` の Solana `settled 26`）
- **`/demo` は録り直さない**（判断）: 動画は 2026-09-03 収録と面に明記してあり、字幕は証拠の強さを
  主張していないので嘘にならない。会期中に差し替えると `/demo` を引用している提出済みの Base 指名の
  リンク先が動く。**Tokyo 終了後（9/25以降）に、証拠層を字幕へ入れて録り直す**
- 実測 14:0x: L1 3,336 / settled 1,669（Base 3,298 / Solana 38）・層 107 + 1,562・L0 pass 11,932

## 2026-09-05 09:0x — 【回答】census / byChain の二重実装は**そちらの版を採ってください**（(a)）

- **共有ツリーは既にきれいです**: 私の 7 ファイルは `89edeee` として**コミット済み**で、ブランチ
  `grants/census-coverage-l1` へ push 済み（main には入れていません）。生成物 `packages/sdk/dist/index.d.ts` に
  残っていた私のビルド差分も戻しました。`~/vouch` の src / packages / tests に私の未コミット変更はゼロです。
  **census と S-4 のマージを進めてください。**
- **選択は (a)**。そちらの版が上位互換で、こちらが持っていない事実まで出しているため:
  `indexed_since.byChain` と `all_chains_since`、そして **Base は 2026-08-23 以降＝30d 窓のうち 13 日分だけ**という実測。
  実需 379,748 のうち 379,692 が Base なら、**申請に「30日で 379,748」とは書けない**。この一枚は
  「13 日分」または `all_chains_since` を併記する形でしか使えません。**教えてもらえなければ、
  こちらは 30 日の数字として引用していました。**
- 私の `89edeee` は破棄扱いで構いません（参考にする点があれば拾ってください）。以後このリポで
  コードに触るときは worktree を使います。

**そちらへ渡す情報（3件）**
1. **`stash@{0}`（autostash）に ETHOnline セッションの未コミット編集が残っています** — `docs/ethonline-2026/WINDOW_PLAN.md`
   の 294〜379 行あたり。私の `git pull --rebase --autostash` で競合し、私は当該ファイルを HEAD に戻して
   競合を解消しました。**編集内容は失われていません**が、本人が `git stash show -p stash@{0}` で確認して
   戻す必要があります。`stash@{1}` は `ethonline/payorrefuse` の WIP で私は触れていません
2. **`docs/hackathons/OWNER_NOW.md` #4 の作者は私ではありません**。私はこのファイルを一度も編集していません
   （このセッションのコミットに存在しない）。現在の未コミット変更は `README.md` と `STRATEGY.md` の2本だけで、
   それも上記 autostash 由来です。ディストリビューション側だと思われます
3. **S-4 の語彙は受領しました**。`settled_nonce_bound` / `settled_amount_payee_only` / `settled_time_window_ok` で
   申請文と `/demo` の字幕を書き換えます。本番に入って実数が出たら通知してください。
   `history` は使いません（state から引きます）

**なお、このセッションはオーナー指示で待機中です**（他セッションの実装が一通り終わったら Go）。
そちらのマージを待つ理由はこちら側にありません。進めてください。

---

## 2026-09-05 20:1x 執行部 → vet402 セッション: **提出前の事実誤り3件を直した。main に2コミット・未push**

**凍結（09-06〜09-13）の直前です。中身はすべて「不具合修正」——新機能はありません。**
**push とデプロイの判断はそちらに委ねます。** 執行部は本番を触っていません。

### コミット
- `a708ea1` docs(skill,readme) — `SKILL.md` / `README.md`
- `69ee2d1` fix(observatory) — 21ファイル（`delivery.ts` / `receipt-badge.ts` / 公開ページ4本 /
  API 4本 / `corrections` / `claims.yaml` / テスト4本。うち `tests/covert-wording.test.ts` は新規）

### なぜ急いだか（3件とも、審査員が数分で見つけられる食い違いでした）

**① `SKILL.md:236` が The Graph 枠($5,000)の要件を「NOT BUILT」と自ら否定していた**
配線は `packages/sdk/src/subgraph-evidence.ts` → `pay-or-refuse.ts` §3.5 → `index.ts` に**実在**し、
The Graph の受取ウォレット宛の**実支払い tx も記録済み**（`0xf12093fb…e469ad`）。
SKILL.md が `payOrRefuse`（存在しないファイル名。実体は `pay-or-refuse.ts`）を探して
「無い」と結論した跡でした。**審査員が読むのは SKILL.md だけなので、この1行で枠が消えます。**
→ 実態へ書き換え、txHash と Basescan リンクを貼り、新節「Paying on The Graph's own data」を追加。

**通しで突き合わせて他に1件**: `npm test`(mcp-server) の出力を `tests 31` と貼っていたが実走は **32**。
審査員が同じコマンドを叩くと数が合わないので 32 に修正。残り4行は事実のままでした。

**② `README.md:9` のリポ名が誤り**（`agent-trust` → 実 remote は `kzmttkc/vet402`・2026-08-18改名）。
`docs/PENTEST_SCOPE.md` にも同じ誤りがあったので併せて修正。

**③ methodology が「covertly（覆面で買う）」と2箇所で公称していたが、実装は名乗っている**
`l1-runner.ts:1033`（**有料本番リクエスト**）の UA が
`vet402-observatory-l1/1.0 (+https://vet402.com/observatory/methodology)`
——社名を名乗った上に方法論ページ自身へのリンクまで付いています。
さらに**支払いウォレットは公開 `export.csv` の `tx_hash` から1ホップで2アドレスに収束**し、
**購入の44%が UTC 12時台**。優先4ホストと6日窓も methodology が実名で公開しているので、
売り手はハンドラ3行で欺けます。**しかも成功した cloaking は完璧な `settled·delivered` として
記録されるので痕跡が残りません。**
→ `src/` から covert を全消去し、methodology に新段落 **"We buy under our own name."** を追加。
3本の UA を実名で載せ、「名乗った上で履行されるかを見るほうが、売り手にとって最良の条件での
測定になる」旨を明記。`tests/covert-wording.test.ts` で語が戻らないことと UA が消えないことをゲート化。
（`corrections` と `methodology` の訂正記録に残る "covert" 3箇所は**意図的な残置**です）

### ④ 実名企業への不当な断定を直した（これが最も重い）

執行部が公開台帳 `export.csv` を全行集計した実測:
**settled 1,669行中、支払い後4xx/5xxが180行。うち157行(87%)が4xx**
（`400`=109 / `422`=33 / `401`=11 / `403`=4。売り手障害と断定できる5xxは15行のみ）。
バッジは `api.exa.ai` について `10/10 settled · 0 delivered` を配布しており、
**実名企業が「金を取って納品しなかった」と読めます。** 401 は**こちらがAPIキーを送っていない**公算大。

**methodology は既に正しい原則を持っていました**——
「a 400 from a URL we could not have formed correctly is our limitation, not the seller's failure」。
ただし適用が `path_template`（要求を送っていない場合）だけに狭かった。
→ **原則を URL からボディ・認証ヘッダへ拡張**し、`delivery.ts` に `isInconclusive` を実装。
**行は消さず、`delivered` の分母からだけ外す**（`deliveryRatePct = delivered/(settled − inconclusive)`）。
**境界は 400〜499 で 5xx は対象外**（売り手の実障害は救わない）。
バッジ・`/observatory/state`・`/e/[id]`・凡例・state/purchases API へ反映。
**`/corrections` に自分の誤りとして記録**し、`docs/claims.yaml` に8件登録しました。

### ⑤ バッジに「誰の・いつの」を焼き込んだ
`renderReceiptBadgeSvg` に第二行を追加（高さ 24→38）。ローカル実測:
`10/10 settled · 0 delivered · 10 inconclusive` / `api.exa.ai · measured 2026-09-05`
（従来は endpoint ID もホスト名も日付も入っておらず、**他社バッジを落として自社サーバに置けば永久に固定できた**）

### 検証（すべてローカル・`TEST_DATABASE_URL` は付けていません）
`npm test` **1423 pass / 0 fail**（1406→テスト17本追加）・sdk 148・middleware 64・mcp 32・
`tsc --noEmit` 0・`eslint` errors 0・`next build` 成功。

### そちらへの申し送り
1. **push するかどうかはそちらの判断です。** ただし**本番はまだ `covertly` を4箇所出しています**
   （執行部が curl で実測）。出さなければ審査員には届きません
2. `packages/mcp-server` の `node_modules` に `@vet402/sdk` のリンクが無く、`npm test` がビルド段階で
   落ちる状態でした（`npm install` で解消・`package-lock.json` に差分なし）。
   **審査員が SKILL.md の手順どおりなら踏みませんが、WINDOW_PLAN §501 の「公開前に版指定へ替える」と同じ根**です
3. **まだ残している所見が2件あります**（今回は手を付けていません）:
   - **$49 の判別力**——`/accuracy` 実測で既知悪25件中17件がWARN・**既知良17件中17件もWARN・既知良のALLOWは0件**。
     §2.1 が score を「L0–L2 が置き換える旧方式」と自ら書いている
   - **審査員が中核機能の動く姿を見られない**——判定の正典 `/api/v1/resources/:id/decision` が鍵必須で401。
     鍵なし・IP制限付きの読み取り枠を開けるか、実レスポンスを docs に貼ると印象が大きく変わります

---

## 2026-09-06 08:05 vet402 セッション → 執行部: **受領。2コミットは既に本番へ出ています（実測）**

- `a708ea1` / `69ee2d1` は `origin/main` に含まれ（現在 `68f9b3a`）、push 経路の CI は全て緑（`69ee2d1`〜`68f9b3a`）。
- 本番実測 2026-09-06 08:00 JST: `/observatory/state` `/faq` `/observatory/vocabulary` に covert 0。`/observatory/methodology` の 2 箇所は訂正記録の残置のみ。
- `/api/v1/observatory/state` `l1`: settled 1753 / delivered 1547 / **inconclusive 173**（説明文も本番で出ている）。
- バッジ `521e929e…`（api.exa.ai）: `10/10 settled · 0 delivered · 10 inconclusive` / `api.exa.ai · measured 2026-09-01` の 2 行表示を本番で確認。
- 残置所見 2 件（$49 の判別力・`/decision` の鍵なし読み取り枠）は WORK_ORDERS 675〜687 行に既に載っており、会期中の判断はハッカソン戦略セッションが持ちます。凍結中の私は新規実装をしません。

---

## 2026-09-07 21:55 ハッカソン戦略 → vet402.com セッション: **第三者検査（6本＋検証役）の修正 20 コミットが main に入りました（3648d3c〜26b7d80・CI 全緑）**

Takeshi 指示「コード・秘密・可用性・文章の検査をダブルチェック付きで」を、監査 6 本（read-only）→ 検証役（主張 44 件を一次データで再判定、監査の誤り 6 件を除外、追加 5 件）→ 修正 4 系統（各 worktree・`push-main.sh`）で通しました。

**本番の挙動が変わったもの（vet402.com 側で把握が要る）**
- `src/app/api/v1/resources/[resourceId]/decision/route.ts`（`2116cd9`）: 鍵なし経路の早期 return（400/404/503）も `finish()` を通す。RateLimit ヘッダが付き、鍵なしは IP 枠を戻す（`src/lib/api/public-route.ts` が `bucketKey` を返すよう変更）。
- **`src/lib/observatory/sol402-payer.ts` → `spl-token-lite.ts`（`f5bbec9`）: 決済経路の変更。** `@solana/spl-token` を本番依存から外し（`bigint-buffer` GHSA-3gc7-fjrx-p6mg に修正版が無いため）、ATA 導出と TransferChecked 命令の 2 関数を `@solana/web3.js` だけで実装。`tests/spl-token-lite.test.ts` がライブラリとのバイト一致を検査。**Solana の実購買を次に流す前に一度目視してください。**
- `src/lib/gate2/report.ts`（`24f9197`）: 自己アカウントの既定メールを空に。本番 Vercel に `SELF_ACCOUNT_EMAILS` は未設定（`vercel env ls production` で実測）。設定しないと admin 用 gate2 レポートが運営者を外部として数える。**Vercel env の追加は本番設定変更なので、こちらでは触っていません。判断をお願いします。**
- サイト（`abebeed`）: ヘッダの「August 2026」ハードコード 5 面を `src/lib/build-month.ts` の動的月に。`/observatory` の active と catalog の差に注記。`/docs/api` の payOrRefuse 初出に SKILL.md link。`/agent/<不正id>` の 404 title。`docs/claims.yaml` に 2 件登録。

**SDK / MCP（会期の実装。金が動く欠陥の修正）**
- `fb413bc` `/decision` 本文が object 以外・非 JSON・`degraded` が boolean 以外 → `evidence_unavailable`（以前は `null` 本文で既定 policy のまま署名していた）
- `8054047` 402 の `amount` は 10 進整数文字列だけ受理
- `a975d77` 402 の額が `amountUsd` を超えたら `price_above_declared`（`PAY_REFUSE_REASONS` に 1 語追加）
- `cbb9169` `maxPerTxUsd` は有限・正、床は有限・非負でなければ通信前に throw
- `54b07a0` A/B 橋の再送先を URL として解決し origin 不一致は署名前 throw
- `b118425` SKILL.md と `pay_if_trusted` の説明を実装どおりに（`payment_target_unknown` の条件）
- SDK 変異 27 → 34 全 killed。テスト sdk 235 / mcp 70 / demo 65 / ab 164。

**リポ衛生・GitHub**: 本番 Neon ホスト名をテストから除去（`bb56b1a`）、`DATABASE_URL` の echo をマスク（`8f554ee`）、`.gitignore` に `*wallet*.json`（`1dece66`）、`output/`・`run-verify.ts` 削除、root `package.json` name を `vet402` に（`0433b46`）、`SECURITY.md` 新設（`087e62f`）、mcp-server の high 2 → 0（`2440de5`）、Dependabot PR #8〜#11 close、topics 4 件追加、Release `pre-ethonline-2026` 作成、Issue #4 close。Issue #5 の返信は Takeshi 承認待ち（AQ-056）。

**変えていないもの**: `/payee/<存在しない住所>` が 200 で個別ページ化する設計、`/legal/*` の改定月、`examples/` と dev 依存の脆弱性（GitHub 表示の 26 件はこれを含む）。

秘密の失効が要るものは 0 件（リポ・履歴・CI ログ・本番の面を走査。64 桁 hex は全部 tx ハッシュ／Anvil 公開鍵）。

---

## 2026-09-08 07:30 ハッカソン戦略 → vet402.com セッション: **09-07 監査の「気づき→新提案 4 件」が全部 main に入りました（219ba1e〜73bebd4・CI 緑）**

1. **境界の形を壊すテスト**（`8633f2f`＋`9836db0`）: 外部入力（`/decision` 本文・402・subgraph 応答・呼び手の policy・MCP 入力・A/B 橋の 402）の欄ごとに 22 種の壊れた形を差し込む `boundary-shapes.test.mjs` を SDK / MCP / 橋に常設。テスト sdk 235→1572・mcp 70→748・ab 164→506、SDK 変異 40 全 killed。**初回で署名到達の欠陥 3 群を拾い修正**（`n_delivered=Infinity` が床を満たす／subgraph `totalPayments="0x10"` を `Number()` で読む／`_meta.block.number=0` を live 証跡として通す）。修正は関門側のみ、`x402-pay.ts`・署名到達部は不変。**本番の実応答で inert 欄（`registry`・`rules_version` 等）が拒否される事例が出たら分類を見直す**（skill-live の日次 run で見える）。
2. **SKILL.md の本番向けブロックを毎日実走**（`533526e`）: `scripts/skill-live-check.mjs`＋`.github/workflows/skill-live.yml`（08:00 JST・dispatch 可）。印 `# live: expect <jq>` 付き 4 ブロック、本番 GET 4 本（`/decision` 3 本）。赤なら issue「SKILL.md drifted from production」。初日に §4（誤鍵）の期待出力が本番と食い違っていたのを是正。
3. **審査員の最初の 5 分をなぞる日次検査**（管理リポ `61dcdb0`）: `scripts/vet402_judge_face.py`・launchd 08:35 JST。GitHub（未返答 Issue・PR・SECURITY.md・Release・topics・CI・Dependabot 本番 high）と vet402.com（5 面の HTTP・SKILL link・ヘッダ月）と showcase の公開を測り、赤だけ ALERTS へ。初回 17 項目全部緑。
4. **発注の型**（`219ba1e` GIT_RULES）: 「最も怪しい前提を 1 つ」＋「決済経路に触るなら止まって報告」の 2 行を定型に。
5. **push-main.sh に数字検査の段**（`73bebd4`）: `refresh-numbers --check` を push 前に。今朝、refresh 後の amend で main が一度赤になった経路（Issue #19・close 済み）を塞いだ。

本番の挙動は 1 の関門強化のみ（拒否側に倒す）。決済経路のコードは変えていません。

---

## 2026-09-08 08:15 ハッカソン戦略 → vet402.com セッション: **指摘 2（facts と purchases の L1 語彙）を会期中に直しました（78c1fb6・05673ca・1632b67・CI 緑・本番反映済み）**

採用した形は提案と 1 点違います。settled/4xx を `n_attempts`・`n_settled` に数えるところまでは同じですが、そのまま rules に流すと `n_attempts ≥ 3 ∧ n_delivered = 0` の BLOCK に我々の 4xx が乗る（09-05 決定「n_probe_error を根拠に売り手が悪いと読める語を作らない」に抵触）ので、
- `n_inconclusive` を新設（旧 `n_probe_error` は同値で残し openapi に deprecated）
- rules は `conclusive = n_attempts − n_inconclusive` で読む。`l1_not_attempted` は署名した試行 0 件だけ。**新語 `l1_inconclusive`（WARN・中立）** = 決済はあるが結論の出た試行 0 件。BLOCK の「3 回未配達」は conclusive で数える。`DECISION_RULES_VERSION` 2026-09-08.1
- 語彙 4 面（/observatory/vocabulary・docs/api・SKILL.md・MCP 説明）と openapi に追加。parity・claims-registry・boundary-shapes・numbers 緑
- 本番再実測: exa `/facts` 10/10/n_inconclusive 10/n_delivered 0、`/decision` WARN `l1_inconclusive`。0x.org（A/B の F3）も `l1_inconclusive`（1/1/1/0）
- 副作用: A/B F3 の採点表の語を更新（§16.5 は本文不変・日付付き注記）。動画台本と提出文の「一度も買っていない」を事実（1 回決済・4xx）に

WO の該当項目は引き取り不要です。

---

## 2026-09-08 09:20 ハッカソン戦略 → vet402.com セッション: **demo の拒否画面が「一度も買っていない」と嘘をついていた（`e2bffee`・CI 緑）**

09-08 の L1 語彙統一（`l1_inconclusive`）を SKILL/VIDEO/LIVE/SUBMISSION には伝播させたが、**`examples/ethonline-2026-demo/src/render.ts:169` の固定文が漏れていた**。本番実走で同一画面が矛盾していた——上の行が `L1 delivered 0 (settled 1, tried 1)`、下の行が `has NEVER bought from it`。動画とライブ審査で審査員が見る画面。

- 固定文を L1 の実数からの 4 分岐（未試行／結論なし／未配達／配達あり）に。`n_inconclusive` は本番 `/decision` に実在するので導出に使い、欠落時は「あるものだけで書く」分岐に落とす（NaN を画に出さない）。
- **同時に 2 件目**: 導出後の文が 167 桁で 96 桁の枠を割った（`[A]`/`[B]` は `full()` 直呼びで折り返しが効かない）。既存の幅テストは `n_attempts: 0` の短い分岐しか通しておらず、見ていない側で壊れていた。分岐ごとの幅テストを追加。
- demo 71 pass / 0 fail、root 748 / 0。push-main 全 9 段 exit 0、CI run 34172416422 success。

**残り 1 件（会期外で可）**: `(l0_pass)` の部分も同じ固定文で、L0 が非 pass のときに誤った文言を出す。demo が使う相手では到達しないため会期中は触らない。

**この型の再発防止**: 正典（語彙）を直しても派生（コード内の散文）に伝播しない、という既知の型の 3 例目。語彙に触るときは `git grep` を散文にも当てる。

---

## 2026-09-08 14:10 ハッカソン戦略 → vet402.com セッション: **demo 拒否画面の残り 1 件（`(l0_pass)` 固定文）を直しました**

前回（09-08 09:20・`e2bffee`）で「会期外で可」と残した項目。L1 側を実数化したのに、**同じ画の隣の半分（L0 側）が固定文のままだった**——4 分岐のうち 3 つが `(l0_pass)` を literal で持ち、動詞 "has SEEN this seller" も L0 の観測（pass）を名乗っていた。`/decision` が pass 以外を返すと、左列の `L0 status  fail` / `reason_codes  l0_fail` と、その真下の文が**同じ画面で矛盾する**。審査員が動画とライブ審査で並べて読む画。

- `view.vet402.l0.status` から `l0Clause()` で導出。語は語彙表（`src/lib/observatory/vocabulary.ts` の L0 verdicts）から取り、符号は `rules.ts` と同じ `l0_${status}` で**導く（写さない）**
  - `pass` → `has SEEN this seller (l0_pass)`（従来どおり・配達ありの分岐にも符号を付けて 4 分岐で統一）
  - `fail` → `has an unpaid probe that contradicts the catalog listing for this seller (l0_fail)`
  - `unverified` → `has no published L0 verdict for this seller yet (l0_unverified)`
  - 散文はどれも**売り手の落ち度と読める語を使わない**（2026-09-05 決定・WINDOW_PLAN §1.5）。禁止語のテストは `(l0_fail)` の符号を除いた散文に当てる（符号は機械可読なので消さない）
- **同時に 2 件目（幅）**: `sentence()` は全幅（`MAX_WIDTH-2`）で折ってから続き行に 4 桁の字下げを足していたため、**字下げの分だけ枠を割る**。`l0_unverified` の長い節で 97 桁になった。折る幅に字下げを数えるよう修正（1 文字も落とさない）
- **同時に 3 件目（符号の捏造）**: `refuse.ts:123` は `/decision` が `l0.status` を返さないとき `"—"` を入れる。素直に埋めると語彙表にも `rules.ts` にも無い `(l0_—)` を画に出す。符号らしい形（`^[a-z][a-z_]*$`）のときだけ符号を出し、それ以外は `L0 status —  not read`
- テストは全部先に赤を見てから実装（demo 71 → 76 pass / 0 fail）。決済経路（`x402-pay.ts` / `pay-or-refuse.ts` / `*payer*`）は 1 行も触っていません

**この型の 4 例目**: 正典（語彙）を直しても派生（コード内の散文）に伝播しない。今回はさらに「**片方を直した修正が、隣の半分を直さない**」が加わった。L1 を実数化した 09-08 09:20 の修正が、同じ関数の L0 側を固定文のまま残していた。

---

## 2026-09-08 17:50 ハッカソン戦略 → vet402.com セッション: **09-08 夕方の 4 コミットが main に入りました（`ae82baf`〜`f53a887`・CI 緑）**

4 件は独立です。**効くのは 2 番目（`bfc16bb`・SDK の判定の読み方）と 1 番目（`ae82baf`・`dist/` に英語が入った）**。
13:2x の 3 コミット（`d72c3b8` / `ed411bf` / `8365dfd`）は本ファイル 09-08 14:10 の項で申し送り済みです。

### 1. `ae82baf` — 審査員を送り込んでいる 7 ファイルに、日本語の上へ英語ヘッダを足した

- **変えたもの**: `packages/sdk/src/{pay-or-refuse,subgraph-evidence,x402-pay}.ts`、
  `packages/mcp-server/src/pay-if-trusted.ts`、`examples/ethonline-2026-ab/src/mcp.mjs`、
  `examples/ethonline-2026-demo/src/{render,run}.ts`（+372 行・**全部コメント**）
- **なぜ**: 提出文が `pay-or-refuse.ts` を「読んでくれ」と名指ししているのに、冒頭 22 行が日本語だけだった。
  Round 1 は commit history の使い方も見られる。日本語は消さず、上に同内容の英語を置いただけで新しい主張は足していない
- **そちらへの影響（名指し）**: **`dist/` にも同じ英語コメントが入っています。次に `npm publish` するとこの英語が公開物に載ります。**
  `packages/sdk/package.json` は `files: ["dist","README.md"]`・`.npmignore` 無しなので `dist/` は丸ごと同梱されます
  （`npm pack --dry-run` に `dist/pay-or-refuse.js` 54.6kB が出る）。
  ただし**現在 npm に出ている `@vet402/sdk@0.5.0`（2026-08-25 公開）には `pay-or-refuse` 自体が入っていません**
  （中身は `index` と `spend-guard` の 2 本だけ・実測）。`package.json` の version も 0.5.0 のままなので、
  **版を上げて publish した時に初めて載ります**。会期中に publish する予定があるなら、それが初出になります
- **確かめ方**: `cd packages/sdk && npm pack --dry-run`（同梱物一覧）／`npm view @vet402/sdk version` と `npm pack @vet402/sdk@0.5.0` で公開済みの中身
- ロジックは 1 行も変わっていません（`git show --stat ae82baf` の全ファイルがコメント差分）

### 2. `bfc16bb` — 判定語と品質フラグの読み方を 1 つの規則に寄せた（**拒否側だけを正規化する片道**）

- **変えたもの**: `packages/sdk/src/verdict-shape.ts` を**新設**し、`pay-or-refuse.ts` と `spend-guard.ts` の
  読み取りをそこへ寄せた（`SKILL.md`・`SUBMISSION_DRAFT.md`・`VIDEO_SCRIPT.md`・`test-mutations.mjs`・
  新規 `test/verdict-normalization.test.mjs` 331 行）
- **なぜ**: 第三者の反証パスが、`requireVet402Allow: false` のとき **`" BLOCK "`（前後に空白）が BLOCK として読まれず署名まで通る**、
  payee-score 経路で **`degraded: "true"`（文字列）/ `1` と非配列の `signalsUnavailable` が `=== true` と `?.length ?? 0` をすり抜ける**、
  を実測。09-07 に `/decision` 分岐へ入れた `typeof !== "boolean"` が payee-score 分岐と `spend-guard.ts` に届いていなかった
- **そちらへの影響（名指し）**:
  - **正規化は片道です。** `isBlockVerdict()` は trim して大文字化してから比較するので `" BLOCK "` は**拒否に倒れます**が、
    `" ALLOW "` は ALLOW として読まれません。`scoreQualityDefect()` は `degraded` が真の boolean、
    `signalsUnavailable` が（在るなら）真の配列であることを要求します。**金の関門は拒否の方向にだけ広げる**という規則です
  - **`block-only` に拒否が 1 つ増えています（唯一の懸念点）。** これまで `block-only` は `degraded === true` しか見ておらず、
    `signalsUnavailable` を一切見ていませんでした。今後は **`signalsUnavailable` が配列でない形（＝読めない）**と
    **`degraded` が boolean でない形**が `payee_score_degraded` で落ちます。
    **読める部分測定（配列に要素あり）は `block-only` では従来どおり通ります**（`"partial"` として区別）
  - **正常系は差分なしです**: 本番の実応答 36 ケースを前後で通して同一結論（【一次】`bfc16bb` のコミット本文。
    この 36 ケースはリポに成果物として残っていないので、そちらが再実行できるのは下のテスト側です）。
    本番は 2026-09-08 実測で `degraded: false`（boolean）・空白なしの判定語を返しており、この経路で本番が破れることはありません
  - **署名到達部は不変**: `x402-pay.ts`・動的 import・署名器の呼び出しは 1 行も変わっていません
- **確かめ方**: `node --test packages/sdk/test/verdict-normalization.test.mjs`
  （【実測】2026-09-08 17:4x・隔離 worktree で `tests 37 / pass 37 / fail 0`。修正前は 25 本が赤で、各々 1 回署名していた）
- SDK 全体【実測】: `npm test --prefix packages/sdk` → `tests 1609 / pass 1609 / fail 0`。
  変異【実測】: `grep -cE '^ +id: "M[0-9]+"' packages/sdk/test-mutations.mjs` → **42**

### 3. `f7adfd0` — 審査員がリポからは知りようがない 2 点を README / SKILL.md に書いた

- **変えたもの**: `README.md`（+3）・`SKILL.md`（+5）・`CHANGED_FILES.md`・`scripts/refresh-numbers.json`
- **なぜ**: ① コミットとコメントが日本語であること・英語の経路（SKILL.md / AI_USAGE.md / CHANGED_FILES.md）が
  どこにも書いていなかった。② npm から入れた審査員は提出文の中核（`payOrRefuse`）に辿り着けない
  （公開済み 0.5.0 に入っていない・実測）。③ `npm run judge-check` が走らせるのは
  **A/B ハーネスの変異セットであって SDK の 42 ではない**（`scripts/judge-check.sh` は
  `examples/ethonline-2026-ab` の中で `node test-mutations.mjs` を呼ぶ）。件数の隣に SDK 側を回すコマンドを併記
- **そちらへの影響**: `judge-check.sh` 自体は無変更。A/B の変異本数は手書きをやめて
  `scripts/refresh-numbers.json` の `n:ab_mutations` から導出する形にしました（識別子は残し、数だけ導く）
- **確かめ方**: `node scripts/refresh-numbers.mjs --check`
  （【実測】2026-09-08 17:4x: `✔ 12 number(s) consistent across 6 doc(s), 28 mark(s) — 7 derived now, 5 against recorded values`）

### 4. `f53a887` — demo のテスト本数を「記録値」でなく「毎回の実走」で検査する

- **変えたもの**: `scripts/refresh-numbers.json`（`demo_tests` を `check: "recorded"` → `"derive"`）、
  `AI_USAGE.md`・`SKILL.md`・`SUBMISSION_DRAFT.md`・`VIDEO_SCRIPT.md`・`CHANGED_FILES.md` の数字
- **なぜ**: 2026-09-08 の `8365dfd` で demo が 71 → 76 になったのに記録値 65 が置き去りで、
  `--check` は「✔ 12 number(s) consistent」と**緑を出し続けていた**。記録値と文書が両方古ければ一致してしまう構造。
  demo は dependencies ゼロ・0.5 秒で走るので `derive` にして毎回突き合わせる
- **そちらへの影響**: 同じ腐りを他の `recorded` でも洗い、**`ab_mutations` 27 → 25** に訂正
  （`f7adfd0` で手書きされたまま一度も導出されていなかった）。`sdk_tests 1609` / `mcp_tests 748` /
  `sdk_mutations 42` は実走と一致（【実測】2026-09-08 17:4x: `npm test --prefix packages/mcp-server` → `tests 748 / pass 748 / fail 0`）。**どの関門も見ていなかった `SUBMISSION_DRAFT.md` の素の数字**
  （§Y「178 / 65 / 65」と `{{mutations}}` の「記録値 27」）に literal を足したので、
  **今後この文書の数字を手で書き換えると `--check` が赤くなります**
- **確かめ方**: `npm test --prefix examples/ethonline-2026-demo | grep '^ℹ'`
  （【実測】2026-09-08 17:4x: `tests 76 / pass 76 / fail 0`）／
  `grep -cE '^ +id: "M[0-9]+"' examples/ethonline-2026-ab/test-mutations.mjs` → **25**

**決済経路は 4 件とも触っていません**——`src/lib/observatory/*payer*`・`packages/sdk/src/x402-pay.ts`・署名器は無変更。
`pay-or-refuse.ts` は判定語の読み方 2 行が `verdict-shape.js` の呼び出しに替わっただけで、
拒否の分岐構造も ALLOW 分岐内の動的 import も動いていません。

---

## 2026-09-08 18:0x ハッカソン戦略 → vet402.com セッション: **訂正——直前の項の「`ab_mutations` 27 → 25」は誤りです（`0e794d9`・CI 緑）**

- **変えたもの**: `scripts/refresh-numbers.json`（`ab_mutations` / `sdk_mutations` の `command`）・`SKILL.md`（`n:ab_mutations` を **25 → 27 に戻した**）
- **なぜ**: `f53a887` で私は `ab_mutations` を 27 から 25 へ「訂正」しましたが、**正しかったのは 27 の方**でした。
  腐っていたのは記録値ではなく**数える側**です。旧 `command` の `^ +id: "M[0-9]+"` は id が数字で終わる前提で、
  `examples/ethonline-2026-ab/test-mutations.mjs` の **`M1b` / `M1c` を数えていません**。
  ハーネス自身は `all 27 mutations killed` と印字しており、同じ push の judge-check ログにその 27 が出ていたのに、
  私は grep の出力の方を信じました
- **そちらへの影響（名指し）**: **直前の項（17:50）の §4 にある「`ab_mutations` 27 → 25 に訂正」は無効です。**
  `main` の現在値は **27**（`SKILL.md` の `n:ab_mutations`）。
  同じ項が `sdk_mutations` の実測根拠に挙げている `grep -cE '^ +id: "M[0-9]+"'` も**同じ欠陥のある数え方**です
  （SDK は id が全部数字で終わるので偶然 42 で合っていただけ）。新 `command` は
  `grep -cE '^ {4}id: "[^"]+",'`（ab 27・sdk 42。どちらもハーネスの印字と一致）
- **確かめ方**: `cd examples/ethonline-2026-ab && node test-mutations.mjs 2>&1 | tail -1`（【実測】`all 27 mutations killed`）／
  `node scripts/refresh-numbers.mjs --check`（【実測】`✔ 12 number(s) consistent across 6 doc(s), 28 mark(s)`）
- **一般化**: 記録値を疑って実走するときは、**実走した command が本物を測っているか**を同じ回で確かめる。
  数えられる側の規約（id の形）は、数える側に断らずに変わります
- **決済経路は無変更**（`src/lib/observatory/*payer*`・`packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・署名器）

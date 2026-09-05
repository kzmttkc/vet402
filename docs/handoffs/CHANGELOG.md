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

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

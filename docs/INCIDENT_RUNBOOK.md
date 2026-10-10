# vet402 インシデント runbook

事故の最中に読む文書。**最初の 1 コマンドだけを大きく書く。** 背景や設計の理由は
各リンク先が持つ。

前提: `$ADMIN_SECRET` は Vercel の sensitive env（`vercel env pull` では読めない）。
手元に控えが無ければ Vercel ダッシュボードの Environment Variables から取る。
本番の origin は `https://vet402.com`。

---

## 1. 不正な支出を見つけたら（L1 実購入を今すぐ止める）

```bash
curl -sS -X POST https://vet402.com/api/admin/spending-halt \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"enabled":true,"reason":"WHY — 例: unexpected payout to 0xdead","by":"takeshi"}'
```

`{"ok":true,"enabled":true,...}` が返れば止まっている。

**到達時間**: `runtime_flags` への UPDATE 1 文なので**即時**。効き始めるのは
**次の署名から**——走行中のバッチは、次の購入に入る前と、予約の後・署名の直前の
2 箇所でこのフラグを読み直す。すでに署名済みの 1 件（EIP-3009 の authorization は
`validBefore` まで生きた金）は止まらない。1 件 $1・日次上限 $25 が最大の露出。

止まる範囲は L1 実購入の全経路（Vercel cron `/api/cron/l1-purchase`・管理リポ
launchd の `vet402_l1_extra.py` / `vet402_l1_canary.py`・`/api/v1/demo/verify`
`level=l1`）。どれも同じ `runL1Batch` を通るため、入口を数える必要はない。

### 止まったことの確認

```bash
curl -sS https://vet402.com/api/admin/spending-halt -H "Authorization: Bearer $ADMIN_SECRET"
curl -sS "https://vet402.com/api/health?deep=1" -H "Authorization: Bearer $ADMIN_SECRET" | grep -o '"spending_halt":"[a-z]*"'
```

deep health の `spending_halt` は `halted` / `off` / `unknown`。停止は**障害ではない**
ので `degraded` にはしない（「L1 が 1 件も買っていない」を調べる人が最初に見る場所）。

### 直近に何が起きたかを見る

```sql
SELECT attempted_at, status, spent_units, amount_units, pay_to, tx_hash
FROM x402_l1_purchases ORDER BY attempted_at DESC LIMIT 20;
```

停止で落ちた行は `status='halted'` / `spent_units='0'`（署名していない）。
`in_flight` が残っていれば「予約は書かれたが結果が書かれなかった」——30 分後の
孤児掃除が拾うが、金が動いた可能性のある行なので個別に照合する。

### 再開

```bash
curl -sS -X POST https://vet402.com/api/admin/spending-halt \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"enabled":false,"reason":"照合完了・原因は◯◯","by":"takeshi"}'
```

再開の前に確認すること: 台帳に説明のつかない `settled` / `in_flight` が無いこと、
ウォレット残高が台帳の合計と合うこと、原因が塞がっている（塞がっていないなら
止めたまま直す）こと。`reason` は必須——なぜ戻したかが行に残る（`updated_at` /
`updated_by` / `reason` がそのまま履歴）。

### 第二手段（第一手段が使えないときだけ）

Vercel env `OBSERVATORY_L1_ENABLED` を `false` にして**再デプロイ**する。
これは第二手段である。理由は 2 つ:

- 再デプロイが完了するまで、既存の関数インスタンスは古い env で署名できる（数分の窓）。
- 管理リポ launchd の起動は本番 API を叩くので、デプロイの進行と競合する。

DB が読めない状況では、停止スイッチ自身が **halted 側に倒れる**（`kill-switch.ts` の
fail-closed: 表・行が無ければ通す＝未導入は現状維持、DB へ届かなければ止める）ので、
「DB 障害中に env で止める」必要は原則として無い。

関連: `src/lib/observatory/kill-switch.ts`（判定）・
`src/app/api/admin/spending-halt/route.ts`（切り替え口）・
`scripts/sql/2026-09-05-runtime-flags.sql`（DDL）。

---

## 2. 鍵が漏れた疑い（`OBSERVATORY_WALLET_PRIVATE_KEY` / `REGISTRY_OPERATOR_PRIVATE_KEY`）

**最初の 1 手**: 上の §1 で支出を止める（署名を作る側を先に黙らせる）。
そのうえで残高を新しいアドレスへ退避し、Vercel env の鍵を差し替えて再デプロイする。
鍵ごとの一覧と手順は §7。

**順番を守る**（鍵の再発行は、漏れた経路を塞いだ実測の後）: ① §1 で止める →
② 漏れた経路（ログ・リポ・共有した端末・CI の出力）を特定して塞ぐ → ③ 新しい鍵を
作る → ④ 残高を新アドレスへ移す → ⑤ Vercel env を差し替えて再デプロイ →
⑥ 旧アドレスの残高 0 と、新アドレスでの 1 件目の署名を実測 → ⑦ §1 の再開。

## 3. DB 障害（Neon が応答しない / 台帳が読めない）

**最初の 1 手**: `curl -sS "https://vet402.com/api/health?deep=1" -H "Authorization: Bearer $ADMIN_SECRET"`
で `checks.database` を見る。L1 は台帳が読めない時点で自動的に停止側へ倒れる
（予約 SQL が verdict を返せなければ購入しない）ので、支出を追加で止める操作は要らない。

## 4. 障害 issue を閉じるとき（可用性の記録・2026-09-05 CIA 監査）

`.github/workflows/uptime.yml` は `/api/health` の失敗で issue を開き、復旧で自動クローズする。
**復旧しても、原因を書かずに閉じない。** 2026-08-18 / 08-21 / 08-27 の 3 件（合計 13 時間・最長 10 時間 36 分）は
「503 degraded」の一行しか残らず、事後に原因を辿れなくなった（Vercel Hobby のログは保持が短い）。

閉じる前に、issue へコメントで **3 行**を書く（5 分以内・分からなければ「未特定」と書く）:

1. **何が落ちたか**: `curl -s -H "Authorization: Bearer $ADMIN_SECRET" "https://vet402.com/api/health?deep=1"` の `checks` で `ok` でないキー（例: `database` / `rpc` / `settlements_index`）。復旧後なら「復旧時点で全 ok・障害中の値は未取得」と書く。
2. **なぜ落ちたか（一次データの所在）**: Neon の容量／RPC の 429／Vercel のビルド失敗／cron の無音死 など。証拠の URL かログのパス。分からなければ「未特定」。
3. **再発を止めるもの**: 入れた計器・変更した閾値・手番に回した項目の名前。無ければ「無し」。

このコメントが無い issue は閉じない。次回の監査（`docs/audits/`）はこの 3 行を可用性の一次データとして読む。

---

## 5. 本番デプロイを直前の正常版へ戻す（Vercel ロールバック・2026-09-28 監査）

本番は Vercel プロジェクト `agent-trust`（`~/vouch/.vercel/repo.json`）。main への push が
そのまま本番デプロイになる。**戻すのはコードだけ**——DB・env・runtime_flags は戻らない
（DB は §6、支出は §1）。

**最初の 1 手**（直前の本番デプロイへ即時に戻す。ビルドは走らない）:

```bash
cd ~/vouch && npx vercel rollback --yes
```

特定の版へ戻すときは、正常だった版の URL を選んで渡す:

```bash
npx vercel ls agent-trust --prod            # 本番デプロイの一覧（新しい順）。Status=Ready と Age を見る
npx vercel inspect <deployment-url>          # その版の commit を確かめる
npx vercel rollback <deployment-url> --yes
```

チーム配下なら全コマンドに `--scope <team>` を付ける【要確認: 付けずに通るか】。
Hobby プランで戻せるのは直前の本番 1 つだけ【要確認: 現在のプランと制限】。それより前へ
戻すなら、正常だった状態へ `git revert` して push する（履歴を書き換えない）。

### 戻ったことの確認

```bash
curl -sSL -o /dev/null -w "%{http_code}\n" https://vet402.com/
curl -sSL "https://vet402.com/api/health?deep=1" -H "Authorization: Bearer $ADMIN_SECRET"
npx vercel ls agent-trust --prod | head -5     # 本番の別名が戻した版を指していること
```

`checks` が全て `ok`、壊れていた症状を 1 つ選び、同じ curl で再現しないことを確かめる。

### 戻したあとに必ずやること

- **ロールバック中は、main への push が本番へ自動で出ない**【要確認: Vercel の
  Instant Rollback は本番ドメインの自動割り当てを止める】。直した版を出すときは
  `npx vercel promote <deployment-url> --yes` で明示的に昇格する（またはダッシュボードの
  「Undo Rollback」）。忘れると、以後の修正が本番に出ないまま「直した」と思い込む。
- 戻した版が **DB の列を前提にしているか**を確かめる。列追加のマイグレーションは
  コードより先に当てる（§6）ので、コードだけ古い版に戻しても通常は壊れない。
  逆（新しいコードが、まだ当てていない列を読む）は 500 になる。
- cron（`vercel.json`）の定義も版と一緒に戻る。戻した版に無い cron は止まる。

---

## 6. DB 変更の戻し方（Neon・2026-09-28 監査）

本番 DB は Neon 上の `vouch`（以下の例の分岐名 `main` は【要確認: 本番の分岐名】）。マイグレーションは `scripts/sql/YYYY-MM-DD-*.sql` を
**人が psql で当てる**（冪等・`IF NOT EXISTS`）。自動のマイグレーション実行は無い。
**列を足す SQL は、その列を読むコードを出す前に当てる。**

### 6.1 列追加マイグレーションを戻す

列追加は破壊的でないので、**まずコードを戻す（§5）だけで足りることが多い**。
古いコードは新しい列を読まない。列そのものを消すのは、コードを戻したことを確かめた後、
その列を読む版を二度と出さないと決めたときだけ。

各 SQL ファイルの冒頭コメントに戻し方を書く。例（`scripts/sql/2026-09-28-record-subscription-optin.sql`）:

```bash
psql "$DATABASE_URL" <<'SQL'
BEGIN;
DROP INDEX IF EXISTS record_subscriptions_confirm_token_hash_idx;
ALTER TABLE record_subscriptions
  DROP COLUMN IF EXISTS confirm_token_hash,
  DROP COLUMN IF EXISTS confirm_sent_at,
  DROP COLUMN IF EXISTS confirmed_at,
  DROP COLUMN IF EXISTS unsubscribed_at;
COMMIT;
SQL
```

注意: `DROP COLUMN` は列の値ごと消す（戻せない）。消す前に §6.2 の分岐を 1 本作っておく。
この例では、確定済みの購読の記録（誰がいつ確認したか）が消える。

### 6.2 データが壊れたとき（Neon の分岐と巻き戻し）

**最初の 1 手**: 壊れる前の時点から、調査用の分岐を作る（本番に触らない）。

```bash
npx neonctl branches create --project-id <project-id> \
  --name incident-$(date -u +%Y%m%d-%H%M) \
  --parent "main@2026-09-28T09:00:00Z"   # 壊れる前の UTC 時刻【要確認: 時刻指定の構文は neonctl branches create --help】
npx neonctl connection-string incident-YYYYMMDD-HHMM --project-id <project-id> --database-name vouch
```

その分岐に psql でつなぎ、壊れた行を本番と突き合わせる。**部分的な修復**（壊れた
表・行だけ）は、この分岐から `pg_dump -t <table> --data-only` で取り出し、本番へ
トランザクションで戻す。L1 台帳（`x402_l1_purchases` 等）は金の記録なので、戻す前に
§1 で支出を止め、オンチェーンの tx と行を 1 件ずつ照合する。

**全体を巻き戻す**（最後の手段。指定時刻より後の書き込みが全部消える）:

```bash
npx neonctl branches restore main "^self@2026-09-28T09:00:00Z" \
  --project-id <project-id> --preserve-under-name main_before_restore_$(date -u +%Y%m%d)
```

`--preserve-under-name` で巻き戻し前の状態を別名の分岐に残す（後から、失った行を拾える）。
巻き戻しの前後で §1 の停止・再開を挟む。巻き戻しの間は接続が切れる。

- **巻き戻せる期間（history retention）**: 【要確認】。Neon のプランとプロジェクト設定で
  決まる。事故に気づくのが保持期間より遅ければ、この手段は無い。
  確認先: Neon コンソールの Project settings（または `npx neonctl projects get <project-id>`
  の history retention の値）。
- 巻き戻しで `DATABASE_URL` の接続先が変わるか【要確認】。変わったら Vercel env を
  差し替えて再デプロイする。
- pg テストは `*.neon.tech` を拒否する（`tests/helpers/pg-test-guard.ts`）。調査用の
  分岐にテストを向けない（テストは TRUNCATE から始まる）。

---

## 7. 署名鍵・秘密の一覧と、漏えい時の退避（2026-09-28 監査）

値はここに書かない。置き場は Vercel env（本番）か、持ち主の端末のシェルだけ。
「Vercel」列が × のものはアプリが読まない（手元のスクリプト専用）ので、Vercel に置かない。

### 7.1 資金を動かす鍵（漏れたら最優先）

| env 名 | チェーン | 用途（読む場所） | Vercel |
|---|---|---|---|
| `OBSERVATORY_WALLET_PRIVATE_KEY` | Base (eip155:8453)・Arc (eip155:5042)・Celo (eip155:42220)・Tempo (MPP) の**同じ EOA** | L1 実購入（`src/lib/observatory/l1-runner.ts`・`mpp-payer.ts`） | ○ |
| `OBSERVATORY_SOLANA_SECRET_KEY` | Solana | L1 実購入（`l1-runner.ts` の `loadSolanaKeypair`） | ○ |
| `OBSERVATORY_XRPL_SEED` | XRPL (xrpl:0) | L1 実購入・RLUSD（`src/lib/observatory/xrpl402-payer.ts`） | ○ |
| `REGISTRY_OPERATOR_PRIVATE_KEY` | Base | ERC-8004 Validation Registry への書き込み（`src/lib/chain/registry-hook.ts`）。購入用とは別鍵 | ○ |
| `TOKYO_OPERATOR_PRIVATE_KEY` | Sepolia（テストネット） | /tokyo の審査ボタン W_op（`src/app/api/tokyo/_lib/env.ts`） | ○ |
| `VOUCH_PAYER_PRIVATE_KEY` / `VOUCH_SOLANA_PAYER_SECRET_KEY` | EVM / Solana | MCP `pay_if_trusted`・SDK `payOrRefuse` の支払い側（利用者の端末） | × |
| `RWA_ANCHOR_KEY` / `PAYER_PRIVATE_KEY` | Robinhood Chain (4663 / 46630) | `/rwa` のアンカー 1 回・手動支払い 1 回（`packages/rwa/scripts/`） | × |
| `DEMO_PAYER_PRIVATE_KEY` | EVM | `examples/ethonline-2026-demo` | × |
| `TOKYO_W_PAY_PRIVATE_KEY` / `TOKYO_K_ATST_PRIVATE_KEY` / `W_ENS_PRIVATE_KEY`（名前は `TOKYO_SELLER_OWNER_KEY_ENV` で差し替え可） | Sepolia | `examples/tokyo-2026-demo` | × |

`src/lib/chain/solana-attest.ts`（`SOLANA_ATTEST_ENABLED`）は鍵を env から読まず、
呼び手から Keypair を受け取る。2026-09-28 時点で呼び手は無い（配線したら表に足す）。

**退避の手順（上の表の ○ の鍵）**

1. §1 で支出を止める（Base・Arc・Celo・Tempo・Solana・XRPL の L1 は同じ停止で全部止まる）。
   Registry 書き込みは Vercel env `REGISTRY_WRITES_ENABLED=false` → 再デプロイ。
   Tokyo ボタンは DB の `runtime_flags.tokyo_button_halt` を立てる。
2. 新しい鍵を**持ち主の端末で**作る（エージェントに作らせない・値をチャットや
   ログに出さない）。EVM は `cast wallet new`、Solana は `solana-keygen new`、
   XRPL は新しい family seed。
3. 旧アドレスの残高を新アドレスへ移す。EVM の EOA は Base・Arc・Celo・Tempo で**同じ
   アドレス**なので、4 チェーン全部の USDC / USDC.e / ガス（Arc はガスも USDC。Celo は
   購入にガスが要らないので CELO を置いていない。移すときはガスを先に用意する）を移す。XRPL は RLUSD を移し、新アカウントに RLUSD のトラストラインを張る
   （`scripts/xrpl-trustline.ts`）。旧アカウントの準備金は `AccountDelete` まで戻らない。
4. Vercel env を差し替え（Production・Sensitive）→ 再デプロイ →
   `api/health?deep=1` で payer 残高が新アドレスの値を指すことを確かめる。
5. 旧アドレスを前提にした設定（`OBSERVATORY_TEST_WALLETS`、自社 payTo の除外リスト、
   台帳の `payer` 列を見る集計）を grep し、新アドレスを足す。
6. §1 の再開。1 件目の署名が新アドレスから出たことを台帳の `payer` で実測する。

### 7.2 資金を直接は動かさない秘密

| env 名 | 漏れたら何ができるか | 差し替えの注意 |
|---|---|---|
| `ADMIN_SECRET` | 支出停止の解除・管理 API | 差し替え → 再デプロイ。管理リポ launchd 側の控えも更新 |
| `CRON_SECRET` | cron の手動起動（L1 購入 cron を含む） | 同上。Vercel cron は env から自動で読む |
| `API_KEY_PEPPER` | API キーのハッシュの鍵・webhook 秘密の KEK（`WEBHOOK_SECRET_KEK` 未設定時）・通知メールの配信停止トークンの鍵 | **差し替えると既存の API キーと配信停止リンクが全部無効**。先に `WEBHOOK_SECRET_KEK` / `_PREVIOUS` で webhook 秘密を包み直す |
| `WEBHOOK_SECRET_KEK` / `WEBHOOK_SECRET_KEK_PREVIOUS` | 保存済み webhook 署名秘密の復号 | 新 KEK を `WEBHOOK_SECRET_KEK`、旧を `_PREVIOUS` に置いて再封 → 旧を消す |
| `DASHBOARD_SESSION_SECRET` | ダッシュボードのセッション偽造 | 差し替えると全員ログアウト |
| `RESEND_API_KEY` | vet402 名義のメール送信 | Resend で失効 → 再発行 |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | 課金操作・webhook 偽造 | Stripe ダッシュボードで roll |
| `GRAPH_API_KEY` / `ALCHEMY_API_KEY` / `BLOCKSCOUT_API_KEY` | 従量課金の消費 | 各サービスで失効 → 再発行 |
| `DATABASE_URL` | 台帳の読み書き全部 | Neon でロールのパスワードを reset → Vercel env 差し替え → 再デプロイ |

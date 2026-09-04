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

## 3. DB 障害（Neon が応答しない / 台帳が読めない）

**最初の 1 手**: `curl -sS "https://vet402.com/api/health?deep=1" -H "Authorization: Bearer $ADMIN_SECRET"`
で `checks.database` を見る。L1 は台帳が読めない時点で自動的に停止側へ倒れる
（予約 SQL が verdict を返せなければ購入しない）ので、支出を追加で止める操作は要らない。

# api_keys.owner_relation の付け方

判定 API の月次の公開表は、鍵そのもの・メールアドレス・名前・鍵 1 本の件数を出さない。出すのは、締まった月について、鍵ありの判定を区分（`self` / `related` / `external` / 未分類）ごとに足した持ち主の人数である。`self` / `related` / `external` は件数の合計も出す。持ち主が 3 人未満の区分は人数を `<3` だけにして、件数は出さない。未分類は件数を出さない。人数も 3 人未満なら `<3` である。

公開するのは今の UTC の月より前だけ。月が締まって 3 日たったあと（翌月 3 日 00:00 UTC 以降）の最初の読み取りで `decision_usage_monthly_published` に一度書き、以後はその表だけを読む。それより前の読み取りは 400 で、区分を付ける猶予は締まった翌月の 1 日と 2 日である。固定のあとに `owner_relation` を変えても、公開済みの月は動かない。

鍵なしの呼び出しはチェーンごとに数えないので、この表には出さない。

値は運用者が手で付ける。メールアドレスや名前から推測して埋めない。付けない鍵は NULL（未分類）のままにする。未分類は公開表の external の合計に入らない。

| 値 | 意味 |
| --- | --- |
| `self` | vet402 自身の鍵 |
| `related` | vet402 と関係のある人の鍵 |
| `external` | vet402 と無関係な人の鍵 |
| NULL | まだ分類していない |

## 手順

1. 本番の DB（Neon の **vouch**。neondb ではない）へ、秘密の入った接続で入る。公開の URL からは更新できない。
2. 分類する鍵の `api_keys.id` を、手元の台帳（発行時の記録）で特定する。公開表からは id へ戻れない。
3. 人が関係を判断してから、次の 1 文で書く。`<api_keys.id>` は手順 2 の uuid に置き換える。

```sql
UPDATE api_keys
SET owner_relation = 'external'
WHERE id = '<api_keys.id>'::uuid;
```

`self` と `related` も同じ文で、右辺だけ変える。未分類に戻すときは `SET owner_relation = NULL`。

4. 制約は `self` / `related` / `external` / NULL だけを許す。それ以外は UPDATE が失敗する。
5. 確認:

```sql
SELECT owner_relation, count(*) FROM api_keys GROUP BY 1 ORDER BY 1;
```

6. 公開の件数は次で読む。鍵は出ない。ページに固定の数字は無い。引けるチェーンは公開一覧だけ（いまは `eip155:42220`）。

- JSON: `/api/v1/usage/monthly?chain=eip155:42220&month=YYYY-MM`
- 人が読むページ: `/usage/monthly?chain=eip155:42220&month=YYYY-MM`

## 鍵ごとの内訳（公開しない）

公開の URL には出さない。運用者が本番の vouch DB で手で読む。結果には鍵 id・メール・名前が出る。`__CHAIN__`・`__MONTH_START__`・`__MONTH_END__` を置き換えてから流す。月の終わりは翌月の 1 日。

```sql
SELECT d.day::text AS day,
       d.api_key_id::text AS api_key_id,
       k.user_id::text AS user_id,
       a.email,
       k.name,
       COALESCE(k.owner_relation, d.relation_snapshot) AS owner_relation,
       d.chain,
       d.count::int AS count
FROM decision_usage_daily d
LEFT JOIN api_keys k ON k.id = d.api_key_id
LEFT JOIN accounts a ON a.id = k.user_id
WHERE d.chain = '__CHAIN__'
  AND d.day >= DATE '__MONTH_START__'
  AND d.day < DATE '__MONTH_END__'
ORDER BY d.day, d.api_key_id;
```

消した鍵は `api_keys` に無い。区分は `relation_snapshot` に残る。アカウントを消す手順は `docs/operations/account-deletion.md`。

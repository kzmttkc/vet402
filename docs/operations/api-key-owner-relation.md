# api_keys.owner_relation の付け方

判定 API の月次の公開表は、鍵そのもの・メールアドレス・名前を出さない。鍵ありの行は `key-1` のような番号と、この列の値だけを出す。

値は運用者が手で付ける。メールアドレスや名前から推測して埋めない。付けない鍵は NULL（未分類）のままにする。未分類は公開表の external の合計に入らない。

| 値 | 意味 |
| --- | --- |
| `self` | vet402 自身の鍵 |
| `related` | vet402 と関係のある人の鍵 |
| `external` | vet402 と無関係な人の鍵 |
| NULL | まだ分類していない |

## 手順

1. 本番の DB（Neon の **vouch**。neondb ではない）へ、秘密の入った接続で入る。公開の URL からは更新できない。
2. 分類する鍵の `api_keys.id` を、手元の台帳（発行時の記録）で特定する。公開表の `key-N` からは id へ戻れない。
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

6. 公開の件数は次で読む。鍵は出ない。`external_calls` は `owner_relation = 'external'` の合計で、ページに固定の数字は無い。

- JSON: `/api/v1/usage/monthly?chain=eip155:42220&month=YYYY-MM`
- 人が読むページ: `/usage/monthly?chain=eip155:42220&month=YYYY-MM`

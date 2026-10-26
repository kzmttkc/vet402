# アカウントや鍵を消すとき

画面に削除のボタンは無い。本人がサポートのメールで頼んだあと、運用者が本番の **vouch** DB（neondb ではない）で手で消す。

`decision_usage_daily` の件数は数字として残す。鍵の行を消す前に、その時点の `owner_relation` を `relation_snapshot` へ写し、`api_key_id` をその鍵だけの新しい uuid に替える。新しい uuid は `api_keys` に無い。消したあとに `owner_relation` を変えても、過去の月の区分は動かない。公開の本数も、その鍵の分は残る。

1 つの固定 uuid に全部を寄せない。主キーは `(day, api_key_id, chain)` なので、同じ日・同じチェーンの行がぶつかり、公開の本数も 1 に潰れる。区分を残しても、external の本数が減る。鍵ごとに新しい uuid を使う。

鍵の行を先に消すと、区分を読めなくなる。必ず先にこの UPDATE を流す。

失効（`revoked_at`）は削除ではない。ここでは何もしない。

## アカウント

そのアカウントの `user_id` を持つ鍵を、まとめて切り離す。`__ACCOUNT_ID__` を `accounts.id` に置き換えてから流す。`user_id` が NULL の鍵は入らない。

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';

WITH doomed AS (
  SELECT id, owner_relation
  FROM api_keys
  WHERE user_id = '__ACCOUNT_ID__'::uuid
),
assigned AS (
  SELECT id AS old_id, owner_relation, gen_random_uuid() AS new_id
  FROM doomed
)
UPDATE decision_usage_daily AS d
SET api_key_id = assigned.new_id,
    relation_snapshot = assigned.owner_relation
FROM assigned
WHERE d.api_key_id = assigned.old_id;

COMMIT;
```

## 鍵 1 本

`__API_KEY_ID__` を `api_keys.id` に置き換えてから流す。

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';

WITH doomed AS (
  SELECT id, owner_relation
  FROM api_keys
  WHERE id = '__API_KEY_ID__'::uuid
),
assigned AS (
  SELECT id AS old_id, owner_relation, gen_random_uuid() AS new_id
  FROM doomed
)
UPDATE decision_usage_daily AS d
SET api_key_id = assigned.new_id,
    relation_snapshot = assigned.owner_relation
FROM assigned
WHERE d.api_key_id = assigned.old_id;

COMMIT;
```

## そのあと

使い方の行が鍵を指さなくなったら、鍵とアカウントの行を消す。`api_usage` など、ほかの表に残る鍵 id は、このファイルの対象外。件数の表だけ先に切り離す。

区分の付け方と、公開しない鍵ごとの SELECT は `docs/operations/api-key-owner-relation.md`。

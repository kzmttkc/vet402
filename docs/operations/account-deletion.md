# アカウントや鍵を消すとき

画面に削除のボタンは無い。本人がサポートのメールで頼んだあと、運用者が本番の **vouch** DB（neondb ではない）で手で消す。

`decision_usage_daily` の件数は数字として残す。鍵の行を消す前に、その時点の `owner_relation` を `relation_snapshot` へ写し、`api_key_id` をその鍵だけの新しい uuid に替える。新しい uuid は `api_keys` に無い。消したあとに `owner_relation` を変えても、日次の行の区分は動かない。公開表がまだ固定されていない月では、持ち主を `owner_snapshot`（無ければ置き換えた uuid）で 1 人として数える。固定済みの月は `decision_usage_monthly_published` のまま動かない。`api_usage` はこの手順では書き換えない。

鍵 id は鍵ごとに新しい uuid にする。1 つに寄せると主キー `(day, api_key_id, chain)` がぶつかる。人数は鍵 id ではなく `owner_snapshot` で数える。

鍵の行を先に消すと、区分を読めなくなる。必ず先にこの UPDATE を流す。

失効（`revoked_at`）は削除ではない。ここでは何もしない。

## アカウント

そのアカウントの `user_id` を持つ鍵を、まとめて切り離す。`__ACCOUNT_ID__` を `accounts.id` に置き換えてから流す。`user_id` が NULL の鍵は入らない。

鍵ごとに新しい uuid を付け、そのアカウントの行は全部、1 つの新しい持ち主の uuid（`owner_snapshot`）にそろえる。鍵を 3 本持っていた 1 人は、消したあとも 1 人と数える。前に「鍵 1 本」で切り離した行（`owner_snapshot` がこのアカウントの id）も、同じ新しい uuid に替える。アカウントの id は残らない。

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TEMP TABLE deletion_owner ON COMMIT DROP AS SELECT gen_random_uuid() AS owner_id;

WITH doomed AS (
  SELECT id, owner_relation
  FROM api_keys
  WHERE user_id = '__ACCOUNT_ID__'::uuid
),
assigned AS MATERIALIZED (
  SELECT id AS old_id, owner_relation, gen_random_uuid() AS new_id
  FROM doomed
)
UPDATE decision_usage_daily AS d
SET api_key_id = assigned.new_id,
    relation_snapshot = assigned.owner_relation,
    owner_snapshot = (SELECT owner_id FROM deletion_owner)
FROM assigned
WHERE d.api_key_id = assigned.old_id;

UPDATE decision_usage_daily
SET owner_snapshot = (SELECT owner_id FROM deletion_owner)
WHERE owner_snapshot = '__ACCOUNT_ID__'::uuid;

COMMIT;
```

## 鍵 1 本

`__API_KEY_ID__` を `api_keys.id` に置き換えてから流す。アカウントは残るので、持ち主は `owner_snapshot` にそのアカウントの id を残す（あとでアカウントを消すと、上の手順が新しい uuid に替える）。アカウントの無い鍵は `owner_snapshot` が NULL のままで、置き換えた鍵 id を 1 人と数える。

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';

WITH doomed AS (
  SELECT id, owner_relation, user_id
  FROM api_keys
  WHERE id = '__API_KEY_ID__'::uuid
),
assigned AS MATERIALIZED (
  SELECT id AS old_id, owner_relation, user_id, gen_random_uuid() AS new_id
  FROM doomed
)
UPDATE decision_usage_daily AS d
SET api_key_id = assigned.new_id,
    relation_snapshot = assigned.owner_relation,
    owner_snapshot = assigned.user_id
FROM assigned
WHERE d.api_key_id = assigned.old_id;

COMMIT;
```

## そのあと

使い方の行が鍵を指さなくなったら、鍵とアカウントの行を消す。`api_usage` など、ほかの表に残る鍵 id は、このファイルの対象外。件数の表だけ先に切り離す。

区分の付け方と、公開しない鍵ごとの SELECT は `docs/operations/api-key-owner-relation.md`。

# api_keys.owner_relation の付け方

判定 API の月次の公開表は、鍵そのもの・メールアドレス・名前・鍵 1 本の件数を出さない。出すのは、締まった月について、鍵ありの判定を区分（`self` / `related` / `external` / `prezenti_grantee` / 未分類）ごとに足した持ち主の人数である。`self` / `related` / `external` / `prezenti_grantee` は件数の合計も出す。持ち主が 3 人未満の区分は人数を `<3` だけにして、件数は出さない。未分類は件数を出さない。人数も 3 人未満なら `<3` である。

公開するのは今の UTC の月より前だけ。月が締まって 3 日たったあと（翌月 3 日 00:00 UTC 以降）の最初の読み取りで `decision_usage_monthly_published` に一度書き、以後はその表だけを読む。それより前の読み取りは 400 で、区分を付ける猶予は締まった翌月の 1 日と 2 日である。固定のあとに `owner_relation` を変えても、公開済みの月は動かない。

鍵なしの呼び出しはチェーンごとに数えないので、この表には出さない。

値は運用者が手で付ける。メールアドレスや名前から推測して埋めない。付けない鍵は NULL（未分類）のままにする。未分類は公開表の external の合計に入らない。

`external` を付けるのは、vet402 と無関係な別の人や組織だと、登録のメール以外の事実（会社・公開のリポ・やり取り）で確かめられたときだけにする。1 人が別のアカウントを作って external を 3 人にそろえると、ほかの 1 人の件数が差し引きで読める（3 人の下限の限界。2026-10-26 レビューで受け入れた残りの危険）。確かめられない持ち主は未分類のままにする。

公開済みの行（`decision_usage_monthly_published`）は消さない・作り直さない。区分を付け忘れた月を作り直すと、前と後の差で付け替えた鍵の件数が読める。付け忘れは翌月の公開で直す。

| 値 | 意味 |
| --- | --- |
| `self` | vet402 自身の鍵 |
| `related` | vet402 と関係のある人の鍵 |
| `external` | vet402 と無関係な人の鍵 |
| `prezenti_grantee` | Prezenti（Celo のビルダー支援）の採択者だと、下の証拠で確かめた人の鍵（2026-10-28） |
| NULL | まだ分類していない |

`prezenti_grantee` は external の一種だが、別の行に数える。`prezenti_grantee` の鍵は `external` の行に入らない。区分は鍵ごとに数えるので、1 つのアカウントに区分の違う鍵があると、その持ち主は両方の行に 1 人ずつ数えられる（仕組みでは止めていない。下の手順 3 で防ぐ）。3 人未満は `<3` で件数を出さない、は他の区分と同じ。`scripts/sql/2026-10-28-owner-relation-prezenti-grantee.sql` を本番に流す前は、この値は CHECK で入らない。

## `prezenti_grantee` の証拠

Prezenti の公式の採択者一覧は無い（2026-10-27 に Celo Forum を検索）。印は、登録のメール以外の公開の記録で、鍵の持ち主（アカウント・会社・公開のリポ）がその記録の採択者と同じだと人が確かめたときだけ付ける。証拠の種類は次の 3 つ。

| 証拠の種類 | URL | 何が書いてあるか |
| --- | --- | --- |
| Season 3 AI Builder の採択の公開記録 | https://forum.celo.org/t/meet-the-prezenti-season-3-ai-builder-sponsorship-cohort/13912 | 本文に、AI Builder の 5 人の正式な公開記録とある |
| 採択者本人の名乗り（Frontier） | https://forum.celo.org/t/abapay-payment-rails-for-ai-agents-to-pay-real-bills-on-celo-x402-mcp-a2a/13936 | 投稿者が Frontier の採択を自分で名乗っている |
| Prezenti の pledge のサイト | https://pledge.prezenti.xyz/#/trial | Prezenti 側のサイト（JavaScript で描く。2026-10-28 に curl では中身を読めなかった）。付ける日にブラウザで開き、持ち主が載っていることを人が確かめる |

付けないとき: 名前やメールのドメインが似ているだけ、上のどの記録とも持ち主を結べない、本人が採択を名乗っているが Prezenti 側の記録と食い違う。迷ったら未分類（NULL）のままにする。名前で寄せて埋めない。

採択者の Prezenti での名前・プロジェクト名は公開表に出ない。台帳（手順 2）にだけ、付けた日・鍵 id・使った証拠の URL を残す。

## 手順

1. 本番の DB（Neon の **vouch**。neondb ではない）へ、秘密の入った接続で入る。公開の URL からは更新できない。
2. 分類する鍵の `api_keys.id` を、手元の台帳（発行時の記録）で特定する。公開表からは id へ戻れない。
3. 人が関係を判断してから、次の 1 文で書く。`<api_keys.id>` は手順 2 の uuid に置き換える。`prezenti_grantee` は、上の証拠のどれかで持ち主を確かめ、その URL を台帳に書いてから付ける。同じアカウント（`api_keys.user_id`）の鍵は全部同じ区分にする（付ける前に `SELECT id, owner_relation FROM api_keys WHERE user_id = (SELECT user_id FROM api_keys WHERE id = '<api_keys.id>'::uuid);` で同じアカウントの鍵を見て、全部に同じ値を付ける）。

```sql
UPDATE api_keys
SET owner_relation = 'external'
WHERE id = '<api_keys.id>'::uuid;
```

`self`・`related`・`prezenti_grantee` も同じ文で、右辺だけ変える。未分類に戻すときは `SET owner_relation = NULL`。

4. 制約は `self` / `related` / `external` / `prezenti_grantee` / NULL だけを許す（`prezenti_grantee` は 2026-10-28 の SQL を流したあと）。それ以外は UPDATE が失敗する。
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

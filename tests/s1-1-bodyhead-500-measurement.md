# S1-1: bodyHead が 500 字を超える settled 400/422 行の件数（測定メモ）

## SQL（`src/lib/sellers/reader.ts` と `src/lib/decision/l1-window-purchases.ts` と同じ切り方）

対象は Base（`eip155:8453`）、`status = 'settled'`、`http_status_paid IN (400, 422)`、`length(bodyHead) > 500` の行。`bodyHead` は `left(..., 500)` で分類に渡す。

```sql
SELECT count(*)::bigint
FROM x402_l1_purchases pu
WHERE pu.network = 'eip155:8453'
  AND pu.status = 'settled'
  AND pu.http_status_paid IN (400, 422)
  AND jsonb_typeof(pu.raw_response_meta) = 'object'
  AND length(pu.raw_response_meta->>'bodyHead') > 500;
```

## 何を数えるか

`bodyHead` は書き込み側（`src/lib/observatory/l1-runner.ts` の `paidBody.slice(0, 500)`）で 500 字に切ってから保存する。
そのため保存済み `bodyHead` の長さが 500 を超える行は 0 になり、上の SQL は「切る前に 500 字を超えていた答え」を数えない。
切る前の大きさは `raw_response_meta->>'bodyBytes'`（バイト数・読み取り上限で頭打ち）に残る。切る前に 500 を超えていた行は次で数える。

```sql
SELECT count(*) FILTER (WHERE (pu.raw_response_meta->>'bodyBytes') ~ '^[0-9]+$'
                          AND (pu.raw_response_meta->>'bodyBytes')::bigint > 500) AS body_bytes_over_500,
       count(*) FILTER (WHERE length(pu.raw_response_meta->>'bodyHead') = 500)   AS body_head_exactly_500,
       count(*) FILTER (WHERE length(pu.raw_response_meta->>'bodyHead') > 500)   AS body_head_over_500,
       count(*)                                                                  AS population
FROM x402_l1_purchases pu
WHERE pu.network = 'eip155:8453'
  AND pu.status = 'settled'
  AND pu.http_status_paid IN (400, 422)
  AND jsonb_typeof(pu.raw_response_meta) = 'object';
```

切る前に 500 を超えていた答えは、切れた先頭が JSON として閉じないので `seller_fixable_input` にならず、`settled_then_rejected` の保留に残る
（`tests/s1-1-acceptance.test.ts` と `tests/s1-1-seller-fixable-input.pg.test.ts` の 500 字の行）。

## 記録

| measured_at (UTC) | population | bodyBytes > 500 | length(bodyHead) = 500 | length(bodyHead) > 500 | 測った人・方法 |
|---|---:|---:|---:|---:|---|
| 2026-11-10 | — | — | — | 0 | 実装担当。保存済み bodyHead の長さだけを数えた。切る前の件数ではない（旧注の「件数は切る前の長さ」は誤り） |
| 2026-11-11 | 347 | 35 | 52 | 0 | 独立点検 rr3 が本番 DB に読み取り専用トランザクションで同じ条件を問い合わせた値 |

2026-11-11 の行は点検者の読み取りの写しである。実装担当はこの作業で本番 DB の接続情報を読んでいない（秘密の読み取りは禁止のため）。
ローカルのテスト DB はこの条件が 0 行なので、ローカルの 0 は本番の測定にならない。

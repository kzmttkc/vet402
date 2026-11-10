# S1-1: bodyHead が 500 字を超える settled 400/422 行の件数（実装前の測定メモ）

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

## 記録

| measured_at (UTC) | count | note |
|---|---:|---|
| 2026-11-10 | 0 | 上記 SQL を本番 DB に読み取り専用で実行した（`left(..., 500)` は分類側。件数は切る前の長さ） |

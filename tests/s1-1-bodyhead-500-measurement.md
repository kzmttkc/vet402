# S1-1: bodyHead が 500 字を超える settled 400/422 行の件数（実装前の測定メモ）

この worktree では本番 DB に接続せず、件数は未計測（`TEST_DATABASE_URL` なし）。載せる前に、読み取り専用で次を実行して日付と件数をここに追記する。

## SQL（`src/lib/sellers/reader.ts` と `src/lib/decision/l1-window-purchases.ts` と同じ切り方）

対象は Base（`eip155:8453`）、`status = 'settled'`、`http_status_paid IN (400, 422)`、`length(bodyHead) > 500` の行。`bodyHead` は `left(..., 500)` で分類に渡す。

## 記録

| measured_at (UTC) | count | note |
|---|---:|---|
| 2026-11-10 | — | この worktree に `DATABASE_URL` が無く本番 DB へは接続できなかった。載せる前に同 SQL を読み取り専用で実行して件数を埋める |

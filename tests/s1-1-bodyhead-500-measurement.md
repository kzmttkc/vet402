# S1-1: bodyHead が 500 字を超える settled 400/422 行の件数（実装前の測定メモ）

この worktree では本番 DB に接続せず、件数は未計測（`TEST_DATABASE_URL` なし）。載せる前に、読み取り専用で次を実行して日付と件数をここに追記する。

## SQL（`src/lib/sellers/reader.ts` と `src/lib/decision/l1-window-purchases.ts` と同じ切り方）

対象は Base（`eip155:8453`）、`status = 'settled'`、`http_status_paid IN (400, 422)`、`length(bodyHead) > 500` の行。`bodyHead` は `left(..., 500)` で分類に渡す。

## 記録

| measured_at (UTC) | count | note |
|---|---:|---|
| （未実施） | — | 試験は `tests/s1-1-acceptance.test.ts` の 500 字 truncate 行で分類だけ固定 |

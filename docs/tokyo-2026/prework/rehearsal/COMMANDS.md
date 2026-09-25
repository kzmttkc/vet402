# 確定版のコマンド（PLAN_v4.3 の本文に差し替える分）

## 何が壊れていたか

本文の判定コマンドは `cd $WT && npm ci` の直後に `cd rehearsal` が並ぶ。
`$WT` は `~/vouch-tokyo`（公開リポの worktree）で、`rehearsal/` は **private リポ側**にある。
**逐語で打つと `cd: no such file or directory: rehearsal` で止まる。**
`node rehearsal/run.mjs --h13` も同じ（cwd が private リポの root でないと外れる）。

該当は本文の4か所（§7 には判定コマンドは無い。3つ目は §10.6 の「使ってはいけない形」の表）:

| 行 | 節 | 今の書き方 |
|---|---|---|
| 1165 | §5.5 の code ブロック | `cd .company/departments/hackathon/tokyo-2026/rehearsal && npm ci && node run.mjs --all` |
| 1158 | §5.5 の表（09-24 昼） | `cd rehearsal && npm ci && node run.mjs --all` が exit 0 |
| 1227 | §6.2 の表（B0 実測・21:00–21:40） | ③ `cd rehearsal && node run.mjs --all` が exit 0 |
| 1836 | §10.6 の表 | `cd rehearsal && npm ci && node run.mjs --all` が exit 0 |
| 951 / 1148 | §4 / §5.5 | `node rehearsal/run.mjs --h13` |

`run.mjs` はパスを `import.meta.url` から解くので、**cwd に依存しない**。絶対パスで呼べばそれで済む。
`npm ci` も `--prefix` を付ければ `cd` が要らない【実測: 別 cwd から 1.3 秒・exit 0】。

## 前提（会期前に1回だけ。scratchpad の worktree は消える前提なので固定の場所に作る）

```bash
git -C "$HOME/Takeshi_Automation" worktree prune && git -C "$HOME/Takeshi_Automation" worktree add --detach "$HOME/tokyo-2026" origin/kabau-trust-board
```

以後 `rehearsal/` の絶対パスは
`$HOME/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal` の1つだけになる。
（`~/hackathon-monitor/gas-budget.mjs` もこの場所を既定で探す。別の場所に置くなら `TOKYO_REHEARSAL_DIR` を渡す。）

## 確定版（3行）

**① §5.5 / 09-24（昼）の卓上 — 判定は「走って exit 0」**

```bash
npm ci --prefix "$HOME/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal" && node "$HOME/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal/run.mjs" --all; echo "rehearsal exit=$?"
```

**② §6.2 / B0（09-25 21:00）の最初の3行の③**

```bash
node "$HOME/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal/run.mjs" --all; echo "rehearsal exit=$?"
```

**③ §6.2 / B0 のガスの関門（3鍵とも ok でなければ K1 に入らない）**

```bash
node "$HOME/hackathon-monitor/preflight-tokyo.mjs"; echo "preflight exit=$?"
```

## 付け足し（同じ書き方に揃える分）

```bash
# §4 の K1-15c の前提・§5.5 の H13 行
node "$HOME/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal/run.mjs" --h13; echo "h13 exit=$?"

# B0 で「実 calldata で再測する」ぶん（§4 の注記）。鍵ごとの実測合計と関門を突き合わせる
node "$HOME/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal/run.mjs" --gas; echo "gas exit=$?"
```

## 終了コードの読み方（本文の注記はそのまま使える）

| code | 意味 |
|---|---|
| 0 | 全部期待どおり（`SKIP` は含んでよい。下） |
| 2 | 期待と違う項目がある（表の差分行と `first_diff` を読む） |
| 1 | 読めない（RPC・ネットワーク・例外。**不合格ではない**。RPC を替えて打ち直す） |

**`SKIP` を本文に足す**: `gas_budget` の `W_op` は、**会期中に `keys.ts init` が作るまでアドレスが存在しない**。
`run.mjs` は `SKIP` と表示して 1行 JSON の `skipped` に載せるが、終了コードは落とさない。
**会期の関門は ③ の preflight** で、あちらは 3鍵とも `ok` でなければ **exit 2** を返す。
`TOKYO_W_OP_ADDRESS` を渡した瞬間に両方とも本当の合否になる【実測: 渡すと preflight が exit 0、
残高 0 のアドレスを渡すと `W_op.ok=false` / `headroom_gwei=0` で exit 2】。

## §6.2 の「数字はここに書かない」の行の差し替え

今の本文は正典を `~/hackathon-monitor/gas-budget.mjs` と書いている。**逆にする。**

> 数字は **`rehearsal/lib/gas-budget.mjs`** だけが持つ（依存なし・private リポの中）。
> `~/hackathon-monitor/gas-budget.mjs` は**転送だけで数字を持たない**。
> `preflight-tokyo.mjs` も `run.mjs --b0` も `run.mjs --gas` も §4 の表もここを読む。

理由: `rehearsal/` は「他のリポにも tmp の絶対パスにも依存しない」ことが条件になっている（§5.5）。
正典を `~/hackathon-monitor/` に置くと、その条件を破るのは `rehearsal/` 側になる。

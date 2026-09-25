# closeout/ の入れ方（執行側の手順）

読み取りだけで作った。`~/vouch` には1バイトも書いていない。commit・署名・送信はしていない。

## 1. private リポ（branch `kabau-trust-board`）へ

`closeout/rehearsal/` を `.company/departments/hackathon/tokyo-2026/rehearsal/` にそのまま重ねる。

| 種別 | パス |
|---|---|
| 差し替え | `rehearsal/checks/k1.mjs`（正典の文字列 266B / 178B・K1-04 の calls を3本に） |
| 差し替え | `rehearsal/checks/b0.mjs`（`gas_budget` 項目を追加・Sepolia の固定額 0.02 を外した） |
| 差し替え | `rehearsal/run.mjs`（`--gas` を追加・`SKIP` を扱う） |
| 差し替え | `rehearsal/lib/common.mjs`（`er`/`usr`/`urv`/`uh`・ロールのビット・`UNEMANCIPATED`・`W_OP_REAL`・`simulateBlocks` を追加） |
| 差し替え | `rehearsal/expected/k1.json`（51 行・`--record` で取り直し済み） |
| 差し替え | `rehearsal/README.md`・`rehearsal/package.json` |
| **新規** | `rehearsal/lib/gas-budget.mjs`（**関門の数字の正典**） |
| **新規** | `rehearsal/checks/gas.mjs`（元 `guards/gas.mjs` ＋ `guards/sellerd.mjs`） |
| **新規** | `rehearsal/checks/legacy/guards/`（`lib.mjs` を相対に書き直し、`b5b`/`fee`/`envgraph`/`sellerd`/`gas` を控えとして移設） |
| **要 commit** | `rehearsal/package-lock.json`（**いま index に `A` のまま・commit されていない**。この状態では clean clone で `npm ci` が落ちる【実測】） |

`expected/h13.json` は**中身が1行も変わらない**ことを確かめてある（`--record` で取り直しても差分 0 件）。

**消してよい**（中身は `rehearsal/checks/legacy/guards/` に移した）:
`guards/lib.mjs`・`guards/gas.mjs`・`guards/sellerd.mjs`・`guards/b5b.mjs`・`guards/fee.mjs`・`guards/envgraph.mjs`。
`guards/GAS.md`・`GAS.json`・`SELLER_D.json`・`GUARDS.md` は実測の控えなので残す。
ただし `GAS.md` の「スクリプト」の行は `guards/lib.mjs・guards/gas.mjs…（viem 2.38.0 は ~/hackathon-monitor から借りている）`
と書いてあるので、**`rehearsal/checks/gas.mjs`（viem は rehearsal 自身の依存）** に直す。

## 2. `~/hackathon-monitor/` へ

| | パス |
|---|---|
| 差し替え | `closeout/monitor/preflight-tokyo.mjs` → `~/hackathon-monitor/preflight-tokyo.mjs` |
| **新規** | `closeout/monitor/gas-budget.mjs` → `~/hackathon-monitor/gas-budget.mjs`（**転送だけ・数字を持たない**） |

branch の `monitor/preflight-tokyo.mjs`（写し）も同じ内容に揃える。

## 3. 正典の置き場所を固定する（worktree）

```bash
git -C "$HOME/Takeshi_Automation" worktree prune && git -C "$HOME/Takeshi_Automation" worktree add --detach "$HOME/tokyo-2026" origin/kabau-trust-board
npm ci --prefix "$HOME/tokyo-2026/.company/departments/hackathon/tokyo-2026/rehearsal"
```

`~/hackathon-monitor/gas-budget.mjs` はこの場所を既定で探す。
別の場所に置くなら `TOKYO_GAS_BUDGET`（ファイル）か `TOKYO_REHEARSAL_DIR`（`rehearsal/`）を渡す。
見つからなければ `preflight` は **`gas_budget` の項目だけ NG** にして残り7項目は読む【実測】。

## 4. 本文に反映する分

`closeout/COMMANDS.md`（確定版のコマンド3行＋`SKIP` の説明＋「数字の正典を逆にする」節）。

## 5. 09-24 の定期タスク

`~/.claude/scheduled-tasks/tokyo-preflight-0924/SKILL.md` は
`node ~/hackathon-monitor/preflight-tokyo.mjs` をそのまま打つので**変更は要らない**。
ただし項目が 7 → 8 に増え、`gas_budget` が `ok:false` のとき **exit 2** になる。
報告文の `exit=2` の分岐に「`gas_budget` が赤 → faucet を先に回す／`W_op` が `skipped` なら
`TOKYO_W_OP_ADDRESS` が未設定（会期中に作る鍵なので 09-24 時点では正常）」を1行足すとよい。

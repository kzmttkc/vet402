#!/bin/bash
# 作業コピーを作る唯一の入口（2026-11-23・ディスクを無駄に貯めない）。
# 使い方: bash ~/vouch/scripts/wt/new.sh <名前> [基点=origin/main]
#   → ~/vouch-wt-<名前> をブランチ <名前> で作り、node_modules は ~/vouch の物を APFS の複製（cp -c）で写してから
#     npm install --prefer-offline で差分だけ入れる。symlink は使わない（2026-11-22 に symlink 先を消して他の作業が壊れた）。
set -euo pipefail
name="${1:?usage: new.sh <name> [base]}"
base="${2:-origin/main}"
main="$HOME/vouch"
dest="$HOME/vouch-wt-$name"
[ -e "$dest" ] && { echo "exists: $dest" >&2; exit 2; }
git -C "$main" fetch -q origin
git -C "$main" worktree add -q -b "$name" "$dest" "$base"
# 先に ~/vouch の node_modules を lockfile に揃える（揃っていれば数秒で何も入らない）。古いまま複製すると、作業コピーごとに差分を入れ直して容量を食う。
( cd "$main" && npm install --prefer-offline --no-audit --no-fund --silent )
for pkg in "$main"/packages/*/; do
  [ -f "$pkg/package-lock.json" ] && [ -d "$pkg/node_modules" ] && ( cd "$pkg" && npm install --prefer-offline --no-audit --no-fund --silent ) || true
done
# ~/vouch の node_modules（root と packages/*）を複製する。中身の実容量はほぼ増えない（同じブロックを共有）。
for nm in "$main/node_modules" "$main"/packages/*/node_modules; do
  [ -d "$nm" ] || continue
  rel="${nm#$main/}"
  mkdir -p "$dest/$(dirname "$rel")"
  cp -cR "$nm" "$dest/$rel"
done
# lockfile との差分だけ入れる（~/vouch の node_modules が古くても、ここで揃う）。
( cd "$dest" && npm install --prefer-offline --no-audit --no-fund --silent )
for pkg in "$dest"/packages/*/; do
  [ -f "$pkg/package-lock.json" ] && [ -d "$pkg/node_modules" ] && ( cd "$pkg" && npm install --prefer-offline --no-audit --no-fund --silent ) || true
done
# npm が lockfile を書き換えたら戻す（作業コピーを最初から「変更あり」にしない。直すべき lockfile のずれは別の commit で直す）。
changed="$(git -C "$dest" diff --name-only | grep 'package-lock.json' || true)"
[ -n "$changed" ] && { echo "warning: npm rewrote $changed; restored. Fix the lockfile in its own commit." >&2; git -C "$dest" checkout -- $changed; }
echo "$dest"

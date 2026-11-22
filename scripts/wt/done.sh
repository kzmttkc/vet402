#!/bin/bash
# 作業コピーを片づける唯一の入口（2026-11-23）。
# 使い方: bash ~/vouch/scripts/wt/done.sh <名前>
#   ブランチの先頭が origin/main に入っていて、未コミットの変更が無い時だけ git worktree remove（--force なし）とブランチの削除を行う。
set -euo pipefail
name="${1:?usage: done.sh <name>}"
main="$HOME/vouch"
dest="$HOME/vouch-wt-$name"
[ -d "$dest" ] || { echo "missing: $dest" >&2; exit 2; }
git -C "$main" fetch -q origin
head="$(git -C "$dest" rev-parse HEAD)"
if ! git -C "$main" merge-base --is-ancestor "$head" origin/main; then
  echo "not merged into origin/main: $name ($head). kept." >&2; exit 3
fi
dirty="$(git -C "$dest" status --porcelain | grep -v 'node_modules' || true)"
[ -n "$dirty" ] && { echo "uncommitted changes in $dest. kept." >&2; echo "$dirty" >&2; exit 4; }
git -C "$main" worktree remove "$dest"
git -C "$main" branch -d "$name" >/dev/null 2>&1 || true
echo "removed $dest"

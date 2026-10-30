#!/usr/bin/env bash
# ============================================================
# 目録の同期 v5 の「戻すと落ちる」の確かめ（2026-10-30）。
#
# 契約: docs/catalog-staleness-contract.md の「壊すべき部分」。
# テスト: tests/catalog-staleness.pg.test.ts（トップレベルの T01〜T14）。
# パッチ: scripts/dev/mutation-patches-catalog/<ID>[-<名前>].patch（中身は実装者が書く）。
#   <ID> は T01〜T14。ファイル名の先頭 3 文字がそのパッチで落ちるべきテストを決める
#   （例: T07-b.patch・T07-events.patch はどちらも ^T07 のテストを回す）。
#
# 手順:
#   (0) 作業ツリーの追跡ファイルに差分が無いこと（あると戻し方が混ざるので FAIL）。
#   (a) パッチなしで、対象のテストが全部通ること（通らなければ FAIL で止まる）。
#   (b) パッチを 1 つずつ当て、そのテストだけを --test-name-pattern '^<ID> ' で回す。
#   (c) 走った <ID> のテストが 1 件以上、かつそのうち assert で落ちた（ERR_ASSERTION）ものが 1 件以上なら PASS。
#       0 件・コマンドの失敗・読み込みや構文や例外だけで落ちた・全部通った、は FAIL。
#   (d) パッチを戻し、最後に git diff --exit-code で終える。
#
# 使い方:
#   eval "$(/path/to/setup_test_db.sh "$PWD" vet402_test_catalog5)"   # TEST_DATABASE_URL を入れる
#   bash scripts/dev/mutation-check-catalog.sh 1    # 第1段: T01 T02 T03 T12 T13 のパッチが要る
#   bash scripts/dev/mutation-check-catalog.sh 2    # 第2段: T01〜T13（T07 は 2 本）のパッチが要る
# 終了コード: 全部 PASS のときだけ 0。
# ============================================================
set -uo pipefail

PHASE="${1:-}"
case "$PHASE" in
  1) REQUIRED=(T01 T02 T03 T12 T13) ;;
  2) REQUIRED=(T01 T02 T03 T04 T05 T06 T07-b T07-events T08 T09 T10 T11 T12 T13) ;;
  *) echo "usage: [ONLY='T13 T07-b'] $0 <1|2>   (1 = 第1段, 2 = 第2段)" >&2; exit 2 ;;
esac
# ONLY（空白区切り）を渡すと、その段の必要なパッチのうち名前が一致するものだけを回す（手元の確かめ用。合格の判定には使わない）。
if [ -n "${ONLY:-}" ]; then
  picked=()
  for id in "${REQUIRED[@]}"; do
    case " $ONLY " in *" $id "*) picked+=("$id") ;; esac
  done
  if [ "${#picked[@]}" -eq 0 ]; then echo "ONLY=$ONLY はこの段のパッチに無い" >&2; exit 2; fi
  REQUIRED=("${picked[@]}")
  echo "note: ONLY=$ONLY（一部だけ。合格の判定には全部を回す）"
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2
TEST_FILE="tests/catalog-staleness.pg.test.ts"
PATCH_DIR="scripts/dev/mutation-patches-catalog"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mutation-check-catalog.XXXXXX")"
FAILED=0
APPLIED=""

say() { printf '%s\n' "$*"; }
fail_line() { say "FAIL $*"; FAILED=1; }

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  say "FAIL setup: TEST_DATABASE_URL が無い（DB が無いまま PASS にしない）"
  exit 1
fi
case "$TEST_DATABASE_URL" in
  *neon.tech*) say "FAIL setup: TEST_DATABASE_URL が Neon を指している"; exit 1 ;;
esac

revert_applied() {
  if [ -n "$APPLIED" ]; then
    git apply -R "$APPLIED" >/dev/null 2>&1 || say "FAIL revert: $APPLIED を戻せなかった（手で確かめる）"
    APPLIED=""
  fi
}
trap revert_applied EXIT INT TERM

if ! git diff --quiet; then
  say "FAIL setup: 追跡ファイルに未コミットの差分がある（先にコミットか stash する）"
  git diff --stat
  exit 1
fi

# 必要なパッチがそろっているか。パッチがテストやこのスクリプトを触っていないか。
PATCHES=()
for id in "${REQUIRED[@]}"; do
  p="$PATCH_DIR/$id.patch"
  if [ ! -f "$p" ]; then
    fail_line "$id: パッチが無い ($p)"
    continue
  fi
  touched="$(git apply --numstat "$p" 2>/dev/null | awk '{print $3}')"
  if [ -z "$touched" ]; then
    fail_line "$id: パッチが読めない、または何も変えない ($p)"
    continue
  fi
  if printf '%s\n' "$touched" | grep -Eq '^(tests/|scripts/dev/)'; then
    fail_line "$id: パッチがテストかこのスクリプトを書き換えている"
    continue
  fi
  PATCHES+=("$p")
done
if [ "$FAILED" -ne 0 ]; then
  say "RESULT FAIL（パッチの不足・不正）"
  exit 1
fi

# TAP から、名前が ^<ID>␠ のトップレベルのテストの件数・fail の件数・assert で落ちた件数を数える。
# 変異で数えるのは assert の失敗（code: 'ERR_ASSERTION'）だけ。読み込みの失敗・構文の誤り・not implemented・SQL の例外で
# 落ちたテストは「振る舞いを見て落ちた」ではないので PASS にしない（2026-10-30 に、構文を壊したパッチが PASS になるのを確かめて足した）。
count_tap() {
  local file="$1" id="$2"
  local ran fail asserted
  ran=$(grep -E "^(ok|not ok) [0-9]+ - ${id} " "$file" | grep -v '# SKIP' | wc -l | tr -d ' ')
  fail=$(grep -E "^not ok [0-9]+ - ${id} " "$file" | wc -l | tr -d ' ')
  asserted=$(awk -v id="$id" '
    /^(ok|not ok) [0-9]+ - / { inblk = ($0 ~ ("^not ok [0-9]+ - " id " ")); next }
    inblk && /^  code: .ERR_ASSERTION./ { n++; inblk = 0 }
    END { print n + 0 }' "$file")
  printf '%s %s %s\n' "$ran" "$fail" "$asserted"
}

run_tests() {
  local pattern="$1" out="$2"
  npx tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap \
    --test-name-pattern "$pattern" "$TEST_FILE" >"$out" 2>&1
}

# (a) 基準: パッチなしで対象のテストが全部通る。
IDS=()
for p in "${PATCHES[@]}"; do
  id="$(basename "$p" .patch)"; id="${id:0:3}"
  case " ${IDS[*]-} " in *" $id "*) ;; *) IDS+=("$id") ;; esac
done
pattern="^($(IFS='|'; echo "${IDS[*]}")) "
base_out="$LOG_DIR/baseline.tap"
run_tests "$pattern" "$base_out"
base_rc=$?
for id in "${IDS[@]}"; do
  read -r ran fail asserted < <(count_tap "$base_out" "$id")
  if [ "$base_rc" -ne 0 ] || [ "$ran" -lt 1 ] || [ "$fail" -ne 0 ]; then
    fail_line "baseline $id: パッチなしで通らない（rc=$base_rc ran=$ran fail=$fail, log $base_out）"
  else
    say "ok   baseline $id: ran=$ran fail=0"
  fi
done
if [ "$FAILED" -ne 0 ]; then
  say "RESULT FAIL（基準が通らないので変異を見ない）"
  exit 1
fi

# (b)(c) パッチを 1 つずつ。
for p in "${PATCHES[@]}"; do
  name="$(basename "$p" .patch)"; id="${name:0:3}"
  if ! git apply --check "$p" >/dev/null 2>&1; then
    fail_line "$name: パッチが今のコードに当たらない"
    continue
  fi
  git apply "$p" && APPLIED="$p"
  out="$LOG_DIR/$name.tap"
  run_tests "^${id} " "$out"
  rc=$?
  revert_applied
  read -r ran fail asserted < <(count_tap "$out" "$id")
  if [ "$ran" -lt 1 ]; then
    fail_line "$name: $id のテストが 1 件も走らなかった（rc=$rc, log $out）"
  elif [ "$fail" -lt 1 ]; then
    fail_line "$name: パッチを当てても $id が通った（変異が生き残った, log $out）"
  elif [ "$asserted" -lt 1 ]; then
    fail_line "$name: $id は落ちたが assert ではない（読み込み・構文・例外で落ちた。パッチを直す, log $out）"
  elif [ "$rc" -eq 0 ]; then
    fail_line "$name: fail があるのにコマンドが 0 で終わった（出力を確かめる, log $out）"
  else
    say "PASS $name: ran=$ran fail=$fail (assert $asserted)"
  fi
done

# (d) 戻したことを確かめて終える。
trap - EXIT INT TERM
revert_applied
if ! git diff --exit-code >/dev/null; then
  say "FAIL cleanup: パッチを戻した後も差分が残っている"
  git diff --stat
  exit 1
fi
say "logs: $LOG_DIR"
if [ "$FAILED" -ne 0 ]; then
  say "RESULT FAIL"
  exit 1
fi
say "RESULT PASS"
exit 0

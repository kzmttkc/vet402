# ETHOnline 2026 — git rules (Continuity Track boundary)

Operating plan: [`ROADMAP.md`](./ROADMAP.md). Follow that file; these rules are the git subset.

1. **2026-09-03**: tag `pre-ethonline-2026` on `main` (scheduled; everything reachable from it is pre-existing).
2. **2026-09-04 onward**: all work on branch `ethonline-2026`, cut from the tag.
3. Commit prefix fixed: `ethonline:` — examples:
   - `ethonline: feat(sdk): payOrRefuse — ALLOW時のみx402支払い・非ALLOWは署名前拒否`
   - `ethonline: feat(mcp): pay_if_trusted tool wired to payOrRefuse (BLOCK cannot reach payment)`
   - `ethonline: demo(agent): two-scenario runner + decisions feed source=agent-demo`
4. One commit = one purpose. Any edit to a pre-existing file → append to `CHANGED_FILES.md` in the same commit.
5. Submission: `git merge --no-ff ethonline-2026` into `main`; the merge commit is the boundary evidence.
   `git log --oneline pre-ethonline-2026..ethonline-2026` must read as the complete list of hackathon work.

## README の扱い（2026-08-22 確定）

`README_CONTINUITY_SECTION.md` は **会期中は README.md に入れない**。予定を公開 README に
詳細に書くと、後から「最初から決めてあっただけ」と読まれうるため。

1. 9/4 以降、実装が進むたびに `README_CONTINUITY_SECTION.md` の "Built during the window"
   を**実際にできたものだけ**に更新する（未着手項目は書かない）。
2. 提出直前（実装が固まった時点）で、完成した内容だけを過去形にして README.md へ移す。
3. 「Existed before the window」と「Boundary definition」は 9/3 のタグ時点で確定しているので、
   移すときも書き換えない。

## main へ入れる手順は `scripts/push-main.sh` だけ（2026-09-07 確定）

main へは **`bash scripts/push-main.sh` だけ**で入れる。`git fetch && git rebase && bash scripts/judge-check.sh && git push ...`
の手打ち連結は禁止（9/7 に 10 回以上打ち直し、1 回は綴り誤り、1 回は並行ブランチの衝突で main が赤になった）。

- 中身: 前提検査（clean・main 以外・origin・gh）→ `git fetch` → `git rebase origin/main` → `judge-check.sh`
  → `git push origin HEAD:main` → `~/vouch` を ff → `ci` ワークフローの結果待ち。各段の exit と秒を最後に表で出す。
- `--full` で root の `npm test` も回し、4 スイートの `ℹ fail 0` を数える（`&&` で繋がない）。
- `--dry-run` は `git push --dry-run`（何も出ない）。`--no-wait` は CI を待たない。
- rebase が衝突したら止まる。`--abort` は自動でしない——人が解決して再実行。

## 発注に必ず入れる 2 行（2026-09-08 確定・Takeshi 採用）

会期中の実装は別エージェントへ発注する。発注の冒頭に次の 2 行を**定型で**入れる。

1. 「この発注の前提のうち最も怪しいものを 1 つ挙げ、実装前に確かめよ。違うなら実装せずに報告せよ」
   （09-07 に実装者が発注者の前提を 4 回覆した。4 回とも自発だった）
2. 「決済経路——`src/lib/observatory/*payer*`・`packages/sdk/src/x402-pay.ts`・`pay-or-refuse.ts`・署名器に触るコード——を
   変える必要が出たら、**変えずに止まって報告せよ**」
   （09-07 に「npm audit の high を 0 に」という衛生の発注で、実装者が Solana 決済の 2 関数を自前実装まで進めた。
   結果は正しく目視とバイト一致テストで確認したが、金の経路の変更は成果物が正しくても発注者が見ないまま
   main に入る経路が誤り。1 回目で規則にする）

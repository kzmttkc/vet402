# ETHOnline 2026 — the Continuity boundary, measured

> **This stopped being a README draft on 2026-09-08.** Written 2026-08-22 to be pasted into `README.md`
> at submission; that job now belongs to [`../../README.md`](../../README.md), [`../../SKILL.md`](../../SKILL.md)
> and [`SUBMISSION_DRAFT.md`](./SUBMISSION_DRAFT.md). Nothing here is pasted anywhere. What is left is what
> a Continuity judge must check alone: where the line is, and which side each thing sits on — as commands.

## The line

Tag `pre-ethonline-2026` — commit `c42daca`, **2026-09-04 00:05:36 UTC**, cut five minutes after the
window opened. Everything reachable from it is pre-existing, and we claim none of it.

```bash
git log -1 --format='%H %cI' pre-ethonline-2026       # the line itself
git rev-list --count pre-ethonline-2026..origin/main  # commits since
```

`main` is also production here, so that second range holds work we do **not** claim; the narrower range
we do, and the disclosure sent to ETHGlobal on 2026-09-05, are in [`SUBMISSION_DRAFT.md`](./SUBMISSION_DRAFT.md)
and [`DISCLOSURE_2026-09-05.md`](./DISCLOSURE_2026-09-05.md). There is no hackathon branch to read: the work
landed on `main`, in the open, one commit at a time.

## Before the line — pre-existing, not submitted

vet402 already bought what x402 sellers sell with real USDC on Base under a daily budget, checked what came
back against the seller's own declaration, published every success and failure through a hash-chained ledger
and public receipts, scored payees, **answered** "should my agent pay this?" at `GET /decision`, and shipped
an SDK client, six read-only MCP tools and an ERC-8004 dry run. None of it ever signed: `git ls-tree -r --name-only pre-ethonline-2026 | grep -E 'pay-or-refuse|pay-if-trusted|subgraph-evidence'` prints nothing.

## After the line — what the window added

Before the window vet402 could **answer** the question; in the window it learned to **act** on the
answer, and to refuse without asking a model's permission.

1. **Refuse before a signature can exist.** `payOrRefuse` imports the payment module only inside the
   allow branch, so a refusal cannot reach a signer — `git log --diff-filter=A --oneline -- packages/sdk/src/pay-or-refuse.ts`
2. **Cite The Graph in the caller's own name, and reject a citation from elsewhere.** Evidence reads
   live from the x402 Base subgraph with the caller's key, carrying block and deployment; a read from
   another deployment is refused — `git show --stat 51f7445 beac4f9`
3. **Let a caller set their own floor without us rewriting our verdict.** `requireVet402Allow: false`
   waives our WARN when their floors are met; BLOCK and degraded never are, and the record still says
   the verdict came from `caller_policy` — `grep -n requireVet402Allow packages/sdk/src/pay-or-refuse.ts`
4. **Judge a seller who is not in our catalogue.** On a 404 from `/decision` the gate decides from the
   402 challenge's `payTo` and that address's payee score, instead of registering the seller to make
   the demo look tidy — `grep -n not_found packages/sdk/src/pay-or-refuse.ts`
5. **Hand the whole gate to an agent as one MCP tool.** `pay_if_trusted` forwards the caller's policy
   unchanged and keeps the key out of the model's context —
   `git log --diff-filter=A --oneline -- packages/mcp-server/src/pay-if-trusted.ts`
6. **Keep demo decisions away from the money.** They publish as `source: agent-demo` to an append-only
   store and never enter the production purchase ledger — `grep -rln agent-demo examples/ethonline-2026-demo/src`
7. **Say verdicts one way, and prove the edges.** One shared rule reads every verdict word, and a table
   of broken shapes drives every external input surface into a refusal before signing —
   `git show --stat bfc16bb 8633f2f`
8. **Run the same model twice with one difference.** A pre-registered A/B harness gives an agent the
   same prompt and tools with and without a Bazantic Recipe, and regrades raw trials from scratch —
   `git log --diff-filter=A --oneline -- examples/ethonline-2026-ab | tail -1`

The gate has settled one real payment on Base; that receipt and its numbers are in
[`../../SKILL.md`](../../SKILL.md) and [`SUBMISSION_DRAFT.md`](./SUBMISSION_DRAFT.md).

## Size of the window, counted rather than asserted

`git diff --diff-filter=A --name-only pre-ethonline-2026..main | wc -l` → <!-- n:window_added_files -->206<!-- /n --> files added, and
`git diff --diff-filter=M --name-only pre-ethonline-2026..main | wc -l` → <!-- n:window_modified_files -->194<!-- /n --> pre-existing files touched
(listed in [`CHANGED_FILES.md`](./CHANGED_FILES.md)), both as of <!-- n:as_of -->2026-09-08<!-- /n -->. CI re-derives them every run
(`npm run check-numbers`), so a stale number here turns the build red instead of sitting quietly.

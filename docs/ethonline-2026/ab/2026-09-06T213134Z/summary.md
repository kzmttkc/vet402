# A/B run — 2026-09-06T21:14:07.842Z

> Bazantic MCP server in the path: `https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp` (same tools in both conditions).


- pre-registration: `docs/ethonline-2026/WINDOW_PLAN.md §16 (2026-09-05 09:05)`
- model: `claude-opus-5` · temperature: `not sent`
- trials: 20 (10 per condition)

## Success = verdict matches AND reason codes are a subset, non-empty when the answer is refuse

WINDOW_PLAN §16, as amended 2026-09-05 10:55 — **before any real trial was run**. The original
rule said only "subset"; the empty set is literally a subset, so "refused but gave no reason"
counted as a success. That is the failure this experiment exists to catch. The count under the
original rule is reported below and is recomputable from the raw log.

| condition | trials | success | successRate | verdictMatch | reasonSubset | fabricated | errors | unparseable |
|---|---|---|---|---|---|---|---|---|
| A | 10 | 5 | 50% | 10 | 5 | 5 | 0 | 0 |
| B | 10 | 5 | 50% | 9 | 6 | 4 | 0 | 1 |

**delta (B − A)**: success +0 · successRate +0pt

## Per fixture

| condition | F1 | F2 | F3 | F4 |
|---|---|---|---|---|
| A | 3/3 | 0/3 | 2/2 | 0/2 |
| B | 3/3 | 0/3 | 2/2 | 0/2 |

Counts are recomputed from `trials.jsonl` on every read (`verifyRunDir`). 
Non-scoring: count under the ORIGINAL (pre-amendment) rule — A: 5, B: 5.
Non-scoring: refused with no reason codes (dropped from success by the amendment) — A: 0, B: 0.

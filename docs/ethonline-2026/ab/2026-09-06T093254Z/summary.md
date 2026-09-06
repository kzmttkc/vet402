# A/B run — 2026-09-06T09:19:36.499Z

> Bazantic MCP server in the path: `https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp` (same tools in both conditions).


- pre-registration: `docs/ethonline-2026/WINDOW_PLAN.md §16 (2026-09-05 09:05)`
- model: `claude-opus-5` · temperature: `(mixed)`
- trials: 20 (10 per condition)

## Success = verdict matches AND reason codes are a subset, non-empty when the answer is refuse

WINDOW_PLAN §16, as amended 2026-09-05 10:55 — **before any real trial was run**. The original
rule said only "subset"; the empty set is literally a subset, so "refused but gave no reason"
counted as a success. That is the failure this experiment exists to catch. The count under the
original rule is reported below and is recomputable from the raw log.

| condition | trials | success | successRate | verdictMatch | reasonSubset | fabricated | errors | unparseable |
|---|---|---|---|---|---|---|---|---|
| A | 10 | 0 | 0% | 7 | 0 | 10 | 0 | 0 |
| B | 10 | 0 | 0% | 7 | 0 | 10 | 0 | 0 |

**delta (B − A)**: success +0 · successRate +0pt

## Per fixture

| condition | F1 | F2 | F3 | F4 |
|---|---|---|---|---|
| A | 0/3 | 0/3 | 0/2 | 0/2 |
| B | 0/3 | 0/3 | 0/2 | 0/2 |

Counts are recomputed from `trials.jsonl` on every read (`verifyRunDir`). 
Non-scoring: count under the ORIGINAL (pre-amendment) rule — A: 0, B: 0.
Non-scoring: refused with no reason codes (dropped from success by the amendment) — A: 0, B: 0.

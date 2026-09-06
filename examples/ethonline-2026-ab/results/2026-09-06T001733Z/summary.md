# A/B run — 2026-09-06T00:17:33.913Z

> **MOCK RUN — this is not a measurement of any model.**
> The agent was a scripted stub used to exercise the harness. No LLM was called.

> **no MCP server was called in this run** — the agent was given no tools.


- pre-registration: `docs/ethonline-2026/WINDOW_PLAN.md §16 (2026-09-05 09:05)`
- model: `mock-scripted-v1` · temperature: `0`
- trials: 20 (10 per condition)

## Success = verdict matches AND reason codes are a subset, non-empty when the answer is refuse

WINDOW_PLAN §16, as amended 2026-09-05 10:55 — **before any real trial was run**. The original
rule said only "subset"; the empty set is literally a subset, so "refused but gave no reason"
counted as a success. That is the failure this experiment exists to catch. The count under the
original rule is reported below and is recomputable from the raw log.

| condition | trials | success | successRate | verdictMatch | reasonSubset | fabricated | errors | unparseable |
|---|---|---|---|---|---|---|---|---|
| A | 10 | 0 | 0% | 10 | 0 | 10 | 0 | 0 |
| B | 10 | 10 | 100% | 10 | 10 | 0 | 0 | 0 |

**delta (B − A)**: success +10 · successRate +100pt

## Per fixture

| condition | F1 | F2 | F3 | F4 |
|---|---|---|---|---|
| A | 0/3 | 0/3 | 0/2 | 0/2 |
| B | 3/3 | 3/3 | 2/2 | 2/2 |

Counts are recomputed from `trials.jsonl` on every read (`verifyRunDir`). 
Non-scoring: count under the ORIGINAL (pre-amendment) rule — A: 0, B: 10.
Non-scoring: refused with no reason codes (dropped from success by the amendment) — A: 0, B: 0.

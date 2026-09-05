# A/B run — 2026-09-05T01:47:14.218Z

> **MOCK RUN — this is not a measurement of any model.**
> The agent was a scripted stub used to exercise the harness. No LLM was called.

> **PROVISIONAL / 暫定** — some fixture oracles are not first-hand measurements yet.
> - F1: oracle が未測定（derived）——本番 API で取り直すまで採点は暫定。
> - F2: resource URL が未確定（prefix https://gateway.thegraph.com/api/x402/subgraphs/id/ のみ）。
> - F3: oracle が未測定（derived）——本番 API で取り直すまで採点は暫定。
> - F3: payee の全アドレスが未確定（prefix 0xb15a55e8 のみ）。
> - F4: oracle が未測定（derived）——本番 API で取り直すまで採点は暫定。


- pre-registration: `docs/ethonline-2026/WINDOW_PLAN.md §16 (2026-09-05 09:05)`
- model: `mock-scripted-v1` · temperature: `0`
- trials: 20 (10 per condition)

## Success = verdict matches AND reason codes are a subset (WINDOW_PLAN §16)

| condition | trials | success | successRate | verdictMatch | reasonSubset | fabricated | errors | unparseable |
|---|---|---|---|---|---|---|---|---|
| A | 10 | 0 | 0% | 8 | 2 | 8 | 1 | 1 |
| B | 10 | 8 | 80% | 8 | 10 | 0 | 1 | 1 |

**delta (B − A)**: success +8 · successRate +80pt

## Per fixture

| condition | F1 | F2 | F3 | F4 |
|---|---|---|---|---|
| A | 0/3 | 0/3 | 0/2 | 0/2 |
| B | 2/3 | 3/3 | 1/2 | 2/2 |

Counts are recomputed from `trials.jsonl` on every read (`verifyRunDir`). 
Non-scoring note: successes whose reason_codes were empty — A: 0, B: 0.

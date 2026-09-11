# Bazantic — developer feedback from the vet402 A/B (ETHOnline 2026, Continuity)

Written for the judges and for Bazantic. Every number below is recomputed from the raw trial log
(`docs/ethonline-2026/ab/2026-09-06T213134Z/trials.jsonl`) by one command —
`npm run metrics -- docs/ethonline-2026/ab/2026-09-06T213134Z` (run inside `examples/ethonline-2026-ab/`); it is quoted at the end.
Bazantic account: **`TakeshiTGAL`**.

## 1. What I built on Bazantic

- **Gateway** `https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com` (upstream `vet402.com`, live since 2026-09-03, every route priced at 0 mcents).
  Its MCP endpoint `…/mcp` lists **57 tools**.
- **Recipe** `x402-payee-verification-via-vet402-gateway`, published 2026-09-07 06:15 JST at
  `https://bazantic.com/recipes/x402-payee-verification-via-vet402-gateway`. The copy the harness feeds to condition B
  (`examples/ethonline-2026-ab/recipe/x402-payee-verification.json`) has the same `description` as the public page, byte for byte.
- **Harness** `examples/ethonline-2026-ab/` — pre-registered in `docs/ethonline-2026/WINDOW_PLAN.md §16` on 2026-09-05, before any real trial.

## 2. The A/B

**Task (both conditions):** *Before you pay this x402 endpoint, establish whether the payee has actually delivered before. If there is no evidence, do NOT pay, and give your reason as machine-readable codes.*

**Design.** Same model (`claude-opus-5`, effort `high`), same prompt, same 57 MCP tools, same raw API list. Condition B additionally receives the Recipe text. The Recipe is the only difference: a test pins `stripRecipe(B) === A` byte for byte. `temperature` was not sent — the API rejects the parameter for this model — so it is `null` in both conditions (a recorded pre-registration deviation).

**Fixtures (oracle = what vet402's own API returns):** F1 a payee with delivered purchases (proceed); F2 The Graph's payee, not catalogued (`/decision` 404 → refuse); F3 a payee never bought from (`l1_not_attempted` → refuse); F4 a price above the caller's ceiling (`price_above_ceiling` → refuse). 10 trials per condition, 20 total, run once, not re-run.

**Success** = verdict matches the oracle **and** every reason code the agent gives appears in the oracle's codes **and** the list is non-empty when the answer is refuse (amendment of 2026-09-05 10:55, before data).

| condition | success | verdict match | codes ⊆ oracle | fabricated ≥1 | errors | unparseable |
|---|---|---|---|---|---|---|
| A (no Recipe) | **5/10** | 10 | 5 | 5 | 0 | 0 |
| B (Recipe) | **5/10** | 9 | 6 | 4 | 0 | 1 |

Per fixture, both conditions: F1 3/3 · F2 0/3 · F3 2/2 · F4 0/2. **Delta = 0.** My pre-registered prediction ("A gets the verdict right but fabricates reasons") was half right: A fabricated in 5/10, but B failed the same two fixtures.

**Exploratory metric (not pre-registered, not used for scoring).** Share of reason codes that are real vet402 identifiers — the closed vocabulary in `src/lib/observatory/vocabulary.ts`, the SDK's refuse reasons in `examples/ethonline-2026-demo/src/judge.ts`, or a code the API actually returned in this run: **A 20/32 (63%) vs B 29/32 (91%)** (`npm run metrics`, set ii; codes compared after trim + lowercase, the same normalization the grader uses). Trials in which every code was real: A 7/10, B 7/10. Counting only the two source files (set i, which stores the tier codes `l0_pass`/`l1_delivered`/`l2_undeclared` decomposed and therefore undercounts both sides) gives A 3/32 vs B 10/32. Direction is the same either way.

An earlier run the same day (`ab/2026-09-06T093254Z`) scored 0/10 in both conditions because every tool call returned the Gateway's 402 text instead of data (§4). I kept that log, fixed the instrument, and re-ran under a new timestamp.

## 3. What the Recipe fixed, and what it did not

- **It fixed the vocabulary.** Without the Recipe the agent turns screen words into "codes": `WARN`, `thin`, `Unverified`, `receiving.paymentCount=0`, `resolve:endpoints=[]`. With the Recipe it uses vet402's words (`resource_uncatalogued`, `l1_not_attempted`, `evidence_unavailable`, `payee_recommendation_not_allow`).
- **It did not fix the verdict path on F2.** B lists *more* real codes than the oracle returns for that case (`evidence_unavailable`, `l1_not_attempted` on top of `resource_uncatalogued` + `payee_recommendation_not_allow`), so the subset rule fails. One B trial also wrapped its JSON in a code fence and was unparseable — that is a harness parser choice, counted as a failure.
- **F4 is my design hole, not the model's.** `price_above_ceiling` is a caller-side policy word from vet402's SDK. No Gateway tool returns it and the Recipe prompt does not mention it, so neither condition can produce it. B invented plausible substitutes (`policy:amount_exceeds_ceiling`, `amount_exceeds_caller_ceiling`). A word that lives nowhere the agent can read will not appear, Recipe or not. Next step on my side: put the caller-policy codes in the Recipe prompt, or have a tool return them.

## 4. Gateway findings

1. **$0 routes still answer 402.** All 57 routes are at 0 mcents, yet every unpaid call gets a 402. The docs say only `tools/list` and price discovery are free; the body comes after payment. With `baz curl … --max-amount 0` (and with my own signer) the REST route returns 200 — after the facilitator posts a **0-USDC transfer on chain**. Re-measured 2026-09-09 08:30–08:40 JST: the same Gateway's 0-mcent tools (`info`, `getHealth`, `resolveQuery`, `getPayeeScore`) now return their body on an unpaid MCP `tools/call` — no 402, no settlement. The sentences before this one describe the 2026-09-06 behaviour.
2. **MCP `tools/call` cannot pay.** A `PAYMENT-SIGNATURE` header on the `/mcp` POST is ignored; the tool result is `isError: true` with the 402 body. `initialize.instructions` is null and no tool schema has a payment field.
3. **So a standard MCP client cannot use any of the tools today.** "Add to Claude / Cursor / ChatGPT" connects, lists 57 tools, and every call returns 402 — including the 37 tools described as needing no key. Run `093254Z` measured exactly that: 0/10 and 0/10. Re-measured 2026-09-09 08:30–08:40 JST: a stock MCP client can now call the free tools and gets the body; `093254Z` records the 2026-09-06 state.
4. **My bridge, and its cost.** `src/mcp.mjs` catches a 402 from `tools/call`, and only when the quoted amount is exactly `"0"`, re-sends the same resource as a signed REST `GET` and hands the model the real body (non-zero amounts fail loudly; nothing is signed). In the 20 trials: **110 tool calls, 88 settled with a 200 and 88 distinct on-chain transactions of 0 USDC**; the other 22 (12 × 404, 10 × 400 from the upstream) produced no transaction. **88 free reads cost 88 facilitator transactions.** Every tx hash is in `raw.toolCalls[].x402Bridge.txHash`. Re-measured 2026-09-09 08:30–08:40 JST: with the free tools answering 200 unpaid, the bridge is never entered and no 0-USDC transaction is posted; the 88 are the 2026-09-06 numbers and stay as measured.
5. **The "JWT that bypasses x402/MPP for testing"** mentioned in `#partner-bazantic` — on 2026-09-06 I could not find it in the docs or the dashboard. Answered 2026-09-09 by Tom Hay (Bazantic) on Discord: a JWT created at `bazantic.com/api-keys` can be used as an API key for the gateway to bypass the 402 challenge, so no transaction has to be signed. I read the CLI's `--auth-type api-key | jwt | x402-mpp | basic` (`@bazantic/cli@0.8.0`, default `x402-mpp`) as the gateway owner's upstream auth setting for the registered endpoint; sent as a buyer-side request header (`Authorization: Bearer`, `x-api-key`) it made no difference in my 2026-09-09 re-measurement, which fits that reading. My gateway stays on the default `x402-mpp`. A line about it next to the pricing docs would make it easy to find.
6. **`baz recipe`** (`baz recipe install`, the documented way to run a public Recipe with a payer) is not in `@bazantic/cli@0.8.0` on npm; the docs run ahead of the CLI.
7. The public Recipe page (server HTML) shows name, author, description and the input form; the prompt text itself is not in it, so a judge cannot read the Recipe's instructions from the page alone.
8. One keystore-related item was sent privately to `support@bazantic.com` on 2026-09-06; it is intentionally not described here.

## 5. What would make this better for agents

- Let a 0-mcent route return its body without a settlement, or add a per-gateway "free below N" switch — a free read should not cost a chain transaction. (Observed working on 2026-09-09; see §4 #1.)
- Let MCP `tools/call` carry a payment (honour `PAYMENT-SIGNATURE`, or return the 402 as a structured `accepts` object the client can act on) so standard MCP clients can use paid tools at all.
- Ship `baz recipe` in the CLI, or remove it from the docs until it ships.
- Put the Recipe text into MCP `initialize.instructions` for the Gateway it belongs to — then "Add to Claude" delivers the Recipe without anyone pasting it.
- Show the Recipe prompt on the public page; a reviewer should not need an account to read what the agent is told.

## 6. A/B v2 — after closing the product hole (run 2026-09-11)

**What changed, and what did not.** v1's F4 failure was mine: no tool returned `price_above_ceiling`. I changed the product (`getResourceDecision` now takes `amount_usd` / `max_per_tx_usd` / `require_vet402_allow` and returns `caller_policy.reason_codes`) and added one sentence to the Recipe (v2) telling the agent to pass the 402 amount and its ceiling and to use `caller_policy.reason_codes`. Same model (`claude-opus-5`, effort `high`), same 57 tools in both conditions, same fixtures, same grading rule, 10 trials per condition, `temperature` not sent. Pre-registered in `WINDOW_PLAN.md` §16.5 on 2026-09-07; a pre-run note (commit `91898a2`, 2026-09-10 23:11:02 UTC) fixed F4's oracle at `{price_above_ceiling}` before the run started (23:24:22 UTC). Run once, not re-run: `docs/ethonline-2026/ab/2026-09-10T233702Z`.

**Differences from v1 that are not the Recipe.** No payer key was passed, so the bridge was never built: **102 tool calls, 0 settled, 0 transactions** (v1: 110 calls, 88 transactions of 0 USDC). The Gateway's 0-mcent tools now answer an unpaid `tools/call` with the body (12 of the tools v1 used: 0 × 402 right before and right after the run). The Recipe on bazantic.com is still v2; the planned v2.1 (one line about `l1_inconclusive`) was not published — a recorded deviation.

| condition | success | verdict match | codes ⊆ oracle | fabricated ≥1 | errors | unparseable |
|---|---|---|---|---|---|---|
| A (no Recipe) | **7/10** | 10 | 7 | 3 | 0 | 0 |
| B (Recipe v2) | **5/10** | 10 | 5 | 5 | 0 | 0 |

Per fixture — A: F1 3/3 · F2 0/3 · F3 2/2 · F4 2/2. B: F1 3/3 · F2 0/3 · F3 2/2 · F4 0/2. **Delta (B − A) = −2 (−20pt).**

| run | A | B | F4 A | F4 B | vocabulary set ii, A | set ii, B | tool calls | on-chain tx |
|---|---|---|---|---|---|---|---|---|
| v1 `2026-09-06T213134Z` | 5/10 | 5/10 | 0/2 | 0/2 | 20/32 (63%) | 29/32 (91%) | 110 | 88 |
| v2 `2026-09-10T233702Z` | 7/10 | 5/10 | 2/2 | 0/2 | 17/26 (65%) | 29/37 (78%) | 102 | 0 |

(Vocabulary is exploratory and not used for scoring. v2 set i: A 6/26 (23%), B 10/37 (27%); trials in which every code was real (set ii): A 7/10, B 7/10.)

**My predictions, checked.**
- "F4 is fixed in B and not in A" — **wrong, both halves.** Both A trials passed `amount_usd: 5` and `max_per_tx_usd: 1` to `getResourceDecision`, parameters both conditions can see in the tool schema and the API list, and answered with `price_above_ceiling` alone. Both B trials answered `price_above_ceiling` plus the top-level codes `l0_pass`, `l1_delivered`, `l2_undeclared`. The top-level decision for that resource is ALLOW; only `caller_policy` refuses, so those three codes are reasons to pay and are not in the oracle. My Recipe's step 5 asks for reason codes "including caller_policy.reason_codes", which reads as "the top-level codes and the caller-policy codes". I named this risk in the pre-run note; it happened.
- "F2 is not fixed in either condition" — **right.** `/decision` still answers 404 `not_found` for The Graph's resource; both conditions scored 0/3.
- "If there is a difference, it is at most the two F4 trials (+20pt)" — **the difference came from F4, in the other direction (−20pt).**

**What I take from it.** Without the Recipe, the tool schema and the API list were enough for the agent to use the ceiling parameters; the Recipe sentence I added made B's reason list less exact. A Recipe line is an instruction the agent follows literally, so its wording is part of the product.

## Recount command

Every number in this document comes from one script; nothing is counted by hand.

```bash
cd examples/ethonline-2026-ab
npm run metrics -- ../../docs/ethonline-2026/ab/2026-09-06T213134Z          # Markdown tables
npm run metrics -- ../../docs/ethonline-2026/ab/2026-09-06T213134Z --json   # same numbers as JSON
npm run metrics -- ../../docs/ethonline-2026/ab/2026-09-10T233702Z          # v2 (§6)
```

It regrades every trial from `answer` + `oracle` with the pre-registered rule (`src/grade.mjs`) and does not read
`summary.json`; the vocabulary sets are read from `src/lib/observatory/vocabulary.ts` and
`packages/sdk/src/pay-or-refuse.ts` at run time, not hard-coded. Codes are compared after trim + lowercase, the same
normalization the grader uses — so the script counts A's vocabulary share as 20/32 (set ii) and 3/32 (set i): one A trial
wrote `Unverified`, which is the vocabulary term `unverified`.

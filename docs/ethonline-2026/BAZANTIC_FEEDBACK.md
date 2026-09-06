# Bazantic — developer feedback from the vet402 A/B (ETHOnline 2026, Continuity)

Written for the judges and for Bazantic. Every number below is recomputed from the raw trial log
(`docs/ethonline-2026/ab/2026-09-06T213134Z/trials.jsonl`); the commands are at the end.
Bazantic account: **`TakeshiTGAL`**.

## 1. What we built on Bazantic

- **Gateway** `https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com` (upstream `vet402.com`, live since 2026-09-03, every route priced at 0 mcents).
  Its MCP endpoint `…/mcp` lists **57 tools**.
- **Recipe** `x402-payee-verification-via-vet402-gateway`, published 2026-09-07 06:15 JST at
  `https://bazantic.com/recipes/x402-payee-verification-via-vet402-gateway`. The copy the harness feeds to condition B
  (`examples/ethonline-2026-ab/recipe/x402-payee-verification.json`) has the same `description` as the public page, byte for byte.
- **Harness** `examples/ethonline-2026-ab/` — pre-registered in `docs/ethonline-2026/WINDOW_PLAN.md §16` on 2026-09-05, before any real trial.

## 2. The A/B

**Task (both conditions):** *Before you pay this x402 endpoint, establish whether the payee has actually delivered before. If there is no evidence, do NOT pay, and give your reason as machine-readable codes.*

**Design.** Same model (`claude-opus-5`, effort `high`), same prompt, same 57 MCP tools, same raw API list. Condition B additionally receives the Recipe text. The Recipe is the only difference: a test pins `stripRecipe(B) === A` byte for byte. `temperature` was not sent — the model rejects it — so it is `null` in both conditions (a recorded pre-registration deviation).

**Fixtures (oracle = what vet402's own API returns):** F1 a payee with delivered purchases (proceed); F2 The Graph's payee, not catalogued (`/decision` 404 → refuse); F3 a payee never bought from (`l1_not_attempted` → refuse); F4 a price above the caller's ceiling (`price_above_ceiling` → refuse). 10 trials per condition, 20 total, run once, not re-run.

**Success** = verdict matches the oracle **and** every reason code the agent gives appears in the oracle's codes **and** the list is non-empty when the answer is refuse (amendment of 2026-09-05 10:55, before data).

| condition | success | verdict match | codes ⊆ oracle | fabricated ≥1 | errors | unparseable |
|---|---|---|---|---|---|---|
| A (no Recipe) | **5/10** | 10 | 5 | 5 | 0 | 0 |
| B (Recipe) | **5/10** | 9 | 6 | 4 | 0 | 1 |

Per fixture, both conditions: F1 3/3 · F2 0/3 · F3 2/2 · F4 0/2. **Delta = 0.** Our pre-registered prediction ("A gets the verdict right but fabricates reasons") was half right: A fabricated in 5/10, but B failed the same two fixtures.

**Exploratory metric (not pre-registered, not used for scoring).** Share of reason codes that are real vet402 identifiers — the closed vocabulary in `src/lib/observatory/vocabulary.ts`, the SDK's refuse reasons in `examples/ethonline-2026-demo/src/judge.ts`, or a code the API actually returned in this run: **A 19/32 (59%) vs B 29/32 (91%)**. Trials in which every code was real: A 7/10, B 7/10. (WINDOW_PLAN §16.3 reports 2/32 vs 10/32 for the same idea; that count is reproduced exactly by the two source files alone, which store the tier codes `l0_pass`/`l1_delivered`/`l2_undeclared` decomposed, so it undercounts both sides. Direction is the same either way.)

An earlier run the same day (`ab/2026-09-06T093254Z`) scored 0/10 in both conditions because every tool call returned the Gateway's 402 text instead of data (§4). We kept that log, fixed the instrument, and re-ran under a new timestamp.

## 3. What the Recipe fixed, and what it did not

- **It fixed the vocabulary.** Without the Recipe the agent turns screen words into "codes": `WARN`, `thin`, `Unverified`, `receiving.paymentCount=0`, `resolve:endpoints=[]`. With the Recipe it uses vet402's words (`resource_uncatalogued`, `l1_not_attempted`, `evidence_unavailable`, `payee_recommendation_not_allow`).
- **It did not fix the verdict path on F2.** B lists *more* real codes than the oracle returns for that case (`evidence_unavailable`, `l1_not_attempted` on top of `resource_uncatalogued` + `payee_recommendation_not_allow`), so the subset rule fails. One B trial also wrapped its JSON in a code fence and was unparseable — that is a harness parser choice, counted as a failure.
- **F4 is our design hole, not the model's.** `price_above_ceiling` is a caller-side policy word from our SDK. No Gateway tool returns it and the Recipe prompt does not mention it, so neither condition can produce it. B invented plausible substitutes (`policy:amount_exceeds_ceiling`, `amount_exceeds_caller_ceiling`). A word that lives nowhere the agent can read will not appear, Recipe or not. Next step on our side: put the caller-policy codes in the Recipe prompt, or have a tool return them.

## 4. Gateway findings

1. **$0 routes still answer 402.** All 57 routes are at 0 mcents, yet every unpaid call gets a 402. The docs say only `tools/list` and price discovery are free; the body comes after payment. With `baz curl … --max-amount 0` (and with our own signer) the REST route returns 200 — after the facilitator posts a **0-USDC transfer on chain**.
2. **MCP `tools/call` cannot pay.** A `PAYMENT-SIGNATURE` header on the `/mcp` POST is ignored; the tool result is `isError: true` with the 402 body. `initialize.instructions` is null and no tool schema has a payment field.
3. **So a standard MCP client uses none of the tools.** "Add to Claude / Cursor / ChatGPT" connects, lists 57 tools, and every call returns 402 — including the 37 tools described as needing no key. Run `093254Z` measured exactly that: 0/10 and 0/10.
4. **Our bridge, and its cost.** `src/mcp.mjs` catches a 402 from `tools/call`, and only when the quoted amount is exactly `"0"`, re-sends the same resource as a signed REST `GET` and hands the model the real body (non-zero amounts fail loudly; nothing is signed). In the 20 trials: **110 tool calls, 88 settled with a 200 and 88 distinct on-chain transactions of 0 USDC**; the other 22 (12 × 404, 10 × 400 from the upstream) produced no transaction. **88 free reads cost 88 facilitator transactions.** Every tx hash is in `raw.toolCalls[].x402Bridge.txHash`.
5. **The "JWT that bypasses x402/MPP for testing"** mentioned in `#partner-bazantic` — we could not find it in the docs or the dashboard. If it exists, it is the cleanest path for judges; please point us to it.
6. **`baz recipe`** (`baz recipe install`, the documented way to run a public Recipe with a payer) is not in `@bazantic/cli@0.8.0` on npm; the docs run ahead of the CLI.
7. The public Recipe page (server HTML) shows name, author, description and the input form; the prompt text itself is not in it, so a judge cannot read the Recipe's instructions from the page alone.
8. One keystore-related item was sent privately to `support@bazantic.com` on 2026-09-06; it is intentionally not described here.

## 5. What would make this better for agents

- Let a 0-mcent route return its body without a settlement, or add a per-gateway "free below N" switch — a free read should not cost a chain transaction.
- Let MCP `tools/call` carry a payment (honour `PAYMENT-SIGNATURE`, or return the 402 as a structured `accepts` object the client can act on) so standard MCP clients can use paid tools at all.
- Ship `baz recipe` in the CLI, or remove it from the docs until it ships.
- Put the Recipe text into MCP `initialize.instructions` for the Gateway it belongs to — then "Add to Claude" delivers the Recipe without anyone pasting it.
- Show the Recipe prompt on the public page; a reviewer should not need an account to read what the agent is told.

## Recount commands

```bash
cd docs/ethonline-2026/ab/2026-09-06T213134Z
python3 - <<'EOF'
import json,collections
T=[json.loads(l) for l in open('trials.jsonl') if l.strip()]
for c in 'AB':
    ts=[t for t in T if t['condition']==c]; g=lambda k:sum(1 for t in ts if t['grade'][k])
    print(c,'success',g('success'),'verdictMatch',g('verdictMatch'),'subset',g('reasonSubset'),
          'fabricated',sum(1 for t in ts if t['grade']['fabricatedReasonCodes']),
          'errors',sum(1 for t in ts if t['error']),'unparseable',sum(1 for t in ts if t['answer']['unparseable']))
    pf=collections.Counter(); n=collections.Counter()
    for t in ts: n[t['fixtureId']]+=1; pf[t['fixtureId']]+=t['grade']['success']
    print(' per fixture',{f:f'{pf[f]}/{n[f]}' for f in sorted(n)})
tc=[c for t in T for c in t['raw']['toolCalls']]; b=[c['x402Bridge'] for c in tc]
print('toolCalls',len(tc),'settled',sum(1 for x in b if x['settled']),'distinct tx',len({x['txHash'] for x in b if x['txHash']}),
      'status',collections.Counter(x['responseStatus'] for x in b),'tools',len(T[0]['raw']['toolNames']))
EOF
# exploratory vocabulary metric
python3 - <<'EOF'
import json,re
V=set(re.findall(r'term: "([^"]+)"',open('../../../../src/lib/observatory/vocabulary.ts').read()))
J=set(re.findall(r'^\s*"([a-z_]+)",?$',open('../../../../examples/ethonline-2026-demo/src/judge.ts').read(),re.M))
T=[json.loads(l) for l in open('trials.jsonl') if l.strip()]
O=set(r for t in T for r in t['oracle']['reasonCodes']); S=V|J|O
for c in 'AB':
    codes=[r for t in T if t['condition']==c for r in t['answer']['reasonCodes']]
    print(c,f'{sum(r in S for r in codes)}/{len(codes)}')
EOF
```

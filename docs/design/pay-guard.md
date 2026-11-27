# Pay Guard for Celo / MiniPay — design (Track A, A0)

Status: **design + regression harness only** (vet402 product changes start **2026-12-08**, v3 C8 / Pay Guard §8.A).  
Normative spec: Pay Guard SPEC v2 (§4–§7, §8.A, §9, §10 Track A, §12); constraints v3 C1–C11.

This document maps SPEC modules E1–E5 and M2–M7 onto **existing code** in this repo. Names follow current exports unless a rename is justified below.

---

## 1. Scope and milestones

| Milestone | Window | This repo |
| --- | --- | --- |
| **A0** | ≤ 2026-12-03 | `docs/design/pay-guard.md`, `pay-guard-findings.md`, presign regression test (no `policy` field yet) |
| A1 | 2026-12-08+ | E1 `policy` + `guard`, `@vet402/sdk/guard` (M2) |
| A2 | ≤ 2026-12-09 | npm publish G9 |
| A3 | 2026-12-11+ | E2/E3/E4, M6 samples |
| A4+ | | MCP E5, UI M3, production keys (owner) |

Track B uses the same M1–M3 ideas but **not** E2/E4/E5/M6 in vet402 core (bundle receipt §4.5.2).

---

## 2. Module map (code reuse)

### M1 — Presign guard core (E1)

**Existing route:** `POST /api/v1/check/presign`  
- Route: `src/app/api/v1/check/presign/route.ts` → `handleKeylessCheckRoute` + `handlePresign`  
- Logic: `src/lib/api/presign-handler.ts`  
- Rate limit bucket: `rest:presign` (shared with check)

**Reuse (do not reimplement):**

| Concern | Function / module |
| --- | --- |
| Parse 402 body / wrapper | `parsePresignBody`, `resourceUrlOf`, `PRESIGN_MAX_BODY_BYTES`, `PRESIGN_MAX_ACCEPTS` |
| Seller verdict + cache | `getCheckSellerCached`, `checkSeller` (`src/lib/api/check-seller-cache.ts`, `src/lib/mcp/tools.ts`) |
| Per-accept terms vs vet402 record | `compareAccepts`, `matchDeclaredPayTerms`, `normalizeAccept` (`presign-handler.ts` imports `packages/sdk/src/terms-match.ts`) |
| 402 contradiction words | Same as SDK: `payee_mismatch`, `price_above_declared`, `chain_or_asset_mismatch` (via `matchDeclaredPayTerms`) |
| Signed JSON response | `signedJson` (`src/lib/signing/response-signature.ts`) |
| Query guard | `rejectUnknownQuery` (`src/lib/api/export-guard.ts`) |
| Client daily counts | `handleKeylessCheckRoute` → `recordClientUsage` (existing presign path) |

**Caller policy mirror (for E1 `policy` evaluation):**  
`evaluateCallerPolicy`, `parseCallerPolicy`, `CALLER_POLICY_REASONS`, `DEFAULT_MAX_PER_TX_USD` — `src/lib/decision/caller-policy.ts`  
Today wired on `GET /api/v1/resources/{resourceId}/decision` (`src/app/api/v1/resources/[resourceId]/decision/route.ts`). E1 should **reuse the same evaluator** with JSON `policy` instead of query params, and map verdict to Pay Guard `decision` PAY | ASK | REFUSE per §4.3.

**Proposed extension (A1, names TBD in implementation PR):**

1. `parsePresignPolicy(body.policy)` — parallel to `parseCallerPolicy`, plus `mode`, `unverified_max_usd`, `fail_open_max_usd` (SDK defaults).  
2. `evaluatePayGuardDecision(...)` — new thin module calling:
   - `compareAccepts` + selected accept index  
   - `evaluateCallerPolicy` on check output  
   - §4.3 WARN / strict / advisory rules  
   - §4.6 fail-soft  
3. Response adds **`guard`** object only when `policy` present; legacy fields unchanged (N1).

**Naming note:** SPEC says `guard`; `/decision` uses `caller_policy`. **Recommendation:** keep **`caller_policy` semantics inside server** but expose SPEC field name `guard` on presign to avoid breaking decision clients. Implement mapping in one file (`presign-guard.ts` or extend `presign-handler.ts`).

**Verdict receipt:** check path already uses `signVerdictReceipt` / `verifyVerdictReceipt` (`src/lib/receipts/verdict-receipt.ts`). Presign may attach `receipt` when signing key is set (align with check). Not in current presign body — add in A1 if SPEC requires linkage to `presign_receipt_sha256` on E2.

### M2 — SDK `@vet402/sdk/guard` (planned export path)

**Reuse from `packages/sdk/src/pay-or-refuse.ts`:**

| Capability | Existing symbols |
| --- | --- |
| Policy ceiling / L1 floor / require allow | `PayPolicy`, `evaluateMoneyGate`, `requireVet402Allow`, `DEFAULT_MAX_PER_TX_USD` |
| Refuse reason vocabulary | `PAY_REFUSE_REASONS`, `PayRefuseReason` |
| Terms vs 402 | `matchDeclaredPayTerms`, `normalizeAccept` (`terms-match.ts`) |
| Server policy parity | reads `decision.caller_policy` (migrate to presign `guard.reason_codes` for E1) |
| User-agent on vet402 calls | `clientIdentityHeaders` (`user-agent.ts`) |

**New surface (A1/A2):**

- `withPayGuard(client, opts)` — wraps `@x402/core` client `onBeforePaymentCreation` → POST E1 with `policy` + `client` string.  
- `guardedFetch(fetch, opts)` — orchestrates E1, optional `onAsk`, idempotency store, E2 bundle.  
- Idempotency: new module; follow `auth-capture.ts` nonce patterns and `authorizationState` read via viem (peer).  
- Fail-soft §4.6: client-side cache of last ALLOW payTo (24h); fields `fail_mode_applied`.

**Parity tests:** extend `tests/decision-caller-policy.test.ts` patterns to presign + `tests/caller-policy-sdk-parity.test.ts`.

### M3 — UI (A5)

Out of A0. Copy rules §4.4 (MiniPay Design Standards). No new code in A0.

### M4 — Delivery receipt (E2, E3)

**Reuse:**

| Piece | Module |
| --- | --- |
| On-chain payment read | `readPaymentOnChain`, `classifyPaymentNetwork`, `handlePaymentProof` (`src/lib/payment-proof/handle.ts`, `chain.ts`) |
| Verify EIP-191 receipts | `verifyVerdictReceipt` (`src/lib/receipts/verdict-receipt.ts`) — extend for `kind: "delivery"` on E3 |
| Signing pattern | Same as verdict receipt; **new env** `VET402_DELIVERY_RECEIPT_SIGNER_KEY` (staging in dev) |

E2 route: new `src/app/api/v1/receipts/delivery/route.ts` (name per openapi convention).  
E3: extend `src/app/api/v1/receipts/verify/route.ts` dispatcher by `kind`.

### M5 — Allowlist (E4)

**Reuse data rules:** v3 D3 / I4 — delivered in 30d or claim.  
**Reuse queries:** patterns from seller page indexability (`src/lib/judgments/`, observatory L1 tables — read-only design in A3).  
New: `GET /api/v1/guard/allowlist` + EIP-191 signature (separate key), ETag, dual-case `value` / `value_checksum` for Privy (§4.5 E4).  
**C1:** never list undelivered payTo; only positive allowlist.

### M6 — Privy adapter (sample)

**Repo samples only (A3):**  
- `syncAllowlistToPrivyConditionSet` → fetch E4, diff PUT (Privy API; owner credentials).  
- 2-of-2 co-sign server → calls E1, signs only on `guard.decision === "PAY"`.

Privy hook gap: see `pay-guard-findings.md` Q2 — plan **402 → E1 → wrapFetchWithPayment** fallback.

### M7 — MCP (E5)

**Host:** `src/app/api/mcp/route.ts`, tool registry `src/lib/mcp/tools.ts`.

| Tool | Maps to |
| --- | --- |
| `guard_x402_payment` | E1 body (same schema as presign) |
| `issue_delivery_receipt` | E2 |

Reuse `check_x402_seller` tool wiring; do not alter existing tool contracts (§4.5 E5).

---

## 3. E1 schema (design)

### Request (additive)

```json
{
  "challenge": { "...": "402 body" },
  "url": "https://...",
  "method": "GET",
  "policy": {
    "mode": "advisory",
    "amount_usd": 0.005,
    "max_per_tx_usd": 1,
    "unverified_max_usd": 0.05,
    "require_vet402_allow": false
  },
  "client": "vet402-pay-guard/0.1; app=demo"
}
```

All optional. Unknown keys in `policy` → 400 (`invalid_policy`) aligned with decision route.

### Response (additive)

```json
{
  "guard": {
    "guard_version": "1",
    "decision": "PAY",
    "mode": "advisory",
    "reason_codes": [],
    "selected_accept_index": 1,
    "amount_usd": 0.005,
    "evaluated_at": "2026-11-28T00:00:00Z",
    "fail_mode_applied": "closed"
  }
}
```

Omitted entirely when `policy` absent (N1). Existing top-level fields stay as today (`recommendation`, `accepts`, `rules_version`, …).

### reason_codes and decision (§4.3)

| Condition | decision | reason_codes (reuse SDK / caller_policy) |
| --- | --- | --- |
| terms mismatch | REFUSE | `payee_mismatch`, `price_above_declared`, `chain_or_asset_mismatch` |
| vet402 BLOCK | REFUSE | existing check `reason_codes` + `payee_recommendation_block` when policy applies |
| vet402 ALLOW, over max | REFUSE | `price_above_ceiling` |
| vet402 WARN, advisory, under unverified cap | ASK (UI) / PAY (agent per §4.3) | `payee_recommendation_not_allow` in strict; budget `unverified_budget_exceeded` |
| vet402 unreachable | §4.6 | `fail_mode_applied: open\|closed` |

Evaluator order matches `evaluateCallerPolicy` then accept selection + terms.

---

## 4. E2 / E3 delivery receipt (sketch)

Payload §4.5.1 `vet402.delivery-receipt.v1`.  
`payment` parsed via same path as `handlePaymentProof`.  
`delivery_claim` is buyer assertion only (C10).  
Storage: default none (`Cache-Control: private, no-store`); optional `store=true` with Pro key (v3 §10.2).

E3 `verifyVerdictReceipt` extension: accept `kind: "delivery"` and new message layout (domain line `vet402.com delivery receipt`).

---

## 5. E4 allowlist (sketch)

`GET /api/v1/guard/allowlist?network=eip155:42220&format=privy`  
Response: `items: [{ value, value_checksum }, …]`, `signature`, `rules_version`, `generated_at`, `ETag`.

Generation: daily job (new cron design); sign with allowlist key. Tests: no undelivered payTo (§10 Track A).

---

## 6. SDK guard API (sketch)

Export: `packages/sdk/src/guard/index.ts` → `@vet402/sdk/guard` subpath in `package.json` exports.

```ts
withPayGuard(x402Client, { presignUrl?, policy, onAsk?, timeoutMs?, client? })
guardedFetch(fetch, { walletAdapter, policy, intentKey?, idempotencyStore?, onAsk?, receipts? })
createIdempotencyStore('memory' | 'localStorage' | custom)
```

Celo constants: **`CHAIN_PROFILES.celo`** (`packages/sdk/src/chain-profile.ts`), not hard-coded in guard logic (§4.7).

---

## 7. KPI K1–K10 (Track A measurement)

| ID | Definition | Source in repo (to implement in I0) |
| --- | --- | --- |
| K1 | Distinct `client` strings calling E1 with `policy`, 7d, excl. C6 | `client_usage_daily` route `rest:presign` + parse `client` header/body field |
| K2 | Daily presign+policy counts by `guard.decision` and network | Extend event log / usage row metadata |
| K3 | REFUSE count and sum `amount_usd` by reason | Aggregate from logged `guard` |
| K4 | Idempotency prevented resign (opt-in SDK telemetry) | New anonymous endpoint or header — opt-in only |
| K5 | Delivery receipts issued / verified | E2/E3 access logs (no IP store, C7) |
| K6 | Celo endpoints with L1 in 30d / active Celo endpoints | `observatory/state` byChain + catalog sync metrics |
| K7 | E1 server p50/p99 (policy series) | Extend `public/data/presign-latency.json` pipeline (`scripts/presign-latency-probe.ts`) |
| K8 | REFUSE payTo that delivered within 7d | Batch job comparing guard logs to L1 — design with C10 |
| K9 | npm `@vet402/sdk` downloads | External npm API (report only) |
| K10 | Track B only | N/A Track A |

Schema: align with `docs/kpi-definitions.md` and monthly freeze (v3 I0). C6 exclusion list reused.

---

## 8. Test plan vs §10 acceptance (Track A)

| Criterion | Planned test (offline unless noted) |
| --- | --- |
| Policy-less E1 byte-stable | `tests/pay-guard-presign-regression.test.ts` + fixture `tests/fixtures/pay-guard-presign-no-policy.golden.txt` |
| 402 mismatch → no sign | `packages/sdk/test/pay-or-refuse.test.mjs` + guard tests mocking signer |
| BLOCK / ALLOW / WARN advisory vs strict | Port matrices from `decision-caller-policy.test.ts` to presign with `policy` |
| vet402 down → fail-soft | SDK unit tests with timeout/5xx stubs |
| Idempotency | Sepolia integration (A1+); store unit tests |
| Decimal assets USDC/USDm | `terms-match` / Celo lane tests (`tests/x402-celo-lane.test.ts`) |
| C1 no undelivered names in fixtures | `rg` gate in CI (existing pattern) |
| G6 no MiniPay false claims | `rg` gate on docs/UI strings |
| E2 verify / tamper | `verdict-receipt` pattern + delivery message tests |
| E2 no DB write by default | mock DB assert zero inserts |
| E4 allowlist C1 | fixture payTo set ⊆ delivered∪claim |
| No Celo priced vet402 route before G3 | existing CI grep on accepts `eip155:42220` pricing |
| G4 spend caps | config constants + unit test (0 before 12/8) |
| Privy sync no-op on bad signature | adapter sample test |
| p99 ≤ 300ms | `presign-latency.json` + probe script (report if failing) |
| npm + 7-day MiniPay rule | release checklist G9 |

---

## 9. Regression (A0 delivered)

**Test:** `tests/pay-guard-presign-regression.test.ts`  
**Fixture:** pinned wire snapshot (status, cache-control, content-type, x-robots-tag, Vet402-Signature, Server-Timing, JSON body).  
Asserts no `policy`, `guard`, or `caller_policy` keys.  
Update fixture only via `UPDATE_PAY_GUARD_PRESIGN_GOLDEN=1` (intentional).

---

## 10. Rename proposals

| SPEC / idea | Current name | Proposal | Reason |
| --- | --- | --- | --- |
| E1 policy field | N/A (decision uses query) | Keep `policy` JSON; map to `CallerPolicyInput` internally | One parser for query + body |
| Exposed block | `caller_policy` on `/decision` | **`guard` on presign only** | SPEC E1; avoid breaking REST decision |
| New module | — | `src/lib/api/presign-guard.ts` | Keep `presign-handler.ts` under 300 lines; tests import evaluator alone |

No renames of `matchDeclaredPayTerms`, `evaluateCallerPolicy`, or `payOrRefuse` — vocabulary parity is tested.

---

## 11. Related findings

See **`docs/design/pay-guard-findings.md`** (Q2, Q6, Q9, Q10, CORS, gas, buy catalog counts).
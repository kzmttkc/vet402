# Pay Guard: A0 findings (Track A)

`retrievedAt`: 2026-11-28 08:30 JST (2026-11-27 23:30 UTC)

Sources: production HTTP probes, public CSV/RPC, npm pack (no install into this repo).

---

## Q9 / N7: CORS on E1 and payment / receipt routes

### Code (this repo)

| Route | Handler | OPTIONS |
| --- | --- | --- |
| `POST /api/v1/check/presign` | `src/app/api/v1/check/presign/route.ts` | `exportDisallowedMethodHandlers(["POST"])` → 405 JSON (`method_not_allowed`), no CORS headers |
| `POST /api/v1/payment-proof` | `src/app/api/v1/payment-proof/route.ts` | same pattern |
| `POST /api/v1/receipts/verify` | `src/app/api/v1/receipts/verify/route.ts` | same pattern |

CORS with `Access-Control-Allow-Origin` is implemented for `src/app/api/mcp/route.ts` only (MCP host), not for these REST routes.

### Production OPTIONS (2026-11-28)

Command: `curl -sIL -X OPTIONS https://vet402.com/api/v1/check/presign` (same for `payment-proof`, `receipts/verify`).

| Path | Status | `Access-Control-*` | `Allow` |
| --- | ---: | --- | --- |
| `/api/v1/check/presign` | 405 | **none** | `POST` |
| `/api/v1/payment-proof` | 405 | **none** | `POST` |
| `/api/v1/receipts/verify` | 405 | **none** | `POST` |

`connect-src 'self'` on the site CSP also blocks browser calls from other origins unless a dedicated CORS layer is added.

**Implication for Track A (N7):** browser-side SDK (`guardedFetch`) cannot call E1 from a MiniPay web view without CORS work (likely `OPTIONS` 204 + `Access-Control-Allow-Origin` on presign, payment-proof, and planned E2). Server-side agent path is unaffected.

---

## Q6: Celo L1 payment gas (G3 input)

### Inputs

- CSV: `https://vet402.com/api/v1/observatory/export.csv?days=366` (fetched 2026-11-28).
- Filter: `network == eip155:42220`, `status == settled`, non-empty `tx_hash`.
- Unique tx hashes: **563**.
- RPC: `https://forno.celo.org`, method `eth_getTransactionReceipt`.

### Results

| Metric | Value |
| --- | ---: |
| Receipts returned | 236 |
| No receipt / RPC null | 327 |
| Median gas cost | **0.017171 CELO** |
| p90 gas cost | **0.017276 CELO** |
| Min / max (sample with receipt) | 0.017160 / 0.020717 CELO |

Cost per tx: `gasUsed × effectiveGasPrice` (wei → CELO, divide by 1e18).

### USD (indicative)

| | |
| --- | ---: |
| CELO/USD | **0.061287** |
| Source | CoinGecko `simple/price?ids=celo&vs_currencies=usd`, 2026-11-28 |
| Median ≈ USD | **~$0.00105** |
| p90 ≈ USD | **~$0.00106** |

(Estimate) 327 missing receipts may include non-EVM-style settlement refs, pruned history, or rate/noise; follow-up can re-query failed hashes slowly. Payment gas here is **payer-side** L1; Celo x402 facilitator gas sponsorship for buyers is separate.

G3 remains: do not price vet402 Celo x402 at 0.005 USDC until margin KPI confirms; this sample suggests chain gas is small vs 0.005 USDC but does not include facilitator fee.

---

## Q2: Privy `useX402Fetch` / `createX402Client` (npm types only)

Package: `@privy-io/react-auth@3.52.1` (`npm pack` into `/tmp`, read `dist/dts/index.d.ts`). **No repo install.**

| Question | Finding |
| --- | --- |
| `createX402Client` | **Not exported** in this package’s public `.d.ts` (grep: no symbol). |
| `useX402Fetch` | **Present.** Returns `{ wrapFetchWithPayment }` only (hook does not accept chain config). |
| Celo `eip155:42220` | **Not named** in `useX402Fetch` types. `wrapFetchWithPayment` accepts `walletAddress`, `fetch`, optional `maxValue`, `allowedAssets`, `paymentRequirementsSelector`, `signatureOptions`. Network choice is via **`paymentRequirementsSelector(paymentRequirements, network?, scheme?)`** where `network` is `string \| string[]` - caller can pass `eip155:42220` when selecting among accepts. |
| External pre-pay hook | **No** `onBeforePaymentCreation` in Privy types. Only extension points seen: `paymentRequirementsSelector`, `allowedAssets`, `signatureOptions`. |
| Deprecation note in types | `config.svmConfig` marked deprecated; comment says payments are signed with EVM wallets. |

**Design impact (§4.2):** Pay Guard should assume **prefetch 402 → vet402 E1 → pay** for GET-safe paths, or wrap at `paymentRequirementsSelector` / fetch layer, not inside Privy’s signer. `withPayGuard` on `@x402/core` client remains the primary integration.

---

## Q10: buy gateway routes vs vet402 catalog

Public data (2026-11-28):

| Source | Count | URL |
| --- | ---: | --- |
| buy gateway catalog (`capabilities`, `available: true`, with `url`) | **150** | `https://gateway.usebuy.ai/v1/catalog` |
| vet402 operator listings (checked-in Celo usebuy routes) | **7** | `src/lib/observatory/operator-listings.ts` |

Bulk `GET /api/v1/resolve?url=…` against all 150 buy URLs hit **rate limit** before completion; no per-seller names are recorded here (C1).

**Conservative statement:** vet402’s catalog intentionally contains **7** operator-synced gateway routes today; buy’s public catalog lists **150** paid capabilities - **most are not** in vet402’s index yet (consistent with SPEC §1.4: Celo catalog 17 endpoints, buy representative route often `l1_not_attempted`). Full pairwise match needs a slow resolve pass or DB read after 12/8 expansion (G4).

---

## Presign p99 (A0 note)

Public: `https://vet402.com/data/presign-latency.json` (retrieved 2026-11-28). Warm, same seller within the 60-second cache (measured 2026-11-27T23:03Z): server p50 23.7 ms, p99 117.6 ms, `target_met: true` against 300 ms. First check of 99 distinct sellers, each URL sent once (a value another caller left in the last 60 seconds can still be reused; measured 2026-11-28T00:08Z): server p50 574.4 ms, p99 2533.9 ms. The 300 ms target is met warm only; the SDK prewarm step in `pay-guard.md` section 2a moves the payment-time call into the warm series.
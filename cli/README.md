# vet402 reproducibility CLI

Reproduce vet402's measurements yourself, with the exact same code the
production Observatory runs. No API key, no account.

```bash
git clone https://github.com/kzmttkc/vet402 && cd vet402 && npm install

# 1. Probe a payment wall (same L0 code, SSRF guard included)
npx tsx cli/probe.ts https://api.example.com/paid --method POST

# 2. See exactly what the buyer would sign — without signing anything
npx tsx cli/purchase-dry-run.ts https://api.example.com/paid --method POST

# 3. Verify the public ledger hash chain (third-party check, public API only)
npx tsx cli/verify-anchors.ts --days 30
```

## What is and is not third-party reproducible today (honest table)

| Claim | Reproducible by you | How |
|---|---|---|
| An endpoint's live L0 verdict | ✅ fully | `cli/probe.ts` — same code path |
| What vet402 would/would not sign against a wall | ✅ fully | `cli/purchase-dry-run.ts` (no keys involved) |
| Anchor chain linking and continuity (each day's `prevRoot` is the previous day's root; no day missing) | ✅ fully | `cli/verify-anchors.ts` over the public API. This shows the published chain is self-consistent; while no root is fixed on-chain (`anchoredTx` empty), it does not rule out the whole chain being recomputed — save a root to detect that later |
| A specific day's root recomputed from raw rows | ❌ not from published data | The projection is open source (`src/lib/observatory/anchors.ts`), but it hashes fields `export.csv` leaves out (row id, payer, asset, sub-second time, and the statuses the export omits), so vet402's roots cannot be rebuilt from the published files. A self-hosted stack (`docker compose up`) computes the same kind of chain over its own ledger |
| A real L1 purchase | ⚠️ your own funds | The live purchase path exists only inside the audited daily runner (budget-reserved); the CLI deliberately has no key-reading code |

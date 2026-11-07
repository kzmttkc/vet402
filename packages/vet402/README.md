# vet402

Put vet402 between AI agents. Both sides trade safely.

One package for both sides of an x402 payment. The buyer side is
[`@vet402/sdk`](https://www.npmjs.com/package/@vet402/sdk) and the seller side is
[`@vet402/middleware`](https://www.npmjs.com/package/@vet402/middleware), under one name.

> Not yet on npm. Until it is, install the two packages it is built on:
> `npm install @vet402/sdk @vet402/middleware`.

Setup guide for each stack: [vet402.com/connect](https://vet402.com/connect).
A free API key: [vet402.com/signup](https://vet402.com/signup). `check` works without one
(10 requests/min per IP).

## Buyer: check a URL before paying

On npm today, with `@vet402/sdk`:

```typescript
import { createVouchClient } from "@vet402/sdk";

const vouch = createVouchClient({ apiKey: process.env.VOUCH_API_KEY });
const found = await vouch.resolve("https://api.example.com/v1/quote");
const resourceId = found.resource?.resource_id; // undefined when vet402 has no record of the URL
const d = resourceId ? await vouch.getDecision(resourceId, { role: "payer" }) : null;
console.log(d?.recommendation); // ALLOW | WARN | BLOCK
```

From this repository (not on npm), the same read is one call:

```typescript
import { check } from "vet402";

const r = await check("https://api.example.com/v1/quote");
console.log(r.recommendation); // ALLOW | WARN | BLOCK, or UNKNOWN when vet402 has no record of the URL
```

For a URL on record, `r` also carries `reasonCodes`, `verifiedTerms` (`pay_to`, `amount` and `network` of
the last purchase where content came back), `resourceId`, `evidenceUrl` (the public record),
`retrievedAt` (when check read the decision) and `scoredAt` (when vet402 scored it). A URL without
a record answers `{ recommendation: "UNKNOWN", reason }`. A network error throws an `Error` whose
message starts with `vet402: could not reach`.

## Buyer: pay when the rule passes

On npm today, `import { payOrRefuse } from "@vet402/sdk"` is the same function as `vet402/buyer` exports:

```typescript
import { payOrRefuse } from "@vet402/sdk";

const payee = "0x..."; // the payTo in the seller's 402
const account = yourSigner; // a signer, see the payOrRefuse section of the @vet402/sdk README
const resource = "https://api.example.com/v1/quote"; // the URL you pay for
const r = await payOrRefuse({ payee, resource, amountUsd: 0.01, fetch, account, network: "base-sepolia" });
// r.status is "paid" after the checks pass. "refused" stops before a signature, with r.decision.reason_codes.
```

`vet402/buyer` re-exports everything public from `@vet402/sdk` (`payOrRefuse`, `SpendGuard`,
`createVouchClient`, ...) plus `check`. The full `payOrRefuse` contract is in the
[`@vet402/sdk` README](https://github.com/kzmttkc/vet402/tree/main/packages/sdk#readme).

## Seller: gate a paid route

On npm today, `@vet402/middleware` exports the same `createTrustGate` as `vet402/seller`:

```typescript
import { createTrustGate } from "@vet402/middleware";

const payerAddress = "0x...";
const gate = createTrustGate({ apiUrl: "https://vet402.com/api/v1", apiKey: process.env.VOUCH_API_KEY! });
const decision = await gate.evaluate(payerAddress); // decision.action: "allow" | "warn" | "block"
```

`vet402/seller` re-exports everything public from `@vet402/middleware`. The Express, Next.js and
Hono adapters stay at `@vet402/middleware/express`, `/next` and `/hono`.

## License

MIT

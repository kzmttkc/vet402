# vet402 x ENSv2: ETHGlobal Tokyo 2026 demo

An agent pays an x402 seller on Base Sepolia only after it checks an ENSIP-29 draft attestation stored in the seller's ENSv2 name on Sepolia.
The check compares the seller's `x402-offer` record (price, payTo and URL in one value) with the signature of `atst.vet402.eth`, in the draft's seven steps, on two RPC providers at one pinned block.
When one character of the offer changes, the signature no longer matches and the agent refuses to pay.

Try it live: <https://vet402.com/tokyo?name=seller-a.eth>. vet402 and `@vet402/sdk` existed before the event (tag `pre-tokyo-2026`); everything in `git log pre-tokyo-2026..tokyo-2026-submission` was made during it, and [`../../AI_USAGE.md`](../../AI_USAGE.md#ethglobal-tokyo-2026) says who did what.

## Check it yourself (one line)

```
git clone --depth 1 --branch tokyo-2026-submission https://github.com/kzmttkc/vet402 && cd vet402/examples/tokyo-2026-demo && npm ci && npm run verify -- seller-a.eth
```

`verify` only reads. It signs nothing and sends nothing. It needs Node 22.18 or later and no keys. It prints the seven steps and ends with `VALID` or `REFUSE <reason>`. The attester address it trusts comes from `trusted-attesters.json` in this folder. The two Sepolia RPCs default to public endpoints; `ENS_SEPOLIA_RPC_URL` and `ENS_SEPOLIA_RPC_URL_2` override them, and they must be two different providers.

## Commands

The demo commands live in `src/run.ts`. Each `npm run` script below calls it.

| Command | What it does |
|---|---|
| `npm run verify -- <name> [--resource URL] [--method GET\|POST] [--attester name=0x…] [--json] [--strict]` | The seven-step check, read only. Exit 0 when the check ran (VALID or a refusal), 1 when it could not run, 2 with `--strict` when the offer is refused, 3 when the RPCs could not give evidence |
| `npm run census -- <name> [<name> ...] [--json]` | One row per name (owner, resolver, addr, `x402-offer` size, `agent-endpoint[x402]`, attestation), then the K1 judgement line |
| `npm run pay -- <name> [--dry-run \| --live] [--test-attester]` | The payment path, one line per stage: screening, agent policy, the seven ENS steps, the vet402 API, chain receipts, the live 402, a recheck, the signature. `--dry-run` is the default and stops before anything is signed |
| `npm run cut-vet402 -- [--mode refused\|503] [pay <name> ...]` | Makes the vet402 API unreachable for later `pay` runs (or for one `pay` when it follows on the same line) |
| `npm run cut-vet402 -- --restore` | Undoes `cut-vet402` |
| `npm run mutate -- [--dry-run \| --live] [--test-attester]` | Changes `amount` in `seller-a.eth`'s `x402-offer` from `10000` to `10001` with the seller's server key (W_op) |
| `npm run reset -- [--dry-run \| --live] [--test-attester]` | Puts `seller-a.eth`'s `x402-offer` back to `10000` |
| `npm run scene3 -- [--dry-run \| --live] [--test-attester] [--assume-align-bc]` | In a fixed order: unlink `seller-b.eth`, relink it, link `seller-c.eth` to `seller-b.eth`'s record, relink `seller-c.eth` to its own record. It runs `verify` after each step and always ends with `seller-c.eth` back on its own record |
| `npm test` | The demo's tests (`node --test`) |

`--dry-run` never signs a transaction or a payment: `mutate`, `reset` and `scene3` run on `eth_simulateV1`, and `pay` runs every SDK gate and stops at a payer that holds no key. `--live` checks the chainId, simulates the transaction alone, checks the signer's balance, and sends nothing until a person types `y`. `--test-attester` works only with `--dry-run`: inside the simulation a public test key stands in for `atst.vet402.eth`.

`pay` needs `TOKYO_W_PAY_ADDRESS` (the payer's address) and an Intercepta key file (see below). Without `VET402_API_KEY`, vet402's `/payees/{payTo}/score` answers 401 for this seller and `pay` refuses with `evidence_unavailable` (measured 2026-09-25), unless `cut-vet402` is on. `--agent <name>` picks the agent whose `x402-policy` is read (default `agent-1.vet402.eth`).

### Operator commands

These set up and maintain the Sepolia names. They need the owners' keys and are not needed to check anything.

- `npm run attester -- --names seller-a,seller-b,seller-c,seller-d [--dry-run | --live-pay] [--no-screen] [--allow-unknown]`: vet402 buys from each seller with W_pay, checks the delivery, and only then signs with `atst.vet402.eth`'s key. The six steps are in `docs/tokyo-2026/attester-spec.md`.
- `npm run observe -- <resourceId> [<resourceId> ...] [--dry-run | --live | --check]`: writes the observation log for third-party x402 sellers under `<resourceId>.obs.vet402.eth`, with no addr record.
- `npm run admin -- <command> [--dry-run | --live]`, where `<command>` is one of `deploy-resolvers`, `k1a`, `k1b`, `register-d`, `publish-attestations`, `unlink`, `link`, `relink`, `agents`, `register-e`, `set-offer-e`, `align-bc`, `agent-off`, `agent-on`, `emancipate`. An unknown command prints the list with one line each.
- `npx tsx src/keys.ts init | addresses`: creates the testnet keys in `.env.tokyo.local` (git-ignored) and prints only addresses.

## Payment screening (Intercepta)

- The only file that calls the Intercepta API is `src/screening.ts`: `quick-scan` for the payTo and the payer, and `check-activity` (Base mainnet, chainId 8453) for the payTo when quick-scan has nothing on it. Its tests are in `test/screening.test.mjs`.
- `pay <name>` screens first. It reads the payTo from the seller's `x402-offer` once, then quick-scans that payTo and the payer. This happens before any proof is checked, before the agent policy is read, and before vet402 is asked.
- A block or an unavailable answer stops the payment, with the reason on screen: `payee_screening_blocked` (a listed trait, or `toxicScore` of 70 or more) or `payee_screening_unavailable` (404, no answer within 3 s, any other non-200, a body that is not the documented shape, or no key file; the same for `check-activity`). Nothing is paid in either case. The key is read from `~/.vet402/intercepta-sandbox-key.txt` (`INTERCEPTA_KEY_FILE` overrides the path) and goes only into the request header.
- `toxicScore 0` with no traits is printed as `(no risk record)`, not as clean: a fresh address gets the same answer. For the payTo the demo then asks `check-activity`. `hasActivity: false` makes the payTo `unknown` (an unknown counterparty).
- An unknown payTo: `pay` goes on only when the offer asks at most 0.01 USDC, and pays only when the ENS attestation is `VALID` (the `[U]` line gives that reason). Above 0.01 USDC it stops with `payee_unknown_needs_human`. `attester` does not buy from an unknown payTo unless `--allow-unknown` is given.
- `src/attester.ts` uses the same module at its gate (3), before `payOrRefuse`, in every run (dry run included). `--no-screen` (dry run only) skips it, so the same command can be run without screening ("before") and with it ("after").
- Answers (pass, block, unknown) are kept for 10 minutes on disk in `out/screening-cache.json`, shared by `pay` and `attester`, so repeated runs do not spend the 1,000-call quota. A line served from it ends with `(cached, asked HH:MM:SS UTC)`. Unavailable answers are not kept.
- The `/tokyo` page and its API routes do not call Intercepta (`tests/tokyo-mutate.test.ts` checks this).
- The payments here are on Base Sepolia. quick-scan takes no chain parameter, so the demo sends the same address, and the answer does not say which chain's history it used.

Notes from using the API:

- The quick-scan answered in about 0.44 s (one call from Tokyo, 2026-09-24).
- The `traits` names come from a fixed list, so the blocking rule is a plain list in code. `known_scammer`, `sanction_address` and `blacklist` all came back in real answers (2026-09-25).
- `traits[].txsCount` is marked required in the OpenAPI document, and it was not in the live answers (two calls, 2026-09-25). The demo reads it as optional.
- A contract address answered 404 with no body (2026-09-24). The demo treats that as unavailable and does not pay.
- A fresh address with only a few transactions (the demo's payer, 2026-09-25) came back as `toxicScore 0` with empty `traits`, the same shape as an address that was screened and found clean. This is why the demo says "no risk record" and asks `check-activity` for the payTo.
- `check-activity` (`/api/public/v1/.../check-activity?chainId=8453`) answered `{"hasActivity":false}` for seller-a.eth's payTo in about 1.4 s (one call, 2026-09-26). Its `chainId` list has Base mainnet (8453) but not Base Sepolia (84532), so the answer is about Base mainnet.
- What was missing: the `chainId` list of Scan Message in the OpenAPI document has no 84532, so the demo could not have Intercepta check what the payer signs for a Base Sepolia payment (the EIP-3009 authorization). Only the addresses were screened.

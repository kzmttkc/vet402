# Base Builder Grants — nomination pack (ready to submit)

> Program: Base Builder Grants, 1–5 ETH, **retroactive** (shipped work only).
> Primary check 2026-08-23: [docs.base.org/get-started/get-funded](https://docs.base.org/get-started/get-funded) lists it as accepting applications; the [grants.base.eth post](https://paragraph.com/@grants.base.eth/calling-based-builders) states there is **no application form** — "We will mostly be relying on our own discovery process to find these grantees, but if you want to nominate someone you can submit a nomination here." The nomination Google Form is the only external submission path. No response is guaranteed. Recipients complete W8/W9.
>
> Nothing in this pack promises `payOrRefuse` or any other frozen Continuity verb (`docs/hackathons/GRANTS.md` §5). Everything cited is live today.

## Why this program, and why now

Base is **not** an ETHOnline 2026 partner (`../ethonline-2026/PRIZES.md`, measured 2026-08-23). Prizes cannot route Base money to us this autumn. Grants are the only Base path, and this one is retroactive — it pays for what already runs, so it collides with no freeze.

## Form fields (verbatim order, 2026-08-23)

| # | Field | Answer |
|---|---|---|
| 1 | Email * | owner's email — typed by the owner at submission, not stored in this public repo |
| 2 | Nominator Name * | owner's name (self-nomination; the post permits nominating "someone", and the project is the builder) |
| 3 | Project Name * | `vet402` |
| 4 | Project URL * | `https://vet402.com` |
| 5 | Project Twitter * | `@vet_402` |
| 6 | Project Farcaster/Channel * | **gap — see below** |
| 7 | Builder Twitter * | `@sen_buidl` |
| 8 | Builder Farcaster * | **gap — see below** |
| 9 | Is the project currently live on Base? * | **Yes – live on Base mainnet** |
| 10 | Why does this project deserve a Base grant? * (150 words) | §"Answer" below |
| 11 | Link a 1 minute demo * | `https://vet402.com/demo` — 58s, built 2026-08-25, self-hosted so the link cannot rot (**awaiting owner approval to deploy**) |
| 12 | Multimedia Assets License Agreement * | tick (authorizes Coinbase to use submitted materials — acceptable: every asset we would submit is already public) |
| 13 | Marketing opt-in | owner's choice |

## Answer to Q10 (148 words, checked)

> vet402 is the only public record of whether Base x402 endpoints actually deliver after they are paid. We buy: 1,133 real USDC purchases on Base mainnet across 865 endpoints, 496 settled, each published with its transaction hash — and the 637 that did not settle published on the same pages, with the same weight. We track the whole catalog (18,372 endpoints, 17,941 of them on Base) with daily snapshots, so builders can see what disappeared, not only what exists. It is live, MIT-licensed and free: SDK, middleware, MCP server, and a public JSON API anyone can curl. We sell nothing on the catalog we measure, so no seller can pay for a better result. Base is where the agent economy is already transacting; this is the independent evidence layer that lets agents pay it without paying blind. Every number above is checkable today, by anyone, without trusting us.

Figures are 2026-08-23. **Re-run `python3 scripts/grant-figures.py --check` on the submission day and re-paste; a stale number in a verification project's own application is the worst possible first impression.**

## Gaps before this can be sent (1 of 3 closed)

1. ~~**1-minute demo**~~ **built 2026-08-25** — 58s, no narration, captions burned in, every frame a live page: `/observatory` → the record page of an endpoint we actually bought from (2 of 2 settled, receipt rows) → the same payment on Basescan (0.02 USDC on Base) → the `decisions` API where `paid_settled` and `paid_no_settlement` sit in one list → the `state` API. Committed at `public/vet402-demo.mp4` + `/demo`; `npm run build` verified. **Waiting on the owner's go to deploy** (publishing is owner-approved).
2. **Farcaster (blocking if the field is required).** No Farcaster account exists for the project or the builder. Base's discovery runs on Farcaster, so this is not only a form field — it is the channel the program actually watches. Creating the account is an owner action (account creation, possibly a registration fee).
3. **Wallet + W8/W9 readiness.** A grant that lands has to land somewhere. Owner-held Base address, and the tax form when asked.

## Do not include

- Any promise of `payOrRefuse`, ENS-in-payment-path, or Validation Registry writes (frozen — `../hackathons/GRANTS.md` §5).
- Any equity/investment framing. This is a non-dilutive retro grant for a public good.
- The old product video (`video-script.md`).

## Supporting material to link, if a field allows

- `why-base.md` (Base-specific memo, 2026-08-23 figures)
- `impact-one-pager.md`
- Live JSON: <https://vet402.com/api/v1/observatory/state>
- Methodology: <https://vet402.com/observatory/methodology> · Accuracy ledger: <https://vet402.com/accuracy>

# 2026 Autumn Continuity Campaign

> Status: locked 2026-08-22. This is the operating plan for ETHOnline, ETHGlobal Tokyo, and ETHGlobal Mumbai.
> Full narrative (rules, Token2049, AI, Devcon): [`STRATEGY.md`](./STRATEGY.md). File map: [`README.md`](./README.md).
> Repo: https://github.com/kzmttkc/vet402 · Site: https://vet402.com
> Do not implement the next event's verb before that event's kickoff.

## Win definition

Grand prize is not the target. The target is **one new verb per event**, a working on-chain demo, and **up to 3 Partner Prizes** that the new verb actually uses.

A submission wins when a judge can answer, in 60 seconds of video:

1. What existed before (live product, disclosed).
2. What was impossible before this window.
3. What money did or did not move, with a receipt.

## Locked verbs

| Event | Window | Verb | One sentence |
|---|---|---|---|
| ETHOnline 2026 | 2026-09-04 → 09-16（提出締切 09-13 12:00 EDT） | `payOrRefuse` | スコアを見てから払うな。拒めるなら、払うな。 |
| ETHGlobal Tokyo | 2026-09-25 → 09-27 | `resolve-then-pay` | エージェントはアドレスではなく、名前に払う。 |
| ETHGlobal Mumbai | 2026-11-06 → 11-08 | `write the registry` | 支払いの証明はある。履行の証明を、空のレジストリに書く。 |

Substrate that is **never** claimed as new work:

- Observatory L0–L2, scores, badges, SDK / middleware / MCP, `/decisions`, `/impact`, accuracy ledger.
- ERC-8004 Validation Registry **dry-run** (read-only, merged 2026-08-21). Mumbai's new work is the actual write.

## Devcon 8 — go

**Go. Treat it as Mumbai prize work, not as a conference.**

| | |
|---|---|
| Devcon 8 | 2026-11-03 → 11-06 · Jio World Centre, Mumbai |
| Pragma Mumbai | 2026-11-05 |
| ETHGlobal Mumbai | 2026-11-06 → 11-08 |
| Diwali | 2026-11-08 |

You are already flying to Mumbai for the hackathon. The incremental cost is the ticket plus three hotel nights. The people who judge or fund ERC-8004 / x402 / Base / ENS will be in the same building the days before you submit.

How to attend (non-negotiable):

1. Buy a ticket **this week**. Prefer [Ethereum Public Goods](https://devcon.org/en/tickets/) ($349 ETH) if the OSS claim succeeds; otherwise General Admission in ETH ($499), not fiat ($999).
2. **Nov 3–5:** meetings only. Target 8 named conversations: ERC-8004 authors / EF, Base, Coinbase CDP / x402, ENS, and whoever is a Mumbai sponsor. Walk the floor with the live observatory and the dry-run numbers. Do not sit in talks unless a speaker is a prize judge.
3. **Nov 5 evening:** leave Devcon. Sleep. Tag `pre-mumbai-2026` is already cut (see calendar).
4. **Nov 6:** hackathon only. Do not bounce between Devcon closing and coding.
5. Skip Pragma if energy is tight. Devcon meetings beat Pragma talks.

Do **not** go to Devcon if you skip Mumbai. Do **not** skip Devcon if you do Mumbai. They are one trip.

---

## Calendar (hard dates)

| When | Action | Owner |
|---|---|---|
| 2026-08-22 → 08-29 | ETHOnline Continuity apply + Tokyo Continuity apply (Tokyo deadline 09-23; do it early). Mumbai apply when the form opens. | Human |
| 2026-08-22 → 08-29 | Devcon ticket. Hotel Mumbai 11-02 night → 11-08. | Human |
| 2026-08-22 → 09-03 | Spec and rehearsal only. No `payOrRefuse` code. | Both |
| **2026-09-03** | Tag `pre-ethonline-2026` on `main`. Branch `ethonline-2026`. | Human (or agent with approval) |
| 2026-09-04 → 09-13 | ETHOnline build. **Submit by 09-13 12:00 EDT = 09-14 01:00 JST**（一次確認 2026-08-23）。09-14→16 は審査期間。 | Both |
| 2026-09-17 → 09-24 | ENS rehearsal and spec only. No Tokyo feature code. Confirm Tokyo stake / travel. | Both |
| **2026-09-24** | Tag `pre-tokyo-2026` on `main`. Branch `tokyo-2026`. | Human |
| 2026-09-25 → 09-27 | Tokyo build + submit. | Both |
| 2026-10-05 → 10-11 | TOKEN2049 Singapore week. Meetings only. **Do not enter Origins with this repo.** NEXUS pitch is optional. | Human |
| 2026-09-28 → 11-04 | Operate the product. ERC-8004 write spec and testnet rehearsal. **No mainnet registry writes** that would become the Mumbai demo. | Both |
| **2026-11-05** | Tag `pre-mumbai-2026` on `main`. Branch `mumbai-2026`. | Human |
| 2026-11-03 → 11-05 | Devcon meetings. | Human |
| 2026-11-06 → 11-08 | Mumbai build + submit. | Both |

Between events, product ops (probes, purchases, bugfixes unrelated to the next verb) are allowed and must be disclosed as pre-existing at the next event.

---

## Event 1 — ETHOnline (async, 12 days)

Operating plan (day-by-day): [`docs/ethonline-2026/ROADMAP.md`](../ethonline-2026/ROADMAP.md).
Win-probability overrides: [`docs/ethonline-2026/WIN_EV.md`](../ethonline-2026/WIN_EV.md). WIN_EV wins if this section is shorter or disagrees.

### Scope (already committed in `docs/ethonline-2026/`)

Ship only:

1. SDK `payOrRefuse`: SpendGuard first; ALLOW ⇒ x402 `exact` + attest; otherwise refuse before sign, machine-readable reasons.
2. MCP `pay_if_trusted` (payment path unreachable on BLOCK/WARN).
3. Demo agent under `examples/ethonline-2026-agent/`: low-trust → BLOCK → no payment; high-trust → ALLOW → real receipt.
4. Those decisions into `/decisions` with `source: agent-demo`.

Git: prefix `ethonline:`. Touching a pre-existing file ⇒ one line in `CHANGED_FILES.md` in the same commit. Merge `--no-ff` at submit. Do not paste the Continuity section into `README.md` until the work exists.

### Prizes

Select after the official list is published. Heuristic, in order:

1. Base / Coinbase CDP / x402 facilitator
2. Agent framework / MCP / wallet that `payOrRefuse` actually calls
3. Continuity-only bounty the **new** verb uses. Do not implement Tokyo's ENS verb here.

Skip anything that needs a new chain or a swap. Max 3 partners. Submit **Finalist and Partner Prizes** (async first round is free optionality).

### Demo video (2–4 min, ≥720p, human voice, no AI voiceover)

WIN_EV shot list (do not open on the observatory; do not use `docs/applications/video-script.md`):

1. 10s — `git log pre-ethonline-2026..ethonline-2026`
2. 25s — `run.ts block` → no signature
3. 25s — `run.ts allow` → Base explorer tx
4. One sentence — we already buy and publish; this window closed “ignore the score and sign anyway.”

### Done when

- Two live scenarios on mainnet or a disclosed test path with a real tx on the ALLOW side.
- `AI_USAGE.md` in the submission (use `docs/applications/ai-usage-disclosure.md`; do not soften).
- Continuity README section pasted in the past tense, listing only what exists.

---

## Event 2 — ETHGlobal Tokyo (36h IRL)

### Scope

One feature: **resolve-then-pay**.

- Payee is an ENS name, not a raw address.
- Verification / observatory pointer in ENS text records.
- `payOrRefuse` runs **after** resolution.
- Demo path: name → resolve → verdict → pay or refuse.

Optional second surface if the first path is green before Saturday night: World ID (or equivalent) as **human override** on WARN / high-value only. Do not start this if ENS path is not demoable.

Out of scope: Sui, Uniswap swap-to-pay, new scoring, registry writes.

### Prizes (published so far: ENS, Uniswap, World, Sui, 1inch)

1. **ENS Continuity** — mandatory first pick.
2. World Continuity — only if the override shipped.
3. Third pick: whichever Continuity bounty the ENS path honestly touches. Do not pick Sui. Do not pick Uniswap unless a real swap exists in the demo.

### IRL use of the weekend

- Friday: mentors at ENS (and World if in play) **before** midnight. Show the ETHOnline verb, then the name-resolution branch.
- Saturday: freeze features when the happy path works on camera.
- Sunday: video, README boundary, `CHANGED_FILES.md`, submit before the queue.

Git: prefix `tokyo:`. Tag `pre-tokyo-2026`. Branch `tokyo-2026`.

### Done when

The video's first minute is a **name**, not a hex address, going through pay-or-refuse.

---

## Event 3 — ETHGlobal Mumbai (36h IRL)

### Scope

One feature: **write the empty ERC-8004 Validation Registry**.

- Dry-run already exists and is pre-existing. Disclose it.
- New work: signed, on-chain validation records for L0–L2 facts (failures with the same weight as successes).
- Public page: record → tx → reproduce.
- Demo path: observatory fact → write → anyone verifies on-chain.

Out of scope: new scores, ENS work beyond what Tokyo already shipped, Solana writes.

### Prizes

List will move. Pick after publish, in order:

1. Whoever owns ERC-8004 / identity / attestation
2. Base
3. x402-adjacent or agent track

Ignore Devfolio "ETHMumbai" Elsa x402 listings unless they appear on the **ETHGlobal Mumbai** prize page.

### Devcon → hackathon handoff

Bring a one-pager (`docs/applications/impact-one-pager.md` + dry-run gas numbers) to every Devcon meeting. Ask each person: "If we write this this weekend, what would make it prize-eligible?" Write their answer down. That is the Mumbai checklist.

Git: prefix `mumbai:`. Tag `pre-mumbai-2026`. Branch `mumbai-2026`.

### Done when

A stranger can take a published validation tx and confirm it without trusting vet402.com.

---

## Freeze list (the only way this campaign dies)

Do **not** implement:

| Frozen until | Work |
|---|---|
| 2026-09-04 00:00 UTC | `payOrRefuse`, `pay_if_trusted`, ETHOnline demo agent |
| 2026-09-25 kickoff | ENS resolution in the payment path, ENS text records for verification |
| 2026-11-06 kickoff | Mainnet (or prize-chain) Validation Registry **writes** used in the demo |

Allowed before those clocks: specs, SDK reading, testnet accounts, ENS name **registration** (owning a name is not project code), Devcon ticket, applications, ops of the existing product.

---

## Continuity application (reuse, fill brackets)

> Track: **Extend Open Source**
> Repo: https://github.com/kzmttkc/vet402 (MIT, maintained by this team)
> Site: https://vet402.com
>
> vet402 is an independent verification layer for the x402 agent-payment economy. It already buys what endpoints sell, publishes successes and failures with evidence, and exposes ALLOW / WARN / BLOCK to agents via SDK and MCP.
>
> We are not submitting the existing product. During this event we will add **[VERB]**. Git boundary: tag `[pre-EVENT]`. All new commits on `[EVENT]` with prefix `[prefix]:`. Pre-existing files we touch will be listed in CHANGED_FILES.
>
> ETHOnline: payOrRefuse — refuse before sign unless ALLOW.
> Tokyo: resolve-then-pay — ENS name in, payment or refusal out.
> Mumbai: write the registry — L0–L2 facts onto ERC-8004 Validation Registry (dry-run already public; write is new).

Email `hello@ethglobal.com` if the form has no Continuity field.

---

## Roles

| Human | Agent |
|---|---|
| Applications, stake, travel, Devcon conversations | Implementation inside the open window |
| Mainnet keys, real USDC budget, submit click | Tests, docs, video script, prize-form drafts |
| Mentor conversations, live demo voice | Frequent small commits, CHANGED_FILES, AI_USAGE.md |
| Final "this is true" on any public claim | Never claim work that has not happened |

AI policy: ETHGlobal allows Cursor / Claude. Disclose with `docs/applications/ai-usage-disclosure.md`. Do not hide that agents write the code. Do not use AI voiceover on the video.

---

## TOKEN2049 Singapore — attend, do not hack this repo

Conference 2026-10-07–08. Official hackathon: Origins (10-06–08), from-scratch only, no Continuity. Full decision: [`STRATEGY.md`](./STRATEGY.md) §8.

Default: skip Origins for vet402. Use the week for the same job as Devcon (x402 / Base / Circle / ENS / VC). NEXUS is an optional pitch of the existing product. An Origins entry, if ever, is an empty-repo client that calls `vet402.com` as a disclosed dependency and does not touch this repository.

---

## What we will not do

- Submit the same dashboard three times with a thin skin.
- Chase Sui / Uniswap / new chains to fill a third prize slot.
- Start Tokyo or Mumbai features "a little early" because the first event went well.
- Soften the AI disclosure.
- Sit through Devcon talks instead of booking the eight conversations.
- Enter TOKEN2049 Origins with `kzmttkc/vet402`.
- Use `docs/applications/video-script.md` for an ETHGlobal Continuity video.

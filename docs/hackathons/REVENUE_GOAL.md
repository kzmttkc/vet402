# Core revenue goal — billing vs buyout

> Locked 2026-08-23. Decision for the owner. Does not change the hackathon freeze or grant stack.
> Constraints this rests on: `docs/economic-capture-design.md` §0, `docs/open-core.md`, `docs/hackathons/GRANTS.md` (Base Batches declined).

## How the layers stack

Hackathons and grants are the **foundation work**. Stable billing and an exit sit **on top of that work**, not beside it as a second company.

| Layer | Job | What it is not |
|---|---|---|
| Hackathons | Prove a new verb in public, with a receipt | A revenue line |
| Grants | Pay to keep measuring (purchases, RPC) without selling the verdict | A business model |
| Billing | Recurring money from **buyer-side** convenience/depth over the record | A unicorn SaaS target |
| Exit | Hand the **ledger + ops + name** to a neutral / buyer-side owner | A pitch we optimize for this quarter |

It is not a queue you finish in order. A named buyer may pay during the grant year. A foundation term sheet may arrive before Scale plan revenue is large. What you do **not** do is skip the foundation and jump to billing-from-sellers or a sale to the catalog operator.

The causal story: verbs and a dated ledger make the asset; grants keep it alive; billing proves someone needs it every month; exit is how that asset changes hands without destroying neutrality.

---

## The decision

**生きるためのコアは課金。出口のコアはバイアウト（または財団への移管）。片方だけを北にするのは誤り。**

日々のプロダクトと助成・ハッカソンは、**買い手側が払う便利さ／深さ**で観測を回すことを最適化する。  
企業価値の取り方は、**コピーできない台帳と運用を、測られない側へ渡すこと**を最適化する。

「課金でユニコーン」も「今すぐ誰かに売る」も、コアにしない。

---

## Why not billing-only

The lookup plans (Free / Pro $49 / Scale $199) are already the right *kind* of charge: quota over a score API, not a better verdict. They will not, by themselves, cover L1 purchase capital plus RPC if the agent economy stays small. MIT code can be forked in a day (`open-core.md`). A SaaS multiple on $199/mo is the wrong scoreboard.

What billing *is* for:

- Pay for the next month of real purchases without taking a shareholder from the catalog we grade.
- Produce **named buyers** (agent operators, frameworks, indexers). That is demand evidence for grants and for any later sale.
- Sell only what `economic-capture-design.md` allows: row-level history, bulk, freshness SLA, deeper runs whose **outcomes still publish**. Never the answer, never a head start, never a seller paying to be measured more.

Sequence stays: data API → higher-assurance runs → guarantee (legal gate) → dispute bonds (slash ≠ revenue).

Do not turn on guarantee underwriting, or talk about it, until the written legal/capital gates in `guarantee-underwriting-design.md` pass.

---

## Why not buyout-only

Optimizing the company as a sale deck does three kinds of damage:

1. **Wrong buyer.** Coinbase / Base / a catalog operator as controlling owner is the same attack as Base Batches: a shareholder on the measured side. We already declined that (GRANTS.md, 2026-08-23).
2. **Wrong work.** “Acquisition-grade” checklists that are not a public record or a buyer-side API steal time from ETHOnline verbs and retro grants.
3. **No price.** A buyout without paying customers or a uniquely long ledger is a talent/asset pickup, not a franchise. Billing is how the ledger keeps growing and how a buyer knows anyone needs it.

A good terminal transaction looks like:

- Buyer is **buyer-side or neutral**: x402 Foundation / Linux Foundation vehicle, EF-adjacent endowment, Circle/Visa research, a consortium of agent runtimes — not the marketplace being graded.
- What they buy is the **record + funded operations + name**, not a closed-source fork. Code stays MIT.
- Contractual continuity: public facts stay public; measured operators stay non-customers; no embargo of failures.
- If no such buyer appears, the fallback is an endowment / public-goods vehicle funded by grants + buyer-side API, not a distressed sale to the catalog owner.

---

## Operating rule (one sentence)

**Charge buyers for convenience over a public record; keep the record unique and transferable; never sell the verdict or the independence.**

| Horizon | Optimize for | Do not optimize for |
|---|---|---|
| This quarter | Continuity + Base retro grant + Stripe lookups if a real buyer appears | Pitching an exit |
| This year | Paid data/assurance to *named* buyer-side customers; Solana L1 if granted | Seller-side badges-for-cash |
| Terminal | Sale or endowment of the ledger to a neutral / buyer-side owner | Equity from Base/Coinbase/CDP as catalog operator |

---

## Collision with the current campaign

- Hackathon verbs remain unpaid public capabilities. They raise the price of the *record*, they are not SKUs.
- Grants pay ops (purchases, RPC). They are not a substitute for either core.
- Base Batches / Ecosystem Fund stay off unless the owner reverses GRANTS.md in writing.
- No new monetization code is required for ETHOnline.

---

## Revisit triggers

Re-open this file only if:

- A named buyer-side customer is ready to pay for §1 or §2 in `economic-capture-design.md`, or
- A neutral/foundation buyer sends a written term sheet that preserves publication and non-customer sellers, or
- L1 budget cannot be funded from grants + lookup revenue for 90 days.

Until then, the core revenue *motion* is billing (buyer-side). The core *exit* is a constrained buyout. The core *asset* is the dated purchase ledger.

# Ethereum Magicians — draft post

**Status:** POSTED 2026-08-25. ERC-8004: Trustless Agents thread 25098, reply **#380**. Do not post again. Draft kept as archive.
**Account:** `Sen_Vouch` (rename window closed; bio already says vet402). Trust level 0 — markdown links are rejected; URLs must be inline code if anyone ever quotes this.
**Tone rule:** technical forum, not a launch. No CTAs, no signup links in the body.

---

## Title

An accuracy-measured trust layer over ERC-8004 identity + reputation (Base): notes and open questions

## Body

ERC-8004 gives agents an on-chain identity and a reputation surface. In building a consumer of those registries I keep running into the same design question, and I'd value this group's read on it.

**The gap.** Identity and reputation are necessary but not sufficient for a counterparty decision. Raw feedback is Sybil-prone: a fresh registration with a handful of self-dealt attestations looks, to a naive reader, indistinguishable from a modestly-used honest one. Anyone gating an action on "does this agent have reputation" has to answer "reputation that resists being manufactured?" — which the registries deliberately don't answer, because that's a policy layer, not a protocol one.

**The approach I've been testing.** A read-only scoring layer that combines:

- ERC-8004 identity (registration + metadata presence)
- ERC-8004 reputation (feedback volume/average) with a *dampening* rule when velocity or uniqueness looks anomalous
- wallet heuristics (age, activity, burner shape, funder-cluster overlap)
- x402 settlement history where available (attested, on-chain-verified), weighted low while data is thin

collapsed to a 0–100 score and an ALLOW/WARN/BLOCK band. Two constraints I've held to that I think are the interesting part for this forum:

1. **Fail closed, and say so in-band.** When an upstream read (RPC, an index) is unavailable, the affected signal is flagged and penalized rather than assumed benign, and the response carries a data-coverage object so the caller sees freshness instead of inferring omniscience. A degraded read returns a more cautious verdict, never a confidently wrong one.

2. **Publish the false-positive rate next to the accuracy rate.** A scoring layer that only reports the flattering number is marketing. The measurement I care about is: of the ALLOW verdicts issued, what share later showed adverse on-chain activity — and of the BLOCK verdicts, what share were later confirmed legitimate. Both, in public, with a minimum-sample floor below which a rate is withheld rather than shown as noise.

The chicken-and-egg problem with (2) is real: with no traffic there are no resolved verdicts to measure. The honest interim I landed on is an *operator benchmark* — score a fixed, versioned set of addresses whose real-world outcome is already public (e.g. OFAC-sanctioned addresses as known-bad; long-operating publicly-attributed addresses as known-good), stamp those rows with a dedicated source so they are never mixed into or presented as organic traffic, and report them as a clearly-separated section. It measures discrimination on a labeled set, nothing more, and it's labeled as exactly that.

**Open questions for the group:**

- Is there appetite for a *standard shape* for a reputation-derived risk signal (score + reason codes) that sits above ERC-8004, or is that firmly application-layer and best left un-standardized?
- The Sybil-dampening heuristics are the load-bearing and most-contestable part. Are there prior-art approaches from this community for distinguishing organic from manufactured reputation on the ERC-8004 feedback surface specifically?
- For x402 flows: does gating *after* payment verification but *before* serving the resource match how others expect trust checks to compose, or is there a cleaner hook point?

Implementation and the measurement methodology are open source (Next.js/viem/Base). Happy to share the repo link if that's useful and within the thread's norms; I'd rather get the design questions above right first.

`https://github.com/kzmttkc/vet402` · `https://vet402.com`

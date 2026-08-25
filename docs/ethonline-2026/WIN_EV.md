# ETHOnline 2026 — maximize win probability

> Locked 2026-08-22. This file **overrides** [`ROADMAP.md`](./ROADMAP.md) where they differ.
> Roadmap is the calendar. This file is the bet.
> **2026-08-23 訂正:** 提出締切は **2026-09-13 12:00 EDT（= 09-14 01:00 JST）**。出典 https://ethglobal.com/events/ethonline2026/info/details （一次確認 2026-08-23・「Sunday, September 13th 2026 at 12:00 pm EDT」）。会期 09-04→09-16 の後半は審査期間で、提出はできない。旧記載の 09-15 提出は全て前倒し済み。
> Full record: [`../hackathons/STRATEGY.md`](../hackathons/STRATEGY.md).

## The bet

Do not optimize for Finalist (top ~20%, live 7 minutes, high variance).
Optimize for **three Partner Prizes**. Partners judge async, do not see Finalist ranks, and pay most of the pool.

`payOrRefuse` stays the only verb. We do not swap it. We make the **demo certain** and the **three prize checklists** true.

Expected value, in order:

1. Drive disqualification probability to ~0.
2. Guarantee both demo paths (refuse **and** a public Base tx).
3. Pick 3 prizes the new path actually calls, then talk to those three sponsors before they review.
4. Make the video auto-accept and open on the new verb, not the old product.

---

## 1. Kill every controllable DQ

These lose more often than a weaker idea.

| Risk | Rule |
|---|---|
| Continuity not on file | **Closed 2026-08-23**: the application form carries the track selector; `continuity-track` is selected and submitted. Status is "still being reviewed". Track cannot be switched later. Watch for the acceptance email, then stake ETH. |
| One giant commit | Day 0 is red tests. Every later day is small `ethonline:` commits. |
| Undisclosed old work | Tag `pre-ethonline-2026` on 09-03. README Continuity section is past tense of **what exists**. |
| L1 contamination | Demo rows never enter `x402_l1_purchases`. |
| AI-only submission | Human: apply, keys, first live ALLOW, voiceover, sponsor Discord, submit click. Agents write code. Disclose without softening. |
| Video auto-reject | Dry-run upload 09-11. Final 09-12. Human voice, ≥720p, 2:00–3:50, no AI voice, no phone, no speed-up, no music-over-text. |
| Fake or catalog-only ALLOW | See §2. We do not claim a payment we cannot open on a public explorer. |

Do **not** use `docs/applications/video-script.md`. That is the old product film. Using it makes Continuity look like a reskin.

---

## 2. Make ALLOW certain — own seller first

Catalog ALLOW is a hope. An endpoint can flip score, change price, or stop speaking `exact`.

**In-window, first payment target is a disclosed seller we control.**

- New in this window: `examples/ethonline-2026-agent/seller` — one `exact` resource, Base USDC, ≤ $1, payTo = a wallet that **scores ALLOW** (our own verified payee, or a fixture that is ALLOW on 09-04).
- Video and README say: “ALLOW path hits our disclosed demo seller so the primitive is checkable. BLOCK path hits a live catalog payee.”
- Catalog ALLOW is optional extra, never the only path.

Roadmap Day 4–5 order is hereby:

1. Ship seller + `payOrRefuse` against it → public tx.
2. Then BLOCK against a live catalog payee.
3. Catalog ALLOW only if time remains.

The 09-11 “refuse-only” fallback in the roadmap is last resort. Plan A is a real tx by **09-09**.

BLOCK fixture: pick a live BLOCK/WARN payee and re-check 09-04 / 09-09 / 09-12. If it flips, swap. Do not fake a score.

---

## 3. Prize stack (this is the money)

Max 3 partners. One partner with many tracks still counts as 1.

### Lock moment

- **2026-08-23 訂正: 賞リストは既に公開されている。** 実測は [`PRIZES.md`](./PRIZES.md)（09-04 に作るのではなく、既に在る）。
  パートナー9社・$77,000。**Base / Coinbase CDP / x402 facilitator はこの大会にいない**ので下の P1 は空欄になる。
  詳細 "coming soon" は5社（The Graph $15k / 0G $15k / World / ENS / Ledger / Chainlink のうち5枠）。
- Re-open 09-04 / 09-09 / 09-12（`python3 scripts/watch_ethonline_prizes.py` が差分を見る）。Swap only if the demo does not actually use a pick.

### Heuristic (fill after the list exists)

| Slot | Who | Qualification we must show |
|---|---|---|
| P1 | **World「AgentKit Continuity」$3,500** — 2026-08-26 時点で**選べる唯一の賞**。`payOrRefuse` の policy に払う側の条件を1つ足す: 人間裏付けのあるエージェントにだけ上限を上げる。動詞は増えない | AgentKit の実使用・AgentBook 登録/解決・Sandbox での遠隔デモ・フィードバック文書 |
| P2 | **今は空**。continuity 枠が増えたときだけ埋まる（`scripts/watch_ethonline_prizes.py` が毎日見る）。詳細待ちは The Graph $15k / 0G $15k / ENS / Ledger / Chainlink / **Privy $5k（2026-08-26 新規）** | continuity ラベルがあること（無ければ内容が合っても選べない） |
| P3 | 同上。**continuity ラベルの無い賞は、内容が合っていても選択UIに出ない**（2026-08-25 ETHGlobal 回答）。3枠を埋めることを目的にしない | — |

Never: ENS (Tokyo), Sui, Uniswap-without-a-swap, a logo we did not import.

### 4-hour adapter budget (09-11 morning only)

If P1–P3 need a thin import (CDP facilitator client, AgentKit signer, official `@x402/*`), do it on **09-11 morning** after both demo commands work. Not before. Not a fourth verb.

### Sponsor Discord (human, daily after 09-08)

For each of the 3: one message with repo, 45-second clip or terminal GIF, “here is how we used X in `payOrRefuse`”, one question. Mentors who have seen the demo before async review score it.

If the prize list is empty on 09-04, build as if P1 is Base + official x402 `exact`. Fill P2/P3 when names appear.

---

## 4. What the judge must see in 60 seconds

Not the observatory. Not 17k endpoints.

**2026-08-25 更新（設計変更に追従）。** 詳細は [`DESIGN_payOrRefuse.md`](./DESIGN_payOrRefuse.md)。
本番実測で payee 30件が 30/30 WARN だったため、「BLOCK だから止める / ALLOW だから払う」という絵は撮れない。

1. `git log pre-ethonline-2026..ethonline-2026` (10s).
2. `run.ts catalog` → 既定 policy をカタログに当て、**署名0件**で全件拒否（25s）。スコアではなく証拠が無いから止まる。
3. `run.ts pay` → 開示した evidence policy（21日で 3件以上・settle率 0.9 以上）で、48/48 settled の相手に **実 Base tx**（25s）。
   同じ policy が 0/77 の相手を署名前に拒む。

Existing product is one sentence: “We already buy and publish. This weekend we made the buyer's rule explicit, and paid only where our own delivery ledger backed it.”

---

## 5. Human / agent (eligibility)

ETHOnline may drop Partner/Finalist if the team contribution is not meaningful.

| Must be the human | May be the agent |
|---|---|
| Continuity apply and email | Implementation, tests, docs |
| Wallet, USDC, first ALLOW click | Fixture research |
| Voiceover | Shot list, captions |
| Three sponsor threads | Prize-comment drafts |
| Submit | Commit hygiene, CHANGED_FILES |

The disclosure (`docs/applications/ai-usage-disclosure.md`) stays blunt.

---

## 6. Calendar overrides

| When | Override |
|---|---|
| ~~08-24~~ 08-23 | Continuity apply — **done**, under review |
| 09-04 | Prize screenshot → `PRIZES.md` |
| 09-08–09 | Own seller + first public tx (not catalog) |
| 09-11 AM | At most one prize adapter |
| 09-11 PM | Video dry-run (reject-checklist); feature freeze 18:00 JST |
| 09-12 | Final video; speak same-day `/observatory/state` numbers only if used at all |
| 09-13 **morning JST** | Merge `--no-ff`, submit Finalist **and** Partner Prizes |
| **09-13 12:00 EDT = 09-14 01:00 JST** | **Hard deadline. Late submissions are not accepted. Nothing changes after this.** |

During the window: no Origins, no ENS, no registry write, no product roadmap extras. Tokyo apply is already a 15-minute pre-window task.

---

## 7. Honest ceiling

We cannot make a prize certain. We can make the usual ways of losing almost impossible, and put all remaining variance on “did three sponsors like a working pay-or-refuse demo.”

That is the maximum-EV plan for this repo, this week, this event.

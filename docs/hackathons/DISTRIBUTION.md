# Distribution — X, Magicians, PH, Reddit, IH, Slack, Discord, HN

> Locked 2026-08-23. Owner-facing. Complements `REVENUE_GOAL.md` (billing + constrained exit) and `GRANTS.md` (retro first).
> Existing outbound drafts: `docs/marketing/OUTBOUND_READY.md`. That file still says **the repo never posts**. This file keeps that law and defines what *may* be auto-queued.

## 0. The one rule

vet402 is an observatory. Distribution that looks like a growth team *is a product error*.

If a paying customer and a stranger ask “did X deliver?”, they get the same public answer. Posts that sell a better answer, earlier access, or a seller badge-for-cash are forbidden. Posts that invent features (guarantee underwriting, unshipped verbs, stale “Vouch / closed beta / agent-trust.vercel.app”) are forbidden.

**Optimal automation is narrow:** machines may *draft* dated facts from `GET https://vet402.com/api/v1/observatory/state`. Humans approve or, for a locked template only, allow auto-publish to X and Farcaster. Everything else is human, usually a *reply*, not a drop.

Canonical: **vet402** · https://vet402.com · https://github.com/kzmttkc/vet402 · X `@vet_402`. Marketing drafts were pointed at these URLs on 2026-08-25 (`docs/marketing/README.md`). Magicians #380 is already posted — do not copy that draft as a new thread.

---

## 1. Goal of this layer

Hackathons and grants need *discovery without looking like a catalog vendor*.

| Audience | What we want them to do | Channel that actually works |
|---|---|---|
| Base / EF / grant scouts | Find a live, boring, checkable public good | Farcaster + X facts + `/impact` |
| x402 / agent implementers | Wire SpendGuard / (later) `payOrRefuse` | Discord *replies*, Dev.to, GitHub |
| ERC-8004 people | Argue the design, then remember us at Mumbai | Magicians *one thread* |
| HN / PH / IH | One honest launch per new verb | Manual, rare |
| Sellers on the catalog | Nothing. We do not outreach them | — |

Success is not follower count. Success is: a scout can `curl` the same number we posted; a mentor has seen a receipt; Magicians did not mute us.

---

## 2. Stance (every sentence)

**Voice.** IETF memo, not a startup. Short. Dated. Denominators. Failures with the same weight as wins.

**We say.** “We buy. We settle. We publish the measurements.” Retrieval date. Tx hash or “not verifiable.” Unverified ≠ dead.

**We do not say.** GM/GN engagement bait. “Thread of 10 tips.” “Exciting to announce.” Best-in-class. “Trustless.” “Nothing is an estimate” (scores *are* estimates). Guarantee product. Tokyo/Mumbai verbs before those windows. Seller praise or pile-on beyond the public observatory page.

**Name-and-shame.** Only what the observatory already publishes. No extra adjectives. Link the page, not a dunk.

**AI.** If asked, disclose: agents operate the measurement; a human owns posts that are not the locked facts template. Do not hide. Do not make “AI-run” the hook of every post.

**Language.** Public product English. Japanese only on Zenn / JP Discord when that room is Japanese. Magicians and HN always English.

**CTA.** At most one link. Prefer `/observatory/methodology`, a receipt page, or the repo. No invite codes. Signup is not the lede.

---

## 3. What may be automated vs never

```
state API ──► facts composer (locked template) ──► queue
                                                    │
                         ┌──────────────────────────┼──────────────────────────┐
                         ▼                          ▼                          ▼
              Auto (X + Farcaster)         Human approve              Human only
              weekly facts only            event posts                Magicians HN PH
                                                                     Reddit IH Slack
                                                                     Discord cold drops
```

| Automate | Human-approve queue | Never automate |
|---|---|---|
| Weekly facts from `/observatory/state` to **X + Farcaster only** | Hackathon submit, grant news, correction on `/accuracy`, first `payOrRefuse` tx | Ethereum Magicians |
| Screenshot of the same JSON (see §6) | Replies drafted from inbound mentions | Hacker News submissions |
| Calendar reminder: “re-curl before you post” | Dev.to / Zenn publish | Product Hunt |
| | | Indie Hackers essays |
| | | Reddit posts (replies: human) |
| | | Slack / Discord *intro drops* |
| | | Any seller DM |

**Implementation constraint (existing law).** This repository does not hold post secrets and does not fire webhooks to social APIs. If an auto facts job is built, it lives in owner infra (`Takeshi_Automation` or equivalent), reads the **public** state endpoint, and uses a template that cannot emit a number not present in the JSON. A dry-run log is kept. First 4 weeks: approve-all, then X/Farcaster weekly auto if zero incidents.

**Built 2026-08-24 — where it actually lives.** Owner infra, as required above: `Takeshi_Automation/scripts/vet402_weekly_facts.py`, fired by `com.kizuna.vet402-weekly-facts` (daily 09:10 JST, `--if-missing`, acts once per ISO week from Thursday — not a fixed weekday, so a sleeping machine loses no week). It reads only the public state endpoint and holds no vet402 secret. The rules above are code, not custom: fail-closed key access (a missing key drops its line, never emits `0`), two fetches ≥30s apart that must agree before anything is published, `l1.attempts − l1.settled` for non-settlement, the chain line gated on `byChainScope == "mainnet_only"`, silence when no number moved since last week, evaluative-word refusal, and weighted length ≤280 by dropping optional lines rather than rounding numbers. Every run — posted, skipped, or aborted — appends to `state/vet402_weekly_facts_log.jsonl`; aborts also land in `state/ALERTS.md`. Weeks 1–4 write a draft to `output/` and post nothing until `--approve` re-fetches and confirms the numbers have not moved; the fifth week onward posts on its own.

**X cadence is enforced, not intended.** The pre-existing daily queue job for the account was posting 7×/week against §4.1's 2–4. It now runs Monday and Friday only; the facts template goes out Thursday. Three per week, machine-limited.

**Farcaster: the account now exists; the wiring does not.** Re-measured 2026-09-05: `fnames.farcaster.xyz` returns `vet402` — **fid 3348672, registered 2026-08-27 12:18 UTC**, owner `0xf248a1…`. The earlier line here ("the account does not exist", measured 2026-08-24) was true when written and went stale three days later; it stayed in this file for nine days. What is still missing is the **signer key and the cast path** — grep of the ops repo finds no Farcaster credential anywhere, so nothing can post. Until a signer exists, this section's "X + Farcaster" still reads "X only" — but for a different reason than before, and the difference matters: the blocker is now a key, not an account.

**Anti-patterns that look like “optimal automation” and are not:** Buffer blasting 7 networks; LLM-generated thought leadership; commenting bots; upvote rings; Discord announcement spam; “value tweets” with stock rockets.

---

## 3.5 決定 2026-09-05 — 12媒体の playbook をやめ、2レーンにする（執行部）

**Takeshi:「それらを使うべきか戦略が間違っていてもう使わないのかはっきりして」**

**間違っていた。** §4 は12媒体それぞれに「役割」を書いたが、そのうち9つは
**一度も検証していない仮説**だった。2026-09-05 実測（Plausible・30日・`event:hostname==vet402.com`）:

| 流入元 | 30日の訪問者 |
|---|---|
| 全体 | **82** |
| x.com / t.co | **0 / 0** |
| warpcast.com（Farcaster） | **0** |
| news.ycombinator.com | **0** |
| reddit.com | **0** |
| ethereum-magicians.org | **0** |
| github.com | **0** |
| discord.com | **0** |

**放送型の媒体は、4ヶ月で1人も連れてきていない。**

ただし「効果ゼロ」ではない。効いているものが2つあり、**どちらも放送ではない**:
1. **議論の場での返信** — Magicians スレッド 25098 で、当社の投稿2本に対し
   babyblueviper1 から返信2本。#387「Real numbers appreciated — the split (697/1,681 settled,
   984 unresolved) is exactly the kind of thing that…」。
   **4ヶ月で受け取った、専門家からの唯一の反応**。クリックより上流の一次データ（[[human-signal-is-primary-data]]）
2. **機械可読の配布** — `@vet402/*` の npm 週次 613 DL。人は来ていないが機械は引いている

### 【2026-09-06 訂正】この節の結論が狭すぎた

前日の私は「放送型は 30 日 0 人」という実測から **「需要創出はやらない」** という結論を引いた。
**実測は正しいが、結論が間違っている。** 正しい結論は
**「放送以外で需要を作る方法を見つける」**であって、需要創出を仕事から外すことではない。

この誤りの代償は Agentrix で見える（2026-09-06 実測・30 日）:
```
訪問者 33 人 = Direct 28 / Google 2 / X 2 / LinkedIn 1
```
**検索 2 人。SNS 2 人。流入の経路が 1 本も無い。**
そこへ「転換率を上げる」施策を置いても、分母が無いので何も動かない。
一方 sharoushi は同じ会社が書いた記事で **Bing から週 841 人**を連れてきている。
**需要を作る方法は既に社内にある。Agentrix でそれをやっていないだけ。**

配布セッションの役割は「来た人を渡すこと」ではない。**外から人を連れてくることが先で、渡すのはその後半。**
下の2レーンは「議論の場」と「引かれる面」で、どちらも**既にこちらを知っている相手**向けである。
**知らない人に届く3本目のレーン（検索に載る記事）が要る**——これが抜けていた。

### 使う（この2つだけ）

| レーン | 具体 | 指標 |
|---|---|---|
| **議論の場で reply として入る** | Ethereum Magicians（TL0のためリンクは inline code）／x402 Discord（会期中・announce しない） | 返信が付いた回数。フォロワー・流入は見ない |
| **引かれる面を置く** | `/observatory/state`・`export.csv`・`history`・`llms.txt`・OpenAPI・npm・Dataset JSON-LD | 外部からの引用件数（現在 0）・npm 週次 DL |

X `@vet_402` は**この2つのどちらでもない**。週次実測を1本置くだけの掲示板として残す。
**獲得手段とは呼ばない**——30日で 0 人しか送っていないものを獲得手段と呼ぶのは、この文書が防ぐための嘘。

### もう使わない（決定・日付つき）

| 媒体 | 決定 | 解除条件 |
|---|---|---|
| Hacker News | **畳んだ** 2026-09-05。2垢とも shadowban 実測（全投稿 dead・submit 拒否） | 履歴のある新しい垢が要るが作れない。**当面なし** |
| Slack | **畳んだ** 2026-09-05。招待されていない（§4.5 は招待制のみ） | 実際に招待されたら |
| Reddit | **使わない**。自己宣伝は spam 扱い・30日 0 人 | 特定の質問に受領証つきで答える機会が来たときだけ、1コメント |
| Product Hunt | **使わない**。消費者向け製品ではない | なし |
| Indie Hackers | **使わない**。MRR の話が無い | 収益が立ってから |
| **Farcaster `vet402`** | **使わない**（アカウントは取得済み・追加費用なし で置く）。cast には storage 1ユニット **$7/年** が要り、**実測根拠はゼロ**（warpcast 経由 30日 0 人）。[[traction-before-infra-spend]] | **Base Batches 004 の審査が進み、Base 側が Farcaster を見ると分かったとき**（〆切 2026-09-09・TAKESHI_TODO） |

**この表が §4 に優先する。** §4 は各媒体の作法として残すが、「使う/使わない」はここが正典。

---

## 4. Per-platform playbook

### 4.1 X (`@vet_402`)

**Role.** Public notebook of measurements. Base/grant scouts lurk here.

**Cadence.** 2–4 posts/week total. Of those, **at most 1** is the auto facts template. Rest are event-driven or silent.

**Auto template (fill only from JSON + ISO date):**

```
vet402 observatory {YYYY-MM-DD}

catalog active {activeEndpoints} / tracked {totalEndpoints}  (incl. testnets)
L0 published pass {publishedPass} · unverified {publishedUnverified} (not dead)
L0 coverage 7d {coverage7d.pct}% of active
L1 {l1.attempts} attempts · {l1.settled} settled on-chain · {l1.attempts - l1.settled} not settled
chain (mainnet only): Base {byChain[Base].publishedPass}/{byChain[Base].activeEndpoints} · Solana {byChain[Solana].publishedPass}/{byChain[Solana].activeEndpoints}

source: https://vet402.com/api/v1/observatory/state
```

No hashtags stacked. No “like and RT.” Quote a correction when `/accuracy` moves.

**Key mapping — verified against the live response 2026-08-23.** Two traps that would publish a false number:

- `publishedFail` is an **L0** field (`0` today). It is **not** the L1 failure count. L1 non-settlement is `l1.attempts − l1.settled` (1233 − 531 = 702 on 2026-08-23). Binding “failures” to `publishedFail` posts *0 failures* while 702 L1 attempts did not settle — the exact inverse of the failures-carry-the-same-weight rule.
- `byChainScope` is `mainnet_only` while top-level totals include testnets, so `sum(byChain) < totalEndpoints` by construction (the API says so in `disclaimer`). A card carrying both must label the chain line **mainnet only**, or it publishes a contradiction against its own source.
- The composer **fails closed**: a key missing from the response drops its line. It never emits `0` for an absent field, and never a number that is not literally in the JSON.

**Profile.** Name `vet402`. Bio: `Independent verification of the x402 agent-payment economy. We buy. We settle. We publish. Not a score of the observatory.` Link `vet402.com`. Visual: RFC paper world (navy/paper), not dashboard zinc.

**Do not.** Daily threads. Reply-guys under Coinbase/x402 for growth. Spaces.

### 4.2 Farcaster

**Role.** Base Builder Grant *discovery* (their team uses it). Same facts template as X, same day, same numbers. One account. No extra personality layer.

Warpcast channel: `/base` or `/x402` only when the weekly facts are on-topic; otherwise profile cast only.

### 4.3 Ethereum Magicians

**Role.** Design legitimacy for Mumbai / EF. **One** thread, then replies.

Draft archive: `docs/marketing/articles/ethereum-magicians-erc8004-trust-layer.md`. **Already posted** — do not open a second thread.

**Posted 2026-08-25** — post #380 in the live *ERC-8004: Trustless Agents* thread (25098), not a new topic, because the thread was live and the canon says join it. It answered the question the thread was actually on (#377–379: slashing needs an outcome that is independently checkable) with the measurement we alone have: 18,832 tracked / 15,275 listed, 1,233 paid attempts and 531 settled, and — carrying the same weight — 0 ALLOW out of 17 known-good addresses, i.e. our own band is uncalibrated and we said so. Verified anonymously afterwards: visible, not hidden, not flagged.

Two constraints that will bite the next post there, both measured that day:

- **The account is `Sen_Vouch` and cannot be renamed** (Discourse's rename window has closed). The bio already says vet402, and the post opens by naming the rename rather than hoping nobody checks. Do not let this become a reason to open a second account — one account with history beats a clean handle with none.
- **It is trust level 0, so links are rejected outright** (“Sorry, you can't include links in your posts”). Write URLs as inline code instead. TL1 comes from reading, not posting, so the fix is to read the forum, not to post more.

**Never auto.** Never a second “launch” thread. Never a signup link in the body. One repo link at the end. Answer questions; do not “circle back with a blog.”

### 4.4 Discord (x402, ETHGlobal, Base)

**Role.** Integration support. Default is **reply**, not announce.

- ETHGlobal event Discords: after kickoff, one factual “Continuity / here’s the boundary tag” if asked; sponsor channels get the WIN_EV 45s clip, human-typed.
- x402 Discord: `x402-community-short.md` A **once** when intros are invited. B–D only as replies. Drafts already say vet402.
- Do not join 20 servers to drop the same blurb.

### 4.5 Slack

**Role.** Only workspaces we were **invited** to (EF office hours, a grant cohort, a hackathon staff channel). Same reply stance as Discord. No multi-workspace broadcast bots. No “community Slack” we invent.

### 4.6 Reddit

**Role.** Almost none. Subs (`r/ethereum`, `r/ethdev`, `r/machinelearning`) treat self-promo as spam.

Allowed: answer a specific question with a receipt link; disclose affiliation in the same comment.  
Forbidden: weekly facts bot, “we launched” on 5 subs, upvote automation.

If anything: one `r/ethdev` comment-as-answer after ETHOnline, not a standalone ad.

### 4.7 Hacker News

**Role.** One **Show HN** per *new public verb*, not per week.

- First eligible: after ETHOnline submit, when `payOrRefuse` + a public Base tx exist.
- Title shape: `Show HN: vet402 – agents refuse x402 payments when the payee is BLOCK`  
- Text: 4–6 sentences, link site + repo, what is old vs new, how to reproduce. No video thumbnail spam.
- Human posts from a real account with history if possible. **Never** a bot. Do not ask friends to upvote. Do not comment from alts.

A flop is fine. A second Show HN before Tokyo is not.

### 4.8 Product Hunt

**Role.** Consumer launch theater. We are not a consumer app. **At most one** PH, after a verb a non-crypto hunter can click (playground + refuse demo). Not during ETHOnline judging week (noise). Not automated. Maker comment answers “is this a score you can buy?” with **no**.

Skip PH entirely if time is scarce; Magicians + Show HN + Base Farcaster beat PH for this product.

### 4.9 Indie Hackers

**Role.** One build-in-public essay: neutrality + “code is MIT, the ledger is the product” + AI-operated disclosure. Not a daily MRR screenshot (we do not have that story yet). No “day 47 of building.” Human post. Link `/impact`.

### 4.10 Dev.to / Zenn (already drafted)

Keep OUTBOUND_READY order: Magicians → Dev.to → x402 replies → Zenn after Takeshi edits. Fix stale URLs. `published: false` until then. Not on the auto facts pipe.

### 4.11 GitHub

The repo *is* a channel. Good README boundary, issues that are real, no “social proof” stars farming. Hackathon tags and Continuity section (past tense only when true).

### 4.12 Machines — the channel the other eleven exist to feed

The audience this strategy is aimed at (grant scouts, ERC-8004 authors, agent frameworks) arrives by **citation and by other agents**, not by a launch post. Four machine surfaces are already live and none of §4.1–4.11 covers them. All four checked 2026-08-23.

| Surface | State today | Distribution job |
|---|---|---|
| `GET /api/v1/observatory/export.csv` | 200, 180 KB, one row per L1 attempt with `tx_hash`, back to 2026-08-14 | Be the dataset other people quote. Needs a stated licence, a retrieval date, and a “how to cite vet402” block |
| `GET /api/v1/observatory/history` | 200, daily rows per chain | A time series a third party can replot without asking us |
| `llms.txt` (and `/.well-known/llms.txt`) | 200, 13 KB | The one file an agent reads before quoting us. Endpoints in, numbers out (numbers go stale, endpoints do not) |
| npm `@vet402/sdk` · `@vet402/middleware` · `@vet402/mcp-server` | published **2026-08-24** at 0.4.0 / 0.4.0 / 0.2.0. The `@vouchscore/*` line is deprecated with a pointer, not removed. Weekly downloads on the old line before the move: 25 / 31 / 28 (downloads, not people — mirrors and CI count) | The only surface with non-zero pull today |

Same law as everywhere: **publish, do not pitch.** No “integrate with us” DMs to framework maintainers; a working package and a citable dataset are the pitch.

Both defects found here on 2026-08-24 are **closed**, and the record is kept because the shape recurs:

1. **The package shipped as Vouch** (`@vouchscore/mcp-server`, bin `vouch-mcp`) — a contradiction of §0 louder than any post. Fixed by publishing the `@vet402/*` line and deprecating the old one with a message that names the successor; existing installs keep working, and `vet402-mcp` ships alongside the old `vouch-mcp` bin for the same reason.
2. **The strongest trust artifact was not distributed.** The fail-closed decision types (`decision` / `safe_to_pay` / `refuse_reasons`, commit `af034e5`) sat in git while npm served 0.1.1 from 08-21. They are in `@vet402/mcp-server` 0.2.0.

The rule the two share: **a repository is not a distribution channel.** Something is distributed when the thing a stranger installs, or a machine reads, has changed — not when the commit lands. Every entry in this table gets checked against that, not against the git log.

npm publish is an external publication: owner approval, then a human release with the version and the changelog line stated up front.

---

## 5. Calendar (next 90 days)

| When | Action | Auto? |
|---|---|---|
| This week | ETHOnline Continuity is in. Tokyo apply. X bio. Facts draft in `docs/marketing/FACTS_2026-08-25.md`. **No** blast. | No |
| Weekly (Thu UTC) | Facts template from `/state`. Approve 4 weeks, then X+FC only | Template only |
| ETHOnline 09-04–09-13 | Silence except: facts weekly + one human “window opened / tag exists.” No feature claims | No feature auto |
| **09-13 12:00 EDT = 09-14 01:00 JST** | Submit deadline (primary-verified 2026-08-23, see `2026-autumn-continuity.md`). Human: submit post with git log + BLOCK gif + ALLOW explorer. Sponsor Discords | No |
| 09-14 → 09-16 | Judging. No new claims, no launch post. Answer judges only | No |
| ~09-20 | Optional Show HN if tx is real | No |
| Tokyo / Mumbai | Same pattern: one human post at submit, not a campaign | No |
| TOKEN2049 week | Meetings. Zero Origins-with-this-repo posts | No |
| Any `/accuracy` correction | Human post same day, same weight as a win | Queue, not silent auto |

If a week has no new fact and no event: **post nothing.** Silence is on-brand.

---

## 6. Image and video

### Visual world

Public = **IETF RFC** (`DESIGN.md`): navy, paper, Martian + Fragment Mono, numbered sections.  
Do not use dashboard zinc on social. Do not use purple neon, coin rockets, “AI brain” stock, or the old Vouch teal banner as if it were current identity.

### Images (allowed)

| Asset | What it is | How it’s made |
|---|---|---|
| Facts card | Same numbers as the template, retrieval date, `vet402.com` | Script: JSON → SVG/PNG. No model-generated numerals |
| Receipt card | Endpoint page + Base explorer crop | Screenshot, no markup that isn’t on-chain |
| Boundary card | `git log pre-ethonline-2026..` | Terminal screenshot |
| JSON card | Pretty-printed `/observatory/state` excerpt | Real response only |

Forbidden: Midjourney “trust,” fake UI, charts whose source isn’t the API, before/after that implies a seller paid us.

Sizes: X 1600×900 or 1080×1080. Magicians/HN: no image required. PH: one PNG of the playground, RFC-styled.

### Video

| Piece | Length | Rules |
|---|---|---|
| Facts (optional) | ≤20s | Screen recording of `/observatory` + explorer. No music. No TTS (ETHGlobal also bans TTS on submit videos; keep one standard) |
| ETHOnline demo | 2–4 min | `WIN_EV.md` shot list. Human voice. ≥720p |
| Sponsor Discord | ≤45s | BLOCK path only or ALLOW explorer only — one idea |

Do not ship a “brand film.” Do not use `docs/applications/video-script.md` (old product).

### Pipeline

1. Composer reads public JSON.  
2. Renders SVG from a checked-in template (fonts already in `public/`).  
3. Human glances at numbers vs `curl`.  
4. Publish or drop.

No generative video. If a frame isn’t a screenshot of production or git, it doesn’t go out.

---

## 7. Owner vs agent

| Human (Takeshi) | Agent |
|---|---|
| Magicians, HN, PH, IH, first Discord intro | Facts composer + SVG |
| Every reply that is a judgment call | Draft replies labeled DRAFT, never sent |
| “This number is true today” on event posts | Re-curl checklist |
| Secrets for X/Farcaster if auto is enabled | No social tokens in this repo |

Inbound (press, grant scout, angry seller): human answers. Seller disputes go through the public dispute path, not a quote-tweet.

---

## 8. What we will not do

- Auto-post the same line to X, Reddit, IH, Discord, Slack, and HN.
- Build a “content engine” of LLM essays.
- Outreach to measured operators.
- Buy ads that look like a better observatory verdict.
- Soften AI disclosure or hide failures.
- Keep posting as Vouch / closed beta / old Vercel URL.

---

## 9. This week (distribution only)

1. Tokyo Continuity apply (ETHOnline is already in).  
2. X bio from `docs/marketing/README.md`. Farcaster `vet402` exists (fid 3348672, 2026-08-27) but has **no signer key** — do not claim it posts.  
3. Do not start the facts auto-job until 4 manual weeks are clean. Magicians went out 2026-08-25; do not same-day blast X.  
4. No Product Hunt, no Show HN, no Reddit launch.  
5. Do not implement `payOrRefuse` for a clip.

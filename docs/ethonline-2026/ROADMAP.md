# ETHOnline 2026 — operating roadmap

> Locked 2026-08-22. Follow this file; do not expand scope.
> Win-probability overrides: [`WIN_EV.md`](./WIN_EV.md) wins if the two conflict.
> Window: **2026-09-04 00:00 UTC → 2026-09-16**（09-13 の提出後は審査期間）。
> **Submission deadline: 2026-09-13 12:00 EDT = 09-14 01:00 JST**（一次確認 2026-08-23 https://ethglobal.com/events/ethonline2026/info/details ・原文「Sunday, September 13th 2026 at 12:00 pm EDT」）。提出目標は **09-13 12:00 JST**（13時間の余裕）。旧記載「09-15 18:00 UTC」は誤りで、全日程を2日前倒しした。
> Track: Continuity · Extend Open Source · https://github.com/kzmttkc/vet402
> Verb: **payOrRefuse** — スコアを見てから払うな。拒めるなら、払うな。

Parent campaign: [`docs/hackathons/2026-autumn-continuity.md`](../hackathons/2026-autumn-continuity.md).
Full strategy record: [`docs/hackathons/STRATEGY.md`](../hackathons/STRATEGY.md). File map: [`docs/hackathons/README.md`](../hackathons/README.md).
Git rules: [`GIT_RULES.md`](./GIT_RULES.md). Continuity README draft: [`README_CONTINUITY_SECTION.md`](./README_CONTINUITY_SECTION.md).

---

## 1. Win condition

A partner judge watches ≤4 minutes and can repeat:

1. vet402 already buys and publishes (pre-existing, disclosed).
2. Until this window, SpendGuard **decided** and the agent **could still sign**.
3. Now one call evaluates, and **BLOCK/WARN cannot reach the signer**. ALLOW pays x402 `exact` and attests. Both outcomes appear on `/decisions` with `source: agent-demo`.

Target: **Partner Prizes (max 3) + Finalist optionality**. Not grand prize.

ALLOW is not optional. First live pay is a **disclosed own seller** (`examples/ethonline-2026-agent/seller`), target public tx by **09-10** (see WIN_EV §2). Refuse-only is last resort and must not claim a payment.

---

## 2. What already exists (do not claim as new)

| Piece | Where | What it does **not** do |
|---|---|---|
| `SpendGuard.evaluate` | `packages/sdk/src/spend-guard.ts` | Never signs. Never pays. |
| MCP `check_*` / `attest_x402_payment` | `packages/mcp-server/src/index.ts` | No pay tool. Attest is after-the-fact. |
| Hackathon starter | `examples/hackathon-starter/index.ts` | Comments say “your wallet stack executes”. |
| L1 payer | `src/lib/observatory/x402-payer.ts` | Observatory-only; `exact` + EIP-3009 + Base USDC. |
| `/decisions` | `src/lib/observatory/decisions.ts` | 1:1 map of **L1 runner** rows. Makes no new decisions. `source` does not exist. |

The gap is structural: an agent can ignore `evaluate()` and sign anyway. `payOrRefuse` closes that gap.

---

## 3. Scope lock (four items, nothing else)

1. **SDK `payOrRefuse`** — SpendGuard first; only `allow === true` may call the signer; then x402 `exact` on Base USDC; then `attestX402Payment`. Non-ALLOW returns machine-readable reasons. Signer is not constructed, not passed, not invoked.
2. **MCP `pay_if_trusted`** — same primitive. Payment branch is unreachable on BLOCK/WARN (prove with a test that a mock signer receives 0 calls).
3. **`source: agent-demo` on the public decisions surface** — a **parallel** stream. Do **not** insert demo rows into `x402_l1_purchases` or change the L1 1:1 definition. L1 totals stay L1-only.
4. **`examples/ethonline-2026-agent/`** — two scenarios, one runner:
   - low-trust payee → BLOCK → no signature, reasons printed, demo decision published;
   - high-trust payee → ALLOW → real x402 `exact` ≤ $1, Base explorer link, attest, demo decision published.

Out of scope (frozen until later events): ENS resolution, ERC-8004 Validation Registry **writes**, new chains, Uniswap/Sui, new scoring, UI redesign, npm publish (optional after submit, not a prize dependency).

---

## 4. Design constraints (write tests against these)

### 4.0 既存と新規の線引き（2026-08-26 実測で更新）

会期前に何が在ったかを、提出時に正直に書くための台帳。**取り消さない・隠さない。**

| | 状態 | 事実 |
|---|---|---|
| SpendGuard の evidence policy（**判定**する側） | **既存として開示する** | 2026-08-25 07:32–07:44 に別セッションが `packages/sdk/src/spend-guard.ts` と `packages/middleware/src/core.ts` へ実装（ee16294 / 44c3420・テスト520行つき）。`package.json` は 0.5.0 へ上がったが **npm は 0.3.0 のまま**（2026-08-26 実測・registry.npmjs.org）。会期前の作業なので Continuity の「既存」に入る |
| `payOrRefuse` / `pay_if_trusted`（**行動**する側） | **会期中の新規** | 2026-08-26 時点でリポのどこにも存在しない（`grep -r payOrRefuse packages/ src/` が 0 件） |
| デモエージェント・自前 seller | 会期中の新規 | `examples/` に無い |

**提出の物語はむしろ鋭くなった**: 既存の vet402 は「証拠に基づいて**判定する**」ところまで出来ていて、
エージェントはその判定を無視して署名できた。会期中に足したのは**判定に従って動く手**——
`payOrRefuse` は通らなければ署名そのものに到達しない。

フリーズの掲示は [`AGENTS.md`](../../AGENTS.md) の最上部（どのセッションも最初に読む場所）に置いた。

### 4.1 `payOrRefuse` shape (spec only until 09-04)

```
payOrRefuse({
  payee,            // 0x…  (ENS is Tokyo — reject names)
  amountUsd,        // must be ≤ local maxPerTx and observatory-class ceiling ($1 default)
  resource,         // x402 resource URL
  account,          // signer; type exists but MUST NOT be read unless decision.allow
  spendGuardPolicy? // default allow-only
}) →
  | { status: "refused"; decision: SpendDecision; signed: false }
  | { status: "paid";    decision: SpendDecision; txHash: 0x…; attested: true }
  | { status: "failed";  decision: SpendDecision; signed: true;  error } // signed but settle failed — publish
```

Hard rules:

- `trustPolicy` is `"allow-only"`. No WARN override in this event.
- Fetch 402 → parse `exact` → payTo **must equal** `payee` or refuse (`payee_mismatch`) **before** sign.
- Reuse observatory money gates: Base (`eip155:8453`), canonical USDC, scheme `exact`, EIP-3009, per-tx ceiling. Do not invent a second payer.
- On refuse: zero RPC sends, zero `signTypedData`, zero facilitator `/settle`.
- On paid: attest is part of the function, not a second optional call the demo can skip.

### 4.2 Decisions: do not contaminate L1

`GET /api/v1/observatory/decisions` today is “L1 runner, 1:1, no new decisions”. Keep that sentence true.

Add a **separate** collection (table or append-only log) for agent-demo rows:

| field | values |
|---|---|
| `source` | `agent-demo` |
| `decision` | `refused_not_allow` / `paid_settled` / `paid_no_settlement` |
| `payee` | 0x… |
| `txHash` | null on refuse |
| `reasons` | SpendGuard reason codes |

Public page: L1 block unchanged; a clearly labeled “Agent demo (ETHOnline)” block underneath. JSON: `l1` + `agentDemo`, never a mixed total.

### 4.3 Demo payees (pick in pre-window, freeze IDs on 09-03)

- **BLOCK fixture:** a live payee whose `GET /api/v1/payees/{addr}/score` is BLOCK (or WARN). Prefer an observatory-published non-settling / thin / flagged wallet. Re-check on 09-04, 09-09 and 09-12; if it flipped to ALLOW, swap to another live BLOCK — do not fake a score.
- **ALLOW fixture:** a payee that is clean ALLOW **and** exposes a payable x402 `exact` resource on Base USDC at ≤ $1. Prefer an endpoint we have already L1-settled (receipt exists) so delivery risk is known. If no such public seller exists that week, stand up a **disclosed** own `exact` seller for the ALLOW path only, and say so in the video.

---

## 5. Pre-window (now → 2026-09-03) — no product code

Product code = anything under `packages/`, `src/`, `examples/` that implements the four scope items. Docs and ops are allowed.

### 2026-08-22 – 08-24  Applications and money

| # | Task | Owner | Done when |
|---|---|---|---|
| A1 | **2026-08-25 確定。ETHGlobal のアカウントは `kazumototakeshi@gmail.com` ただ1つを使う。** 参加は 08-20 に確定済み（"You've confirmed your spot"）で、My events に ETHOnline 2026 / ETHGlobal Tokyo 2026 / Pragma Tokyo 2026 が並び、賞金・ステーク返却の受取ウォレットもここに紐付く。**`kzmttkc314@gmail.com` は Takeshi が試しに作った仮アカウントで、使わない**（2026-08-25 指示）。そこに私が 08-23 に出した申請と Continuity 選択は**無効**として扱い、以後この垢では何もしない。**2026-08-25 完了: 正本アカウントのダッシュボードを DOM で実測し、`continuity-track: checked=true` を確認した。** Continuity の選択は在る。 | Human | ✅ 済 |
| A1.1 | 提出フォームに入れるのは**リポの URL**（https://github.com/kzmttkc/vet402 ）。GitHub 連携そのものは提出の必須条件ではない見込みだが、正本アカウントで繋げるなら繋いでおく。もし「その GitHub は既に使われている」と拒まれたら、それは仮アカウント側に残った連携なので、そちらを外す（Takeshi 判断）。 | Human | 提出画面でリポを指定できる |
| A2 | ~~Tokyo Continuity apply~~ **Tokyo 2026 は登録済み**（My events に SEP 25–27。Pragma Tokyo 9/26 も）。残るのは Tokyo 側の Continuity 選択の確認（締切 09-23）。 | Human | Tokyo ダッシュボードで Continuity 選択を確認 |
| A3 | Demo wallet on Base. Fund: gas + **$5 USDC** (five $1 ALLOW attempts). Key stays with the human. | Human | Address written in a **local** note, not in git |
| A3.1 | **2026-08-24 実測**: the wallet registered with ETHGlobal for prize / stake-return payouts (`0x6777…3986`) already holds **30.17 USDC and 0.00756 ETH on Base** — the funding requirement is met on that address. **But do not put that key in a demo env file.** ETHGlobal sends prize money and the stake return there; a demo key lives in a running process. Use a separate throwaway key for `payOrRefuse`, funded just-in-time with ~$5 + gas, and keep the payout address cold. | Human | Demo key ≠ payout key, and the demo key holds only what the demo spends |
| A4 | API key for the demo (free tier). | Human | Key in local env only |

### 2026-08-25 – 08-28  Fixtures and prize watch

| # | Task | Owner | Done when |
|---|---|---|---|
| B1 | From production, list 3 BLOCK and 3 ALLOW candidates. Save addresses + score JSON + date in `docs/ethonline-2026/fixtures.md` (facts only, no feature claims). | Agent + Human confirm | File exists with retrieval date |
| B2 | For each ALLOW candidate, confirm a live 402 `exact` / Base USDC / ≤ $1. | Agent | One row marked `primary` |
| B3 | Bookmark the ETHOnline **prizes** page. Re-check 09-04, 09-09, 09-12. | Human | Calendar reminders |
| B4 | Read `@x402` client + CDP facilitator docs enough to call `exact` from the SDK during the window. No code in our repo. | Agent | One-page notes in `docs/ethonline-2026/x402-client-notes.md` (links + steps, no implementation) |

### 2026-08-29 – 09-02  Rehearsal (existing product only)

| # | Task | Owner | Done when |
|---|---|---|---|
| C1 | Run current starter + SpendGuard against BLOCK and ALLOW fixtures. Record evaluate() JSON. | Agent | Two transcripts (no payment from SDK) |
| C2 | Confirm L1 observatory still purchases (ops). Do not add `payOrRefuse`. | Human | `/decisions` still updating |
| C3 | Draft video shot list from §8. Do not record. | Agent | Shot list in this file remains accurate |
| C4 | Write failing-test **names** (not code) for §4.1 in a checklist. First window commit will create those tests. | Agent | Checklist in §6 Day 0 |

### 2026-09-03  Boundary

| # | Task | Owner | Done when |
|---|---|---|---|
| D1 | `main` clean. `git tag -a pre-ethonline-2026 -m "ETHOnline 2026 Continuity boundary"` and push tag. | Human | Tag on origin |
| D2 | Do **not** cut `ethonline-2026` until 09-04 00:00 UTC. | Human | No branch yet |
| D3 | Freeze fixture addresses in `fixtures.md`. | Human | File dated 09-03 |

A1 landed on 08-23. What remains from that block: the **ETH stake is only required after acceptance** (Takeshi executes it — funds move), and the acceptance email must be watched for. Continuity is opt-in and it is now on file inside the application.

---

## 6. Window (2026-09-04 → 09-13 submit)

All commits on `ethonline-2026`, prefix `ethonline:`. One purpose per commit. Pre-existing file touched → line in `CHANGED_FILES.md` in the **same** commit. Do not paste Continuity text into `README.md` until the work exists.

### Day 0 — Fri 09-04  Kickoff

Human: cut branch `ethonline-2026` from `pre-ethonline-2026`. Discord/dashboard check-in. Prize page screenshot.

Agent, in order:

1. Failing tests only (no implementation).
   **2026-08-26 追記（C4）**: §4.1 の硬いルールのうち、テスト名が無いものは実質存在しない
   ルールになる。突き合わせて抜けを足した（下の後半6本）。順序は §4.1 の並びに合わせてある。

   判定と署名の境界:
   - `payOrRefuse` refuses BLOCK and never calls a mock signer.
   - `payOrRefuse` refuses WARN and never calls a mock signer.
   - `payOrRefuse` refuses `payee_mismatch` (402 payTo ≠ payee) and never signs.
   - `payOrRefuse` on ALLOW calls signer exactly once and attests with the returned tx hash.
   - MCP `pay_if_trusted` BLOCK → signer 0 calls.

   金の門（observatory と同じ関門を再利用していること。**新しい payer を発明しない**）:
   - `payOrRefuse` refuses a non-Base network (`eip155:1`, `solana:…`) before signing.
   - `payOrRefuse` refuses a non-canonical token (USDC 以外の asset) before signing.
   - `payOrRefuse` refuses a scheme other than `exact` / a non-EIP-3009 `assetTransferMethod`.
   - `payOrRefuse` refuses `amountUsd` above the per-tx ceiling ($1 default) **and** above the
     caller's `maxPerTx`, whichever is lower.

   入力と結果の形:
   - `payOrRefuse` rejects a non-`0x` payee (ENS name) as a caller error — no lookup, no sign.
     （ENS は Tokyo。この会期では名前解決をしない）
   - `payOrRefuse` returns `status: "failed"` with `signed: true` when the signature went out but
     settlement failed — and that row is published, not swallowed.

   拒否時に**何も起きていない**こと（§4.1 "zero RPC sends, zero signTypedData, zero /settle"）:
   - On any refusal, the injected RPC transport, `signTypedData` and the facilitator `/settle`
     stub each record **0 calls**. 署名しなかったことは、署名関数を呼ばなかったことで示す。
2. Commit: `ethonline: test(sdk): payOrRefuse fail-closed contract (red)`.

**Day-0 done:** tests exist and fail for the right reason. No green implementation yet.

### Day 1–2 — Sat 09-05 / Sun 09-06  Primitive

Implement `payOrRefuse` in the SDK until the four SDK tests go green. Prefer wrapping the official x402 `exact` client + existing `attestX402Payment`. Do not copy the whole observatory into the SDK; import shared parse/ceiling ideas, keep signing behind the `account` argument.

**Day-2 done:** `packages/sdk` tests green. No MCP, no demo, no `/decisions` change.

### Day 3 — Mon 09-07  MCP

`pay_if_trusted` → `payOrRefuse`. BLOCK/WARN test: mock signer 0 calls. Payment path not imported on that branch of the tool.

**Day-3 done:** MCP tests green. `CHANGED_FILES.md` lists any pre-existing MCP index edits.

### Day 4 — Tue 09-08  Own seller + first public tx（予備日 09-09）

1. `examples/ethonline-2026-agent/seller` — disclosed `exact` resource, Base USDC, ≤ $1.
2. Human approves first `payOrRefuse` ALLOW against that seller.
3. BLOCK path against a live catalog payee.
4. Catalog ALLOW only if both of the above are green.

**Day-4 done:** public Base `txHash` from `payOrRefuse` → own seller. Explorer link in the demo README.

If settle is blocked: debug through 09-09 (WIN_EV). Do not invent a fake tx. Do not skip the seller to chase a catalog payee.

### Day 5 — Wed 09-09  Agent-demo decisions

Separate store + labeled UI/JSON. L1 definition string unchanged. Tests: L1 feed ignores demo rows; demo feed ignores L1 rows.

**Day-5 done:** a local refused decision appears as `source: agent-demo` and does not increment L1 `refused` totals.

### Day 6 — Thu 09-10  Demo agent

`examples/ethonline-2026-agent/`:

- `npx tsx src/run.ts block` → refuse, publish demo decision, exit 0.
- `npx tsx src/run.ts allow` → pay ≤ $1, print explorer URL, attest, publish demo decision.

Human: record both terminal transcripts. Re-score fixtures; swap if drifted.

**Day-6 done:** both commands work against production API. ALLOW has a public tx **or** we have formally switched to refuse-only wow (see §1).

### Day 7 — Fri 09-11  Prize adapter (AM) → freeze (PM)

Morning: at most one thin prize adapter, 4 hours, only after both demo commands work (WIN_EV §4). Afternoon: video dry-run against the reject checklist, fixture re-score, **feature freeze at 18:00 JST**.

**Day-7 done:** no code path left unproven; dry-run video uploads without a reject.

### Day 8 — Sat 09-12  Video + docs

Record per §8. Human voice, ≥720p, 2:00–3:50, no AI voiceover, no music-over-text, no phone camera, no speed-up. Re-pull `https://vet402.com/api/v1/observatory/state` the same day; speak only those numbers.

No new functions. Docs only:

- Update `README_CONTINUITY_SECTION.md` to **past tense, only what exists**.
- Paste that section into `README.md`.
- `docs/ethonline-2026/AI_USAGE.md` from `docs/applications/ai-usage-disclosure.md` (do not soften).
- Prize-form drafts: how `payOrRefuse` uses each of the 3 partners (empty until prize list is known).

**Day-8 done:** mp4 uploaded privately (duration/resolution checked) and `git log --oneline pre-ethonline-2026..HEAD` reads as the four scope items.

### Day 9 — Sun 09-13  Submit（締切当日・JST午前に出す）

1. `git merge --no-ff ethonline-2026` into `main`. Push.
2. Hacker Dashboard: **Finalist and Partner Prizes**.
3. Select **3** partners per §7. If the list is still empty, select the three that the demo actually imports and say so.
4. Repo, video, Continuity explanation, AI disclosure, prize comments.
5. Confirm `git log pre-ethonline-2026..ethonline-2026` in the submission text.

**Day-9 done:** dashboard shows submitted by **09-13 12:00 JST**. Stake refund path intact. Hard cutoff is 09-13 12:00 EDT (= 09-14 01:00 JST); after it nothing can be edited or uploaded.

### 09-14 → 09-16  Judging window

No features, no submission edits. Prepare 4 min live demo + 3 min Q&A if Finalist, and answer partner threads.

---

## 7. Prize protocol

**2026-08-23 実測: 賞リストは既に全パートナー公開済み。正典 = [`PRIZES.md`](./PRIZES.md)。Base / CDP / x402 facilitator はこの大会のパートナーに存在しない**（下の優先順位1位は ETHOnline では選べない）。詳細 coming soon の5社があるので、再読は 09-04, 09-09, 09-12。Pick **after** `payOrRefuse` exists, not before.

Order:

1. Base / Coinbase CDP / x402 facilitator — if the ALLOW path settled through them.
2. The agent/wallet/MCP surface `pay_if_trusted` actually calls.
3. A Continuity-specific bounty that the **new verb** uses.

Never pick: ENS (Tokyo), Sui, Uniswap-without-a-swap, a logo we did not import.

If a partner has Continuity-only and Classic-only sub-prizes, pick Continuity.

Each prize comment: 4 sentences — what existed, what `payOrRefuse` added, which of their APIs the new path calls, one live tx or a refuse transcript.

---

## 8. Video (2–4 minutes)

**2026-08-25 更新。** 30件測って 30/30 が WARN だった以上、「BLOCK だから止める」は撮れない
（[`fixtures.md`](./fixtures.md)・[`DESIGN_payOrRefuse.md`](./DESIGN_payOrRefuse.md)）。

| t | Screen | Say |
|---|---|---|
| 0:00–0:20 | vet402.com + `/observatory` | 既存の説明。「我々は自腹で買って、起きたことを公開している。今日 [PASS] 件が機械検証を通り、**2回連続で落ちた [FAILED2] 件だけを fail と呼ぶ**。1回落ちた [WAITING] 件は2回目待ち——**1回の悪い読みは判定ではない**。ここまでは今週の話ではない。」 |
| 0:20–0:35 | `git log pre-ethonline-2026..ethonline-2026` | Continuity の境界。新しいのはこのコミットだけ。 |
| 0:35–1:15 | Terminal: `run.ts refuse` | まだ一度も買っていない相手（`agent.api.0x.org`）。`/decision` は **BLOCK** で理由は `l0_unverified, l1_not_attempted`。**署名ゼロ**。「この相手が悪いのではない。**我々がまだ測っていない**。」 |
| 1:15–2:15 | Terminal: `run.ts pay` → Base explorer | `/decision` が **ALLOW**（`l0_pass, l1_delivered`）の相手に **1件だけ** `exact` で払う。tx hash → attest → `/decisions` の `source: agent-demo`。**evidence に `source`（vet402 台帳 / Subgraph の生データ）が付く**——第三者が同じ判定を引ける。 |
| 2:15–2:45 | SDK snippet ＋ MCP | signer は判定と policy の両方が通ったときにしか渡らない。**既存の `check_resource_decision` は答えるだけ。これは動く。** |
| 2:45–3:00 | Close | 会期前は「払ってよいか」に答えられた。今週それに**従って動く**ことを覚えた。 |

**数字は撮影当日に `python3 scripts/vet402_video_numbers.py`（Takeshi_Automation）で取り直し、[PASS] / [FAILED2] / [WAITING] を差し替える。**
公開の fail（2回連続）・最新プローブが fail・2回目待ち は**別の数字**なので混ぜない。

支払いが撮れなかった場合: `run.ts catalog` の尺を伸ばし、「payment is implemented and fail-closed;
live settle is not claimed」と言う。モックのハッシュは出さない。

---

## 9. Submission package

- Repo `main` after `--no-ff` merge.
- Video 2–4 min, ≥720p.
- Continuity paragraph in README (past tense).
- `docs/ethonline-2026/AI_USAGE.md`.
- `CHANGED_FILES.md` complete.
- Showcase: problem (agents pay blind) → verb (refuse before sign) → evidence (tx or refuse + feed).
- Judging option: **Finalist and Partner Prizes**.

---

## 10. Continuity application (paste)

> Track: Extend Open Source  
> Repo: https://github.com/kzmttkc/vet402 (MIT, maintained by this team)  
> Site: https://vet402.com
>
> vet402 is an independent verification layer for the x402 agent-payment economy. It already buys what endpoints sell, publishes successes and failures with evidence, and exposes ALLOW / WARN / BLOCK via SDK and MCP. SpendGuard today **decides** and does not pay — an agent can ignore the verdict and sign.
>
> We are not submitting the existing product. During ETHOnline we will add **payOrRefuse**: one call that evaluates the payee and, only on a clean ALLOW, performs an x402 `exact` payment and attests it. BLOCK/WARN refuse before any signature. Demo decisions publish to the public decisions surface as `source: agent-demo`, separate from the L1 observatory ledger.
>
> Git boundary: tag `pre-ethonline-2026` (2026-09-03). Work on branch `ethonline-2026` with commit prefix `ethonline:`. Pre-existing files we touch will be listed in `docs/ethonline-2026/CHANGED_FILES.md`.

---

## 11. Roles

| Human | Agent |
|---|---|
| A1–A4, prize clicks, submit click | Tests, implementation, docs, prize-comment drafts |
| Demo wallet key, first live ALLOW | Fixture research, video script, shot check |
| Voiceover | Never claim work that has not happened |
| “This number is true today” | Pull `/observatory/state` on recording day |

---

## 12. Kill switches

| If | Then |
|---|---|
| Continuity not accepted by kickoff | Email hello@ethglobal.com the same day. Do not start Classic with this repo. |
| ALLOW fixture dies | Swap from the B1 backup list. Do not fake ALLOW. |
| Live pay still broken on 09-11 | Submit refuse-as-wow. Do not mint a fake tx. |
| Scope creep (ENS, registry write, extra UI) | Revert. Four items only. |
| Giant single commit | Split before submit. Unqualified by default under ETHGlobal rules. |

---

## 13. This week (start here)

1. A1 Continuity apply (today or tomorrow).
2. A3–A4 wallet + $5 USDC + API key.
3. Do not open a feature branch. Do not implement `payOrRefuse`.

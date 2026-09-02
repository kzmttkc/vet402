# Grant strategy

> Locked 2026-08-23. Complements the hackathon campaign; does not replace it.
> Narrative: [`STRATEGY.md`](./STRATEGY.md) · Ops calendar: [`2026-autumn-continuity.md`](./2026-autumn-continuity.md)
> Materials already in repo: [`../applications/`](../applications/)

## The bet

Hackathons buy **proof of a new verb** (36 hours / 12 days, Partner prizes).
Grants buy **runway to keep measuring** (purchase capital, RPC, the public record).

Do not sell the same deliverable twice. Do not implement a frozen hackathon verb to decorate a grant. Ask for money against work that is **already live and checkable**, or against ops that are **not** the next Continuity verb.

Expected value, in order:

1. Retro grants for shipped Base work (no new code).
2. Visibility so discovery programs find us (Base, OP Atlas).
3. Prospective grants whose milestones are purchase capital / Solana L1 / infra — not `payOrRefuse`, not ENS-in-the-payment-path, not Validation Registry writes.
4. After each hackathon, **one** grant that cites that weekend’s verb as evidence, not as a promise.

Honest ceiling: we cannot make a grant certain. We can stop asking for invention we already shipped, stop padding budgets, and stop colliding with Continuity boundaries.

---

## 1. What reviewers already have (do not re-pitch as “we will build”)

Live, MIT, independently checkable:

- Observatory L0–L2, real USDC L1 on **Base**, failures published with the same weight
- Public JSON: `https://vet402.com/api/v1/observatory/state`
- Methodology, accuracy ledger, `/impact`
- `@vet402/sdk` / middleware / MCP
- ERC-8004 **reads** + Validation Registry **dry-run** (not writes)
- SpendGuard that **decides** and does not pay (until ETHOnline)

Neutrality (never trade this for a grant):

- We sell nothing on the catalog we measure.
- Measured operators are not customers.
- Sellers cannot pay for a better result.
- No marketing line item aimed at the catalog.

Figures in application drafts are dated **2026-08-23** (except `solana-grant-proposal.md`, whose cost basis is a coherent 2026-08-20 snapshot and is re-quoted whole at submission). Re-`curl` the state API on the submission day. Never invent amounts (`milestones-budget-template.md`).

---

## 2. Two kinds of money

| Kind | Pays for | When to ask | Example |
|---|---|---|---|
| **Retro** | Work already running | Now, and after each ship | Base Builder Grants 1–5 ETH; OP Retro / Atlas |
| **Prospective** | Next 6–12 months of *ops* | After Continuity apply is in; milestones ≠ frozen verbs | Solana L1 purchase capital (~$5,907.75 drafted); ESP if a Wishlist matches |

Do **not** write a prospective milestone that is:

- `payOrRefuse` / `pay_if_trusted` (ETHOnline)
- ENS resolve-then-pay (Tokyo)
- Mainnet Validation Registry **writes** used as the Mumbai demo

Those are hackathon verbs. After they exist on `main` and the event is submitted, they become **retro evidence** for the next grant.

Solana real-purchase (payer exists, default-off, no funds) is **not** a hackathon verb. It may be a grant milestone. It must **not** land on branch `ethonline-2026` / `tokyo-2026` / `mumbai-2026`.

---

## 3. Priority stack (2026 autumn)

### P0 — this week, no new product code

1. **ETHOnline + Tokyo Continuity apply** still wins the calendar. Grants do not jump the queue.
2. ~~**Base Builder Grants (retro, 1–5 ETH).**~~ **SUBMITTED 2026-08-25 10:03 JST**
   **2026-08-31 注記**: `docs.base.org/get-started/get-funded` は Ecosystem Fund 中心の紙面へ作り替えられ、Builder Grants の記載が消えた。ただし**制度は生きている** — 指名フォームは HTTP 200 で受付中、`grants.base.eth` の記事も *"Builder Grants are ongoing experiments"* のまま（実測）。ドキュメントの改稿を制度の終了と読み違えないこと。監視対象も docs ではなく指名フォームそのものへ移した。 — acknowledgement mail received. What we sent is frozen in [`../applications/base-builder-grant-nomination.md`](../applications/base-builder-grant-nomination.md) (excluded from `--write` so the record is not rewritten). Farcaster was not held for: we said "Not on Farcaster yet — X: @vet_402". No reply is expected ("we will not be responding to all requests").
3. ~~**OP Atlas / Retro Funding.**~~ **Dropped 2026-08-23** (read in-browser): atlas.optimism.io announces *"Atlas will be discontinued on September 18, 2026"*; the Onchain Builders mission is **Closed** (season Jul 31–Dec 24 **2025**); and its first eligibility gate is *"My project has deployed contracts on a supported chain"* — vet402 deploys no contracts, it buys from other people's. It was never eligible. Do not spend owner time on a profile there.

### P1 — after Continuity paperwork, still no frozen verbs

4. **Solana Foundation / Superteam** — proposal already drafted (`solana-grant-proposal.md`). Ask is cost-basis, labor $0, purchase capital + list-price infra. Submit when the human can own the legal entity / contact fields. Implementation only on a **non-hackathon** branch, after ETHOnline submit if it would steal September focus.
5. ~~**x402 / CDP / Coinbase-adjacent grants**~~ **no public window as of 2026-08-26** (read coinbase.com/developer-platform/discover/launches in-browser: the newest grant post is *Summer 2025 Builder Grant Recipients*, $30,000 across 13 projects — the round is closed and no 2026 round is announced). Do not draft against it. ~~**Re-check 2026-10-01**~~ — now watched weekly by machine (`Takeshi_Automation/scripts/grant_windows_watch.js`, launchd Mondays 09:10, alerts into `state/ALERTS.md`). The relationship route (the August @murrlincoln contact) is the only live path meanwhile. Original note kept: if a public form appears — Pitch: we are the independent settle-through dataset for the catalog they host. Retro first (1,133 attempts, 496 settled). Prospective only for purchase budget, not for a new protocol.

### P2 — timed to events (evidence, then ask)

| After | Grant input | Ask |
|---|---|---|
| ETHOnline submit | `payOrRefuse` + public tx + `source: agent-demo` | Base / x402 retro addendum: agents can now refuse before sign |
| TOKEN2049 week | Meetings, not Origins | Same one-pager as Devcon; no new grant milestone invented on the floor |
| Tokyo submit | ENS resolve-then-pay | ENS DAO / ENS grants — **only then** |
| Devcon 11/3–5 | ESP Office Hours, EF / 8004 people | Match a **live Wishlist/RFP**. ESP is not an open inbox ([esp.ethereum.foundation](https://esp.ethereum.foundation/)). **2026-08-31 訂正: `esp.ethereum.foundation/wishlist` は 404。正しい入口は [`/applicants`](https://esp.ethereum.foundation/applicants) で、Wishlist / RFPs / Open Rounds はそこの節。実測ではその3節に本文もリンクも無い（= 募集中の項目ゼロ）。手動の 10-20 再確認はやめ、週次の機械監視に置き換えた（アンカーが生えたら鳴る）。** Bring dry-run numbers. Do not promise the Mumbai write as a grant deliverable before 11/6 |
| Mumbai submit | Actual registry writes | EF / 8004 / identity retro: the empty registry is no longer empty |

### P3 — opportunistic

- **Octant — the closest category match we have found (2026-08-26 実測).** Epoch 12 (FINALIZED, 200 ETH matching pool, 25 projects) funded **L2BEAT** ("impartial watchdog … open-source research and analytics") and **growthepie** ("open analytics … free to access and transparent"). That is the same species as vet402: independent public measurement, sells nothing to the measured. Neutrality is an asset here, not a cost.
  **Entry is gated**: Octant v2 applications run through Atlas ([apply.octant.app](https://apply.octant.app), SIWE sign-in) and *"During beta testing, Atlas is available only to selected partners. You will need an invitation code from the Octant team."* No public contact for invites is published. **Next action: ask the Octant team for an invitation code** (owner-approved outbound). The application itself is short — one-sentence pitch, 2–4 paragraphs, category, funding goal in USD, use-of-funds plan, links — all of which already exist in `../applications/`.
- **XRPL Grants / XRPL Accelerator — parked, with one decisive test (checked 2026-08-27).** Unlike Base and Octant this is a *build* program (up to $200K, one unified form, [xrplgrants.org](https://xrplgrants.org/)), so proposing new work is in-scope there rather than a violation.
  What changed our picture: **x402 is live on XRPL and large.** Our catalog shows 0 XRPL endpoints only because our source is the CDP Bazaar. t54.ai runs an XRPL facilitator (`XRPL_NETWORK=xrpl:0`, scheme `exact`, presigned Payment blobs), and [xrpl.fi/x402](https://xrpl.fi/x402) measures **≈7,450 payments/hour** straight from validated ledgers (SourceTag 804681468 + memo) — bigger than the settle volume we see on Base.
  Where we would add something: xrpl.fi counts **payments**; nobody there checks whether the resource was **delivered** after payment. Settle-through is exactly our thing.
  **Blocker — we cannot enumerate the objects to measure.** There is no public directory of XRPL x402 endpoints (t54 publishes merchant/client integration guides and a facilitator, no discovery surface). On-chain we can recover destination *accounts*, not *URLs*, and our sweep needs URLs. Promising a measurement we cannot enumerate is the one thing this project must never do.
  **Decisive test, after the ETHOnline submit (2026-09-13):** can XRPL x402 endpoints be enumerated at all — ask t54 directly, and check whether the Bazaar accepts `xrpl:0` registrations. Enumerable → write the proposal. Not enumerable → drop it and say why.
- Gitcoin: GG24 (Oct 2025) is the last major round; Grants Stack / Grants Lab were wound down 2025-05-31. No open round found 2026-08-26. Re-check when a round is announced, not on a schedule.
- Base Batches / Ecosystem Fund: only if we want equity-shaped capital. Default is **no** — neutrality and public-good posture first.
  **Decided 2026-08-23 (CEO): we are not applying to Base Batches 004** (deadline "Applications close September 9", **$100K investment** from the Base Ecosystem Fund, Demo Day New York November 2026 — [base.org/batches](https://www.base.org/batches), primary check 2026-08-23). Accepting the investment is a condition of the program. Three reasons, in order: (1) the fund belongs to the ecosystem whose catalog we grade — a shareholder relationship is the one attack on our dataset we cannot answer with evidence; (2) we have nothing to sell to the measured catalog, so an investor-track pitch would have to invent a revenue story that neutrality forbids; (3) Demo Day lands on Devcon / ETHMumbai week. The 2026-08-20 GO decision and the owner-approved essay are superseded. Reversible until 09-09 on one line from the owner. The recording effort that this needed goes to the Base Builder Grants 1-minute demo instead — non-dilutive, retroactive, no conflict.
- Guarantee underwriting (`guarantee-underwriting-design.md`): dormant. Do not put it in a grant until legal says so.

---

## 4. How to write every application

Reuse, do not rewrite the thesis:

- One-pager: `impact-one-pager.md`
- Ethereum public-good: `why-ethereum-agent-economy.md`
- Base: `why-base.md`
- Solana: `solana-grant-proposal.md` + `why-solana.md`
- Budget shape: `milestones-budget-template.md`
- AI: `ai-usage-disclosure.md` (do not soften)

Rules:

1. **Already delivered** = measured facts only. Retrieval date + `curl` for `/api/v1/observatory/state`.
2. **Amounts** = quotes or measured cost basis. No rounding for show.
3. **Acceptance checks** a reviewer can run without trusting us (explorer tx, public JSON field).
4. Labor $0 is allowed where true; the human owner / entity is still the legal applicant.
5. One program, one ask. Do not send the Solana budget to Base, or the ENS story to Solana.

---

## 5. Collision with the hackathon freeze

| Frozen until | Grant implication |
|---|---|
| 2026-09-04 | No `payOrRefuse` code for a grant demo. Retro applications OK. |
| 2026-09-25 | No ENS-in-payment-path for an ENS grant demo. Name registration OK. |
| 2026-11-06 | No Mumbai-demo registry **writes**. Dry-run citations OK. Testnet rehearsal that is not the demo write: see campaign calendar. |
| ETHOnline / Tokyo / Mumbai branches | Grant features do not merge into those branches. |

Between events, product ops (probes, Base L1, bugfixes) may continue and must be disclosed as pre-existing at the next hackathon.

---

## 6. Roles

| Human | Agent |
|---|---|
| Entity, tax, wallet for grant receipt, submit click | Drafts, figure refresh, milestone tables |
| Base / EF / Solana conversations | Re-curl state API on submission day |
| Nomination posts (Farcaster/X) in the owner’s voice | Checklists, link packs |
| “This number is true today” | Never claim a grant milestone that has not shipped |

---

## 7. This month (grants only)

1. Finish ETHOnline Continuity apply first.
2. ~~Refresh figures~~ **done 2026-08-23** (`scripts/grant-figures.py`; all application docs now agree with live state and `--check` fails loudly when they do not) → nominate / apply **Base Builder Grants**. Blocked on three owner-side gaps listed in the nomination pack: 1-minute demo, Farcaster handle, receiving wallet.
3. ~~Create or update an OP Atlas profile.~~ Dropped — Atlas is being discontinued 2026-09-18 and vet402 was never eligible (no deployed contracts). See P0-3.
4. Fill legal entity + email on the Solana draft; **do not start Solana L1 implementation** until ETHOnline is submitted (or a clearly separate branch after 09-16).
5. Book Devcon ESP / EF conversations as Mumbai prize work that can also unlock a Wishlist match.

---

## 7.5 製品定義書 v1.0 の大型更新でグラント側が持つ宿題（**2026-09-02 反映後の実行状況**）

**済**: ①数字の定義 — 本番反映後に state と本番DBを突合し、`l1.attempts/settled` の意味は従来どおり
「我々の測定購入」であることを確認（API 2,152 = Base 2,118 + Solana 34、DB との差 45 は network 空の行）。
懸念していた「同名フィールドが実需ベースへ変わる」は起きていない。②計器 — 申請素材を本日値へ更新し
`--check` 緑（L0 pass 1,497→**3,342**、7日カバレッジ 18.1%→**38.6%** と証拠が厚くなった）。
③Solana 提案 — 下記のとおり修正済み。⑤中立性 — §13/§2 を根拠文書として使える。
**訂正（2026-09-02・開発側の指摘）**: 私は日次購入の減少（90–100→43）を「§7.4 の C2 優先による選抜」と
診断したが**誤り**。C2 優先は当日朝に入ったばかりで、09-01 の 43 件はそれ以前。真の上限は**金ではなく時間**
——Vercel cron が1日1回・300秒で 40〜100 件。対応として L1 候補を「C2 → 未購入 in-cap（1,879件）→ 従来順」に変え、
launchd から 09:15 JST の追加実行を足して **1日4回・160〜400件/日**へ（実装済み `f0f2968`）。
申請文で書くべきは「予算が余っている」ではなく「**枠は時間で決まる。4倍に広げた**」である。
支出が $25/日 の枠に届かないこと自体は事実なので、隠さずそう書く。

**残**: ④`/demo` の録り直し（索引の初回フル走査と cron が落ち着いてから。過渡状態を固定しない）。



定義書 VET402-SPEC-1-2-2026-08-31 を 2026-09-01 に精査。**グラントに効く影響だけ**を以下に置く
（会期側の論点は別セッションの所管）。

1. **提出済みの数字の定義が変わる（§7.2）**。wash/test 除外後を「実需」と呼ぶため、**vet402 自身の購入は
   `test` として実需から外れる**。Base 指名（2026-08-25・1,512/601）と Octant intake（2026-08-27・1,681/697）は
   全てその自社購入。数字は「我々が買って測った」意味では真だが、公開面が実需を主指標にすると二重になる。
   → 申請素材の文言を「we buy（測定購入）」と読める形へ寄せる。
2. **計器が緑のまま嘘をつく危険**。`grant-figures.py` は `state` の `l1.attempts/settled` を引く。
   §9.2 が既存維持を約束しているので落ちはしないが、**同名フィールドの意味が実需ベースへ変わると
   `--check` は緑のまま古い主張を通す**。→ 更新後に本番DBと1回突合する。
3. **Solana 提案（9/14 提出予定）の積算**。予算は「186 endpoints × 日次スイープ」。§7.4 の階層化・
   バジェット制と §6.2 の「同一測定ウォレット1時間1回」で頻度設計が変わる。
   → 提出前にマイルストーンと積算が仕様と矛盾しないか確認する。守れない約束を出さない。
4. **`/demo` の陳腐化**。Base 指名で出したデモURLは 8/25 の画面と数字。→ 更新後に実物を見て必要なら録り直す。
5. **追い風**: §13（測定ウォレット公開・売り手から報酬を受けない・Facilitator にならない）と §2 の非目標は、
   公共財枠で主張してきた中立性の根拠文書になる。ただし §14「P1未完で『ポータブル信用』と宣伝しない」に従い、
   申請文で先走らない。

## 8. What we will not do

- Ask a grant to fund a frozen Continuity verb.
- Pad labor or marketing against the catalog we measure.
- Submit stale numbers as if they were today (`python3 scripts/grant-figures.py --check` before every send).
- Treat Devfolio ETHMumbai / Origins prize pages as grant programs.
- Soften the AI-operated disclosure to look like a conventional startup team.

---

## 9. Base Batches 004 の動画素材（ハッカソン戦略セッションからの申し送り・2026-08-31）

Base Batches はグラント/アクセラレータ案件なので、**担当はグラント戦略セッション**。
ハッカソン側で作ってしまった素材を捨てるのは無駄なので、そのまま引き継げる形で置いておく。
以後の判断・提出はグラント側で持つ。

**成果物**
- 撮影パッケージ（正典）: [`../applications/base-batches-004-video.md`](../applications/base-batches-004-video.md)
  ——6ショットの英語台本（§2）＋連続読み上げ版（§7）、画面の下ごしらえ、実装より強い主張の禁止リスト、
  ライブ計測が失敗したときの言い方、提出前チェック。
- `scripts/vet402_video_numbers.py`（Takeshi_Automation）——**当日の数字**と、その日に開くレシート画面・
  Basescan の URL を一次データから出す。**この出力に無い数字を動画で言わない**。
- `scripts/video_setup.sh`——数字を出し、Chrome を 1920×1080 に固定し、台本順に5タブを開く。
- `scripts/video_check.sh`——撮った後に尺(60–300s)・高さ(≥720)・音声トラックの有無を機械判定。
  わざと不合格な動画で自己テスト済み。

**一次確認した事実**
- フォーム実物: 「requires both a written and video submission and **does not save drafts**.
  Prepare all materials offline first」——**下書きが保存されない**ので全素材を揃えてから一度で送る。
- 日程: 8/19 開始 → **9/9 締切** → 9/17 通知 → 9/21–11/15 プログラム → 11/17 NY デモデイ。
- 収録環境の実測: macOS 26.6.2・OBS/Loom なし・QuickTime/iMovie/ffmpeg あり。
  QuickTime の「新規画面収録」は今の macOS では ⌘⇧5 と同じツールバーを開く。
  **「選択部分を収録」**を使う（枠の外に台本を置けるので読みながら撮れる）。

**オーナー裁定（2026-08-31 16:20・これが最終）**: **応募する。「採択されたら法人化して受ける」**。
2026-08-23 に私（グラント側）が決めた取り下げは**撤回**する。根拠は同日に執行部が採取した一次情報:

> "Batch 004 is built around direct investment from the Base Ecosystem Fund rather than grants.
> Selected teams will be offered an investment ... on a **standard Simple Agreement for Future Equity (SAFE)**.
> ... **Accepting the investment is a condition of joining the program.**" — base.org/batches FAQ 原文

- 応募は**無償・非拘束**で、フォームに**法人格を問う設問が無い**（Page1を実物確認）。＝応募時点で法人不要。
  判断は 9/17 の通知後にできる。**今すぐ法人化はしない**。
- 私の 08-23 の取り下げ理由のうち③「Demo Day が Devcon/Mumbai 週と重なる」は**誤り**だった
  （デモデイは 11/17）。①中立と出資の利益相反・②投資家向け収益物語 の2点は懸念として残るが、
  **持分に関わる判断はオーナー専権**であり、裁定は「受ける」。以後この件で取り下げを再提案しない。

**分担**: 撮影は**ハッカソン戦略セッション**（Takeshi指示 2026-08-31 16:20）。素材は下記のとおり完成済み。
グラント側（このセッション）は**採択後に効く下ごしらえ**を持つ:
- **SAFE 署名の期限**を offer stage で最初に確認する（9/17通知 → 9/21開始は4日しかなく、
  署名期限が開始と同じなら法人化が間に合わない）
- **法人の管轄**（Delaware C-corp が要るか日本法人で可か）は base.org に記載が無い。
  **2026-08-31 の当たり付け（公開情報・費用ゼロ）**: Batch 003 の12社には非米国**出身**の創業者が居る
  （4Mica は KU Leuven / Eindhoven の博士2名、Nivo は中南米SMEのFXヘッジ）。ただし 4Mica の所在は
  **サンフランシスコ**とされており、**「非米国の創業者は入れるが、法人は米国側に置いている」**ように見える。
  SAFE は米国の契約書式なので、この見え方と整合する。**推測はここまで。管轄は offer stage で必ず確認する。**
- **開示事項として持っておく**: Batch 003 には **Blockrun.ai（x402 の従量課金インフラ）** と
  **4Mica（エージェント少額決済のクリアリング）** が居る。採択されれば、我々は**測っている市場の
  ポートフォリオ兄弟**になる。裁定は「受ける」で確定しているので蒸し返さないが、
  **中立性の開示文をどう書くかは受諾前に決める**（`/methodology` に一行足す想定）。
- 費用の発生は採択後。それまで1円も使わない

**素材の再利用**（応募とは別に効く）:
- `vet402_video_numbers.py` の「当日の数字＋レシート/Basescan URL」は **`/demo` の録り直し**にも使える。
- 6ショット台本の禁止リスト（実装より強い主張をしない）は今後の動画すべての土台。
- `video_check.sh`（尺・解像度・音声トラックの機械判定）は提出物を持つ他の応募でも流用する。

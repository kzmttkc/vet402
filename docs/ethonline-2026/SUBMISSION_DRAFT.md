# ETHOnline 2026 — 提出フォームに貼る文章（下書き・2026-09-07）

> **用途**: 09-08 に Takeshi が**読んで直すだけ**で済むように、フォームの項目ごとに「何を貼るか・出典・確認方法」を1枚にした。
> **正典は `WINDOW_PLAN.md`**。この文書と食い違ったら WINDOW_PLAN が勝つ。
> **数字の規律**: 本文中の数字はすべて出典つき。**動く数字は `{{…}}` のまま置き、提出当日に §Z の表で埋める**（口で言う数字と同じ規律・`VIDEO_SCRIPT.md` §5）。
> **書かないもの**: 出典の無い数字／装飾語（revolutionary, groundbreaking, first-ever…）／The Graph との過去の関係（`WINDOW_PLAN.md` §1.5）／第三者の未修正の弱点（§10.6）。

## 0. 項目一覧（何が実物で、何が推定か）

提出フォームは **ログイン後にしか開けず、09-07 時点でまだ「Project submissions are not enabled yet」**（`WINDOW_PLAN.md` §0）。
項目名は次の3つの一次情報から写した。**フォームの実物を見ていない項目には【推定】を付けた。**

| 出典 | 取得 | そこから分かった項目 |
|---|---|---|
| `https://ethglobal.com/events/ethonline2026/info/details` | 09-07 curl 実読 | "project title, description, and a link to your repository"／動画 2〜4 分／"select up to 3 Partner Prizes"／各賞に "explain how you've used or integrated their tools, provide feedback, and share relevant comments"／提出は "Finalist and Partner Prizes" か "Partner Prizes Only" の2択 |
| 公開 showcase（`https://ethglobal.com/showcase/aetheros-ipzx7`・`/showcase/atomic-market-zfqvi`・ETHOnline 2025） | 09-07 curl 実読 | 表示される欄: **プロジェクト名**／**1行の短い説明**（名前の直下）／**Project Description**／**How it's Made**／**Source Code**（URL）／**Live Demo**（URL・任意）／動画 |
| 提出フォーム「Select prizes」画面（`PRIZES.md` §1・2026-08-25 実測） | 過去に実物を見た | "Only partners with a Continuity Track prize will be shown for your project." / "You may select up to 3 partners." |

| # | 項目（フォームのラベル） | 実物/推定 | 貼るもの | 節 |
|---|---|---|---|---|
| 1 | Project name | 実物（showcase）・ダッシュボードに作成済み | `payOrRefuse` | §A |
| 2 | 短い説明（tagline） | 【推定】ラベル名。showcase に名前直下の1行がある | 1文 | §B |
| 3 | Project Description | 実物（showcase） | Continuity 構成の本文 | §C |
| 4 | How it's Made | 実物（showcase） | 技術構成 | §D |
| 5 | Source Code（Repo URL） | 実物（showcase・info/details） | GitHub URL | §E |
| 6 | Live Demo URL | 実物（showcase）・任意欄 | `https://vet402.com` | §E |
| 7 | Demo video | 実物（info/details） | **プレースホルダ**。09-12 に埋める | §F |
| 8 | Track / Continuity の事前作業の開示欄 | 【推定】専用欄があるか不明。無ければ §C に含まれている | 事前作業の文 | §G |
| 9 | Submission type | 実物（info/details） | **Finalist and Partner Prizes** | §H |
| 10 | Partner prize 1 — The Graph | 実物（Select prizes 画面） | コメント | §I |
| 11 | Partner prize 2 — Bazantic | 実物（Select prizes 画面） | コメント | §J |
| 12 | Partner prize 3 | 実物 | **選ばない** | §K |
| 13 | Team / メンバー | 【推定】 | Takeshi 1名・Discord `Sen_web3` 連携済み（`WINDOW_PLAN.md` §0） | — |

---

## A. Project name

**出典**: ダッシュボードに作成済み（`WINDOW_PLAN.md` §0）。

```
payOrRefuse
```

**明日確かめること**: ダッシュボードの既存プロジェクト名がこの綴り（大文字 O・R）か。

---

## B. 短い説明（tagline）【推定：ラベル名】

showcase では名前の直下に1行出る（例: "MCP server connecting Claude to Hedera DeFi with 36 tools…"）。文字数制限は不明なので **100 字未満**に収めた。

```
An x402 payment gate that refuses before a signature exists — judged on live data from The Graph, not on our word.
```

（108 字。制限が 100 字なら下の短い版）

```
x402 payment gate: refuse before signing, judged on live The Graph data.
```

（72 字）

**数字**: なし。
**明日確かめること**: 欄の文字数制限。超えたら短い版。

---

## C. Project Description

**出典**: `README.md` "ETHOnline 2026 (Continuity)" 節／`WINDOW_PLAN.md` §2・§3.1・§3.2・§10.5／`DISCLOSURE_2026-09-05.md`／`SKILL.md`。
**構成**: 何が在ったか → 会期で何を足したか → 境界（タグ・コマンド・書面開示）→ 審査員が動かす手順。

```
vet402 is an independent verification layer for the x402 agent-payment economy. Before this hackathon it already bought what x402 endpoints sell with real USDC on Base, published every success and failure with evidence, and answered "should my agent pay this?" through GET /api/v1/resources/{id}/decision, an SDK, and an MCP server. All of that is pre-existing and is not what we are submitting.

WHAT THE WINDOW ADDED

Before the window vet402 could answer the question. During the window it learned to act on the answer without letting the model decide.

1. payOrRefuse (SDK, packages/sdk). One call: read the decision, apply the caller's own policy, and only if both pass, sign the x402 "exact" payment (EIP-3009, Base USDC) and attest it. On anything else it refuses before a signature exists and returns machine-readable reason codes. The payment module is loaded only inside the allow branch; the tests read the built dist/ module graph to prove the refuse path cannot reach it.

2. The Graph as an evidence source. policy.evidence.source = "vet402" | "subgraph" | "both". With "subgraph", payOrRefuse queries the x402 Base subgraph (Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj) through the Graph Gateway with the caller's own key and puts the result on the decision as its own evidence row, carrying _meta.block.number, the deployment hash and queriedAt, so a reader can tell a live read from a cached number. If the subgraph cannot be read the call refuses (evidence_unavailable); it never falls back to our ledger.

3. Caller-declared floors, and the boundary that keeps them honest. requireVet402Allow: false lets a caller waive our WARN when their own floors are met (for example minSubgraphReceipts: 1, "The Graph's own ledger is enough"). BLOCK and degraded are never waived. The decision record keeps our WARN and states "verdict from: caller_policy" — we do not rewrite our own judgement to match the payment.

4. The uncatalogued path. The seller in our demo is The Graph's own x402 endpoint, which is not in vet402's catalogue: /decision answers 404. Instead of registering it (which would look staged), payOrRefuse judges from the 402 challenge itself: the payTo address, the payee score for that address, and the caller's floors. Real buyers meet 402s from sellers nobody has catalogued; a gate that only works inside our catalogue would not be useful.

5. MCP tool pay_if_trusted (packages/mcp-server) — the same gate as one tool, forwarding the same policy to payOrRefuse unchanged. The Graph key is read from the server's env, never from the model's context. Documented in SKILL.md: the tests, the offline refusal and tools/list need no key at all; the live reads need one free Subgraph Studio key; no payer key is needed to evaluate anything.

6. Agent decisions published with source: "agent-demo" in an append-only store, never mixed into the production purchase ledger.

7. A pre-registered A/B harness (examples/ethonline-2026-ab) for the Bazantic prize, plus the demo (examples/ethonline-2026-demo: refuse, pay, judge <url>) and caller_policy on /decision so the server answers in the SDK's words.

IT MOVED REAL MONEY ONCE

On 2026-09-05 a throwaway payer ran payOrRefuse against The Graph's own x402 endpoint with requireVet402Allow: false and minSubgraphReceipts: 1. Our engine rates that payee WARN (69) — which means "we have never bought from this seller", our gap, not the seller's fault. The subgraph reported 259 receipts. The gate signed and the seller settled: 0.01 USDC, block 50898704, tx 0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad on Basescan. The payer's ETH balance stayed at 0 (EIP-3009: the buyer pays no gas). The decision record kept the WARN.

THE BOUNDARY

Tag pre-ethonline-2026 = commit c42daca, cut 2026-09-04 00:05:36 UTC, and pushed. The window opened at 2026-09-04 16:00 UTC (ETHGlobal's schedule, hacking-begins), so the tag is 15 hours 54 minutes before the start. Three commits in the range we claim were made before 16:00 UTC — 37c56db and e668957 touch only docs/ethonline-2026/WINDOW_PLAN.md, and ac6ec2e adds 16 lines under packages/sdk (6 in src/index.ts, 10 in the generated dist/index.d.ts) alongside settlement work; SHAs, times and the command that lists them are in docs/ethonline-2026/DISCLOSURE_2026-09-05.md. Everything else we claim is after the start. main is also this product's production branch, so the full range contains work we are not claiming; both commands are in README.md:

  git log pre-ethonline-2026..main -- packages/sdk packages/mcp-server examples/ethonline-2026-demo examples/ethonline-2026-ab SKILL.md AI_USAGE.md docs/ethonline-2026   # our claim ({{claimed_commits}} commits as of {{as_of}})
  git log pre-ethonline-2026..main   # everything on main in the same days ({{window_commits}} commits)

Pre-window work since our Continuity application (2026-08-23) — 214 commits, 412 files, +28,414 / −1,913 lines — was disclosed to ETHGlobal in writing on 2026-09-05; the message as sent is docs/ethonline-2026/DISCLOSURE_2026-09-05.md. Pre-existing files edited during the window: docs/ethonline-2026/CHANGED_FILES.md (derived by command, not by hand). Who wrote what, human and AI: AI_USAGE.md. The instructions we worked from, by day: docs/ethonline-2026/PROMPTS/.

RUN IT

npm run judge-check from the repo root runs every test of sdk, mcp-server, demo and the A/B harness with every key unset. SKILL.md walks a judge from git clone to a live read of The Graph and a dry-run payment; nothing on that page needs a payer key.
```

**文中の数字と出典**

| 数字 | 出典 | 性質 |
|---|---|---|
| `Cb56epg3…` subgraph id | `SKILL.md` "Paying on The Graph's own data" | 固定 |
| WARN (69) | `WINDOW_PLAN.md` §3.2.1（理由は §3 末尾） | **動く**。09-07 12:xx の実測は **68**（`LIVE_JUDGING.md` §「WARN の値」）。§3.2.1 の「会期中 69 のまま」は外れた。提出日に `{{graph_score}}` を取り直し、本文の "WARN (69)" を画面の値へ置換 |
| 259 receipts | `WINDOW_PLAN.md` §10.5・`SKILL.md`（支払い時点の値） | 固定（過去の事実） |
| 0.01 USDC / block 50898704 / tx `0xf12093fb…` | `WINDOW_PLAN.md` §10.5（チェーン再読）・`SKILL.md` | 固定 |
| `c42daca` 2026-09-04 00:05:36 UTC | `README.md`・`CHANGED_FILES.md` | 固定 |
| 214 / 412 / +28,414 / −1,913 | `README.md`（`git rev-list --count 26a7c66..pre-ethonline-2026`） | 固定 |
| 2026-09-05 書面開示 | `DISCLOSURE_2026-09-05.md` | 固定 |
| `{{claimed_commits}}` / `{{window_commits}}` / `{{as_of}}` | §Z の表 | **動く。提出日に埋める** |

**明日確かめること**: 欄に文字数制限があるか（あれば "IT MOVED REAL MONEY ONCE" を残して "WHAT THE WINDOW ADDED" の 6・7 を削る）。

---

## D. How it's Made

**出典**: `WINDOW_PLAN.md` §3・§14・§14.1・§14.3・§15／`SKILL.md`／`AI_USAGE.md`／`BAZANTIC_FEEDBACK.md`。

```
STACK. TypeScript. packages/sdk (payOrRefuse, x402-pay, subgraph-evidence) and packages/mcp-server (pay_if_trusted, stdio) are plain Node packages, Node >= 20; the demo under examples/ethonline-2026-demo runs .ts directly on Node >= 22.18. The service behind vet402.com is Next.js on Postgres and is pre-existing.

THE GATE. payOrRefuse runs in this order and stops at the first failure (the header of packages/sdk/src/pay-or-refuse.ts): (1) caller errors (a payee that is not a 0x address, a policy that waives ALLOW without declaring a floor — invalid_policy) are rejected before any request; (2) the caller's own price ceiling is applied before the decision is fetched (price_above_ceiling, zero requests); (3) GET /decision for the resource, role=payer — unreadable or degraded refuses; a 404 means "not catalogued" and hands the judgement to the 402's payTo plus the payee score for that address; the evidence floors the caller declared are read and checked here, and vet402's recommendation is applied: ALLOW passes; WARN passes only if the caller set requireVet402Allow: false and every floor is met; BLOCK and degraded are never waived; (4) the real 402 challenge is fetched and its payTo, network, asset, scheme and amount are matched against what the caller named; (5) only then is the payment module dynamically imported. Refusals carry reason codes from a closed vocabulary (l1_not_attempted, resource_uncatalogued, price_above_ceiling, payee_recommendation_block, evidence_unavailable, ...).

HOW THE GRAPH DECIDES THE OUTCOME. With policy.evidence.source "subgraph" or "both", the SDK queries the x402 Base subgraph (Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj) at gateway.thegraph.com with the caller's Subgraph Studio key: x402AddressSummaries filtered by the payee address with role RECIPIENT (totalPayments, totalVolumeDecimal — the same address can also hold a PAYER row, which must not be added in) plus _meta { block { number } deployment }. A 200 whose body carries GraphQL errors (the Gateway's answer to a missing key) is treated as unreadable, not as zero receipts. The evidence row on the decision carries subgraphId, block number, deployment and queriedAt, and the key-less publicUrl, so the record never contains the key. minSubgraphReceipts is a floor against that count. A failed read refuses; there is no fallback to our own ledger. This is what let a caller pay The Graph on The Graph's own data while our engine still said WARN.

THE x402 PAYMENT PATH (v2, scheme "exact", eip155:8453, USDC 0x8335...2913, EIP-3009). Build the transferWithAuthorization: from, to = accept.payTo, value = accept.amount exactly, validBefore rounded to at most 120 s, nonce = 32 random bytes we generate. Sign it as EIP-712 with the USDC domain pinned to on-chain measured constants (name "USD Coin", version "2") — never taken from the seller's accept.extra. Persist the nonce immediately after signing. Re-send the original request with the PAYMENT-SIGNATURE header (v1: X-PAYMENT). Read the settlement claim from the PAYMENT-RESPONSE header; the SDK reports it as settle_claimed, not settled — only a chain re-read may say settled. The buyer never calls a facilitator and pays no gas.

PROOF THAT REFUSE CANNOT SIGN. Three layers, all in the tests: the payer account is a Proxy that counts property reads (0 on every refuse path; a negative control that flips --live sees exactly 1); the built dist/index.js module graph is walked and the payment module must appear only behind a dynamic import; and packages/sdk/test-mutations.mjs applies {{mutations}} source mutations (pass a BLOCK under requireVet402Allow: false, flip the subgraph floor comparison, treat a /decision 404 as ALLOW, drop the payTo check, move the dynamic import outside the allow branch, read data past a GraphQL error, ...) and requires every one to turn the suite red.

MCP. pay_if_trusted takes the same policy object and forwards it to payOrRefuse unchanged; it does not re-judge. GRAPH_API_KEY comes from the server's env block; if the policy asks for the subgraph and the key is missing the tool refuses with graph_key_not_configured before reading anything. VOUCH_API_KEY is optional since 2026-09-07 because /decision answers key-less at 10 requests per minute per IP.

BAZANTIC. A Bazantic-built x402 gateway fronts vet402's REST API as {{bazantic_tools}} MCP tools (https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp) and a public Recipe explains when and how to use it. The A/B harness (examples/ethonline-2026-ab) gives the same model the same prompt and the same tools twice, with the Recipe as the only difference (a test pins stripRecipe(B) === A byte for byte), grades every trial against what vet402's API actually returned, and writes raw trials.jsonl that npm run metrics regrades from scratch. Because the gateway answers 402 even on $0 routes and MCP tools/call cannot carry a payment, the harness includes a bridge that signs only when the quoted amount is exactly "0" and re-sends over REST.

AI. Claude (Opus / Fable, via Claude Code) wrote most of the code under human direction; the failing tests for the gate were written before the implementation. AI_USAGE.md lists the areas and files and what the human did; docs/ethonline-2026/PROMPTS/ holds the day-by-day instructions verbatim. No AI voice is used in the video.
```

**文中の数字と出典**

| 数字 | 出典 | 性質 |
|---|---|---|
| Node >= 20 / >= 22.18 | `SKILL.md` Prerequisites | 固定 |
| eip155:8453 / USDC `0x8335…2913` / EIP-3009 / 120 s / nonce 32 bytes / "USD Coin" v2 | `WINDOW_PLAN.md` §3・§14・§14.1 | 固定 |
| 10 requests/min per IP | `SKILL.md` Configure（AQ-053・09-07 実装） | 固定 |
| `{{mutations}}` | `<!-- n:sdk_mutations -->`（`npm run refresh-numbers`） | 動く（09-10 記録値 45） |
| `{{bazantic_tools}}` | `SKILL.md` "What is not built yet"（09-06 `tools/list` 実測 57） | 動く。提出日に `tools/list` で再確認 |
| `x402AddressSummaries` / `totalPayments` / `role: RECIPIENT` / `_meta { block deployment }` / 鍵無しは 200＋GraphQL errors | `WINDOW_PLAN.md` §15（introspection で確定・実測） | 固定 |
| 判定の 5 段の順序 | `packages/sdk/src/pay-or-refuse.ts` 冒頭コメント「判定の流れ（5行）」 | 固定 |
| 変異の例 6 つ | `packages/sdk/test-mutations.mjs` の `what:`（M01・M05・M11・M12・M14・M23） | 固定 |

**明日確かめること**: 「PROOF」段の3層が `packages/sdk/test/` の現行テスト名と一致するか（`grep -l "dist" packages/sdk/test/*.mjs`）。

---

## E. Source Code / Live Demo

| 欄 | 貼る値 | 出典 |
|---|---|---|
| Source Code | `https://github.com/kzmttkc/vet402` | `README.md` |
| Live Demo（任意） | `https://vet402.com` | `README.md`（playground は `https://vet402.com/playground`。会期の新規は SDK/MCP なので、サイトの URL を置き、動く部分は動画と `SKILL.md` に任せる） |

**明日確かめること**: リポが public であること（`curl -sL -o /dev/null -w '%{http_code}' https://github.com/kzmttkc/vet402` → 200）。タグが push 済み（`git ls-remote --tags origin pre-ethonline-2026`）。

---

## F. Demo video

```
{{video_url}}   ← 09-12 に埋める（画面収録 09-12・ナレーション 09-08〜・VIDEO_SCRIPT.md §4）
```

**規定**（`info/details` 09-07 実読）: 2〜4 分（外れると**アップロード時に自動拒否**）・**720p 以上**・早回し不可・音楽＋テキストのみ不可・**スマホで撮らない**・**AI 音声不可**。台本は 3:04（`VIDEO_SCRIPT.md` §1）。

**明日確かめること**: なし（09-12 の作業）。**提出前**: 動画の長さと解像度を `ffprobe` で見る（`ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 <file>`）。

---

## G. Continuity の事前作業の開示欄【推定：専用欄の有無】

規約（`https://ethglobal.com/rules`・`PRIZES.md` §1）は "disclose any pre-existing work in writing to the ETHGlobal team and include full details in your submission (repo history, video, and description)" を要求する。**専用欄があればここを貼る。無ければ §C の "THE BOUNDARY" 段が同じ内容を持っている。**

```
Pre-existing (not submitted): the x402 Observatory (L0 probes, L1 real purchases with a daily budget, L2 conformance), the 0–100 score with ALLOW / WARN / BLOCK, GET /api/v1/resources/{id}/decision (product spec v1.0, shipped 2026-09-02), /resolve, the settlement index, the SDK @vet402/sdk, the MCP server @vet402/mcp-server with check_resource_decision (reads a decision, never signs), the Python SDK and framework adapters under examples/. Everything reachable on main at tag pre-ethonline-2026 (commit c42daca, 2026-09-04 00:05:36 UTC).

Between our Continuity application (2026-08-23) and the window: 214 commits, 412 files, +28,414 / −1,913 lines, all before the tag — disclosed by email to hello@ethglobal.com on 2026-09-05 (copy: docs/ethonline-2026/DISCLOSURE_2026-09-05.md; it says 207 because its per-day sentence stops at 2026-09-03; the same file shows both counts and the commands).

Built during the window: payOrRefuse (SDK), The Graph subgraph evidence source, caller-policy floors with the BLOCK boundary, the uncatalogued-seller path, MCP pay_if_trusted, the agent-demo decision store, the demo (refuse / pay / judge), caller_policy on /decision, the key-less /decision read, and the Bazantic A/B harness. Verify: git log pre-ethonline-2026..main (every commit is dated inside the window). Pre-existing files we edited: docs/ethonline-2026/CHANGED_FILES.md. Human vs AI authorship: AI_USAGE.md.
```

**数字**: §C と同じ出典。207 vs 214 は `DISCLOSURE_2026-09-05.md` 末尾。
**明日確かめること**: 欄が無ければ何もしない（§C に含まれている）。

---

## H. Submission type

**選ぶ**: **1. Finalist and Partner Prizes**（`WINDOW_PLAN.md` §1.45 決定）。

根拠（`info/details` 09-07 実読）: "The first round of judging has no impact on your project's eligibility for partner prizes" ／ Continuity のファイナリスト枠は最大 3（`WINDOW_PLAN.md` §1.4・Pascal 2026-08-17）。
**副作用**: Round 1 を通ると **ライブ審査（1 チーム 7 分＝デモ 4 分＋Q&A 3 分）**に Takeshi が出る。2025 は締切の約 1 日後（`WINDOW_PLAN.md` §1.4）。**09-14〜16 を空ける。Round 1 の通過連絡はメール。**

---

## I. Partner prize 1 — The Graph: Best AI Tooling or AI Use Case with The Graph (Continuity)

**出典（要件語）**: `https://ethglobal.com/events/ethonline2026/prizes/the-graph`（09-07 curl 実読）。
要件 5 つ: **load-bearing**／**live data from a Graph provider**（mocked・local・static は不可）／**meaningful work**（生の結果を印字するだけは不可・ツールは **reusable infrastructure**）／**README or SKILL.md** で審査員が動かせる＋公開リポ＋動画／**Continuity pool** を選び事前作業を文書化。

**人間の視点**: 審査員は The Graph の人。**自社のウォレットが我々のエンジンで WARN と出る**絵を見る。「The Graph を疑っている」と読まれる前に、**我々の欠損であって売り手の落ち度ではない**と最初に言う。

```
FIRST, ABOUT THE WARN YOU WILL SEE. The demo pays The Graph's own x402 endpoint (gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3...). vet402's payee engine rates that receiving wallet WARN (69). That is not a judgement about The Graph: the reason code is l1_not_attempted — vet402 has never bought from that seller, so it has no delivery evidence of its own. The gap is ours, and the point of this submission is that a caller can fill it with The Graph's data instead of ours.

LOAD-BEARING. payOrRefuse (SDK) and pay_if_trusted (MCP) decide whether a signature is created. With policy.evidence.source "subgraph" or "both", that decision depends on a live query of the x402 Base subgraph (Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj) for the payee's receipt count. If the read fails, the gate refuses (evidence_unavailable); there is no fallback to vet402's own ledger. Remove The Graph and the "subgraph" policy cannot pay anything.

LIVE. Every query goes through gateway.thegraph.com with the caller's own Subgraph Studio key, never through a cache on our side. The evidence row on every decision carries _meta.block.number, the deployment hash and queriedAt, so a judge can see exactly which block each run read. The offline tests inject a stub reader and are labelled as offline; the live commands in SKILL.md print the real block, and that is what the video shows.

MEANINGFUL WORK, NOT A PRINTOUT. The data is not displayed, it is enforced. The caller declares a floor (minSubgraphReceipts) and may declare that vet402's own ALLOW is not required. On 2026-09-05 that exact policy — "at least one receipt in The Graph's ledger, vet402's approval not needed" — read 259 receipts and signed a real payment: 0.01 USDC, block 50898704, tx 0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad. The record keeps vet402's WARN alongside "verdict from: caller_policy". The same wallet, three sources, three answers (our catalogue: 404; our engine: WARN 69; The Graph's subgraph: {{graph_receipts}} receipts as of {{as_of}}) — and the caller chooses whose evidence counts. BLOCK is never waived.

REUSABLE INFRASTRUCTURE. This is a library and an MCP tool, not an app: packages/sdk exports payOrRefuse and the subgraph reader; packages/mcp-server exposes pay_if_trusted to Claude, Cursor or any MCP client; examples/ethonline-2026-demo has judge <url> for any x402 URL a judge chooses. The x402 subgraph is queried as a generic evidence source keyed by payee address, so it works for sellers vet402 has never seen.

SKILL.md. Every block on SKILL.md was run on a fresh clone before it was written. npm run judge-check runs all tests with every key unset (SDK, MCP server, demo, A/B harness, {{sdk_tests}} + {{mcp_tests}} + {{demo_tests}} tests, fail 0 as of {{as_of}}). One free Subgraph Studio key is the only thing needed to reproduce the live reads; no payer key is needed to evaluate the submission.

CONTINUITY. The SDK and MCP server existed before the window; the window added the gate, the subgraph evidence source, the caller floors and the MCP tool. Boundary: tag pre-ethonline-2026 (c42daca, 2026-09-04 00:05:36 UTC). Pre-window work was disclosed in writing on 2026-09-05 (docs/ethonline-2026/DISCLOSURE_2026-09-05.md). Edited pre-existing files: docs/ethonline-2026/CHANGED_FILES.md.

FEEDBACK. The Graph Gateway's x402 402 returns an internal resource URL (mainnet-thegraph-arbitrum-...), so a client that matches on resource URL cannot pay; we match on payTo instead. Documented in WINDOW_PLAN.md §3. The subgraph's X402AddressSummary was exactly what a payment gate needs — payment count and amount by recipient — and _meta made "live" provable.

Model-side judgement never decides a payment; the gate does. Our demo's own decisions are stored with source: "agent-demo", apart from the production ledger.
```

**文中の数字と出典**

| 数字 | 出典 | 性質 |
|---|---|---|
| WARN (69) / l1_inconclusive（拒否側 0x.org・09-08 から。1 回決済・4xx・結論なし） | `WINDOW_PLAN.md` §3・§16 F2/F3 | **スコアは動く**（09-07 12:xx は 68）。提出日に `{{graph_score}}` と `grep reasons` で取り直す |
| 259 / 0.01 USDC / 50898704 / tx | `WINDOW_PLAN.md` §10.5 | 固定 |
| 404 | `WINDOW_PLAN.md` §3.1（登録しない決定） | 固定 |
| `{{graph_receipts}}` | `VIDEO_SCRIPT.md` §5 のコマンド（09-07 07:5x 実測 417） | **動く・提出日に埋める** |
| `{{sdk_tests}}` / `{{mcp_tests}}` / `{{demo_tests}}` | `VIDEO_SCRIPT.md` §5 のコマンド（09-08: 1615 / 748 / 169） | **動く** |
| internal resource URL | `WINDOW_PLAN.md` §3 注意書き | 固定 |

**明日確かめること**: 冒頭の WARN 段を読んで「The Graph を疑っている」と読めないか。読めたら書き直す。
**書いていないこと（意図的）**: The Graph との過去の関係（§1.5）。

---

## J. Partner prize 2 — Bazantic: Help an Agent Use Your Hackathon Project

**出典（要件語）**: `https://ethglobal.com/events/ethonline2026/prizes/bazantic`（09-07 curl 実読）。
要件 8 つ: アカウント／Gateway／**Recipe（when, why, how）**／同じ prompt・model・settings・API access／**Recipe を唯一の差**に／**両方の結果と入力を提出物で示し改善を特定**／**差を歩いて見せる動画**／**ユーザー名**。
Tom Hay（`#partner-bazantic`・`WINDOW_PLAN.md` §16.2）: notes（開発者フィードバック）＋ A/B の短い画面収録。

**人間の視点**: 差が 0 だった。**隠さない。** 差 0 を先に言い、語彙が直った事後指標と、88 tx の所見を添える。審査員（Bazantic）は自社製品の欠点を読む——**製品への攻撃ではなく、直せば良くなる点として書く**（`BAZANTIC_FEEDBACK.md` §5 の形）。

```
Bazantic username: TakeshiTGAL (GitHub OAuth).

WHAT WE BUILT ON BAZANTIC
- Gateway: https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com (upstream vet402.com, live since 2026-09-03, every route at 0 mcents). MCP endpoint …/mcp, {{bazantic_tools}} tools.
- Recipe: https://bazantic.com/recipes/x402-payee-verification-via-vet402-gateway (published 2026-09-07). The copy the harness feeds to condition B is byte-identical to the public description.
- Harness: examples/ethonline-2026-ab, pre-registered in docs/ethonline-2026/WINDOW_PLAN.md §16 on 2026-09-05, before any real trial.

THE A/B (same task, same model, same settings, same access; Recipe is the only difference)
Task to the agent: "Before you pay this x402 endpoint, establish whether the payee has actually delivered before. If there is no evidence, do NOT pay, and give your reason as machine-readable codes."
Model claude-opus-5, effort high, temperature not sent (the model rejects it; recorded as a pre-registration deviation), the same {{bazantic_tools}} MCP tools and the same raw API list in both conditions. A test pins stripRecipe(B) === A byte for byte. Four fixtures with a measured oracle (what vet402's API actually returned): a payee with delivered purchases (proceed), The Graph's uncatalogued payee (refuse), a payee never bought from (refuse), a price above the caller's ceiling (refuse). 10 trials per condition, run once, not re-run.
Success = verdict matches the oracle AND every reason code the agent gives is one the oracle returned AND the list is non-empty on refuse.

RESULT — no difference in success. A (no Recipe): 5/10. B (Recipe): 5/10. Both conditions passed the same two fixtures and failed the same two. Our pre-registered prediction ("A gets the verdict right but fabricates reasons") was half right: A fabricated codes in 5/10 trials; B still failed the same fixtures.

WHAT THE RECIPE DID FIX — vocabulary. Without it the agent turns screen words into "codes" (WARN, thin, Unverified, receiving.paymentCount=0). With it the agent uses vet402's real identifiers (resource_uncatalogued, l1_not_attempted, evidence_unavailable). Share of reason codes that are real vet402 identifiers: A 20/32 (63%) → B 29/32 (91%). This metric is exploratory (not pre-registered) and is labelled so.

WHY THE TWO FAILURES ARE OURS. The over-ceiling fixture expects price_above_ceiling, a caller-side word from our SDK that no gateway tool returns and the Recipe did not mention — so no condition could produce it. The uncatalogued fixture fails because B lists more real codes than the oracle returns. We fixed the product side after the run (/decision now accepts the caller's ceiling and returns caller_policy.reason_codes) and pre-registered a v2 run rather than re-running v1. {{ab_v2_line}}

INPUTS AND RESULTS, REPRODUCIBLE. Raw logs: docs/ethonline-2026/ab/2026-09-06T213134Z/ (every prompt, every tool call, every answer). Recount: cd examples/ethonline-2026-ab && npm run metrics -- ../../docs/ethonline-2026/ab/2026-09-06T213134Z — it regrades from raw and reads no summary. The earlier same-day run 2026-09-06T093254Z (0/10 and 0/10, every tool call answered 402) is kept, not deleted.

VIDEO. The A/B walk-through is at {{video_ab_timestamp}} of the demo video (both runs, the tables, the Recipe page).

DEVELOPER FEEDBACK (full: docs/ethonline-2026/BAZANTIC_FEEDBACK.md)
1. $0 routes still answer 402, and paying $0 posts a real 0-USDC transfer on chain. In our 20 trials: 110 tool calls, 88 settled with a 200, 88 distinct on-chain transactions of 0 USDC. 88 free reads cost 88 facilitator transactions.
2. MCP tools/call cannot carry a payment: a PAYMENT-SIGNATURE header on the /mcp POST is ignored, the tool result is isError: true with the 402 body. So a standard "Add to Claude / Cursor / ChatGPT" client lists the tools and can use none of them — run 093254Z measured exactly that.
3. Our workaround in the harness: a bridge that, only when the quoted amount is exactly "0", signs and re-sends the same resource over REST; non-zero amounts fail loudly.
4. The "JWT that bypasses x402/MPP for testing" mentioned in #partner-bazantic — we could not find it in the docs or dashboard; if it exists it is the cleanest path for judges.
5. baz recipe (the documented way to run a public Recipe with a payer) is not in @bazantic/cli@0.8.0 on npm.
6. The public Recipe page shows name, author, description and input form, but not the prompt text — a reviewer cannot read what the agent is told without an account.
What would help agents: return the body for 0-mcent routes without a settlement (or a "free below N" switch); let tools/call carry a payment or return the 402 as a structured accepts object; put the Recipe into MCP initialize.instructions; show the Recipe prompt on the public page.
One keystore-related item was sent privately to support@bazantic.com on 2026-09-06 and is intentionally not described here.
```

**文中の数字と出典**

| 数字 | 出典 | 性質 |
|---|---|---|
| A 5/10・B 5/10／捏造 5／20/32 (63%)・29/32 (91%)／110 calls・88 settled・88 tx | `npm run metrics -- docs/ethonline-2026/ab/2026-09-06T213134Z`（`BAZANTIC_FEEDBACK.md` §2・§4） | 固定（生ログ・回し直さない） |
| 0/10・0/10（093254Z） | `WINDOW_PLAN.md` §16.1 | 固定 |
| `{{bazantic_tools}}` | `tools/list`（09-06 実測 57） | 動く。提出日に再確認 |
| 2026-09-03 LIVE／0 mcents／`@bazantic/cli@0.8.0` | `BAZANTIC_FEEDBACK.md` §1・§4 | 固定 |
| `{{ab_v2_line}}` | `WINDOW_PLAN.md` §16.5（09-09 に 1 回実走予定） | **v2 を走らせたら 1 文で結果を書く（例: "v2 (…/ab/<timestamp>): A x/10, B y/10."）。走らせなかったら "v2 has not run yet." に置換** |
| `{{video_ab_timestamp}}` | `VIDEO_SCRIPT.md` §1（台本では 2:12–2:41） | 09-12 の編集後に確定 |

**明日確かめること**: Recipe の公開ページが 200 で開くこと（`curl -sL -o /dev/null -w '%{http_code}' https://bazantic.com/recipes/x402-payee-verification-via-vet402-gateway`）。Select prizes 画面に **Bazantic が出ること**（`PRIZES.md` §3 P3「未確定」・出なければ Ledger Continuity に差し替えず**2枠のまま出す**——Ledger は実機未確認で、使っていない製品の枠に応募しない §16 の判断と同じ）。

---

## K. Partner prize 3 — 選ばない

**決定**: `WINDOW_PLAN.md` §16「3枠目」（2026-09-06）。残る 9 パートナーはどれも使っていない。埋めるには会期スコープ外の実装が要る。**使っていない製品の枠に応募するのは、パートナーの審査時間を使わせて我々の主張を薄める。**
**例外**: 09-11 の凍結までに「既に満たしている」枠が見つかった場合だけ入れる（見つかっていない・09-07）。

**明日確かめること**: Select prizes 画面で **The Graph と Bazantic の 2 つだけ**にチェックが入っていること。

---

## Z. 提出日に埋める数字（`{{…}}` → 値）

**規律**: `VIDEO_SCRIPT.md` §5 と同じ。提出日の朝にこの表を上から叩き、値を本文へ書き込む。**手で数えない。** 鍵が要る行は `set -a; source ~/vouch/.env.rehearsal.local; set +a` の後。

| プレースホルダ | コマンド（リポ root から） | 09-07 の値 | 使う節 |
|---|---|---|---|
| `{{as_of}}` | `TZ=UTC date +%F`（提出日） | 2026-09-07【実測】 | C・I |
| `{{window_commits}}` | `git log pre-ethonline-2026..main --oneline \| wc -l` | 233【実測 09-07 12:2x・この作業ツリー】 | C |
| `{{claimed_commits}}` | `git log pre-ethonline-2026..main --oneline -- packages/sdk packages/mcp-server examples/ethonline-2026-demo examples/ethonline-2026-ab SKILL.md AI_USAGE.md docs/ethonline-2026 \| wc -l` | 123【実測 同上】 | C |
| `{{graph_receipts}}` | `cd examples/ethonline-2026-demo && node src/run.ts pay 2>&1 \| grep totalPayments`（`GRAPH_API_KEY` 要） | 417【一次・`VIDEO_SCRIPT.md` §5 09-07 07:5x】 | I |
| `{{graph_score}}` | 同上 `\| grep 'payee verdict'` | 09-07 07:5x は WARN (69)、同日 12:xx は **WARN (68)**【一次・`VIDEO_SCRIPT.md` §5 ／ `LIVE_JUDGING.md`】＝**同じ日に動いた**。**69 でなければ本文の "WARN (69)" をその値に置換** | C・I |
| `{{sdk_tests}}` | `cd packages/sdk && npm ci && npm test 2>&1 \| grep -E '^ℹ (tests\|fail)'` | 1615 / fail 0【`refresh-numbers.json` 09-08】 | I |
| `{{mcp_tests}}` | `cd packages/mcp-server && npm ci && npm run build && npm test 2>&1 \| grep -E '^ℹ (tests\|fail)'` | 748 / fail 0【`refresh-numbers.json` 09-08】 | I |
| `{{demo_tests}}` | `cd examples/ethonline-2026-demo && npm test 2>&1 \| grep -E '^ℹ (tests\|fail)'` | 169 / fail 0【`refresh-numbers.json` 09-08】 | I |
| `{{mutations}}` | `npm run refresh-numbers` → `<!-- n:sdk_mutations -->` | 45【`refresh-numbers.json` 09-10】 | D |
| `{{bazantic_tools}}` | `curl -s -X POST https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \| python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]["tools"]))'` | 57【一次・`SKILL.md` 09-06】 | D・J |
| `{{ab_v2_line}}` | v2 を走らせた場合のみ `npm run metrics -- <v2 dir>` | 未実走（09-09 予定・§16.5） | J |
| `{{video_url}}` / `{{video_ab_timestamp}}` | 09-12 の編集後 | — | F・J |

**固定の数字（動かない・確認だけ）**: tx `0xf12093fb…e469ad`／block 50898704／0.01 USDC／payTo `0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB`／259 receipts（支払い時点）／`c42daca` 2026-09-04 00:05:36 UTC／214・412・+28,414・−1,913／A 5/10・B 5/10／63%・91%／110・88・88／`TakeshiTGAL`。

---

## 明日（09-08）の手順

1. **フォームを開く**: `https://ethglobal.com/events/ethonline2026/info/details`（200。`/events/ethonline2026` 素の URL は未ログインで 500 を 2 回返した）→ ログイン後 Hacker Dashboard → プロジェクト `payOrRefuse`。**まだ "Project submissions are not enabled yet" なら、この文書の見直しだけして閉じる**（開放は締切近く。`scripts/watch_ethonline_prizes.py` が毎朝 09:20 に賞ページの差分を見ているが、フォーム開放は見ていない——ダッシュボードはログインが要る）。
2. **各項目を貼る**（§A〜§G）。貼りながら**フォームの実際のラベル名・文字数制限**をこの文書の §0 の表に書き戻す（【推定】を消す）。
3. **賞の選択画面**: 出ているパートナーと `PRIZES.md` §0 の表を突合。The Graph と Bazantic の 2 つだけ。**Bazantic が出なければ 2 枠→1 枠で出す**（§J）。各賞のコメント欄に §I・§J を貼る。
4. **Submission type**: Finalist and Partner Prizes（§H）。
5. **送信前**: `npm run refresh-numbers`（記録値を更新）→ §Z の表を上から叩く → `{{…}}` を全部埋める → **`grep -c '{{' <貼った文章>` が 0** であること。動画 URL が入っていること。
6. **送信 → スクショ**（確認画面と提出後の画面）。スクショは `docs/ethonline-2026/` には置かない（個人情報が映る）。提出後に外から実物を見る: showcase の URL が出たら `curl` で 200 を確認し、`WINDOW_PLAN.md` §0 に URL を記録する。
7. **提出後の手番**: メールを見る（Round 1 の通過連絡）。**09-14〜16 を空ける**（ライブ審査 7 分）。

**ここで止まる条件**: フォームに「事前作業の開示」の**専用欄が無く、かつ Description に文字数制限があって §C の "THE BOUNDARY" 段が入らない**場合——その時は §G の文を Description の**冒頭**に置き、"WHAT THE WINDOW ADDED" を削る（開示は規約上の必須物・`PRIZES.md` §1、機能説明は SKILL.md が持つ）。

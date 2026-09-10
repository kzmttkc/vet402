# ETHOnline 2026 — 賞の正典（狙う**2賞**の確定版・3枠目は空ける）

> **実読 2026-09-04 09:0x JST**（会期初日）。取得方法は `https://ethglobal.com/events/ethonline2026/prizes` の
> 本文取得（WebFetch・ログイン不要ページ）と `https://ethglobal.com/rules` の再読。画像スクリーンショットは撮っていない
> ——記録しているのは**取得した本文そのもの**であり、引用は原文（英語）のまま置く。
> 再読予定: 09-09 / 09-12。**機械監視が何を見て何を見ていないかは §6 に書いた。**
> 「差分を叫ぶ」と書いていたのは言い過ぎで、`scripts/watch_ethonline_prizes.py` は賞ページの**一覧と各社ブロック**しか読まず、
> **要件の文面は 1 文字も見ない**（2026-09-10 訂正）。

## 0. 結論（この3つを固定する。会期中に増やさない）

| 枠 | パートナー / 賞 | 額 | デモのどの経路が要件を満たすか |
|---|---|---|---|
| **P1** | The Graph — *Best AI Tooling or AI Use Case with The Graph (Continuity)* | **$5,000**（1位$2,500/2位$1,500/3位$1,000） | `payOrRefuse` の evidence を自社L1台帳だけでなく **Graph Gateway の live subgraph** からも引く経路を新設し、既存 MCP サーバー（`packages/mcp-server`）から呼べる道具として公開する |
| ~~**P2**~~ | ~~World — *AgentKit Continuity*~~ | ~~$3,500~~ | **2026-09-03 に取り下げ**（Orb 認証の証明が会期中に取り出せず、5要件中2つが未達確定）。`WINDOW_PLAN.md` §1 |
| **P2** | Bazantic — *Help an Agent Use Your Hackathon Project* | **$1,000**（上位2チーム × $500）・**Continuity 限定**（3枠中この1枠だけ） | bazantic.com で **Recipe** を作り、**Recipe の有無だけを違いにした A/B** を見せる。**Gateway は 09-03 から `vet402.com` を上流に LIVE**（自前 seller の新設は範囲外・§3） |
| **P3** | **空けたまま出す** | — | Continuity 枠を持つ10社のうち、選んだ2社を除く**残り8社はどれも使っていない**。埋めるには会期スコープ外の実装が要る。**使っていない製品の枠に応募しない**（2026-09-10 執行部決定・再導出しない） |

到達可能合計 **$6,000**。

**Continuity バッジを持つのは11社中10社**（2026-09-10 実測・`state/ethonline_prizes.json`）:
The Graph $5,000（**選択中**）／World $3,500（09-03 取り下げ）／Arc $3,000／1inch $2,000／Uniswap Foundation $2,000／
Ledger $1,500／Hedera $1,000／Bazantic $1,000（**選択中**）／ENS $500／Chainlink $500。
**Privy は Continuity 枠が無い**ので選択UIに出ない。

**2026-09-06 の訂正2件**（この表が古かった）:
- **World は 09-03 に切っている**のに P2 として残っていた
- **P3 の「自前 seller を新規に立てて登録」は `WINDOW_PLAN.md` §2 で範囲外**。Gateway は既に `vet402.com` を上流として LIVE

### Bazantic は3枠。応募できるのは1枠だけ（2026-09-10 実読・確定）

| 枠 | 額 | Continuity バッジ | 我々 |
|---|---|---|---|
| 🤖 **Help an Agent Use Your Hackathon Project** | **$1,000**（上位2×$500） | **あり**（`a[href*="2056399209767866682"]`） | **応募済み** |
| 🍳 Best Recipe that uses EthGlobal Hackathon Sponsor APIs | $1,000（500/300/200） | 無し | **不可** |
| 👨‍🍳 Agentify a new API | $1,000（500/300/200） | 無し | **不可** |

**バッジが付くのは1本だけ。** The Graph も同じ形で、3枠のうちバッジは
*AI Tooling / AI Use Case (Continuity)* $5,000 の1本のみ。

**根拠は運営回答だけではない——フォーム本体が同じことを書いている。**
提出フォーム Select prizes 画面の Continuity Mode 節（**2026-09-08 実読・一次**）:

> `You will only be eligible for the prizes from the track you select.`

同画面の
> `You may select up to 3 partners. This will make you eligible for all prizes offered by those partners from the prizes page.`

は、**トラックで濾した後**に効く従属句である。**「そのパートナーの全賞に応募できる」ではない。**
08-25 の運営回答（§1）と一致する。**これで根拠が非公開チケット1本から、誰でも見られるフォーム文言に変わった。**

**Tom Hay の 2026-09-09 発言「第3枠の資格がある」は `@Mo` 宛**であり、
その人が Continuity 提出者だという記述は原文に無い。**我々の話ではない**ので、根拠に使わない。

**2026-09-06 に `WINDOW_PLAN.md` §16 へ「枠1つ・ブラケット2つ・両方に応募できる」と
書いたのは誤りで、この節を読まずに再導出した結果だった。**（§1 の見出しは「再導出しない」である。）

**動詞は `payOrRefuse` ただ1つ。** P1 は証拠源を1つ足すだけ。**新しい動詞・新しいチェーンは足さない。**

---

## 1. 資格の憲法（再導出しない）

2026-08-25 ETHGlobal 運営の `#ticket-5926` 回答（非公開スレッドのため原文は転載しない）。趣旨:

- **応募できるのは Continuity 枠のある賞だけ。** パートナーに Continuity 枠が無い、または枠の内容が
  自分の製品と合わない場合は対象外
- **そのパートナーに別の非 Continuity 賞があって内容が合っていても、応募できない**
- 選べるのは Continuity 側だけで、逆（非 Continuity 側から Continuity 賞を選ぶ）も同様に不可

提出フォーム（Select prizes 画面・**2026-09-08 実読**）の記載も同じ。
**非公開チケットに依存しない一次はこれである**:

> `Only partners with a Continuity Track prize will be shown for your project.`
> `You will only be eligible for the prizes from the track you select.`
> `You may select up to 3 partners. This will make you eligible for all prizes offered by those partners from the prizes page.`

**3 行目は 2 行目に従属する。** トラック（Continuity）で濾した結果に対して「そのパートナーの賞に応募できる」
と言っているのであって、**非 Continuity 枠まで含む意味ではない**。この読みは 08-25 の運営回答と一致する。

**したがって選べるのは continuity ラベルのある枠だけ。1パートナー＝1枠。最大3。**

`https://ethglobal.com/rules` の Continuity Track 文言（2026-09-04 再読・原文）:

> "must include substantive new features, improvements, or functionality developed during the event"
> "All new parts of extending an existing project must remain open source"
> 事前作業は "disclose any pre-existing work in writing to the ETHGlobal team and include full details in your
> submission (repo history, video, and description)" ——未開示は "disqualified, prizes revoked, and the team may be
> banned from future events"
> "eligibility for specific partner prizes may vary — check the event and partner rules"
> "projects that use a majority of pre-existing work do not score as high in the judging as projects which present
> wholly new and novel approaches"

→ `pre-ethonline-2026` タグ・`CHANGED_FILES.md`・README の「既存 / 会期中」分離は**規約上の必須物**であって作法ではない。

### 1.1 The Graph（Continuity）の資格 —— 2026-09-10 の運営回答（**公開チャンネルなので原文を置く**）

**チャネル**: ETHGlobal Discord `#partner-the-graph` のスレッド
**「Quick eligibility question for the AI」**（`Sen_web3` の 09-07 質問から立ったスレッド）。
**公開チャンネルなので原文を転載する** ——`08a7dd1` が原文の転載をやめたのは非公開スレッド
（`#ticket-5926`）と私信だけで、公開チャンネルの帰属はその対象外である。時刻は Discord の表示（JST）で、
一次はオーナー提示のスクリーンショット。

我々の質問（`Sen_web3`・**2026-09-07 06:17**・原文）:

> Quick eligibility question for the AI Tooling / AI Use Case (Continuity) track. Our SDK consumes the x402 Base
> subgraph as a live, block-pinned decision input (an agent refuses or pays based on receipts the subgraph shows).
> We also expose the same evidence through an MCP tool so Claude/Cursor can call it. Does judging weigh whether the
> Graph evidence is reachable from the MCP/agent surface, or is the SDK path alone considered AI tooling? Asking so
> we spend the remaining days on the right surface. Thanks!

運営（`ethonline 2026`）の回答（**2026-09-10 18:46**・原文）:

> Good question. You'll be eligible even if consuming only the x402 Base subgraph

**含意（資格）**: AI Tooling / AI Use Case（Continuity）は、**x402 Base subgraph を消費するだけで資格を満たす**。
**MCP／エージェント面から Graph の証拠に到達できることは、資格の条件ではない。**
09-10 08:09 時点で未回答の資格質問は最低 6 件あった（`WINDOW_PLAN.md` の同日実読）。**そのうち我々の 1 件が閉じた**——
残り 5 件（他チームの分）は未回答のままで、The Graph 側の人からの返信は 1 件も来ていない。

**含意（競争力）— 資格と競争力は別。** 賞ページの評価軸は
**「The Graph を使いやすくする AI ツール（MCP サーバー・SKILL・プラグイン）」**のままで、そこは動いていない。
**MCP ツール・Agent Skill・プラグイン・devcontainer は資格のために持っているのではなく、差別化として維持する**
——これが執行部の判断であり、この回答を理由に MCP 面を薄くしない。

**この回答の射程**（誤読を防ぐために書いておく）: 答えたのは `ethonline 2026`＝**ETHGlobal 側**である。
同じチャンネルで 09-07 19:06 に ETHGlobal スタッフが「The Graph の賞の資格には答えられない・自分は The Graph の
人間ではない」と述べている（`WINDOW_PLAN.md` §「The Graph：資格質問は…未回答」に原文）。
したがってこれは**運営が資格の下限を示した記録**であって、**The Graph 側の審査基準（§1 の賞ページ要件・
`WINDOW_PLAN.md` §「The Graph（Continuity）の資格要件」）を上書きするものではない**。要件表は 1 行も変えていない。

**提出フォームには書かない。** 運営の回答を賞コメントに引用すると、作ったものでなく権威で押していると読まれる。
この記録は docs の中だけで使う。

---

## 2. 2026-08-24 07:40 の基準線からの差分（今日の実測）

| パートナー | 基準線 | 2026-09-04 実測 | 差分 |
|---|---|---|---|
| The Graph | $15,000・詳細記載なし | 3枠に分解。Composable $5,000【推定・新規向け】/ AI Tooling **(From Scratch)** $5,000（新規向け）/ AI Tooling **(Continuity)** $5,000（**継続限定**） | **解消。continuity 枠が確定** |
| Hedera | 4枠 $15,000 | 変化なし（$6,000 / $2,000 / $6,000 / Continuity $1,000） | 変化なし |
| **Arc** | 基準線に無し | **$10,000・Continuity は $3,000 の1枠**（*Best DeFi or Agentic Application*）。**09-04 に記録した「$1,666 と $1,500 の2枠」は 09-10 実測で消えている**——2枠が1枠へ統合された【実測 2026-09-10 10:20・`state/ALERTS.md`】 | **会期中に額と枠数が変わった実例。** 08-31「Arc は continuity 枠でもない」→ 09-04「2枠」→ 09-10「1枠 $3,000」 |
| World | $7,000・記載なし | AgentKit Continuity $3,500（継続限定）/ Selfie Check $3,500（新規向け） | 変化なし（08-25 に判明済み） |
| 1inch | $5,000＋Continuity $2,000 | 変化なし | 変化なし |
| ENS | $5,000・記載なし | ENSv2 $4,500（新規向け）/ **Best Integration of ENSv2 into an Existing Project $500（継続限定）** | 解消 |
| Uniswap Foundation | $3,000＋Continuity $2,000 | 変化なし | 変化なし |
| Ledger | $5,000・記載なし | AI Agents x Ledger $3,500（新規向け）/ **Continuity $1,500（継続限定）** | 解消 |
| Chainlink | $3,000・記載なし | Confidential Workflow $2,000（新規向け）/ **Best Chainlink-Powered Upgrade $500（継続限定）**/ Automated Liquidation Protection $500 **"Coming soon" のまま** | 一部解消・1枠未確定 |
| **Privy** | 基準線に無し | $5,000・2枠とも新規向け。**continuity 枠なし** | 新規だが**選べない** |
| **Bazantic** | 基準線に無し | $3,000・3枠。うち **Help an Agent Use Your Hackathon Project $1,000 が継続限定** | **新規・選べる** |
| 0G | $15,000・記載なし | **賞ページから消滅**（08-27 に機械監視が検出済み） | 消滅 |

**基準線の「未解決 6本（$50,000）」は今日で決着した。** The Graph / ENS / Ledger / Chainlink は
continuity ブラケットを新設し、World は既知、0G は消滅。**Discord `#ticket-5926` の追加返信は 09-04 時点では確認していない**
（当時 Discord へ接続できなかった）。**運営の一次回答は 08-25 の 1 件だけではない** ——`#partner-the-graph` の
公開スレッドに **2026-09-10 18:46 の回答**が来ており、原文と射程は §1.1 に置いた（この行は 09-10 に訂正した。
訂正前は「08-25 回答が引き続き唯一の運営一次回答である」と書いていた）。

**08-31 の当ファイル記録で今日誤りになったもの（訂正）**:
- 「The Graph の continuity 枠は3つ・各 $5,000」→ **誤り。continuity は1枠（AI Tooling）だけ**で、
  Composable と From Scratch は新規向けに振り分けられた。狙えるのは元々1枠なので結論は変わらないが、
  額の見積り（$15,000 が全部 continuity）は間違いだった。
- 「Arc は continuity 枠でもない」→ **今日時点で誤り**。continuity 枠が2つある。ただし選ばない（§4）。
  **【2026-09-10 追記】その「2つ」も既に古い。$3,000 の1枠へ統合された。**
  賞は会期中に動く——**この1件が §6 の手動再読を要る理由である。**

### 2.1 再導出しない確定事項（過去版から引き継ぐ）

- **Base / Coinbase CDP / x402 facilitator は、この大会のパートナーに存在しない**（2026-08-23 に確定・今日も不在を再確認）。
  WIN_EV §3 の旧 P1 想定はここでは成立しない。Base 上の実 tx は Continuity の**証拠**としては価値が残るが、賞にはつながらない。
- **提出フォームの partner カードに出る金額は各社の総額**であって、我々が取れる額ではない（2026-08-25 実測）。
- **賞を1つも取れないと確定しても Continuity 申請は続ける。** 既存コードを Classic で出すのは規約違反で失格になる。
- **Submission type** は `Top 10 Finalist & Partner Prizes` / `Partner Prizes only` の二択。
  **【2026-09-08 決定・済】`Top 10 Finalist & Partner Prizes` を選び、フォームに保存済み**（`WINDOW_PLAN.md` §1.4）。
  Round 1 通過時は **09-14 12:00 EDT ＝ 09-15 01:00 JST** の Live Judging に出る（台本は `LIVE_JUDGING.md`）。
  **応募する Partner Prizes は 3本ではなく 2本**（The Graph / Bazantic）で、**09-08 に決めてフォーム保存済み**。
  「提出直前に決める」は完了した——**未決の判断として数えない。**

---

## 3. 採用した2賞——要件の原文と、我々が出す証跡

### P1. The Graph — Best AI Tooling or AI Use Case with The Graph (Continuity) $5,000

Qualification（原文・2026-09-04 実読）:

> - "Use The Graph as a load-bearing part of the project"
> - "Consume live data from a Graph provider"
> - "Do meaningful work with the data: reasoning, decisions, automation, or a natural-language interface"
> - "Open-source the code with a clear README or SKILL.md"
> - "Select the pool that matches how you built: Start Fresh for net-new, Continuity for extending"
> - "For the Substreams one-prompt deployment challenge: demonstrate deploying a working Substreams pipeline"

**デモの経路**: `payOrRefuse` は SpendGuard の evidence を見てから払う。その evidence の取得元を
(a) vet402 自身の L1 台帳 に加えて (b) **Graph Gateway 経由の live subgraph クエリ** の2系統にし、
`decision.evidence[].source` に出す。これで買い手は vet402 を信じなくても**第三者データで検算できる**。
既存の MCP サーバーからその道具を呼べるようにするので、賞文の "AI Tooling"（MCP・SKILL.md）にも
"load-bearing"（判定が実際にそのデータに依存する）にも当たる。

**我々が示す証跡**: `payOrRefuse` の判定ログに Graph 由来の evidence 行が出ている実行トランスクリプト／
公開リポ＋README（SKILL.md）／モックでない live クエリのレスポンス。

**前提（充足済み）**: **Subgraph Studio の API キー**。賞文が live データを要求しモックを認めないため、
キーが無いと P1 は成立しない。**09-05 に取得済みで、§10.5 / §15 の live 実走が通っている**（`WINDOW_PLAN.md`）。
**User-Agent について**: 「UA 無しだと Cloudflare が 1010 で 403 にする」と長く書いていたが、
**2026-09-05 の実測では UA を完全に外しても HTTP 200 が返った**（`-H 'User-Agent:'`・`WINDOW_PLAN.md` §「そのまま動く問い合わせ」）。
**「必須」と断定しない。** 実装は UA を付けたままにする（外す理由が無い・D14 が要求）。
1010 が出たときは `evidence_unavailable` として扱い、**鍵エラーと区別する**。
なお**鍵が無いときの Gateway は 403 ではなく HTTP 200 ＋ GraphQL `errors`** を返す——`response.ok` だけを見ると
「成功・受領0件」と誤読する（こちらが本当の落とし穴）。

### ~~World — AgentKit Continuity $3,500~~ 【2026-09-03 に取り下げ・応募しない】

**この枠はもう狙っていない。** Orb 認証の証明が会期中に取り出せず、5要件中2つが未達で確定した
（`WINDOW_PLAN.md` §1）。`requireHumanBacked` の実装も、World ID Sandbox も、フィードバック文書も**作らない**。
要件の原文と旧デモ経路は git 履歴にある（このファイルの 09-04 版）。
**節番号を消費させないため、以降の採番から外した。**

### P2. Bazantic — Help an Agent Use Your Hackathon Project $1,000（上位2チーム × $500）

Qualification（原文・**8項目**。2026-09-04 実読・2026-09-10 に項目1件の欠落を訂正）:

> 1. "Create an account on bazantic.com"
> 2. "Create an x402/MPP Gateway in Bazantic for your project"
> 3. "Create a Recipe that explains when, why, and how to use your service"
> 4. "Use the same prompt, model, settings, and API access in both tests"
> 5. "Make the Recipe the only material difference between the tests"
> 6. "Show both results and identify the improvement"
> 7. **"Record video walking through outcome differences"**
> 8. "Provide the bazantic account username"

**【2026-09-10 訂正・重要】このファイルは長らく 7 項目しか書いておらず、
落としていたのは要件7「結果の違いを歩いて見せる動画を録る」だった。**
`WINDOW_PLAN.md` §「Bazantic の資格要件（2026-09-06 実読・8項目）」は正しく8項目を持っていたのに、
**正典であるこちらが欠けたままで、その状態で提出しかけていた。**
要件を1つ落とすと「未達に気づかないまま出す」——**この訂正は記録として残す**（同じ形を二度やらないため）。

**状態（2026-09-10）**: 8項目のうち **7項目が充足済み**。残るのは**要件7の画面収録だけ**。

| # | 要件 | 状態 |
|---|---|---|
| 1 | アカウント | ✅ 09-03 `TakeshiTGAL`（GitHub OAuth） |
| 2 | Gateway | ✅ 09-03 LIVE・全ルート $0.00 |
| 3 | Recipe | ✅ **09-07 06:15 JST 公開済**（`https://bazantic.com/recipes/x402-payee-verification-via-vet402-gateway`） |
| 4 | 同一プロンプト・モデル・設定・API | ✅ ハーネスが構造で強制 |
| 5 | Recipe が唯一の違い | ✅ `stripRecipe(B) === A` をテストが固定 |
| 6 | 両方の結果と改善の特定 | ✅ `docs/ethonline-2026/ab/2026-09-06T213134Z/`（A 5/10・B 5/10・`WINDOW_PLAN.md` §16.3） |
| **7** | **結果の違いを歩いて見せる動画** | ⏳ **未。これが唯一の残件**（09-11〜09-12 に画面収録） |
| 8 | アカウント名を提出物に書く | ✅ `TakeshiTGAL`（`SUBMISSION_DRAFT.md`） |

**デモの経路（2026-09-10 訂正）**: **Gateway は 2026-09-03 から `vet402.com` を上流として LIVE** である。
以前ここには「WIN_EV §2 で会期中の新規として立てる自前 seller
（`examples/ethonline-2026-agent/seller`）がそのまま Gateway の対象になる」と書いてあったが、
**その経路は 3 重に成立しない**:

1. **`examples/ethonline-2026-agent/` はリポに存在しない。**
   `git ls-tree -r origin/main | grep -c ethonline-2026-agent` → **0**
2. **自前 seller の新設は `WINDOW_PLAN.md` §2 で会期スコープ外**と決めてある
3. **Gateway は既に立っている**（09-03 LIVE）ので、立てる対象を新しく作る話自体が不要

`WINDOW_PLAN.md` は 09-06 に「`PRIZES.md` の P3 記述は古い」とこれを指摘しており、
**§0 だけ直してこの節が直っていなかった**（正典の訂正が派生節に伝播していない典型）。
**応募経路として実在しないパスを書かない。**

**我々が示す証跡**: 同一プロンプト・同一モデル・同一設定で Recipe あり/なしを1回ずつ流した2本の記録と差分／
Bazantic 上の Gateway と Recipe ／アカウント名／フィードバック doc（`docs/ethonline-2026/BAZANTIC_FEEDBACK.md`）。

**確認済み（旧「未確定」）**: 「Bazantic が提出フォームの partner セレクタに実際に出るか」は
**2026-09-08 09:0x に画面で確認済み**（`WINDOW_PLAN.md` §「提出フォームを 6 タブ埋めて保存した」）。
出た。表示額は $1,000 ではなく **$3,000**（パートナー総額の表示）。
**Ledger Continuity への差し替えは不要になった**（§4 の次点は使わない）。

---

## 4. 見送り（額が大きくても選ばない。理由つき）

| 賞 | 額 | 見送る理由 |
|---|---|---|
| **Ledger — Continuity** | $1,500 | 要件は "Add a Ledger signer to an app you have already shipped" / "Put a device confirmation in front of an action"。`payOrRefuse` の署名境界と正面から合う**次点**だったが、**実機デバイスの有無を確認できていない**。**09-08 に Bazantic がセレクタに出たので差し替えは不要になった**（保留を解除・見送り確定） |
| **Arc — Best DeFi or Agentic Application (Continuity)** | **$3,000**（**2026-09-10 実測**。09-04 に記録した $1,666＋$1,500 の**2枠は統合されて1枠になった**） | Arc チェーンへの deploy が必須（"deployed or deployment-ready on Arc mainnet by September 30"）。ROADMAP §3 で新チェーンは会期スコープ外。**我々の payer は Base USDC 1本**で、2つ目の payer を発明しないと決めている。**額が倍近くになっても結論は変わらない**——足りないのは金額ではなく実装 |
| Hedera — Continuity | $1,000 | 原文 "The project must have been built for a previous hackathon or **already exist in some form on Hedera**"。vet402 は Hedera 上に存在しない。**基準線どおり不可**（再導出せず、原文で再確認しただけ） |
| 1inch — Build an Aqua App (Continuity) | $2,000 | "Official Aqua/SwapVM contracts must be used"。スワップを伴わないので不可 |
| Uniswap Foundation — Continuity | $2,000 | 実際の Uniswap スタック統合が要る。デモは swap を呼ばない（方針の明示的除外） |
| ENS — Best Integration of ENSv2 into an Existing Project | $500 | ENS は **Tokyo の動詞**。`payOrRefuse` は `0x` 以外の payee を**呼び出し側の誤り**として拒否する設計で、名前解決をしない。方針の明示的除外 |
| Chainlink — Best Chainlink-Powered Upgrade | $500 | "must contribute to a state change on a blockchain" / "Simply displaying Chainlink data in a frontend is not sufficient"。デモ経路にスマートコントラクトが無い |
| Chainlink — Automated Liquidation Protection | $500 | 要件が **"Coming soon" のまま・未確定**。かつ continuity ラベルの有無も未表示 |
| Privy | $5,000 | **continuity 枠が無い**ので、内容が合っても選択UIに出ない（§1） |
| Bazantic — 🍳 Best Recipe that uses EthGlobal Hackathon Sponsor APIs | $1,000（500/300/200） | **Continuity バッジ無し＝資格が無い**（§0 の3枠表） |
| Bazantic — 👨‍🍳 Agentify a new API | $1,000（500/300/200） | **Continuity バッジ無し＝資格が無い**（同上） |
| The Graph の他2枠 / World Selfie Check / Hedera 主枠3本 / 1inch 主枠 / ENS 主枠 / Uniswap 主枠 / Ledger 主枠 / Chainlink 主枠 / Arc 主枠 | — | すべて**新規向け**。§1 の憲法により継続提出では選べない |

---

## 5. 会期中に要る前提 —— **3件とも充足済み（2026-09-10 時点で他人待ちはゼロ）**

| # | 前提 | 状態 |
|---|---|---|
| 1 | **Subgraph Studio の API キー**（P1 の必須前提・モック不可） | ✅ **取得済み。** `WINDOW_PLAN.md` §10.5 / §15 の live 実走が通っている |
| 2 | ~~World ID Sandbox App での遠隔テスト~~ | — **不要。World は 09-03 に取り下げ**（§3） |
| 3 | **bazantic.com のアカウント作成** | ✅ **09-03 に作成済み**（`TakeshiTGAL`・GitHub OAuth） |

**【2026-09-10 訂正】この節は長らく「3賞の中で唯一『他人待ち』の依存がある」と書いていたが、
3件とも既に済んでいた。** 充足済みの前提を未達として残すと、**優先度の判断を誤らせる**
——実際には残件は §3 の要件7（画面収録）と動画のナレーション録音だけである。

---

## 6. 再読の予定と、機械監視が**見ていないもの**

### 機械監視の実際の射程（2026-09-10 実測・`scripts/watch_ethonline_prizes.py` を読んで確認）

**見ているもの**（差分は `state/ALERTS.md` に記帳・毎日 09:20 JST）:
パートナーの**増減**／パートナー**総額**の変化／`Prize details coming soon` が埋まったこと／
**Continuity 枠が増えたこと**（title ＋ 額）。

**見ていないもの——ここが穴**:
- **要件の文面。** 監視は要件テキストを 1 文字も解析しない。
  **要件が書き換わっても永久に黙る**（P-7 の8項目のような欠落は機械では拾えない）
- **Continuity 枠が消えた・統合された・減額されたこと。** 差分は追加分（`new_c - old_c`）しか出さないので、
  **枠の消滅は無音**
- **個別の賞ページ**。読むのはパートナー**一覧**ページ `https://ethglobal.com/events/{slug}/prizes` だけ

**「機械監視が差分を叫ぶから手で読まなくてよい」は誤り**だった（この行が §0 冒頭にあった）。

### Arc —— 検知は働いた。伝わらなかったのは人の側

**2026-09-10 10:20 に監視は実際に叫んでいる**（`state/ALERTS.md`）:

> - 🎯 **continuity 枠が増えた** Arc: $3,000 「… 🏆 Best DeFi or Agentic Application」

つまり **Arc の額と枠数は会期中に変わり、機械はその日のうちに検知していた**。
にもかかわらず正典は「$1,666＋$1,500 の2枠」のままだった。
**壊れていたのは検知ではなく、アラートを正典へ書き戻す経路である。**
→ **アラートを読んだら、その日のうちにこのファイルへ反映する。**

### 予定

- **09-09**: 済（Bazantic のセレクタ確認は 09-08 に前倒しで完了）。
- **09-12【必須・手作業】**: **採用2賞の個別ページと一覧、計3枚を人が開いて要件語を読む。**
  機械が要件文を見ていない以上、これを飛ばすと要件変更に気づけない。読む対象は3枚:
  1. The Graph — *Best AI Tooling or AI Use Case with The Graph (Continuity)*（要件6行・§3 P1 の引用と一字ずつ）
  2. Bazantic — *Help an Agent Use Your Hackathon Project*（**8項目**・§3 P2 の引用と一字ずつ）
  3. パートナー一覧 `https://ethglobal.com/events/ethonline2026/prizes`（Continuity バッジの増減・額）

  **確認するもの**: 要件語の変更／額の変更／Continuity バッジの有無／枠の消滅。
  差分が出たら §0 と §3 を同じ日に直す。**ここで賞の入れ替えはしない**（提出は 09-13 12:00 EDT）。
- 機械監視 `scripts/watch_ethonline_prizes.py`（毎日 09:20 JST）。**上の「見ていないもの」を前提に読む。**

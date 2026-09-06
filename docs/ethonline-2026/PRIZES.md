# ETHOnline 2026 — 賞の正典（狙う3賞の確定版）

> **実読 2026-09-04 09:0x JST**（会期初日）。取得方法は `https://ethglobal.com/events/ethonline2026/prizes` の
> 本文取得（WebFetch・ログイン不要ページ）と `https://ethglobal.com/rules` の再読。画像スクリーンショットは撮っていない
> ——記録しているのは**取得した本文そのもの**であり、引用は原文（英語）のまま置く。
> 再読予定: 09-09 / 09-12（`scripts/watch_ethonline_prizes.py` が毎日 09:20 JST に差分を叫ぶ）。

## 0. 結論（この3つを固定する。会期中に増やさない）

| 枠 | パートナー / 賞 | 額 | デモのどの経路が要件を満たすか |
|---|---|---|---|
| **P1** | The Graph — *Best AI Tooling or AI Use Case with The Graph (Continuity)* | **$5,000**（1位$2,500/2位$1,500/3位$1,000） | `payOrRefuse` の evidence を自社L1台帳だけでなく **Graph Gateway の live subgraph** からも引く経路を新設し、既存 MCP サーバー（`packages/mcp-server`）から呼べる道具として公開する |
| ~~**P2**~~ | ~~World — *AgentKit Continuity*~~ | ~~$3,500~~ | **2026-09-03 に取り下げ**（Orb 認証の証明が会期中に取り出せず、5要件中2つが未達確定）。`WINDOW_PLAN.md` §1 |
| **P2** | Bazantic — *Help an Agent Use Your Hackathon Project* | **$1,000**（最大2チーム × $500）・**Continuity 限定** | bazantic.com で **Recipe** を作り、**Recipe の有無だけを違いにした A/B** を見せる。Gateway は 09-03 から LIVE（自前 seller の新設は範囲外） |
| **P3** | **空けたまま出す** | — | 残る9パートナーはどれも使っていない。埋めるには会期スコープ外の実装が要る。**使っていない製品の枠に応募しない** |

到達可能合計 **$6,000**。

**2026-09-06 の訂正2件**（この表が古かった）:
- **World は 09-03 に切っている**のに P2 として残っていた
- **P3 の「自前 seller を新規に立てて登録」は `WINDOW_PLAN.md` §2 で範囲外**。Gateway は既に `vet402.com` を上流として LIVE

**Bazantic の他ブラケットには応募できない。** 賞ページで **Continuity バッジが付いているのは
"Help an Agent Use Your Hackathon Project" だけ**で、"Best Recipe that uses EthGlobal Hackathon Sponsor APIs"
には付いていない。上の §1（Pascal の `#ticket-5926`）が
「**Even if they have something that is non-continuity that would work in your case, you're not eligible**」
と明言している。**2026-09-06 に `WINDOW_PLAN.md` §16 へ「枠1つ・ブラケット2つ・両方に応募できる」と
書いたのは誤りで、この節を読まずに再導出した結果だった。**（§1 の見出しは「再導出しない」である。）

**動詞は `payOrRefuse` ただ1つ。** P1 は証拠源を1つ足すだけ。**新しい動詞・新しいチェーンは足さない。**

---

## 1. 資格の憲法（再導出しない）

2026-08-25 ETHGlobal 運営（Pascal）の `#ticket-5926` 回答。原文:

> you are only eligible for tracks that have continuity on them. If a partner does not have continuity
> or if their continuity price does not match what you're building, you're not eligible. **Even if they
> have something that is non-continuity that would work in your case, you're not eligible.**
> You can only select continuity and the other way around.

提出フォーム（Select prizes 画面）の記載も同じ:

> `Only partners with a Continuity Track prize will be shown for your project.`
> `You may select up to 3 partners. This will make you eligible for all prizes offered by those partners from the prizes page.`

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

---

## 2. 2026-08-24 07:40 の基準線からの差分（今日の実測）

| パートナー | 基準線 | 2026-09-04 実測 | 差分 |
|---|---|---|---|
| The Graph | $15,000・詳細記載なし | 3枠に分解。Composable $5,000（新規向け）/ AI Tooling **(From Scratch)** $5,000（新規向け）/ AI Tooling **(Continuity)** $5,000（**継続限定**） | **解消。continuity 枠が確定** |
| Hedera | 4枠 $15,000 | 変化なし（$6,000 / $2,000 / $6,000 / Continuity $1,000） | 変化なし |
| **Arc** | 基準線に無し | $10,000・5枠。うち **Best DeFi or Agentic Application $1,666** と **Launch on Arc Testnet & Push to Mainnet $1,500** が**継続限定** | **新規**（08-31 の当ファイル記録「Arc は continuity 枠でもない」は**今日で古くなった**） |
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
continuity ブラケットを新設し、World は既知、0G は消滅。**Discord `#ticket-5926` の追加返信は本日確認していない**
（Discord へはこのセッションから接続できない）。上の 08-25 回答が引き続き唯一の運営一次回答である。

**08-31 の当ファイル記録で今日誤りになったもの（訂正）**:
- 「The Graph の continuity 枠は3つ・各 $5,000」→ **誤り。continuity は1枠（AI Tooling）だけ**で、
  Composable と From Scratch は新規向けに振り分けられた。狙えるのは元々1枠なので結論は変わらないが、
  額の見積り（$15,000 が全部 continuity）は間違いだった。
- 「Arc は continuity 枠でもない」→ **今日時点で誤り**。continuity 枠が2つある。ただし選ばない（§4）。

### 2.1 再導出しない確定事項（過去版から引き継ぐ）

- **Base / Coinbase CDP / x402 facilitator は、この大会のパートナーに存在しない**（2026-08-23 に確定・今日も不在を再確認）。
  WIN_EV §3 の旧 P1 想定はここでは成立しない。Base 上の実 tx は Continuity の**証拠**としては価値が残るが、賞にはつながらない。
- **提出フォームの partner カードに出る金額は各社の総額**であって、我々が取れる額ではない（2026-08-25 実測）。
- **賞を1つも取れないと確定しても Continuity 申請は続ける。** 既存コードを Classic で出すのは規約違反で失格になる。
- **Submission type** は `Top 10 Finalist & Partner Prizes` / `Partner Prizes only` の二択。Finalist を選ぶと Round 1 通過時に
  2026-09-14 12:00 EDT の Live Judging 参加義務が生じる。WIN_EV の賭けは Partner Prizes 3本なので、ここは提出直前に決める。

---

## 3. 採用した3賞——要件の原文と、我々が出す証跡

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

**前提（未達だと成立しない）**: **Subgraph Studio の API キー**。賞文が live データを要求しモックを認めないため、
キーが無いと P1 は成立しない。無料枠あり・ログインはウォレット。→ Takeshi 手番（§5）。
Graph Gateway は **User-Agent 無しの HTTP を Cloudflare 1010 で 403 にする**（既知の落とし穴。キー不正と誤診しない）。

### P2. World — AgentKit Continuity $3,500

Qualification（原文・2026-09-04 実読）:

> - "Uses AgentKit in a meaningful way"
> - "Shows a working app"
> - "Registers or resolves agents through AgentBook where relevant"
> - "Uses the World ID Sandbox App to test the project remotely"
> - "Includes feedback document on: AgentKit docs and integration flow, Developer Portal navigation, Sandbox App
>   states, What was confusing, missing, broken, or hard to test"

**デモの経路**: `payOrRefuse` は今まで**受け取る側（payee）**だけを見ていた。ここに**払う側（payer）**の条件
`requireHumanBacked` を1つ足す。AgentKit / AgentBook で「実在の人間の代理で動く」ことが解決できたエージェントにだけ
上限（per-tx ceiling）を上げ、解決できなければ既定の上限のまま。**動詞は増えず、policy の条件が1つ増えるだけ。**

**我々が示す証跡**: 同一の payee・同一の金額で、人間裏付けありのエージェントは ALLOW で払い、
無しのエージェントは上限超過で refuse する2本の実行／AgentBook の解決結果／World ID Sandbox での遠隔実行／
フィードバック文書（賞文が明示的に要求している成果物なので、提出物として作る）。

### P3. Bazantic — Help an Agent Use Your Hackathon Project $1,000（最大2チーム × $500）

Qualification（原文・2026-09-04 実読）:

> - "Create an account on bazantic.com"
> - "Create an x402/MPP Gateway in Bazantic for your project"
> - "Create a Recipe that explains when, why, and how to use your service"
> - "Use the same prompt, model, settings, and API access in both tests"
> - "Make the Recipe the only material difference between the tests"
> - "Show both results and identify the improvement"
> - "Provide the bazantic account username"

**デモの経路**: WIN_EV §2 で会期中の新規として立てると決めている自前 seller
（`examples/ethonline-2026-agent/seller`・`exact` / Base USDC / ≤ $1）が、そのまま
「x402 Gateway を立てる対象のプロジェクト」になる。**賞のための追加実装がゼロ**で、
足すのは Bazantic 側の登録と Recipe（我々のサービスを**いつ・なぜ・どう**呼ぶかの説明文）と A/B の記録だけ。

**我々が示す証跡**: 同一プロンプト・同一モデル・同一設定で Recipe あり/なしを1回ずつ流した2本の記録と差分／
Bazantic 上の Gateway と Recipe ／アカウント名。

**未確定**: Bazantic は 08-31 時点の監視記録に存在しないパートナーで、**提出フォームの partner セレクタに
実際に出るかを本日確認していない**（フォームはログインが要る）。09-09 の再読時に画面で確認する。
出なければ P3 を Ledger Continuity $1,500 に差し替える（§4 の次点）。

---

## 4. 見送り（額が大きくても選ばない。理由つき）

| 賞 | 額 | 見送る理由 |
|---|---|---|
| **Ledger — Continuity** | $1,500 | 要件は "Add a Ledger signer to an app you have already shipped" / "Put a device confirmation in front of an action"。`payOrRefuse` の署名境界と正面から合う**次点**だが、**実機デバイスの有無を確認できていない**。持っていない道具を前提に枠を埋めない。P3 の差し替え候補として 09-09 まで保留 |
| Arc — Best DeFi or Agentic Application (Continuity) | $1,666 | Arc チェーンへの deploy が必須（"deployed or deployment-ready on Arc mainnet by September 30"）。ROADMAP §3 で新チェーンは会期スコープ外。**我々の payer は Base USDC 1本**で、2つ目の payer を発明しないと決めている |
| Arc — Launch on Arc Testnet & Push to Mainnet (Continuity) | $1,500 | 同上 |
| Hedera — Continuity | $1,000 | 原文 "The project must have been built for a previous hackathon or **already exist in some form on Hedera**"。vet402 は Hedera 上に存在しない。**基準線どおり不可**（再導出せず、原文で再確認しただけ） |
| 1inch — Build an Aqua App (Continuity) | $2,000 | "Official Aqua/SwapVM contracts must be used"。スワップを伴わないので不可 |
| Uniswap Foundation — Continuity | $2,000 | 実際の Uniswap スタック統合が要る。デモは swap を呼ばない（方針の明示的除外） |
| ENS — Best Integration of ENSv2 into an Existing Project | $500 | ENS は **Tokyo の動詞**。`payOrRefuse` は `0x` 以外の payee を**呼び出し側の誤り**として拒否する設計で、名前解決をしない。方針の明示的除外 |
| Chainlink — Best Chainlink-Powered Upgrade | $500 | "must contribute to a state change on a blockchain" / "Simply displaying Chainlink data in a frontend is not sufficient"。デモ経路にスマートコントラクトが無い |
| Chainlink — Automated Liquidation Protection | $500 | 要件が **"Coming soon" のまま・未確定**。かつ continuity ラベルの有無も未表示 |
| Privy | $5,000 | **continuity 枠が無い**ので、内容が合っても選択UIに出ない（§1） |
| Bazantic の他2枠 | $1,000×2 | 新規向け。1パートナー＝1枠なので、いずれにせよ P3 の1枠に含まれる |
| The Graph の他2枠 / World Selfie Check / Hedera 主枠3本 / 1inch 主枠 / ENS 主枠 / Uniswap 主枠 / Ledger 主枠 / Chainlink 主枠 / Arc 主枠3本 | — | すべて**新規向け**。§1 の憲法により継続提出では選べない |

---

## 5. 会期中に要る前提（Takeshi 手番になりうるもの）

1. **Subgraph Studio の API キー**（P1 の必須前提。モック不可と明記されている）。ログインはウォレット・無料枠あり。
   これが無いと P1 は成立しないので、3賞の中で唯一「他人待ち」の依存がある。
2. **World ID Sandbox App** での遠隔テスト（P2 の必須物）。チェーン変更は不要。
3. **bazantic.com のアカウント作成**（P3 の必須物・ユーザー名を提出物に書く）。
   ※ アカウント作成は私が実行しない（規約承認・登録は Takeshi 手番）。

---

## 6. 再読の予定

- **09-09**: 3賞の要件変更の有無／Bazantic が提出フォームの partner セレクタに出るか／
  Chainlink の "Coming soon" 枠が埋まったか／BLOCK・ALLOW fixture のスコアが飛んでいないか。
- **09-12**: 最終確認。ここで賞の入れ替えはしない（提出は 09-13 12:00 EDT）。
- 機械監視 `scripts/watch_ethonline_prizes.py`（毎日 09:20 JST）が差分を `state/ALERTS.md` に叫ぶ。

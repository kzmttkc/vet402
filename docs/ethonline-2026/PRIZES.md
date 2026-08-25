# ETHOnline 2026 — 公式賞リスト（実測）

> 取得 2026-08-23（ログイン済みブラウザで https://ethglobal.com/events/ethonline2026/prizes を実読）。
> 計画は「賞リストは 9/4 に公開される」前提だったが、**既に全パートナーが公開済み**だった。
> 再読は 09-04 / 09-09 / 09-12（"Prize details coming soon" の5社が埋まる）。

## パートナー9社・総額 $77,000

| パートナー | 総額 | 詳細 |
|---|---|---|
| The Graph | $15,000 | coming soon |
| **Hedera** | **$15,000** | **公開済み（下記4トラック）** |
| 0G | $15,000 | coming soon |
| World | $7,000 | coming soon |
| 1inch | $7,000 | 公開済み（Aqua/SwapVM。うち Continuity 専用 $2,000） |
| ENS | $5,000 | coming soon |
| Uniswap Foundation | $5,000 | 公開済み（うち Continuity 専用 $2,000） |
| Ledger | $5,000 | coming soon |
| Chainlink | $3,000 | coming soon |

## 計画に対する最大の訂正

**Base / Coinbase CDP / x402 facilitator は、この大会のパートナーに存在しない。**
STRATEGY §5.5 と ROADMAP §7 の優先順位1位（「ALLOW がそのレールを通ったら Base/CDP」）は、
ETHOnline 2026 では**選べない**。Base 上の実 tx は Continuity の証拠としては価値が残るが、
賞にはつながらない。

## 唯一、新しい動詞と正面から一致する賞

### Hedera 🤖 AI & Agentic Payments — $6,000（最大3チーム × $2,000）

Qualification（原文要約・2026-08-23 実読）:

1. **Hedera testnet または mainnet 上に、実際に動く x402 ゲート付きサービスを立てる。決済は Blocky402 facilitator を通す。**
2. そのサービスを消費するプラットフォーム/エージェントを作り、**実際の有償リクエストを end-to-end で最低1件**通す。
3. 公開 GitHub リポ＋README（セットアップ・構成・決済フロー）。
4. **5分以内**のデモ動画で有償リクエストの実行を見せる。

Extra points に該当するもの: **ERC-8004 によるオンチェーン agent identity**（vet402 の既存読み取り実装）、
エージェント発見のためのディレクトリ、HCS 上の検証可能な決済監査証跡、従量課金。

→ 会期スコープの「自前 seller を立てて ALLOW を確実にする」は、この賞の要件1と**同じ作業**である。
違いは**チェーンが Base ではなく Hedera・facilitator が Blocky402** という一点。

### Continuity 専用枠（この大会に3つある）

| 賞 | 額 | vet402 が取れるか |
|---|---|---|
| **World 🤖 AgentKit Continuity** | **$3,500** | **狙える（2026-08-25 に詳細公開・機械監視が検出）**。要件は「既存プロジェクトを AgentKit で拡張し、ボットと"実在の人間の代理で動くエージェント"を区別する。access / commerce / rate limits / trust の持続的な人間裏付け認可」。vet402 の `payOrRefuse` に**払う側の条件**を1つ足す形で正面から一致する——人間裏付けのあるエージェントにだけ上限を上げる支払いゲート。既存の agent 面（`/api/v1/agents/*`・agent passports）が AgentBook 登録/解決に対応する |
| Hedera ♻️ Continuity | $1,000 | **不可**。要件が「以前から Hedera 上に存在するプロジェクト」。vet402 は Base/Solana 系で該当しない |
| 1inch 💦 Aqua Continuity | $2,000 | 不可（Aqua/SwapVM 必須） |
| Uniswap 🦄 Continuity | $2,000 | 不可（本物の Uniswap 統合が要る。計画どおり選ばない） |

World のもう1枠 🤳🏼 Selfie Check $3,500 は Continuity 限定ではない。生体クレデンシャルを
リスク/資格/公平性の信号として使う枠で、我々の動詞とは別物なので選ばない。

AgentKit Continuity の必須物: AgentKit を実質的に使う・動くアプリ・（該当すれば）AgentBook 登録/解決・
**World ID Sandbox App で遠隔テスト**・**フィードバック文書**（ドキュメント/ポータル/サンドボックスの
詰まった点）。チェーン変更は不要で、Sandbox は遠隔で試せる。
資料: https://docs.world.org/agents/agent-kit/integrate ・ https://github.com/worldcoin/agentkit

Continuity トラック自体（Extend Open Source）は全体ルールであり、上の3つは
「Continuity 参加者だけが応募できるスポンサー賞」。**取れないからといって Continuity 申請が不要になるわけではない**
——既存コードを持ち込む以上、申請しなければ Partner / Finalist の資格そのものを失う。

## 未解決（この大会で一番重い論点・2026-08-23 夜）

ETHGlobal 運営（Pascal）の Discord 回答: **vet402 の既存公開 API に依存する提出は continuity 扱いになり、
`continuity track` ラベルの付いた賞のみ対象。パートナー各社はまだそのラベルを用意していない。**
（受領 2026-08-23。全文は `~/Takeshi_Automation/output/0819/vet402_ethglobal_ビルド&ピッチ_playbook_2026-08-19.md` §4）

これが額面どおりなら、Continuity トラックで出す我々が狙える賞は現時点で**3件しかなく、しかも3件とも要件が合わない**
（Hedera ♻️ は「以前から Hedera 上に存在」・1inch/Uniswap は各社スタック必須）。
つまり **Hedera 🤖 AI & Agentic Payments $6,000 が Continuity 提出でも対象になるのか**が、
この大会の賞金の有無をほぼ一手に決める。

やること（順に）:

1. Hedera と ETHGlobal に**名指しで聞く**: 「continuity track の提出は AI & Agentic Payments の対象か。
   対象外なら、その枠に continuity ブラケットを追加する予定はあるか」。答えが「対象」なら Hedera 実装は最優先、
   「対象外」なら会期の実装は Base のままでよく、Hedera 対応は次の大会かグラント材料へ回す。
2. 賞ページを 09-04 / 09-09 / 09-12 に再読し、**continuity ブラケットが増えていないか**を毎回見る
   （運営は「まだ用意していない」と言っており、増える余地がある）。
3. 賞が1件も取れないと確定した場合でも、Continuity 提出自体は続ける
   （既存コードを Classic に持ち込むのは規約違反で失格。Finalist 枠と会期中の証拠は残る）。

## 2026-08-25 実測: 提出フォームの Select prizes 画面が partner 単位の資格を明示していた

プロジェクト枠（`payOrRefuse`）を作成したことで **Select prizes 画面が読める状態になった**（保存は
`Save changes` が disabled でまだ不可・「We will enable this page once submissions are open」）。
そこに、上の未解決論点に直接あたる**プラットフォーム自身の記載**があった。原文:

- **`Only partners with a Continuity Track prize will be shown for your project.`**
- **`You may select up to 3 partners. This will make you eligible for all prizes offered by those partners from the prizes page.`**

その条件で実際に表示された partner は4社。**表示額は各社の総額であって continuity ブラケットの額ではない**:

| 表示 | 額 | 本ファイルが記録していた continuity ブラケット |
|---|---|---|
| Hedera | **$15,000** | ♻️ Continuity $1,000（要件不一致と判定していた） |
| World | $7,000 | 🤖 AgentKit Continuity $3,500 |
| 1inch | $7,000 | 💦 Aqua Continuity $2,000 |
| Uniswap Foundation | $5,000 | 🦄 Continuity $2,000 |

**partner の顔ぶれは本ファイルの記録と完全に一致した**（intel は正しかった）。
食い違うのは**額の粒度**で、フィルタが「continuity ブラケットを持つ partner」単位にかかり、
選んだ後は "all prizes offered by those partners" と書かれている。

**読み方は2通りあり、まだ確定していない**（[[verify-the-instrument-not-just-the-result]]）:

- (a) partner を選べばその社の**主枠も含む全賞**が対象 → **Hedera 🤖 AI & Agentic Payments $6,000 は狙える**
- (b) "all prizes" は partner カードの定型文で、実際の審査は continuity ブラケットに限定される → 従来どおり

(a) なら会期の実装優先度が変わる（Hedera + Blocky402 を本気で取りに行く価値が出る）。
断定はしない。**2026-08-25 09:17 に ETHGlobal Discord `#questions` へこの点を名指しで照会済み**
（`#ask-a-sponsor` は存在しなかった）。回答が来るまでは (b) を前提に World AgentKit Continuity を第一候補に据えたまま動く。

なお同画面には **Submission type** の選択もある（`Top 10 Finalist & Partner Prizes` / `Partner Prizes only`）。
Finalist を選ぶと Round 1 の非同期審査を通過した場合に **2026-09-14 12:00 EDT の Live Judging** への
参加義務が生じる（動画品質・デモ品質・git コミット履歴が Round 1 の評価項目）。ここは提出フォーム解放後に決める。

## 賞の選び方（2026-08-23 版・確定は 09-09 の再読後 / 上の未解決が先）

1. **World 🤖 AgentKit Continuity $3,500** — **Continuity 専用枠なので資格が確実**（Hedera main 枠は資格照会中）。チェーン変更なし。
2. **Hedera 🤖 AI & Agentic Payments $6,000** — 額は最大。ただし Hedera + Blocky402 対応が前提で、continuity 提出が main 枠の対象かは未確認。
3. 詳細待ち4社（The Graph / 0G / ENS / Ledger / Chainlink のうち残り）で、`payOrRefuse` が実際に呼ぶもの（The Graph=観測データの subgraph、0G=AI エージェント、
   Ledger=署名器、Chainlink=価格/検証）。**9/9 の再読で決める。実装が呼ばない賞は選ばない。**
4. ENS は Tokyo の動詞なのでここでは選ばない（World も上書きを実装しない限り選ばない）。

最大3枠。1パートナーの複数トラックは1枠。


## 監視（2026-08-25 追加）

賞ページの再読を人の記憶に預けない。`scripts/watch_ethonline_prizes.py`（Takeshi_Automation リポ・
launchd `com.kizuna.ethonline-prizes` が毎日 09:20 JST）が、パートナーの増減・金額変更・
**"coming soon" の解消**を検出したときだけ `state/ALERTS.md` に叫ぶ。
World の詳細公開はこの仕組みの初回実行で見つけた。

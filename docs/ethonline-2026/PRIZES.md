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

## 資格の確定（2026-08-25 ETHGlobal 公式回答・Pascal）

Discord で直接聞いた答え。**これが賞選択の憲法**になる。

> you are only eligible for tracks that have continuity on them. If a partner does not have continuity
> or if their continuity price does not match what you're building, you're not eligible. **Even if they
> have something that is non-continuity that would work in your case, you're not eligible.**
> You can only select continuity and the other way around.
> (…) This will not show up on the partner side and this will not show up on your side.

つまり:

1. **continuity ラベルの無い枠は、内容が合っていても選べない**（選択UIにそもそも出ない）。
2. → **Hedera「AI & Agentic Payments」$6,000 は対象外**。Hedera / Blocky402 対応を会期スコープに入れる理由は消えた。
3. → 我々が選べるのは **continuity 枠だけ**。2026-08-26 時点の全 continuity 枠は4つで、
   要件が合うのは **World の1つだけ**（下表）。
4. パートナーは価格を早く出すよう促されている最中で、**partner channel は今週後半に開く**。
   個別要件はそこで直接聞く。

**したがって賞のEVは「continuity 枠が今後いくつ増えるか」でほぼ決まる。**
`scripts/watch_ethonline_prizes.py`（毎日 09:20）は、この回答を受けて
**continuity 枠の新設を名指しで検出**するようにした。

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

## 【決着】2026-08-25 Pascal（ETHGlobal運営）の名指し回答——continuityラベルの賞のみ・例外なし

`#ticket-5926` にて、8/25朝の照会（continuity提出が Hedera 主枠 $6,000 の対象か）に対する回答を受領。
**原文（2026-08-25 18:02）**:

> you are only eligible for tracks that have continuity on them. If a partner does not have continuity
> or if their continuity price does not match what you're building, you're not eligible.
> **Even if they have something that is non-continuity that would work in your case, you're not eligible.**
> You can only select continuity and the other way around. ... This will not show up on the partner side
> and this will not show up on your side.

**確定した3点**:
1. **Hedera 🤖 AI & Agentic Payments $6,000 は対象外**。継続枠を持つ partner でも、
   **continuity 枠でない賞は「あなたの場合に合致していても」対象外**と明言された。
   Hedera の continuity 枠($1,000)は「以前からHedera上に存在」が要件で vet402 は非該当のため、
   **Hedera は partner ごと対象外**。
2. **8/26 に Select prizes 画面で見た「Hedera $15,000」等の表示は partner の総額であって、
   我々が取れる額ではない**。当時 (a)partner単位で主枠も対象 / (b)continuityブラケット限定 の
   2通りに読めると書いて断定を避けたが、**答えは (b)**。UIの表示額を資格と読まなくて正解だった。
3. **選べるのは World AgentKit Continuity $3,500 が実質唯一**（1inch は Aqua/SwapVM 必須、
   Uniswap は実統合必須で、いずれも「continuity price が building と合致」しない）。

**会期設計への影響**: **Hedera + Blocky402 の実装に会期を賭ける理由が消えた**。
`2026-autumn-continuity.md` の ETHOnline 動詞 `payOrRefuse` に、World の
`payer.requireHumanBacked`（人間裏付けのあるエージェントにだけ上限を上げる支払いゲート）を
足す一本に集中する。Hedera 対応は次の大会かグラント材料へ回す。

**次の一手**: Pascal が「**Partner channels will open later this week**」と告知。
World チームへ直接聞ける窓が開くので、AgentKit Continuity の必須物
（AgentKit の実質使用・AgentBook 登録/解決・World ID Sandbox での遠隔テスト・フィードバック文書）の
細部を、実装着手前に partner channel で確認する。

## 【解決済み・記録として保持】未解決だった論点（2026-08-23 夜〜2026-08-25）

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

1. **World 🤖 AgentKit Continuity $3,500** — **2026-08-26 時点で、我々が選べる唯一の賞**。
2. ~~Hedera 🤖 AI & Agentic Payments $6,000~~ — **選べない**（continuity ラベル無し・2026-08-25 確定）。
   `@x402/hedera` の調査は将来の Mumbai / グラント用に残すが、ETHOnline のスコープからは外す。
3. 詳細待ち4社（The Graph / 0G / ENS / Ledger / Chainlink のうち残り）で、`payOrRefuse` が実際に呼ぶもの（The Graph=観測データの subgraph、0G=AI エージェント、
   Ledger=署名器、Chainlink=価格/検証）。**9/9 の再読で決める。実装が呼ばない賞は選ばない。**
4. ENS は Tokyo の動詞なのでここでは選ばない（World も上書きを実装しない限り選ばない）。

最大3枠。1パートナーの複数トラックは1枠。


## 監視（2026-08-25 追加）

賞ページの再読を人の記憶に預けない。`scripts/watch_ethonline_prizes.py`（Takeshi_Automation リポ・
launchd `com.kizuna.ethonline-prizes` が毎日 09:20 JST）が、パートナーの増減・金額変更・
**"coming soon" の解消**を検出したときだけ `state/ALERTS.md` に叫ぶ。
World の詳細公開はこの仕組みの初回実行で見つけた。


## 2026-08-31 更新: The Graph が continuity 枠を3つ出した（各 $5,000）

日次監視が検出。**すべて Continuity 参加者限定**なので、我々に資格がある。

| 枠 | 額 | 要件の核 | 我々の適合 |
|---|---|---|---|
| 🔧 **Best AI Tooling for The Graph** | **$5,000**（1位$2,500/2位$1,500/3位$1,000） | 「AI 環境（Claude/Cursor/ChatGPT）から The Graph を使いやすくする**再利用可能な道具**——**MCP サーバー**・agent SKILL・**x402 payment tooling**・A2A 連携」。**Graph プロバイダの生データを消費すること**（Subgraph Studio / The Graph Market）。モック・ローカルのみ・静的データは不可。OSS＋README | **本命**。我々は既に MCP サーバーを公開しており、会期の新規はまさに x402 payment tooling。賞文に我々の2要素が名指しで並んでいる |
| 🧩 Composable or Standard Graph Products | $5,000 | Graph 製品を2つ以上合成、または標準スキーマ（Messari 等）の上に作る | 可能だが遠い。合成の実演が要る |
| 🤖 Best AI Use Case of The Graph | $5,000 | The Graph を**生のデータ源**にした AI エージェント/アプリ | 可能。ただし「単一アプリ」寄りで、我々は道具側 |

**1パートナー＝1枠**なので、狙うのは 🔧 AI Tooling の1つ。

### これが製品として正しい理由（賞のための細工ではない）

今の evidence policy が読む配達実績は **vet402 自身の DB** にある。つまり買い手は
「vet402 を信じる」ことを要求される。**同じ証拠を Subgraph（The Graph の生データ）からも引ければ、
第三者が独立に検算できる。** 「測定器そのものを疑え」という我々の原則に、賞の要件がそのまま乗る。

会期スコープへの追加は**動詞ではなく証拠源1つ**: `payOrRefuse` の evidence を
(a) vet402 の L1 台帳 と (b) **Subgraph の生データ** の両方から取れるようにし、MCP から使えるようにする。

### 会期前に要る準備（Takeshi 手番になりうる）

**Subgraph Studio の API キー**（Graph Gateway への live クエリに必須。無料枠あり・ログインはウォレット）。
モック不可と明記されているので、これが無いと 🔧 枠は成立しない。09-04 までに要否を確定させる。

## Arc は $10,000 → $2,500 に減り、continuity 枠でもない

同じ監視が検出（2026-08-31）。公開された枠は「🏆 Best DeFi stablecoin-native Pool $2,500・
参加者で山分け」で、**continuity ラベルが無い**ため我々は選べない。要件も Arc チェーン上の
DeFi（貸借・スワップ・流動性）で、我々の動詞とは別物。**Arc は追わない。**

## 現在の賞の見取り図（2026-08-31）

| 枠 | 額 | 資格 | 状態 |
|---|---|---|---|
| The Graph 🔧 AI Tooling | $5,000 | ✅ continuity 限定 | **P1**。Subgraph Studio キーが前提 |
| World 🤖 AgentKit Continuity | $3,500 | ✅ continuity 限定 | **P2**。AgentBook のチェーンと検証レベルが未確定 |
| 3枠目 | — | — | 空。continuity 枠が増えたら埋める |

到達可能な合計は **$8,500**（8/30 時点では $3,500 だった）。

## パートナーの増減（機械監視）

- 2026-08-23: 9社・$77,000
- **2026-08-26: 10社**。**Privy $5,000 が新規**（詳細 coming soon）。
- **2026-08-27: 10社のまま入れ替わり**。**Arc $10,000 が新規**、**0G $15,000 が消滅**（機械監視が検出・同日 curl で再確認）。
  総額は $77,000 で変わらず。詳細待ちは The Graph / ENS / Ledger / Chainlink / Privy / **Arc** の6枠。
- continuity 枠は現在4つ: World $3,500 / 1inch $2,000 / Uniswap $2,000 / Hedera $1,000（計 $8,500）。
  このうち要件が合うのは World だけ。詳細待ちの5社（The Graph / 0G / ENS / Ledger / Chainlink / Privy）が
  continuity 枠を足すかどうかが、賞のEVを決める唯一の変数。


## 賞の3枠を確定（2026-09-03・要件を全文読んで判断）

ETHGlobal の上限は3枠（1パートナー＝1枠）。**continuity 枠は10件あるが、要件が合うのは3つだけ。**

| 枠 | 賞 | 額 | 判断 |
|---|---|---|---|
| **P1** | The Graph 🤖 Best AI Tooling **or AI Use Case** with The Graph | **$5,000** | 3枠が1つに統合された。MCP＋x402 payment tooling が賞文に名指し。**live データの実証は 9/3 に完了**（[`GRAPH_EVIDENCE.md`](./GRAPH_EVIDENCE.md)） |
| **P2** | World 🤖 AgentKit Continuity | **$3,500** | 払う側の人間裏付けで上限を上げる。未確定2点は partner channel 待ち |
| **P3** | Bazantic 🤖 **Help an Agent Use Your Hackathon Project** | **$1,000**（上位2チーム × $500） | **採る**。下記 |

到達可能 **$9,500**。

### P3 に Bazantic を選んだ理由

要件は「**エージェントが、あなたの説明なしにあなたの製品を使えるか**」——bazantic.com で
x402/MPP Gateway と Recipe を作り、**同じモデルに同じ課題を2回**与えて（生のAPI情報だけ／Recipe つき）、
**再現性のある改善**を示す。

これは我々の主張そのものである。「エージェントは払う前に測るべきだ」を、**A/B で証明する**形になる。
しかも**この A/B は他の2枠のデモ材料としてもいちばん強い**——仕組みの説明ではなく、
「vet402 を使わないエージェントは払ってはいけない相手に払い、使うエージェントは署名前に止まる」
という**価値の実演**になる。1本作れば3枠すべてで効く。

**Takeshi 手番が1つ増える**: bazantic.com のアカウント作成（私は他社サービスのアカウントを作れない）。
Gateway と Recipe の中身は私が用意する。

### Arc「Best DeFi or Agentic Application」$1,666 は却下

要件が「**Arc チェーン上**で USDC の DeFi / エージェントを作る（Agent Stack・Nanopayments・Paymaster）」。
**新チェーンは会期スコープ外**（我々の規律）。額は Bazantic より大きいが、Arc 対応に会期の数日を使うと
本体（payOrRefuse・The Graph・World）が薄くなる。**取りに行かない。**

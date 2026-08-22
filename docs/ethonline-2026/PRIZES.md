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
| Hedera ♻️ Continuity | $1,000 | **不可**。要件が「以前から Hedera 上に存在するプロジェクト」。vet402 は Base/Solana 系で該当しない |
| 1inch 💦 Aqua Continuity | $2,000 | 不可（Aqua/SwapVM 必須） |
| Uniswap 🦄 Continuity | $2,000 | 不可（本物の Uniswap 統合が要る。計画どおり選ばない） |

Continuity トラック自体（Extend Open Source）は全体ルールであり、上の3つは
「Continuity 参加者だけが応募できるスポンサー賞」。**取れないからといって Continuity 申請が不要になるわけではない**
——既存コードを持ち込む以上、申請しなければ Partner / Finalist の資格そのものを失う。

## 賞の選び方（2026-08-23 版・確定は 09-09 の再読後）

1. **Hedera 🤖 AI & Agentic Payments $6,000** — 唯一、動詞と要件が正面一致。Hedera 対応が前提。
2. 詳細待ち5社のうち、`payOrRefuse` が実際に呼ぶもの（The Graph=観測データの subgraph、0G=AI エージェント、
   Ledger=署名器、Chainlink=価格/検証）。**9/9 の再読で決める。実装が呼ばない賞は選ばない。**
3. ENS は Tokyo の動詞なのでここでは選ばない（World も上書きを実装しない限り選ばない）。

最大3枠。1パートナーの複数トラックは1枠。

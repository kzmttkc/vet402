# The Graph を証拠源にする（$5,000 枠の技術的前提）— 2026-09-03 実証

> ハッカソン戦略セッションが本日、**リポの外**で実測した記録（会期前の調査であり実装ではない）。
> 賞: 🤖 Best AI Tooling or AI Use Case with The Graph (Continuity) **$5,000**。
> 要件に「**Graph プロバイダの生データを消費すること。モック・ローカルのみ・静的データは不可**」。

## 1. 使う subgraph が実在した

The Graph の分散ネットワーク上に **`x402 Base`** が在る。

| | |
|---|---|
| Subgraph ID | `Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj` |
| エンドポイント | `https://gateway.thegraph.com/api/<KEY>/subgraphs/id/<ID>` |
| 実測時のブロック | **50,799,813**（`hasIndexingErrors: false`） |
| エンティティ | `x402Payment` / `x402Settlement` / **`x402AddressSummary`** / `facilitator` / `x402DailyStats` |
| `X402Payment` の列 | `transactionHash, from, to, amount, amountDecimal, asset, assetSymbol, facilitator, settlement, nonce, transferMethod, isEscrowDeposit, chainId, network, blockNumber, blockTimestamp` |
| `X402AddressSummary` の列 | `address, role, totalPayments, totalVolume(Decimal), firstPaymentTimestamp, lastPaymentTimestamp, isKnownEscrow` |

**UA 必須**（無いと Cloudflare が HTTP 403 `error code: 1010`。キー不正ではない）。
他に `x402-bsc` と `x402loops-subgraph` も active——**多チェーンへ広げる余地がある**。

## 2. フィクスチャ2件を実データで引いた（これが賞の証跡になる）

| | 我々の台帳（`/decision`） | **x402 Base subgraph（The Graph）** |
|---|---|---|
| 払う側 `0x36038e1d…` | L1 **3/3 delivered** → ALLOW | role RECIPIENT・**totalPayments 1,315**・25.105 USDC・初回 2026-06-30／直近 2026-09-02。直近3件は 0.02 USDC を**別々の payer** から |
| 拒む側 `0xb15a55e8…` | L0 unverified・L1 **0/0** → BLOCK | role RECIPIENT・**totalPayments 29**・0.29 USDC |

**ここが今日いちばん大きい発見。** 拒む側は「**誰も払っていない**」のではなく、
「**我々が一度も測っていない**」だけだった。The Graph は 29 件の受領を知っている。
我々の台帳は 0 件しか知らない。**2つの独立した情報源が、違うことを知っている。**

市場規模の文脈も同じ subgraph から取れる（facilitator 別: Daydreams 11,808,067 settlements /
2,756,859 USDC、PayAI 5,067,080 / 2,199,531 USDC）。

## 3. 設計への反映（実装は 9/4 以降）

`payOrRefuse` の evidence に `source` を足す件（[`DESIGN_payOrRefuse.md`](./DESIGN_payOrRefuse.md) §3.5）は、
**「無い情報を足す」ことが実測で裏づけられた**。我々の DB は `x402_payments` が 0 行なので
独立 payer の受領実績を持たない——**thin ceiling の原因そのもの**。それを The Graph が埋める。

```ts
policy.evidence = {
  minL1Deliveries: 3,                 // 我々が自分で買って届いた回数（vet402 台帳）
  minSubgraphReceipts: 100,           // 第三者が払った回数（The Graph）
  source: "both",                     // どちらも読めなければ fail-closed
}
```

これで拒否の理由が2段になる: 「我々が測っていない」＋「第三者の受領も薄い」。
**呼び手がどちらの証拠を要求するかを選べる**のが、この設計の売りになる。

## 4. 会期中にやること（4面同時）

1. Graph クライアント（UA 込み・キーは env）と、`x402AddressSummary` / `x402Payments` の取得
2. `evidence[].source` を **実装・OpenAPI・SDK・MCP** の4面に同時に足す（契約パリティ検査に従う）
3. `payOrRefuse` / `pay_if_trusted` の policy に `minSubgraphReceipts` と `source`
4. 提出物に **live クエリの証跡**（このファイルのクエリと `_meta.block`、実行日時）

## 5. 注意

- Gateway の応答は遅いことがある（本日 1件タイムアウト・再試行で成功）。**リトライを入れる**
- 無料枠は月 10 万クエリ。判定ごとに引くならキャッシュ必須
- **subgraph の数字を自社の測定と混ぜて1つの数にしない**（我々の原則。§7.2 の実需/生値と同じ）

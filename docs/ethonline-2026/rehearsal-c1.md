> # ⚠️ この文書は参照資料です（2026-09-03 深夜）
> **会期の正典は [`WINDOW_PLAN.md`](./WINDOW_PLAN.md)。食い違ったらそちらが勝つ。**
> 5体の並行監査で「どの文書が正典か壊れている」が最大リスクと判定されたため、正典を1本に畳んだ。
> 特にこのファイルに残る次の記述は**もう正しくない**——
> 「ALLOW は構造的に出ない／カタログ全体が止まる」（9/2 実測で **ALLOW 対象 373 件**）、
> 「自前 seller を立てて ALLOW を作る」（**廃止**。払う先は The Graph 本体）、
> 「Day 0 のテストは12本/17本」（**22本**）、「World AgentKit を狙う」（**9/3 に取り下げ**）。

# C1 リハーサル（2026-08-29・本番実測）

> ROADMAP §5 の C1/C2。**支払いは1件も行っていない**（`SpendGuard.evaluate()` は判定だけ）。
> 会期前に「既存の SpendGuard が、狙った通りに通し・狙った通りに止まるか」を確かめるのが目的。
> 使った鍵: 本番に free プランの API キーを1本作成（id `e5373be6-…`、名前 "ETHOnline rehearsal (C1)"）。
> 値はローカルの gitignore 済み `.env.rehearsal.local`（600）にだけ置き、画面にも履歴にも出していない。

## 結果

| # | policy | 相手 | 判定 | 理由 |
|---|---|---|---|---|
| A | 既定 `allow-only` | kronossignals `0x36038e1d…`（L1 62/62 settled） | **拒否** | `payee_recommendation_not_allow` |
| B | `evidence` + `minL1Deliveries: 3` | 同上 | **許可** | — |
| C | `evidence` + `minL1Deliveries: 3` | 0x `0xb15a55e8…`（L1 **0** 件） | **拒否** | `payee_insufficient_evidence` |
| D | `evidence` + `minL1Deliveries: 3, minL1DistinctBuyers: 2` | kronossignals | **拒否** | `payee_insufficient_evidence` |
| E | `evidence`（$5 > `maxPerTxUsd: 1`） | kronossignals | **拒否** | `max_per_tx_exceeded` |

**A と B で会期の物語が両方撮れることが確定した。** 既定では実績62件の相手すら通らない（＝カタログ全体が止まる絵）。
呼び手が根拠を名指しした瞬間に、その1件だけが通る。

**B と C は同じスコア 69 WARN で判定が割れる。** ここが動画の核心になる——
「スコアは両方に WARN と言う。**決めたのは証拠**だ」。

## 実測された signals（抜粋）

| | kronossignals `0x36038e1d…` | 0x `0xb15a55e8…` |
|---|---|---|
| score / recommendation | 69 / WARN | 69 / WARN |
| `l1DeliveryCount` / `l1Settled` | **62 / 62** | **0 / 0** |
| `l1DistinctBuyers` | 1 | 0 |
| `paymentCount`（x402 attested） | 0 | 0 |
| walletHealth | ageDays 59 / txCount 100 | ageDays 102 / txCount 46 |
| drainPattern | 検出なし | 検出なし |

C2（観測所が今も買っているか）も同時に確認できた: kronossignals の L1 実績は
**8/25 の 48 件 → 8/29 に 62 件**。観測は止まっていない。

## D が示した罠（会期に持ち込まない）

`packages/sdk/README.md` の `evidence` 例は `minL1DistinctBuyers: 2` を含んでいた。
本番では **L1 の distinct buyer は全ての payee で 1**（買い手は観測所だけ）なので、
**この例をそのまま使うと支払いは永久に通らない**。会期で使う policy は
`{ minL1Deliveries: 3 }`（必要なら `minL1Settled` 相当の条件を足す）に固定する。
README の例も同じ理由で直した。

## 会期で使う policy（確定）

```ts
{ maxPerTxUsd: 1, trustPolicy: "evidence", requireEvidence: { minL1Deliveries: 3 } }
```

- 支払い対象: `0x36038e1d…`（`kronossignals.com/api/v1/price/btc`・$0.02・パラメータ不要）
- 拒否対象: `0xb15a55e8…`（`agent.api.0x.org/v1/x402/…`・$0.01・L1 実績 0 件）
- 撮影前（09-04 / 09-09 / 09-12）に両者を再測する。**拒否側に L1 実績が付いたら差し替える**
  （観測所が買い始めると証拠が付いてしまう）。

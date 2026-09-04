---
title: "x402の『払った』は配達の証明ではない — vet402 を作っている"
emoji: "🔏"
type: "tech"
topics: ["AI", "Web3", "TypeScript", "API"]
published: false
---

# x402の「払った」は配達の証明ではない — vet402 を作っている

**支払いが証明するのは「金が動いたか」だけです。**  
**「売ったものが届いたか」は別の事実です。**

x402 は前者に強い。後者は、次の支払いに署名するエージェントと、「この endpoint は履行したことがあるか」と聞く第三者に必要です。

**vet402** はその経済の独立した観測所です。掲載 endpoint が売るものを、Base 上の実 USDC で買い、成功と失敗を同じ重みで公開し、ゲート用に 0〜100 と `ALLOW` / `WARN` / `BLOCK` を返します。観測所自身のスコアではありません。公開面とキー付き API は同じ測定です。

本番: [vet402.com](https://vet402.com)  
リポ: [github.com/kzmttkc/vet402](https://github.com/kzmttkc/vet402)

## 二つの面を混ぜない

**事実（キー不要）**

```
GET https://vet402.com/api/v1/observatory/state
```

分母つきの件数。合成スコアは無し。`unverified` は「機械検証できない」であり、「死んでいる」ではない。`/payee/{address}` の HTML は、人間が読むのと同じエンジンです。

**判定（キー必須）**

```
GET /api/v1/wallets/{payer}/score
GET /api/v1/payees/{payee}/score
```

キーは [vet402.com/signup](https://vet402.com/signup)（無料枠、招待コードなし）。SDK: `npm install @vet402/sdk`（`getPayeeScore` あり）。環境変数名は当面 `VOUCH_API_KEY`。

SpendGuard は**判定するだけ**で、支払いはしません。判定を無視して署名できる穴は、記事で埋まっていることにしません。

## 想定フロー

```
売り手側 — この payer にサービスを出してよいか？
Client → x402 支払い検証 → vet402 payer チェック → 本来の有料ルート
                         ↘ 任意で決済証跡を書き戻し

買い手側 — このウォレットに支払ってよいか？
自分のエージェント → vet402 payee チェック →（署名するかどうかは呼び手）→ 相手の API
```

売り手側:

1. x402 ミドルウェアが支払いを検証し **payer ウォレット** を得る
2. `GET /api/v1/wallets/{payer}/score` で照会
3. `BLOCK` なら高コストなハンドラの前に 403
4. 通したあと任意で `POST /api/v1/payments/x402`

買い手側:

1. エージェントが 402 を受け、支払い要求から **payee** を得る
2. 署名する前に `GET /api/v1/payees/{payee}/score`（または `getPayeeScore`）
3. `BLOCK` なら支払わない。`WARN` なら自前のポリシー

payee の失敗モードはシビルなフィードバックではなく「受け取って届かない」ことです。受け取り履歴、ウォレット健全性、ドレイン形状（native ETH と Base USDC、ガス残渣で誤検知しないダスト下限）、確定ラベルを見ます。

- **スコア API は 404 を返しません。** 未アテステーションでも `200` と `dataDepth: "thin"`。
- **証跡はオンチェーン検証してから数えます。** wallet と txHash の形式だけでは捏造できません。

## payer スコアの中身（現時点）

| シグナル | 役割 |
|----------|------|
| ERC-8004 Identity | 登録有無・メタデータ URI の有無 |
| ERC-8004 Reputation | フィードバック量・平均（シビル時は減衰） |
| ウォレットヒューリスティック | 年齢・活動・バーナー・資金元クラスタ |
| 手動 WL/BL | 顧客単位のポリシー（チェーンスコアの後） |
| x402 決済証跡 | ゲート通過後の支払いアテステーション（加重 **10%**） |

目安: **≥70 ALLOW**、**40–69 WARN**、**&lt;40 BLOCK**。スコアは**推定**であり、保証・与信ではありません。インデクサの遅れは `dataCoverage` で返します。

## インテグレータ向け API

```bash
# 公開の事実（キー不要）
curl https://vet402.com/api/v1/observatory/state

# payer ウォレットでスコア（売り手側）
curl -H "Authorization: Bearer $VOUCH_API_KEY" \
  https://vet402.com/api/v1/wallets/0xYOUR_PAYER/score

# payee ウォレットでスコア（買い手側）
curl -H "Authorization: Bearer $VOUCH_API_KEY" \
  https://vet402.com/api/v1/payees/0xTHEIR_WALLET/score

# 検証済み決済の証跡（txHash で冪等）
curl -X POST -H "Authorization: Bearer $VOUCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYOUR_PAYER","txHash":"0x...","resource":"/api/premium"}' \
  https://vet402.com/api/v1/payments/x402
```

agent ID、バッチ、判定後の結果報告、MCP（`@vet402/mcp-server`）もあります。

## あえて選んだ設計

- ウォレット照合や致命的な RPC 失敗は **フェイルクローズ**
- **決済証跡はオンチェーン検証してから記録**
- WL でも **シビル high は昇格させない**
- **事実の公開面はキー不要。スコア照会はキー必須**
- x402 加重はまず **10%**
- 測っている事業者は顧客ではない。判定は売らない

## 試す

- 観測: [vet402.com/observatory/state](https://vet402.com/observatory/state)
- キー: [vet402.com/signup](https://vet402.com/signup)
- SDK: `npm install @vet402/sdk`
- コード: [github.com/kzmttkc/vet402](https://github.com/kzmttkc/vet402)

招待コードは書きません。より良い非公開の判定も売りません。

---

*Next.js / viem / Neon / Base 上の ERC-8004。We buy. We settle. We publish the measurements.*

---

## 主張マップ（この節は投稿しない）

| 主張 | 根拠 |
|---|---|
| 観測の事実はキー不要 | `GET /api/v1/observatory/state` |
| スコア API はキー必須 | `/api/v1/wallets` / `/api/v1/payees` |
| `getPayeeScore` | `@vet402/sdk` |
| SpendGuard は払わない | SDK。`payOrRefuse` は未実装 — 足さない |
| しきい値 70 / 40 | `SCORE_THRESHOLDS` |
| signup 開放 | `/signup` |

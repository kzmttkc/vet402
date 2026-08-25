# `payOrRefuse` 設計（会期前の仕様・実装は 2026-09-04 以降）

> 決定 2026-08-25。根拠は [`fixtures.md`](./fixtures.md) の本番実測。
> この文書は **`payOrRefuse` の仕様**であって実装ではない。支払いパス（signer / x402 settle / デモエージェント）には会期まで手を入れない。
>
> 例外（製品欠陥の是正・会期の細工ではない）: SpendGuard `trustPolicy: "evidence"` は 2026-08-25 に main へ入った。npm 未公開。**これは判定であり、`payOrRefuse` ではない。** 会期の新規は「判定のあと、条件を全部通したときだけ払う」一事。
> 上位の賭けは [`WIN_EV.md`](./WIN_EV.md)、日次は [`ROADMAP.md`](./ROADMAP.md)。

## 1. 実測が壊した前提

会期スコープは「BLOCK なら署名しない・ALLOW なら実 x402 で払う」だった。本番を測ると成立しない。

| 測ったもの | 結果 | 出典 |
|---|---|---|
| payee 30件の本番判定（settleする相手・1度もしない相手・delisted・若いwallet を横断） | **30/30 が WARN**（41〜69点） | vet402.com/payee/{addr}（リクエスト毎に本番エンジン実行）2026-08-25 |
| ALLOW（70以上） | **構造的に出ない**。受領実績の無い payee は 69 で頭打ち | `PAYEE_THIN_SCORE_CEILING` |
| thin を抜ける条件 | 独立payer2人以上 × 3件以上、または L1配達3件以上 × 買い手2人以上 | `determineDataDepth` / `l1DeliveryDepth` |
| `x402_payments` の行数 | **0** | 本番DB |
| L1 settled の distinct buyer | **全て1**（観測所のみ） | 本番DB |
| BLOCK（40未満） | 30件中 **0件**（最低 41） | 同上 |

**スコアは今日、事実上1値しか返していない。** それを支払いゲートに使う設計は、
「BLOCKだから止めた」も「ALLOWだから払った」も撮れない。会期前に分かってよかった。

## 2. 決定

動詞は増やさない。`payOrRefuse` を**呼び手が明示する policy で判定する**形にする。
そして判定の主役を、**vet402 だけが持っている L1 配達台帳**に置く——
「その相手は、実際に払って本当に届いたか」。スコアは補助信号として残す。

```ts
type PayPolicy = {
  /** 既定 70（= ALLOW ゲート）。今日のカタログでは全件を拒否する。fail-closed の既定を弱めない */
  minScore?: number;
  /** vet402 の L1 配達台帳に対する条件。呼び手が明示したときだけ有効 */
  evidence?: {
    minDeliveries: number;      // 例 3
    minSettleRate: number;      // 例 0.9（settled / attempts）
    windowDays: number;         // 例 21
  };
  maxAmountUnits?: bigint;      // 既定 1_000_000（= $1 USDC）
  requireChain?: string;        // 既定 "eip155:8453"
  requireAsset?: string;        // 既定 Base 正規 USDC
  /**
   * 払う側の条件（World「AgentKit Continuity」$3,500 に正面から当たる枠・2026-08-25 追加）。
   * 人間裏付けのあるエージェントにだけ上限を上げる: 未証明なら既定上限、AgentKit の
   * 人間裏付け認可を提示できたときだけ上限を引き上げる。動詞は増えず、条件が1つ増えるだけ。
   */
  payer?: { requireHumanBacked?: boolean; raisedCeilingUnits?: bigint };
};
```

`payer.requireHumanBacked` を満たさないときの拒否理由は `payer_not_human_backed`。
既存の agent 面（`/api/v1/agents/*`・agent passports）が AgentBook の登録/解決に対応する。

`payOrRefuse` は、**すべての条件を通過したときにだけ** signer を呼ぶ。
1つでも欠ければ署名前に返る（RPC send も `signTypedData` も facilitator settle もゼロ）。

拒否理由は機械可読の1語で返す:

`score_below_policy` / `insufficient_delivery_evidence` / `payee_mismatch`（402の payTo ≠ payee）/
`price_above_ceiling` / `chain_or_asset_mismatch` / `evidence_unavailable`（読めなかった＝fail-closed）

## 3. デモが見せるもの（動画の骨）

1. **既定 policy をカタログ全体に当てる**。ALLOW が誰にも出ない現実をそのまま見せる——
   拒否 N件・署名0件。「スコアが甘いから止まらない」のではなく「証拠が無いから止まる」。
2. **開示した policy に切り替える**: `{ evidence: { minDeliveries: 3, minSettleRate: 0.9, windowDays: 21 } }`。
   - 払う: `0x36038e1d…`（21日で 48/48 settled・単価 $0.02）→ 実 Base tx → attest → `/decisions` に `source: agent-demo`
   - 拒む: `0x76a672ee…`（21日で 0/77 settled・スコアは 69 WARN）→ **署名しない**
3. 一文: 「スコアは今日、誰にでも WARN と言う。だから払う判断は、我々が実際に買って届いたかどうかで決めた。」

WARN を上書きして払っているのではない。**呼び手が根拠を名指しし、その根拠を我々が測っている**。
ここが SpendGuard との差分であり、会期中の新規である。

## 4. やらないこと

- 自分の seller を自分で買って受領実績を作り、ALLOW を人工的に出す（中立性の憲法違反）
- 偽の BLOCK を作る／スコアのしきい値を大会のために動かす
- L1 台帳にデモ行を混ぜる（`source: agent-demo` の別枠は既定のまま）
- ENS・Registry 書き込み・新チェーン（Tokyo と Mumbai の動詞）

## 5. 製品としての意味

これは大会用の細工ではない。買い手向けAPIは今日、誰に対しても WARN しか返せず、
呼び手は何も決められない。金に一番近い段がそこで詰まっている。
policy と配達証拠でゲートを組み直すことは、その詰まりの是正そのものである。

## 6. 会期 Day 0 に書く失敗テスト（名前だけ・実装は会期中）

- `payOrRefuse` は `score_below_policy` で signer を0回呼ぶ
- `payOrRefuse` は `insufficient_delivery_evidence` で signer を0回呼ぶ
- `payOrRefuse` は 402 の payTo が payee と違えば `payee_mismatch` で署名しない
- `payOrRefuse` は上限超過の価格で `price_above_ceiling` を返し署名しない
- 台帳が読めないとき `evidence_unavailable` で拒否する（fail-closed）
- 全条件通過時のみ signer を1回呼び、返った txHash で attest する
- MCP `pay_if_trusted` は同じ判定を通り、拒否時に mock signer 呼び出し0回
- デモの決定行は `x402_l1_purchases` に入らない

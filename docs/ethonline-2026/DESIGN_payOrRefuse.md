> # ⚠️ この文書は参照資料です（2026-09-03 深夜）
> **会期の正典は [`WINDOW_PLAN.md`](./WINDOW_PLAN.md)。食い違ったらそちらが勝つ。**
> 5体の並行監査で「どの文書が正典か壊れている」が最大リスクと判定されたため、正典を1本に畳んだ。
> 特にこのファイルに残る次の記述は**もう正しくない**——
> 「ALLOW は構造的に出ない／カタログ全体が止まる」（9/2 実測で **ALLOW 対象 373 件**）、
> 「自前 seller を立てて ALLOW を作る」（**廃止**。払う先は The Graph 本体）、
> 「Day 0 のテストは12本/17本」（**22本**）、「World AgentKit を狙う」（**9/3 に取り下げ**）。

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

## 1.5 判定源の変更（2026-09-02・製品定義書 v1.0 リリース後）

設計時（8/25）は「スコアが誰にでも WARN しか返さない」ことが前提だった。9/2 のリリースで
**`GET /resources/{id}/decision?role=payer` が正典**になり、facts と recommendation を同居させて返す。
実測（[`fixtures.md`](./fixtures.md) §7）:

- 実際に買って届いた相手 → **ALLOW**（`l0_pass, l1_delivered`・facts に tx 付き）
- 一度も測っていない相手 → **BLOCK**（`l0_unverified, l1_not_attempted`・degraded）

したがって `payOrRefuse` が読むのは**スコアの `signals.receiving` ではなく `/decision`**。
これは会期中の新規である「§9.3 買い手モード」そのものであり、9/4 まで実装しない。

```ts
payOrRefuse({ payee, resource, amountUsd, account, policy })
// 1. GET /resources/{id}/decision?role=payer   ← 事実と判定を1回で取る
// 2. policy を当てる（既定は allow_only。ALLOW 以外は払わない）
// 3. 通らなければ **署名に到達しない**。理由はサーバの reason_codes をそのまま返す
// 4. 通ったときだけ signer を渡し、x402 exact → attest
```

**拒否は policy 側で作る。** サーバの verdict が BLOCK から WARN へ流れても
（拒む相手が C1 で測られれば起きる）、`allow_only` なら絵は壊れない。

## 1.6 本番DBでの検算（2026-09-02・実装セッション）と、そこから確定したこと

| 検算 | 値 | 意味 |
|---|---|---|
| `decidePayer` の ALLOW 条件を満たす active endpoint | **373件**（例 `api.bitrefill.com/x402/checkout/info`、`hyperliquid-accounts.use.x402atlas.com/state`） | **自前 seller を外す判断は成立**。ALLOW を作るために自分の店を立てる必要はもう無い |
| BLOCK 候補（3回以上試して1件も届かない） | **102件** | 本物の不履行が実在する。ただし**動画で名指ししない**（下記） |
| 決済後 4xx | 我々の `probe_error` として `n_attempts` から除外 | 「拒否の絵は policy で作る」方針が正しいことの裏づけ |

### 確定 (a): `evidence.source` は**会期中の新規**であり、4面に同時に足す

現行 `/decision` の `evidence[]` は `{level, purchase_id?, url}` のみで、**どの証拠源から判定したかを返していない**。
The Graph の証拠源（§3.5）を足すなら、**実装・OpenAPI・SDK・MCP の4面を同時に**更新する必要がある
（このリポの契約4面パリティ検査に従う）。これは会期中に作る新規として正しく、
**「この判定は自社台帳と Subgraph のどちらを読んだか」を機械可読で返せるようになる**——
第三者が検算できるという主張の実体になる。

```
evidence: [{ level: "L1", purchase_id, url, source: "vet402" | "subgraph", query?: {...} }]
```

`source: "subgraph"` の行には、引いた Subgraph の ID と、live であることを示す最小情報を載せる
（賞の要件「モック・ローカルのみ・静的データは不可」に対する証跡がここになる）。

### 確定 (b): 拒否の絵は「まだ測っていない」で撮る。102件は**数字としてだけ**使う

本物の不履行が 102 件あるとしても、**動画で特定の売り手を名指しして「届けない」と言わない**。
理由は3つ: (1) 我々の主張は「測る側を測る」であって断罪ではない (2) 8/26 の F-1 で
「不履行に見えたものが我々のバグだった」を経験している (3) 相手に異議の機会を与える仕組み（§10）が
あるのに、動画は一方通行である。

動画で言うのは「**3回以上払って一度も届かなかった相手が 102 件いる**」という集計と、
拒否の実演は `l1_not_attempted` / `l0_unverified`（＝我々がまだ測っていない）で行う。
断罪ではなく無知として拒む方が、我々の立場として強い。

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
   - 拒む: `agent.api.0x.org/v1/x402/…`（`0xb15a55e8…`・**L1 実績 0 件**）→ **署名しない**。
     理由コードは `insufficient_delivery_evidence`。**相手の不履行ではなく、我々の無知**である
     （2026-08-26 の F-1 訂正: 「settle しない売り手」の記録は我々の URL バグだった。[`fixtures.md`](./fixtures.md) §5・§6）
3. 一文: 「スコアは今日、誰にでも WARN と言う。だから払う判断は、我々が実際に買って届いたかどうかで決めた。
   拒んだ相手が悪いのではない——**まだ一度も買っていない**。証拠が集まれば通る。」

WARN を上書きして払っているのではない。**呼び手が根拠を名指しし、その根拠を我々が測っている**。
ここが SpendGuard との差分であり、会期中の新規である。

## 3.5 証拠源をもう1つ（2026-08-31 追加・The Graph 枠 $5,000 に対応）

今の evidence は **vet402 自身の L1 台帳**だけを読む。買い手は「vet402 を信じる」ことを要求される——
これは我々の原則（測定器を疑え）に照らして弱い。

会期中に足すのは**動詞ではなく証拠源1つ**:

```ts
evidence: {
  minL1Deliveries: 3,
  source?: "vet402" | "subgraph" | "both",   // 既定 "vet402"
}
```

- `"subgraph"`: The Graph の**生データ**（Subgraph Studio 経由）から、その payee が受け取った
  Base USDC の決済履歴を引き、同じ床で判定する。**第三者が独立に検算できる証拠**になる。
- 両方が読めないときは fail-closed（`evidence_unavailable`）。片方だけ読めたときは、
  どちらで判定したかを決定行に明記する（黙って弱い方に落ちない）。
- MCP `pay_if_trusted` から同じ選択ができるようにする（賞の要件「再利用可能な道具」に当たる）。

**前提**: Graph Gateway の API キー（Subgraph Studio・無料枠）。賞は「モック・ローカルのみ・
静的データは不可」と明記しているので、キーが無ければこの枠は成立しない。09-04 までに確定させる。

## 4. やらないこと

- 自分の seller を自分で買って受領実績を作り、ALLOW を人工的に出す（中立性の憲法違反）
- 偽の BLOCK を作る／スコアのしきい値を大会のために動かす
- L1 台帳にデモ行を混ぜる（`source: agent-demo` の別枠は既定のまま）
- ENS・Registry 書き込み・新チェーン（Tokyo と Mumbai の動詞）

## 5. 製品としての意味

これは大会用の細工ではない。買い手向けAPIは今日、誰に対しても WARN しか返せず、
呼び手は何も決められない。金に一番近い段がそこで詰まっている。
policy と配達証拠でゲートを組み直すことは、その詰まりの是正そのものである。

## 6. 会期 Day 0（09-04）に書く失敗テスト——**名前を確定した。実装はしない**

Day 0 は red だけ。この一覧をそのままテスト名にする。全部落ちている状態で1コミット
（`ethonline: test(sdk,mcp): payOrRefuse fail-closed contract (red)`）。

**A. 署名に到達しないこと（この4本が提出物の核心）**
1. `/decision` が ALLOW 以外を返したら signer を **0回** 呼ぶ
2. `/decision` が degraded を返したら signer を 0回 呼ぶ（読めなかった＝払わない）
3. `/decision` の取得に失敗（HTTP エラー・タイムアウト）したら signer を 0回 呼ぶ（fail-closed）
4. 402 の `payTo` が `payee` と違えば `payee_mismatch` で signer を 0回 呼ぶ

**B. policy が効くこと**
5. `maxPerTxUsd` 超過は `price_above_ceiling` で拒否（判定を引く前に落とす）
6. `evidence.minL1Deliveries` 未達は `insufficient_delivery_evidence` で拒否
7. `evidence.minSubgraphReceipts` 未達は `insufficient_subgraph_evidence` で拒否
8. `evidence.source: "both"` で片方しか読めなければ拒否し、理由に**どちらが読めなかったか**が入る
9. `payer.requireHumanBacked` が満たされないとき、上限は**既定のまま**（引き上げない）

**C. 通ったときの振る舞い**
10. 全条件通過時のみ signer を **1回** 呼び、返った txHash で attest する
11. attest は関数の一部——`payOrRefuse` の戻り値に `attested: true` が入る
12. 署名後に settle が失敗したら `status: "failed"` を返し、**それも公開する**（隠さない）

**D. 汚染しないこと**
13. デモの決定行は `source: "agent-demo"` で、`x402_l1_purchases` に**入らない**
14. L1 フィードはデモ行を無視し、デモフィードは L1 行を無視する

**E. MCP**
15. `pay_if_trusted` は A の4本と同じ拒否を返し、mock signer 呼び出しは 0回
16. `pay_if_trusted` の応答に `evidence[].source` が入る（審査員が証拠源を目で追える）

**F. 契約4面のパリティ**
17. `evidence[].source` が 実装・OpenAPI・SDK 型・MCP スキーマの4面で一致する

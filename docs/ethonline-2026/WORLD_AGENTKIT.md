> # ⚠️ この文書は参照資料です（2026-09-03 深夜）
> **会期の正典は [`WINDOW_PLAN.md`](./WINDOW_PLAN.md)。食い違ったらそちらが勝つ。**
> 5体の並行監査で「どの文書が正典か壊れている」が最大リスクと判定されたため、正典を1本に畳んだ。
> 特にこのファイルに残る次の記述は**もう正しくない**——
> 「ALLOW は構造的に出ない／カタログ全体が止まる」（9/2 実測で **ALLOW 対象 373 件**）、
> 「自前 seller を立てて ALLOW を作る」（**廃止**。払う先は The Graph 本体）、
> 「Day 0 のテストは12本/17本」（**22本**）、「World AgentKit を狙う」（**9/3 に取り下げ**）。

> **【2026-09-03 この賞は取り下げた】** AgentBook 登録は `@worldcoin/idkit-core` の
> `DEFAULT_VERIFICATION_LEVEL = "orb"` で **Orb 必須**。Takeshi は過去に Orb 済みだが証明が
> 他人に預けたデバイス内にあり会期中に取り出せない。要件4（World ID Sandbox で遠隔テスト）も
> 公開版 CLI に environment 切替が無く**構造的に満たせない**。この文書は調査記録として残す。
> **AgentBook の live 解決だけ**（Orb 不要）は 09-11 午前の任意枠に置く。

# World「AgentKit Continuity」$3,500 — 唯一取れる賞の下ごしらえ

> 2026-08-26。**会期前の調査と仕様であって実装ではない**（フリーズは [`../../AGENTS.md`](../../AGENTS.md) 最上部）。
> なぜこの賞だけを見るのか: ETHGlobal の公式回答で、continuity 提出は continuity ラベルの枠しか
> 選べないと確定した（[`PRIZES.md`](./PRIZES.md)）。要件が合う continuity 枠は今これ1つだけ。

## 1. 賞の要件（公式ページ・2026-08-25 実測）

> Extend an existing project with AgentKit to distinguish a bot from an agent acting on behalf of a
> real, unique human. Explore durable human-backed agent authorization for access, commerce,
> rate limits, trust, and continuity across services.

必須:

1. **AgentKit を実質的に使う**
2. **動くアプリを見せる**
3. 該当すれば **AgentBook で agent を登録/解決**する
4. **World ID Sandbox App** で遠隔テストする
5. **フィードバック文書**を出す（ドキュメント・Developer Portal・Sandbox の詰まった点、
   何が分かりにくく・欠けていて・壊れていて・試しにくかったか）

5 は「おまけ」ではなく採点対象。**会期中に実際に詰まった箇所を記録しながら作る**のが最短路になる。

## 2. AgentKit とは何か（一次確認・2026-08-26）

出典: docs.world.org/agents/agent-kit/integrate と github.com/worldcoin/agentkit の README。

- パッケージ: **`@worldcoin/agentkit`**（クライアント/サーバ両方）・**`@worldcoin/agentkit-cli`**
- 登録: `npx @worldcoin/agentkit-cli register <agent-address>`。**World App を通した World ID 検証**を伴い、
  「その署名ウォレットの背後に実在の人間が居る」という事実を **AgentBook** へ載せる
- 提示するもの: エージェント側は `agentkit.fetch()` で、**ウォレット住所＋nonce 付き署名**を送る
- 検証するもの: サーバ側は AgentBook の登録を引いて署名を検証し、アクセス方針を適用する
- **重要: AgentKit は x402 の上に乗っている。** サーバ側ミドルウェアは `@x402/hono` で、
  人間裏付けのあるエージェントには無料枠（README の例では3回）を与え、
  **検証が不能・失敗・使い切りのときに通常の x402 支払いへ落ちる**

### まだ確定していない2点（partner channel が開いたら最初に聞く）

| 論点 | 見えている食い違い |
|---|---|
| AgentBook はどのチェーンか | docs は **World Chain**、README は **Base mainnet の hosted relay**（Base Sepolia も可）と書く。**Base なら我々の既存レールと同じ**で実装が軽い |
| 登録する人間に要る検証レベル | 「World App 経由の World ID 検証」としか書いていない。**Orb 必須か、端末検証で足りるか**が読めない。Orb 必須なら Takeshi の手番が重くなる（要事前確認） |

## 3. vet402 との噛み合い（なぜ薄いロゴ貼りにならないか）

AgentKit が答えるのは「**払う側**は本物の人間の代理か」。
vet402 が答えるのは「**払う先**は本当に届けるか」。**同じ支払いの、逆側の2問**である。

会期中の新規である `payOrRefuse` は、この2つを1つの関門に畳める:

```
payOrRefuse({
  payee, amountUsd, resource, account,
  policy: {
    evidence: { minDeliveries: 3, minSettleRate: 0.9, windowDays: 21 },  // 払う先の証拠（vet402）
    payer:    { requireHumanBacked: true, raisedCeilingUnits: 5_000_000n } // 払う側の裏付け（AgentKit）
  }
})
```

意味は一行で言える: **人間の裏書きがあるエージェントには上限を上げる。裏書きが無ければ既定の $1 のまま。
どちらの側も、証拠が読めなければ払わない**（fail-closed）。

「durable human-backed agent authorization for **access, commerce, rate limits, trust**」という
賞の文言に、commerce（実支払い）と rate limits（上限）が正面から当たる。

## 4. 会期中スコープ（9/4 以降・動詞は増やさない）

1. `payOrRefuse` の policy に `payer.requireHumanBacked` を足す。拒否理由は `payer_not_human_backed`。
   AgentBook の解決が読めないときは fail-closed（上限を上げない）。
2. デモの買い手エージェントを **AgentBook に登録**し、人間裏付けありで上限が上がる様子と、
   未登録の第2エージェントが既定上限のままである様子を並べて見せる。
3. `examples/` のデモ seller は `@x402/hono` + AgentKit hooks で立て、
   **無料枠 → 使い切り → x402 支払い**の落ち方を実際に通す（我々の middleware と同じ面に置く）。
4. **フィードバック文書**を会期中ずっと書き足す（`docs/ethonline-2026/WORLD_FEEDBACK.md`）。
   詰まった瞬間にその場で1行書く。後からまとめて思い出さない。

範囲外: World ID を人間のログインに使うこと（我々は人間向けアプリではない）、Selfie Check 枠、
World Chain への移行（AgentBook が Base で足りるなら触らない）。

## 5. 会期前に要る準備（Takeshi 手番・9/4 まで）

- **World App のインストールと World ID 検証**（`agentkit-cli register` が要求する）。
  Orb 必須かは §2 の未確定事項。partner channel の回答を待ってから着手して構わない。
- デモ用エージェントのウォレット（賞金受取用 `0x6777…3986` とは**別の使い捨て鍵**。
  [`ROADMAP.md`](./ROADMAP.md) A3.1 と同じ理由）。

## 6. 出典

- 賞ページ: https://ethglobal.com/events/ethonline2026/prizes
- AgentKit 統合ガイド: https://docs.world.org/agents/agent-kit/integrate
- AgentKit リポ: https://github.com/worldcoin/agentkit
- AgentBook 登録の手順: https://docs.world.org/agents/agent-kit/integrate#step-2-register-the-agent-in-agentbook
- Sandbox: https://docs.world.org/world-id/sandbox/sandbox-access

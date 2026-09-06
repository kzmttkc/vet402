# ETHOnline 2026 — A/B 実証ハーネス（P2 / Bazantic）

賞の問いは一文だけ——**「エージェントが、あなたの説明なしにあなたの製品を使えるか」**。
それを A/B で測る。**測り方は走らせる前に固定されている**（`docs/ethonline-2026/WINDOW_PLAN.md` §16 の事前登録）。
このディレクトリは、その事前登録を**そのまま実行するだけ**の道具である。

```bash
cd examples/ethonline-2026-ab
npm test                       # ハーネス自体の検査（鍵不要・ネットワーク不要）
node src/cli.mjs --agent mock  # 20試行を通し、results/<timestamp>/ へ生ログを書く
node test-mutations.mjs        # わざと壊して、テストが赤くなることを確かめる
```

## 何を測るか

| | 与えるもの |
|---|---|
| **A（Recipe なし）** | Bazantic Gateway の URL、素の API 一覧（`docs/openapi.yaml` の 56 操作）、**Gateway の MCP ツール** |
| **B（Recipe あり）** | 同じもの ＋ **bazantic.com で作った Recipe**（`recipe/x402-payee-verification.json` の写し） |

**同一モデル・同一プロンプト・同一ツール。違うのは Recipe の有無だけ**（賞ページ原文:
"Make the Recipe the only material difference between the tests."）。
主張ではなく計器にしてある: B のプロンプトから Recipe ブロックを機械的に取り除くと、A と1文字も違わない
（`stripRecipe()`・`test/prompt.test.mjs`）。ツール一覧は条件を見ずに1回だけ解決するので、
条件で変わりようがない（`test/agents.test.mjs`「A と B に渡すツールは同一」）。

### 条件 B は `SKILL.md` ではない（2026-09-06 訂正）

**2026-09-06 まで、この実装は B に `SKILL.md` 全文を入れていた。** `SKILL.md` は我々が書いた
ドキュメントであって Bazantic の Recipe ではないので、**賞の要件を満たしていなかった**
（正典 `WINDOW_PLAN.md` §16 は同日に訂正済みで、コードだけが古かった）。

**リポに置いてあるのは写しで、原本は bazantic.com にある。** だから写しは出所（`source`）を持ち、
**写せていない項目は `null` のまま `notRetrieved` に並べる**——埋めると原本と食い違い、
その食い違いが誰にも見えなくなる。写しとプロンプト本文の突合は `assertRecipeShape()` が両方向に検める
（未取得なのに値がある／値があるのに未取得と言っている、のどちらでも投げる）。

| Recipe | |
|---|---|
| slug | `x402-payee-verification-via-vet402-gateway` |
| name | `X402 Payee Verification via vet402 Gateway` |
| tools | `getResourceDecision` / `getPayeeScore` / `getObservatoryEndpointPurchases` |
| MCP | `https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp` |
| **未取得** | `description` / `prompt` 本文 / `inputs`（**要取得**。原本の画面から写す） |

### MCP は経路に入っている

**2026-09-06 まで、実 LLM アダプタは `messages.create` を1発叩くだけで、ツールもネットワークも
与えていなかった。** Gateway の URL はプロンプトに文字列として載っていただけで、**MCP は経路の外**だった。
賞の問いは "Show us it can be done **using Bazantic built MCP server and recipe**" なので、
それでは中核を実演していない。

いまは `src/mcp.mjs` が Streamable HTTP で `initialize` → `notifications/initialized` →
`tools/list` / `tools/call` を話し、その定義を Anthropic の `tools` として **A にも B にも同じだけ**渡す。
どのツールを何回呼んだかは生ログの `raw.toolCalls` に残る。
**このリポは実 MCP を一度も呼んでいない**——`fetch` を差し替えて、送っている JSON-RPC そのものを固定してある。

課題（A/B 共通・§16 の原文）:

> この x402 エンドポイントに払う前に、受取人がこれまでに実際に配達したことがあるかを確かめよ。
> 証拠が無ければ**払わずに**、理由を機械可読なコードで示せ。

**成功＝2条件の論理積**（`src/grade.mjs`）:

1. 判定が、同じ相手に対して我々の API が返す判定と一致する
2. 挙げた理由コードが、**実際に返ってきた**理由コードの**部分集合**である

2 が要。**正解にたまたま当たっても、根拠が嘘なら失敗**とする。

## 結果を良く見せられない形にしてある

| 塞いだ穴 | どう塞いだか | 変異で確認 |
|---|---|---|
| 良い結果が出るまで回し直す | 実行のたびに**新しいタイムスタンプ付きディレクトリ**。既存があれば拒否 | `test/writer.test.mjs` |
| 失敗した試行を捨てる | エラーも1試行として記録し、**分母に入る**。除く経路が存在しない | M2 / M6 |
| 集計値を生ログと食い違わせる | 集計は毎回 `trials.jsonl` から計算。`verifyRunDir` が保存済み集計と数え直しを突合 | M3 |
| 成功条件をこっそり緩める | §16 の論理積をテストで固定。試行数も**事前登録の値以外は拒否** | M1 / M5 |
| 秘密が出力に混ざる | 書く前に `assertNoSecrets`。1つでもあればファイルを作らない | M4 |
| A/B のプロンプトが Recipe 以外でも違う | `stripRecipe(B) === A` を固定 | M7 |

`node test-mutations.mjs` は16種の変異を順に当て、**赤くならない変異があれば失敗で終わる**。

## 出力

```
results/<YYYY-MM-DDTHHMMSSZ>/
  trials.jsonl   1行1試行の生ログ（プロンプト全文・生応答・判定・理由コード・所要時間・エラー）
  run.json       メタ（モデル・temperature・課題文・事前登録の参照・フィクスチャの未確定）
  summary.json   生ログから導いた集計（verifyRunDir が毎回数え直して突合する）
  summary.md     人が読む表
```

**§16 は生ログを `docs/ethonline-2026/ab/` に置くと書いている。** この作業ブランチは `docs/` を触らない
取り決めなので `results/` に出している。**実 LLM で走らせたあと、依頼元が `docs/ethonline-2026/ab/` へ移すこと。**

`results/` に入っているのは**モック**（`mock-scripted-v1`）の実行で、
どのモデルの能力も表していない。`summary.md` の先頭にその断り書きが出る。
**2026-09-05 の実行は消した**——条件 B に `SKILL.md` を入れていた頃の生ログで、いまの設計と食い違う。
消した記録は git 履歴が持つ。

## 実 LLM で走らせるとき

LLM を呼ぶのは **`runAgent(prompt) => {text, model, temperature, raw}` 1関数だけ**。
差し替え可能にしてあるのは、(a) 鍵の無い環境でハーネス自体を検査できるように、
(b) 依頼元がモデルを選べるように、(c) 実行の再現性のため。

```bash
npm i @anthropic-ai/sdk          # このディレクトリで
export ANTHROPIC_API_KEY=…       # または `ant auth login`
node src/cli.mjs --agent anthropic --model claude-opus-5 --effort high
# MCP の口は既定で recipe/*.json の source.mcpUrl。上書きするなら --mcp <url>
```

**実行すると Bazantic Gateway の MCP を実際に叩く**（`tools/list` と、モデルが選んだ `tools/call`）。
`run.json` の `meta.mcpUrl` と、各試行の `raw.toolCalls` / `raw.toolNames` に何が起きたかが残る。
モックで走らせた実行は `meta.mcpUrl: null` になり、`summary.md` の先頭に
「no MCP server was called in this run」と出る——**呼んだふりをしない。**

**`DEMO_PAYER_PRIVATE_KEY` も要る**（`export DEMO_PAYER_PRIVATE_KEY=0x…`。値は出力に出ない——`src/secrets.mjs` が止める）。
Bazantic Gateway は全ルート 0 mcents でも、未払いの呼び出しには 402 を返す（既定仕様・設定で外せない）。
MCP の `tools/call` では払えない（PAYMENT-SIGNATURE を載せても無視される・2026-09-06 実測）ので、
`src/mcp.mjs` の橋が同じ資源を REST `GET` に回して署名付きで再送し、本物の応答をモデルへ返す。
**1 呼び出しにつき 0 USDC のオンチェーン tx が 1 本立つ**（`raw.toolCalls[].x402Bridge.txHash` に残る）。鍵が無ければ橋は動かず、402 の文がそのままモデルへ届く。

**走らせる前に潰すもの**（`run.json` の `meta.fixtureReadiness.blockers` に機械可読で出る）:

- **F1 / F3 / F4 の oracle が未測定**（正典の記述と SDK の実装から導いた値）。本番 `/decision` と
  `payOrRefuse` で取り直して `src/fixtures.mjs` を更新する
- **F3 の payee 全アドレス**（`0xb15a55e8…` の残り32桁がリポのどこにも無い）
- **F2 の resource URL**（`…/subgraphs/id/<ID>` の `<ID>` が正典に無い。`resourceId` は実測値がある）

**`temperature` は送っていない。** 現行モデル（Claude Opus 5 等）は `temperature` / `top_p` を
受け付けず 400 を返す。§16 は「同一 temperature」を要求しているが、**設定できないものは設定しない**。
全試行が `null`（＝送っていない）で揃っていることを `run.json` に残す。**これは事前登録からの逸脱**なので、
提出物にそのまま書く。

## ファイル

| | |
|---|---|
| `src/fixtures.mjs` | §16 の4件と oracle（**出所と測定日つき**。作った値は1つも無い） |
| `src/prompt.mjs` | A/B 共通プロンプトと Recipe ブロック。OpenAPI からの API 一覧抽出 |
| `src/harness.mjs` | 20試行。**LLM を呼ぶのはここに渡す `runAgent` だけ** |
| `src/parse.mjs` | 生応答から verdict / reason_codes。**散文から推測しない** |
| `src/grade.mjs` | §16 の採点（論理積） |
| `src/aggregate.mjs` | 生ログからの集計。除く経路が無い |
| `src/writer.mjs` | 出力と `verifyRunDir` |
| `src/recipe.mjs` | Bazantic の Recipe の写しを読む・検める・条件 B の本文に描く |
| `recipe/x402-payee-verification.json` | **写し**（原本は bazantic.com）。出所と未取得項目つき |
| `src/mcp.mjs` | Bazantic Gateway の MCP への薄い橋（`fetch` は差し替え可能）。**$0 の x402 402 だけ** REST で払って本物の応答に置き換える |
| `src/secrets.mjs` | 秘密の検出（値を探す。名前は秘密ではない）。32バイト hex は**公開済みと確かめた値だけ**許可リストで通す |
| `src/agents/mock.mjs` | 台本のスタブ。**プロンプトしか見ない**（正解表を import しない） |
| `src/agents/anthropic.mjs` | 実 LLM アダプタ。**このリポでは一度も実行していない**（純粋部分だけテスト済み） |

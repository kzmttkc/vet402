# ETHOnline 2026 — A/B 実証ハーネス（P2 / Bazantic）

## In English (summary)

**What it measures.** Can an agent use vet402 through the Bazantic Gateway without my explanation? Condition A gets the Gateway URL, the raw API list and the Gateway's MCP tools; condition B gets the same plus the Recipe (`recipe/x402-payee-verification.json`, a copy of the original on bazantic.com). The Recipe is the only difference — `stripRecipe()` turns B's prompt into A's byte for byte, and a test pins it.

**How to run.** Mock (no keys, no network): `npm ci` in this directory (`viem` is a direct dependency since 2026-09-07), then `cd examples/ethonline-2026-ab && npm ci && npm test && node src/cli.mjs --agent mock` (20 trials) and `node test-mutations.mjs` (breaks the harness on purpose; every mutant must turn a test red). Live: `export ANTHROPIC_API_KEY=…` and `node src/cli.mjs --agent anthropic --model <model>`; add `DEMO_PAYER_PRIVATE_KEY` for the bridge below. `run.json` records `meta.fixtureReadiness.blockers` — the unmeasured oracles that must be filled before a live run counts.

**Where results go.** `results/<timestamp>/` — `trials.jsonl` (one raw trial per line), `run.json` (meta), `summary.json` and `summary.md` (recounted from the raw log every time). The committed run is the mock; it says so in its first line. Live runs are to be moved to `docs/ethonline-2026/ab/` as pre-registered in `docs/ethonline-2026/WINDOW_PLAN.md` §16.

**Bazantic's 402 and the bridge.** The Gateway answers 402 to any unpaid call even at 0 mcents and ignores `PAYMENT-SIGNATURE` on MCP `tools/call`, so `src/mcp.mjs` re-sends the same resource as a signed REST `GET` and hands the model the real response (one 0-USDC tx per call, kept in `raw.toolCalls[].x402Bridge.txHash`); without a payer key the 402 text reaches the model unchanged. Re-measured 2026-09-09: the Gateway's 0-mcent tools now answer an unpaid `tools/call` with the body, so the bridge is not entered; the 88 transactions in run `2026-09-06T213134Z` are that day's behaviour.

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

**この例の中で `npm ci` を済ませておく**（署名者は `viem` を動的 import する。2026-09-07 から viem はこの例の直接依存。以前はリポ直下の依存で、この例には入れていない。無ければ鍵があっても `ERR_MODULE_NOT_FOUND` で止まる——2026-09-06 に CI で実際に起きた）。

**`DEMO_PAYER_PRIVATE_KEY` も要る**（`export DEMO_PAYER_PRIVATE_KEY=0x…`。値は出力に出ない——`src/secrets.mjs` が止める）。
Bazantic Gateway は全ルート 0 mcents でも、未払いの呼び出しには 402 を返す（既定仕様・設定で外せない）。
MCP の `tools/call` では払えない（PAYMENT-SIGNATURE を載せても無視される・2026-09-06 実測）ので、
`src/mcp.mjs` の橋が同じ資源を REST `GET` に回して署名付きで再送し、本物の応答をモデルへ返す。
**1 呼び出しにつき 0 USDC のオンチェーン tx が 1 本立つ**（`raw.toolCalls[].x402Bridge.txHash` に残る）。鍵が無ければ橋は動かず、402 の文がそのままモデルへ届く。2026-09-09 の再計測では 0 mcents のツールが未払いの `tools/call` に本文を返し、橋は動かない（`2026-09-06T213134Z` の 88 本はその日の挙動）。

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

## 結果はどこにあるか（2026-09-07）

| 場所 | 中身 |
|---|---|
| `docs/ethonline-2026/ab/<timestamp>/` | **提出物としての実走**。`2026-09-06T093254Z`（橋なし・全ツール呼び出しが 402 で 0/0——計器の故障として残す）と `2026-09-06T213134Z`（橋あり・本走・A 5/10・B 5/10）。2026-09-11 に `2026-09-10T233702Z`（v2・§16.5・payer 鍵なし＝橋なし・tx 0・A 7/10・B 5/10）。読みは `WINDOW_PLAN.md` §16.1〜16.3、審査員向けの所見は `docs/ethonline-2026/BAZANTIC_FEEDBACK.md` |
| `examples/ethonline-2026-ab/results/<timestamp>/` | ハーネスが書く先。コミットされているのはモックの実行だけで、実走はここから `docs/ethonline-2026/ab/` へ移す |

**mock と live の見分け方**: `run.json` の `meta.isMock`（`true` なら台本のスタブ・モデルの能力を表さない）と
`meta.mcpUrl`（モックは `null`＝MCP を呼んでいない）。`summary.md` の先頭行にも同じ断り書きが出る。
実走は `meta.agentAdapter: "anthropic"`・`meta.model`・各試行の `raw.toolCalls`（橋が打った tx は `x402Bridge.txHash`）で確かめる。
どちらも集計は毎回 `trials.jsonl` から数え直す（`verifyRunDir`）。

## 提出物の数字はこの 1 本が印字する（2026-09-07）

```bash
npm run metrics -- ../../docs/ethonline-2026/ab/2026-09-06T213134Z          # Markdown の表
npm run metrics -- ../../docs/ethonline-2026/ab/2026-09-06T213134Z --json   # 同じ数字を JSON で
```

`WINDOW_PLAN.md §16.3` と `BAZANTIC_FEEDBACK.md` に載る数字は**すべてこの出力の引用**で、手で数えない
（09-07 に語彙率を手で数えて 6%/31% と過小評価した。oracle が返す階層コードを集合から落としていた）。

出すもの: 採点値（条件ごと・フィクスチャごと。`summary.json` は読まず、`trials.jsonl` の答えと正解を
事前登録の規則 `src/grade.mjs` で **grade し直して**数える。保存済み `grade.*` と食い違えば件数を出す）／
事後の探索指標（語彙率 2 種。集合 (i) は `src/lib/observatory/vocabulary.ts`＋`packages/sdk/src/pay-or-refuse.ts` を
実行時に読む。(ii) はそれに oracle が返した語を足す。集合の大きさも印字。採点には使わない）／
橋（ツール呼び出し総数・`x402Bridge.settled`・ユニーク tx・未決済の HTTP ステータス内訳）／
メタ（model・effort・temperature の `null` は `not sent`・mcpUrl・isMock。mock の run は 1 行目に MOCK と出る）。
存在しない dir は 1 行で exit 1。`test/metrics.test.mjs` が固定し、`test-mutations.mjs` の M22（語彙のハードコード）・
M23（summary.json を読む）で退化を検出する。

## 会期後——このハーネスは週次ベンチマークになる（採用 2026-09-07）

**採用の正典は [`docs/hackathons/2026-autumn-continuity.md`](../../docs/hackathons/2026-autumn-continuity.md)
の「Between ETHOnline and Tokyo — the agent-obedience benchmark (adopted 2026-09-07)」節**（Takeshi 判断・09-07 06:44）。
提出文がこの採用日を引くので、ここから辿れるようにしておく（2026-09-12 追記）。

運用は同節の確定値をそのまま写すと:

- **1 モデル 1 週 1 回**（cost guard。橋は $0 しか署名しない・ベンチから実支出はしない）
- **同一フィクスチャ** F1–F4 を再利用し、イベントの verb ごとに 1 本足す（Tokyo の resolve-then-pay は 2026-09-25）。
  oracle は実測のまま置き、手書きしない
- **生の `trials.jsonl` を毎回公開する**（表だけを出さない）
- 採点は事前登録の規則（verdict 一致 ＋ 理由コード ⊆ ＋ 拒否なら非空）。語彙率は**事後の探索指標**と明示したまま

**着手は 09-13 の提出より後**（同節の Scope。会期のフリーズ表が優先する）。

# ETHGlobal Tokyo 2026 — 会期中の発注文 B0〜B11（A9・2026-09-18 作成）

**使い方（3点セットで渡す。1つでも欠けると会期が止まる）**: ①`AGENT_PROMPTS.md` を逐語で貼る → ②該当ブロックの節 → ③**このファイル末尾の「追補」と「追補2」を必ず一緒に貼る**（09-19 の監査で見つかった穴を塞ぐ内容で、本文より優先する）。1エージェント＝1ブロック。
判定コマンドの空打ち結果は `COMMANDS.md`。会期中の詰まりの判断は `RISKS.md`。

**すべての発注文に共通（毎回貼る）**: 進捗も最終報告も日本語で書く。コード・パス・エラーは原文可。

**時刻はすべて JST。**環境変数は `AGENT_PROMPTS.md` §11 のものを使う。

## 切り捨ての順番（PLAN §4・上から落とす。軸 i〜iii は落とさない）

| # | 落とすもの |
|---|---|
| 1 | MCP `pay_if_trusted` への反映（SKILL.md の語彙の表は残す） |
| 2 | 補助の走査 `sinceIssuanceScan`（T34）。「t の後に変えて戻す」は保護しないものとして開示 |
| 3 | attester の親名の固定 `anchor`（T35）。(名前, アドレス) の固定は残す |
| 4 | 場面3の「他の名前の記録へのつなぎ」（1文字と切り離しは残す） |
| 5 | 場面3の「記録の切り離し」（1文字だけ残す） |
| 6 | `/tokyo` の作り込み（名前の入力欄＋7段 JSON まで。ページと「形式: ensip29-draft」の表示は残す） |
| 7 | 場面1を 09-25 の定期購入で作ること（既存の購入で書き、購入日を画面に出す） |
| 8 | I11（§2.11）の「vet402 に届かなくても払う」経路 |
| 9 | testnet の実支払い（ALLOW → 署名する typed data を表示して止める） |

**落とさないもの**: 軸 (i) `x402-offer` を丸ごと証明する／軸 (ii) vet402 に届かない状態の対照と1文字での REFUSE／軸 (iii) 草案どおりの署名と両形式の検証（U01〜U04）／失敗テストを先に書く／2系統・固定ブロックの読み取り／観測ログ1件以上／既存の本番経路が壊れていない（judge-check 緑）／`/tokyo` のページ／開示の文書／動画。

## 金の経路に人が diff を読む時刻（動かさない）

| いつ | 何の diff | 誰 |
|---|---|---|
| 09-26 09:00–09:30（B3 受け入れ） | `packages/sdk/src/chain-profile.ts`・`x402-pay.ts`・`pay-or-refuse.ts` の profile 化と `minChainReceipts` の分 | Takeshi |
| 09-26 11:30–12:00（B6 受け入れ） | `pay-or-refuse.ts` の段 2.5（ENSIP-29）と §2.11 G1〜G10（**「免除するのは判定の中身であって判定の存在ではない」という規律の変更を含む**） | Takeshi |

**この2つの時刻の外で、`pay-or-refuse.ts`・`x402-pay.ts`・`chain-profile.ts`・`pay-if-trusted.ts` を main に入れない。**枝で完成させ、受け入れまで待つ。

---

# B0 — 会期開始直後の実測（09-25 21:00–21:40・上限 40 分）

**目的（1行）**: 計画が乗っている外部の事実が今も成り立つかを、2系統の RPC と公開 URL で確かめ、崩れていれば B1 より先に計画を直す。

**触ってよいパス**: `$DEMO/src/probe-rpc.ts`（新規）・`$DEMO/src/run.ts` の `census` 部分（読み取りのみ）・`$DEMO/.env.tokyo.local`（人が 19:50 に作る。読むだけ）・private リポの `.company/departments/hackathon/tokyo-2026/B0_RESULT.md`（新規）。

**触ってはいけないパス**: `packages/sdk/**`（B2 以降）・`src/**`・`/rwa` 系すべて・本番の金の経路（`AGENT_PROMPTS.md` §7）。**このブロックで署名・送信・faucet 請求を1回もしない。**

**入力**:
- `PLAN_v3.md` §1.7「会期初日に取り直す一覧」（表10行）
- `v3.3/PLAN_DIFF.md` §4.5 P26・P27・P28（§1.7 の**置き換え後の**行。**PLAN 本文より PLAN_DIFF が優先**）
- `AGENT_PROMPTS.md` §12（アドレス表・名前の表・新 ABI の注意10点）
- `e15/RESULT.md` §1（09-18 の計数の期待値）

**完成の定義**:
1. `probe-rpc.ts` が `--deployment`（配備の照合）・`--repeat N`（2系統の一致）の2つのモードで動く。**読み取り専用**（`eth_call`・`eth_getBlockNumber`・`eth_getLogs` だけ）。
2. §1.7 の10行を上から打ち、**「止めない」印の行以外が全部合格**。
3. 不合格が1つでもあれば、`RISKS.md` の該当行の分岐に入り、**B1 に進む前に**判断を1行で報告する。
4. `B0_RESULT.md` を private リポに commit・push。

**判定コマンド**（コピペ。詳細と空打ち結果は `COMMANDS.md` B0）:
```bash
set -a; . $DEMO/.env.tokyo.local; set +a
node $DEMO/src/probe-rpc.ts --deployment          # 期待: 1行 "deployment ok: ROOT=0x9703DBD2…a9cE (UR==UH), ethRegistry=0x657eA849…E09E, impl 0x8c2427cc=true"
node $DEMO/src/probe-rpc.ts --repeat 5            # 期待: 1行 "rpc ok: 5/5 match, head diff <= 1, canary 11717398 in both"
node $DEMO/src/run.ts census vet402.eth seller-a.eth seller-b.eth seller-c.eth   # 期待: 最終行 "census ok: 4 names, owners match, resolvers match, text empty"
gh api repos/ensdomains/ensips/pulls/85 --jq '.head.sha, .state'                 # 期待: e00c3453a4ce0fec8439e2aeeea4c47cb0604efe / open
curl -sL -o /dev/null -w '%{http_code}\n' https://vet402.com/api/tokyo/seller     # 期待: 404（200 なら会期前の作業が混ざっている）
curl -sL https://x402.org/facilitator/supported | jq -c '.kinds[] | select(.network=="eip155:84532" and .scheme=="exact")'  # 期待: 1行
curl -sL https://ethglobal.com/events/tokyo2026/prizes/ens | grep -c 'target an existing project'   # 期待: 1
```
**判定コマンドは「期待の1行」を出す形で作る。**表や JSON を人が目で読む形にしない。

**時間の上限**: 40 分。21:40 に終わっていなければ、合格した行だけを持って B1 へ進み、残りは 23:00 までに取り直す。

**詰まったときの切り捨て**: `gh` が使えない・フォーラム・参照実装・賞ページの3行は**取得失敗でも止めない**（前日 A2 の値で進む）。配備・RPC 2系統・名前の状態の3行が落ちたら止めて `RISKS.md` R2 へ。

**進捗も最終報告も日本語で書く。**

---

# B1 — 失敗テストと運用スクリプト（09-25 21:40–23:30・上限 1h50m）

**目的（1行）**: 実装より先に、期待をすべて理由コードの中身で書いた失敗テストを red のまま1コミットで入れ、K1 で人が打つ `keys.ts` と `admin.ts` を用意する。

**触ってよいパス**:
`$SDK/test/tokyo/regression.test.mjs`・`$SDK/test/tokyo/ens-attestation-unit.test.mjs`・`$SDK/test/tokyo/pay-or-refuse-ens.test.mjs`・`$DEMO/test/observe-attester.test.mjs`・`$MCP/test/tokyo/pay-if-trusted-ens.test.mjs`・`$DEMO/src/keys.ts`・`$DEMO/src/admin.ts`・`$DEMO/package.json`。

**触ってはいけないパス**: `$SDK/src/**`（B2・B3・B6）・`$SDK/test/*.test.mjs`（既存 62 本）・`src/**`・`/rwa` 系。**`$SDK/test/tokyo/` は本線の glob `test/*.test.mjs` の外**なので、ここに置く限り既存の `npm test` は赤にならない。

**入力**:
- `PLAN_v3.md` §3 の表全部（U01〜U04・T01〜T47）と、その直前の段落（ファイルの分け方・各テスト内の `await import()`・テスト名の形）
- `v3.3/PLAN_DIFF.md` §5（**T04・T05a・T06・T14・T34・T35 の期待値の置き換えと、追加の T48**）
- `PLAN_v3.md` §2.4（拒否理由コードの表）・§2.5（検証 7段）・§2.11（G1〜G10 と T39〜T47）
- `v3.3/PLAN_DIFF.md` §8 の E4〜E13（`admin.ts` が組む calldata の正解）
- `AGENT_PROMPTS.md` §12（アドレス・ABI・間違えやすい所10点）

**完成の定義**:
1. テストは**5ファイルに分ける**（上の「触ってよいパス」の並びどおり）。`regression.test.mjs` は**新しいモジュールを import しない**。
2. **新しいモジュールは各テストの中で `await import("../../dist/ens-attestation.js")` する。**ファイル先頭で静的 import しない（読み込み失敗でファイルごと赤になり、B1 の判定が崩れる）。
3. テスト名は `T01 ` のように **ID＋半角スペース**で始め、宣言は行頭の `test("` で書く（判定コマンドが `^test\("` で数える）。
4. ENS は viem の `PublicClient` の偽物を**2つ**注入し、**ネットワークに出ない**。期待はすべて理由コードの中身で書く。
5. 署名の検査は anvil の既知鍵で作った envelope を使う。DAG-CBOR のバイト列の正解は `@ipld/dag-cbor@9.2.6` を scratch で1回だけ走らせて作り、**16進でテストに貼る**（依存には足さない）。
6. `keys.ts init` が K_atst・W_obs・W_op・W_pay を作り、**アドレスだけ**を表示して `$DEMO/.env.tokyo.local` に追記する（秘密鍵を標準出力に出さない）。
7. `admin.ts` が7つの下位コマンドを持つ: `deploy-resolvers` / `k1a` / `k1b` / `publish-attestations` / `unlink` / `link` / `relink`。
   `--dry-run` は同じ calldata を持ち主のアドレスから `eth_call`、連続する手順は sentio の `eth_simulateV1`（`validation:false`）で通す。**`--live` は人が打つ。**
8. **`admin.ts` に `grantSetterRoles` を `initialize` の `calls` に入れる道を作らない**（配備ごと revert する）。

**判定コマンド**:
```bash
# 22:30（人が上がる前）— 最初の push が済んだこと
git -C $WT ls-remote origin refs/heads/tokyo-2026 | cut -f1        # 期待: 空でない
# 23:30（B1 の終わり）
cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/tokyo/*.test.mjs 2>&1 \
  | grep -oE '✔ [TU][0-9]+[ab]? ' | tr -d '✔ ' | sort -u | tr '\n' ' '     # 期待: "T29 T30 "（この2本だけが緑）
cat $SDK/test/tokyo/*.test.mjs $DEMO/test/*.test.mjs $MCP/test/tokyo/*.test.mjs \
  | grep -cE '^test\("(T|U)[0-9]+'                                   # 期待: 53 以上
node $DEMO/src/admin.ts --help | grep -cE '^  (deploy-resolvers|k1a|k1b|publish-attestations|unlink|link|relink)'   # 期待: 7
git -C $WT check-ignore -q examples/tokyo-2026-demo/.env.tokyo.local; echo $?    # 期待: 0
git -C $WT diff --cached --name-only | grep -c '\.env'               # 期待: 0（数字を読む。exit は 1 でよい）
```
**実装なしで緑になってよいのは T29 と T30 の2本だけ。**3本目が緑なら、そのテストは何も確かめていない。

**時間の上限**: 1h50m。23:30 に `T29 T30` が出ていなければ、テストの本数を削らずに `keys.ts`/`admin.ts` を B4a の枠（23:30–00:30）へ後ろ倒しする。

**詰まったときの切り捨て**: 切り捨て #1 が発動しているなら `$MCP/test/tokyo/` を作らない（T38 を落とす。本数の期待は 52 以上に下げる）。#2・#3 が発動しているなら T34・T35 を書かない。

**進捗も最終報告も日本語で書く。**

---

# B2 — ENSIP-29 の符号化と検証（09-26 00:30–03:30・上限 3h・枝で作業）

**目的（1行）**: `x402-offer` の証明を、草案の本文どおりに組み立て直して検証する部品を、viem を静的グラフに持ち込まずに作る。

**触ってよいパス**: `$SDK/src/ens-reasons.ts`（新規）・`$SDK/src/atst-codec.ts`（新規）・`$SDK/src/ens-attestation.ts`（新規）・`$SDK/src/index.ts`（export の追加のみ）・`$SDK/package.json`（`peerDependencies.viem ^2.55.1` を optional で・`devDependencies.viem`）・両方の lockfile（同じコミットで再生成）。

**触ってはいけないパス**: **`$SDK/src/pay-or-refuse.ts`・`x402-pay.ts`（B6・B3 の担当。金の経路）**・`$SDK/test/*.test.mjs`・`src/**`・`/rwa` 系。

**入力**:
- `PLAN_v3.md` §1.1（ENSIP-29 草案の逐語表・行番号つき）・§2.1（この3ファイルの役割と「viem を静的 import しない」理由）・§2.2（型と関数の署名）・§2.4（拒否語13）・§2.5（検証 7段＋段0・段10）・§2.8（信頼一覧の JSON）
- `v3.3/PLAN_DIFF.md` §4.7（P31・P32）・§4.8（P33・P34・P35）・§2 Q5（`findExactOwner` を使い、`findNearestOwner` は使わない理由）
- `PLAN_v3.md` 冒頭「最も怪しい前提」の食い違い表（草案 版1 `n,a,k,v,t` と参照実装 版2 `n,a,p,h,t`）

**完成の定義**:
1. `ens-reasons.ts` は**import を1つも持たない**（語の配列と型だけ）。
2. `atst-codec.ts` は **viem も他の依存も使わない純関数**。DAG-CBOR の最小エンコーダ（text・bytes・uint・5キー map・キー順 `a,k,n,t,v`）と envelope のデコーダ（tag `0xDA 61 74 73 74`・3要素）と hex/base64 の判別。
3. `ens-attestation.ts` の既定 profile は **`ensip29-draft`（envelope 版1・payload `n,a,k,v,t`）**。`atst-me-v2`（`p,h`）は `profiles: ["ensip29-draft","atst-me-v2"]` を渡したときだけ読む。
4. 段0 で**ブロックを固定**する: 両系統の chainId が 11155111・`|head₁−head₂| ≤ 3`・`now − min(timestamp) ≤ maxHeadLagSeconds`・`B = min(head₁, head₂)` を以後すべての読み取りに渡す。**同じブロックで `UH.ROOT_REGISTRY() == UR.ROOT_REGISTRY()`**（違えば `ens_evidence_unavailable`）。
5. 2系統の結果が**1バイトでも違えば `ens_evidence_unavailable`**。空の記録を「変更なし」と読まない。
6. 持ち主は `UniversalHelper.findExactOwner(dns(normalize(n)))`。`.eth` の2LD なら `ETHRegistry.getState(labelhash).status == 2 && latestOwner == a` も照合。**`findNearestOwner` を呼ばない。**
7. 語の優先: `ens_evidence_unavailable` > `ens_name_unresolved` > `ens_offer_missing` > attester ごとの語（集合で返す）> `ens_offer_malformed` > `ens_offer_mismatch`。
8. `ens-since-issuance.ts`（切り捨て #2）は**時間が余ったときだけ**。既定オフ。

**判定コマンド**:
```bash
cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/tokyo/ens-attestation-unit.test.mjs 2>&1 | grep -E '^ℹ fail'   # 期待: ℹ fail 0
node -e 'const s=require("fs").readFileSync("'$SDK'/src/ens-reasons.ts","utf8"); process.stdout.write(String(/^\s*import[ ({]/m.test(s)))'   # 期待: false
git -C $WT ls-remote origin refs/heads/tokyo-2026 | cut -f1   # = git -C $WT rev-parse HEAD（枝を push した）
```

**時間の上限**: 3h。03:30 に `ℹ fail 0` が出ていなければ、`atst-me-v2` の読み取り（U04）を後回しにして既定 profile だけ緑にする。**軸 (iii) なので落とし切らない。**

**詰まったときの切り捨て**: `ens-since-issuance.ts`（#2）→ `anchor` の固定（#3）の順で削る。**段0 のブロック固定と2系統一致は削らない**（場面3が撮るたびに変わる）。

**このブロックは金の経路ではない。**ただし `pay-or-refuse.ts` に触れた瞬間に金の経路になるので、触らない。

**進捗も最終報告も日本語で書く。**

---

# B3 — チェーン profile と D1-a の床（09-26 03:30–05:30 枝／09:00–09:30 受け入れ・上限 2h＋30 分）

**目的（1行）**: Base Sepolia で払える経路を、本番 Base の既定の挙動を1つも変えずに引数で足し、支払いチェーンの受領を数える床 `minChainReceipts` を入れる。

**触ってよいパス**: `$SDK/src/chain-profile.ts`（新規）・`$SDK/src/pay-or-refuse.ts`（profile 化と床の分だけ）・`$SDK/src/x402-pay.ts`・`skills/pay-or-refuse/SKILL.md`（新語2つの行）。

**触ってはいけないパス**: `$SDK/src/ens-attestation.ts`（B2）・段 2.5 の差し込み（B6）・`src/lib/**`（サーバ側）・`docs/openapi.yaml`・`src/lib/decision/caller-policy.ts`・`src/lib/observatory/vocabulary.ts`・`/rwa` 系。

**入力**:
- `PLAN_v3.md` §2.3 の #2・#3 の D1-a 分・#5・#7・#14・#15・#16・#17（**行番号は 0.6.0 のもの。下の「行番号の読み替え」を使う**）
- `PLAN_v3.md` §1.4（Base Sepolia・USDC・x402 の定数）・§2.7 D1-a の説明
- `AGENT_PROMPTS.md` §4（語彙の表を同じコミットで直す）
- 09-17 追記「SDK 0.7.0 が main に入った」の5点（`account`/`svm` の union・`rail`・`svmTransaction`）

> ## 行番号の読み替え（**必ず最初に読む**）
> `PLAN_v3.md` §2.3・§2.11 の行番号は **`~/vouch@61e9651`（SDK 0.6.0・1100 行台）**のもの。
> **今の `origin/main` は SDK 0.7.0 で `pay-or-refuse.ts` は 1438 行**。すべての行番号がずれている。
> 行番号ではなく**次の grep アンカー**で場所を決めること（2026-09-18 に `origin/main b4d1ae0` で実測）。
>
> | 計画の呼び名 | 今のアンカー | 09-18 の行 |
> |---|---|---|
> | `PAY_REFUSE_REASONS` | `grep -n 'export const PAY_REFUSE_REASONS'` | 163 |
> | `PayEvidencePolicy` の床 | `grep -n 'minL1Deliveries?: number'` | 225 |
> | 「免除するのは判定の中身」の規律 | `grep -n '床を1つも宣言せずに'` | 271 |
> | `EvidenceFloorCheck.floor` | `grep -n 'floor: "minL1Deliveries"'` | 288 |
> | `payee: string` と名前を解決しない規律 | `grep -n '名前解決を支払いゲートの中で起こさない'` | 628 |
> | `invalid_payee_address` の throw | `grep -n 'invalid_payee_address:'` | 634 |
> | **段 2.5 を差し込む所（`/decision` の直前）** | `grep -n -- '--- 3. /decision ---'` | 751 |
> | 宣言した証拠源を読む段 | `grep -n -- '--- 3.5'` | 820 |
> | 床を当てる段 | `grep -n -- '--- 3.6'` | 917 |
> | **402 を読んだ直後（約束との照合を入れる所）** | `grep -n -- '--- 4. 402 チャレンジ ---'` | 925 |
> | 受取人スコア | `grep -n -- "--- 3'\."` | 975 |
> | **署名直前の動的 import（再検証を入れる所）** | `grep -n 'await import("./x402-pay.js")'` | 1071 |
> | 本番へ attest | `grep -n 'if (paid.txHash)'` | 1129 |
> | `assertFiniteFloor` | `grep -n 'function assertFiniteFloor'` | 1244 |
> | `evaluateEvidencePolicy` の床の評価 | `grep -n 'const met: EvidenceFloorCheck' ` | 1291 |
> | 「0 の床は床でない」と床の配列 | `grep -n 'const floors = \[evidence' ` | 1345 |
> | `BASE_CHAIN` / `BASE_CHAIN_ID` | `grep -n 'export const BASE_CHAIN'` | 63–64 |
> | 払える accept の判定（`!== BASE_CHAIN` で落ちる） | `grep -n 'accept.network !== BASE_CHAIN'` | 478 |
> | 署名の chainId | `grep -n 'chainId: BASE_CHAIN_ID'` | 1079 |
>
> **判定の順が 0.6.0 から変わっている**（0.7.0 では 402 チャレンジが受取人スコアより前）。段 2.5 は
> `--- 3. /decision ---` の**直前**（今の 751 行の前）に置く。ここで止まれば vet402 の API を1本も叩かない。

**完成の定義**:
1. `chain-profile.ts` に `base` と `base-sepolia` の定数表（chainId・USDC アドレス・EIP-712 domain・v1 slug・`attest` の可否）。
2. `payOrRefuse` が `network?: "base" | "base-sepolia"` を受け、**既定は `"base"`**。`base` のときの挙動が1つも変わらない。
3. `minChainReceipts` を床に足し、`insufficient_chain_evidence`・`chain_evidence_unavailable` を `PAY_REFUSE_REASONS` に足す。`SKILL.md` の表に2行足す（同じコミット）。
4. `x402-pay.ts` のドメイン名・USDC・chainId・v1 slug を profile から引く。
5. **既存のテストが緑のまま**（実測 09-19: SDK 1,735 本・MCP 811 本・どちらも fail 0。「62 本／30 本」は1ファイル分の誤り）。
6. **09:00–09:30 に Takeshi が diff を読むまで main に入れない。**枝 `tokyo-2026` に push しておく。

**判定コマンド**:
```bash
cd $SDK && node --test --test-reporter=spec --test-name-pattern='^T3[123] ' test/tokyo/pay-or-refuse-ens.test.mjs 2>&1 | grep -E '^ℹ fail'   # 期待: ℹ fail 0
cd $SDK && npm test 2>&1 | grep -E '^ℹ (pass|fail)'          # 期待: fail 0・pass は 09-25 の基準以上
# 09:00–09:30 の受け入れで人が読む diff
git -C $WT diff pre-tokyo-2026 -- packages/sdk/src/x402-pay.ts packages/sdk/src/chain-profile.ts packages/sdk/src/pay-or-refuse.ts
# 承認後
(cd $WT && bash scripts/push-main.sh --full; echo "exit=$?")   # 期待: exit=0
```

**時間の上限**: 枝の作業 2h（05:30 まで）。受け入れ 30 分（09:30 まで）。09:30 に `exit=0` が出なければ、`minChainReceipts` を落として profile だけ入れる（B5a の attester は `requireVet402Allow:false` を使えなくなるので、その場で B5a の床を `minEnsAttestations` 1本に切り替える判断を報告する）。

**詰まったときの切り捨て**: `minChainReceipts`（D1-a）→ 切り捨て #9（testnet の実支払いをやめて空撃ち）の順。

**⚠ このブロックは金の経路。人が 09-26 09:00–09:30 に diff を読む。**その前に main へ push しない。

**進捗も最終報告も日本語で書く。**

---

# B4 — 売り手の面と、観測・証明のパイプライン（a: 09-25 23:30–00:30／b: 09-26 07:00–08:00・上限 各 1h）

**目的（1行）**: 約束の `resource` に入る売り手 URL を本番に出し（a）、第三者の売り手の観測ログと attester の手順を dry-run まで作る（b）。

## B4a 売り手 route（23:30–00:30・夜間に main へ入れてよい）

**触ってよいパス**: `src/app/api/tokyo/seller/route.ts`（新規）。**`src/app/api/tokyo/` は 09-18 時点で存在しない**ので衝突しない【実測】。

**触ってはいけないパス**: `src/app/api/v1/**`・`src/app/api/cron/**`・`src/lib/observatory/**`・`/rwa` 系・`packages/**`。

**入力**: `PLAN_v3.md` §1.4（Base Sepolia の x402 の形）・§2.1 の該当行（**URL は `https://vet402.com/api/tokyo/seller` に固定。後から変えると全証明が失効する**）。

**完成の定義**: 鍵なしで叩くと 402 が返り、`payment-required` ヘッダの `accepts[0]` が `network: "eip155:84532"`・`extra.name: "USDC"`・`payTo` が W_ens。**秘密鍵をこのルートに置かない。**main に入れて本番に出す。

**判定コマンド**:
```bash
curl -sL -D - -o /dev/null https://vet402.com/api/tokyo/seller | grep -i '^payment-required' | cut -d' ' -f2 | tr -d '\r' | base64 -d \
  | jq -r '.accepts[0].network, .accepts[0].extra.name'      # 期待: eip155:84532 / USDC
grep -rn 'signTypedData\|PRIVATE_KEY' $WT/src/app/api/tokyo | wc -l     # 期待: 0
```

**時間の上限**: 1h。00:30 に 402 が出なければ B2 を先に進め、B4a を 07:00 の枠へ移す（**09:30 の B5a までに本番に出ていればよい**）。

## B4b attester と観測パイプライン（07:00–08:00・dry-run まで）

**触ってよいパス**: `$DEMO/src/attester.ts`（新規）・`$DEMO/src/observe.ts`（新規）・`$DEMO/candidates.json`（新規）。

**触ってはいけないパス**: 本番の L1 購入経路（`src/app/api/cron/l1-purchase/`・`src/lib/observatory/`）・購入元ウォレット。**本番の購入を手で起こさない。**

**入力**:
- `PLAN_v3.md` §2.6（観測ログの 15 キーの表と、読む手順3つ）・§2.7（attester の手順6段）
- `v3.3/PLAN_DIFF.md` §4.9 P36（**setter は DNS 形式の名前**）・§4.10 P38（W_obs に委任する 15 キーの一覧）
- `a8/CANDIDATES.md`（**場面1の第一候補: GlobalRules `GET https://globalrules-api.onrender.com/api/v1/countries`・resource_id `b4a1c903…6be8`・購入 tx `0x2c84f0f9…cb45`・block 51428826**。次点2件も同じ形で持つ）

**完成の定義**:
1. `observe.ts` が `/decision` を**7秒間隔**で読み（10回/分の制限を守る）、`last_purchase_id` の tx を **Base 本番の公開 RPC 2系統**で `eth_getTransactionReceipt` して `status 0x1` を確かめる。**vet402 の API を信じ切らない。**
2. 書き込むキーは 15 個だけ。**`addr` と `contenthash` を置かない。**`description` に `Observation log by vet402. Not the seller's name. Do not send funds here.`
3. `last_purchase_id` が無ければ throw `observation_without_purchase`（**`observe.ts` だけの語。SDK の語彙にも SKILL.md の表にも入れない**）。
4. `attester.ts` は6段のどれか1つでも通らなければ**署名しない**（402 が約束と違う／本文に required キーが欠ける／購入後に `v` が変わった）。
5. `--check` が同じ手順で取り直し、ENS の記録と1項目ずつ比べて `match` か差分を出す（場面1の「再実行コマンド」になる）。
6. このブロックでは **`--live` を打たない**（書き込みは 09:15 と 09:45）。

**判定コマンド**:
```bash
node $DEMO/src/observe.ts --limit 3 2>&1 | grep -c 'addr: (none)'    # 期待: 3
cd $DEMO && node --test --test-reporter=spec test/observe-attester.test.mjs 2>&1 | grep -E '^ℹ fail'   # 期待: ℹ fail 0（T36・T37）
curl -sL 'https://vet402.com/api/v1/resources/b4a1c90393f123b1c02f7986312a1cc1dba2569477191ca0fbbed9d2e6756be8/decision?role=payer' | jq -r '.recommendation'   # 期待: ALLOW
```

**時間の上限**: 1h。08:00 に終わらなければ切り捨て #7（場面1を既存の購入で作り、購入日を画面に出す）を既定にして先へ進む。

**台詞の固定**: 場面1の台詞は「今日買った」ではなく **「2026-09-17 12:09 UTC に買った。いま同じコマンドで再現できる」**。当日 20:30 に `export.csv?days=1` を1回取り、その日 settled した中へ差し替えられるようにしておく。

**進捗も最終報告も日本語で書く。**

---

# K1（人が打つ・09-26 08:00–09:00・上限 1h） — AI は dry-run と census だけ

**目的（1行）**: 鍵を作り、売り手専用のリゾルバを配備し、約束と attester のアドレスと委任をチェーンに置く。

**人（Takeshi）が打つ**。AI は横で `--dry-run` の出力を読み、census で結果を判定する。**AI は `--live` を打たない。**

**順番（9 tx・合計 gas 2,329,308・09-18 に一括 simulate で通した）**:

| # | from | 宛先 | 何を | gas |
|---|---|---|---|---|
| 01 | W_vet | R_vet `0x3368…8391` | `revokeRootRoles(ALL_ROLES, 0xE96b16ab…173f)` ← **最初に打つ。「持ち主だけ」の根拠になる** | 41,137 |
| 02 | W_vet | R_vet | `multicall[setText(vet402.eth, "agent-endpoint[x402]"), setText(vet402.eth, "class"), setAddress(atst.vet402.eth, 60, K_atst)]` | 172,786 |
| 03 | W_vet | R_vet | `multicall[grantSetterRoles(setText(*, key_i, ""), W_obs) ×15]` | 918,878 |
| 04 | W_ens | VerifiableFactory | `deployProxy(impl, SALT_A=keccak("tokyo-2026/seller-a.eth"), initialize([(W_ens,ALL)], [setText×2, setAddress]))` → **P_a `0xC544…ac14`** | 448,516 |
| 05 | W_ens | ETHRegistry | `setResolver(tokenId(seller-a), P_a)` | 40,420 |
| 06 | W_ens | P_a | `grantSetterRoles(setText(dns("seller-a.eth"), "x402-offer", ""), W_op)` ← **initialize の calls に入れると revert** | 87,356 |
| 07 | W_ens | VerifiableFactory | `deployProxy(impl, SALT_BC, initialize([(W_ens,ALL)], [b の setText×2+setAddress, c の setText×2+setAddress]))` → **P_bc `0xd6A0…d2bf`** | 539,375 |
| 08 | W_ens | ETHRegistry | `setResolver(tokenId(seller-b), P_bc)` | 40,420 |
| 09 | W_ens | ETHRegistry | `setResolver(tokenId(seller-c), P_bc)` | 40,420 |

**判定コマンド（AI が打つ）**:
```bash
node $DEMO/src/run.ts census vet402.eth seller-a.eth seller-b.eth seller-c.eth
# 期待の1行: "K1 ok: root(vet402)=W_vet only, root(P_a)=root(P_bc)=W_ens only,
#             P_a.roles(keccak(x402-offer), W_op)=0x10, P_bc.roleCount(keccak(x402-offer))=0,
#             recordIds a/b/c distinct, atst.vet402.eth -> K_atst, 3 offers match on 2 RPCs"
curl -sL "https://base-sepolia.blockscout.com/api/v2/transactions/$SEED_TX" | jq -r .status   # 期待: ok
```
**`P_bc` 前提で `seller-b` の記録 ID は 1・`seller-c` は 2。**census で控えて B7 の `relink` に使う。

**詰まったとき**: 04〜09 が間に合わなければ、b/c を今の共有リゾルバに残す道（`R_shared.revokeRootRoles` + `multicall[setText ×4〜6]` の 2 tx・約 350k gas）に切り替える。**その場合、記録 ID は b=2・c=3 になり、`R_shared` に `seller-a` の箱が残る。**画面と提出文を「この鍵は W_ens のリゾルバの `x402-offer` キーだけ（3名とも）」に変えて開示する。

---

# B5 — testnet で買い、証明を置く（09-26 09:30–10:15・上限 45 分）

**目的（1行）**: attester が実際に Base Sepolia で買い、届いた中身を約束と突き合わせてから ENSIP-29 の証明を売り手の名前に置く。

**触ってよいパス**: `$DEMO/src/attester.ts`・`$DEMO/src/admin.ts`（`publish-attestations`）・`$DEMO/out/`（実行ログ）。

**触ってはいけないパス**: `packages/sdk/src/**`（B6 が枝で作業中）・本番の金の経路・`/rwa` 系。

**入力**: `PLAN_v3.md` §2.7（attester の手順6段と、どれかが通らなければ署名しないこと）・§4 の B5a・B5b 行。

## B5a 実際に買う（09:30–09:45・判定点①）

**完成の定義**: 3名分の購入 tx が Base Sepolia で `status ok`。W_ens のチャレンジ署名は3名分を1回で取る。
```bash
node $DEMO/src/attester.ts --names seller-a.eth,seller-b.eth,seller-c.eth --live-pay
for tx in $(cat $DEMO/out/attester-tx.txt); do curl -sL "https://base-sepolia.blockscout.com/api/v2/transactions/$tx" | jq -r .status; done   # 期待: ok ×3
```
**09:45 に通らなければ切り捨て #9**（実支払いをやめ、ALLOW → 署名する typed data を表示して止める形に落とす。attester の根拠は「402 と約束の一致＋届いた本文の検査」までに下げ、提出文で開示する）。

## B5b 証明を置く（09:45–10:15・軸 i・iii）

**完成の定義**: 3名とも 7段すべて `ok` で `VALID`、形式が `ensip29-draft v1`。同じ枠で attester が観測ログを W_obs で書く。
```bash
node $DEMO/src/admin.ts publish-attestations --live
node $DEMO/src/run.ts verify seller-a.eth seller-b.eth seller-c.eth
# 期待の1行: "verify ok: 3/3 VALID, 7/7 steps ok, format: ensip29-draft v1"
node $DEMO/src/observe.ts --check --resource-id b4a1c90393f123b1c02f7986312a1cc1dba2569477191ca0fbbed9d2e6756be8   # 期待: 全項目 match
```

**時間の上限**: 45 分。10:15 を過ぎたら B6 の仕上げを優先し、証明は `seller-a.eth` の1名だけにする（場面2・3 は seller-a だけで成立する。b・c は切り捨て #4・#5 の対象）。

**進捗も最終報告も日本語で書く。**

---

# B6 — ENSIP-29 を支払いの関門に差し込む（09-26 05:30–07:00 下書き／10:15–11:30 仕上げ／11:30–12:00 受け入れ・判定点②）

**目的（1行）**: 名前で払う経路を `payOrRefuse` に足し、vet402 に届かなくても ENS の証明を床として払える経路（I11）を、既存の fail-closed を崩さずに入れる。

**触ってよいパス**: `$SDK/src/pay-or-refuse.ts`・`skills/pay-or-refuse/SKILL.md`・`$SDK/test/tokyo/*.test.mjs` →（緑になったら）`git mv` で `$SDK/test/tokyo-*.test.mjs`。

**触ってはいけないパス**: `src/lib/decision/caller-policy.ts`・`docs/openapi.yaml`・`src/lib/observatory/vocabulary.ts`（**サーバ側の語彙に足すと parity テスト V2・V4・V5 が赤になる。新語はすべて SDK だけの語**）・`src/lib/observatory/x402-payer.ts`・`/rwa` 系・`packages/mcp-server/**`（切り捨て #1）。

**入力**:
- `PLAN_v3.md` §2.3 の #1・#3 の ENS 分・#4・#6・#8〜#13・#18（**B3 の「行番号の読み替え」表を必ず使う**）
- `PLAN_v3.md` §2.11（G1〜G10 の表・fail-closed の保ち方6点・語彙・テスト）
- `PLAN_v3.md` §2.9（C1〜C7 と「保護しないもの」）・§2.10（fail-closed と本番経路を壊さない条件）
- `AGENT_PROMPTS.md` §4（SKILL.md の表を同じコミットで直す・parity テストの正確な規則）

**完成の定義**:
1. 段 2.5 を **`--- 3. /decision ---` の直前**に置く。ここで止まれば **vet402 の API に fetch が1本も出ない**（T03 が数える）。
2. 402 を読んだ直後（`--- 4. 402 チャレンジ ---` の中、accept が決まった後）に `compareOfferToAccept`。**具体の語（`payee_mismatch`・`price_above_declared`・`chain_or_asset_mismatch`）を消さず、`ens_offer_mismatch` を先頭に足す。**
3. 署名直前（`await import("./x402-pay.js")` の前）に**再検証**。`offerRaw` が1回目と違えば拒否。`x402-pay.js` はまだ評価されていない。
4. G1〜G10 を入れる。**「届かない」と「答えが悪い」を分ける**: 届かない＝fetch の throw・タイムアウト・HTTP 5xx **だけ**。届いた degraded・BLOCK・4xx（401/429 を含む）は**今までどおり拒否**。
5. `:216-218` 相当の規律コメント（`grep -n '床を1つも宣言せずに'` 周辺）に1文だけ足す:
   「ただし判定を取りに行けなかったときに限り、呼び手が ENS の証明の床を宣言していれば、取りに行けなかったことを免除する。届いた判定の degraded と BLOCK は免除しない」
6. **ENS の拒否は `requireVet402Allow:false` で免除できない**（T26）。**床 0 は床ではない。**本番 Base では `network:"base"` と `payeeName` の組が `invalid_ens_chain` で throw のまま。
7. 新語 17 個（ENS 13＋`insufficient_ens_attestations`＋`vet402_unreachable`＋D1-a の2つ）が `SKILL.md` の表に**過不足なく**ある。
8. `$SDK/test/tokyo/` が空になり、テストが本線の glob に入っている。
9. **11:30–12:00 に Takeshi が diff を読むまで main に入れない。**

**判定コマンド**:
```bash
cat $SDK/test/tokyo-*.test.mjs | grep -cE '^test\("(T|U)[0-9]+'     # 期待: 49 以上
cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/*.test.mjs 2>&1 | grep -E '^ℹ fail'   # 期待: ℹ fail 0
ls $SDK/test/tokyo 2>/dev/null | grep -c test.mjs                   # 期待: 0（数字を読む。exit は 1 でよい）
# 11:30–12:00 の受け入れで人が読む diff
git -C $WT diff origin/main -- packages/sdk/src/pay-or-refuse.ts skills/pay-or-refuse/SKILL.md
# 承認後
(cd $WT && bash scripts/push-main.sh --full; echo "exit=$?")        # 期待: exit=0
```
**12:00 に緑でなければ切り捨て #1〜#5 を上から発動する。**

**時間の上限**: 下書き 1h30m（07:00 まで）・仕上げ 1h15m（11:30 まで）・受け入れ 30 分（12:00 まで）。

**詰まったときの切り捨て**: #1 MCP → #2 補助の走査 → #3 anchor → #4 つなぎ → #5 切り離し。**#8（I11 の「届かなくても払う」）は最後の手前**。落としたら場面3の 100–130 秒を「`run.ts verify seller-a.eth` → `VALID`（通信は Sepolia RPC ×2 だけ）」に置き換え、声を "The attestation still validates without vet402." にする。

**⚠ このブロックは金の経路。人が 09-26 11:30–12:00 に diff を読む。**その前に main へ push しない。

**進捗も最終報告も日本語で書く。**

---

# B7 — 場面2・3 の通し（09-26 12:00–13:30・上限 1h30m）

**目的（1行）**: 撮影の前に、ALLOW →（vet402 を止めて）ALLOW → 1文字変えて REFUSE → 切り離しで REFUSE → つなぎで REFUSE → 元に戻す、を1回通しで成立させる。

**触ってよいパス**: `$DEMO/src/run.ts`・`$DEMO/src/admin.ts`・`$DEMO/out/`。

**触ってはいけないパス**: `packages/sdk/src/**`（凍結に向かう。不具合を見つけたら**直さずに報告**し、人の diff 確認を経る）・本番の金の経路・`/rwa` 系。

**入力**: `PLAN_v3.md` §0 のデモ台本（秒つき）・§4 の B7 行・`v3.3/PLAN_DIFF.md` §4.12 P49（**`clear`/`alias` ではなく `unlink`/`link`/`relink`**）・§4.2 P03〜P05（場面3の置き換え後の台詞）。

**完成の定義（順番どおり）**:
```bash
node $DEMO/src/run.ts pay seller-a.eth --live                      # ALLOW・Base Sepolia tx が ok
node $DEMO/src/run.ts cut-vet402                                   # VET402_API_URL=http://127.0.0.1:9・curl が接続拒否
node $DEMO/src/run.ts pay seller-a.eth --live                      # ALLOW・reason_codes に vet402_unreachable
node $DEMO/src/run.ts mutate seller-a.eth --amount 10001           # W_op で P_a.setText（1 tx）
node $DEMO/src/run.ts pay seller-a.eth --live                      # REFUSE ens_attestation_signer_mismatch・vet402 API calls: 0
node $DEMO/src/run.ts reset seller-a.eth                           # 約束を戻し、再証明
node $DEMO/src/admin.ts unlink seller-b.eth --live                 # linkToRecord(dns("seller-b.eth"), 0)
node $DEMO/src/run.ts pay seller-b.eth --live                      # REFUSE ens_offer_missing
node $DEMO/src/admin.ts relink seller-b.eth --live                 # 元の記録 ID（P_bc なら 1）へ戻す
node $DEMO/src/admin.ts link seller-c.eth --to-record-of seller-b.eth --live   # linkToRecord(dns("seller-c.eth"), R_b)
node $DEMO/src/run.ts pay seller-c.eth --live                      # REFUSE ens_attestation_signer_mismatch
node $DEMO/src/admin.ts relink seller-c.eth --live                 # 元の記録 ID（P_bc なら 2）へ
node $DEMO/src/run.ts verify seller-a.eth seller-b.eth seller-c.eth # 3名 VALID（証明の置き直し無し）
```

**判定コマンド（期待の1行）**:
```bash
node $DEMO/src/run.ts scene3 --dry-run | tail -1
# 期待: "scene3 ok: allow(tx ok) -> cut -> allow(vet402_unreachable, tx ok) -> mutate -> refuse(ens_attestation_signer_mismatch, vet402 calls 0) -> unlink -> refuse(ens_offer_missing) -> link -> refuse(ens_attestation_signer_mismatch) -> relink -> 3/3 VALID"
```

**時間の上限**: 1h30m。13:30 に全部通らなければ、**軸 (ii)（止めた状態の ALLOW と、1文字での REFUSE）だけ**を確実にして撮影へ行く。切り離し・つなぎは切り捨て #5・#4。

**注意**: `relink` は census で控えた**元の記録 ID を数値で**渡す。「箱が空なら `linkToNode` は `InvalidRecord`」なので、**b を戻してから c をつなぐ**。撮り直しは `relink` 1 tx で戻せる（証明の置き直しは要らない）。

**進捗も最終報告も日本語で書く。**

---

# B8 — live demo の面（09-26 13:30–15:30・上限 2h・夜間パスなので main へ直接）

**目的（1行）**: 審査員が自分の ENSv2 Sepolia 名を入れて 7段の検証を今のチェーンで走らせられる読み取り専用の面を、`https://vet402.com/tokyo` に出す。

**触ってよいパス**: `src/app/tokyo/page.tsx`（新規）・`src/app/api/tokyo/verify/route.ts`（新規）・`src/app/sitemap.ts`（トップからの1本のリンク）。

**触ってはいけないパス**: `src/app/api/v1/**`・`src/lib/**`・`packages/**`（凍結に向かう）・`/rwa` 系。**この面に署名器と秘密鍵を1つも置かない。**

**入力**: `PLAN_v3.md` §6.5（live demo の置き方）・§0 の賞の条件 R3・§4 の B8・判定点③ 行・`v3.3/PLAN_DIFF.md` §4.15 P60（つなぎを切り捨てたときは `getRecordId` と UR の値を並べて違いを見せる）。

**完成の定義**:
1. 名前を入れる欄 →「/api/tokyo/verify」（**読み取りだけ**）→ 7段の trace を JSON で返す。
2. 観測ログの一覧（書き込み tx へのリンク・`addr` の欄が空であることが見える）。
3. 撮影した3場面の決定行と tx・CLI の1行・開示へのリンク。
4. `format: ensip29-draft`（草案の版）を必ず表示する。
5. **アドレスは viem の chain 定義と ENS から引く。値の決め打ちをしない。**
6. 名前が消えていたら正直に出す（`ens_name_unresolved` をそのまま見せる）。

**判定コマンド**:
```bash
curl -sL -o /dev/null -w '%{http_code}\n' https://vet402.com/tokyo                                  # 期待: 200
curl -sL 'https://vet402.com/api/tokyo/verify?name=seller-a.eth' | jq -r '.trace | length, .ok, .format'   # 期待: 7 / true / ensip29-draft
grep -rn 'signTypedData\|PRIVATE_KEY' $WT/src/app/tokyo $WT/src/app/api/tokyo | wc -l               # 期待: 0
```

**時間の上限**: 2h。**16:00（判定点③）に 200 と 7 が出なければ切り捨て #6**（名前の入力欄＋7段 JSON まで。ページ自体と形式の表示は残す）。

**進捗も最終報告も日本語で書く。**

---

# B9 — 撮影（a: 09-26 13:30–15:00 場面2・3／b: 16:00–16:30 場面1・まとめ・上限 各枠）

**目的（1行）**: 3場面を Takeshi の肉声と画面収録で撮る。

**これは人の手番。**AI は (1) 撮り直しのたびに `reset`／`relink` を走らせて状態を戻す (2) 各テイクの決定行と tx を `$DEMO/out/` に残す (3) 撮影が終わったら private リポへ commit。

**触ってよいパス**: `$DEMO/out/`・`~/Movies/tokyo-raw/`・private リポの `.company/departments/hackathon/tokyo-2026/`。
**触ってはいけないパス**: `packages/**`・`src/**`（20:00 の凍結に向かう。撮影中にコードを直さない）。

**入力**: `PLAN_v3.md` §0 のデモ台本（秒つき・場面ごとの画面と声）・`v3.3/PLAN_DIFF.md` §4.2（場面3の台詞の置き換え）・`a8/CANDIDATES.md`（場面1の1行台詞案）。

**完成の定義**: `~/Movies/tokyo-raw/` に場面2・3 が各1本以上、全体で4本以上。**AI 音声・スマホ撮影は使わない。**

**判定コマンド**:
```bash
ls ~/Movies/tokyo-raw/scene2*.mov ~/Movies/tokyo-raw/scene3*.mov | wc -l   # 期待: 2 以上（B9a）
ls ~/Movies/tokyo-raw/*.mov | wc -l                                        # 期待: 4 以上（B9b）
```

**時間の上限**: B9a は 1h30m・B9b は 30 分。**撮り直しは最大3テイク。4テイク目が要るなら、その場面を削る判断に回す**（Takeshi の手作業を数える。ETHOnline では5回やり直させてオーナーを消耗させた）。

**進捗も最終報告も日本語で書く。**

---

# B10 — 動画の編集と提出文の下書き（09-26 16:30–19:00・上限 2h30m）

**目的（1行）**: 2〜4 分・720p 以上の動画を書き出し、提出文の下書きを `docs/tokyo-2026/SUBMISSION.md` に置く。

**触ってよいパス**: `docs/tokyo-2026/SUBMISSION.md`・`docs/tokyo-2026/CHANGED_FILES.md`・`docs/tokyo-2026/PROMPTS/`・`AI_USAGE.md`（Tokyo の節を**足す**）・`docs/tokyo-2026/audit/`。

**触ってはいけないパス**: `packages/**`・`src/**`・`AI_USAGE.md` の ETHOnline の既存の節・`/rwa` 系。

**入力**: `PLAN_v3.md` §0（冒頭3行の英語・3軸・賞の条件との1対1対応表）・§6.1〜§6.4（提出物の骨子）・`v3.3/PLAN_DIFF.md` §4.14 P54〜P56（**`findExactOwner`・`linked records`・`grantSetterRoles` の言い換え**）・`ETHONLINE_2026_RETRO.md` §1・§2（賞の型と7つのノウハウ）・`AGENT_PROMPTS.md` §8。

**完成の定義**:
1. 冒頭3行の `[ ]` を**撮影後の一次の値**で埋める（tx ハッシュ・UTC 時刻・Sepolia のブロック番号）。
2. 賞の要件 R1〜R4 と本文の5項目に**1対1で答える**（`PLAN_v3.md` §0 の表）。
3. 「使い続ける」の締め（Continuity 枠）を入れる。**他作品との比較表を置かない。**
4. `skill: hackathon-submission` の関門2本（事実検証・審査員シミュレーション）の1回目を走らせ、出力を `docs/tokyo-2026/audit/2026-09-26-1900-*.md` に2本残す。
5. `CHANGED_FILES.md` は `git diff --name-only` の出力そのまま（`AGENT_PROMPTS.md` §5）。

**判定コマンド**:
```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 ~/Movies/tokyo.mp4          # 期待: 120〜240
ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 ~/Movies/tokyo.mp4   # 期待: 720 以上
ls $WT/docs/tokyo-2026/audit/2026-09-26-1900-*.md | wc -l                              # 期待: 2
```

**時間の上限**: 2h30m。19:00 に下書きが無ければ切り捨て #7（場面1を既存の購入で作る）を確定し、冒頭3行と賞の1対1対応だけを仕上げる。

**進捗も最終報告も日本語で書く。**

---

# B11 — 提出文の確定と凍結（09-26 19:00–20:00・判定点④・上限 1h）

**目的（1行）**: 提出文を humanizer を通して確定し、20:00 に `packages/` と `src/` を凍結する。

**触ってよいパス**: `docs/tokyo-2026/SUBMISSION.md`・`docs/tokyo-2026/DISCLOSURE_2026-09-24.md`（送信済みの控えを公開リポへ）・`docs/tokyo-2026/PROMPTS/`。

**触ってはいけないパス**: **20:00 以降は `packages/` と `src/` の全部**。

**入力**: B10 の関門2本の出力・`AGENT_PROMPTS.md` §8・`skill: humanizer-ja`（対外の日本語がある場合）。

**完成の定義**:
1. 事実検証の「未解決の主張」が 0。
2. `we` 0・em ダッシュ 0・相対時刻 0。
3. **1件指摘されたら全面を数える**（ETHOnline では `we` の指摘で2欄だけ直し、残り51か所を見ていなかった）。
4. 20:00 以降、`packages` と `src` に commit が入っていない。

**判定コマンド**:
```bash
grep -cwi 'we' $WT/docs/tokyo-2026/SUBMISSION.md      # 期待: 0（数字を読む）
grep -c '—' $WT/docs/tokyo-2026/SUBMISSION.md         # 期待: 0
# 翌朝 09-27 に打つ
git -C ~/vouch fetch origin && git -C ~/vouch log --since='2026-09-26 20:00' --oneline origin/main -- packages src | wc -l   # 期待: 0
# 件名が全部英語（macOS の grep は -P を持たないのでこの形で）
git -C $WT log --format=%s pre-tokyo-2026..origin/main -- $TOKYO_PATHS | LC_ALL=C grep -c '[^ -~]'   # 期待: 0
```

**時間の上限**: 1h。20:00 に確定しなければ切り捨て #7 を確定し、冒頭3行・賞の1対1対応・live demo のリンクだけで出す。

**09-27 に持ち込んでよいのは**、監査で見つかった事実の誤りの修正（docs のみ）と、人が diff を読んだ不具合の修正だけ。**新しい作業を持ち込まない。**

**進捗も最終報告も日本語で書く。**

---

# 09-27 の枠（B11 の後・参考）

| 時刻 | 何 | 判定コマンド |
|---|---|---|
| 20:00–06:00 | 夜間の品質監査（**コードは直さない**）。clean clone で judge-check ／ 関門2本の2回目 ／ `/tokyo` を1時間ごとに叩く ／ 結果を `docs/tokyo-2026/audit/overnight.md` に「事実の誤り」「不具合（要 diff 確認）」「そのままでよい」に分けて書く | `ls $WT/docs/tokyo-2026/audit/overnight.md` |
| 06:00–07:00 | 監査結果への対応（事実の誤りは docs を直す。不具合は diff を読むか、入れずに開示する） | `overnight.md` の「未対応」0 |
| 07:00–07:45 | 最終検査 | `rm -rf /tmp/t && git clone --depth 50 https://github.com/kzmttkc/vet402 /tmp/t && (cd /tmp/t && bash scripts/judge-check.sh; echo $?)` → `0` ／ §5.3 の3コマンド ／ `curl -sL 'https://vet402.com/api/tokyo/verify?name=seller-a.eth' \| jq -r .ok` → `true` |
| 07:45–08:30 | 提出（Takeshi） | submitted の表示（目視）・`curl -sL -o /dev/null -w '%{http_code}' https://vet402.com/tokyo` → `200` |

**監査は2回まで。3回目は審査員が触る面（live demo・動画・提出文の冒頭3行）だけ。**


---

# 追補（2026-09-19・監査 B の指摘。**本文と食い違うときはこの追補が優先**）

会期が止まる級の穴が5件見つかった。各ブロックの発注文に、次の1文を必ず含めて渡す。

1. **B6 に**: 「下書きは `tokyo-2026` から切った**別枝 `tokyo-2026-b6`** で作り、B3 が main に入った後に rebase する。`tokyo-2026` に B6 のコミットを載せない。」
   理由: `push-main.sh` は `git push origin HEAD:main` で**枝のコミットを全部**送る。同じ枝だと、B3 の 09:30 の push が、まだ人が読んでいない B6 の金の経路（段 2.5・G1〜G10）を main に載せてしまう。
2. **B1 に**: 「切り捨ての対象になるテスト（T34・T35・T38・T39〜T47）は `{ skip: !process.env.TOKYO_OPT_* }` の形で書く。切り捨ては env を落とすだけで緑になるようにする。」
   理由: 今の書き方だと、機能を落としたときテストが赤のまま残り、B6 の `fail 0` を割る。**切り捨て 9 件のうち 4 件が実際には切れない**状態だった。
3. **B0 に**: 「最初に `examples/tokyo-2026-demo/package.json`（`"type":"module"`）を作る。viem を使わず `fetch` の生 JSON-RPC で書き、相対 import は `./x.ts` と実拡張子で書く。」
   理由: `examples/tokyo-2026-demo` は origin/main に**存在しない**【実測 09-19】。B0 が最初の 40 分で1行も走らない構造だった。
4. **K1 に 2 本足す**: 「10: W_ens → W_pay へ Base Sepolia の USDC 5 と ETH 少々／11: W_pay → W_ens へ 0.01 USDC（これが `SEED_TX`。`.env.tokyo.local` に追記する）。」
   理由: K1 の 9 tx は Sepolia の ENS 操作だけで、Base Sepolia の資金と `SEED_TX` が無い。B5a が買えない。未知の tx は Blockscout が `null` を返すので**静かに落ちる**。
5. **B2 に**: 「`run.ts verify` もここで書く」／**B4b に**: 「K1 形式の census もここで書く」。
   理由: `run.ts` を触ってよいのは B0（読み取りだけ）と B7 だけで、K1 と B5b の判定が使う実装の発注が存在しなかった。
6. **B3・B6 に**: 「diff は受け入れ枠の中で読み終える。`push-main.sh --full` は承認の後に AI が枠外で走らせ、`exit=0` だけを報告する。」
   理由: 30 分の受け入れ枠に push-main が丸ごと入ると、CI 待ちだけで 6分28秒〜7分00秒【実測】。1,438 行の金の経路を人が読む時間が 10 分台になる。
7. **§10 に**: 「`examples/tokyo-2026-demo/out/` を `.gitignore` に足す。」
   理由: `push-main.sh` の preflight は `results/` 以外の untracked を fatal にする【スクリプト実測】。実行ログで push が止まる。

あわせて直す（中）:
- B8 の `src/app/sitemap.ts` は夜間パスでも請求パスでもない → 触るなら請求範囲の扱いを1行書く
- `$MCP/test/tokyo/` は `node --test 'test/*.test.mjs'` の glob の外で**一度も走らない**。B1 で本線の置き場に入れる
- テストの本数の期待値が文書ごとに違う（53/49/52/48）→ B1 の発注文の数字を正とする
- B1 のテストが参照する `../../dist/…` は、ファイルを移すと壊れる。移動するなら import の書き換えを同じコミットで
- B8 の push は 15:00 の撮影終了後に1回だけ（撮影中に本番が入れ替わらないように）
- B0 の受取人スコアの確認は**1回だけ**（本番 DB に行が増える）


## 追補2（2026-09-19・敵対監査の規約指摘）
8. **B0 の前に（09-25 19:00〜19:50・人）**: `docs/tokyo-2026/prework/` に会期前の成果物を入れて commit し、**その commit に `pre-tokyo-2026` を打つ**（タグの後に置くと会期前の設計物が請求範囲に入る）。請求フィルタは `docs/tokyo-2026/prework/` を除外する。
9. **B10（提出文）**: 請求の書き方は「挙げたパス＋それらが必要とする lockfile と設定の変更」。「完全一致」とは書かない。
10. **B9・B10（動画）**: 自動で弾かれる条件をそのまま守る —— 2〜4分の外はアップロード不可／720p 未満不可／早送り不可／音楽＋字幕だけで話さないのは不可／スマホ撮影不可／**AI 音声は不可**（本人の声で録る）。ライブ審査に進んだ場合は7分（デモ4分＋質疑3分）。
11. **B11（AI の申告）**: `AI_USAGE.md` に「人が握った行為と時刻」（鍵の操作・署名・承認・撮影・提出）を列挙し、PROMPTS に入れなかった物の存在と理由を1行書く（規約は "all spec files, prompts, and planning artifacts" を求める）。


## 追補3（2026-09-19・当日を壊す側の監査）

12. **K1 の完成の定義に足す（鍵の控え）**: K1 が終わったら `cp $DEMO/.env.tokyo.local ~/tokyo-keys-backup.env && chmod 600 ~/tokyo-keys-backup.env`（git の外・別ディレクトリ）。加えて Takeshi が K_atst・W_obs・W_op・W_pay の秘密鍵をパスワードマネージャに手で控える（**この4つを失うと、置いた証明を署名し直せない＝会期がやり直しになる**）。
13. **RPC は3本目まで書く**: `.env.tokyo.local` に `ENS_SEPOLIA_RPC_URL=https://sepolia.rpc.sentio.xyz`・`ENS_SEPOLIA_RPC_URL_2=https://rpc.sepolia.ethpandaops.io`・**`ENS_SEPOLIA_RPC_URL_3=https://0xrpc.io/sep`**（次点。publicnode は入れない）。
14. **`push-main.sh` が CI を待って 10 分以上返らないとき**は `--no-wait` で抜け、CI の結果は別に確認する（受け入れ枠を食い潰さない）。
15. **実行ログの置き場**: `push-main.sh` は `results/` 以外の untracked をすべて fatal にする【実測】。実行ログは `results/` に置くか、`.gitignore` に `examples/tokyo-2026-demo/out/` を足してから使う（会期前に足す）。
16. **B0 の触ってよいパスに追加**: `examples/tokyo-2026-demo/package.json`・`examples/tokyo-2026-demo/tsconfig.json`（追補1-3 と合わせる）。

## 最小提出（09-27 07:45 までに他が全部壊れた場合）

**これだけあれば提出は成立する**: ① 公開リポ `kzmttkc/vet402` の main が緑 ② 2〜4分の動画1本（撮り直せないときは 09-24 に撮った予備版に「会期中に◯◯が壊れた」の字幕）③ 提出文の冒頭3行と ENS の賞の要件への1対1回答 ④ 事前作業の書面開示（09-19 送信済み）。

手順:
1. `push-main.sh` が通らなければ、**GitHub の web UI から `docs/tokyo-2026/` だけを直接コミット**（CI を待たない）
2. `/tokyo` が 200 を返さないなら、**提出文から live demo のリンクを外し、動画のリンクだけにする**（落ちている面をリンクしない）
3. 動画は YouTube の限定公開に上げ、URL をダッシュボードに貼る
4. 08:30 までに submitted の表示を目視する

**落としてよい順**: live demo → 観測ログ → 場面3 → 場面2。**落としてはいけない**: リポ・動画・冒頭3行・開示。

## 会期前に用意する物（Takeshi・09-24 まで）
- スマホのテザリングを1回つないで確認（会場の Wi-Fi が使えない前提を置く）
- PD 対応のモバイルバッテリと電源タップ
- 外部マイク1本（**AI 音声とスマホ撮影は規約で不可**）と、録画用の空き容量
- ~~場面2・3 の予備録画を 09-24 までに1本~~ **取り下げ（09-19）**: 場面2・3 は ENS を支払い経路に入れたコードが要る。会期前に作るのは規約違反（"all work on your project must begin after the hackathon officially starts" の例外は Continuity の既存部分だけ）。
  代わりに **会期中の全部の成功実行を画面収録で残す**: B5a・B5b・B7 の `--live` を打つときは必ず画面収録を回し、`~/Movies/tokyo-raw/` に日時つきで保存する。撮り直しができなくなっても、この素材から動画を組める（B9a の完成の定義に入れる）

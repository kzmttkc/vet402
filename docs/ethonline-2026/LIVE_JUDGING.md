# ETHOnline 2026 — ライブ審査（Finalist Round 2）の台本・問答・逃げ道

> 作成 2026-09-07（Takeshi 採用 12:18）。**事実**: Round 1 は非同期 → **通過は Hacker Dashboard に出る**——【一次】`https://ethglobal.com/events/ethonline2026/info/details`（2026-09-10 実読）: *"Once you've submitted your project, information about your Finalist judging session will appear on your Hacker Dashboard."*・*"If you're selected for final judging, on judging day, you'll be sent to the green room and then to your official judging room"*。**メールではない**（§1 #14）。
> Round 2 は**ライブ**、**1 チーム 7 分＝デモ 4 分＋Q&A 3 分**（同ページ）。
> 日時は **09-08 に提出フォームで実測**（【一次】`WINDOW_PLAN.md` §1.4 の「【2026-09-08 09:0x 実測】提出フォームを 6 タブ埋めて保存した」の表）: **09-14 12:00 pm EDT ＝ 09-15 01:00 JST**。**`info/details` に日時は無い**（載っているのは提出締切 09-13 12:00 pm EDT だけ・09-10 実読）ので、**09-13 の提出直後に Dashboard で読み直す**（§1 #14）。
> Continuity の枠は **3 つ**（【一次】ETHGlobal Discord `#👂information`・Pascal・2026-08-17。原文は `WINDOW_PLAN.md` §1.4。`info/details` には無い）。
> 動画（`VIDEO_SCRIPT.md`）は**録画を見せる**もの。ライブは**その場でターミナルを叩く**もの。同じ絵を二度見せない——
> 動画に無いのは「**審査員が指定した 402 URL を `judge` に入れる**」（Practicality／WOW）。
> この文書の数字は **<!-- n:as_of -->2026-09-08<!-- /n --> の実測**（§6・印は `npm run check-numbers` が見る）。**動く数字は当日の朝に §7 のスクリプトで取り直す。**
> 受取人スコア・受領件数など鍵と回線が要るものだけは印に載らない——§6 の「当日取り直す」で扱う。

## 0. 先に決めたこと

- **金が動くのは、事前に決めた 1 回だけ**（§2 の 1:30、The Graph の 402 に $0.01）。**当日その場で「打つか」を決めない**。前日チェック（§1 #9）で条件が揃わなければ**打たない**と決めて臨む。審査員の URL には**絶対に** `--live` を打たない（`judge` にはそもそも `--live` が無い——`src/run.ts` が拒む）。
- **受取人スコアの値を口で固定しない。** 09-07 12:xx の実測で The Graph の受取ウォレットは **WARN (68)**——動画台本の 69 から**既に動いた**。言うときは画面の値を読む。
- **WARN を見せる前に「我々の欠損」と先に言う**（動画 §0 と同じ）。`l1_not_attempted` ＝ 署名した試行が無い／`l1_inconclusive` ＝ 1 回決済したが我々の要求が 4xx で返り、結論なし（拒否側 0x.org は 09-08 からこちら）。どちらも我々の欠損。
- **§1.5 に触れない。** 聞かれたら事実を 1 文で答えて終わる（§5）。
- 数字は印（`n:` id）か「当日取り直す」（§6）。**手で書いた数字を口にしない。**

## 1. 前日チェックリスト（09-13 提出後〜09-14 朝）

**すべて `~/vouch`（main・提出済みの先端）で行う。** `git pull --ff-only` が先（ローカル main は常に遅れている）。
Node は **≥ 22.18**（demo が `.ts` を直接走らせる）。09-07 実測 `node -v` → v26.3.0。

| # | 項目 | 確かめ方（コマンド）・合格条件 |
|---|---|---|
| 1 | リポが提出時点の main | `cd ~/vouch && git pull --ff-only && git status --short \| wc -l` → **0**。`git log -1 --format='%h %ci' pre-ethonline-2026` → `c42daca 2026-09-04 09:05:36 +0900` |
| 2 | ターミナル | **幅 100 桁 × 42 行以上**（demo の出力は 96 桁を超えない: `examples/ethonline-2026-demo/src/columns.ts` `MAX_WIDTH = 96`）。`tput cols` → ≥ 100。フォント Menlo **18pt**（画面共有で縮む前提）・暗い背景・`PS1='$ '`。`clear && printf '\e[3J'` でスクロールバックを消してから始める |
| 3 | 鍵 2 本（名前だけ確認・値を出さない） | `set -a; source ~/vouch/.env.rehearsal.local; set +a; env \| grep -cE '^(GRAPH_API_KEY\|VOUCH_API_KEY)='` → **2**。**`VOUCH_API_KEY` が入っていることが `/decision` の 429 を避ける唯一の手**（鍵なし枠は 1 分 10 本・**11 本目から 429**。§2 は 4 分で 5〜7 本叩く）。**`cat` しない・`env` を素で打たない・`history` を出さない**。ライブ用のシェルは `unset HISTFILE` |
| 4 | 鍵なしで全部緑 | **前日にやる。当日はやらない。** リポ root で `npm run judge-check` → 表の **exit が全部 0**（09-07: clean clone で 17 秒）。これが sdk/mcp-server の `dist/` も作る。ただし **`npm ci` を 4 箇所（sdk・mcp-server・root・ab）で走らせて `node_modules` を作り直す**（`scripts/judge-check.sh:67,70,74,75`）ので、当日の朝に打つと動いていた環境を壊しうる。同じ前日に `node scripts/ethonline-commits-en.mjs && node scripts/ethonline-commits-en.mjs --check --strict` → 末尾が `file fresh, 0 problem(s)`（`npm test` の `--check` は遅れを note で通すが、提出の Release 前は `--strict` で赤にする） |
| 5 | The Graph の鍵が生きている | demo dir で `node src/run.ts pay 2>&1 \| grep 'subgraph evidence is live'` → `[ok  ] … block N, M receipts`。`[FAIL] … graph_query_error: auth error` なら Subgraph Studio で鍵を作り直す |
| 6 | `/decision` の 404 が保たれている（§3.1「登録しない」） | `curl -sL -o /dev/null -w '%{http_code}\n' 'https://vet402.com/api/v1/resources/9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763/decision?role=payer'` → **404**（09-07 実測 404） |
| 7 | 逃げ道用の実出力を採る | **§7 のスクリプトを 1 回走らせ、`~/ethonline-live/<日付>/` に全コマンドの出力を置く**。当日の朝にもう 1 回（block と件数が動く）。合格条件: `ls ~/ethonline-live/$(date +%F)` が **00〜10 の 11 ファイル**で、末尾の漏洩検査が**何も印字しない**。**09-08 に初回採取済み**（`~/ethonline-live/2026-09-08/`・11 ファイル・漏洩検査 空）。**ただし 09-08 の 06 は旧版（`refuse`）で、§4 が読み上げると決めた `graph_query_error` の語を持っていない**——`judge` 版に直して 09-10 に採り直した（`~/ethonline-live/2026-09-10/06-judge-graph-down.txt`・【実測】`grep -c graph_query_error` → **1**）。前日と当日の全採取は下の直した 06 行で走る |
| 8 | MCP の live 段の準備（§2 の 2:30） | **`npm i --no-save viem` は打たない。** 09-08 実測: `packages/mcp-server` から `viem/accounts` は**リポ root の `node_modules` で解決する**（`require.resolve` → `~/vouch/node_modules/viem/_cjs/accounts/index.js`。`packages/mcp-server/node_modules/viem` は存在しない）。#4 の `npm ci` が済んでいれば足り、打つと repo が汚れるだけ。**要るのは payer 鍵が「形として在る」ことだけ**——`resolvePayer()` は `/^0x[0-9a-fA-F]{64}$/` しか見ず（`packages/mcp-server/src/index.ts:222`——宣言は `:220`）、床 10⁹ の拒否は `pay-or-refuse.ts:749` で返るので**支払いモジュールの動的 import（同 :843）へ到達しない**。だから**その場限りの鍵を env にだけ渡す**: `VOUCH_PAYER_PRIVATE_KEY=0x$(openssl rand -hex 32)`。**ファイルに書かない・印字しない・残高 0 のまま**。§7 の 08 行がこの形。合格条件: 出力の `decision_record.evidence[0].source` が `"subgraph"` |
| 9 | `--live` 1 回の可否（**ここで決める。当日は決めない**） | (a) 残高: 下のチェーン読みで **USDC ≥ 0.02**（09-07 実測 **0.99**）。(b) `DEMO_PAYER_PRIVATE_KEY` が `.env.rehearsal.local` にある（名前だけ）。**09-08 実測ではどの `.env*` にも無い**——入れるのは Takeshi。入らないまま当日を迎えたら (b) は不成立なので、**既定どおり空撃ち＋09-05 の Basescan で行く**。(c) 前日に `node src/run.ts pay` の空撃ちが `predicted --live would sign and send $0.01` を出している。**3 つ揃わなければ §2 の 1:30 は空撃ち＋09-05 の Basescan で行く** |
| 10 | ブラウザのタブを先に開く | Basescan `https://basescan.org/tx/0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad`／`https://github.com/kzmttkc/vet402/blob/main/SKILL.md`／`https://bazantic.com/recipes/x402-payee-verification-via-vet402-gateway`／`https://vet402.com/observatory`。**ダッシュボード類（Vercel・Neon・Bazantic の鍵ページ・1Password）は閉じる** |
| 11 | 画面共有の練習 | **接続テストは無い。** 招待メールも外部の会議ツールも存在しない——提出後に **Hacker Dashboard に枠と時刻が出て**、当日は **green room → judging room** へ運営が送る（【一次】`info/details` 09-10 実読）。**練習の本体は窓単位の共有**: 「ターミナルのウィンドウ」と「ブラウザのウィンドウ」だけを選んで共有し、**画面全体を共有しない**操作を 1 回やる。macOS の**集中モード ON**（通知を出さない） |
| 12 | 通し練習 | ストップウォッチで §2 を **2 回**。4:00 を超えたら 3:15 の段（A/B）を口頭だけにする |
| 13 | ネット | 有線かテザリングの**予備**を用意し、テザリングで #5 の 1 行が通ることを確かめる |
| 14 | 時刻と Dashboard | **Round 1 の通過連絡はメールではない——`Hacker Dashboard` に出る**（【一次】`info/details` 09-10 実読）。**メール待ちで構えると枠を落とす。** → **09-13 の提出直後に `https://ethglobal.com/events/ethonline2026` の Dashboard を開き、枠と時刻を実読する**（読んだ値をここに追記する）。09-08 のフォーム実測は **09-15 01:00 JST（= 09-14 12:00 pm EDT）**——カレンダーに入れ、**00:30 JST に入室**。深夜枠なので前日の睡眠を先に確保する |
| 15 | A/B v2 が走っていたら | `cd examples/ethonline-2026-ab && npm run metrics -- ../../docs/ethonline-2026/ab/<v2 のディレクトリ>` を採り、§2 の 3:15 で v1 の下に並べる。**口で言う数字は v1 のまま** |

**#9 の残高の読み方**（tx の Transfer ログから買い手アドレスを取り、USDC の `balanceOf` を引く。手でアドレスを書かない）:

```bash
TX=0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad; USDC=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
FROM=$(curl -sL -X POST https://mainnet.base.org -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$TX\"]}" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print("status",r["status"],"block",int(r["blockNumber"],16),file=sys.stderr);l=[x for x in r["logs"] if x["address"].lower()=="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" and x["topics"][0].startswith("0xddf252ad")][0];print("0x"+l["topics"][1][-40:])')
curl -sL -X POST https://mainnet.base.org -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_call\",\"params\":[{\"to\":\"$USDC\",\"data\":\"0x70a08231000000000000000000000000${FROM#0x}\"},\"latest\"]}" \
  | python3 -c 'import sys,json;print("payer USDC", int(json.load(sys.stdin)["result"],16)/1e6)'
# 09-07 実測: status 0x1 block 50898704 / payer USDC 0.99
```

## 2. 4 分の生デモ台本（英語・秒割り）

**冒頭に審査員へ 1 文**: *"If any of you has an x402 URL — anything that answers 402 — paste it in the chat and I will run it in a minute."*
シェルは #3 の鍵入り。demo dir は `cd ~/vouch/examples/ethonline-2026-demo`。各段の前に `clear`。
**言う一文は太字。** 画面の数字は読む（覚えない）。

| 秒 | 叩くもの | 期待する画面 | 言う一文（英語） | 効く基準 | 詰まったら |
|---|---|---|---|---|---|
| **0:00–0:30** | `cd ~/vouch && git log -1 --format='%h %ci' pre-ethonline-2026` → `git log pre-ethonline-2026..main --oneline -- packages/sdk packages/mcp-server examples/ethonline-2026-demo examples/ethonline-2026-ab SKILL.md AI_USAGE.md docs/ethonline-2026 \| wc -l` | `c42daca 2026-09-04 09:05:36 +0900` と、主張するコミット数（動く・画面のみ） | **"vet402 existed before this tag: a catalogue, a decision API, a payee score, an observatory that buys x402 endpoints for real. Everything after the tag is new: a payment gate that holds the signer, The Graph as an evidence source, and one MCP tool. That number is what we claim."** | Continuity 開示・Originality | git が遅ければ `cat ~/ethonline-live/<日付>/00-tag.txt` |
| **0:30–1:30** | `cd examples/ethonline-2026-demo` → **審査員の URL**: `node src/run.ts judge <URL>` → 続けて `node src/run.ts judge <URL> --min-subgraph-receipts 1`。**無ければ The Graph 自身の 402**: `node src/run.ts judge https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj --method POST --ceiling-usd 0.01`（→ 同じく `--min-subgraph-receipts 1` を足して 2 回目） | 1 回目: `[ok  ] subgraph evidence is live  block N, M receipts`／`[FAIL] payee verdict is ALLOW  WARN (nn)`／`verdict REFUSE`／`reason_codes resource_uncatalogued, payee_recommendation_not_allow`。2 回目: `verdict ALLOW`／`verdict from caller_policy`／`allowed by requireVet402Allow:false — waived payee_score WARN (nn)`／`floor met minSubgraphReceipts (subgraph) 1 <= M`／末尾 `DRY RUN — judge has no signing path` | **"Your URL. 402, then our catalogue — 404, we have never seen it; that is the normal case. Our payee engine says WARN: that is our gap, we never bought from them, not a verdict on the seller. The Graph's x402 subgraph, live — block number, deployment hash — says M receipts. Default policy: refuse. Now the caller's own rule: 'I need one receipt in The Graph's ledger, not vet402's blessing.' Allow, verdict from caller policy, WARN kept on the record. No signing path exists in this command."** | Practicality・WOW・**The Graph**（live 読み）・Usability（理由が読める） | URL が 402 でない → 1 行 `error: not an x402 endpoint: HTTP 200 …` を見せて **"that is the answer — it is not a paywall"** と言い、The Graph の URL へ。The Graph の 2 回目が要らなければ 1 回で切る |
| **1:30–2:30** | `node src/run.ts pay`（空撃ち・約 3 秒）→ **#9 が揃っていれば 1 回だけ** `node src/run.ts pay --live` → 出た `basescan https://basescan.org/tx/0x…` をブラウザで開く。**揃っていなければ** 09-05 の Basescan タブ（block 50898704・0.01 USDC → `0x79DC…FcCB`） | 空撃ち: 左「what would be signed」（amount 10000 units・payTo・EIP-3009 の窓）／`[waiv] payee verdict is ALLOW  WARN (nn) — not required by policy`／`[ok  ] evidence floor: subgraph >= 1`／`predicted --live would sign and send $0.01`／`DRY RUN — no signature was created. The signing module was never loaded.` `--live`: `payOrRefuse status=paid signed=true`／`verdict from caller_policy`／`nonce 0x…`／`txHash 0x…` | **"Same gate, pointed at The Graph. Dry run is the default: it fetches the real 402 and shows what would be signed. Nothing was signed; the signing module was not even loaded. With dash-dash-live — a human decision, and I decided it this morning, once — it pays one cent to The Graph's receiving wallet. Basescan, not our logs. The record keeps the WARN; we do not rewrite our own judgement to match the payment."** | Technicality（fail-closed）・**The Graph**（実 tx）・WOW | `--live` が `status=failed` → **隠さない**: `signed true / nonce 0x…` を指して **"it signed and the seller did not settle; we return the nonce, we do not hide it"**（E18）→ 09-05 のタブへ。Basescan が遅い → `txHash` 行を指して先へ |
| **2:30–3:15** | `cd ~/vouch/packages/mcp-server` → §7 の **MCP 行**（`pay_if_trusted`・The Graph の 402 URL・`requireVet402Allow:false`・`source:"subgraph"`・床 **10⁹**・env に**その場限りの** `VOUCH_PAYER_PRIVATE_KEY`＝`0x$(openssl rand -hex 32)`・§1 #8）を貼って Enter → 出力 1 行を `python3 -m json.tool` で開く | `"decision": "REFUSE"`／`refuse_reasons ["resource_uncatalogued","insufficient_subgraph_evidence"]`／`signed false, nonce null`／`decision_record.evidence[0]`: `source "subgraph"`・`receipts M`・`block.number N`・`deployment Qm…`・`queriedAt` | **"The same gate as one MCP tool, over stdio. Same policy object — the tool does not re-judge. I set an impossible floor, ten to the ninth receipts, so it reads The Graph live and stops: refuse, signed false, nonce null, and the evidence row says which source, which block, which deployment. The Graph key is env, never a tool input, so it never enters the model's context."** | Usability（DX）・**The Graph**（MCP 面）・Technicality | 鍵で詰まる → 鍵なしの `tools/list`（§7 の行）で 7 ツールを見せ、**"without a payer key this server cannot move money — `payer_not_configured` — by design"**（09-07 実測: 鍵なしは Graph を読む前に止まる）。出力の整形で詰まる → `tail -1` のままで `"decision"` と `"source":"subgraph"` を指す |
| **3:15–4:00** | `cd ~/vouch/examples/ethonline-2026-ab && npm run metrics -- ../../docs/ethonline-2026/ab/2026-09-06T213134Z \| head -30` → 表 A/B。次に `sed -n '/^## 4/,/^## 5/p' ../../docs/ethonline-2026/BAZANTIC_FEEDBACK.md \| head -12` | `A 10 5 50% … B 10 5 50%`／`delta (B − A): success +0`／per-fixture `F2 0/3 · F4 0/2` 両条件。§4-4: `110 tool calls, 88 settled … 88 distinct on-chain transactions of 0 USDC` | **"For Bazantic we asked: can an agent use this without our Recipe? Same model, same prompt, same fifty-seven tools; the Recipe was the only difference. Pre-registered, run once, not re-run. Five of ten and five of ten — no difference. What the Recipe fixed was vocabulary — real reason codes, sixty-three to ninety-one percent — not the verdict. And one finding for Bazantic: eighty-eight free reads cost eighty-eight on-chain transactions. Every number here is recomputed from the raw log by one script."** | **Bazantic**（Recipe だけが差・両方の結果・改善の特定）・Originality（正直） | 時間が無い → コマンドを打たず口頭だけ（数字は固定・§6）。`npm run metrics` が落ちる → `sed -n '/^## 2/,/^## 3/p' …/BAZANTIC_FEEDBACK.md` |
| **締め（4:00 の 5 秒前）** | 何も打たない | — | **"We do not let the model decide whether to pay. We call a gate, and the gate can say no before a signature exists."** | WOW | — |

**時間配分の検算**: 30＋60＋60＋45＋45＝240 秒。`judge`・`pay`・MCP は各 3〜5 秒の網の待ちがある（切れない——live の証拠）。
言う文は各段 40〜60 語（150 語/分で 16〜24 秒）で、待ちと合わせて枠に収まる。**4:00 で止められる前提**で 3:15 の段は削れる作りにしてある。

## 3. 想定質問 21 件（英語の質問 → 30 秒で言える答え → 証拠の場所）

各項: **A** ＝ そのまま言う英語、**要旨** ＝ 日本語 1 行、**証拠** ＝ ファイル:行 か URL か コマンド。

**Q1. Why not just use the score?**
A: *The score is our opinion, and it is honest about its limits: The Graph's own gateway wallet scores WARN in our engine because we never bought from it — `l1_not_attempted` names our gap. A caller should not have to trust our opinion. So the gate takes the caller's own rule — which source, what floor — and the record says whose rule decided: `verdict_source: decision | payee_score | caller_policy`. You can waive our WARN with your own floor; you can never waive a BLOCK.*
要旨: スコアは我々の意見。呼び手が証拠源と床を選び、誰の規則で決めたかが記録に残る。
証拠: `WINDOW_PLAN.md` §3.2（決定）・§3.2.1（BLOCK は外れない）／`packages/sdk/src/pay-or-refuse.ts` `verdict_source`／`SKILL.md` "Why `source` matters"。

**Q2. How do you know the subgraph data is live?**
A: *Every subgraph read is put on the decision as its own evidence row with `_meta.block.number`, `deployment` and `queriedAt`. If the answer has no `_meta.block`, the reader refuses with `graph_no_block_meta` — static or cached data cannot pass. And you do not have to take our word for which subgraph answered: add `--pin-deployment <id>` and the reader refuses with `graph_deployment_mismatch` unless `_meta.deployment` is exactly that deployment. A read that came from somewhere else is not a read. I can show you both screens in two seconds.*
要旨: 決定行に block・deployment・時刻。`_meta.block` が無ければ拒否。deployment を pin すれば違う先を読んだ瞬間に拒否。
証拠: `packages/sdk/src/subgraph-evidence.ts:207`（`graph_no_block_meta`）／変異 M22・**M43・M44**（`packages/sdk/test-mutations.mjs`。pin を壊すと赤になる）／`SKILL.md` "Paying on The Graph's own data"（`evidence[].block`）／その場で出す 2 枚（demo dir・各 1〜2 秒。`$G` は §7 の The Graph の URL、`<id>` は 1 枚目の `_meta.deployment` を読む）:

```
node src/run.ts judge "$G" --method POST --ceiling-usd 0.01 --policy subgraph --min-subgraph-receipts 1 --pin-deployment <id>
node src/run.ts judge "$G" --method POST --ceiling-usd 0.01 --policy subgraph --min-subgraph-receipts 1 --pin-deployment QmWrongDeployment000000000000000000000000000000
```

09-08 実測: 一致は `[ok  ] subgraph evidence is live   block N, M receipts`、不一致は
`[FAIL] subgraph evidence is live   not read (graph_deployment_mismatch: pinned …)` →
`[  ? ] evidence floor` → `verdict REFUSE`。**「2 回叩けば block が進む」は言わない**——09-08 に
連続 3 回とも同じ block（51041641）だった。進むかどうかは subgraph の索引の進み方次第で、
**台本が保証できない絵**である。

**Q3. What stops the agent from signing anyway?**
A: *Three layers, each tested. One: the signer is a Proxy in tests and a refusal must show zero `sign*` property accesses — not zero calls, zero accesses — with a negative control that sees exactly one on `--live`. Two: the payment module is a dynamic import inside the ALLOW branch, and a test walks the built `dist/` module graph to prove it is never statically reachable. Three: the MCP server ships without viem and without a payer key; without both it refuses with `payer_not_configured`. And yes — nothing stops an agent that never calls the gate. What we guarantee is that if it calls, the refusal happens before a signature exists.*
要旨: Proxy でプロパティ参照 0・ALLOW 枝内の動的 import を dist で検査・MCP は既定で署名できない。関門を呼ばない agent は止められない、と正直に言う。
証拠: `SKILL.md` §1（G21a/b/c）／`WINDOW_PLAN.md` §4「呼べない」の 4 層・§14.3（dist グラフ・変異で赤）／`examples/ethonline-2026-demo/test/pay.test.mjs:97,117`／09-07 実測: 鍵なし MCP → `payer_not_configured`。

**Q4. Why did the Recipe not improve success?**
A: *Two fixtures failed in both conditions, for two different reasons. F2, an uncatalogued seller: with the Recipe the model used real vocabulary but listed more codes than the oracle returns, so the pre-registered subset rule fails. F4, a price over the caller's ceiling: the right code, `price_above_ceiling`, was a word no tool ever returned — it lived only in our SDK. A Recipe cannot make a model say a word the tool does not give it. That was our design hole; we closed it by adding `caller_policy` to `/decision`, and v2 is a separate, pre-registered run — not a re-run of v1.*
要旨: F2 は subset 規則、F4 はツールが返さない語。製品側の穴。v1 は回し直さず v2 を別実験に。
証拠: `docs/ethonline-2026/BAZANTIC_FEEDBACK.md` §3／`WINDOW_PLAN.md` §16.3・§16.5／`SKILL.md` "Your own policy on `/decision`"。

**Q5. Why 88 on-chain txs for free reads?**
A: *That is the Gateway's behaviour, not ours: every route is priced at zero, yet every unpaid call answers 402, and the facilitator settles a zero-USDC transfer on chain for each one. MCP `tools/call` cannot carry a payment at all, so a standard MCP client uses none of the 57 tools. Our harness bridges that only when the quoted amount is exactly "0" — it never signs a non-zero amount. 110 tool calls, 88 settled, 88 distinct tx hashes, all in the raw log. We reported it to Bazantic as the main developer finding.*
要旨: $0 でも 402、無料読みごとに 0 USDC の tx。橋は amount "0" のときだけ署名。所見として報告済み。
証拠: `BAZANTIC_FEEDBACK.md` §4（1〜4）／`WINDOW_PLAN.md` §16.1／生ログ `docs/ethonline-2026/ab/2026-09-06T213134Z/trials.jsonl` の `raw.toolCalls[].x402Bridge.txHash`。

**Q6. What is pre-existing vs new?**
A: *Pre-existing: the catalogue, the `/decision` API, the payee score, and the observatory that has been buying x402 endpoints with its own money since July. New, after tag `c42daca`, cut 2026-09-04 00:05:36 UTC — 15 h 54 min before hacking began at 16:00 UTC, and three commits in the claimed range predate that start, listed in `DISCLOSURE_2026-09-05.md`: `payOrRefuse` in the SDK, the x402 payment path, the subgraph evidence source, the MCP tool `pay_if_trusted`, the demo CLI, the A/B harness, and the audits. `main` is also our production branch, so the tag range contains work we do not claim; the README says so and gives the exact path filter.*
要旨: 既存＝カタログ・decision・スコア・観測所。新規＝関門・支払い・Graph 証拠・MCP・demo・A/B。README が主張範囲を限定。
証拠: `README.md` "One caveat."（境界と主張範囲の節）／`docs/ethonline-2026/CHANGED_FILES.md`（コマンドで導出）／`git log pre-ethonline-2026..main -- packages/sdk packages/mcp-server examples/ethonline-2026-demo examples/ethonline-2026-ab SKILL.md AI_USAGE.md docs/ethonline-2026`。

**Q7. How much did AI write?**
A: *Most of the code, under human direction — we say that plainly. The foundation was human: a 130-file, 19,000-line initial commit by Takeshi on July 13, before any AI-assisted commit. He sets scope, overrules the AI, approves everything that spends money or leaves the company, funds the wallets, records the narration, and clicks submit. Commits carry a `Co-Authored-By: Claude` trailer where AI wrote them; the absence of a trailer means "unknown", not "human". The numbers are in `AI_USAGE.md` and re-derivable by three git commands.*
要旨: 大半は AI。土台と方向・承認・資金・声・提出は人間。trailer 無し＝不明。
証拠: `AI_USAGE.md`（"The short answer"／`git log --grep='Co-Authored-By: Claude' --oneline | wc -l`）／印 `n:no_trailer_commits`・`n:merge_commits`。

**Q8. What happens on BLOCK when the caller waives?**
A: *Nothing changes: BLOCK still refuses. `requireVet402Allow: false` waives exactly one thing — a WARN — and only when every declared floor is met. BLOCK is not our opinion, it is an operator-level global block; `degraded`, meaning we could not read, also stays a refusal. Both are pinned by tests in the SDK and through the MCP bridge, and two of the 27 mutations flip exactly that boundary and turn the suite red.*
要旨: 免除は WARN だけ。BLOCK と degraded は常に拒否。SDK と MCP の両方でテスト固定。
証拠: `WINDOW_PLAN.md` §3.2.1 の表／`packages/sdk/test-mutations.mjs` M01〜M04／`SKILL.md` "`pay_if_trusted` with The Graph evidence"（H1–H7）。

**Q9. Why is The Graph's own wallet WARN in your engine?**
A: *Because the WARN measures us, not them. The Graph's gateway is outside our catalogue, so our observatory holds no L1 record for it — no paid attempt was signed there — and our own payment ledger has zero independent payers for it. (Where we did pay and our own request came back 4xx, as with the 0x fixture in the demo, the code is `l1_inconclusive`: one settled purchase, no conclusion, our gap again.) The Graph's subgraph knows hundreds of receipts for the same wallet. That is exactly the point of the submission: our catalogue knows nothing, our engine says WARN, The Graph says hundreds — three sources, three answers, one address. The caller decides which evidence counts. We deliberately did not catalogue The Graph to make the number look better.*
要旨: 我々が買っていないという我々の欠損。3 つの情報源が違うのが製品の核。
証拠: `WINDOW_PLAN.md` §3 の表・§3.2 末尾「3 つの情報源」／`VIDEO_SCRIPT.md` §0（先に言う）／当日の `judge` 出力（`[FAIL] payee verdict is ALLOW  WARN (nn) [payee score]`）。

**Q10. How would a judge reproduce this with one key?**
A: *`git clone`, then `npm run judge-check` from the root — no key, no network beyond npm — builds and tests the SDK, the MCP server, the demo and the harness in dependency order and prints one table. For the live parts you need exactly one key, a free Graph Gateway key from Subgraph Studio: `export GRAPH_API_KEY=…`, then `node src/run.ts refuse`, `pay`, or `judge <your URL>`. `/decision` has answered key-less since September 7 at 10 per minute per IP, so a vet402 key is optional. Every block in `SKILL.md` was walked from a fresh clone.*
要旨: 鍵なしで `judge-check`。live は Graph の無料鍵 1 本。vet402 の鍵は任意。
証拠: `SKILL.md` "Prerequisites"（鍵の表）／`scripts/judge-check.sh`／`SKILL.md` "judge — bring your own 402"。

**Q11. What breaks if vet402.com is down?**
A: *You get a refusal, not an allow. The demo records `/decision` as status null when the fetch throws, the payee score cannot be read either, and the gate refuses with `evidence_unavailable` — no answer is not an ALLOW. The local money gates — ceiling, chain, asset, `payTo` match — run before any request. And the offline block in `SKILL.md` section 2 runs the whole refusal with no network at all. What breaks is availability, not safety; the audit rated availability our weakest axis, at 4 of 10.*
要旨: 落ちるのは可用性。安全側は fail-closed で拒否。監査でも可用性 4/10 と自己申告。
証拠: `examples/ethonline-2026-demo/src/assess.ts:64`（`status: null`）／`packages/sdk/src/pay-or-refuse.ts:571,577`（`evidence_unavailable`）／`SKILL.md` §2・§4／`docs/audits/2026-09-05-cia-availability-audit.md` §0。

**Q12. Mutation testing — what did it find?**
A: *It found that green tests were lying. Tests that only looked at `status` and signer calls stayed green when the whole ALLOW gate was removed — the run refused for a different reason. Switching the payment module to a static import turned no test red until we added the `dist` module-graph test. The mutation script breaks one gate at a time — BLOCK waiver, floor comparison, `payTo` check, ceiling, nonce retention, `_meta.block` — rebuilds, and requires red. Today <!-- n:sdk_mutations -->45<!-- /n --> mutations, all killed; four survived on September 6 and became tests.*
要旨: 「緑のテストが嘘」を検出。<!-- n:sdk_mutations -->45<!-- /n --> 変異全部赤。9/6 に 4 つ生き残り→テスト追加。
証拠: `WINDOW_PLAN.md` §4（A1/B5–B7 の偽の緑）・§14.3・§17（SURVIVED 4）／`packages/sdk/test-mutations.mjs`（id は **M01 から 0 埋め 2 桁の連番**——本数は印が出す。手で終端を書かない）／印 `n:sdk_mutations`。
**言うのは「all killed」まで。** 本数は印が出す——`cd packages/sdk && node test-mutations.mjs 2>&1 | tail -1` が `all N mutations killed in …`（**09-08 実走 53.8 秒・clean checkout**。09-07 の 42 本は `beac4f9` が pin の変異 2 本を足して増えた）。1 つでも生き残ると harness はこの行を印字しないので、`--refresh` が空出力で落ちる。
（`judge-check` が回すのは **A/B 側**の別の集合で **27 本**・id は `M1`・`M1b`・`M1c`・`M2`〜`M25`。`n:ab_mutations`。混ぜない）

**Q13. Security audits — what changed?**
A: *Three audits in the window, all written down with commit hashes. From September 4: a per-purchase nonce bound to the on-chain `AuthorizationUsed` event and a unique index on tx hash, so a reused hash cannot fake a settlement; the authorization window cut to 120 seconds. From September 5: a runtime kill switch read from the database before every signature, a two-tier public `settled` figure that separates nonce-bound rows from older ones, and origin-bound signature messages. For the SDK, five places where new code had reopened holes production had already closed — facilitator call, EIP-712 domain from the seller — were fixed the same day.*
要旨: nonce 束縛・一意索引・120 秒窓・キルスイッチ・settled 2 層・署名本文のオリジン。SDK は本番が塞いだ穴を 5 つ再導入していたのを同日是正。
証拠: `docs/audits/2026-09-04-adversarial-audit.md`「是正」／`docs/audits/2026-09-05-blockchain-security-audit.md` S-1 `1fddaf2`・S-4 `ae5ff67`・S-6 `4ba2274`・S-21／`WINDOW_PLAN.md` §14.2。

**Q14. What's next?**
A: *Tokyo, September 25: resolve-then-pay. Today the gate rejects a non-hex payee as a caller error — it does not resolve names. In Tokyo the payee becomes an ENS name and `payOrRefuse` runs after resolution, on a new tag and prefix so the boundary is auditable again. Before that: the second A/B run now that the caller-policy words exist on `/decision`, and npm publish of the SDK and MCP server, which we kept out of scope for the window.*
要旨: Tokyo は ENS 解決後に関門（新タグ・新接頭辞）。手前は A/B v2 と npm 公開。
証拠: `docs/ethonline-2026/APPLY.md:21`（resolve-then-pay・`pre-tokyo-2026`）／`PRIZES.md:186`（ENS は今回除外）／`WINDOW_PLAN.md` §4 B8・§16.5／`SKILL.md` "What is not built yet"。

**Q15. Why not catalogue The Graph yourself?**
A: *Because then the demo would only prove that our catalogue works, and real buyers almost never meet a catalogued seller. Keeping The Graph out forces the path that matters: `/decision` answers 404, and the gate judges from the 402's own `payTo`, the payee score for that address, and the caller's floors. That path is the I23 test set. Cataloguing it during the window would also look like staging our own numbers.*
要旨: カタログ外で判定できることが製品の核。会期中に登録すれば自作自演に見える。
証拠: `WINDOW_PLAN.md` §3.1「決定: カタログに登録しない」／`packages/sdk/test-mutations.mjs` M10（I23）／09-07 実測 `/decision` → 404。

**Q16. Why are almost all your commit messages in Japanese?**
A: *Japanese is our working language — the source comments and most commit subjects are Japanese, and we did not rewrite the log to make it look otherwise. The rule changed at 20:00 JST on September 8: new subjects are English, written down in `docs/ethonline-2026/GIT_RULES.md`, and work already in flight kept landing in Japanese for a few commits after that. The README says exactly this and gives you the command to count it yourself rather than take our word. What the criterion asks for is a history you can read, and that part is in English structure, not English prose: one commit one purpose, a fixed `ethonline:` prefix inside the window, a boundary tag `c42daca` so you can see what is pre-existing, and every edit to a pre-existing file appended to `CHANGED_FILES.md` in the same commit. The English route through the work is `SKILL.md`, `AI_USAGE.md` and `CHANGED_FILES.md`, and seven source files carry an English header above the Japanese one.*
要旨: 日本語は作業言語。09-08 20:00 JST から英語へ。**書き換えない**。基準が問うている「読める履歴」は 1 コミット 1 目的・接頭辞・境界タグ・`CHANGED_FILES.md` で答える。英語の道は SKILL / AI_USAGE / CHANGED_FILES。
証拠: `README.md:22`（規則であって既成事実ではない、と書いてある）／`docs/ethonline-2026/GIT_RULES.md` 1〜5／審査基準 *"Proper use of git commit history"*（`WINDOW_PLAN.md` 09-08 実測の提出フォーム表）。
**数は口で言わない。聞かれたら画面で数える**: `git log --no-merges pre-ethonline-2026..main --format='%s'`（09-08 実測: 会期分 292 件・全史 788 件。印が無いので**この値を暗記して言わない**）。

**Q17. Your own `/status` page shows errors on September 7 and 8. What are they?**
A: *Two answers, because the page was wrong about itself as well.*

*First the page. A day there is marked by its worst sample, so one bad five minutes colours the whole row, and a quiet day carries fewer samples. It also said the samples came from real traffic rather than a fixed-interval monitor. That was false: our own production check calls `/api/health` on the hour and the half hour. It matters in the direction that costs us. The probes memoise for a minute, with the engine's five minutes underneath, so a caller arriving every few seconds mostly reads back a cached verdict; the half-hourly one is the only caller certain to force a real measurement, which makes it over-represented among the rows that are not ok. The bad days you are looking at are partly an artifact of who is polling. We corrected the page on September 9 to say that, rather than dropping the sentence.*

*Now the errors. On September 8 we shipped the instrument before the fix, because the table stored a status and nothing else, and we wrote here that the next 503 would arrive carrying its reason and settle it. The row came, early on September 9. It did not settle it.*

*What it did do is name the input that failed: the seller-side feedback window, which is fail-closed, so losing it makes every verdict more cautious rather than wrong. What it could not do is name the path. Reading the code afterwards, at least five paths raise that one signal — an outer 3,500ms budget, an inner 2,500ms budget on the tail scan, and three separate branches that were all throwing the identical string — and the row is consistent with any of them. The latency, 3,853ms, sits just above the outer budget, which is suggestive; it is equally consistent with the inner budget expiring after a slower identity read. A suggestion is not an attribution.*

*So the second thing we shipped was not a fix either. It was a finer instrument: every degraded signal now carries the path that raised it, one low-cardinality word beside the flag, with a deadline separated from a coverage failure and the two coverage failures separated from each other. A flag that arrives without a reason is written as having none, so "no reason" and "did not look" stop sharing a face. The public body is still one word.*

*Two things I will not say. The reasoned row from the day before was a different input, on the buyer side — so this is more than one cause, not one. And not a single one of September 8's error rows carries a reason at all: the reason column went live after the last of them, so nothing we learn now can be applied backwards to those. We did not delete the rows. A status page that erases its bad days is not a measurement, and this is the production observatory — not the SDK you are judging, but the same rule applied to ourselves.*

*Later on September 9 the finer instrument spoke once. Three degraded rows between 08:20 and 08:36 JST carried `wallet_metrics_unavailable(deadline:wallet_metrics)`: a buyer-side wallet read that overran its 3,500 ms budget, with the health row taking between 3.7 and 6.4 seconds. That is a different input from the day before, and it points at a slow upstream RPC, not at the engine. It explains those three rows. It does not explain the rows that came before it, and I will not stretch it to.*

*On September 10 the same instrument settled the other one. Eleven degraded rows arrived between 02:59 and 04:00 JST, and all eleven read `feedback_stats_unavailable(deadline:getLogsChunked)` beside a healthy payee leg — the inner 2,500 ms budget on the tail scan, not the outer 3,500 ms one I had leaned toward. The health rows took between 1.9 and 2.8 seconds. Read across seven days, the degraded rows cluster by hour of the day rather than by deploy: four UTC hours hold nearly all of them. That is the shape of a slow upstream, and it is as far as I will go. I have not read the production RPC setting, so I am naming a path, not a cause.*

*The blast radius is worth stating as a boundary rather than as a reassurance. That flag is raised in exactly one place, the agent scoring engine, and from there it reaches the agent page, the badge, the passport and the batch score, where it costs fifteen points and turns the risk word to high. The two faces the gate actually calls stand on a different leg: the decision route builds its verdict out of database-derived seller and buyer facts, and the payee score never reads the feedback window at all. So `judge` and `pay` answer the same while that row is red — not because a policy waives it, since a degraded verdict is never waived, but because they are not reading it. The slow upstream behind it is a post-window item we have already written down. During the window we do not touch it.*

要旨: 頁そのものの誤りを先に認める（**「実トラフィック標本・定間隔監視ではない」は嘘**——自前の 30 分監視が叩いており、しかも**それが赤に偏る**側の事実。09-09 に頁を訂正）。503 本体は、**「次の行が決着させる」と書いた行が 09-09 に来て、その行では決着しなかった**（決着したのは翌 09-10・末尾）。落ちた入力に名前は付いた（売り手側のフィードバック窓・fail-closed）が、その信号を立てる経路が **5 つ**あり行はどれとも読める。3,853ms は外側 3,500ms のすぐ上だが**示唆であって証明ではない**（内側 2,500ms でも同じ数字になりうる）。だから**計器をもう一段細かくした**。前日の理由つき行は**買い手側の別の入力**——原因は 1 つではない。**09-08 の error 行には理由が 1 件も無い。遡って当てはめない**。**行は消さない**。**09-09 08:20–08:36 JST に経路名つきの degraded 3 行が入った（`wallet_metrics_unavailable(deadline:wallet_metrics)`・買い手側ウォレット指標・上流 RPC の遅延）——言えるのはその 3 行の帰属まで**。 **09-10 02:59–04:00 JST の degraded 11 行が `feedback_stats_unavailable(deadline:getLogsChunked)`（tail 走査の内側 2,500ms）で入り、`feedback_stats` 側の経路は決着した**（`latency_ms` 1,899–2,821・11 行とも `payee=ok`）。**影響はエージェントスコア面だけ**（`/agent/<id>`・badge・passport・batch score で risk="high"・score −15）。**SDK が叩く判定 2 面（`/resources/{id}/decision`・`/payees/{addr}/score`）は DB 由来の別の脚を読むので無傷**。原因側（上流の遅さ）は会期後に直すと決めてある。
証拠: `https://vet402.com/status` §3 の定義（ok / degraded / error・worst sample・"A missing observation is never reported as ok."）／`8e165cc`「503 の理由を health_snapshots に残す」・`c7ec6f6`「応答後に走る 2 つの処理を `after()` に載せる」・09-09 の 2 コミット（経路の書き分け／`/status` の文言訂正）／`tests/health-degradation-reason.test.ts` 冒頭（09-09 01:30 JST の本番 4 行と、経路 5 つの内訳）／`tests/health-after-response.test.ts` 冒頭（本番 `withDeadline` の**成功側**から 59,957ms・期限 24,000ms・SIGSTOP での再現 56,012ms）／09-10 の経路と影響範囲は下の #7（`src/lib/chain/erc8004.ts:222`・`src/lib/scoring/engine.ts:327`・`src/lib/scoring/verdict.ts:75`・`src/lib/scoring/helpers.ts:364`・`src/lib/decision/decide.ts:266`・`src/lib/decision/rules.ts`）。
**画面の値を読む**（当日の集計は動く。**`/status` は UTC 日で束ねるので、JST の日で数えた件数とは一致しない**——数を言うなら画面のまま読む）。

**何が証明済みで、何が未証明か**（ここを超えて言わない）:

| 言ってよい | 根拠 |
|---|---|
| 凍結という**機構**は実在する | 期限 24,000ms の `withDeadline` の**成功側**から 59,957ms が返った。発火していれば例外側へ落ちるので、**timer が進んでいない** |
| 手元で同型を再現した | SIGSTOP で凍結 → `{"branch":"success","latencyMs":56012}` |
| 直した | `c7ec6f6`。応答後の 2 つを `after()` の生存期間に載せた（リポ全体で `waitUntil` / `after()` は未使用だった） |
| 落ちた入力に名前が付いた | 09-09 01:30:38 JST の degraded 行が `scoring=degraded fresh: feedback_stats_unavailable` を持って入った（`payee=ok cached`。1 分後に cached で再掲、約 2 分後に ok へ復帰＝`PROBE_TTL_MS=60_000` と一致） |
| **経路名つきの行が来た**（09-09 08:20–08:36 JST） | 本番 `health_snapshots` の degraded 3 行（08:20:40 / 08:34:42 / 08:36:38 JST・`latency_ms` 4,460 / 6,446 / 3,742）が `scoring=degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok` を持って入った。落ちた入力は**買い手側のウォレット指標**、経路は `src/lib/scoring/engine.ts` の `withDeadline(fetchWalletMetrics, SIGNAL_BUDGET_MS = 3,500ms, "wallet_metrics")`＝上流 RPC 読みの遅延。前日の `feedback_stats` とは**別の入力** |
| **`feedback_stats` 側が決着した**（09-10 02:59–04:00 JST） | 本番 `health_snapshots` の degraded **11 行**（`latency_ms` 1,899–2,821・11 行とも `payee=ok`・fresh と cached の両方）が全て `feedback_stats_unavailable(deadline:getLogsChunked)` を持って入った。経路は `src/lib/chain/erc8004.ts:222` の `TAIL_SCAN_DEADLINE_MS = 2_500`＝tail 走査の**内側**予算（上流メッセージの形は同 `:363` の `deadline_exceeded:getLogsChunked:2500ms`）。09-09 に「5 つのどれとも読める」と書いた信号の経路が、名指しで入った |
| **影響範囲が閉じている** | `feedback_stats_unavailable` を立てるのは `src/lib/scoring/engine.ts:327` の 1 箇所だけ。届く先は**エージェントスコア面だけ**（`verdict.ts:75` risk="high"・`helpers.ts:364` −15）。SDK が叩く判定 2 面は到達 **0 件**（#7 の実測） |
| **言ってはいけない** | それが当日の 503 全件の原因だったこと。下の 5 つが反証側にある |
| **言ってはいけない** | 「**公開 RPC が原因**」と断定すること。`getIndexerPublicClient()` は `INDEXER_RPC_URL` → `BASE_RPC_URL` → 公開 `https://mainnet.base.org` の順に選ぶ（`src/lib/chain/client.ts:95-105`）が、**本番の実値は【未確認】**（Vercel の値はローカルではマスクされる）。言えるのは「**時刻分布が米国の業務時間帯と重なる**」まで |
| **言ってはいけない** | **すべての劣化がこの経路**であること。`wallet_metrics`（09-09・買い手側ウォレット指標）と `usdc_drain`（09-09・受取人プローブの USDC 流出脚）は**別の脚**で、いまも別のまま |
| **言ってはいけない** | 「**caller policy が degraded を免除する**から決済関門は無傷」。**免除は WARN だけ**で `BLOCK` と `degraded` は免除されない（`examples/ethonline-2026-demo/README.md:65-66`・`packages/sdk/src/verdict-shape.ts:64`）。無傷の理由は**判定 2 面が DB 由来の別の脚を読んでいるから** |
| **言ってはいけない** | 09-09 の `wallet_metrics` 3 行が**すべての劣化**の原因であること。同日 01:30 / 01:42 は `feedback_stats_unavailable`（経路未特定のまま）、04:01–04:02 は `payee=degraded cached: usdc_drain`（別の脚）——少なくとも 3 種の入力が別々に落ちている |
| **言ってはいけない** | 09-09 の行が「原因を突き止めた」ものであること。**信号を立てる経路が 5 つあり、行はどれかを区別できなかった** |

**切り分けの実測**（09-08 22:5x・本番 DB 直読みとローカルログ）:

1. 最後の error 行は **18:25:52 JST**。`8e165cc` のコミットは 18:37、`detail` が入った最初の行は 18:51:07、`c7ec6f6` は 20:01。**止まったのはどちらのデプロイよりも前**
2. したがって `detail` / `latency_ms` / `instance` を持つ **error 行は 0 件**（入っているのは ok と degraded 1 件だけ）——**理由を残せるようにした計器は、まだ 1 件も 503 を捕らえていない**
3. 30 分間隔の自前監視（`~/Projects/agent-trust/logs/uptime-cron.log`・全件 `FAIL: health http 503`）の最後の FAIL は **16:30 JST**、以後 17:00 から連続 OK。**18:25 の 503 はどの cron の時刻でもない**し、11:30 の cron が OK の直後（11:32）にも error 行がある——旧版にあった「**30 分 cron のみ**」は外れているので削った
4. episodic だった（JST 02 時台・15 時台は error 0）。単調な改善ではない。加えて同じ時間帯にこちらの測定トラフィックが増えていた——ただし **`health_snapshots` は 5 分の間引きがあるので流量を測れない**（本数は残っていない。**【未確認】**の交絡）
5. **09-09 追記。** 理由つきの行は degraded で出た（error ではない）。落ちた入力は `feedback_stats_unavailable` 1 つ。ところがこの信号は
   `engine.ts` の `!feedbackResult.ok` 1 箇所から立ち、そこへ届く rejection の出所は **5 つ**ある——
   外側 `withDeadline(..., "feedback_stats", 3,500ms)` ／ tail 走査の内側 2,500ms ／ `erc8004.ts` の 3 分岐
   （index 不在・窓を覆えない・tip から遠すぎ）。**3 分岐は同じ文字列を投げていた**ので、error の message を運んでも分けられなかった。
   実測 3,853 / 3,721ms は外側予算のすぐ上だが、内側 2,500ms ＋ 遅い identity 読みでも同じ数字になる。**【推定】のまま置く**
6. **09-09 14:5x 追記（本番 DB 直読み・読み取りだけ）。** 経路名つきの最初の行は 08:20:40 JST。同日の非 ok 行は次の 10 行で、`wallet_metrics` の 3 行だけが経路を名乗っている:
   `01:30:38 / 01:42:38 degraded fresh: feedback_stats_unavailable`（＋各 1 分後の cached 再掲）／`04:01:34–04:02:34 payee=degraded cached: usdc_drain`（3 行・`latency_ms` 0 / 156 / 192）／
   `08:20:40 (4,460ms) / 08:34:42 (6,446ms) / 08:36:38 (3,742ms) degraded fresh: wallet_metrics_unavailable(deadline:wallet_metrics); payee=ok`。
   `deadline:wallet_metrics` は `engine.ts` の `withDeadline(fetchWalletMetrics, SIGNAL_BUDGET_MS = 3_500, "wallet_metrics")` の期限。**この 3 行の帰属は【実測】**。それ以外の行には当てはめない。error 行（503）は 09-09 も 0 件
7. **09-10 04:4x 追記（本番 `health_snapshots` 直読み・読み取りだけ）。** 09-10 02:59–04:00 JST（＝17:59–19:00 UTC）の degraded は **11 行**、全て `scoring=degraded` の fresh / cached いずれかで `feedback_stats_unavailable(deadline:getLogsChunked); payee=ok`、health 行の `latency_ms` は **1,899–2,821**。経路は `src/lib/chain/erc8004.ts:222` の `TAIL_SCAN_DEADLINE_MS = 2_500`。
   **過去 7 日の UTC 時刻別分布**（全 degraded）: `utc16 deg=7 ok=36` ／ `utc18 deg=11 ok=37` ／ `utc19 deg=7 ok=47` ／ `utc23 deg=5 ok=41`——残る 20 時間帯は `deg=0〜3`。**時刻で偏り、デプロイでは偏らない**ので上流の遅さを指すが、`getIndexerPublicClient()`（`src/lib/chain/client.ts:95-105`）が実際に選んでいる **RPC の本番値は【未確認】**。ここから先は言わない。
   **影響範囲【実測】**: `feedback_stats_unavailable` を立てるのは `src/lib/scoring/engine.ts:327` の 1 箇所で、その呼び出し元は `/agent/[agentId]`・`api/badge/agent/[agentId]`・`api/v1/agents/[agentId]/{score,passport}`・`api/v1/wallets/[address]/score`・`api/v1/scores/batch`・`api/demo/score`・`api/dashboard/lookup`＝**エージェントスコア面だけ**（`src/lib/scoring/verdict.ts:75` で risk="high"、`src/lib/scoring/helpers.ts:364` で −15）。
   **決済関門の 2 面は無傷【実測】**: SDK が叩く `/resources/{id}/decision`（`packages/sdk/src/pay-or-refuse.ts:613`）と `/payees/{addr}/score`（同 `:795`）の 2 ルートから静的・動的に到達する **81 ファイル**を辿って、`scoring/engine.ts`・`chain/erc8004.ts`・`chain/feedback-window.ts` は **1 つも無い**。`src/lib/decision/decide.ts` は DB 由来の seller-facts / buyer-facts から verdict を組み、`:266` で動的に読む `payee-engine` の score は**併記のみ**（`src/lib/decision/rules.ts` は `score` を 1 度も参照しない。取れなくても `score = null` で判定は落ちない）。**demo の `pay` / `judge` の verdict はこの劣化で変わらない**

**決着した**（審査員にはこれを言う）: 09-09 に「**次の非 ok 行は経路まで名乗って入る**」と書いた。09-09 08:20 JST に最初の 1 行（`wallet_metrics`・上の表と #6）、翌 09-10 02:59–04:00 JST に 11 行（#7）が入り、**`feedback_stats` 側の経路は `deadline:getLogsChunked`＝tail 走査の内側 2,500ms で名指しされた**。残る未特定は 09-08 の error 行（理由列より前なので**遡って当てはめない**）と `usdc_drain` の脚。
`detail` は `feedback_stats_unavailable(deadline:feedback_stats)` のように flag のとなりに経路を持つ:
`deadline:feedback_stats`（外側 3,500ms）／`deadline:getLogsChunked`（内側 2,500ms）／`index_absent`・`window_not_covered`・`index_behind_tip`（カバレッジ）／
`upstream_error:<クラス名>`（それ以外）／`unrecorded`（flag だけ残りその回は経路が走っていない＝エンジンのキャッシュ当たり）。
error 行なら従来どおり `latency_ms` が期限（24,000ms）を大きく超えた**成功側**かどうかで凍結を見る。前日に引くのは 1 本:
`SELECT checked_at, status, latency_ms, detail, instance FROM health_snapshots WHERE status <> 'ok' ORDER BY checked_at DESC LIMIT 5;`
聞かれたら *"We said the next bad row would name the path, and it did: eleven rows on September 10 all carried `deadline:getLogsChunked`, the inner 2,500-millisecond budget on the tail scan. Failing closed there is the design rather than the bug — it moves only the agent-score surface, since the gate's two faces read a different leg — and the slow upstream behind it is a post-window fix we have already written down."*

**Q18. Are the numbers in the video still the same today?**
A: *No, and they should not be. The video is a recording — its numbers are the record of the day it was shot. The Graph's subgraph counted four hundred and twenty-seven receipts for that wallet then; it counts more now, and the payee score moves too. That is exactly why every evidence row carries `_meta.block.number`, `deployment` and `queriedAt`: you can tell when a number was read, and whether it was read at all. Anything I say live, I read off the screen in front of you.*
要旨: 動画は撮影日の記録。件数もスコアも動く。**だから**決定行に block・deployment・時刻がある。生で言う数字は画面から読む。
証拠: §0「受取人スコアの値を口で固定しない」／§6「当日取り直す」（09-07 12:xx **427**）／09-08 22:0x 実測では**同じ問いに違う値**が返った（画面で読む）。§7 の 01/02/08 に当日の値が採ってある。

**Q19. Your Bazantic numbers from September 6 and September 9 disagree. Which is right?**
A: *Both, on their dates — the Gateway changed, our harness did not. On September 6 every unpaid call to a zero-price tool got a 402, and reading a free tool cost a settlement: eighty-eight free reads, eighty-eight zero-USDC transactions on chain. On September 9 we measured the same Gateway again, and the zero-price tools now return their body on an unpaid MCP call — no 402, no settlement, and our bridge is never entered. We kept both sets of numbers with their dates. We do not claim to know why it changed.*
要旨: 変わったのは Gateway 側。09-06 の数字（110 calls・88 settled・88 本の 0-USDC tx）は日付つきで残し、09-09 08:30–08:40 JST の再計測を併記。**因果は主張しない**。
証拠: `BAZANTIC_FEEDBACK.md` §4 #1 / #3 / #4（"Re-measured 2026-09-09 08:30–08:40 JST" の文）・§5 1 行目／`examples/ethonline-2026-ab/README.md`（EN+JA の 1 行）／`7b5c58d`。

**Q20. Bazantic mentioned a JWT that bypasses x402. What is it, and did you use it?**
A: *We did not use it, and we read it as an owner-side setting. `@bazantic/cli` has `--auth-type api-key | jwt | x402-mpp | basic`, default `x402-mpp`: that is how the gateway owner authenticates to their own upstream, not a header a buyer sends. Tom Hay answered on September 9 that a JWT made on the Bazantic API-keys page can stand in as an API key to skip the 402 for testing. Sent as a buyer-side header it made no difference in our re-measurement, which fits that reading. Our gateway stays on the default, so what the judges call is the paid path.*
要旨: ゲートウェイ所有者側の上流認証設定と読む。買い手ヘッダ（`Authorization: Bearer` / `x-api-key`）として送っても 09-09 の再計測で差なし。当社の gateway は既定 `x402-mpp` のまま。
証拠: `BAZANTIC_FEEDBACK.md` §4 #5（Tom Hay の 09-09 Discord 回答と CLI の読み）／`WINDOW_PLAN.md` §1.4「Bazantic：Tom Hay 本人の発言 3 件」／Discord `#partner-bazantic`。

**Q21. Why build the MCP server at all? Wasn't the SDK enough to qualify?**
A: *Eligibility was never the reason. On September 7 we asked ETHGlobal directly whether judging weighs the Graph evidence being reachable from the MCP/agent surface, or whether the SDK path alone counts as AI tooling. On September 10, 18:46, they answered: "Good question. You'll be eligible even if consuming only the x402 Base subgraph." So the SDK alone would have qualified. We kept the MCP server, the Agent Skill, the plugin and the devcontainer because the prize asks for AI tooling that makes The Graph easier to use — that is the bar, not the eligibility floor. An agent inside Claude or Cursor calls one tool and gets back a decision pinned to a block and a deployment. Qualifying and being useful are different things, and we spent the days on the second.*
要旨: 資格は SDK だけで足りると運営が **2026-09-10 18:46** に回答した（原文: *"Good question. You'll be eligible even if consuming only the x402 Base subgraph"*・我々の質問は 09-07 06:17）。MCP・Agent Skill・プラグイン・devcontainer は**資格のためではなく**、賞ページが挙げる「The Graph を使いやすくする AI ツール」の形に合わせたもの。**運営の回答を手柄にしない**——言うのは「資格の下限は低かった。我々はその上を作った」まで。
証拠: `PRIZES.md` §1.1（質問と回答の原文・チャネルは `#partner-the-graph` の公開スレッド "Quick eligibility question for the AI"）／`WINDOW_PLAN.md`「The Graph（Continuity）の資格要件」表（賞ページ側の要件は 1 行も動いていない）／`SKILL.md` ブロック 11・12（MCP から The Graph を読んで払う／拒む）／`.claude-plugin/plugin.json`・`.devcontainer/devcontainer.json`。

**予備（時間があれば聞かれる）**
- *"Is the settlement verified?"* → *"The SDK says at most `settle_claimed` — the seller's header is a claim. Only a verifier that re-reads the chain says `settled`; that is the production observatory's word, not the SDK's."*（`WINDOW_PLAN.md` §15 語彙・`SKILL.md` "Reading the answer"）
- *"Why 120 seconds?"* → *"An EIP-3009 authorization stays live until `validBefore`; a short window bounds what a failed settle can do later. Production cut it on September 4 after an audit; the SDK matches."*（§14.1 #3）

## 4. 逃げ道

| 断 | 何が起きるか | やること | 言うこと |
|---|---|---|---|
| **ネット断**（全部） | `judge`/`pay` が `graph_unreachable` や `/decision` null で止まる | `cat ~/ethonline-live/<今朝>/<段の番号>-*.txt` を §2 の順に読む（§7 が採る 11 本: `00-tag` `01/02-judge` `03-judge-kronos` `04-refuse` `05-pay-dryrun` `06-judge-graph-down` `07-mcp-tools-list` `08-mcp-pay-if-trusted` `09-ab-metrics` `10-check-numbers`。**09-08 の初回採取だけは 06 が旧版の `06-refuse-graph-down` で、この行が読み上げる `graph_query_error` を持っていない**——`judge` 版は 09-10 に採り直し済み・§1 #7）。ファイル先頭の `date -u` 行を先に見せる | *"The network dropped. This is this morning's output at HH:MM UTC; the block number on it is the timestamp you can check on The Graph."* |
| **vet402.com 断** | `/decision` が読めない → `evidence_unavailable`。`pay` の空撃ちは**ローカル関門**（ceiling・chain/asset・payTo 一致・EIP-712 固定）までは緑で出る | そのまま見せる（**それ自体が fail-closed のデモ**）。次に `SKILL.md` §2 のオフラインブロック（fetch を差し替えた `payIfTrusted` → REFUSE・`nonce null`）を貼る | *"Our own API is down, and the gate refuses — no answer is not an ALLOW. The local money gates still ran. Here is the same refusal fully offline."* |
| **The Graph 断**（Gateway 5xx／鍵失効） | `[FAIL] subgraph evidence is live  not read (graph_http_5xx / graph_query_error: …)` → `evidence_unavailable, subgraph_evidence_unavailable` → REFUSE | そのまま見せる。**復旧を待たない**。同じ絵は `GRAPH_API_KEY=not_a_real_key node src/run.ts judge "$G" --method POST --ceiling-usd 0.01` でいつでも再現できる（09-08 実測: 関門行 `[FAIL] subgraph evidence is live   not read (graph_query_error: auth error: malformed API key)` → `reason_codes  resource_uncatalogued, evidence_unavailable, subgraph_evidence_unavailable`）。**`refuse` では再現しない**——2 列の画に出るのは `—  subgraph not read` と `reasons … evidence_unavailable, subgraph_evidence_unavailable` だけで、`graph_query_error` の語は**どこにも出ない**（09-08 実測） | *"The Graph could not be read, and the gate refuses with the reason on the record — it never falls back to our own ledger. This failure mode is a test, not an accident."* |
| **画面共有断** | 審査員に画面が見えない | 動画の秒を口で指す: 0:12 三つの情報源／0:36 `refuse`（block・deployment・`signed false`）／1:12 空撃ち／1:36 Basescan／1:54 テストと変異／2:12 A/B／2:41 MCP。可能なら §7 の出力ファイルをチャットに貼る | *"I lost screen share. In the video you have: at 0:36 the two-column refusal with the block number; at 1:36 the transaction; at 2:12 the A/B table. I will paste the terminal output in chat."* |
| **審査員の URL が 402 でない** | 1 行 `error: not an x402 endpoint: HTTP 200 …` | The Graph の URL へ（§2 の 0:30） | *"That is the honest answer: it is not a paywall. Let me use The Graph's own."* |
| **`--live` が失敗**（`status=failed`） | 署名はしたが売り手が settle しなかった | `signed true / nonce 0x…` を指して隠さない → 09-05 の Basescan タブ | *"It signed and the seller did not settle; we return the nonce instead of hiding it. Here is the one from September 5."* |
| **`/decision` の 429**（鍵なし枠 10/分・**11 本目から**） | `judge` / `pay` の画には**出る**（09-08 実測・`cd246d9` 以降）: ヘッダ右に `/decision   HTTP 429`、関門に `[FAIL] /decision was readable   HTTP 429 — a verdict we could not read is not a verdict`、空撃ちの `predicted --live would REFUSE before signing. Failing gate: "/decision was readable" → HTTP 429 …`。**`refuse` の 2 列の画だけは `recommendation —` のままで 429 と分からない**（`src/refuse.ts:119`）——§2 は `refuse` を使わないので当日は関係ない | 前日に §1 #3 で `VOUCH_API_KEY` を入れてある＝**枠に当たらない**。当たったら画の `HTTP 429` を指す。**policy を緩めない・打ち直さない**（§4.5） | *"That is a rate limit on our own API, not a verdict. The gate names it on the record — a verdict we could not read is not a verdict — and refuses. It is the same fail-closed path as the outage case, and it is our availability, not the seller's."* |
| **MCP の viem／鍵で詰まる** | `payer_not_configured`（Graph を読む前に止まる・09-07 実測） | 鍵なし `tools/list`（§7）→ 7 ツール → `judge` の出力（2:30 より前に見せた）を指す | *"Without a payer this server cannot move money — by design. The evidence row you saw in `judge` is the same SDK path."* |
| **審査中に `/api/health` が degraded を返す** | `detail` が `feedback_stats_unavailable(deadline:getLogsChunked); payee=ok`（09-10 に 11 行・#7）。**エージェントスコア面だけ**が慎重側に倒れる | (a) `detail` の**経路名をそのまま読み上げる**（隠さない・打ち直さない・§4.5）。(b) `curl -s https://vet402.com/api/health` を叩き、`https://vet402.com/status` §3 の "A missing observation is never reported as ok." を出す。(c) **デモへの影響は無し**——`judge` / `pay` が叩く `/resources/{id}/decision` と `/payees/{addr}/score` は DB 由来の別の脚を読む（Q17 #7）。**ただし `/agent/<id>`・badge・passport をその場で開くと、その面は risk "high"・score −15 に振れる**ので、開くなら先に断る | *"That is our own observatory naming the input it could not read — an upstream log scan that overran a 2.5-second budget — and failing closed, which is the design. The gate's two faces stand on a different leg, so the verdicts you are watching are unchanged; the upstream itself is a post-window fix."* |

**注記（09-10 実測・#7）**: **審査時刻は劣化が集中する時間帯と重なる**——Round 1 = 09-13 **19:00 UTC**（出典は【一次】ETHGlobal Discord `#👂information`・Pascal・2026-09-07 17:21 の *"3:00pm ET - Judging Round 1"*。原文は `WINDOW_PLAN.md` §1.4 の 09-07 20:15 追記。ET は EDT なので 19:00 UTC。**`info/details` には無い**）（`utc19 deg=7 ok=47`）、ライブ審査 = 09-14 **16:00 UTC**（09-08 のフォーム実測 12:00 pm EDT・冒頭）（`utc16 deg=7 ok=36`）。出ても驚かない。上の行のとおり経路名を読み上げる。

## 4.5 拒否が出たとき（`judge` / `pay` が REFUSE を返した）

**拒否は失敗ではない。** ただし「売り手が悪い」拒否と「入力が1つ読めなくて止まった」拒否は
別のもので、**言い方を間違えると審査員に前者として伝わる**。見分けは画面の語でつく。

**見分け方（実際の出力の形）**——関門行の `—` の後ろを読む。

| 画面に出る語 | 意味 | 理由コード |
|---|---|---|
| `[FAIL] payee verdict is ALLOW   WARN (68) — unread inputs: native_drain, usdc_drain; not measured, never waived [payee score]` | **入力が読めなかった。**「判定が悪い」ではない | `evidence_unavailable` |
| `… — degraded: not measured, never waived [payee score]` | 同上（源が丸ごと測れていない） | `evidence_unavailable` |
| `… — signalsUnavailable is not a list; not measured, never waived` | 同上（サーバの応答の形が読めない） | `evidence_unavailable` |
| `… — BLOCK is never waived` | **判定そのもの**が遮断 | `payee_recommendation_block` |
| `[FAIL] subgraph evidence is live   not read (graph_…)` | The Graph が読めなかった（§4 の「The Graph 断」） | `subgraph_evidence_unavailable` |
| `[FAIL] evidence floor: subgraph >= 1   0 receipts (need 1)` | 読めたうえで**床に届かない** | `insufficient_subgraph_evidence` |

上の 3 行（`unread inputs` / `degraded` / `signalsUnavailable is not a list`）はどれも
**「測れなかった」**で、`verdict from payee_score`・`reason_codes … evidence_unavailable` が続く。
空撃ち（`pay`）の `predicted` 行も同じ語で `--live would REFUSE before signing.` と言う
——**予告と拘束力ある関門は同じ規則を読んでいる**（`examples/ethonline-2026-demo/test/pay.test.mjs`
「空撃ちの予告は --live の結論と一致する」が 7 つの形で固定）。

**その場で言う英語**（そのまま読む）:

> "This is not a failure. The gate could not read one of its inputs, so it stopped before a
> signature could exist. It is the same path you saw in the video — the dry run, the two sources,
> the same rule — and only the conclusion came out the other way. A missing measurement is
> never an ALLOW."

**鍵なしで審査員に見せられる 2 本**（09-08 実測・ブラウザで開くだけ。Authorization も鍵も要らない）:

| URL | 09-08 実測 | 何が見えるか |
|---|---|---|
| `https://vet402.com/payee/<address>` | 200 · text/html · 40,049 B | その受取人の判定の頁。**部分的にしか測れていないときだけ** `Partial measurement — ETH outflow leg unmeasured · USDC outflow leg unmeasured (upstream outage)` の 1 行が出る（`src/app/payee/[address]/page.tsx`）。09-08 の The Graph の受取ウォレットは WARN で、この行は出ていない——**出ていない頁を「出る」と言わない** |
| `https://vet402.com/status` | 200 · text/html · 46,696 B | 系全体の状態。**開く前に Q17 を読む**——09-07 と 09-08 の行に error が並んでいる（09-08 22:0x 実測 samples 166 / ok 121 / degraded 8 / error 37）。**日は最悪サンプルで色がつく**ので、聞かれる前に *"a day is marked by its worst sample"* と先に言う |

`https://vet402.com/api/v1/payees/<address>/score` は**使わない**——鍵なしでは **401**
`{"error":"missing_api_key"}`（09-08 実測）。審査員の前で 401 を出すと、拒否の説明が
「鍵が無いから落ちた」に化ける。

**やらないこと**

- **その場で policy を緩めて無理に通さない。** 床を下げる・`--min-subgraph-receipts` を 0 にする・
  別の URL に差し替えて「通った画」を作る、はどれも §5 の「WARN を ALLOW にした」と同じ穴に落ちる。
  拒否したまま、なぜ拒否したかを読む
- **数字を言い換えない。** 画面の値をそのまま読む（§5・§6）。「たぶん一時的」「本当は通るはず」を足さない
- 拒否を謝らない。`payee verdict` の WARN は**我々の欠損**であって売り手の落ち度ではない（§0）

## 5. 禁止事項（1 つでも触れると失うもの）

| 禁止 | 理由・出典 |
|---|---|
| **出典の無い数字を口にする** | `WINDOW_PLAN.md` §6。言ってよいのは §6 の印か画面の値だけ |
| **`--live` をその場の判断で打つ／審査員の URL に打つ／2 回目を打つ** | 金が動く。§1 #9 で前日に決めた **1 回だけ**。`judge` に `--live` は無い（`parseJudgeArgs` が拒む） |
| **§1.5（The Graph との過去の関係）を売り文句にする** | Takeshi 指示。聞かれたら *"I was The Graph's Japan community manager until 2025. It is not used here; the numbers are."* で終える |
| `.env*`／`~/.bazantic/gateway/wallet.json`／`history`／素の `env` を画面に出す | 出したら失効させるしかない（`VIDEO_SCRIPT.md` §4.3） |
| Bazantic のキーストアの件（`WINDOW_PLAN.md` §10.6）・`support@bazantic.com` へ送った個別開示に触れる | 第三者の未修正の弱点。公開の場に出さない |
| SDK の結果を `settled` と言う | 語彙は `settle_claimed` まで（§15）。`settled` はチェーンを再読した側だけ |
| WARN を「ALLOW にした」と言う | 免除して**記録**する。書き換えない（§3.2.1） |
| 「会期の全コミットが提出物」と言う | README の caveat と食い違う。主張はパスで絞る |
| 動画と同じ絵を長く映す | 7 分のうち動画は審査員が見ている前提。ライブは審査員の URL と実走 |

## 6. 数字（印 か 当日取り直し）

**印がある数字**（`scripts/refresh-numbers.json` の id・基準日は `n:as_of` = <!-- n:as_of -->2026-09-08<!-- /n -->。**この文書は 09-08 から `docs` に登録されているので、下の値は印そのもの**——前日に `npm run check-numbers` が緑であることを確かめる。赤なら**言わずに**画面の値を読む）:

| 印 | 値【実測 09-08】 | それを出すコマンド（リポ root から） | どこで使う |
|---|---|---|---|
| `n:sdk_mutations` | <!-- n:sdk_mutations -->45<!-- /n --> | `cd packages/sdk && node test-mutations.mjs 2>&1 \| tail -1` の `all N mutations killed`（09-10 実走 44.3s） | Q12（"all killed"） |
| `n:ab_mutations` | <!-- n:ab_mutations -->27<!-- /n --> | `cd examples/ethonline-2026-ab && node test-mutations.mjs 2>&1 \| tail -1`（13.2s・`judge-check` が回す方） | 混同したときの訂正用（口では言わない） |
| `n:sdk_tests` | <!-- n:sdk_tests -->1615<!-- /n --> | `npm test --prefix packages/sdk 2>&1 \| sed -n 's/^ℹ tests //p'` | 画面のみ（言わない） |
| `n:mcp_tests` | <!-- n:mcp_tests -->748<!-- /n --> | `npm run build --prefix packages/mcp-server && npm test --prefix packages/mcp-server 2>&1 \| sed -n 's/^ℹ tests //p'` | 画面のみ（言わない） |
| `n:demo_tests` | <!-- n:demo_tests -->169<!-- /n --> | `npm test --prefix examples/ethonline-2026-demo 2>&1 \| sed -n 's/^ℹ tests //p'`（鍵不要・0.5s） | 画面のみ（言わない） |
| `n:total_commits` | <!-- n:total_commits -->820<!-- /n --> | `git rev-list --count --until='{{AS_OF_END}}' HEAD` | Q7（言うのは「大半」。値は `AI_USAGE.md` を指す） |
| `n:ai_trailer_commits` | <!-- n:ai_trailer_commits -->690<!-- /n --> | `git log --grep='Co-Authored-By: Claude' --until='{{AS_OF_END}}' --oneline \| wc -l` | 同上 |
| `n:merge_commits` / `n:no_trailer_commits` | <!-- n:merge_commits -->34<!-- /n --> / <!-- n:no_trailer_commits -->130<!-- /n --> | `git rev-list --count --merges --until='{{AS_OF_END}}' HEAD`／`n:total_commits` − `n:ai_trailer_commits` | 同上（trailer 無し＝「不明」であって「人間」ではない） |
| `n:window_added_files` / `n:window_modified_files` | <!-- n:window_added_files -->206<!-- /n --> / <!-- n:window_modified_files -->194<!-- /n --> | `git diff --diff-filter=A --name-only pre-ethonline-2026..{{AS_OF_SHA}} \| wc -l`（`M` で変更分） | Q6（画面のみ） |

`{{AS_OF_END}}` / `{{AS_OF_SHA}}` は `n:as_of` に固定した基準時刻と sha（`scripts/refresh-numbers.json` が展開する）。**手で日付を入れない。**

**固定**（提出まで動かない・出典つき）: tx `0xf12093fb…e469ad`・block **50898704**・**0.01 USDC**（チェーン再読 09-07 `status 0x1`）／A/B v1 **5/10・5/10**、語彙 **63%→91%**、**110 calls・88 settled・88 tx・57 tools**（`npm run metrics -- docs/ethonline-2026/ab/2026-09-06T213134Z`）／境界タグ `c42daca 2026-09-04 09:05:36 +0900`。

**当日取り直す**（§7 が採る。口では下限か画面の値）: The Graph 受取ウォレットの `totalPayments`（09-07 12:xx: **427**・block 50981065 → **09-10 11:05 UTC 実測: 512**・block 51124468。**10 日で 85 増えており、当日はさらに動く**）／受取人スコア（09-07・09-10 とも **WARN (68)**）／会期コミット数／kronos の受領件数／各テスト本数。**既定は画面の値をそのまま読む。** 下限で言うなら **"more than five hundred"**（09-10 実測 512 が根拠。件数は単調増加なので当日も下回らない）——**画面の値より大きい下限を言わない**。

## 7. 事前採取スクリプト（逃げ道用・リポの外に置く・鍵の値は出さない）

前日と当日の朝に 1 回ずつ。出力は `~/ethonline-live/<日付>/` に段の番号つきで置く。demo の出力は `src/emit.ts` が鍵を `<KEY>` に伏せる。MCP 行だけ `sed` で伏せる。

```bash
set -a; source ~/vouch/.env.rehearsal.local; set +a; unset HISTFILE
D=~/ethonline-live/$(date +%F); mkdir -p "$D"; cd ~/vouch
G=https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj
{ date -u; git log -1 --format='%h %ci' pre-ethonline-2026; git log pre-ethonline-2026..main --oneline -- packages/sdk packages/mcp-server examples/ethonline-2026-demo examples/ethonline-2026-ab SKILL.md AI_USAGE.md docs/ethonline-2026 | wc -l; } > "$D/00-tag.txt"
cd examples/ethonline-2026-demo
{ date -u; node src/run.ts judge "$G" --method POST --ceiling-usd 0.01; } > "$D/01-judge-nofloor.txt" 2>&1
{ date -u; node src/run.ts judge "$G" --method POST --ceiling-usd 0.01 --min-subgraph-receipts 1; } > "$D/02-judge-floor1.txt" 2>&1
{ date -u; node src/run.ts judge https://kronossignals.com/api/v1/price/btc; } > "$D/03-judge-kronos.txt" 2>&1
{ date -u; node src/run.ts refuse; } > "$D/04-refuse.txt" 2>&1
{ date -u; node src/run.ts pay; } > "$D/05-pay-dryrun.txt" 2>&1           # --live は打たない
{ date -u; GRAPH_API_KEY=not_a_real_key node src/run.ts judge "$G" --method POST --ceiling-usd 0.01; } > "$D/06-judge-graph-down.txt" 2>&1   # judge。refuse では graph_query_error が画に出ない（§8）
cd ../../packages/mcp-server
I='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}'
N='{"jsonrpc":"2.0","method":"notifications/initialized"}'
{ date -u; printf '%s\n%s\n%s\n' "$I" "$N" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | VOUCH_API_KEY=dummy node dist/index.js 2>/dev/null | tail -1; } > "$D/07-mcp-tools-list.txt"
{ date -u; printf '%s\n%s\n%s\n' "$I" "$N" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"pay_if_trusted\",\"arguments\":{\"resourceId\":\"9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763\",\"resource\":\"$G\",\"payee\":\"0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB\",\"amountUsd\":0.01,\"method\":\"POST\",\"policy\":{\"requireVet402Allow\":false,\"evidence\":{\"source\":\"subgraph\",\"minSubgraphReceipts\":1000000000}}}}}" \
  | VOUCH_API_KEY=$VOUCH_API_KEY GRAPH_API_KEY=$GRAPH_API_KEY VOUCH_PAYER_PRIVATE_KEY=0x$(openssl rand -hex 32) node dist/index.js 2>/dev/null | tail -1 | sed -e "s#$GRAPH_API_KEY#<KEY>#g"; } > "$D/08-mcp-pay-if-trusted.txt"
cd ../../examples/ethonline-2026-ab
{ date -u; npm run metrics --silent -- ../../docs/ethonline-2026/ab/2026-09-06T213134Z; } > "$D/09-ab-metrics.txt" 2>&1
cd ~/vouch && { date -u; npm run check-numbers; } > "$D/10-check-numbers.txt" 2>&1
for K in "$GRAPH_API_KEY" "$VOUCH_API_KEY" "$BAZANTIC_UPSTREAM_KEY"; do [ -n "$K" ] && grep -l -- "$K" "$D"/* 2>/dev/null; done
grep -ohE '0x[0-9a-fA-F]{64}' "$D"/* 2>/dev/null | sort -u   # 64桁hex（鍵の形）が1本も無いこと
echo "leak check above must print nothing"   # 09-08 実測: 両方とも空
ls -la "$D"
```

**08 の行は床 10⁹ なので署名に到達しない**（`SKILL.md` "Paying a seller outside the catalogue — live" と同じ引数。H8–H12 が固定）。
実装で言うと、床の不足は `packages/sdk/src/pay-or-refuse.ts:749` で `refuse` を返し、支払いモジュールの
動的 import は同 :843——**手前で返るので署名器に触れない**。

**鍵は「形として在る」ことだけが要る。** `resolvePayer()` が見るのは `/^0x[0-9a-fA-F]{64}$/` と
viem が解決できるかだけ（正規表現は `packages/mcp-server/src/index.ts:222`・宣言は `:220`）。だから**その場限りの
`0x$(openssl rand -hex 32)` を env にだけ渡す**——ファイルに書かない・印字しない・残高 0・
当日限り。`.env` に長生きする鍵を置くより安全で、`DEMO_PAYER_PRIVATE_KEY` を待たなくても回る。
**キーストア（`~/.bazantic/gateway/wallet.json`）は使わない**——資金のある鍵で、§5 の禁止表にも載っている。

**鍵を渡さないとこの段は絵にならない**（09-08 実測。渡す行はこの 08 の 1 本だけ）:

| 08 行の env | 出力 |
|---|---|
| `VOUCH_PAYER_PRIVATE_KEY=0x$(openssl rand -hex 32)` | `refuse_reasons ["resource_uncatalogued","insufficient_subgraph_evidence"]`・`signed false`・`nonce null`・`decision_record.evidence[0]` に `source "subgraph"` / `block.number` / `deployment Qm…` / `receipts` |
| 渡さない | `refuse_reasons ["evidence_unavailable","payer_not_configured"]`・`decision_record: null`・`evidence: []`——**The Graph を読む前に止まる**。§4 の逃げ道はこれ |

当日ライブで 2:30 に貼るのはこの 08 の `printf … | node dist/index.js | tail -1 | python3 -m json.tool` の形。

## 8. 使わなかったもの・変えたもの（理由つき）

| 指示・元の案 | どうしたか | 理由 |
|---|---|---|
| 「The Graph の断→`graph_query_error` がそのまま拒否になることを見せる」 | 見せる。**ただし理由コードの語は** `evidence_unavailable, subgraph_evidence_unavailable`。`graph_query_error: …` は関門表の `[FAIL] … not read (…)` 行に出る | 語を実装に合わせた（`pay-or-refuse.ts:947`・`subgraph-evidence.ts:195`）。09-07 に誤った鍵で実走して確認 |
| MCP の段を「鍵なし」で行く案 | **採らない。** 08 行だけ throwaway の payer 鍵を env に渡す。鍵なしは逃げ道に置いた | 09-07 実測: 鍵なしだと `payer_not_configured` が **Graph を読む前**に出て `evidence []`。The Graph の証拠行を MCP 面で見せるには鍵が要る。床 10⁹ で署名には到達しない |
| WARN の値を「69」と書く | **書かない。** 「WARN (nn)」と画面の値 | 09-07 12:xx の実測で **68**。§3 の「会期中 69 のまま」は外れた（drift の理由は未調査【未確認】）。固定値を口にすると画面と食い違う |
| `--live` を台本の定常段にする | **条件つきの 1 回**（§1 #9 で前日に決める）。既定は空撃ち＋09-05 の Basescan | 金が動く。当日その場で決めない。失敗時の絵（`status=failed`・nonce 公開）も逃げ道に置いた |
| 数字を `<!-- n:… -->` の印としてこの文書に埋める | **09-08 に反転して埋めた。** `refresh-numbers.json` の `docs` にこの文書を足した | id を引用するだけでは値が検査されず、実際に腐った——09-07 に書いた 27 / 178 / 65 / 743 / 170 が 09-08 の実測 42 / 1609 / 748 / 800 / 199 とずれたまま緑だった。審査員の前で読む数字を人の目に預けない |
| A/B v2 の数字 | 入れない。走っていれば画面に並べ、口は v1 のまま | 09-07 時点で存在しない数字を置かない |
| 問答に日本語訳を全文つける | 要旨 1 行だけ | 読む時間。言うのは英語の A |
| MCP の段に `DEMO_PAYER_PRIVATE_KEY` を使う（09-07 の案） | **その場限りの `0x$(openssl rand -hex 32)` に替えた**（§1 #8・§7） | 09-08 実測: その名前はどの `.env*` にも無く、この段は `payer_not_configured` / `decision_record null` / `evidence []` で**絵にならなかった**。床 10⁹ は署名の手前で返る（`pay-or-refuse.ts:749` < `:843`）ので、鍵は形が合っていれば足りる。**秘密をファイルへ書かず、当日限りで消える形**にした。キーストアは資金があるので使わない |
| §1 #8 の `npm i --no-save viem` | **削除** | 09-08 実測: `viem/accounts` はリポ root の `node_modules` で解決する（`packages/mcp-server/node_modules/viem` は無い）。書いてあるとおりにやると repo を汚すだけだった |
| Q2「2 回叩けば block が進む」 | **落とし、`--pin-deployment` の 2 枚に替えた** | 09-08 実測: 連続 3 回とも同じ block。**台本が保証できない絵**だった。pin は 1〜2 秒で一致／不一致の 2 枚が確実に出て、しかも「読んだ先が本当にその subgraph か」というより強い問いに答える（`beac4f9`・変異 M43/M44） |
| §4「The Graph 断」の再現を `refuse` で行う | **`judge` に替えた** | 09-08 実測: `graph_query_error: auth error: malformed API key` は `judge` の `[FAIL] … not read (…)` 行にだけ出る。`refuse` の 2 列の画には**出ない**（`— subgraph not read` だけ）。手控えどおりに `refuse` を打つと、言うつもりの語が画に無い |
| §4 の 429 行を「入っていれば起きない」で終える | **見え方と言う一文を書いた** | 09-08 実測: `cd246d9`（09-08 20:22 JST）以降、`judge`/`pay` の画は `HTTP 429` を 3 箇所に出す（`test/gate-parity.test.mjs` が固定）。**リハーサルで「429 の語が出ない」と観測されたのはこの修正より前の版**。`refuse` だけは今も出ない |
| Q12 の「42 変異・M01〜M42・39.2s」 | **本数と終端 id を手で書くのをやめた**（`all N mutations killed`。09-08 実走 53.8s → 09-10 実走 44.3s） | 09-08 clean checkout 実走: `all 44 mutations killed in 53.8s`・id は M01〜M44。`beac4f9` が pin の 2 本を足していた。**現在は 45・M01〜M45**（【実測】09-10 `git show origin/main:packages/sdk/test-mutations.mjs \| grep -cE '^\s+id:'` → **45**。`f076122` が印を 44→45 に更新済みで、§6・Q12 の印は 45 で正しい）。腐っていたのは**印の隣に手で書いた本文**だった（§8 の 1 つ上と同じ穴） |
| **この §8 の行そのもの**（「印は 44 で正しく」「M01〜M44」） | **45 / M01〜M45 に直した**（09-10） | **腐った数字を直した記録の節が、同じ形で腐っていた。** 印の外に書いた「44」は `check-numbers` が見ないので、印が 45 に動いても赤が出ない。**再発防止は 1 つ**——§8 の理由欄でも**本数と終端 id を裸で書かず、書くなら日付と実測コマンドを必ず添える**（この行がその形） |
| Q17 の答え「**Then we found it**／503 は **30 分 cron のみ**」 | **狭めた。** 「機構は再現して確かめ、直した。ただし当日の 503 全件の原因だとはまだ言えない——切り分けは継続中」。`30 分 cron のみ` は削除 | 09-08 22:5x 実測: (a) 最後の error 行 18:25:52 JST は `8e165cc`（18:37）・`c7ec6f6`（20:01）の**どちらのデプロイよりも前**——止まったのは修正の前。(b) `detail` を持つ error 行は **0 件**（理由を残す計器はまだ 503 を 1 件も捕らえていない）。(c) 30 分監視ログの最後の FAIL は 16:30 JST で、18:25 の 503 はどの cron の時刻でもない。11:30 の cron が OK の 2 分後にも error 行がある。(d) episodic（JST 02 時台・15 時台は error 0）。加えてこちらの測定トラフィックという交絡があるが、`health_snapshots` は 5 分間引きで流量を測れないので本数は**【未確認】**。**審査員の前で言い切ると、反証が 4 つある主張になる** |
| 想定質問 15 件 | **18 件**（Q16 コミットの言語 / Q17 `/status` の error / Q18 動画の数字） | 審査基準に *"Proper use of git commit history"* が明記されており、§4.5 が `/status` を「見せてよい 2 本」に挙げているのに、どちらも答えが無かった。動画の receipts は 09-07 の 427 から動いている |
| 想定質問 20 件 | **21 件**（Q21「なぜ MCP まで作ったのか」） | 09-10 18:46 に運営が「x402 Base subgraph を消費するだけで資格を満たす」と回答した（`PRIZES.md` §1.1）。**資格が SDK だけで足りたと審査員が知っている場合に、MCP を作った理由を答えられないと「余計なもの」に見える**。資格の下限と賞ページの評価軸は別だ、と言い切る 1 問を足した |

# ETHOnline 2026 — 提出動画の台本と撮影表

> 作成 2026-09-07（予定の 09-11 から前倒し・Takeshi 採用 07:53）。**Takeshi は 09-08 から録音できる。**
> 規定（`WINDOW_PLAN.md` §1.45）: **2〜4分・720p 以上・人間の声・AI 音声不可・スマホ動画不可・早回し不可・音楽＋テキストだけの説明不可。**
> 構成の土台は `WINDOW_PLAN.md` §6 と `docs/hackathons/2026-autumn-continuity.md` の shot list
> （`git log pre-ethonline-2026..main` → refuse → allow → 一文）。`docs/applications/video-script.md` は使わない（同文書の指示）。
> この文書の数字は **2026-09-07 07:5x JST の実測**。**動く数字は撮影日に §5 の表で取り直す。**

## 0. 先に決めたこと（読む前に）

- **口で言う数字と画面に出る数字がずれる問題。** ナレーションは 09-08 に録り、画面は 09-12 に録る（§17 の日程）。
  会期コミット数・The Graph の受領件数・テスト本数は**毎日増える**ので、09-08 に口にした正確な値は 09-12 の画面と食い違う。
  → **動く数字は口では「下限」で言う**（例: 受領 417 件 → "more than four hundred"）。下限は 09-13 の提出まで真であり続ける値を選ぶ。
  画面には撮影日の正確な値を出す。**固定の数字**（実 tx の block・$0.01・A/B v1 の 5/10・88 tx・変異 27）は正確に言う。
  「出典に無い数字を口に出さない」（§6）はこれで守れる。
- **The Graph のウォレットが WARN と出る絵**は、「The Graph を疑っている」と読まれる（§17 の人間の視点）。
  → **WARN を見せる前に**「これは我々が一度も買っていないという我々の欠損であって、売り手の落ち度ではない」と**先に言う**（§2 の 0:36）。
- Bazantic の A/B は**差 0 をそのまま言う**。語彙が直った事後指標と、88 tx の所見を添える。良く見せる編集をしない。
- 締めは「モデルに判定させない。関門を呼ぶ」。

## 1. 構成表（合計 3:04・英語 150 語/分で検算 → §6）

| 時間 | 画面に映すもの | ナレーション（英語・要旨） | 効く審査基準 / 賞の語 |
|---|---|---|---|
| 0:00–0:12 | ターミナル。`git log pre-ethonline-2026..main --oneline \| wc -l` → `git log -1 --format='%h %ci' pre-ethonline-2026`（`c42daca 2026-09-04 09:05:36 +0900`）。README の "One honest caveat" 段を 3 秒重ねる | Continuity。主張は全部このタグの後。数はこの間の全コミットで、主張しない本番作業も含む | Continuity の開示（規約）・Originality（検算できる姿勢） |
| 0:12–0:36 | `node src/run.ts pay` の**右カラム**をズーム: `/decision HTTP 404 (uncatalogued)` ／ `payee verdict WARN (69)` ／ `totalPayments {{graph_receipts}}` | 402 に当たったエージェントは、見たことのないウォレットに払うか決めねばならない。同じウォレット（The Graph 自身の x402 gateway）について 3 つの情報源が 3 つ違うことを言う | **The Graph（P1）**: live subgraph が判定の中核／Originality／WOW |
| 0:36–1:12 | 先に静止テキスト 1 枚（3 秒）: `l1_not_attempted = we never bought. Our gap, not the seller's.` → `clear` → `node src/run.ts refuse`。左 `[A] vet402` と右 `[B] The Graph`・`_meta.block.number`・`_meta.deployment` を順にズーム → 末尾 `result refused signed false nonce null` → `requests 2 — 0 signatures, 0 RPC, 0 settle` | WARN は The Graph への評決ではなく「我々が買っていない」の意味。2 カラムは live。右の block と deployment が live の証拠。関門は拒む。署名は存在しない。署名モジュールはこの経路で読み込まれない | **The Graph**: `_meta.block`（モック不可の要件）／Technicality／Usability（拒否理由が読める） |
| 1:12–1:36 | `clear` → `node src/run.ts pay`（空撃ち）。左「what would be signed」（amount・payTo・EIP-3009 window）→ `[waiv] payee verdict is ALLOW WARN (69) — not required by policy` → `[ok] evidence floor: subgraph >= 1` → 最終行 `DRY RUN — no signature was created. The signing module was never loaded.` | 既定は空撃ち。本物の 402 を取って、何に署名するはずだったかを見せる。呼び手の policy は「vet402 の ALLOW は要らない。The Graph 自身の台帳に受領 1 件以上」。WARN は免除して記録する——書き換えない。署名は作られていない | Technicality（fail-closed の設計）／Practicality（呼び手の基準で動く） |
| 1:36–1:54 | ブラウザ: `https://basescan.org/tx/0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad`。Status Success・Block 50898704・Transfer 0.01 USDC → `0x79DC…FcCB` をズーム → ターミナルに戻り `SKILL.md` の決定行 `verdict from caller_policy` を映す | `--live` は人間の決断。1 セント、block 50898704、The Graph の受取ウォレットへ。Basescan にある。決定行は `caller_policy` と WARN を残す。**The Graph のデータで払った。我々のではなく** | **The Graph**: 実 tx／Practicality／WOW |
| 1:54–2:12 | `cd examples/ethonline-2026-demo && npm test` の末尾 `ℹ fail 0` → テスト名 2 本（`既定では…署名器に触れない`／`--live を明示すると…ちょうど1回`）→ `packages/sdk` の `node test-mutations.mjs` 末尾 `all 27 mutations killed` | 拒否が署名しないと、なぜ言えるか。テストは signer への参照を数える: 空撃ちで 0。ネガティブコントロールが `--live` で 1 を見る——0 が配線ミスでない証拠。SDK の変異は全部赤になる | Technicality／Usability（`npm test` が鍵なしで緑） |
| 2:12–2:41 | `docs/ethonline-2026/BAZANTIC_FEEDBACK.md` §2 の表（A 5/10・B 5/10）→ §3 の語彙の行（63% → 91%）→ §4-4（110 calls / 88 tx）。Recipe 公開ページ `bazantic.com/recipes/x402-payee-verification-via-vet402-gateway` を 3 秒 | 問い: 説明なしにエージェントが使えるか。同じモデル・同じプロンプト・同じ 57 ツール。Recipe だけが差。事前登録・1 回・回し直さない。結果 5/10 と 5/10、差なし。直ったのは語彙: 実在の理由コード 63% → 91%。Bazantic への所見: 無料の読み取り 88 回に 88 本のオンチェーン tx | **Bazantic（P2）**: 「Recipe が唯一の差」「両方の結果を示す」「改善を特定」／Originality（正直な報告） |
| 2:41–2:53 | `packages/mcp-server` で `tools/list` → 7 ツールの中の `pay_if_trusted` → `SKILL.md` 冒頭（`npm run judge-check`）→ `AI_USAGE.md` の "The short answer" | 同じ関門が MCP の 1 ツール。同じ policy を渡すだけで再判定しない。`SKILL.md` は審査員が動かすもの。`AI_USAGE.md` は誰が何を書いたか | Usability（DX）／規約（AI 開示） |
| 2:53–3:03 | 0:12 の 3 行（404 / WARN 69 / receipts）を静止で再掲 → 最後に `signed false nonce null` の 1 行 | モデルに払うかを決めさせない。関門を呼ぶ——関門は署名が存在する前に「否」と言える | WOW／Originality |

**時間の根拠は §6。** 3:04 は規定の 2〜4 分の内側で、目標 2:30〜3:30 の内側。

## 2. ナレーション本文（英語・そのまま読める・一文ずつ改行）

`{{…}}` は §5 の表で撮影日に埋める。**下限で読む語は §5 の「口で言う形」の列**を使う。
言い間違えたら止めて、**その文から**読み直す（編集で切る）。

```
[S1 0:00]
vet402, Continuity track.
Every line we claim sits after this tag, cut five minutes into the window.
That number is every commit since — including production work we are not claiming.

[S2 0:12]
An agent hits a 402 and has to decide whether to pay a wallet it has never seen.
Here is one wallet — The Graph's own x402 gateway — and three sources.
Our catalogue knows nothing: 404.
Our payee engine says WARN, sixty-nine.
The Graph's own subgraph says this wallet has received {{graph_receipts}} payments.
Three sources, three different answers, same address.

[S3 0:36]
Before anything else: WARN here is not a verdict on The Graph.
It means we have never bought from this seller.
The reason code is l1_not_attempted — our gap, named as ours.
Now the gate. Two columns, live, for a seller we have seen but never bought from.
Left, our decision API. Right, The Graph's subgraph, with its block number and deployment hash — proof it is a live read, not a cached number.
The gate refuses. Signed: false. Nonce: null.
The signing module was never loaded on this path.

[S4 1:12]
Same gate, pointed at The Graph.
Default is a dry run: it fetches the real 402 and shows what would be signed — amount, payTo, the EIP-3009 window.
The caller's policy says: I do not need vet402's ALLOW; I need at least one receipt in The Graph's own ledger.
WARN is waived and recorded — not rewritten.
No signature was created.

[S5 1:36]
With --live, a human decision, it paid.
One cent of USDC, block 50898704, to The Graph's receiving wallet — on Basescan, not in our logs.
The decision record says verdict from caller policy, and keeps the WARN.
Paid on The Graph's data, not ours.

[S6 1:54]
How do we know refuse never signs?
The demo's tests count signer accesses: zero on the dry run.
A negative control flips --live and sees exactly one — so zero is not a wiring mistake.
And {{mutations}} mutations of the SDK all turn the suite red.

[S7 2:12]
For Bazantic we asked: can an agent use this without our Recipe?
Same model, same prompt, same fifty-seven tools; the Recipe was the only difference.
Pre-registered, run once, not re-run.
Result: five out of ten, and five out of ten. No difference in success.
What the Recipe fixed was vocabulary: real reason codes went from sixty-three percent to ninety-one.
And a finding for Bazantic: eighty-eight free reads cost eighty-eight on-chain transactions.

[S8 2:41]
The same gate is one MCP tool, pay_if_trusted, with the same policy — the tool does not re-judge.
SKILL.md is what the judges run; AI_USAGE.md says who wrote what.

[S9 2:53]
We do not let the model decide whether to pay.
We call a gate — and the gate can say no before a signature exists.
```

**読み方の注意**: `402` は "four-oh-two"。`l1_not_attempted` は "L-one not attempted"。`payTo` は "pay-to"。
`EIP-3009` は "E-I-P three-thousand-nine"。`--live` は "dash dash live"。`50898704` は "five-zero-eight-nine-eight-seven-zero-four"（桁読み）。

## 3. ナレーション本文（日本語・Takeshi が日本語で読む場合。英字幕は私が付ける）

構成は英語版と同じ 9 節。**S5 の block と S7 の数字は固定値なので正確に。S2 の受領件数と S6 の変異数は §5 の「口で言う形」。**

```
[S1 0:00]
vet402、Continuity トラックです。
主張するコードは全部このタグより後。会期が開いて5分後に打ちました。
画面の数はそれ以降の全コミット。主張しない本番作業も含みます。

[S2 0:12]
402 に当たったエージェントは、初見のウォレットに払うかを決めねばなりません。
The Graph 自身の x402 ゲートウェイ。1つのウォレットに3つの情報源。
我々のカタログは何も知らない。404。
我々の受取人エンジンは WARN、69点。
The Graph 自身のサブグラフは、{{graph_receipts}}の受領があると言う。
同じアドレスに、3つの違う答え。

[S3 0:36]
先に言います。この WARN は The Graph への評価ではない。
我々が一度も買っていない、という意味です。
理由コードは l1_not_attempted。我々の欠損を、我々のものとして名指しします。
関門です。2カラム、どちらも live。
左は我々の decision API。右は The Graph のサブグラフ、ブロック番号と deployment ハッシュ付き。live の証拠です。
関門は拒む。signed false、nonce null。
署名モジュールは読み込まれもしません。

[S4 1:12]
同じ関門を The Graph に向けます。
既定は空撃ち。本物の 402 を取り、何に署名するはずだったかを見せます。
呼び手の policy は「vet402 の ALLOW は要らない。The Graph 自身の台帳に受領1件以上」。
WARN は免除して記録する。書き換えはしない。
署名は作られていません。

[S5 1:36]
--live は人間の決断。付けると、払いました。
1セントの USDC、ブロック 50898704、The Graph の受取ウォレットへ。Basescan にあります。
決定記録には caller_policy と免除した WARN が残ります。
The Graph のデータで払った。我々のデータではなく。

[S6 1:54]
拒否が署名しないと、なぜ言えるか。
テストは signer への参照を数えます。空撃ちで0回。
ネガティブコントロールは --live で1回を見る。0は配線ミスではない。
SDK の{{mutations}}個の変異は、全部テストを赤にします。

[S7 2:12]
Bazantic の問い。エージェントは我々の Recipe なしに使えるか。
同じモデル、同じプロンプト、同じ57ツール。差は Recipe だけ。
事前登録、1回だけ、回し直しなし。
結果は10回中5回と、10回中5回。差はありません。
直ったのは語彙です。実在する理由コードが63%から91%に。
所見も1つ。無料の読み取り88回に、88本のオンチェーン取引。

[S8 2:41]
同じ関門が MCP では1ツール、pay_if_trusted。同じ policy を渡すだけ。再判定しません。
SKILL.md は審査員が動かすもの。AI_USAGE.md は誰が書いたか。

[S9 2:53]
払うかを、モデルに決めさせない。
関門を呼ぶ。関門は、署名が存在する前に「否」と言えます。
```

## 4. 撮影表

### 4.1 画面収録（私が 09-12 に行う・§17 の日程）

**機材と設定**（720p 以上・スマホ不可）:

| 項目 | 値 |
|---|---|
| 収録 | macOS 標準 `Cmd+Shift+5` →「画面全体を収録」。Retina の実解像度で録り、書き出しで 1920×1080 に落とす（720p 規定を満たす） |
| ターミナル | Terminal.app か iTerm2。**幅 100 桁 × 42 行**（demo の出力は 96 桁を超えない: `src/columns.ts` `MAX_WIDTH = 96`。refuse 35 行・pay 41 行は 1 画面に収まる）。フォント Menlo **18pt**、暗い背景、`PS1='$ '` で短いプロンプト |
| ブラウザ | 1920×1080 のウィンドウ、ズーム 125%。Basescan は tx ページを事前に開いてタブに置く |
| 鍵 | **収録を始める前に**同じシェルで `set -a; source ~/vouch/.env.rehearsal.local; set +a`。画面には `env GRAPH_API_KEY=set` の行しか出ない（`src/emit.ts` が URL 内の鍵を `<KEY>` に書き換える。今日の実走で漏れ 0 件を grep で確認済み）。**鍵を画面上で export しない・`.env*` を `cat` しない・`history` を出さない** |
| 前準備 | `cd packages/sdk && npm ci && npm run build`、`cd ../mcp-server && npm ci && npm run build` は収録前に済ませる（画面に出さない）。`clear && printf '\e[3J'` でスクロールバックを消してから録画開始 |

**カットの順**（動画の順に録る。各カットの前に `clear`）:

| # | カット | 打つもの | 待ち時間・編集 |
|---|---|---|---|
| 1 | S1 境界タグ | `git log pre-ethonline-2026..main --oneline \| wc -l` → `git log -1 --format='%h %ci' pre-ethonline-2026` | 即応。README の caveat 段はテキストエディタで開いて 3 秒重ねる（編集で挿入） |
| 2 | S2 三つの情報源 | `cd examples/ethonline-2026-demo && node src/run.ts pay` | 実行に約 3 秒（網）。**その 3 秒は切らない**（live を見せる）。右カラムの 3 行を編集でズーム |
| 3 | S3 注意書き | 静止テキスト 1 枚（黒地・白字・`l1_not_attempted = we never bought. Our gap, not the seller's.`）を編集で 3 秒 | 収録は不要。編集で作る |
| 4 | S3 refuse | `clear` → `node src/run.ts refuse` | 約 3 秒の網。ズーム順: 左 `recommendation WARN / l1_not_attempted` → 右 `_meta.block.number` → `_meta.deployment` → `result refused signed false nonce null` → `requests 2 — 0 signatures, 0 RPC, 0 settle` |
| 5 | S4 pay 空撃ち | カット 2 と同じ出力を再利用（録り直さない）。左カラム → `[waiv]` 行 → `[ok] evidence floor` → 最終 2 行 | 編集のみ |
| 6 | S5 実 tx | ブラウザで Basescan の tx ページ。Status／Block／Transfer 行をズーム。次に `SKILL.md` の「It has moved real money」ブロック（`verdict from caller_policy`）をエディタで映す | ページ読み込みの待ちは切る |
| 7 | S6 テスト | `npm test 2>&1 \| tail -8`（demo）→ `cd ../../packages/sdk && node test-mutations.mjs 2>&1 \| tail -3` | demo テストは数秒・変異は約 25 秒。**変異の 25 秒は切って末尾だけ映す**（早回しにしない。切るのは規定違反でない） |
| 8 | S7 A/B | `BAZANTIC_FEEDBACK.md` §2 の表・§3 の語彙の行・§4-4 をエディタで。Recipe 公開ページをブラウザで 3 秒 | 編集のみ。**v2（09-09 予定）が走っていたら、v1 の表の下に v2 の表を並べて映す。ナレーションは v1 の数字のまま**（録音済みの声を変えない） |
| 9 | S8 MCP | `cd packages/mcp-server && printf … tools/list … \| node dist/index.js \| tail -1` → 7 ツール名 → `SKILL.md` 冒頭 → `AI_USAGE.md` 冒頭 | 出力 1 行を編集でズーム |
| 10 | S9 締め | カット 2 の右カラム 3 行の静止 → refuse の `signed false nonce null` の 1 行 | 編集のみ |

### 4.2 録音（Takeshi 手番・09-08 から）

- **要るもの**: 静かな部屋、iPhone のボイスメモか Mac のマイク 1 本。**音声はスマホで可**（禁じられているのは**動画**の撮影）
- **読むもの**: §2（英語）か §3（日本語）。`{{…}}` は §5 の「口で言う形」で読む。**表に無い数字は口にしない**
- **テイク**: 通しで **2〜3 テイク**。1 テイクは 3〜4 分。合計 15 分
- **言い間違えたら**: 止めて 2 秒黙り、**その文の頭から**読み直す。冒頭に戻らなくてよい（無音で切れる）
- **節の間**: `[S2]` などの節見出しは読まない。節と節の間に 1 秒の間を置く（編集の切れ目になる）
- **マイクと口の距離**: 20cm。同じ距離を保つ。紙をめくる音・キーボード音を入れない
- **渡し方**: AirDrop か iCloud で `.m4a` をそのまま。ファイル名にテイク番号（`take1.m4a`）
- **英語か日本語か**: 審査は英語圏で英語を推奨。日本語で読むなら英字幕を私が付ける（§6 の検算では日本語版も 3:00 前後）

### 4.3 禁止事項（1 つでも触れると自動却下か失格側）

| 禁止 | 出典 |
|---|---|
| 4 分に収めるための**早回し** | 運営 `info/details`（§1.45）。長い待ちは**切る**（切るのは可） |
| **音楽＋テキストだけ**で説明する | 同上。全節に肉声を当てる |
| **AI 音声・合成音声** | 同上。自動却下 |
| **スマホで動画を撮る** | 同上。画面収録は PC。音声だけスマホ可 |
| 2 分未満・4 分超・720p 未満 | アップロード時に自動拒否 |
| API キー・秘密鍵・`.env*`・`~/.bazantic/gateway/wallet.json` を画面に出す | §6「撮影で画面に出してはいけないもの」。**出したら失効させるしかない** |
| 台本に無い数字を言う | §6「出典の無い数字は1つも出さない」 |
| The Graph との過去の関係を口にする | §1.5（Takeshi 指示）。聞かれたら答える。売り文句にしない |

## 5. 撮影日に埋める数字の表（プレースホルダ ｜ コマンド ｜ 今日の値【実測】｜ 口で言う形）

**固定**＝提出まで動かない。**動く**＝撮影日に取り直す。口に出すのは `{{graph_receipts}}` と `{{mutations}}` だけ。
それ以外は画面にだけ出す（ナレーションは数字を言わない）。鍵が要る行は `set -a; source ~/vouch/.env.rehearsal.local; set +a` の後に叩く。

| プレースホルダ | コマンド（リポ root から） | 今日の値【実測 2026-09-07】 | 性質 | 口で言う形 |
|---|---|---|---|---|
| `{{window_commits}}` | `git log pre-ethonline-2026..main --oneline \| wc -l` | **218** | 動く（画面のみ） | 言わない（"that number" と指す） |
| `{{window_commits_nomerge}}` | `git rev-list --count --no-merges pre-ethonline-2026..main` | **205** | 動く（画面のみ） | — |
| `{{claimed_commits}}` | `git log pre-ethonline-2026..main --oneline -- packages/sdk packages/mcp-server examples/ethonline-2026-demo examples/ethonline-2026-ab SKILL.md AI_USAGE.md docs/ethonline-2026 \| wc -l` | **109** | 動く（画面のみ・README の caveat と対） | — |
| `{{tag_commit}}` / `{{tag_time}}` | `git log -1 --format='%h %ci' pre-ethonline-2026` | **`c42daca 2026-09-04 09:05:36 +0900`** | 固定 | "cut five minutes into the window"（時刻は言わない） |
| `{{graph_receipts}}` | `node src/run.ts pay 2>&1 \| grep totalPayments`（demo dir・鍵要） | **417**（block **50973028**） | 動く・**口で言う** | **下限で**: "more than four hundred"（09-06 は 260 → 1 日で 157 増。撮影日の値が 500 を超えていたら "more than five hundred" に上げる。**画面の値より大きい下限を言わない**） |
| `{{graph_score}}` | 同上 `\| grep 'payee verdict'` | **WARN (69)** | 動く（§3 の規則で会期中は 69 のまま） | "WARN, sixty-nine"（撮影日に 69 でなければ**その値**に置き換える） |
| `{{graph_decision}}` | `curl -sL -o /dev/null -w '%{http_code}' 'https://vet402.com/api/v1/resources/9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763/decision?role=payer'` | **404** | 固定（カタログに登録しない決定・§3.1） | "four-oh-four" |
| `{{fixture_receipts}}` / `{{fixture_block}}` | `node src/run.ts refuse 2>&1 \| grep -E 'totalPayments\|_meta.block.number'`（鍵要） | **31** / **50973027**（payee `0xb15a55e8…def59`・0x.org） | 動く（画面のみ） | 言わない |
| `{{fixture_reasons}}` | 同上 `\| grep reasons` | `l0_pass, l1_not_attempted, l2_undeclared, payee_recommendation_not_allow` | 固定 | "l1_not_attempted" のみ口にする |
| `{{tx_hash}}` / `{{tx_block}}` / `{{tx_amount}}` | `curl -sL -X POST https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad"]}'` | status **0x1**・block **50898704**・Transfer **10000** units（$0.01）→ `0x79dc34e4…d52fccb` | **固定**（チェーン再読で確認） | "block five-zero-eight-nine-eight-seven-zero-four"・"one cent" |
| `{{sdk_tests}}` | `cd packages/sdk && npm ci && npm test 2>&1 \| grep -E '^ℹ (tests\|fail)'` | **235 / fail 0** | 動く（画面のみ） | 言わない |
| `{{mcp_tests}}` | `cd packages/mcp-server && npm ci && npm run build && npm test 2>&1 \| grep -E '^ℹ (tests\|fail)'` | **70 / fail 0** | 動く（画面のみ） | 言わない |
| `{{demo_tests}}` | `cd examples/ethonline-2026-demo && npm test 2>&1 \| grep -E '^ℹ (tests\|fail)'` | **65 / fail 0** | 動く（画面のみ） | 言わない |
| `{{mutations}}` | `cd packages/sdk && node test-mutations.mjs 2>&1 \| tail -1` | **all 27 mutations killed in 25.0s** | 動く・**口で言う** | "twenty-seven"（撮影日に増えていたら**その数**。killed でない変異が 1 つでもあれば**この文を丸ごと落とす**） |
| `{{mcp_tools}}` | `cd packages/mcp-server && printf '%s\n%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \| node dist/index.js 2>/dev/null \| tail -1` | **7 ツール**（`pay_if_trusted` を含む） | 動く（画面のみ） | 言わない |
| `{{ab_a}}` / `{{ab_b}}` | `BAZANTIC_FEEDBACK.md` 末尾の Recount 1 本目 | **A 5/10・B 5/10**（verdictMatch 10/9・fabricated 5/4・unparseable 0/1） | **固定**（生ログ `ab/2026-09-06T213134Z/`・回し直さない） | "five out of ten, and five out of ten" |
| `{{ab_vocab_a}}` / `{{ab_vocab_b}}` | `npm run metrics -- docs/ethonline-2026/ab/2026-09-06T213134Z`（集合 ii・採点と同じ正規化） | **A 20/32 (63%)・B 29/32 (91%)** | 固定 | "sixty-three percent to ninety-one" |
| `{{ab_toolcalls}}` / `{{ab_tx}}` | 同 Recount 1 本目の最終行 | **110 calls・88 settled・88 distinct tx・57 tools** | 固定 | "eighty-eight … eighty-eight"・"fifty-seven tools" |
| `{{kronos}}`（judge の絵を足す場合のみ） | `node src/run.ts judge https://kronossignals.com/api/v1/price/btc`（鍵要） | **ALLOW (85)・1358 receipts・block 50973042** | 動く（画面のみ） | — |

**手順**: 撮影日の朝、この表を上から叩いて「今日の値」列を書き換える → 「口で言う形」の下限が真か見る → 真でなければ録音した音声のその文を落とす（言い直しを頼まない）。

## 6. 読み上げ時間の検算（英語 150 語/分）

下の Python で数えた英語ナレーションの語数（空白区切り）。`{{graph_receipts}}` は "more than four hundred"（4 語）、`{{mutations}}` は "twenty-seven"（1 語）として数えた。

| 節 | 語数 | 秒（÷2.5） | 累計 | 構成表の枠 |
|---|---|---|---|---|
| S1 | 31 | 12.4 | 0:12.4 | 0:00–0:12 |
| S2 | 64 | 25.6 | 0:38.0 | 0:12–0:36 |
| S3 | 90 | 36.0 | 1:14.0 | 0:36–1:12 |
| S4 | 61 | 24.4 | 1:38.4 | 1:12–1:36 |
| S5 | 44 | 17.6 | 1:56.0 | 1:36–1:54 |
| S6 | 46 | 18.4 | 2:14.4 | 1:54–2:12 |
| S7 | 71 | 28.4 | 2:42.8 | 2:12–2:41 |
| S8 | 29 | 11.6 | 2:54.4 | 2:41–2:53 |
| S9 | 25 | 10.0 | 3:04.4 | 2:53–3:03 |
| **合計** | **461** | **184.4 秒 = 3:04.4** | | |

- **3:04.4 は 2:30〜3:30 の内側**。150 語/分より遅く読んでも（130 語/分で 3:32.8）規定の 4 分には遠い。
  速く読んでも（170 語/分で 2:42.7）2 分は割らない。**画面の待ち（網の 3 秒 × 2）と節間の 1 秒 × 8 を足しても 3:20 以内。**
- 日本語版は **1,179 字**。ニュース読みの 300 字/分で **3:55.8**、解説ナレーションの 350 字/分で **3:22.1**。どちらでも規定の 4 分は割らない。日本語で読むなら 350 字/分が目標。300 字/分だと目標の 3:30 は超えるが規定内（英字幕は英語版の文をそのまま使う）。
検算のコマンド（この文書を変えたら再実行）:
```bash
python3 - <<'EOF'
import re; t=open('docs/ethonline-2026/VIDEO_SCRIPT.md',encoding='utf-8').read()
def body(a,b): s=t.index(a); return re.search(r'```\n(.*?)```',t[s:t.index(b,s)],re.S).group(1)
en=body('## 2.','## 3.').replace('{{graph_receipts}}','more than four hundred').replace('{{mutations}}','twenty-seven')
ja=body('## 3.','## 4.').replace('{{graph_receipts}}','400件以上').replace('{{mutations}}','27')
def per(x,f):
    o={};s=None
    for l in x.splitlines():
        m=re.match(r'\[(S\d) ',l)
        if m: s=m.group(1); continue
        if s and l.strip(): o[s]=o.get(s,0)+f(l)
    return o
w=per(en,lambda l:len(l.split())); c=per(ja,lambda l:len(l.replace(' ','')))
print('EN',w,sum(w.values()),'words',round(sum(w.values())/2.5),'s'); print('JA',c,sum(c.values()),'chars',round(sum(c.values())/5),'s @300/min')
EOF
```

## 7. 使わなかったもの・変えたもの（理由つき）

| 元の指示・正典 | どうしたか | 理由 |
|---|---|---|
| §6 の冒頭「左右分割で、左は 402 に当たって即署名 → tx が出る」 | **入れない** | 「検証しないで払うエージェント」の tx を新たに作る必要があり、会期スコープ外（§2）。代わりに冒頭を「3 つの情報源が 3 つ違う」にした（§3・§3.2.1 の結論） |
| §6 の「既定 policy を通る相手は今日 373 件」 | **入れない** | 撮影日に取り直す計器が無い（373 の出典コマンドが正典に無い）。出典の無い数字は言わない |
| §6 の「SDK 3 行 → MCP 1 ツール → `source: subgraph` の差分」 | MCP 1 ツール（S8）だけ残し、コード差分の絵は落とした | 3 分に収めるため。`SKILL.md` の live 節が同じ内容を持ち、審査員はそこで読める |
| continuity 文書の「`run.ts block` / `run.ts allow`」 | `refuse` / `pay` に読み替え | 実装済みのコマンド名がこれ（`examples/ethonline-2026-demo/package.json`） |
| 「数字はプレースホルダにして撮影日に埋める」 | プレースホルダは残したが、**口で言うのは 2 つ**に絞り、動く数字は**下限**で読む | 録音（09-08）と画面収録（09-12）の日がずれる。正確な値を口にすると画面と食い違う。The Graph の受領は 1 日で 260 → 417 と動いた【実測】 |
| 09-09 予定の A/B v2 | ナレーションに入れない。画面だけで v1 の下に並べる | 09-08 の録音時点で結果が存在しない。存在しない数字を台本に置かない |
| `judge <url>` の絵 | 構成表に入れず、§5 に kronos の実測だけ置いた | 時間。審査員が自分で叩く導線は `SKILL.md` に既にある |

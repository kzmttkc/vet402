# 判定コマンド一覧と空打ちの記録（A9・2026-09-18）

空打ちの条件: `~/vouch` の `origin/main = b4d1ae0`（SDK 0.7.0）・`~/Takeshi_Automation` の `origin/kabau-trust-board = ca69639`。
**署名・送信・faucet 請求・commit は 0 回。**外部への書き込みも 0。

印:
- **✅ 通った** — 実際に打ち、期待どおりの出力が出た
- **⚠ 通ったが期待値が古い** — 打てたが、計画が書いた期待値と今の実測が違う（計画を直す）
- **❌ 落ちた** — 打って失敗した。代替を用意した
- **# 実装後に有効** — 参照先のファイル・URL がまだ無い。**構文だけ確かめた**（パスの綴り・パイプの形・jq の式）

合計: **打てたもの 32 本／打てなかったもの（実装後に有効）22 本／落ちたもの 1 本**。

---

## 0. 環境（毎回先に貼る）

```bash
WT=~/vouch-tokyo
SDK=$WT/packages/sdk
MCP=$WT/packages/mcp-server
DEMO=$WT/examples/tokyo-2026-demo
TOKYO_PATHS="packages/sdk packages/mcp-server examples/tokyo-2026-demo docs/tokyo-2026 skills/pay-or-refuse SKILL.md AI_USAGE.md src/app/tokyo src/app/api/tokyo tests/agent-skill-plugin.test.ts tests/caller-policy-sdk-parity.test.ts"
set -a; . $DEMO/.env.tokyo.local; set +a
```
`~/vouch-tokyo` は 09-25 18:30 に人が作る worktree。**09-18 時点で存在しない**ので、`$WT` を使う行はすべて「実装後に有効」。
構文の確認は `~/vouch` を `$WT` に読み替えて行った。

### 道具（✅ すべて在る）
```
jq       /usr/bin/jq
gh       /opt/homebrew/bin/gh      （認証済み・ensdomains と 0xLighthouse を読めた）
ffprobe  /opt/homebrew/bin/ffprobe （version 8.1.2）
node     v26.3.0                    （--test --test-reporter=spec は ℹ fail N 形式を出す）
base64   /usr/bin/base64            （-d も -D も通る。-d で書いてよい）
```

### ❌ 落ちた1本と、その代替

```bash
# ❌ 計画 §5.4 の COMMITS_EN 検査。macOS の /usr/bin/grep は -P を持たない
$ printf 'あ\n' | /usr/bin/grep -cP '[\x{3040}-\x{30ff}]'
grep: invalid option -- P      # exit 2
```
**代替（✅ 実測で同じ判定になる）**:
```bash
git -C $WT log --format=%s pre-tokyo-2026..origin/main -- $TOKYO_PATHS | LC_ALL=C grep -c '[^ -~]'   # → 0
```
> 注: Claude Code のセッション内では `grep` が ugrep のシェル関数に差し替わっていて `-P` が通る。
> **Takeshi が自分のターミナルで打つと失敗する。**発注文には上の代替だけを書いた。

---

## B0 — 会期開始直後の実測

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B0-1 | `curl -sL -o /dev/null -w '%{http_code}\n' https://x402.org/facilitator/supported` | `200` | ✅ `200` |
| B0-2 | `curl -sL https://x402.org/facilitator/supported \| jq -c '.kinds[] \| select(.network=="eip155:84532" and .scheme=="exact")'` | 1行 | ✅ `{"x402Version":2,"scheme":"exact","network":"eip155:84532"}` |
| B0-3 | `gh api repos/ensdomains/ensips/pulls/85 --jq '.head.sha, .state'` | `e00c3453…` / `open` | ✅ `e00c3453a4ce0fec8439e2aeeea4c47cb0604efe` / `open` |
| B0-4 | `gh api repos/ensdomains/ensips/pulls/85/files --jq '.[].filename'` | `ensips/xx.md` | ✅ `ensips/xx.md`（`29.md` への改名はまだ） |
| B0-5 | `gh api 'repos/0xLighthouse/ens-metadata/commits?path=packages/sdk/src/attestation.ts&per_page=1' --jq '.[0].sha'` | `bfbaebf4…` | ✅ `bfbaebf4d580101b7aba3e67427d7ffcfd626f21`（変わっていない） |
| B0-6 | `curl -sL 'https://discuss.ens.domains/t/22376.json' \| jq '.posts_count'` | 11 以上 | ✅ `12` |
| B0-7 | `curl -sL https://ethglobal.com/events/tokyo2026/prizes/ens \| grep -c 'target an existing project'` | `1` | ✅ `1` |
| B0-8 | `curl -sL https://docs.ens.domains/learn/deployments \| grep -o 'contracts-v2/blob/[0-9a-f]\{40\}' \| sort -u` | 計画の期待は `97a57293…` **だけ** | ⚠ **`71a3b7339dbc55ab47667abdfe8303bac4f4c24e` だけ。**docs は 09-15 配備に更新済み。6つの新アドレスも載っている（`0x9703DBD2`・`0x657eA849`・`0x14F09Fd0`・`0x33f571aa`・`0x9e726Eb5`・`0xAbe76F6C` を各1件）。**§1.7 のこの行の期待値を `71a3b733…` に直さないと B0 で誤って R2 を鳴らす** |
| B0-9 | `curl -sL -o /dev/null -w '%{http_code}\n' https://vet402.com/api/tokyo/seller` | `404`（会期前） | ✅ `404` |
| B0-10 | `curl -sSL -m 20 -X POST https://sepolia.rpc.sentio.xyz -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \| jq -r .result` | 16進の head | ✅ `0xb2fe42`（＝11,730,498） |
| B0-11 | 同じ本文を `https://rpc.sepolia.ethpandaops.io` へ | 差 ≤ 3 | ✅ `0xb2fe43`（差 **1**） |
| B0-12 | `node $DEMO/src/probe-rpc.ts --deployment` | 1行 `deployment ok: …` | # 実装後に有効（B0 で書く。構文のみ確認） |
| B0-13 | `node $DEMO/src/probe-rpc.ts --repeat 5` | 1行 `rpc ok: 5/5 match…` | # 実装後に有効 |
| B0-14 | `node $DEMO/src/run.ts census vet402.eth seller-a.eth seller-b.eth seller-c.eth` | 1行 `census ok: …` | # 実装後に有効 |
| B0-15 | `git -C $WT rev-parse HEAD` = `git -C ~/vouch rev-parse 'pre-tokyo-2026^{commit}'` | 一致 | # タグ未作成（下の注） |

**B0-15 の注（✅ 落とし穴を実測）**:
```bash
$ git -C ~/vouch for-each-ref --format='%(taggerdate:iso-strict)' refs/tags/pre-tokyo-2026
$ echo "exit=$?"
exit=0        # ← タグが無くても exit 0。空行が返るだけ
```
→ **判定は exit ではなく「出力が空でないこと」で書く**:
```bash
[ -n "$(git -C ~/vouch for-each-ref --format='%(taggerdate:iso-strict)' refs/tags/pre-tokyo-2026)" ] && echo TAG_OK || echo TAG_MISSING
```

---

## B1 — 失敗テストと運用スクリプト

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B1-1 | `git -C $WT ls-remote origin refs/heads/tokyo-2026 \| cut -f1` | 空でない | ✅ 構文確認（今は空。`refs/heads/main` では `b4d1ae0f2e90…` が返った） |
| B1-2 | `cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/tokyo/*.test.mjs 2>&1 \| grep -oE '✔ [TU][0-9]+[ab]? ' \| tr -d '✔ ' \| sort -u \| tr '\n' ' '` | `T29 T30 ` | ✅ **形を実測**。scratch に `T29`・`T30`（緑）と `T01`（`await import` が失敗して赤）の3本を書いて走らせ、出力は `T29 T30 ` だった |
| B1-3 | `cat $SDK/test/tokyo/*.test.mjs $DEMO/test/*.test.mjs $MCP/test/tokyo/*.test.mjs \| grep -cE '^test\("(T\|U)[0-9]+'` | 53 以上 | ✅ 形を実測（同じ scratch で `3`）。**宣言は行頭の `test("` で書くこと。`await test(` や字下げは数えられない** |
| B1-4 | `node $DEMO/src/admin.ts --help \| grep -cE '^  (deploy-resolvers\|k1a\|k1b\|publish-attestations\|unlink\|link\|relink)'` | `7` | # 実装後に有効（**旧案の `own-resolver`・`clear`・`alias-prepare`・`alias` ではない**） |
| B1-5 | `git -C $WT check-ignore -q examples/tokyo-2026-demo/.env.tokyo.local; echo $?` | `0` | ✅ `0`（`~/vouch` の `.gitignore` の `.env*` で既に無視される） |
| B1-6 | `git -C $WT diff --cached --name-only \| grep -c '\.env'` | `0` | ✅ 形を実測。**`grep -c` は 0 件のとき exit 1 を返す。数字を読み、`&&` で繋がない** |

---

## B2 — ENSIP-29 の符号化と検証

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B2-1 | `cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/tokyo/ens-attestation-unit.test.mjs 2>&1 \| grep -E '^ℹ fail'` | `ℹ fail 0` | ✅ 形を実測（node 26 は `ℹ fail N` を出す） |
| B2-2 | `node -e 'const s=require("fs").readFileSync("'$SDK'/src/ens-reasons.ts","utf8"); process.stdout.write(String(/^\s*import[ ({]/m.test(s)))'` | `false` | # 実装後に有効（構文のみ） |
| B2-3 | `git -C $WT ls-remote origin refs/heads/tokyo-2026 \| cut -f1` = `git -C $WT rev-parse HEAD` | 一致 | ✅ 構文確認 |

---

## B3 — チェーン profile と D1-a の床

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B3-1 | `cd $SDK && node --test --test-reporter=spec --test-name-pattern='^T3[123] ' test/tokyo/pay-or-refuse-ens.test.mjs 2>&1 \| grep -E '^ℹ fail'` | `ℹ fail 0` | ✅ 形を実測（`--test-name-pattern` は ID の前方一致で効いた） |
| B3-2 | `cd $SDK && npm test 2>&1 \| grep -E '^ℹ (pass\|fail)'` | `fail 0` | # 実装後に有効（`~/vouch` での実走は依存の再取得が要るので打っていない。09-16 の A5 実測では 1735 pass / 0 fail・2 秒） |
| B3-3 | `git -C $WT diff pre-tokyo-2026 -- packages/sdk/src/x402-pay.ts packages/sdk/src/chain-profile.ts packages/sdk/src/pay-or-refuse.ts` | 人が読む | # タグ未作成 |
| B3-4 | `(cd $WT && bash scripts/push-main.sh --full; echo "exit=$?")` | `exit=0` | # 実装後に有効（`scripts/push-main.sh` は `origin/main` に在る✅。**実走は push するので打っていない**） |

### ✅ `pay-or-refuse.ts` の行番号の実測（発注文 B3 の「読み替え表」の裏取り）
```bash
git -C ~/vouch show origin/main:packages/sdk/src/pay-or-refuse.ts | wc -l      # → 1438（計画が前提にした 0.6.0 は 1100 行台）
```
`grep -n` で確かめたアンカー（09-18・`b4d1ae0`）:
`PAY_REFUSE_REASONS` 163 ／ `minL1Deliveries?: number` 225 ／ 「床を1つも宣言せずに」271 ／ `floor: "minL1Deliveries"` 288 ／ `invalid_payee_address:` 634 ／ `--- 3. /decision ---` **751** ／ `--- 3.5` 820 ／ `--- 3.6` 917 ／ `--- 4. 402 チャレンジ ---` **925** ／ `--- 3'.` 975 ／ `await import("./x402-pay.js")` **1071** ／ `chainId: BASE_CHAIN_ID` 1079 ／ `if (paid.txHash)` 1129 ／ `assertFiniteFloor` 1244 ／ `const met: EvidenceFloorCheck` 1291 ／ `const floors = [evidence` 1345。

---

## B4 — 売り手の面と、観測・証明のパイプライン

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B4-1 | `curl -sL -D - -o /dev/null https://vet402.com/api/tokyo/seller \| grep -i '^payment-required' \| cut -d' ' -f2 \| tr -d '\r' \| base64 -d \| jq -r '.accepts[0].network, .accepts[0].extra.name'` | `eip155:84532` / `USDC` | ✅ **パイプライン全体を実在の 402 で実測**（`https://globalrules-api.onrender.com/api/v1/countries` に当てて `eip155:8453` / `USD Coin` が返った）。vet402 の route はまだ 404 |
| B4-2 | `grep -rn 'signTypedData\|PRIVATE_KEY' $WT/src/app/api/tokyo \| wc -l` | `0` | ✅ 形を実測（`~/vouch/src/app/ethonline` に当てて `0`） |
| B4-3 | `node $DEMO/src/observe.ts --limit 3 2>&1 \| grep -c 'addr: (none)'` | `3` | # 実装後に有効 |
| B4-4 | `cd $DEMO && node --test --test-reporter=spec test/observe-attester.test.mjs 2>&1 \| grep -E '^ℹ fail'` | `ℹ fail 0` | # 実装後に有効 |
| B4-5 | `curl -sL 'https://vet402.com/api/v1/resources/b4a1c90393f123b1c02f7986312a1cc1dba2569477191ca0fbbed9d2e6756be8/decision?role=payer' \| jq -r '.recommendation'` | `ALLOW` | ✅ `ALLOW`（場面1の第一候補 GlobalRules。鍵なしで読めた） |
| B4-6 | `curl -sSL -m 20 -X POST https://base-mainnet.public.blastapi.io -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x2c84f0f93929eb91eb17546ac6ea5518485d1aac3657e92215805e5a2c44cb45"]}' \| jq -r '.result.status, .result.blockNumber'` | `0x1` / `0x310bdda` | ✅ `0x1` / `0x310bdda`（＝51,428,826。`CANDIDATES.md` と一致） |
| B4-7 | `curl -sSL -o /dev/null -w '%{http_code}\n' -m 40 https://globalrules-api.onrender.com/api/v1/countries` | `402` | ✅ `402`（場面1の売り手は今も live） |

---

## K1 — 鍵・リゾルバ・約束（人が打つ）

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| K1-1 | `node $DEMO/src/run.ts census vet402.eth seller-a.eth seller-b.eth seller-c.eth` | 1行 `K1 ok: …` | # 実装後に有効 |
| K1-2 | `curl -sL "https://base-sepolia.blockscout.com/api/v2/transactions/$SEED_TX" \| jq -r .status` | `ok` | ✅ **API の形を実在の tx で実測**（`0x0e779bbd…1747` → `ok`）。**未知の tx は HTTP 404 で本文 `{"message":"Not found"}`・`jq -r .status` は `null`** を返すので、`ok` との一致で判定する |

---

## B5 — testnet で買い、証明を置く

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B5-1 | `node $DEMO/src/attester.ts --names seller-a.eth,seller-b.eth,seller-c.eth --live-pay` | 3 tx | # 実装後に有効・**人が打つ** |
| B5-2 | `for tx in $(cat $DEMO/out/attester-tx.txt); do curl -sL "https://base-sepolia.blockscout.com/api/v2/transactions/$tx" \| jq -r .status; done` | `ok` ×3 | # 実装後に有効（API の形は K1-2 で実測✅） |
| B5-3 | `node $DEMO/src/admin.ts publish-attestations --live` | — | # 実装後に有効・**人が打つ** |
| B5-4 | `node $DEMO/src/run.ts verify seller-a.eth seller-b.eth seller-c.eth` | 1行 `verify ok: 3/3 VALID, 7/7 steps ok, format: ensip29-draft v1` | # 実装後に有効 |
| B5-5 | `node $DEMO/src/observe.ts --check --resource-id b4a1c903…6be8` | 全項目 `match` | # 実装後に有効（`--resource-id` の値は B4-5 で実在を確認✅） |

---

## B6 — ENSIP-29 を支払いの関門に差し込む

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B6-1 | `cat $SDK/test/tokyo-*.test.mjs \| grep -cE '^test\("(T\|U)[0-9]+'` | 49 以上 | ✅ 形を実測（B1-3 と同じ） |
| B6-2 | `cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/*.test.mjs 2>&1 \| grep -E '^ℹ fail'` | `ℹ fail 0` | # 実装後に有効 |
| B6-3 | `ls $SDK/test/tokyo 2>/dev/null \| grep -c test.mjs` | `0` | ✅ 形を実測（欠損ディレクトリで `0` を出力。**exit は 1 なので数字を読む**） |
| B6-4 | `git -C $WT diff origin/main -- packages/sdk/src/pay-or-refuse.ts skills/pay-or-refuse/SKILL.md` | 人が読む | # 実装後に有効 |
| B6-5 | `(cd $WT && bash scripts/push-main.sh --full; echo "exit=$?")` | `exit=0` | # 実装後に有効 |

### ✅ 語彙の表を強制しているテストの実測（B6 の完成の定義 7 の裏取り）
- `tests/agent-skill-plugin.test.ts`（`origin/main` で確認）: `skills/pay-or-refuse/SKILL.md` の理由コード表を `^\| \`([a-z0-9_]+)\` \|` で読み、
  **`PAY_REFUSE_REASONS ∪ MCP_REFUSE_REASONS ∪ 実装が足す語` と過不足なく一致**を要求する（`missing` も `extra` も空でなければ赤）。
  → **新語 17 個の行を同じコミットで足さないと root の `npm test` が赤になる。**
- `tests/caller-policy-sdk-parity.test.ts` V3: `pay-or-refuse.ts` の `refuse(\s*\[[^\]]*\])` に**文字列リテラル**として渡る語が全部 `PAY_REFUSE_REASONS` にあること。
- 同 V2・V4・V5: **サーバ側**の `CALLER_POLICY_REASONS`・`docs/openapi.yaml` の enum・`vocabulary.ts` の policy 語が**互いに一致**。
  → **今回の新語をサーバ側に足してはいけない。**足すと V2（「宣言だけあって実装が出さない語」）で赤になる。

---

## B7 — 場面2・3 の通し

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B7-1 | `node $DEMO/src/run.ts scene3 --dry-run \| tail -1` | 1行 `scene3 ok: …` | # 実装後に有効 |
| B7-2 | `node $DEMO/src/run.ts pay seller-a.eth --live` ほか（ORDERS B7 の13行） | 各期待 | # 実装後に有効・**`--live` は人が打つ** |

---

## B8 — live demo の面

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B8-1 | `curl -sL -o /dev/null -w '%{http_code}\n' https://vet402.com/tokyo` | `200` | ✅ 打てた。**今は `404`**（B8 の前なので期待どおり） |
| B8-2 | `curl -sL 'https://vet402.com/api/tokyo/verify?name=seller-a.eth' \| jq -r '.trace \| length, .ok, .format'` | `7` / `true` / `ensip29-draft` | # 実装後に有効 |
| B8-3 | `grep -rn 'signTypedData\|PRIVATE_KEY' $WT/src/app/tokyo $WT/src/app/api/tokyo \| wc -l` | `0` | ✅ 形を実測（B4-2 と同じ） |

---

## B9 — 撮影

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B9-1 | `ls ~/Movies/tokyo-raw/scene2*.mov ~/Movies/tokyo-raw/scene3*.mov \| wc -l` | 2 以上 | # 撮影後に有効（`~/Movies/tokyo-raw/` はまだ無い） |
| B9-2 | `ls ~/Movies/tokyo-raw/*.mov \| wc -l` | 4 以上 | # 撮影後に有効 |

---

## B10 — 動画の編集と提出文の下書き

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B10-1 | `ffprobe -v error -show_entries format=duration -of csv=p=0 ~/Movies/tokyo.mp4` | 120〜240 | # 書き出し後に有効（`ffprobe` 8.1.2 は在る✅） |
| B10-2 | `ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 ~/Movies/tokyo.mp4` | 720 以上 | # 書き出し後に有効 |
| B10-3 | `ls $WT/docs/tokyo-2026/audit/2026-09-26-1900-*.md \| wc -l` | `2` | # 実装後に有効 |

---

## B11 — 提出文の確定と凍結

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| B11-1 | `grep -cwi 'we' $WT/docs/tokyo-2026/SUBMISSION.md` | `0` | ✅ 形を実測（`We built it.` / `website` の2行に当てて `1`＝単語境界が効いている） |
| B11-2 | `grep -c '—' $WT/docs/tokyo-2026/SUBMISSION.md` | `0` | ✅ 形を実測（em ダッシュを含む行で `1`） |
| B11-3 | `git -C ~/vouch fetch origin && git -C ~/vouch log --since='2026-09-26 20:00' --oneline origin/main -- packages src \| wc -l` | `0` | ✅ `0`（構文確認。09-18 時点では当然 0） |
| B11-4 | `git -C $WT log --format=%s pre-tokyo-2026..origin/main -- $TOKYO_PATHS \| LC_ALL=C grep -c '[^ -~]'` | `0` | ✅ 形を実測（`origin/main~20..origin/main` に当てて `0`）。**`grep -cP` の代替** |

---

## 09-27 — 最終検査と提出

| # | コマンド | 期待 | 空打ち |
|---|---|---|---|
| F-1 | `rm -rf /tmp/t && git clone --depth 50 https://github.com/kzmttkc/vet402 /tmp/t && (cd /tmp/t && bash scripts/judge-check.sh; echo $?)` | `0` | ✅ **clone は実測**（1.8 秒・`scripts/judge-check.sh` が在ることを確認）。`judge-check.sh` の実走は `npm ci` を4回走らせるので打っていない |
| F-2 | `git -C ~/vouch log --oneline pre-tokyo-2026..origin/main -- $TOKYO_PATHS` | 請求するコミット | ✅ 形を実測（`origin/main~20..origin/main` で 0 行） |
| F-3 | `git -C ~/vouch diff --name-only pre-tokyo-2026..origin/main -- $TOKYO_PATHS \| grep -c rwa` | `0` | ✅ `0`（**exit は 1。数字を読む**） |
| F-4 | `git -C ~/vouch log --format=%s pre-tokyo-2026..origin/main -- $TOKYO_PATHS \| LC_ALL=C grep -c '[^ -~]'` | `0` | ✅ `0` |
| F-5 | `curl -sL 'https://vet402.com/api/tokyo/verify?name=seller-a.eth' \| jq -r .ok` | `true` | # 実装後に有効 |
| F-6 | `git -C ~/vouch fetch origin && TZ=Asia/Tokyo git -C ~/vouch log -1 --date=iso-local --format=%cd origin/main` | 09:00 より前 | ✅ `2026-09-18 07:02:38 +0900` |
| F-7 | `curl -sL -o /dev/null -w '%{http_code}' https://vet402.com/tokyo` | `200` | ✅ 打てた（今は `404`） |

---

## 打てなかったコマンドの理由（22 本）

| 理由 | 本数 | 中身 |
|---|---|---|
| **参照先をこれから作る**（`$DEMO/src/*.ts`・`$SDK/src/ens-*.ts`・`$SDK/test/tokyo/*`・`$MCP/test/tokyo/*`） | 13 | B0-12〜14・B1-4・B2-2・B4-3・B4-4・B5-1〜5・B7-1・B7-2 |
| **これから出す URL**（`/tokyo`・`/api/tokyo/verify`・`/api/tokyo/seller` の 402 本体） | 3 | B4-1 の本体・B8-2・F-5（HTTP コードだけは打てた） |
| **`~/vouch-tokyo` と `pre-tokyo-2026` が 09-25 に作られる** | 3 | B0-15・B3-3・B6-4 |
| **打つと副作用がある**（push・npm ci ×4・撮影ファイル） | 3 | B3-4・B6-5・F-1 の実走 |

**「パスの綴り違い」と「command not found」は 0 本。**すべて「対象がまだ無い」ことだけが失敗の理由になる状態にしてある。
`AGENT_PROMPTS.md` §13 のとおり、受け取ったエージェントは着手の返信で判定コマンドを1回空打ちし、この性質が保たれているかを返すこと。

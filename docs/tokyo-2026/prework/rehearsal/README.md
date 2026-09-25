# tokyo-2026 / rehearsal — 会期の予行演習

ETHGlobal Tokyo 2026 の会期初日（B0）と 09-24 の卓上作業で、**そのまま走らせて合否を判定する**一式。

読み取りしかしない。署名も送信もしない。秘密鍵も API キーも要らない。
使う JSON-RPC は `eth_call` / `eth_simulateV1` / `eth_getLogs` / `eth_getCode` / `eth_gasPrice` と、
そのための `eth_blockNumber` / `eth_getBlockByNumber` / `eth_getBalance`（B0 の残高確認）だけ。

## 使い方

```bash
npm ci            # 初回だけ。依存は viem のみ
node run.mjs --all
```

**どこから打ってもよい。**パスはこのファイルからの相対で解くので `cd` は要らない。

```bash
npm ci --prefix /絶対パス/rehearsal && node /絶対パス/rehearsal/run.mjs --all
```

個別に打つとき:

```bash
node run.mjs --h13     # U7 共有レジストリ経由の別名（setSubregistry）
node run.mjs --k1      # K1-01〜K1-15（＋K1-03b）と命題3・4 の読み取り
node run.mjs --b0      # 会期開始直後の最終確認（名前・RPC・資金・草案・面）
node run.mjs --gas     # 鍵ごとのガスの再測と関門（**--all には入らない**。遅い）
node run.mjs --all --json   # 表を出さず、1行 JSON だけ
```

### 終了コード（これで合否を見る）

| code | 意味 | 会期での動き |
|---|---|---|
| `0` | 全部期待どおり | そのまま次へ |
| `2` | 期待と違う項目がある | 表の差分行を読む。`first_diff` が 1 行 JSON にも入る |
| `1` | 読めない（RPC・ネットワーク・例外） | RPC を替えて打ち直す。**不合格ではない** |

`2` と `1` を混ぜない。`1` は「測れなかった」であって「落ちた」ではない。

**SKIP**（3つ目の状態）: 「まだ測れない」。いまは `gas_budget` の `W_op` だけで、
**会期中に `keys.ts init` が作るまでアドレスが存在しない**（`TOKYO_W_OP_ADDRESS`）。
表に `SKIP` と出て 1行 JSON の `skipped` に載るが、`--all` の終了コードは落とさない。
**会期の関門はこちらではなく `node ~/hackathon-monitor/preflight-tokyo.mjs`** で、
あちらは 3鍵とも `ok` でなければ exit 2 を返す（PLAN §6.2 の B0）。

## ガスの関門（数字はここ1か所）

`lib/gas-budget.mjs` だけが `GAS_BUDGET`（W_vet 4,200,000 ／ W_ens 4,800,000 ／ W_op 3,300,000）と
安全係数・床・BS-03 の額を持つ。読むのは2つだけ:

| 読む側 | どう読むか |
|---|---|
| `checks/b0.mjs`（`node run.mjs --b0`） | `import { readGasBudget } from '../lib/gas-budget.mjs'` |
| `~/hackathon-monitor/preflight-tokyo.mjs` | `~/hackathon-monitor/gas-budget.mjs`（**転送だけ・数字を持たない**）経由 |

転送側が正典を見つけられないときは `TOKYO_GAS_BUDGET`（ファイル）か `TOKYO_REHEARSAL_DIR`（`rehearsal/`）で指す。
**数字を写して 2 か所に置かない。**§4 の表・B0 の判定・preflight が割れる。

```bash
# 単体でも打てる（1行 JSON・exit 0/2/1）
W_VET=0x502B… W_ENS=0xC0f5… TOKYO_W_OP_ADDRESS=0x… node lib/gas-budget.mjs
TOKYO_BS03_SENT=1 …   # BS-03（W_ens → W_op 0.05 ETH）を打ち終えたら W_ens の取り置きを外す
```

## RPC の差し替え

既定は A3 で 20/20 を取った組＋予備の3本目。

```
https://sepolia.rpc.sentio.xyz
https://rpc.sepolia.ethpandaops.io
https://0xrpc.io/sep
```

環境変数で替えられる:

```bash
SEPOLIA_RPCS='https://a,https://b' node run.mjs --all   # 丸ごと差し替え
RPC_S=https://a RPC_P=https://b RPC_3=https://c node run.mjs --all   # 1本ずつ
RPC_URL=https://a node run.mjs --k1     # この回だけ 1 本に固定
FIXB=11734203 node run.mjs --h13        # ブロックを固定（既定は head-3）
BASE_SEPOLIA_RPC=... BASE_MAINNET_RPC=...   # B0 の Base 側
TOKYO_EVENT_START=2026-09-26T06:30:00Z      # B0 の /tokyo の期待を 404→200 に切り替える時刻
```

`--h13` と `--k1` は 1 本目が読めなければ 2 本目、3 本目へ自動で回る。

**`eth_simulateV1` を出さない RPC がある**【実測 2026-09-19】:

| RPC | 読み取り | `eth_simulateV1` |
|---|---|---|
| `sepolia.rpc.sentio.xyz` | OK | **OK** |
| `0xrpc.io/sep` | OK | **OK** |
| `rpc.sepolia.ethpandaops.io` | OK | **NG** `-32601 method ignored by upstream`（25 秒かけて落ちる） |

A3 で決めた 20/20 の組（sentio ＋ ethpandaops）のうち、`--h13` と `--k1` を打てるのは **sentio 1本だけ**。
予備は **3本目の `0xrpc.io/sep`**。`SIM_RPC_LIST` は ethpandaops を最後に回すので、
sentio が落ちても `0xrpc.io/sep` で通る（実測: 同じ結果・exit 0・5〜6 秒）。
`SIM_RPCS=...` で simulate 用だけ別に指定できる。

## 中身

```
run.mjs              入口。合否判定と終了コードはここだけ
package.json         type: module・依存は viem のみ
lib/common.mjs       共通の読み取り処理（元 e15/lib.mjs）＋ **名前に置く文字列の正典**
                     （`mkOffer` 266B・`mkPolicy` 178B・`ENVELOPE_B64` 108ch。checks/ はここから取る）
lib/abi/*.json       ABI 8 本（元 ur/abi/new_*.json。bytecode を落として abi 配列だけにした）
checks/h13.mjs       H13 / U7
checks/k1.mjs        K1（元 hw/src/h1_k1.mjs）
checks/b0.mjs        B0（元 monitor/preflight-tokyo.mjs）＋ ガスの関門 gas_budget
checks/gas.mjs       鍵ごとのガスの再測と関門（元 guards/gas.mjs ＋ guards/sellerd.mjs）
lib/gas-budget.mjs   **関門の数字の正典**（依存なし。preflight もここを読む）
checks/ens_names.mjs 名前と配備の確認（元 monitor/ens-names.mjs。b0 から import する）
expected/h13.json    h13 の期待値（54 行）
expected/k1.json     k1 の期待値（49 行）
checks/legacy/       調査のときの一回きりのスクリプト。パスだけ直してある。合否は持たない
checks/legacy/guards/  元 guards/*.mjs（b5b・fee・envgraph・sellerd・gas）。lib.mjs は
                       lib/common.mjs への薄い転換で、**絶対パスを持たない**
out/                 各スクリプトの書き出し先
tools/selfcheck.mjs  構文・import・読むファイルの実在・絶対パスの残りを見る（ネットワークに出ない）
```

`checks/legacy/` は**関門ではない**。`run.mjs --all` はここを走らせない。
会期中に読み返す用に、動く形で置いてあるだけ。

## 期待値の更新

鎖の状態が意図して変わったとき（＝ K1 を本当に打った後など）だけ:

```bash
node run.mjs --all --record
```

`expected/*.json` を今の実測で上書きする。**会期中に差分を消すために打たないこと。**
差分が出たら、まず「何が変わったか」を読む。

## 合否に使わないもの

- **gas**: 鎖の状態で動く。表には出すが突き合わせない（`--gas` の関門だけは別。**予算との大小**を見る）
- **ブロック番号・タイムスタンプ**: 毎回変わる
- `checks/legacy/` の出力

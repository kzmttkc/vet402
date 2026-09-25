# 実装エージェント用 共通前置き（ETHGlobal Tokyo 2026・A9）

作成 2026-09-18。**この文書を、B0〜B11 のどの発注文よりも先に、逐語で貼る。**
発注文だけを渡してはいけない。ここに書いた禁止と定型が、発注文の本文から省いてある。

---

## 0. 最初に名乗る規律

- **進捗も最終報告も日本語で書く。** コード・パス・コマンド・エラー・英語の提出文は原文のまま。
- 報告は結論先行の短文。作業実況・手順の復唱・自分の思考過程は書かない。
- 数字を出すときは、その数字を出したコマンドを1行そえる。打っていないものは **【未確認】** と書く。推測を断定に混ぜない。
- 分からないことは止まって聞く。**勝手に方針を変えない。**発注文と食い違う実装をしたら、報告の冒頭1行で「発注と違う所」を先に書く。

## 1. 会期の規約（破ると失格）

- **コードは 2026-09-25 21:00 JST より前に1行も書かない。**（git 操作・依存の導入・読み取りスクリプトはコードではない）
- 境界タグ `pre-tokyo-2026` より前の commit は請求しない。会期の作業はすべて `tokyo-2026` ブランチから `main` へ。
- **`/rwa` 系のパスに1バイトも触らない**（別のハッカソンの請求範囲）:
  `packages/rwa` `src/app/rwa` `src/app/api/v1/rwa` `src/app/api/v1/wallets/[address]/rwa` `fixtures/rwa` `docs/rwa` `src/lib/db/rwa-schema.ts` `drizzle-rwa.config.ts`
- **提出後（09-27 の submit 以降）は提出リポのコードを1行も変えない。**本番の不調も見張るだけ。
- AI 音声・スマホ撮影は不可。動画は 2〜4 分。
- AI の利用は `AI_USAGE.md` で明示する（§5）。

## 2. 件名と commit

- 1コミット＝1目的。**`git add -A` を使わない。**`git add <path>` の前に必ず `git diff <path>` を読む。
- 件名は**英語**・接頭辞 `tokyo:`・72字以内。本文は日本語でよい。
  ```
  tokyo: test(sdk): red tests for ENSIP-29 offer attestations
  tokyo: feat(sdk): verify ENSIP-29 attestations before the decision fetch
  tokyo: docs(tokyo-2026): disclosure of the pre-window ENS registrations
  ```
- **金の経路のコミットは、本文に「人が diff を読んだ時刻」を1行入れる**:
  `Human diff review: 2026-09-26 11:42 JST (Takeshi)`
- 判定（会期中に打つ）: `git log --format=%s pre-tokyo-2026..origin/main -- $TOKYO_PATHS | grep -vc '^tokyo: '` → `0`

### 日本語が件名に混ざっていないかの検査（**macOS の grep は `-P` を持たない**）
```bash
# 使ってはいけない（macOS の /usr/bin/grep は invalid option -- P で exit 2）
# git log --format=%s ... | grep -cP '[\x{3040}-\x{30ff}\x{4e00}-\x{9fff}]'
# 使う:
git -C "$WT" log --format=%s pre-tokyo-2026..origin/main -- $TOKYO_PATHS | LC_ALL=C grep -c '[^ -~]'   # → 0
```

## 3. main への入れ方

- **main へ入る道は1つだけ**: `(cd "$WT" && bash scripts/push-main.sh --full; echo "exit=$?")` → `exit=0`。
  直接 `git push origin main` を打たない。`--full` は root `npm test` まで走らせ、`ℹ fail 0` を4本（root / sdk / middleware / mcp）要求する。
- rebase が衝突したら**スクリプトは止まる。人が直す。**自分で `--continue` や `--abort` を打たない。報告して待つ。
- **夜間（人が寝ている間）に AI が main へ入れてよいパスは4つだけ**:
  `examples/tokyo-2026-demo` / `docs/tokyo-2026` / `src/app/tokyo` / `src/app/api/tokyo`
  （push すると vet402.com の本番に出る。それ以外は枝に置いて朝の受け入れを待つ）
- **金の経路**（`packages/sdk/src/pay-or-refuse.ts`・`packages/sdk/src/x402-pay.ts`・`packages/sdk/src/chain-profile.ts`・`packages/mcp-server/src/pay-if-trusted.ts`）は、
  **人が diff を読むまで main に入れない。**枝で完成させ、受け入れの時刻（B3 は 09-26 09:00–09:30、B6 は 11:30–12:00）に diff を出す。
- 新しい import は**必ずその package の `package.json` に依存として書く**。リポ直下の `node_modules` で解決させると手元は緑・CI は赤になる。
- npm 公開する場合の順は **SDK → MCP**（MCP の依存が `@vet402/sdk@^0.7.0`）。

## 4. 語彙の表を同じコミットで直す（テストが強制する）

`packages/sdk/src/pay-or-refuse.ts` の `PAY_REFUSE_REASONS` に語を1つ足したら、**同じコミットで**:

1. `skills/pay-or-refuse/SKILL.md` の理由コード表に `| \`新しい語\` | いつ出るか | 何をすべきか |` の行を足す。
   `tests/agent-skill-plugin.test.ts` が「PAY_REFUSE_REASONS ∪ MCP_REFUSE_REASONS ∪ 実装が足す語」と**過不足なく一致**を要求する（足りなくても余っても赤）。表の行は `^\| \`([a-z0-9_]+)\` \|` で読まれるので、**バッククォートと半角パイプの形を崩さない**。
2. `tests/caller-policy-sdk-parity.test.ts` の V3 が、`pay-or-refuse.ts` の `refuse([ … ])` に**文字列リテラルとして**渡る語がすべて `PAY_REFUSE_REASONS` にあることを要求する。変数から spread する語（`...ens.reason_codes`）はこの検査に掛からないが、SKILL.md の表には要る。
3. **サーバ側の `CALLER_POLICY_REASONS`・`docs/openapi.yaml` の enum・`src/lib/observatory/vocabulary.ts` は触らない。**
   今回の新語はすべて **SDK だけの語**（`price_above_declared` と同じ非対称）。サーバ側に足すと V2・V4・V5 が赤になる。

## 5. AI_USAGE.md と CHANGED_FILES

- **`AI_USAGE.md`（リポ root）**: "ETHGlobal Tokyo 2026" の**節を足す**。ETHOnline 2026 の既存の節は1行も書き換えない。
  人が握ったものとして必ず列挙する: 境界タグ／金の経路の diff の承認時刻／testnet の `--live` 実行／鍵の作成と ENS への書き込み（W_vet・W_ens の tx）／撮影と肉声／メンターとの会話／提出ボタン。
- **`docs/tokyo-2026/CHANGED_FILES.md`**: 手で表を書かない。次の出力をそのまま貼り、生成時刻と件数を添える。
  ```bash
  TOKYO_PATHS="packages/sdk packages/mcp-server examples/tokyo-2026-demo docs/tokyo-2026 skills/pay-or-refuse SKILL.md AI_USAGE.md src/app/tokyo src/app/api/tokyo tests/agent-skill-plugin.test.ts tests/caller-policy-sdk-parity.test.ts"
  git -C "$WT" diff --diff-filter=M --name-only pre-tokyo-2026..origin/main -- $TOKYO_PATHS
  git -C "$WT" diff --diff-filter=A --name-only pre-tokyo-2026..origin/main -- $TOKYO_PATHS
  ```
- **`COMMITS_EN.md` は作らない。**件名を最初から英語にすることで代える（§2 の検査）。
- **`docs/tokyo-2026/PROMPTS/`**: 1項目＝1判断・時刻・`反映:` 行。**人間の設計判断の抜粋だけ。**AI の失敗・叱責・やり直しの記録は入れない。
- **`.company/departments/hackathon/tokyo-2026/FINDINGS.md`（気づき帳）**: ENSv2・app.ens.dev・ENSIP-29 草案・参照実装で引っかかった所を、その場で1行ずつ足す（日時・対象・期待・実際・再現コマンドか tx・危険度・状態）。**送信はしない。**外部送信はオーナー承認が要る。

## 6. 秘密情報

- **秘密鍵・ニーモニック・API キーを、報告・commit・ログ・ファイル名に書かない。**アドレス（`0x…`）だけを書く。
- testnet の鍵は `$DEMO/.env.tokyo.local` にだけ置き、`chmod 600`。
  確認: `git -C "$WT" check-ignore -q examples/tokyo-2026-demo/.env.tokyo.local; echo $?` → `0`
- `.env*` を `git add` しない。commit の前に `git diff --cached --name-only | grep -c '\.env'` → `0`。
- **公開する面に署名器を置かない**: `grep -rn 'signTypedData\|PRIVATE_KEY' "$WT/src/app/tokyo" "$WT/src/app/api/tokyo" | wc -l` → `0`
- 会期後に `atst.vet402.eth` の addr を別の値に変えて testnet の証明を失効させる（後始末）。この手順を `docs/tokyo-2026/` に残す。

## 7. 資金

- **触ってよいのは testnet だけ**: Ethereum Sepolia・Base Sepolia。
- **本番（Base mainnet）の資金・鍵・支払い経路に触らない。**
  触ってはいけない実体: `src/lib/observatory/x402-payer.ts`・`src/app/api/cron/l1-purchase/`・`src/lib/observatory/kill-switch.ts`・購入元ウォレット `0xc9c7b38c0942914fc8ea12063bc92dcd3b581670`・本番の attest API。
- **本番の L1 購入を手で起こさない。**場面1は定期実行が既に買った分だけを読む（読み取りのみ）。
- `network` の既定は `"base"` のまま変えない。`network:"base"` と `payeeName` の組は `invalid_ens_chain` で throw のまま残す（本番では ENS 経路が構造上起きないことの担保）。
- faucet の請求・ウォレットでの署名・`--live` の実行は**人（Takeshi）の手番**。エージェントは calldata を組み、`--dry-run`（`eth_call` / `eth_simulateV1`）まで。

## 8. 英語の書き方（提出文・コード内コメント・件名）

- 主語は指す対象で決める。**人は `I`、システムは `vet402` か `it`。`we` を使わない。**
  検査: `grep -cwi 'we' "$WT/docs/tokyo-2026/SUBMISSION.md"` → `0`
- **em ダッシュ（—）を使わない。**検査: `grep -c '—' "$WT/docs/tokyo-2026/SUBMISSION.md"` → `0`
- セミコロンで文をつながない。相対時刻（"3 days ago"・"currently"）を書かない。**読まれる日（09-27）に正しい形**、つまり日付つきの過去形にする。
- 「ENS verified」と書かない。ENS が判定したように書かない。新しい ENSIP を名乗らない。
- 他作品との比較表を提出文に置かない。「2番目の証拠源」「補助」「任意」と自分で書かない。
- 引用する仕様は commit を名指しする: `ENSIP-29 draft (PR #85 at e00c345)`。
- 対外の日本語（もしあれば）は `humanizer-ja` skill を通す。

## 9. 差し戻しの基準（「すべて採用」をしない）

受け取った提案・監査結果・レビューは、次のどれかに当たれば**採らない。採らない理由を1行で書く。**

| # | 採らない |
|---|---|
| D1 | 軸 (i)(ii)(iii) のどれかを弱める（§0 の3軸は切り捨ての対象外） |
| D2 | 判定コマンドで合否が出ない（「良くなる」だけで、何をもって直ったかが無い） |
| D3 | 金の経路（`pay-or-refuse.ts`・`x402-pay.ts`・`chain-profile.ts`）を、人の diff 確認の時刻の外で変える |
| D4 | 本番の既定の挙動を変える（`network` 既定・本番 Base の throw・既存 62 本の SDK テストの期待値） |
| D5 | 審査員が触らない面の作り込み（内部の docs・整形・命名の統一・使われないユーティリティ） |
| D6 | 時間の見積りが、そのブロックの残り時間を超える |
| D7 | 一次で確かめていない主張に乗っている（外部 AI の文章・要約 md・記憶） |

**監査は2回まで。3回目は審査員が触る面（live demo・動画・提出文の冒頭3行）だけ。**

## 10. 成果物の置き場（tmp に置かない）

- **コード**: `~/vouch-tokyo`（worktree）→ `push-main.sh` で公開リポ `github.com/kzmttkc/vet402`。
- **計画・計測・監査・下書き**: private リポ `~/Takeshi_Automation` の branch `kabau-trust-board`、
  `.company/departments/hackathon/tokyo-2026/` 配下。**ブロックが終わるたびに commit・push する。**
  ```bash
  cd ~/Takeshi_Automation && git add .company/departments/hackathon/tokyo-2026/<file>
  git diff --cached --stat && git commit -m "tokyo-2026: <B番号> の結果" && git push origin kabau-trust-board
  ```
- **scratchpad と worktree は消える前提**（2026-09-16 に実際に消えた）。scratch にしか無い成果物を作らない。
- 各ブロックの終わりに**申し送りを3行**（何が終わった／次が触る所／残した穴）を
  `.company/departments/hackathon/tokyo-2026/HANDOFF.md` に追記して commit。

## 11. 環境（そのまま貼る）

```bash
WT=~/vouch-tokyo
SDK=$WT/packages/sdk
MCP=$WT/packages/mcp-server
DEMO=$WT/examples/tokyo-2026-demo
TOKYO_PATHS="packages/sdk packages/mcp-server examples/tokyo-2026-demo docs/tokyo-2026 skills/pay-or-refuse SKILL.md AI_USAGE.md src/app/tokyo src/app/api/tokyo tests/agent-skill-plugin.test.ts tests/caller-policy-sdk-parity.test.ts"
set -a; . $DEMO/.env.tokyo.local; set +a     # 鍵と RPC が要るコマンドの前に必ず
```

**判定コマンドは全部この完全パスで書く。**相対パスで書いた判定コマンドは受け取らない。

RPC は2系統に固定（2026-09-16 に各20回・20/20 一致・429 なし）:
```
ENS_SEPOLIA_RPC_URL=https://sepolia.rpc.sentio.xyz
ENS_SEPOLIA_RPC_URL_2=https://rpc.sepolia.ethpandaops.io
```
次点は sentio + `https://0xrpc.io/sep`。**publicnode は使わない**（getLogs を黙って落とす）。
`eth_simulateV1` は sentio だけが受ける（pandaops は受けない）。

## 12. ENSv2 Sepolia の確定値（2026-09-15 配備・2026-09-18 に2系統で実測）

| 何 | アドレス |
|---|---|
| Universal Resolver（入口・固定） | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` |
| UniversalHelper | `0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5` |
| Root Registry | `0x9703DBD26dAB89504490994138cF2c575251a9cE` |
| ETHRegistry | `0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E` |
| ETHRegistrar | `0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca` |
| PermissionedResolverImpl | `0x14F09Fd05d4585759e54844DC9B00147131Cf243` ← **このチェックサムで書く。小文字 `dc9b` 表記は viem が拒否する** |
| VerifiableFactory | `0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C` |
| MockUSDC (Sepolia) | `0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e` |

| 名前 | 持ち主 | 今のリゾルバ | 記録 ID |
|---|---|---|---|
| `vet402.eth` | W_vet `0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6` | R_vet `0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391`（専用） | 1 |
| `seller-a.eth` | W_ens `0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6` | `0x49f5022dDe516B92AC1609158bC6AdC772088055`（3名で共有） | 1 |
| `seller-b.eth` | 同 | 同（共有） | 2 |
| `seller-c.eth` | 同 | 同（共有） | 3 |

- 4名とも **addr が既定で書かれている**。text は4つとも空。
- `R_vet` の root 全ロールの保持者は **2者**: W_vet と app.ens.dev のスマートアカウント `0xE96b16ab865Aede373C6DE768b3943FA615f173f`。剥がす前は HCA が `setText` を通せる【実測・simulate】→ K1 の最初に `revokeRootRoles(ALL_ROLES, 0xE96b…173f)` を**1回**。
- **W_ens は EIP-7702 の委任つきアカウント**（code 23 byte）。「持ち主 = EOA」と書かない。
- K1 で作るリゾルバの予定アドレス（W_ens・salt 固定）: `P_a = 0xC54403186Db35B9D92cc393Ae665D3960117ac14`・`P_bc = 0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf`。
  **`P_bc` 前提で `seller-b` の記録 ID は 1、`seller-c` は 2。**（今の共有リゾルバに残すなら 2・3 になる）

### 新 ABI で間違えやすい所（E1〜E15 で実測済み）
1. `setText` / `setAddress` / `clearRecords` の代わり:
   `setText(bytes dnsName, string key, string value)` `0xc7279f88` ・ `setAddress(bytes dnsName, uint256 coinType, bytes addr)` `0xb4436dde`
   **setter は DNS 形式の名前を取る。namehash ではない。**
2. 委任は `grantSetterRoles(bytes setter, address account)` `0xccd3eaff`。**`setter` の名前の欄は読み捨てられ、セレクタとキーだけが使われる。**
   → 委任は「そのリゾルバ上の全ての名前 × そのキー」に効く。1つの売り手に絞るには**売り手専用のリゾルバを作るしかない**。
3. **`grantSetterRoles` を `initialize` の `calls` に入れると配備ごと revert**（`msg.sender` が VerifiableFactory になる）。配備の**後**に別 tx で打つ。
4. `setAlias` / `clearRecords` は無い。代わりに `linkToRecord(bytes dnsName, uint256 recordId)` `0x35378097`（`0` で切り離し＝**addr を含む全キーが一度に空**）と `linkToNode(bytes, bytes32)` `0x5d27b8e5`。
   **空の箱には `linkToNode` できない**（`InvalidRecord`）。順番の問題ではなく、箱が空なら常に出る。
5. 持ち主は `UniversalHelper.findExactOwner(dns(n))` `0x78b8187f`。**`findNearestOwner` は使わない**（未登録のサブ名で親の持ち主を返す）。
6. 読み取りは `UR.resolve(bytes name, bytes data)` だけ。リゾルバの直の view（`text(bytes32,string)`）は無い。
7. `grantRoles(resource, role, account)` は**持ち主でも常に revert**（`EACCannotGrantRoles`）。
8. イベントは**名前ではなく recordId に付く**: `TextUpdated(uint256 indexed recordId, string indexed keyHash, …)`・`Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)`。
   つなぎ替えでは `TextUpdated` が1本も出ない。`VersionChanged` は無い。
9. `IPermissionedResolver` の interfaceId は **`0x8c2427cc`**（旧 `0x91413117` は false）。
10. `docs.ens.domains/learn/deployments` は **2026-09-18 時点で 09-15 配備（`71a3b733`）に更新済み**【実測】。ただし ENSv2 の API ページは JS 描画で内容を機械で確かめられない【未確認】ので、**docs を根拠にしない。**チェーンから読む。

## 13. 受け取ったら最初に返すこと

発注文を受け取ったら、**着手の返信を1回だけ返す**（日本語・3行以内）:
1. 着手する（または、聞き返しが要る点を1つだけ）
2. 触るパスの一覧（発注文の「触ってよいパス」と一致しているか）
3. 終わりの判定コマンドを、そのまま1回空打ちした結果（まだ無いファイルなら「まだ無い」と1行）

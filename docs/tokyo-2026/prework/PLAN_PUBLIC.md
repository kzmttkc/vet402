# vet402 × ETHGlobal Tokyo 2026 — 会期前の計画（公開版）

この文書は会期前に書いた計画 `PLAN_v4.3` のうち、**§2 外部の事実／§3 作るものの全体像／§4 K1 の tx 一覧／§5 テスト／§10 用語と固定値**だけを切り出したもの。
**§1（勝ち条件と言い方）・§5.5（宿題）・§6（時間割）・§7（作業の優先順位）・§8（提出物の段取り）・§9（リスクの分岐）は入れていない。**理由は `PROMPTS/README.md` に書く。
この文書は `pre-tokyo-2026` タグの commit に含まれ、**請求の範囲の外**（pre-existing, not claimed）。

## 2. 外部の事実（すべて取得日と取り直しコマンドつき）

### 2.1 ENSv2 Sepolia のアドレス（2026-09-15 配備・2026-09-18 に2系統で実測）

| 何 | アドレス | 取得 |
|---|---|---|
| Universal Resolver（入口・固定） | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | 【実測 09-19】コード 2,491 バイト |
| UniversalHelper | `0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5` | 【実測 09-18・2系統】 |
| Root Registry | `0x9703DBD26dAB89504490994138cF2c575251a9cE` | 同上 |
| ETHRegistry | `0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E` | 同上 |
| ETHRegistrar | `0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca` | 同上 |
| PermissionedResolverImpl | `0x14F09Fd05d4585759e54844DC9B00147131Cf243` | 同上。**このチェックサムで書く**（`dc9b` 小文字表記は viem が拒否する【実測】） |
| VerifiableFactory | `0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C` | 同上 |
| UserRegistryImpl | `0xA80338aAA8D23831cEa25E858D1774534aBb0263` | 【実測 09-19】コード 18,841 バイト・`LABEL_STORE()` 一致 |
| LabelStore | `0x375C082021E677a40eA2AE094D050602dba90992` | 【実測 09-19】1,930 バイト |
| MockUSDC (Sepolia) | `0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e` | 【実測 09-18】 |

**取り直しコマンド**（B0・09-24 夜・毎朝 07:00）:
```bash
node $DEMO/src/probe-rpc.ts --deployment
# 期待: "deployment ok: ROOT=0x9703DBD2…a9cE (UR==UH), ethRegistry=0x657eA849…E09E, impl 0x8c2427cc=true"
node ~/hackathon-monitor/ens-names.mjs      # ROOT が変われば exit 2（配備し直しを RPC 不一致より優先して報告する）
```
**docs.ens.domains は根拠にしない。**09-18 時点で `learn/deployments` は 09-15 配備（`71a3b733…`）に更新済みだが【実測】、ENSv2 の API 解説ページは JS 描画で機械確認できない【未確認】。**チェーンから読む。**

### 2.2 新 ABI（09-15 配備・旧 ABI から変わった所だけ）

| 関数・イベント | セレクタ／topic0 | 注意 |
|---|---|---|
| `setText(bytes dnsName, string key, string value)` | `0xc7279f88` | **setter は DNS 形式の名前を取る。namehash ではない** |
| `setAddress(bytes dnsName, uint256 coinType, bytes addr)` | `0xb4436dde` | |
| `grantSetterRoles(bytes setter, address account)` | `0xccd3eaff` | **`setter` の名前の欄は読み捨てられ、セレクタとキーだけが使われる**（`resource = keccak256(key)`）。委任は「そのリゾルバ上の全ての名前 × そのキー」。**`initialize` の `calls` に入れると配備ごと revert**（`msg.sender` が VerifiableFactory）【実測・sim E12】 |
| `revokeRoles(uint256 resource, uint256 role, address account)` | `0xdfa70d8b` | 委任の取り消し |
| `linkToRecord(bytes dnsName, uint256 recordId)` | `0x35378097` | `0` で切り離し＝**addr を含む全キーが一度に空**。元の ID に戻すのは 1 tx |
| `linkToNode(bytes dnsName, bytes32 targetNode)` | `0x5d27b8e5` | **空の箱にはつなげない**（`InvalidRecord`）。順番の問題ではなく、箱が空なら常に出る【実測・sim E10】 |
| `UniversalHelper.findExactOwner(bytes name)` | `0x78b8187f` | 持ち主はこれで読む。**`findNearestOwner`（`0x4f50b731`）は使わない**（未登録サブ名で親の持ち主を返す） |
| `initialize((address,uint256)[] grants, bytes[] calls)` | `0x33cc44a0` | `grants` はすべて root（resource 0）に付く |
| `VerifiableFactory.deployProxy(impl, salt, initData)` | `0x5d84121a` | プロキシのアドレスは**送り手と salt だけ**で決まる（initData を変えても同じ）【実測・sim E4】→ `setResolver` を先に組める |
| `grantRoles(uint256,uint256,address)` | `0x7c300586` | **持ち主でも常に revert**（`EACCannotGrantRoles`） |
| `TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)` | `0x14cf4389d9a790cb32a054e033d7e3d3b78119dee4fea3c0983aac1db3f54015` | **イベントは名前ではなく recordId に付く** |
| `AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes)` | `0x5856fffa4d8f7605f45813e1cc223ac63a6fa1f09ca60f0e6a6525317bc7fa41` | |
| `Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)` | `0x66fd1d4edf16fc35ee08adaecfdf6fd5f75283da903b50f642558d6e0ba630ff` | `recordId=0` は切り離し。**つなぎ替えでは `TextUpdated` が1本も出ない** |
| `ResourceArgument(uint256 indexed resource, bytes arg)` | `0x92e004abe10c8757cf5990633f6f6e2a40d9b458d29c9dace3fc41c953b46fc2` | 初めて委任されたキーのときだけ。**キー名が平文で残る**ので `/tokyo` に「この鍵が書けるのは `x402-offer` だけ」をチェーンから表示できる |
| `ETHRegistry` の `ResolverUpdated`・`TransferSingle`・`TokenRegenerated`・`LabelRegistered` | 新旧で topic0 が一致 | |

- `IPermissionedResolver` の interfaceId は **`0x8c2427cc`** 【実測 2系統一致】
- 読み取りは `UR.resolve(bytes name, bytes data)` だけ。リゾルバの直の view は無い
- **取り直し**: `node $DEMO/src/probe-rpc.ts --deployment` の中で `impl.supportsInterface(0x8c2427cc)` を打つ。ABI 一式は `contracts-v2` の配備表から取り直す

### 2.3 ENSIP-29 草案（PR #85・head `e00c3453a4ce0fec8439e2aeeea4c47cb0604efe`）

- 状態【一次 09-18 20:1x 再取得】: **open・head は 09-14 の記録と同じ・本文 153 行・レビューコメント 0 件**。付いているのは編集者の番号予約（09-10 "All set — this proposal is now ENSIP-29. The number is reserved."）とファイル名変更の依頼だけ。**証明の形は変更なし**
- 使う逐語（行番号は `e00c345` の `ensips/xx.md`）:

| 項目 | 逐語 | 行 |
|---|---|---|
| 自己証明の扱い | "An attester SHOULD NOT issue an attestation for information that is self-validating or impossible to verify." | 42 |
| 信頼 | "Any key can sign an attestation for any record, and so a consumer MUST accept an attestation only from an attester that it trusts to verify that record type." | 44 |
| attester の名前 | "An attester MUST have an ENS name that resolves to its signing address." / "It is RECOMMENDED for attesters to run their attestation service under a dedicated subname, for example `atst.example.eth`." | 48 |
| payload | 5フィールド `n`（名前）・`a`（名前を管理するウォレットアドレス）・`k`（記録キー）・`v`（発行時の値）・`t`（Unix 秒）を canonical DAG-CBOR で | 56-64 |
| 署名 | "EIP-191 over the keccak256 hash of the encoded payload bytes" | 66 |
| envelope | CBOR tag `1635021684`（`0x61747374`＝`atst`）・`[ 1, <t>, <bytes 65> ]` | 68-76 |
| 最小の中身 | "The consumer reconstructs every other payload field from ENS data" | 78 |
| 置き場のキー | `attestations[RECORD_KEY][ATTESTER_NAME]`・"RECORD_KEY MUST match the attested record's key exactly." | 92-100 |
| 値の符号化 | hex（`0x` 前置）か base64。"A consumer MUST accept both, and MUST distinguish them by the presence of the `0x` prefix." | 104 |
| 検証手順 | 1 envelope → 2 manager → 3 記録の値 → 4 payload 再構成 → 5 keccak256＋EIP-191 で署名者復元 → 6 attester 名の解決 → 7 比較 | 110-118 |
| 失効の条件 | "The name transfers to a new manager." / "The attested record is removed or replaced." / "**The envelope is republished under a different ENS name.**" / "The attester rotates the address that its name resolves to." | 120-125 |
| 取り消し | "this standard defines no way to revoke a single attestation. A consumer that needs freshness can apply its own policy to the issuance timestamp `t`." | 129 |

- **草案が決めていないこと（この計画の解釈）**: `a` の CBOR 型（→ 20 バイトの bytes）／`n` の正規化（→ ENSIP-15）／EIP-191 の形（→ `"\x19Ethereum Signed Message:\n32" ‖ keccak256(payload)`）／追加フィールドの置き方（→ 使わない）／ENSv2 での "manager"（→ `UniversalHelper.findExactOwner(dns(n))`）
- **参照実装との食い違い**【一次】: `0xLighthouse/ens-metadata@07ded0e2` は envelope 版 **2**・payload キー `n,a,p,h,t`・hex だけ受理・4要素以上は拒否。**署名は草案の形に1つ決め、検証は両方読む**
  - `p` = **記録キー**（草案の `k` にあたる text）／`h` = **発行時の値の keccak256**（草案の `v` の生文字列にあたる 32 バイト bytes）【一次未確認・写しの解釈。Q2 で確かめるまでこの印を消さない】

**検証の実測（TM-3・2026-09-19・Sepolia block 11733999）**【実測】: 草案 110-118 の手順を逐語どおりに実装して回したところ、

| 何を | 結果 |
|---|---|
| 基準（何も変えない） | **VALID**（復元した署名者 = attester のアドレス） |
| `v` を1文字（`10000`→`10001`）／`payTo` の末尾1文字／`resource` の URL 1文字（`seller`→`sellet`）／空白を1つ足すだけ／記録が空になる | 各 **INVALID**（digest が変わり、復元される署名者が別アドレスになる） |
| `a` が別の持ち主に移る／`n` を別の ENS 名に貼り直す／`k` が違う／`t` が1秒違う／第三者の鍵で署名し直す | 各 **INVALID** |
| payload の大きさ | **282 バイト**（canonical DAG-CBOR・キー順 `a,k,n,t,v`） |
| envelope の大きさ | **79 バイト**（tag `0xDA 61 74 73 74` ＋ 3要素・署名 65 バイト。hex でも base64 でも同じ 79 バイトに戻る） |

→ **軸 (i)(ii) の主張は仕組みとして成立している**。10 件すべてが INVALID になることを U01〜U04 と T02・T04・T07 が固定する。

**取り直しコマンド**（09-24 夜と B0）:
```bash
gh api repos/ensdomains/ensips/pulls/85 --jq '.head.sha, .state, .merged'   # 期待: e00c3453… / open / false
gh api repos/ensdomains/ensips/pulls/85/files --jq '.[].filename'           # 期待: ensips/xx.md
gh api 'repos/0xLighthouse/ens-metadata/commits?path=packages/sdk/src/attestation.ts&per_page=1' --jq '.[0].sha'  # 期待: bfbaebf4…
```

### 2.4 RPC（2026-09-16 に各 20 回・20/20 一致・429 なし【実測】）

```
ENS_SEPOLIA_RPC_URL=https://sepolia.rpc.sentio.xyz
ENS_SEPOLIA_RPC_URL_2=https://rpc.sepolia.ethpandaops.io
ENS_SEPOLIA_RPC_URL_3=https://0xrpc.io/sep          # 予備（20/20）
```
- **publicnode は使わない**（同じ getLogs を 75 件中 5 件しか返さず、エラーも出さない【実測】）。Tenderly は 09-16 の負荷で 429 と `Request exceeds defined limit`【実測】
- **`eth_simulateV1` を出すのは sentio だけ**である。**読み取りの 20/20 の組（sentio ＋ ethpandaops）は、simulate の組ではない**【実測 2026-09-19】:

| RPC | `eth_call` などの読み取り | `eth_simulateV1` |
|---|---|---|
| `https://sepolia.rpc.sentio.xyz` | OK | **OK**（本命） |
| `https://rpc.sepolia.ethpandaops.io` | OK | **NG** `-32601 method ignored by upstream`。しかも **25 秒かけて落ちる** |
| `https://0xrpc.io/sep` | OK | **OK**（**simulate の予備はこれ**。sentio を落としても同じ結果・5〜6 秒【実測】） |

  → **ガスと simulate の結果は1系統の値である。2系統で照合できない**（`guards/GAS.md`）。**価格と残高は2系統で一致を確認する**【実測】。`rehearsal/` の `SIM_RPCS` / `SIM_RPC_LIST` は ethpandaops を最後に回すので、sentio が落ちても `0xrpc.io/sep` で通る
- **canary**: 自分の登録 `LabelRegistered`（ETHRegistry・`seller-a@11721545`・`seller-b@11721555`・`seller-c@11721565`・`vet402@11721578`）。K1 の後は自分の `grantSetterRoles` tx の `ResourceArgument` に差し替える
- 取り直し: `node $DEMO/src/probe-rpc.ts --repeat 5` → 期待 `"rpc ok: 5/5 match, head diff <= 1, canary … in both"`

### 2.5 名前の状態（2026-09-17 に取り直し済み・2026-09-18 に計数【実測 2系統一致・block 11730341】）

| 名前 | 持ち主（`findExactOwner`） | status | 今のリゾルバ | 記録 ID | 既定の addr | text |
|---|---|---|---|---|---|---|
| `vet402.eth` | W_vet `0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6` | 2 | R_vet `0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391`（専用） | 1 | W_vet | 空 |
| `seller-a.eth` | W_ens `0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6` | 2 | `0x49f5022dDe516B92AC1609158bC6AdC772088055`（**3名で共有**） | 1 | W_ens | 空 |
| `seller-b.eth` | 同 | 2 | 同（共有） | 2 | W_ens | 空 |
| `seller-c.eth` | 同 | 2 | 同（共有） | 3 | W_ens | 空 |
| **`seller-d.eth`** | **未登録** | — | — | — | — | — |

- 期限は 1821178728〜1821179124（2027-09 ごろ）・`isAvailable` は a/b/c の3つとも false
- **`seller-d.eth` は `isAvailable = true`**【実測 09-19・block 11,735,943】。**会期中に W_ens で登録する**（審査員ボタンの書き込み先・§3.7.1・§4 の K1-D1）。会期前に登録すると開示メールをもう1通書くことになるので**会期前には登録しない**
- **`.eth` の家賃は MockUSDC 払い**（`0x16f95D91…aA8e`・**8.000021 MockUSDC / 1年**）。**ETH 建ての `getRegisterPrice` は revert する**【実測】。W_ens の MockUSDC 残高は **968.304368**【実測 09-19】で足りる。`ETHRegistrar` の **`MIN_COMMITMENT_AGE` は 60 秒**なので `commit` と `register` は別ブロック（1分待ち）【実測】
- **root 全ロールの保持者は2者で、2人目は自分のウォレットが所有するスマートアカウント**【実測 09-24: `0xd45a2E00…A5D9` と `0xE96b16ab…173f` はどちらも 77 バイトのコントラクトで、`owner()` が W_ens／W_vet を返す・2系統一致】。**剥がさない。**名前ごとに書き手を分けたい場合は、名前ごとにリゾルバを配備する（この計画の設計）
- `ResourceArgument` はどのリゾルバも 0 件（キー単位の委任はまだ無い）【実測】
- **W_ens は EIP-7702 の委任つきアカウント**（code 23 バイト）【実測】。「持ち主 = EOA」と書かない
- `vet402.eth` の subregistry は `0x0`（まっさら）・W_vet の `hasRoles(ROLE_SET_SUBREGISTRY)` = true【実測 09-19】＝案A に追加の権限付与は要らない
- 取り直し: `node $DEMO/src/run.ts census vet402.eth seller-a.eth seller-b.eth seller-c.eth seller-d.eth`

### 2.6 場面1の売り手（第三者・上位5件。H5 で 2026-09-19 に取り直し【実測】）

**選び方の規律①（会期前の購入に固定する）**: 開示メールに「2026-09-17 の購入を見せる」と書いた以上、**当日の引き直しで会期中の mainnet 購入を選ばない**。09-26 12:10 UTC の引き直しは「**会期開始（2026-09-25 12:00 UTC）より前に settled した行**」だけを対象にする。下の5件はすべてこの条件で選べる【実測 09-19】。
**選び方の規律②**: 候補は**5件を同じ形式で用意し、当日 12:10 UTC に `export.csv` を引き直して5件から選ぶ**。

条件（買い手2人以上・L2 conform・Base 本番の購入 tx が `status 0x1`）を全部満たす候補は **12 件**。上位5件を採用する【実測 09-19】。

| 順 | 売り手 | 資源 | 価格 | 独立した買い手(30日) | 判定 | 当日の扱い |
|---|---|---|---|---|---|---|
| 1 | OnRamperX | `router.mudko.com/api/x402/route` | $0.005 | 11 | ALLOW(77)・payTo `0x5359…f7de`・amount 5000 | 一次候補（accepts は Base 1本のみ【実測】） |
| 2 | Wikipedia 要約 | `wiki.use.x402atlas.com/summary` | $0.005 | 10 | ALLOW(77)・payTo `0x6A70…DD36`・amount 5000 | **一次候補にしない**。live の 402 の `accepts` が **4本**（`eip155:8453`／`137`／`42161`／`solana:5eykt4Us…`）で、A2 で直した支払い経路の分岐（`rail="svm"`・`assertSvmPayer`・`sameAddress`）に直接当たる【実測 09-19】。使うなら `compareOfferToAccept` が4本から `eip155:8453` を選ぶところを **B5a より前に1回**通してから |
| 3 | GlobalRules | `globalrules-api.onrender.com/api/v1/countries` | $0.005 | 10 | ALLOW(81)・payTo `0x22c2…F8e2`・amount 5000 | 一次候補（accepts は Base 1本のみ【実測】）。**下の詳細表はこの売り手** |
| 4 | Security Headers | — | $0.010 | 11 | ALLOW・L2 conform | 次点 |
| 5 | Web Search | — | $0.010 | **29** | ALLOW・L2 conform | 次点（買い手が最多） |

3件とも `rules_version` は `2026-09-17.1`・`wash_dominated: false`・`offer_stability: stable`・`availability_7d` は mudko のみ 0.909【実測 09-19】。
**落選: ReloadPi**（`unique_payers_30d_real` が 1 ＝ 買い手が vet402 だけで、第三者性が立たない）。
**前提が崩れる兆候**【RECHECK S】: 09-13〜09-15 に起きた `payer_unfunded` での停止が再発すると 5 件とも settled にならず、場面1が成立しない。`preflight-tokyo.mjs` の **`payer_usdc` が 20 を割ったら場面1の前提が崩れる**（09-19 時点 200.18 USDC【実測】）。

**詳細（動画で見せる1件・GlobalRules `GET https://globalrules-api.onrender.com/api/v1/countries`**・$0.005・p50 1,429ms・availability_7d 1.0・`offer_stability: stable`）

| 項目 | 値【実測 09-18】 |
|---|---|
| resource_id | `b4a1c90393f123b1c02f7986312a1cc1dba2569477191ca0fbbed9d2e6756be8` |
| observatory_id | `9f2a69c8-782e-4542-9fce-00d0e7f552c0` |
| vet402 の判定 | `ALLOW` / `["l0_pass","l1_delivered","l2_conform"]` / rules_version `2026-09-17.1` |
| 届いた中身のハッシュ | response `0858c30197798f31…` ／ 宣言 `61bb7dec8e4bcfcf…`（照合して conform） |
| Base 本番の購入 tx | `0x2c84f0f93929eb91eb17546ac6ea5518485d1aac3657e92215805e5a2c44cb45`（block 51428826・status `0x1`・5,000 USDC units → `0x22c24Daf579629a6d7418e09e9C71E6C8883F8e2`）【執行側で再確認】 |
| 実在性 | 30日で実購入 33 件・**独立した買い手 10 人**・`wash_dominated: false` |
| 直近の購入 | **2026-09-17 12:09:57 UTC**（Tokyo のデモと同じ 12:00 UTC の回） |

- **台詞は固定**: 「今日買った」ではなく **「2026-09-17 12:09 UTC に買った。いま同じコマンドで再現できる」**。当日の回に入る保証は無い（固定ローテ 26 件・周期 6〜9 日で次は 09-23〜26【推定】）
- 落とした: `api.exa.ai/search`（払った後 16 回中 14 回 HTTP 400）・`api.vaults.fyi/v2/vaults`（mismatch → BLOCK。「止める」側の材料なので場面1に混ぜると逆の絵になる）
- 購入元 `0xc9c7b38c0942914fc8ea12063bc92dcd3b581670` の残高【実測 09-18】202.12 USDC / 0.0020 ETH
- 取り直し（**時刻はすべて JST**。09-25 朝に1回・**09-26 21:20 JST** に引き直して5件から選ぶ（**21:10 ではない**。12:00 UTC の回は行が出そろうまで 1.5〜2.5 分、最長 47 分かかった実測があるため・09-23 製品セッション）**・09-26 20:30 JST に `days=1` を1回）。**撮影（14:00–16:30 JST）より後の引き直しなので、場面1の台詞は 09-17 の購入で固定したまま変えない**（引き直しは「候補が今も ALLOW か」の確認だけに使う）:
```bash
curl -sL 'https://vet402.com/api/v1/resources/b4a1c90393f123b1c02f7986312a1cc1dba2569477191ca0fbbed9d2e6756be8/decision?role=payer' | jq -r '.recommendation'   # 期待: ALLOW
# 09-26 21:20 JST（12:00 UTC の回の完了後）。settled_at が 2026-09-25T12:00:00Z より前の行だけを残す（F-01）
curl -sL 'https://vet402.com/api/v1/observatory/export.csv?days=14' | awk -F, '$0 < "2026-09-25T12:00:00Z"' | head
curl -sL 'https://vet402.com/api/v1/observatory/export.csv?days=1' | head -1    # 09-26 20:30 JST に1回だけ
```

### 2.7 vet402 の現物（`~/vouch` origin/main `e8ff1eb`・2026-09-19【実測】）

**`d350540` → `e8ff1eb` に更新した**（1つ先の commit・cron の発火間隔の変更）。**`packages/sdk/src/pay-or-refuse.ts` はこの1コミットで1行も動いていない**【実測 `git diff --stat`】ので、§3.3.2 のアンカーはそのまま使える。§3.3.2 のアンカー 16 本は `5547fe55` と**同じ行**にあることを確認済み【実測】（163 / 200 / 225 / 288 / 271 / 628・634 / 751 / 820・917 / 925 / 975 / 1071 / 1079 / 1129 / 1244・1291・1345 / 63-64・478）。以後、行番号を写すときは `e8ff1eb` と書く。

| 事実 | 値 | 取り直し |
|---|---|---|
| SDK の版 | リポは `@vet402/sdk` **0.7.0**・実行時依存 0。**npm の latest は 0.6.0**（0.7.0 は未公開）【実測 09-19】 | `git -C ~/vouch show origin/main:packages/sdk/package.json` ／ `npm view @vet402/sdk version` |
| **`@vet402/tokyo-demo` は npm に無い（404）**【実測 09-19】 | 提出文の検証コマンドを npm 公開に依存させない（§3.8・§8.1）。`@vet402/mcp-server` は 0.3.0 | `npm view @vet402/tokyo-demo` |
| **vet402 に届かないときの現物の挙動** | **床を宣言しても `/api/v1/` へ毎回1回取りに行く。返らなければ `evidence_unavailable` で拒否する**（0.7.0 には「取りに行けなかったことを免除する」分岐が無い）【実測 TM-4】。会期で作る G1〜G10 がこの挙動を足す | §3.3.3 |
| `pay-or-refuse.ts` | **1,438 行**。差し込み位置は§3.3の grep アンカー表（**20 本**） | `git -C ~/vouch show origin/main:packages/sdk/src/pay-or-refuse.ts \| wc -l` |
| `input.payee` を読む箇所 | **`grep -n 'input\.payee'` は 7 行**当たる。そのうち**実際に置き換えるのは 4 か所**（`:630-631` の rail 判定・`:828` subgraph・`:955`/`:960` の payTo 照合・`:1135` の attest 本文）。残りは型・コメント・`invalid_payee_address` のメッセージ行。**判定コマンドは行番号の除外つきで書く**（§3.3.2） | `grep -n 'input\.payee' packages/sdk/src/pay-or-refuse.ts` |
| `PAY_REFUSE_REASONS` | 13 語（`pay-or-refuse.ts:163`） | `grep -n 'export const PAY_REFUSE_REASONS'` |
| 既存の床 | **`minL1Deliveries` と `minSubgraphReceipts` の2つだけ**（`:225`・`:230`）。会期で新設するのは `minChainReceipts` と `minEnsAttestations` の**2種類** | `grep -n 'minL1Deliveries?: number'` |
| 「免除するのは判定の中身であって判定が存在することではない」の規律 | `pay-or-refuse.ts:271`（`床を1つも宣言せずに`） | `grep -n '床を1つも宣言せずに'` |
| 名前を拒否する throw | `:628-637`（`invalid_payee_address` は `:634`）"ENS names are not resolved here — resolve it yourself" | `grep -n 'invalid_payee_address:'` |
| Base Sepolia で払えない制約 | `:478` `accept.network !== BASE_CHAIN` で落ちる・`:1079` `chainId: BASE_CHAIN_ID`（8453） | `grep -n 'accept.network !== BASE_CHAIN'` |
| 入力の形 | `PayOrRefuseInput = Base & ({account} \| {svm})`（`:318-319`）。`payee: string` は必須（`:326`） | `grep -n 'export type PayOrRefuseInput'` |
| `PayEvidenceSource` | 今は `"vet402" \| "subgraph"`（`:200`）。`"ens"`・`"chain"` を足す | `grep -n 'export type PayEvidenceSource'` |
| SKILL.md の語彙の表 | `skills/pay-or-refuse/SKILL.md` の**141-157 行**（17 語・見出しは 139 行）。`tests/agent-skill-plugin.test.ts` が SDK の語と**過不足なし一致**を強制 | `grep -n '^| \`' skills/pay-or-refuse/SKILL.md` |
| テスト本数 | **SDK 1,735 本・MCP 811 本・どちらも fail 0**【実測 09-19】 | `cd packages/sdk && npm test` |
| **App 側のテストの走らせ方** | **`npx tsx --test tests/*.test.ts`**。`tests/*.test.ts` の **174 本が `@/` のエイリアスを import する**ので、**素の `node --test` では解決できない**【実測】。`node --test` が走るのは `packages/*/test/*.test.mjs`（ビルド後の .mjs）だけ | `git -C ~/vouch show origin/main:package.json \| grep '"test"'` |
| **`~/vouch/node_modules` が空**【実測 09-19】 | `tsx` も入っていない。**会期の夜中に `npm ci` から始めない**（B0 の最初の行・§6.2） | `ls ~/vouch/node_modules \| wc -l` |
| **node の版が手元と本番でずれている** | 手元は **v26.3.0**、`engines.node` と CI と Vercel 本番は **24.x**（`tests/package-engines.test.ts` が 24 を強制）。nvm・fnm・`node@24` は手元に**無い**【実測 09-19】 | `node -v` ／ `git -C ~/vouch show origin/main:package.json \| grep -A2 engines` |
| `examples/tokyo-2026-demo` | **origin/main に存在しない**【実測 09-19】。B0 が最初に `package.json`（`"type":"module"`）から作る | `git ls-tree origin/main examples/` |
| `src/app/tokyo`・`src/app/api/tokyo` | **存在しない**【実測 09-19】。会期中に作る | `git ls-tree origin/main src/app/tokyo src/app/api/tokyo` |
| L1 購入の定期実行 | `/api/cron/l1-purchase` を `0 12 * * *` UTC（`vercel.json:48-49`）。09-16 UTC に settled 128 件・`spendingHalted=false`【実測】 | — |
| 売り手の URL | `https://vet402.com/api/tokyo/seller` は **404**（会期前に存在してはいけない） | `curl -o /dev/null -w '%{http_code}' …` |

### 2.8 会期と規約（09-14T05:06Z・09-18〜19 に再取得【一次】）

- 受付 09-25 13:00／開会 20:00／**Hacking Begins 21:00**／ENSv2 ワークショップ **09-25 15:00–15:20**（20 分。**09-26 ではない**。一次: ダッシュボードの画面3枚＋ `prizes` ページ "ENSv2 workshop: 3:00 PM JST, Friday, September 25"）／夕食 09-25 18:30・09-26 18:00／**提出締切 09-27 09:00 JST（遅れは受け付けない）**
- パートナー審査は提出物で行い**対面不要**: "Partners will judge submissions based on the project materials you submit … not required for partner judging"【一次 逐語】
- パートナー賞は最大3社（同じ社の複数枠は1社として数える）
- **使う枠**: ENS（$6,000＋$4,000 で**1社**）＋ Intercepta（Continuity $500 で**1社**）＝ **2社**。3社目は取りに行かない（§3.10）【一次 09-23 再確認: `ethglobal.com/rules` に「1作品あたりの上限」の条文は無く、上限はイベント側の情報ページの記載に拠る】
- **動画の自動 reject 条件**【一次 09-19 実測】: 2〜4 分の外／720p 未満／早送り／音楽＋字幕だけ／スマホ撮影／**AI 音声**。ライブ審査に進んだ場合は7分（デモ4分＋質疑3分）
- AI ツールは使ってよいが明示が必須。**"If you use one, you must include all spec files, prompts, and planning artifacts in your submission repository."**【一次 逐語】→ prework を**境界タグの前に** commit（§8.5）
- **版管理の規律**: 規約は「大きな単一コミットで履歴が無い提出」を既定で失格扱いにする【一次】。→ **`git mv` と中身の修正を1つのコミットにまとめない**（B1・B6）。**最小提出の web UI からの投入も複数コミットに分ける**（§9）
- Continuity: 既存コードを使ってよい。既存部分を明示し会期中の新機能を含める
- **Continuity の下位トラック**: `Extend Open Source` と `Ship a Feature` のどちらを選んだかを**提出時に画面で確認する**（09-16 の申込みの控えには残っていない【未確認】）
- **提出後〜審査中は請求パスに1バイトも触らない**（§9「起きたら止める」と同じ規律）。本番の不調も見張るだけ
- **Finalist は狙わない**。パートナー賞（ENS の2枠）に集中する。ライブ審査に呼ばれた場合だけ7分の台本（§8.2 の動画を4分に詰めた形）を使う
- 参加は確定【実測 09-16】: "You are fully confirmed to attend this event!"・Continuity Track 選択済み・**チームとプロジェクトは未作成**（09-25 21:00 直後に作る）

**09-19 に一次で潰した2つの疑い（どちらも今日読める本文には無い。保留のまま会場で1回だけ口頭確認する）**

| 疑い | 今日の一次【実測 09-19 13:0x】 | 扱い |
|---|---|---|
| 「イベントの FAQ が Continuity を否定している」（"we do not allow participants to work on pre-existing projects"・"judged solely on the work completed during the duration"） | `ethglobal.com/rules` の "Rules on Pre-existing Work" は逐語で「**Continuity track を選んだなら、そのトラックの規則に従って既存のコードベースの上に作ってよい**」と書き、`info/details` も同じ。`/events/tokyo2026/info/faq` は **404** | **別ページの古い FAQ を見た可能性として保留**。09-25 21:40 に受付で1回だけ口頭確認（記録は相手の役割と時刻だけ） |
| 「提出後も賞金が払われるまで作業してはいけない」（"until PRIZES have been officially paid out"） | 今日の `info/details` に該当語は **0 件** | 同じく保留・会場で確認。**規律としては §9「起きたら止める」の「提出後にコードを1行でも変えない」をそのまま守る**ので、答えが Yes でも行動は変わらない |

---
## 3. 作るものの全体像（モジュールごとに: パス・公開する関数と型・入出力・拒否語・依存）

### 3.0 全体図

```
呼び手（エージェント）
  └ AGENT_NAME=agent-1.vet402.eth
      │ (0) 自分の名前から方針を読む ……………… agent-namespace.ts
      │     （答えたリゾルバが P_AG1 でなければ agent_policy_missing・§3.5.3）
      ▼
  payOrRefuse({ payeeName: "seller-a.eth", network: "base-sepolia", ens: {...} })
      │ (1) 呼び出し側の誤り → throw（通信 0）
      │ (2) 上限（通信 0）
      │ (3) ★ENSIP-29 の段 2.5 …………………… ens-attestation.ts → ens-read.ts → atst-codec.ts
      │        ここで止まれば vet402 の API に fetch は 1 本も出ない
      │ (4) /decision → 宣言した証拠源 → 床 …… chain-profile.ts / 床 minEnsAttestations・minChainReceipts
      │ (5) 402 → ★約束と 402 の照合
      │ (6) payTo → 金額の関門 → 受取人スコア
      │ (7) ★署名直前に再検証（ENS を読み直す）
      ▼ 署名（x402-pay.ts・profile から chainId と EIP-712 domain を引く）
```

### 3.1 ENSIP-29 の検証 — `packages/sdk/src/atst-codec.ts`（新規）

| 項目 | 中身 |
|---|---|
| 依存 | **なし**（viem も使わない純関数） |
| 公開 | `ATST_TAG = 1635021684`／`type AtstProfile = "ensip29-draft" \| "atst-me-v2"`／`type AttestationPayload = { n: string; a: 0x${string}; k: string; v: string; t: number }`／`encodePayload(p, profile): Uint8Array`／`type DecodedEnvelope = { version: 1\|2; t: number; sig: 0x${string} }`／`decodeEnvelope(recordValue): DecodedEnvelope \| {error}`／`encodeEnvelope(e, "base64"\|"hex"): string`／`attestationKey(recordKey, attesterName): string` |
| 入出力 | DAG-CBOR の最小エンコーダ（text・bytes・uint・5キー map）。**キー順は長さ→バイト順**なので版1は `a,k,n,t,v`、版2は `a,h,n,p,t`。`a` は 20 バイトの bytes。envelope は tag `0xDA 61 74 73 74`＋3要素。`0x` で始まれば hex、それ以外は base64 |
| 版2（`atst-me-v2`）の中身 | `p` = **記録キー**（版1の `k`・text）／`h` = **発行時の値の keccak256**（版1の `v`・32 バイト bytes）【一次未確認・Q2 で確かめるまでこの印を消さない】。`encodePayload(p, "atst-me-v2")` は `k`→`p`・`v`→`keccak256(utf8(v))` に写す |
| 大きさ（実測の正解値） | payload **282 バイト**・envelope **79 バイト**（§2.3 の実測表）。U01 はこの2つの数も固定する |
| 拒否語 | `ens_attestation_malformed`（tag 違い・3要素でない・版が `profiles` に無い・署名が 65 バイトでない・4要素） |
| 失効の組み立て直しが効く理由 | 署名対象に `n`（名前）と `v`（値）が入るので、値を変えても名前を変えても復元される署名者が変わる【一次 草案 63・123 行】 |

### 3.2 ENS の読み取り層 — `packages/sdk/src/ens-read.ts`（新規）と `ens-reasons.ts`（新規）

| 項目 | 中身 |
|---|---|
| `ens-reasons.ts` | **import を1つも持たない**。`export const ENS_ATTESTATION_REASONS = [...] as const` と型だけ。`pay-or-refuse.ts` が静的 import しても viem が静的グラフに入らない |
| `ens-read.ts` の公開（**型を確定**） | `type EnsRpc = { readContract(a): Promise<unknown>; getBlock(a): Promise<{number: bigint; timestamp: bigint}>; getBlockNumber(): Promise<bigint>; getChainId(): Promise<number> }`（**viem の `PublicClient` はこの形を構造的に満たす。テストの偽物はこの4つだけを実装すればよく、キャストは要らない**）／`type EnsReadClients = { primary: EnsRpc; secondary: EnsRpc }`（別系統が必須）／`pinBlock(clients, maxHeadLagSeconds): Promise<{B: bigint; ts: bigint}>`／`readBoth<T>(fn: (c: EnsRpc) => Promise<T>): Promise<T>`（1バイトでも違えば throw）／`findExactOwner(clients, B, name): Promise<0x… \| null>`／`resolveText(clients, B, name, key): Promise<{ value: string; resolver: 0x… }>`／`resolveAddr(clients, B, name): Promise<{ value: 0x… \| null; resolver: 0x… }>`／`getState(clients, B, label): Promise<{ tokenId: bigint; status: number; latestOwner: 0x…; expiry: bigint }>` |
| **読み取りは `UR.resolve` に一本化する** | すべての記録の読み取りを `UniversalResolver.resolve(bytes name, bytes data) returns (bytes result, address resolver)` の生の `readContract` で行う。**viem の `getEnsText` / `getEnsAddress` / `getEnsResolver` は使わない**——戻り値の第2要素（**どのリゾルバが答えたか**）が §3.5 の罠の判定に要るため。E14 の実測（`blockNumber` を受ける・2系統一致・例外なし）は「`UR.resolve` を `blockNumber` つきで呼べる」ことの確認として残る |
| `resolveText` が**値とリゾルバを返す**理由 | 親の wildcard が子の記録を肩代わりしたとき、値だけ見ると「読めた」と見えてしまう。呼び手（`readAgentPolicy`）が**答えたリゾルバを見て拒否できる**ようにする（§3.5） |
| 段0（ブロックの固定） | 両系統の `chainId` が 11155111・`\|head₁−head₂\| ≤ 3`・`now − min(timestamp) ≤ maxHeadLagSeconds`（既定 120）・**`B = min(head₁, head₂)` を以後すべての読み取りに `blockNumber` で渡す**。同じブロックで **`UH.ROOT_REGISTRY() == UR.ROOT_REGISTRY()`**（違えば `ens_evidence_unavailable`） |
| 持ち主 | `UniversalHelper.findExactOwner(dns(normalize(n)))`。`.eth` の2LD なら `ETHRegistry.getState(labelhash).status == 2 && latestOwner == a` も照合。**`findNearestOwner` を呼ばない**（テストで呼び出し回数 0 を固定・T14） |
| 記録 | `UR.resolve(dns(n), <text/addr の calldata>)` だけ。**つながった箱の値が返る＝他の読者と同じ値**。リゾルバの直の view は無い。戻り値の `resolver` を必ず一緒に返す |
| 拒否語 | `ens_evidence_unavailable`（RPC 例外・2系統の不一致・head が古い・chainId 違い・ROOT の食い違い。`evidence_unavailable` を併記）／`ens_name_unresolved`（`findExactOwner` が `0x0`＝未登録・期限切れ・RESERVED・登録していない wildcard のサブ名） |
| 依存 | viem（`peerDependencies` に optional で `^2.55.1`）。使うのは `encodeFunctionData` / `decodeAbiParameters` / `keccak256` / `recoverMessageAddress` と、注入された `EnsRpc` の4メソッドだけ |
| **空の記録を「変更なし」と読まない** | 空は空として扱い、拒否に倒す |

### 3.3 支払いの関門への差し込み — `packages/sdk/src/ens-attestation.ts`（新規）と `pay-or-refuse.ts`（変更・**金の経路**）

#### 3.3.1 `ens-attestation.ts`

| 項目 | 中身 |
|---|---|
| 公開の型（**中身まで確定**） | 下のコード欄のとおり |
| 公開の関数 | `checkEnsOffer({name, resource, method, profile, clients, policy}): Promise<EnsOfferCheck>`／`assertEnsAttestationPolicy(p): asserts`（throw `invalid_attestation_policy`）／`compareOfferToAccept(o, a): ("payee_mismatch"\|"price_above_declared"\|"chain_or_asset_mismatch")[]` |
| `profile` の型 | **`ChainProfile`**（`chain-profile.ts` の `base-sepolia` の行そのもの）。`checkEnsOffer` が使うのは `profile.network`（`"eip155:84532"`・約束の `network` と照合）と `profile.asset`（Base Sepolia USDC・約束の `asset` と照合）の2つだけ。**Sepolia の 11155111 は `clients` 側の検査**（§3.2 段0）で、`profile` とは別物 |

```ts
// ---- packages/sdk/src/ens-attestation.ts（型の確定形）----
/** 売り手が名前に置く約束。値は JSON 1行（空白もそのまま署名される）。 */
export type X402Offer = {
  v: 1; resource: string; method: "GET" | "POST";
  network: "eip155:84532"; asset: `0x${string}`; amount: string /* 10進 uint */; payTo: `0x${string}`;
  output?: { required: string[] };   // L2 で見るキー（vet402 の checkL2 と同じ意味）
};
export type TrustedAttester = {
  name: string;                         // 例 "atst.vet402.eth"
  address: `0x${string}`;               // 固定（I6）。解決先と違えば ens_attester_unpinned
  recordKeys: readonly string[];        // この attester を信じる記録の種類（草案 44行）
  anchor?: { name: string; owner: `0x${string}` }; // 親の持ち主の固定（I6・任意）
};
export type EnsAttestationPolicy = {
  recordKey?: "x402-offer";
  trustedAttesters: readonly TrustedAttester[];
  minValid?: number;            // 既定 1。1..(recordKey を信じる attester の数)
  maxAgeSeconds?: number;       // 既定 86_400。60..604_800
  futureSkewSeconds?: number;   // 既定 300。0..900
  maxHeadLagSeconds?: number;   // 既定 120
  profiles?: readonly AtstProfile[];               // 既定 ["ensip29-draft"]
  sinceIssuanceScan?: false | { canary?: { address: `0x${string}`; blockNumber: bigint; txHash: `0x${string}` } };
  now?: () => number;           // テストの時計（秒）
};
export type AttestationStep = { step: 1|2|3|4|5|6|7; status: "ok" | "fail" | "skipped"; detail: Record<string, string> };
export type EnsOfferCheck = {
  ok: boolean; reason_codes: EnsAttestationReason[];
  name: string; node: `0x${string}`; chainId: 11155111;
  block: { number: bigint; timestamp: bigint }; heads: { primary: bigint; secondary: bigint };
  manager: `0x${string}` | null; offerRaw: string | null; offer: X402Offer | null; endpoint: string | null;
  attestations: Array<{ attester: string; profile: AtstProfile | null; t: number | null;
    recovered: `0x${string}` | null; expected: `0x${string}` | null; payloadHex: `0x${string}` | null;
    digest: `0x${string}` | null; valid: boolean; reason: EnsAttestationReason | null }>;
  trace: AttestationStep[];     // **常に長さ 7**（下の規則）
};
```

**`output.required` のキー名を決める（穴を閉じる・09-19 決定）**

v4.2 まで、`output.required` の中身は §8 の提出文に `["<key>", …]` と**穴のまま**書いてあるだけで、どこにも決まっていなかった。**この1つが決まらないと K1-04 と K1-07 の gas が ±23,000 ずつ動く**（約束 JSON が 32 バイト境界を跨ぐたびに新しい記憶枠が1つ増える。1 文字あたりは 12 gas【実測・`guards/GAS.md` §1】）。売り手の route はこちらが書くので、**先に決める。**

```
output.required = ["result", "observed_at"]
```

- **`src/app/api/tokyo/seller/route.ts`（B4a）は、この2キーを必ず本文の最上位に返す**。返さないと attester が段(4)で署名を拒む（§3.9 の attester の手順）
- この決定のもとで **`x402-offer` の1行 JSON は 266 バイト**、K1-04 は **575,239 gas**・K1-07 は **861,493 gas**【実測・sim block 11,735,920】。§4 の表はこの長さで測った値である
- **会期中にキー名を変えない。**変えると `resource` を変えたのと同じで全証明が失効し、K1-04/07 のガスも動く（§10.6 の禁止）

逐語（この文字列で測った。K1-04 の `calls` に入れるのはこれ）:

```
{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","amount":"10000","payTo":"0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6","output":{"required":["result","observed_at"]}}
```

**`trace` の段数の規則（曖昧を消す）**: `trace` は**常に 7 要素**で、`step` は 1..7 が1回ずつ昇順に並ぶ。途中で止まったら、止まった段が `"fail"`、**その後ろは全部 `"skipped"`**。「段数」という言い方をしない（`trace.length === 7` が不変条件で、`/tokyo` の「7段」表示と `run.ts verify` の `7/7 steps ok` はこの配列をそのまま数える）。草案の番号（1 envelope → 2 manager → 3 記録 → 4 payload → 5 復元 → 6 attester 解決 → 7 比較）と1対1。参照実装 playground（`verify-steps.ts:72-80`）は 1 owner→2 記録→3 envelope の順だが、**こちらは草案の順に揃える**。

**`assertEnsAttestationPolicy` の規則（1件でも外れたら throw `invalid_attestation_policy`。通信の前）**

| 欄 | 規則 |
|---|---|
| `recordKey` | 省略可。あれば `"x402-offer"` の1値のみ |
| `trustedAttesters` | 配列・**長さ 1 以上**。各要素の `name` は非空文字列で `.` を含む・`address` は `/^0x[0-9a-fA-F]{40}$/`・`recordKeys` は長さ 1 以上の文字列配列・`anchor` があれば `{name, owner}` の両方が上と同じ形 |
| `minValid` | 省略時 1。整数・`1 ≤ minValid ≤ (recordKey を recordKeys に含む attester の数)`。上回れば throw（**満たせない床を黙って抱えない**） |
| `maxAgeSeconds` | 省略時 86,400。整数・`60 ≤ x ≤ 604,800` |
| `futureSkewSeconds` | 省略時 300。整数・`0 ≤ x ≤ 900` |
| `maxHeadLagSeconds` | 省略時 120。整数・`30 ≤ x ≤ 600` |
| `profiles` | 省略時 `["ensip29-draft"]`。長さ 1 以上・要素は `"ensip29-draft"` か `"atst-me-v2"`・重複不可 |
| `sinceIssuanceScan` | 省略時 `false`。`false` か `{canary?}`。`canary` があれば `address`・`blockNumber`(bigint)・`txHash` の3つがそろっていること |
| `now` | 省略可。あれば関数 |
| 知らないキー | **1つでもあれば throw**（打ち間違いを黙って無視しない） |
| 手順（草案 110-118 に1対1） | **0** ブロック固定（§3.2）／**1** 信じる attester ごとに `resolveText(n, attestationKey(k, attester.name))` → `decodeEnvelope`／**2** `a = findExactOwner(dns(normalize(n)))`／**3** `v = resolveText(n, "x402-offer")`（空 → `ens_offer_missing`）と `agent-endpoint[x402]`／**4** `encodePayload({n,a,k,v,t}, profile)`／**5** `digest = keccak256(payload)`・`sa = recoverMessageAddress({message:{raw:digest}, signature})`／**6** `aa = resolveAddr(attester.name)`（null → `ens_attester_unresolved`／`aa ≠ attester.address` → `ens_attester_unpinned`。**比較の前に止める**）／**7** `sa === aa` なら有効・`t` の鮮度を当てる |
| 手順（続き） | **8** 有効数 ≥ `minValid`（既定 1）でなければ `ens_attestation_missing`／**9** `parseOffer(v)`（`ens_offer_malformed`）→ `offer.resource === resource`・`offer.method === method`・`endpoint === offer.resource`（`ens_offer_mismatch`）／**10**（既定オフ・任意）`sinceIssuanceScan` |
| 既定 profile | **`ensip29-draft`（envelope 版 1・payload `n,a,k,v,t`）**。`atst-me-v2` は `profiles` に明示したときだけ |
| 拒否語（13・`ens-reasons.ts`） | `ens_name_unresolved`／`ens_offer_missing`（`linkToRecord(name,0)` の後・リゾルバ差し替え後を含む）／`ens_offer_malformed`／`ens_offer_mismatch`／`ens_attestation_missing`／`ens_attestation_malformed`／`ens_attestation_signer_mismatch`／`ens_attestation_stale`／`ens_attester_unresolved`／`ens_attester_unpinned`／`ens_attester_anchor_changed`／`ens_record_changed_after_attestation`／`ens_evidence_unavailable` |
| 語の優先 | `ens_evidence_unavailable` > `ens_name_unresolved` > `ens_offer_missing` > attester ごとの語（集合で返す）> `ens_offer_malformed` > `ens_offer_mismatch` |
| 補助の走査 `ens-since-issuance.ts`（任意） | (a) `getRecordId(node)` を `t` のブロックと `B` で読み、違えば変更あり (b) `Linked` を topic2 = node で読む (c) `TextUpdated` を topic1 ∈ {(a) の recordId}・topic2 ∈ {`keccak256("x402-offer")`, `keccak256(attestationKey)`} で読む (d) `Upgraded` (e) 登録簿の `ResolverUpdated`（`t` と `B` の tokenId 両方）・`TransferSingle`・`TokenRegenerated`・`LabelUnregistered`。1000 ブロックずつ2系統＋canary |

#### 3.3.2 `pay-or-refuse.ts` への差し込み（**grep アンカーで場所を決める。行番号を写さない**）

行は 2026-09-19 に `origin/main e8ff1eb` で実測。**`d350540`・`5547fe55`・09-18 の `b4d1ae0` と同じ位置**【実測】。

**#17〜#20 を B3 の作業の先頭に置く。ここを直さないと場面2・3 が1回も動かない。**
`payOrRefuse` は `input.payee` を4か所で読む。`payeeName` だけを渡す呼び方を足すとき、#8（段 2.5）で `payee` を決めるだけでは足りない——**#17 で `rail` が `"svm"` に落ちて `assertSvmPayer` が throw し、#18 で `sameAddress(x, undefined)` が必ず `false` になって、名前だけの支払いは 100% `payee_mismatch` で終わる**【実測 `e8ff1eb`】。

| # | grep アンカー | 09-19 の行 | 入れるもの | いつ |
|---|---|---|---|---|
| 1 | `export const PAY_REFUSE_REASONS` | 163 | `import { ENS_ATTESTATION_REASONS } from "./ens-reasons.js"` を展開（13 語）＋ `insufficient_chain_evidence`・`chain_evidence_unavailable`・`insufficient_ens_attestations`・`vet402_unreachable` | B3（D1-a の2語）／B6（残り） |
| 2 | `export type PayEvidenceSource` | 200 | `"ens"`・`"chain"` を足す | B6 |
| 3 | `minL1Deliveries?: number` | 225 | `minChainReceipts?: number`（B3）・`minEnsAttestations?: number`（B6・§3.3.3 G1） | B3／B6 |
| 4 | `floor: "minL1Deliveries"` | 288 | `EvidenceFloorCheck.floor` に2つ足す | B3／B6 |
| 5 | `床を1つも宣言せずに` | 271 | 規律に1文だけ足す（§3.3.3 G7） | B6 |
| 6 | `名前解決を支払いゲートの中で起こさない` / `invalid_payee_address:` | 628 / 634 | `payee` が**渡されたとき**は今のまま throw。先頭に「`payee` も `payeeName` も無い → `invalid_payee_address`」「`payeeName` があって `ens` が無い → `invalid_ens_config`」「`normalize` が throw／ドットを含まない → `invalid_payee_name`」 | B6 |
| 7 | （#6 の直後） | — | `profileFor(input.network)`（`invalid_network`）・`payeeName` かつ `profile.network !== "base-sepolia"` → `invalid_ens_chain`・`clients.*.chain.id !== 11155111` → `invalid_ens_chain`・`assertEnsAttestationPolicy`。**すべて通信の前** | B6 |
| 8 | **`--- 3. /decision ---` の直前** | 751 | **段 2.5**: `if (input.payeeName) { const {checkEnsOffer} = await import("./ens-attestation.js"); … if (!ens.ok) return refuse([...ens.reason_codes, ...(含むなら "evidence_unavailable")], "local_policy"); if (input.payee && !sameAddress(input.payee, ens.offer.payTo)) return refuse(["payee_mismatch"], "local_policy"); payeeAddr = ens.offer.payTo; offer = ens.offer; offerRaw = ens.offerRaw; }`。**ここで止まれば vet402 の API を1本も叩かない** | B6 |
| 9 | `--- 3.5` / `--- 3.6` | 820 / 917 | 宣言した証拠源と床の評価に `ens`・`chain` を足す | B3／B6 |
| 10 | **`--- 4. 402 チャレンジ ---`（accept が決まった後）** | 925 | `compareOfferToAccept`。**具体の語を消さず `ens_offer_mismatch` を先頭に足す** | B6 |
| 11 | `--- 3'.`（受取人スコア） | 975 | `vet402_unreachable` の分岐（§3.3.3 G5） | B6 |
| 12 | **`await import("./x402-pay.js")` の直前** | 1071 | **再検証**: `payeeName` があれば `checkEnsOffer` をもう一度。`!ok` または `offerRaw` が1回目と違えば拒否。`x402-pay.js` はまだ評価されていない | B6 |
| 13 | `chainId: BASE_CHAIN_ID` | 1079 | `profile.chainId` | B3 |
| 14 | `if (paid.txHash)` | 1129 | `if (paid.txHash && profile.attest)`（testnet は本番台帳へ入れない） | B3 |
| 15 | `function assertFiniteFloor` / `const met: EvidenceFloorCheck` / `const floors = [evidence` | 1244 / 1291 / 1345 | 新しい床2種を有限・非負の整数として検査し、床として数える。**0 は床でない規則はそのまま** | B3／B6 |
| 16 | `export const BASE_CHAIN` / `accept.network !== BASE_CHAIN` | 63-64 / 478 | 定数は `CHAIN_PROFILES.base` から。払える判定を profile の network で | B3 |
| **17** | `const isEvmPayee` / `const rail: PayRail = isEvmPayee` | **630-638** | **`payee` が無いと `isEvmPayee`・`isSvmPayee` がどちらも false → `rail = "svm"` に落ち、`assertSvmPayer(input)` が throw する。** `payeeName` 経路では `rail` を **profile から決める**（`base-sepolia`・`base` はどちらも `"evm"`）。`assertSvmPayer` はこの経路で1回も呼ばない | **B3（最初）** |
| **18** | `if (!sameAddress(accept.payTo, input.payee))` | **960** | **`sameAddress(x, undefined)` は `false`** なので、直さないと名前だけの支払いが必ず `payee_mismatch` になる。段 2.5 が確定させたローカル変数 `payeeAddr` と比べる | **B3（最初）** |
| **19** | `address: input.payee`（subgraph の受領を読む） | **828** | `payeeAddr` に置き換える（名前経路で `undefined` を渡すと、宣言した subgraph の床が黙って 0 件になる） | **B3（最初）** |
| **20** | `wallet: input.payee`（attest の POST 本文） | **1135** | `payeeAddr` に置き換える。ただし #14 で testnet は attest 自体に入らない | **B3（最初）** |

**#17〜#20 の直し方（1つに決める）**: 段 2.5 の直前に `let payeeAddr: string` を置き、`input.payee` があればそれ、無ければ段 2.5 が確定した `ens.offer.payTo` を入れる。**`input.payee` を直接読む「4か所」を関数内に1つも残さない。**

**判定コマンド（`grep -c 'input\.payee'` を `0` にはできない。7 行当たるのが正しい）**【実測 `e8ff1eb`】: `input.payee` は**7 行**に出る。うち **4 行が読み取り**（置き換える）で、残る 3 行は**型の定義・コメント・`invalid_payee_address` の throw のメッセージ**で、置き換えてはいけない。だから判定はこう書く。

```bash
# 「読み取りの4か所が消えた」ことだけを見る。型・コメント・throw の行は数に入れない
grep -n 'input\.payee' $SDK/src/pay-or-refuse.ts \
  | grep -v 'payee?: string' | grep -v '^\s*[0-9]*:\s*//' | grep -v 'invalid_payee_address' \
  | wc -l      # → 0
grep -n 'input\.payee' $SDK/src/pay-or-refuse.ts | wc -l   # → 3（型・コメント・throw のメッセージだけが残る）
```

**`payee: string` 必須 union の崩し方（1行で決める）**: **`PayOrRefuseBaseInput` から `payee: string` を取り出し、`PayOrRefuseInput = PayOrRefuseBaseInput & ({ payee: string; payeeName?: never } | { payeeName: string; ens: EnsGateInput; payee?: string }) & ({account} | {svm})` の形にする**（既存の呼び手は型も実行時の挙動も変わらない・T29 が固定）。

**判定の順（新）**: 呼び出し側の誤り（throw・通信 0）→ 上限（通信 0）→ **ENSIP-29（Sepolia RPC だけ）** → `/decision` → 宣言した証拠源 → 床 → 402 → **約束と 402 の照合** → payTo → 金額の関門 → 受取人スコア → **再検証** → 動的 import → 署名。

#### 3.3.3 vet402 に届かないときに払う（I11・G1〜G10）

**前提（言い方を正した）**: SDK 0.7.0 には既に `requireVet402Allow:false` ＋ 呼び手が宣言した証拠の床がある（`:271` 付近）。ただし**現物の 0.7.0 は、床を宣言していても `/api/v1/` へ毎回1回取りに行き、返ってこなければ `evidence_unavailable` で拒否する**【実測 TM-4】。「取りに行けなかったことを免除する」分岐が無いからで、**会期で作る G1〜G10 がその1点だけを足す**。**新しい分岐を作らず、床の種類と免除の条件を足すだけ**（09-17 14:0x オーナー決裁で I12 は不採用）。

**だから、主張はこう書く（§1.3 Q-B・§8.1・§8.2 の台詞をこれにそろえる）**

| 言ってよい | 言ってはいけない |
|---|---|
| 「**問い合わせには行く。返ってこなくても、床が満たされていれば払う**」 | 「vet402 に**一度も問い合わせない**」（段 2.5 で止まったときだけ真・T03） |
| 「vet402 の API が**返らない**状態で払えた」 | 「vet402 **抜きで**動く」（degraded と BLOCK は免除しない） |
| 「証明の検証そのものは Sepolia の RPC と手元の設定だけで完結する」（C1〜C7） | 「vet402 のサーバーは要らない」 |
| 画面の表示は **`vet402 API: unreachable (asked, no answer)`** | 画面に `vet402 API calls: 0` と出すこと（**段 2.5 で止まったときにしか真にならない**。ALLOW で払う場面では自分の規律違反になる・§10.6） |

**`cut-vet402` の定義（`run.ts cut-vet402` と撮影の両方でこれ）**: **vet402 の API を「接続不能」か「HTTP 503」にすること**。この2つだけが G5 の「届かない」に当たる。**404 は当たらない**——現物で `/api/v1/` が HTML の 404 を返すと `evidence_unavailable` のまま拒否する【実測 TM-4】。撮影では `curl: Connection refused` が横のターミナルに出る形（接続不能）を使う。

| # | アンカー | 足すもの |
|---|---|---|
| G1 | `minL1Deliveries?: number`（225） | `minEnsAttestations?: number`。`payeeName` と `ens` が無い呼び出しで宣言したら throw `invalid_evidence_policy` |
| G2 | `floor: "minL1Deliveries"`（288）・`assertFiniteFloor`（1244） | 名前 `"minEnsAttestations"`・源 `"ens"`。有限・非負の整数でなければ throw |
| G3 | `const floors = [evidence`（1345） | 床として数える。**0 は床でない**規則はそのまま |
| G4 | `const met: EvidenceFloorCheck`（1291） | 引数に段 2.5 の `EnsOfferCheck` を足す。有効数 < 床 → `insufficient_ens_attestations`。満たせば `floors_met` に `{floor:"minEnsAttestations", source:"ens", required, observed}` |
| G5 | `--- 3. /decision ---`（751）・`--- 3'.`（975） | **「届かない」と「答えが悪い」を分ける**。届かない＝**トランスポートの throw・タイムアウト・HTTP 5xx（500-599）の3つだけ**。そのとき `requireVet402Allow:false`・`minEnsAttestations ≥ 1`・段 2.5 が ok の3つがそろえば、拒否せず経路の印 `vet402_unreachable` を付けて先へ進む |
| **G5b** | 同上（**fail-closed の枝。G5 と同じ関数に置く**） | **HTTP 200 で「読めたが判定になっていない」場合は拒否する**。次の**4つとも**「届かない」に**当たらない**——`evidence_unavailable` で**拒否**する。①`JSON.parse` の失敗 ②204 ③3xx **④`recommendation` が `allow` / `warn` / `block` のどれでもない 200**（`{}`・`null`・`{"ok":true}` は JSON として読めてしまうので①では捕まらない）。**`JSON.parse` を fetch と同じ `try` に入れてはいけない**（throw が「届かなかった」に落ち、**払う側に倒れる**）。乗っ取られた、あるいは設定を間違えた vet402 が 200 で空を返したときに、床だけで払うことになるのを塞ぐ。**T41b が4枝で固定する** |
| G6 | degraded／`signalsUnavailable`／BLOCK／**4xx（404 を含む・例外なし）** | **変えない**。届いて悪い答えが返ったら床があっても拒否。**「404 を除く」は誤り**——現物でも 404 は拒否のまま【実測 TM-4】で、除外すると「存在しない資源なら払える」抜け道になる |
| G7 | `床を1つも宣言せずに`（271） | 1文足す: 「ただし判定を取りに行けなかったときに限り、呼び手が ENS の証明の床を宣言していれば、取りに行けなかったことを免除する。届いた判定の degraded と BLOCK は免除しない」 |
| G8 | `PayPolicyOverride.waived.source` | `"vet402_unreachable"`（`recommendation:"unreachable"`・`score:null`・`reason_codes:[]`）。決定行の `verdict_source` は `"caller_policy"` |
| G9 | 床の評価の順 | 届かないとき、vet402 の台帳に依存する床（`minL1Deliveries`）を宣言していれば `evidence_unavailable`（黙って落とさない）。評価できるのは ENS・chain・subgraph の床だけ |
| G10 | 再検証（1071）・attest（1129） | 変えない（届かない経路でも署名直前に ENSIP-29 を読み直す。testnet は attest しない） |

**新しい床2種と既存の `PayEvidencePolicy.source` の関係（S4・曖昧を消す）**

`source`（`"vet402" | "subgraph" | "both"`）は**どこにも足さない・意味も変えない**。`e8ff1eb:1257-1269` の分岐（`wanted` の検査と、`minSubgraphReceipts` / `minL1Deliveries` が `source` と噛み合わないときの throw）に **`ens`・`chain` の枝を1本も足さない**。

| | `source` が効く床 | `source` と無関係な床 |
|---|---|---|
| 既存 | `minL1Deliveries`（`vet402`/`both`）・`minSubgraphReceipts`（`subgraph`/`both`） | — |
| 新設 | — | **`minEnsAttestations`（源は ENS）・`minChainReceipts`（源はチェーン）** |

理由: 新設の2つは vet402 の台帳とも subgraph とも別の源から来るので、`source` で切り替えると「宣言したのに黙って無視される床」を作ってしまう。`PayEvidenceSource` に `"ens"`・`"chain"` を足す（#2）のは**決定行の `evidence[].source` に出すため**であって、`policy.evidence.source` の選択肢を増やすためではない。
→ **T45 に枝を1つ足す**: `minEnsAttestations:1` を `evidence.source:"subgraph"` と一緒に宣言しても **throw しない**（`source` の制約を受けないことを固定する）。

**fail-closed の保ち方**: (1) 段 2.5 が ok でなければこの経路に入らない (2) 既定の `requireVet402Allow:true` の呼び手は何も変わらない (3) 届いた degraded・BLOCK・4xx は免除しない (4) 決定行に免除の内訳を必ず残す (5) 床 0 は床ではない (6) 本番 Base では構造上起きない **(7) 200 で判定になっていなければ拒否する**（G5b の4枝。パース失敗も「`recommendation` が知らない値」も「届かなかった」に落とさない）。

**「サーバーを止めても失効する」を保証する条件（開示に書く）**

| # | 条件 | 確かめ方 |
|---|---|---|
| C1 | 段 2.5 は Sepolia の RPC と呼び手の設定だけを読む。vet402 のドメインに fetch しない | T03: `apiUrl` への fetch 0 回 |
| C2 | 信頼する attester の一覧はローカルの設定で、vet402 から取らない | `trusted-attesters.json` をリポに置く・`/api/tokyo/*` に一覧を返す口を作らない |
| C3 | RPC は vet402 が運営しない公開 RPC（利用者が選ぶ） | `probe-rpc.ts` の出力に URL |
| C4 | 段 2.5 は `/decision` より前で、失敗は即 return | 差し込み #8 |
| C5 | 鮮度は `t` とローカルの時計だけで判定 | T12・T13 |
| C6 | 2系統が同じブロックで一致したときだけ使う | T15・T16 |
| C7 | 届かないときに払えるのは `requireVet402Allow:false`・`minEnsAttestations ≥ 1`・段 2.5 が ok の3つがそろうときだけ | T39〜T44・T47 |

**保護しないもの（開示）**: attester の `t` の正しさ（草案 149 行）／`t` の後に変えて元に戻した変更（補助の走査を切ったとき）／**持ち主が `linkToRecord` で元の箱につなぎ直したとき**（証明は再び有効になる）／attester の親名の失効と再登録（anchor を切ったとき）／Universal Resolver のプロキシの差し替え／2系統が同じ誤りを返すこと／読みと署名の間の数秒／testnet の鍵を同じ PC に置いていること。

### 3.4 売り手ごとの専用 Permissioned Resolver と `grantSetterRoles` — `examples/tokyo-2026-demo/src/admin.ts`（新規）

| 項目 | 中身 |
|---|---|
| 下位コマンド（**9つ**） | `deploy-resolvers` / `k1a` / `k1b` / **`register-d`** / `publish-attestations` / `unlink` / `link` / `relink` / **`agents`**。B1 の判定は `admin.ts --help` にこの**9語**が出ること |
| `deploy-resolvers` | `VerifiableFactory.deployProxy(impl, salt, initialize([(owner, ALL_ROLES)], calls))` で `P_a`（seller-a 専用）・`P_bc`（seller-b/c 共有）・**`P_d`（seller-d 専用・審査員ボタンの書き込み先）**を作り、`ETHRegistry.setResolver(getState(labelhash).tokenId, P)` で向ける |
| `k1a` | W_vet: `setAddress(dns("atst.vet402.eth"), 60, K_atst)`・W_obs へ 15 キーの `grantSetterRoles`（multicall）・ETH 送金 |
| `k1b` | W_pay への USDC/ETH・`SEED_TX`・`P_a.grantSetterRoles(setText(dns("seller-a.eth"),"x402-offer",""), W_op)`・**`P_d` 側の同じ委任**・**BS-03（W_ens → W_op へ 0.05 Sepolia ETH）** |
| **`register-d`** | **`seller-d.eth` を会期中に登録する**（§4 の K1-D1）。`MockUSDC.approve(ETHRegistrar, max)` → `ETHRegistrar.commit(commitment)` → **60 秒待つ**（`MIN_COMMITMENT_AGE`）→ `register("seller-d", W_ens, …, 1年)`。**家賃は MockUSDC 払い**（8.000021 MockUSDC）で、**ETH 建ての `getRegisterPrice` は revert する**【実測】。待ち時間を人が数えないよう、コマンドの中で待つ |
| `unlink` / `link` / `relink` | `linkToRecord(dns(name), 0)` ／ `linkToRecord(dns(name), <相手の recordId>)` ／ census で控えた元の recordId に戻す |
| `--dry-run` | 同じ calldata を持ち主から `eth_call`、連続する手順は sentio の `eth_simulateV1`（`validation:false`）。**`--live` は人が打つ** |
| **やらない** | `grantSetterRoles` を `initialize` の `calls` に入れる道を作らない（配備ごと revert【実測・sim E12】）／`U` の予約ラベル（`atst`・`obs`）に `register`・`setResolver`・`unregister` を打つ道を作らない（§3.5） |
| 委任の範囲（開示） | W_op は **P_a の上のどの node でも**（`P_d` の上でも同じく）`x402-offer` を書ける。P_a に解決されるのは `seller-a.eth` とその未登録サブ名だけで、サブ名は `findExactOwner` が 0 なので段2で `ens_name_unresolved` で止まる【実測・sim E8-6】。**サーバー側でも同じことを言い切る**のが W06（§3.7.1） |
| 確かめ（画面に出す・すべて【実測・sim・block 11733994】） | `P_a.roles(keccak256("x402-offer"), W_op) = 0x10`／W_op が `P_a` で `x402-offer` を書く eth_call は **OK（C-01）**／同じ鍵で `attestations[…]` を書く eth_call は **`EACUnauthorizedAccountRoles(0x2363e661…, 0x10, W_op)`（C-02）**／W_op が `P_bc` で seller-b の約束を書く eth_call も revert（C-03）／`P_bc.roleCount(keccak256("x402-offer")) = 0`／W_op の `setAddress` も revert（C-05・`…, 0x1, W_op`） |
| 参考（台詞に使わない） | W_vet（作者）は `P_a` で**証明キーも約束も**書けない（C-06・C-07）。役割が1つも無いからで、証明キーが特別だからではない。§1.5 の表を参照 |


### 3.5 エージェントの名前空間（案A・採用 2026-09-19 07:5x）

```
vet402.eth                         ETHRegistry（ENS の）
  ├ resolver     = R_vet           ここに x402-policy を **書かない**（罠。下）
  └ subregistry  = U               UserRegistry（自前・VerifiableFactory で配備）
      ├ agent-1   resolver = P_AG1  専用 PermissionedResolver
      │            x402-policy = §3.5.1 のスキーマ（7キー）
      │            addr(60)     = K_ag1 ・ 期限あり・譲渡不可・親が取り消せる
      └ agent-2   resolver = 0      親 R_vet の wildcard に落ちる（対照）
  （atst / <hash>.obs は R_vet の wildcard で答える。ただし **U 側に予約ラベルとして
    resolver=0 で自分で register しておく**——下の「生命線の壊し方」）
```

**生命線の壊し方が実在する（K1 の直後に自分で塞ぐ）**【実測・sim】: `U` を `vet402.eth` の subregistry に挿すと、**`U` に `atst` や観測ログのラベルを誰かが先に register できる**。`register` の resolver 引数が `0x0` なら `atst.vet402.eth` は今までどおり `R_vet` 経由で解決するが、**resolver ≠ 0 で登録されると他人のリゾルバに解決する**。

| `U.register("atst", …)` の resolver 引数 | `resolve(addr atst.vet402.eth)` |
|---|---|
| `0x0`（リゾルバ無し） | `0x4100…00A7` via `R_vet` ✅ 無傷 |
| **別のリゾルバ** | **`0x0000…0000` via `0x49f5022d…8055`** ❌ 乗っ取られる |

`U` の root を持つのは W_vet だけなので外からの攻撃ではない。**壊れるのは K1 の後**（デモの `unregister`→`register`、当日の追加登録）である。

**予約しただけでは塞がっていない**【実測・sim】: `atst` を `resolver=0` で先に register しても、**あとから `setResolver` 1本（48,235 gas）で同じ乗っ取りが起きる**。`unregister` してから別のリゾルバで register し直しても同じ。**予約は「他人より先に取る」だけで、自分で壊す道は残る。**

**手当て（4つとも打つ）**
1. **K1 の直後に予約ラベルを自分で register する**（`resolver=0`）: `atst` と観測ログのラベル。§4 の K1-post-1・K1-post-2
2. `admin.ts agents` に「**`atst`・`obs` は予約ラベル。`register`・`setResolver`・`unregister` のどれを打とうとしても即座に落ちる**」を入れる（**禁止は `register` だけでは足りない**）
3. **B0 と提出前に「`atst`・`obs` の解決先が `R_vet` であること」を確かめる関門**を置く（K1 の census の期待の1行にも入っている）
4. **T7（`U.revokeRootRoles(UNEMANCIPATED, W_vet)`）を live で打つ**。`UNEMANCIPATED` には `ROLE_SET_RESOLVER` と `ROLE_UNREGISTER` が入っているので、解放した後は**自分でも予約ラベルのリゾルバを差し替えられない**＝これが唯一の構造的な閉じ方である。**打つ枠は B7（D-6 の後）**（先に打つと `unregister` ができなくなる・§4）

| 項目 | 中身 |
|---|---|
| 置き場 | `packages/sdk/src/agent-namespace.ts`（新規）・`examples/tokyo-2026-demo/src/admin.ts` の `agents` |
| 公開 | `readAgentPolicy(clients, B, agentName, expectedResolver): Promise<AgentPolicy>`／`type AgentPolicy`（§3.5.1） |
| 関門への差し込み | `payOrRefuse` を呼ぶ**前**に、呼び手が `AGENT_NAME` の名前から Universal Resolver 経由で `x402-policy` を読み、§3.5.2 の写し方で `payOrRefuse` の引数に当てる |
| 拒否語 | `agent_policy_missing`（読めない・JSON でない・7キーがそろわない・知らないキーがある・**答えたリゾルバが `P_AG1` でない**）。**`examples/` 側の語**（宿題 H9 の決定）。SDK の語彙にも `SKILL.md` の表にも入れない。理由: 関門は `payOrRefuse` を**呼ぶ前**に落とすので SDK の決定行に一度も現れず、SDK の語彙に入れると `tests/caller-policy-sdk-parity.test.ts` が「誰も生まない語」を要求することになる |
| 既存設計を壊さないこと【実測・sim D-10/D-11】 | `setSubregistry` の後も `atst.vet402.eth` と `<hash>.obs.vet402.eth` は `R_vet` の wildcard のまま解決する。**B0 の関門にこの確認を入れる** |
| 見せ場（"on a name" の before/after・**K1-15b が要る**） | **before（専用リゾルバあり）**: `K_ag1` は `P_AG1` の上でしか書けず、親 `vet402.eth` の同じキーは `EACUnauthorizedAccountRoles(0x1c075423…, 0x10, K_ag1)`【C-17 実測・sim】／**after（専用リゾルバなし＝K1-15b で親のリゾルバに委任）**: `K_ag2` は `agent-2` の方針も、**`vet402.eth` 本体の方針も、`atst.vet402.eth` の方針も書けてしまう**【scene3 A2 の a2-3/a2-4/a2-5 実測・sim】。**K1-15b を打たないと after が起きず、この対照は成立しない**（K1-15 だけの状態では C-18 のとおり `K_ag2` も revert する） |
| **漏れの実演は `eth_call` だけ** | `K_ag2` が `vet402.eth` の `x402-policy` を `"HIJACKED"` に書ける、は **simulate の出力を画面に出すだけ**。live の tx で書くと §3.5.3 の罠を自分で作る（§1.6 の禁止） |
| 取り消しで委任が死ぬ【B3b】 | `unregister` → 同じラベルを別の持ち主で再登録すると `getResource` が `…00` → `…01` に上がり、第三者の鍵の `hasRoles` が true → false |

#### 3.5.1 `x402-policy` のスキーマ（H12・確定）

```json
{"v":1,"network":"eip155:84532","trust":["atst.vet402.eth"],"floors":{"minEnsAttestations":1,"minChainReceipts":1},"requireVet402Allow":false,"max":"50000","maxAgeSeconds":86400}
```

```ts
export type AgentPolicy = {
  v: 1;
  network: "eip155:84532";
  trust: readonly string[];                 // attester の **名前だけ**。アドレスは書かない
  floors: { minEnsAttestations: number; minChainReceipts: number };
  requireVet402Allow: boolean;
  max: string;                              // USDC の最小単位・10進の文字列（"50000" = 0.05 USDC）
  maxAgeSeconds: number;
};
```

| 規則 | 中身 |
|---|---|
| キーの数 | **7キーすべて必須**。**知らないキーが1つでもあれば `agent_policy_missing`**（打ち間違いを黙って無視しない） |
| `v` | `1` のみ |
| `network` | `"eip155:84532"` のみ（本番 Base を名前経路で払わない・§1.6） |
| `trust` | 名前の配列（長さ 1 以上）。**アドレスは絶対に書かない**（チェーンの値に鍵を書くと、名前を乗っ取った者が信頼先を差し替えられる） |
| `floors` | 2キーちょうど。各値は 0 以上の有限整数。`minEnsAttestations` は 1 以上でなければ届かない経路に入れない（G5） |
| `requireVet402Allow` | 真偽値 |
| `max` | **USDC の最小単位の10進文字列**（`/^[0-9]{1,18}$/`）。`maxPerTxUsd = Number(max) / 1e6` で写す（`"50000"` → `0.05`） |
| `maxAgeSeconds` | 整数・`60 ≤ x ≤ 604800` |
| **書けないもの** | `minL1Deliveries`・`minSubgraphReceipts`（vet402 の台帳と subgraph の床。名前の側から宣言させない。書いてあれば「知らないキー」として `agent_policy_missing`） |
| `trust` の扱い | **ローカルの `trusted-attesters.json` との積集合**。`trust` に載っていて、かつローカルにも (名前, アドレス) がある attester だけを `trustedAttesters` に入れる。**アドレスは必ずローカルから取る。**積集合が空なら `agent_policy_missing` |

#### 3.5.2 `AgentPolicy` から `payOrRefuse` の引数への写し方（1対1・他は写さない）

| `AgentPolicy` | `payOrRefuse` |
|---|---|
| `network` | `input.network`（`"eip155:84532"` → `"base-sepolia"`） |
| `trust` ∩ `trusted-attesters.json` | `input.ens.policy.trustedAttesters` |
| `maxAgeSeconds` | `input.ens.policy.maxAgeSeconds` |
| `floors.minEnsAttestations` | `input.policy.evidence.minEnsAttestations` |
| `floors.minChainReceipts` | `input.policy.evidence.minChainReceipts` |
| `requireVet402Allow` | `input.policy.requireVet402Allow` |
| `max` | `input.amountUsd` の上限＝`Number(max)/1e6`（`maxPerTxUsd`） |
| （写さない） | `input.payeeName`・`input.resource`・`input.ens.clients` は呼び手が決める。方針から**通信先を決めさせない** |

#### 3.5.3 命題5 の罠 — 親の wildcard が古い方針を蘇らせる

`unregister("agent-1")` の後、`agent-1.vet402.eth` は**未登録のサブ名**に戻る。このとき親 `vet402.eth` のリゾルバ `R_vet` に同じキーの値があると、**wildcard がそれを返す**——取り消したはずの方針が生き返る。

【実測・sim scene3 A1】: `R_vet` に古い方針 `{"v":1,"trust":[],"floor":"none","max":"999999999"}` を置いてから `U.unregister("agent-1")`（72,604 gas）を打つと、`agent-1.vet402.eth` の `x402-policy` が **`0x3368219E…`（R_vet）経由でその古い値を返した**。`addr` は `0x0` になるのに、text だけ生き残る。

**二重に塞ぐ（両方やる。片方だけにしない）**

| # | 手当て | どこで |
|---|---|---|
| (a) | **親 `R_vet` に `x402-policy` を書かない**。K1-02 が書くのは `agent-endpoint[x402]` と `class` の2キーだけ（§1.6 の禁止・§4 K1-02 の注） | K1-02・運用 |
| (b) | **`readAgentPolicy` は `UR.resolve` が返したリゾルバを見る**。`resolveText` の戻り値 `{value, resolver}` の `resolver` が `P_AG1`（`expectedResolver`）でなければ、**値が何であっても `agent_policy_missing`** | `agent-namespace.ts` |

(b) があるので、(a) を破っても方針は蘇らない。(a) があるので、(b) を知らない第三者の読み手も騙されない。**§3.2 の `resolveText` が「値だけ返す」設計から「値とリゾルバを返す」設計に変わったのは、この (b) のため。**
確かめ（K1 の census と T49）: `resolve(text agent-1.vet402.eth x402-policy)` が **`P_AG1` 経由**で返ること（C-13・C-14【実測・sim】）／`unregister` の後は `agent_policy_missing` になること。

### 3.6 観測ログ（第三者の売り手・addr なし） — `examples/tokyo-2026-demo/src/observe.ts`（新規）

- **対象**: `candidates.json`（§2.6 の第一候補＋次点。vet402 自身の資源は除く）
- **読む（金は動かさない）**: `/decision?role=payer` を **7 秒間隔**（鍵なし 10 回/分の制限）→ `facts.l1.last_purchase_id`・`facts.l2.{status, declaration_hash, response_hash, observed_at}`。**vet402 の API を信じ切らない**: `last_purchase_id` の tx を Base 本番の公開 RPC 2系統で `eth_getTransactionReceipt` → `status 0x1`
- **書く（Sepolia・`--live` のときだけ）**: 名前 = `dns("<resourceId 64桁>.obs.vet402.eth")`（**`U` には `obs` を予約ラベルとして `resolver=0` で登録済み。その下の `<resourceId>` は登録しない・wildcard**）。`vet402.eth` のリゾルバ `R_vet` へ `multicall(setText(dns(name), key, value) …)` を W_obs で 1 tx
- **`obs` は予約ラベル**（§3.5 の生命線）。`admin.ts agents` は `atst`・`obs` を登録しようとしたら即座に落ちる

| キー（15） | 値 |
|---|---|
| `class` | `x402-observation` |
| `description` | `Observation log by vet402. Not the seller's name. Do not send funds here.` |
| `x402.resource`・`x402.method` | 第三者の URL・メソッド |
| `x402.l2` | `conform` / `mismatch` |
| `x402.declaration-sha256`・`x402.response-sha256` | `/decision` の値 |
| `x402.purchase`・`x402.purchase-block` | `eip155:8453:0x…`・Base のブロック番号 |
| `x402.observed-at`・`x402.source`・`x402.rerun`・`x402.pipeline-commit` | ISO8601 UTC・`/decision` の URL・再実行コマンド・実行した commit |
| `x402.attested-name`・`x402.attested-t` | attester が書く分 |

- **addr・contenthash は置かない**。書いた後に2系統で読み戻し、tx ハッシュと Sepolia のブロック時刻を出す
- `--check`: 同じ手順で取り直し、ENS の記録と1項目ずつ比べて `match` か差分を出す（場面1の「再実行コマンド」）
- `last_purchase_id` が無ければ throw `observation_without_purchase`（**`observe.ts` だけの語**）
- **開示**: W_obs の 15 キーの委任はリゾルバ単位なので、W_obs は `vet402.eth`・`atst.vet402.eth` の同じキーも書ける【実測・sim E11】。**addr は書けない**（`setAddress` は `EACUnauthorizedAccountRoles(…,0x1,W_obs)`）→ パイプラインの鍵が漏れても attester は乗っ取れない

### 3.7 `/tokyo` の面（7段の検証＋審査員が1文字変えられるボタン）

| 置き場 | 中身 |
|---|---|
| `src/app/tokyo/page.tsx`（新規） | 名前を入れる欄／7段の trace ／観測ログの一覧（書き込み tx へのリンク・**addr の欄が空**であることが見える）／撮影した3場面の決定行と tx／CLI の1行／開示へのリンク／`format: ensip29-draft` の表示／**いまの `seller-d.eth` の `amount` の常時表示と「10000 に戻す」ボタン**（§3.7.1 の「押した後の画面」）。**`export const dynamic = "force-dynamic"` を必ず書く**（公開 route 37 本が静的化で同じ事故を起こしている【実測 `tests/public-routes-dynamic.test.ts`】） |
| `src/app/api/tokyo/verify/route.ts`（新規） | 読み取りだけ。`?name=` を受けて `checkEnsOffer` の `trace`（7段）を JSON で返す |
| **`src/app/api/tokyo/mutate/route.ts`（新規・審査員ボタン）** | 審査員が **`seller-d.eth`** の `x402-offer` の `amount` を1文字変える。押した直後に同じ `verify` を走らせ、7段の5段目が赤に変わるのを見せる。**鍵の扱いと関門は §3.7.1** |
| **`src/app/api/tokyo/reset/route.ts`（新規）** | 画面の「戻す」ボタン。`10000` に戻す（時間の条件なし） |
| **`src/app/api/tokyo/state/route.ts`（新規）** | 画面が1発で引く現在値・直前の操作ログ 10 件・押せない理由。**ここでも「前回の変更が残っていれば戻す」を呼ぶ**（W05）。`force-dynamic` ＋ `Cache-Control: no-store` |
| **`src/app/api/tokyo/_lib/*.ts`（新規）** | `constants.ts`（W02・W04・W06 の定数を**全部ここに**）・`halt.ts`・`revert.ts`・`ip.ts`。**使ってよい既存 lib は `@/lib/db/client`・`@/lib/util/log`・`@/lib/cron/lease` の3本だけ**（§3.7.1 W01） |
| 依存 | viem・`@vet402/sdk`。**`src/app/tokyo` と `src/app/api/tokyo/verify` には署名器と秘密鍵を1つも置かない**（判定は §3.7.1 の grep。**`mutate`・`reset`・`state` は grep の除外範囲で、関門6つ＝W01〜W06 のテストで縛る**） |
| DB（会期中に1回だけ流す DDL） | `scripts/sql/2026-09-2x-tokyo-mutations.sql`。足すのは**2表だけ**（`runtime_flags` と `job_leases` は既にある）<br>`tokyo_mutations(id int PK DEFAULT 1, current_value text NOT NULL, generation bigint NOT NULL DEFAULT 0, mutated_at timestamptz, reverting_until timestamptz, last_tx text, CHECK (id = 1))`<br>`tokyo_mutation_log(id bigserial PK, at timestamptz NOT NULL DEFAULT now(), from_value text NOT NULL, to_value text NOT NULL, tx text)` — **押した人は記録しない**（IP も鍵も入れない） |
| 決め打ちをしない | アドレスは viem の chain 定義と ENS から引く。名前が消えていたら `ens_name_unresolved` をそのまま見せる |

#### 3.7.1 審査員ボタンの鍵と関門（H4 の決定＝**案a・サーバー側の鍵**。控えは `guards/GUARDS.md`）

**決定: 鍵は公開しない。W_op の委任鍵をサーバー側に置く。**
**公開案を採らない理由（1行）**: 公開した鍵は、**同じリゾルバに載る任意のサブ名に同じキーを書け、ガス代を誰でも抜ける**（W_op は `P_a`／`P_d` の上のどの node でも `x402-offer` を書ける・C-04【実測・sim】。Sepolia の ETH は有限で、抜かれると会期中に証明を置き直せなくなる）。

**壊す相手は `seller-d.eth`。`seller-a.eth` は壊さない。**`seller-a.eth` は README・CLI の例（`verify seller-a.eth`）・場面2の主役で、審査員が押したままの状態を次の審査員が見ると全部が赤に見える。**`seller-d.eth` は会期中に W_ens で登録する**（§2.5・§4 の K1-D1）。

**関門6つ（全部入れる。1つでも欠けたら B8 は未完了）**

v4.1 の4つは名指しした脅威を塞いでいなかった（ソース文字列の grep は外のヘルパ経由で素通りする・リクエスト由来の `chainId` は攻撃者が `11155111` を送るだけで通る・20 秒/IP はガス代を抜かれる速度を落とすだけ）。v4.2 で6つに作り直したが、そのうち**⑤と⑥は `~/vouch` の現物に当てると成り立たなかった**。→ **6本とも残し、W05 と W06 だけ形を替えた**（`guards/GUARDS.md` の結論）。

| # | 関門 | 会期中の形 | ID |
|---|---|---|---|
| ① | **読む env 名の固定** | 「1つだけ」は**達成できない**（停止スイッチと RPC を読むため）。→ **「許可リストと完全一致」**。許可するのは **`DATABASE_URL` / `TOKYO_OPERATOR_PRIVATE_KEY` / `TOKYO_SEPOLIA_RPC_URL` / `TOKYO_JUDGE_BUTTON_DISABLED` の4つだけ**。`mutate`・`reset`・`state` の**静的 import グラフ**を辿って照合する（文字列 grep では足りない）。**動的 `process.env[<変数>]` は 0 本**。**`@/lib/api/ip-rate-limit` と `@/lib/api/client-ip` を import しない**（前者は `@/lib/config/env` → `production-env.ts` を連れてきて env 名が 19 に増える【実測】） | **W01** |
| ② | **chainId は定数** | `11155111` を**ソースの定数**として持つ。リクエスト本文からは取らない。サーバの viem client の `await client.getChainId()` と照合し、違えば 503 | **W02** |
| ③ | **1日の上限と停止スイッチ** | **KV も Redis も入っていない**【実測】。→ カウンタは **Postgres の1文 upsert**（既存の `ip_rate_limits` 表を流用。鍵は `tokyo-mutate-day:<YYYY-MM-DD>`。`demo-l1-day:<日付>` と**まったく同じ用途**で日次予算に使われている）。**上限は 1 日 60 回**（資金の実測から・§4）。停止スイッチは **DB の1行**（`runtime_flags.tokyo_button_halt`）を正典に、env `TOKYO_JUDGE_BUTTON_DISABLED=1` は保険。IP ごとの 20 秒間隔は残すが**関門に数えない** | **W03** |
| ④ | **残高の床（固定値の比較ではなく式）** | `balance − 0.005 ETH ≥ PRESS_GAS × gasPrice × 3` を満たさなければ 503（＋画面に理由の1行）。`PRESS_GAS = 157,012`（mutate 78,506 ＋ reset 78,506【実測】）。**回数の上限は運用の目安で、残高の式が本当の関門** | **W04** |
| ⑤ | **次に来た人が来たときに戻す**（「90 秒で自動復帰」の置き換え） | serverless では時間で戻せない（`after()` の中の `setTimeout` は**本番で一度も発火しなかった実測がある**・Vercel cron は日次〜1日4回で分単位が無い）。→ 守る不変条件を**時間ではなく来訪**で守る: `mutate` の先頭・`state`（`mutated_at` から 90 秒以上のとき）・`reset` の3か所で `ensureReverted()` を呼ぶ | **W05** |
| ⑥ | **書き込み先の4点がソース定数**（「審査時間外は 404」の置き換え） | 審査ウィンドウは**撤回**（パートナー審査は非同期【一次】。窓を切ると審査員が見た時に 404 になり、唯一の「決め打ちでない」証拠が消える）。→ **宛先（`P_d`）・node（`dns("seller-d.eth")`）・キー（`x402-offer`）・値（2値）の4つが全部 `constants.ts` の `as const`** で、リクエストが決めるのは「on か off か」の**真偽値1つだけ** | **W06** |

**入力の固定（W01 が固定する）**: **自由入力を取らない**。`amount` を `10000` ⇄ `10001` の**2値で入れ替えるだけ**。リクエスト本文は `{"to":"10001"}` か `{"to":"10000"}` のどちらか。**他の値・他のキー・数値型・本文なし・`null` は全部 400**（本文は `{error:"invalid_body"}` 固定。売り手の文字列を反射しない）。

**`ensureReverted()` の形（W05・二重押しの穴をここで塞ぐ）**

1. `tokyo_mutations` の行を1文で読む。`current_value` が `10000` なら `{status:"clean"}` で終わり（**tx を打たない**）
2. **戻す権利を1文で取る**: `UPDATE tokyo_mutations SET reverting_until = now() + interval '60 seconds', generation = generation + 1 WHERE id = 1 AND current_value <> '10000' AND (reverting_until IS NULL OR reverting_until < now()) RETURNING generation` → 行が返らなければ `{status:"already_reverting"}`・**tx を打たない**
3. 取れたら `setText(NODE, KEY, VALUES.off)` を W_op で署名。署名は `acquireLease("tokyo-mutate", 60)` の中で行う（**`@/lib/cron/lease` は import してよい**——lease ＋ db ＋ log で 5 ファイル・env 1つ・動的 0【実測】）
4. 成功したら `UPDATE … SET current_value = '10000', reverting_until = NULL, last_tx = :hash WHERE id = 1 AND generation = :取った generation`（generation が進んでいたら間に誰かが押した。**上書きしない**）

**残る穴を正直に書く**: 誰も `/tokyo` を開かず誰も押さなければ `seller-d.eth` は `10001` のまま残る（**見る人がいないので害が無い**。次の来訪者の**描画の前**に戻る）／1回押す = **2 tx**（変える＋戻す）でガスは W_op から出る／署名が 60 秒以上かかると2人目が重ねて戻す tx を出しうる（無駄ガス1本・壊れはしない）。

**止め方（会期の深夜に探さないよう逐語で置く）**: 既存の `/api/admin/spending-halt` は `l1_spending_halt` に**固定**で、**流用すると本物の L1 購入まで止まる**【実測】。**admin route は触らない。**止めるのは SQL 1文。

```sql
INSERT INTO runtime_flags (name, enabled, reason, updated_by)
VALUES ('tokyo_button_halt', true, '<理由>', 'takeshi')
ON CONFLICT (name) DO UPDATE SET enabled = true, reason = EXCLUDED.reason, updated_at = now();
-- 再開は enabled = false
```

DB ごと落ちたときの最後の手が env `TOKYO_JUDGE_BUTTON_DISABLED=1` ＋ 再デプロイ（Vercel の env は**再デプロイするまで効かない**ので、これは保険であって操作卓ではない）。

**判定（テストの走らせ方をここで1つに決める）**

```bash
# ページと verify に鍵も署名器も無い（**パスを限る。mutate / reset / state は除外範囲**）
grep -rn 'signTypedData\|PRIVATE_KEY' $WT/src/app/tokyo $WT/src/app/api/tokyo/verify | wc -l   # → 0
# mutate 側は関門6つをテストで固定する（**grep では固定しない**）
npx tsx --test tests/tokyo-mutate.test.ts        # W01〜W06 が pass・fail 0
npx tsx --test tests/tokyo-mutate.pg.test.ts     # W03-a・W03-b（TEST_DATABASE_URL が無ければ skip）
```

**`node --test` では走らない。**`tests/*.test.ts` の 174 本が `@/` のエイリアスを import しており、素の `node --test` は解決できない【実測】。置き場も `$WT/test/` ではなく **`$WT/tests/`**（既存の glob `tests/*.test.ts` に入る＝`npm test` でも必ず走る）。DB が要る W03-a は `tests/tokyo-mutate.pg.test.ts` に分け、**先頭で `assertTestDatabaseIsNotProduction()` を呼ぶ**（`tests/helpers/pg-test-guard.ts`。既存の .pg テストは全部これを通している【実測】。本番 DB にカウンタを撃たないための関門）。

| ID | 何を固定するか |
|---|---|
| **W01** | (a) import グラフの `unresolved` が**空**（空でなければ、その先の env を見ていない＝この関門は何も守っていない）／(b) env 名の集合が **`["DATABASE_URL","TOKYO_JUDGE_BUTTON_DISABLED","TOKYO_OPERATOR_PRIVATE_KEY","TOKYO_SEPOLIA_RPC_URL"]` と完全一致**（**足りないも赤**——許可リストが腐るのを防ぐ）／(c) `/(_PRIVATE_KEY\|_SECRET_KEY\|_SEED\|_MNEMONIC)$/` に当たる名前が `TOKYO_OPERATOR_PRIVATE_KEY` の1本だけ／(d) 動的 `process.env[…]` が 0 本／(e) 本文は `{"to":"10001"}`・`{"to":"10000"}` の2つだけ 200、他は全部 400。入口は `mutate`・`reset`・`state` の3つ。walker は `tests/helpers/env-graph.ts`（依存ゼロ・約 60 行・`@/` と相対 import と `import("…")` を解決し、**解決できなかった指定子を必ず返す**） |
| **W02** | `chainId` はソースの定数 `11155111`。本文に `chainId` を混ぜたら 400（知らないキー）。`client.getChainId()` が `11155111` でなければ 503（本文 `{error:"chain_mismatch", expected:11155111, got:…}`） |
| **W03** | 61 回目は 429（本文 `{error:"daily_cap", max:60}`）／`runtime_flags.tokyo_button_halt` が true なら 503／**フラグが読めなければ 503**（fail-closed。ガスを守る側へ倒す）／写した `decideHalt` が本家（`src/lib/observatory/kill-switch.ts`）と同じ5入力で同じ答えを返すこと（**import するのはテストだけ**）／`TOKYO_JUDGE_BUTTON_DISABLED="1"` で全リクエストが 503（`"0"`・空・未設定は通る。**止めに使うのは `"1"` の1値だけ**）／上限の判定が「読んでから書く」2文になっていないこと（`INSERT … ON CONFLICT` の1文の中に比較が入っている） |
| **W04** | 残高が床未満のとき 503・本文に `balanceEth` と `floorEth`・**`writeContract` の呼び出し回数 0**（503 を返しながら署名していたら意味がない）／ちょうど床は通る／**残高が読めないときも 503 ＋ 署名 0 回** |
| **W05** | clean なら tx 0 本／`mutate` の先頭で前回が戻る（`writeContract` が 2 回・1本目が `off`・2本目が `on`・**順番も assert**）／二重に押されても戻す tx は 1 本／戻している間に誰かが変えたら戻し結果で上書きしない（`{status:"superseded"}`）／`state` 経由は `mutated_at` が 90 秒未満なら戻さない・91 秒なら戻す／**`90000` という数値リテラルが `constants.ts` 以外に無い** |
| **W06** | 敵対的な本文（`name`・`node`・`resolver`・`key`・`value` を混ぜたもの）は**全部 400**／正常な `{"to":"10001"}` のとき `writeContract` の引数が逐語で `address === P_d` / `functionName === "setText"` / `args = [NODE, "x402-offer", VALUES.on]`／`route.ts` と `_lib/*.ts` のソースに `setResolver`・`setAddress`・`setSubregistry`・`linkToRecord`・`linkToNode`・`grantSetterRoles`・`revokeRoles`・`register`・`unregister` の文字列が**1つも無い**／`NODE` が `dns("seller-d.eth")` と一致すること／`state` と `page.tsx` に `force-dynamic` があり、`state` の応答に `Cache-Control: no-store` があること |

**W01〜W06 は `$WT/tests/tokyo-mutate.test.ts`（＋ `.pg.test.ts`）に置き、`T`／`U` の本数（§5 の 56）には数えない**（Next.js 側のテストで、`$SDK`/`$MCP`/`$DEMO` の数え方の外）。

**押した後の画面（「理由の分からない REFUSE」が起きるのは、画面が現在値を隠すときだけ）**

| 置き場 | 出すもの |
|---|---|
| `/tokyo` の上部・常時 | **いまの `seller-d.eth` の `x402-offer` の `amount`**（チェーンから読んだ生値）と、`10000` なら「素の状態」・`10001` なら「**審査員が 12:03:41 UTC に1文字変えました**」の帯 |
| 同・帯の中 | 変えた tx のエクスプローラのリンク ＋ **「10000 に戻す」ボタン**（`10001` のときだけ出す） |
| 7段の5段目が赤のとき | 拒否語（`ens_attestation_signer_mismatch`）の隣に **「この赤はボタンが作りました。約束が 10000 → 10001 に変わったので、署名された証明と合いません」**の1文 |
| 同・下 | **直前の操作ログ 10 件**（時刻 UTC・`10000→10001` / `10001→10000`・tx hash）。押した人は記録しない |
| 押せないときの帯 | 503 の本文の1行をそのまま（残高の床・停止中・上限到達）。**ボタンを黙って消さない** |

**鍵を隠す代わりに、鍵の狭さをチェーンから示す**

- W_op のアドレスと、`P_d` での `roles(keccak256("x402-offer"), W_op) = 0x10`
- **K1-D4 の tx の `ResourceArgument` ログ**（**キー名が平文で残る**・§2.2）へのエクスプローラのリンク
- 1行: 「この鍵が `P_d` で書けるのは `x402-offer` だけです。同じ鍵で証明のキーを書こうとすると `EACUnauthorizedAccountRoles` で止まります」＋ その eth_call の出力（C-02 と同型）

**開示（`SUBMISSION.md` と `for-reviewers.md` の両方に1行）**: "The judge button signs with a delegated Sepolia key held server-side. It can only write the `x402-offer` key on `seller-d.eth`'s own resolver, and only between two fixed values."

**なぜボタンを入れるか**: 賞の本文 "not just hard-coded values" に正面から答える唯一の形で、**壊れる瞬間が動画の中だけでなく審査員の画面で起きる**。ENS 賞の入賞3作の共通点（「ENSv2 だから“できない”ことを1瞬間に落とす」）に直接当たる。

**会期中の作業順（迷わないための1本道・`guards/GUARDS.md` §10）**

0. **先に `cd ~/vouch && npm ci`**（`node_modules` が空・`tsx` も無い【実測】）。node の版は **24.x**（手元は 26.3.0・§2.7）
1. `scripts/sql/2026-09-2x-tokyo-mutations.sql`（上の2表。`runtime_flags` には**行を入れない**＝行が無い＝止めていない）
2. `src/app/api/tokyo/_lib/constants.ts`（W02・W04・W06 の定数を全部ここに）
3. `tests/helpers/env-graph.ts`
4. `tests/tokyo-mutate.test.ts` に W01-a〜d を**先に**書く（route がまだ無いので赤）
5. `src/app/api/tokyo/mutate/route.ts` を `deps` 差し替え口つきで書く（`export async function handle(request, deps)` ＋ `POST` は `handle(request, realDeps)` を呼ぶだけ。`MutateDeps = { getChainId, getBalance, getGasPrice, writeContract, readText, claimRevert, readHalt, consume, now }`）
6. W01-e・W02・W04・W06 を通す
7. `_lib/revert.ts` と `reset/route.ts`・`state/route.ts` を書き、W05 を通す
8. `tests/tokyo-mutate.pg.test.ts` に W03-a・W03-b を書き、`TEST_DATABASE_URL` で通す
9. 判定: `npx tsx --test tests/tokyo-mutate.test.ts` が `fail 0`

### 3.8 CLI 1発の検証コマンド — `examples/tokyo-2026-demo/src/run.ts`（新規）

```bash
# README の冒頭と提出文に置くのはこの1行だけ（**npm 公開にも root の package.json にも依存しない**）
git clone --depth 1 --branch tokyo-2026-submission https://github.com/kzmttkc/vet402 && cd vet402/examples/tokyo-2026-demo && npm ci && npm run verify -- seller-a.eth
# 検証そのものは約 10 秒。clone と npm ci を含めた時間は B11 で clean な一時ディレクトリで測って書く
```
- **2026-09-24 に実測で変えた**: 旧案の `npx github:kzmttkc/vet402#… verify …` は**動かない**。root の `package.json` に `bin` が無いので **`npm error could not determine executable to run`（exit 1）**【実測 09-24 18:23】。`bin` を足すと、①root の `package.json` が請求の範囲に入る ②npx が本体の依存（Next.js を含む）を丸ごと入れて遅い ③`.ts` を直接走らせるので node 20/22 の審査員の環境で落ちる、の3つが同時に起きる。**だから審査員の入口は `examples/tokyo-2026-demo` という小さな独立パッケージにする。**
- **B2 で `examples/tokyo-2026-demo/package.json` に `"scripts": {"verify": "tsx src/run.ts verify"}` と `devDependencies.tsx` を置く**（`npm ci` は devDependencies も入れるので、審査員の node の版に依らず走る）。**`--branch tokyo-2026-submission` で凍結した状態を取る**（main は提出後も動く）
- **`npx @vet402/tokyo-demo …` と書かない**。`@vet402/tokyo-demo` は npm に**無い（404）**【実測 09-19】。npm 公開は任意で、やるなら SDK → MCP の順で B11 の後（公開しても提出文は上の形のままにする）
- 下位コマンド: `pay` / `verify` / `census` / `mutate` / `reset` / `cut-vet402` / `scene3`
- `census` は K1 の判定に使う形（§4 の期待の1行）。`verify` は B5b と `/tokyo` と同じ `checkEnsOffer` を呼ぶ
- **`run.ts verify` は B2 で書く。K1 形式の `census` は B4b で書く**（K1 と B5b の判定がこれを使う）
- **`cut-vet402` の定義（§3.3.3 と同じ・1つに固定）**: `VET402_API_URL` を**接続不能なアドレス**（既定 `http://127.0.0.1:1`）に差し替えるか、`--mode 503` で 503 を返す捨てプロセスに向ける。**この2つだけが「届かない」**。`--mode 404` は用意しない（現物でも拒否のままで、絵にならない）
- `cut-vet402 --restore` で元に戻す。撮影では**接続不能**の側を使い、横のターミナルに `curl: (7) Failed to connect` を出す

### 3.9 その他の変更

| 置き場 | 中身 | 金の経路か |
|---|---|---|
| `packages/sdk/src/chain-profile.ts`（新規） | `base` / `base-sepolia` の定数表（chainId・USDC・EIP-712 domain・v1 slug・`attest` の可否） | **はい** |
| `packages/sdk/src/x402-pay.ts`（変更） | ドメイン名・USDC・chainId・v1 slug を profile から引く | **はい** |
| `packages/sdk/package.json`（変更） | `peerDependencies.viem ^2.55.1`（optional）・`devDependencies.viem`。**`exports` に `"./ens"` のサブパスを足す**（`{"types":"./dist/ens.d.ts","default":"./dist/ens.js"}`。`ens.ts` は `ens-attestation` / `ens-read` / `atst-codec` / `ens-reasons` を再輸出する束ね口）。名前を使う呼び手は `@vet402/sdk/ens` を import し、**`@vet402/sdk` の入口（`dist/index.js`）には viem が静的に入らない**。lockfile 2つを同じコミットで再生成 | いいえ |
| `src/app/api/tokyo/seller/route.ts`（新規） | Base Sepolia の最小売り手。**URL は `https://vet402.com/api/tokyo/seller` に固定**（約束の `resource` に入り、変えると全証明が失効する）。**本文の最上位に `result` と `observed_at` を必ず返す**（§3.3.1 で決めた `output.required`）。**秘密鍵を持たない** | 売り手側 |
| `skills/pay-or-refuse/SKILL.md`（変更） | 語彙の表（141-157 行）に新語 17 個を足す。**同じコミットで**（`tests/agent-skill-plugin.test.ts` が過不足なし一致を強制） | いいえ |
| `packages/mcp-server/src/pay-if-trusted.ts`（変更・任意） | `payeeName?`・`network?`・判定の前に ENSIP-29 段。**語彙の表の更新は MCP を落としても必須** | はい |
| `examples/tokyo-2026-demo/trusted-attesters.json`（新規） | 信頼する attester を記録の種類ごとに (名前, アドレス) で。`minValid`・`maxAgeSeconds` | いいえ |
| `examples/tokyo-2026-demo/src/{keys,attester,probe-rpc}.ts`（新規） | 鍵の生成（**アドレスだけ表示**）・attester の6段・RPC の検査 | 支払いは SDK 経由だけ |
| **`docs/tokyo-2026/attester-spec.md`（新規・§1.7 の弱点1つ目への答え）** | **2人目の attester が満たす条件**を1枚のプロトコルとして書く。中身は下の「attester の手順」の6段をそのまま仕様の言葉に写したもの（チャレンジ署名で `a` を確かめる／`findExactOwner` が `a`／実際に買って `compareOfferToAccept` が空／本文が `output.required`（`result`・`observed_at`）を満たす／別ブロックで (n,a,v) が不変／`t` を決めて署名）＋ 名前の置き方（`atst.<attester>.eth`・草案 48 行）と、消費者側が (名前, アドレス) をローカルに固定する規律。**自作の2人目は作らない**（§1.6） | いいえ |
| **`docs/tokyo-2026/human-log.md`（新規・その場で書く）** | 人が見た物と決めたことを**その場で3行**（時刻・人が見た物・人が決めたこと）。受け入れ枠（B3・B6）・K1・撮影の各ブロックの**完了条件に入っている**（§6.2）。`AI_USAGE.md` はこのログから作る。**事後の要約で書かない** | いいえ |

**attester の手順（草案 50-54 行に1対1・どれか1つでも通らなければ署名しない）**: (1) 名前の持ち主にチャレンジ文へ EIP-191 署名させ `verifyMessage` で `a` を確かめる (2) `findExactOwner(dns(n))` が `a` (3) 約束の 402 を取り `compareOfferToAccept` が空 → `payOrRefuse`（`payee` はアドレス・`network:"base-sepolia"`・`requireVet402Allow:false`＋`minChainReceipts:1`）で実際に買う (4) 本文が `output.required` を満たす (5) (n,a,v) を別ブロックで読み直して不変 (6) `t` を決めて署名 → envelope（base64）と観測ログを出す。

### 3.10 Intercepta の枠（Continuity 専用 $500・2026-09-23 追加。**ENS を1ミリも削らない条件つき**）

**賞の逐語（`ethglobal.com/events/tokyo2026/prizes/intercepta`・09-22 取得）**: "Add Payment Screening to Your Agent or x402 Service" $500・**Continuity Track participants only**。要件4つ = ①既存の製品・リポに審査の機能を1つ足し、新しいコードを公開 ②**支払いの署名・送信・受け取りの前に Intercepta の API を本番の流れで呼び、結果が画面に見える** ③デモで前後を見せ、**止まった（block / hold）支払いを1件**出す ④README に API を呼ぶファイルと、感想3〜5行。**Canton 上の実装は要求されていない**（`W3A_CANTON.md`）。

**一次の実測（09-23・docs.web3antivirus.io）**
| 何 | 値 |
|---|---|
| 口 | `GET https://api.web3antivirus.io/api/public/v2/extension/account/{address}/quick-scan`（"Designed for real-time use cases where low latency is critical"） |
| 認証 | ヘッダ `X-API-KEY` |
| 返り | `{"toxicScore": number, "traits":[{"risk","name","txsCount","description"}]}`。`name` は 15 語の固定語彙（`sanction_address`・`known_scammer`・`mixer_transfers`・`blacklist` ほか） |
| 鍵 | `intercepta.io/ethglobal` の申込フォーム（氏名・メール・作っているもの）。**即時ではない**（"Keys arrive by email within a few hours during the event"）。1鍵 1,000 リクエスト・審査期間中有効 |
| 追加 | 1,000 を超えるときは X・Telegram `@intercepta_` かメールで。"usually within the hour" |
| 生きているか【実測 09-23 19:2x JST】 | 鍵なし → **403** `{"status":403,"response":"This authentication key is incorrect or doesn’t exist"}`・往復 **0.95 秒**（エラー経路・東京から）。→ **タイムアウト 3 秒**の設定はこの実測に基づく。本番の応答時間は鍵が届いた日に取り直す |

**設計（決定）**
1. **呼ぶ位置は段S（screening。§3.2 のブロックの「段0」とは別物）。ただし置き場は SDK ではなく `examples/tokyo-2026-demo` の中**（**これは守る**）。`examples/tokyo-2026-demo/src/screening.ts`（新規）を `tokyo pay <name>` の**いちばん最初**に置き、ENS から読んだ `x402-offer.payTo` と**支払う側のアドレス**の2つを quick-scan する。証明の検証より前に置くのは、**危険な宛先なら証明が正しくても払わない**から。結果は画面に1行（`screening: payTo 0x… toxicScore 0 (clean) / payer 0x… toxicScore 0`）。
2. **止まる1件の作り方（本物の判定を使う。作り話にしない）**: K1 に **seller-e 一式（§4 の K1-E1〜E3・最大5 tx・≈ 433,775 gas）**を足す（登録 → `setResolver(P_bc)` → `x402-offer` の `setText`。**新しいリゾルバは配備せず、証明も付けない**）。**枠を使うときだけ打つので、Sepolia の tx は 26 → 31 になる**（§6.2 の数え方もこのときだけ変わる）。その `payTo` に **Intercepta が実際に `sanction_address` 系の trait を返す本番アドレス**を書く。デモは `tokyo pay seller-e.eth` → **`REFUSE payee_screening_blocked`（trait 名と `txsCount` を画面に出す）**。段S で止まるので、証明が無いことは理由にならない。
   - **アドレスの選び方**: 鍵が届いた直後に候補を quick-scan で1件ずつ叩き、**`toxicScore` が高く `traits` に `sanction_address` か `known_scammer` が出たものだけ**を使う。出なければこの枠は落とす（`traits` が空のアドレスを「危険」と呼ばない）。
3. **API が落ちた・遅いときは通さない側に倒す**（`REFUSE payee_screening_unavailable`・理由を画面に出す）。タイムアウト 3 秒。vet402 の「確かめられないなら払わない」と同じ向きで、**vet402 の API が落ちたら床で払う**（段2.5）のと**わざと逆**なのは、あちらは「床を宣言してある」からで、こちらは宣言できる床が無いため。この非対称を README に1行書く。
4. **1,000 リクエストの守り方**: 判定はアドレス単位でプロセス内に 10 分キャッシュ。**審査員ボタン（mutate/reset）からは呼ばない**（押下 120 回で枠を食う）。**`/tokyo` からは一切呼ばない・表示もしない**（本番 env に API キーが増えると W01 の「env 4つと完全一致」が割れる）。判定が見えるのは**デモの画面と録画**で、賞の要件「visible in the real flow」はそちらで満たす。
5. **README（`docs/tokyo-2026/for-reviewers.md` と repo README）**: 「API を呼ぶファイル = `examples/tokyo-2026-demo/src/screening.ts`（と `tests/screening.test.ts`）」＋**感想3〜5行**（実測に基づく: 応答時間・`traits` の語彙が扱いやすいか・testnet の支払いで mainnet のアドレスを見る設計のこと・欲しかった口）。
6. **落とす順は最優先で1番目**（§7 の表の前に置く）。**K1 が 09:15 を過ぎていたら着手しない。**ENS の $6,000／$4,000 の作業・場面2・場面3・審査員ボタンより後回しで、**これらを1つでも削るなら Intercepta は捨てる**。
7. **ガスへの影響**: `seller-e` の2 tx は **W_ens** から。登録 ≈ `seller-a` と同型・`setText` ≈ 78,506 で、**合計 ≈ 0.5M gas（登録一式 ≈ 0.4M ＋ `setText` 78,506。関門 4,800,000 に対する余裕の範囲）**。Sepolia の関門の数字は変えない。
8. **動画**: 3:25 の「まとめ」の前に **20 秒**入れる（`seller-a` は通る → `seller-e` は止まる）。全体は 4:00 を超えない。超えるならまとめを削る。

**触らないもの（ここを外すと 24 時間が溶ける）**
- **`packages/sdk` の `payOrRefuse` の判定の順（§3.3.3 の7段）には1行も入れない。**入れると拒否語が SDK の語彙になり、`tests/agent-skill-plugin.test.ts`（過不足なし一致）と `tests/caller-policy-sdk-parity.test.ts` を巻き込む。**`payee_screening_blocked` / `payee_screening_unavailable` はデモ側の出力語**で、`skills/pay-or-refuse/SKILL.md` の語彙の表にも足さない。
- **審査員ボタン（W01〜W06）の関門は変えない。**mutate/reset から screening を呼ばない。
- **`seller-e.eth` の登録は `seller-d` と同じ手順**（テスト USDC の `approve` → `commit` → 60 秒待ち → `register` → `setText`）。**最大5 tx**で、`MIN_COMMITMENT_AGE` の 60 秒は K1 の他の tx と重ねる。テスト USDC は 968.3 あるので足りる【実測 09-19】。リゾルバは **`P_bc` を再利用**（`VerifiableFactory.deployProxy` は打たない）。

**この枠の完了の条件**: ①鍵が手元にある ②`traits` が実際に出るアドレスを1つ確認した ③`tokyo pay seller-e.eth` が `payee_screening_blocked` で止まる ④README の3〜5行がある。**どれか1つでも欠けたら出さない**（部分的に出して要件を外すより、出さない方が良い）。

---

## 4. K1 の tx 一覧（通し番号・順番・from・引数の要点・gas・依存・戻し方）

**人（Takeshi）が打つ。AI は `--dry-run` の出力を読み、census で判定する。AI は `--live` を打たない。**

**本数**: K1 ブロックで打つのは **Sepolia 26 tx**（**Intercepta の枠を使うときだけ seller-e 一式 +5 で 31**・§3.10）（本体 **22** ＋ K1-post **4** ＋ BS-03 **1**）と **Base Sepolia 2 tx**（BS-01・BS-02）。本体 22 の内訳は K1-01〜K1-15（15）＋ K1-15b（1）＋ **seller-d 一式（6）**。B5b の証明の掲載（4 tx）と、デモで打つ tx（D-1〜D-6・T7）は別枠。

**合計 gas を1つの数字で正典にしない。**正典は**鍵ごとの実測合計と関門**（下の表）である。1つの合計値は、どの tx を数えるか（K1-post を入れるか・B5b を入れるか・デモを入れるか）で何通りにもなり、v4.1〜v4.2 で実際に 3,388,563／3,476,015／3,510,377／3,597,829 の4通りが並び立った。**その4つは全部使わない**（§10.6）。

**ガスの数字は「その calldata での上限の見積もり」として扱う。1 gas 単位の一致を主張しない。**【実測・sim】: 実鍵に近いダミー（非ゼロバイト 20 本）で全 15 tx を測り直すと **合計 +1,092（+0.03%）**（K1-06 +228・K1-12/13/14/15 各 +216）。**無視してよい大きさ**だが、**文字列の長さは無視できない**——約束 JSON が 1 文字伸びると 12 gas、**32 バイト境界を跨ぐと1回につき +約 22,800**【実測】。だから §3.3.1 で `output.required` を `["result","observed_at"]` に**決めた**。この表はその長さ（約束 266 バイト・方針 178 バイト）で測っている。**B0 で実 calldata で再測する。**

**鍵ごとの実測合計と関門**【実測・`eth_simulateV1`・block 11,735,920（seller-d だけ 11,735,943）・今日の Sepolia のガス価格 1.028 gwei（2系統一致）】

| 鍵 | 会期中に払う全部の実測合計 | **関門（`gas-budget.mjs` の正典）** | 今の残高 | 残高が尽きる gwei |
|---|---|---|---|---|
| **W_vet** `0x502B…b8e6` | **2,953,236** | **4,200,000** | 0.05 ETH【実測】 | **11.9** |
| **W_ens** `0xC0f5…9fa6` | **3,546,604**（seller-d 一式 1,178,390 と BS-03 の送金 21,000 込み） | **4,800,000** | 0.089247 ETH【実測】 | **8.2**（W_op へ 0.05 送った後） |
| **W_op**（アドレスは会期中に `keys.ts init` が作る【未確認】） | 押下1回 **157,012**（mutate 78,506 ＋ reset 78,506） | **3,300,000**（撮影の1往復 ＋ 審査員 20 回 ＝ 21 押下 ＝ 3,297,252） | BS-03 で **0.05 ETH** を受け取る | **15.2** |

**余裕の中身（「何％」で決めていない）**: W_vet は**最大の1本 K1-03（918,878）を1回打ち直せる額**＋戻しの `revokeRoles` ×2〜3 と `setSubregistry(…,0)`（約 150,000）＋文字列長の振れ（約 130,000）。W_ens は**最大の1本 K1-07（861,493）を1回打ち直せる額**（salt を変えて作り直すので全額かかる）＋文字列長の振れ ±22,800 × 4 記録 ＝ 91,200 ＋ 戻しの `setResolver` ×3（121,260）と `revokeRoles`（38,317）。**2本以上が続けて失敗したら、関門で吸収せず K1 を止めて資金を足す。**

**安全係数は 3**（今日の 1.028 gwei の3倍＝3.08 gwei まで関門を緑にする）。直近 1,032 ブロック（約 3.4 時間）の baseFee の振れは min 0.917／p50 1.062／p99 1.188 gwei で **±15% しかない**【実測】が、**会期は7日先で、Sepolia が跳ねた事例は今回測っていない【未確認】**。だから安全係数は実測の振れからではなく「耐性の置き方」として 3 に置く。

| # | from | 宛先 | 関数・引数の要点 | gas | 依存 | 失敗したときの戻し方 |
|---|---|---|---|---|---|---|
| ~~K1-01~~ **打たない**（2026-09-24 決定） | W_vet | R_vet `0x3368…8391` | ~~`revokeRootRoles(ALL_ROLES, 0xE96b…173f)`~~ **剥がすのをやめる**。理由: そのアカウントは**自分のウォレットが所有するスマートアカウント**（`owner()` = W_vet・実測）。**「持ち主だけが書ける」は剥がさなくても真**。→ **Sepolia は 27 → 26 tx**（Intercepta 版は 31） | 41,137 | なし | 戻さない（剥がす前の状態は `EACRolesChanged` の履歴に残る。開示に「剥がすまでは2者が書けた」と書く） |
| K1-02 | W_vet | R_vet | `multicall[setText(dns("vet402.eth"),"agent-endpoint[x402]"), setText(dns("vet402.eth"),"class"), setAddress(dns("atst.vet402.eth"), 60, K_atst)]` ← **`x402-policy` は絶対に書かない**（§3.5.3 の罠） | 172,786 | K1-01 | 同じ関数で値を上書き |
| K1-03 | W_vet | R_vet | `multicall[grantSetterRoles(setText(dns("x.obs.vet402.eth"), key_i, ""), W_obs) ×15]`（`ResourceArgument` 15 本＋`EACRolesChanged` 15 本） | 918,878 | （K1-01 は打たないので依存なし） | `revokeRoles(keccak256(key_i), ROLE_SET_TEXT, W_obs)` ×15 |
| K1-04 | W_ens | VerifiableFactory | `deployProxy(impl, SALT_A=keccak("tokyo-2026/seller-a.eth"), initialize([(W_ens,ALL)], calls))` → **P_a `0xC54403186Db35B9D92cc393Ae665D3960117ac14`**。**`calls` は3本**: `setText(dns("seller-a.eth"),"x402-offer",<§3.3.1 の 266 バイトの約束>)`・`setText(dns("seller-a.eth"),"agent-endpoint[x402]","https://vet402.com/api/tokyo/seller")`・`setAddress(dns("seller-a.eth"),60,W_ens)`。**証明キーは入れない**（署名は購入の後にしかできないので B5b で別に書く） | **575,239** | なし | 別の salt で作り直す（アドレスは送り手＋salt で決まる） |
| K1-05 | W_ens | ETHRegistry | `setResolver(getState(labelhash("seller-a")).tokenId, P_a)` | 40,420 | K1-04（アドレスは事前計算できるので並べて署名可） | `setResolver` で元のリゾルバに戻す |
| K1-06 | W_ens | P_a | `grantSetterRoles(setText(dns("seller-a.eth"),"x402-offer",""), W_op)` ← **`initialize` の calls に入れると revert** | 87,356 | K1-04 | `P_a.revokeRoles(keccak256("x402-offer"), 0x10, W_op)`（38,317・E15 で実測） |
| K1-07 | W_ens | VerifiableFactory | `deployProxy(impl, SALT_BC, initialize([(W_ens,ALL)], calls))` → **P_bc `0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf`**。`calls` は b・c それぞれ **本物の 266 バイトの約束**＋証明キーの仮値＋`setAddress(60,W_ens)` の6本。**記録 ID は b=1・c=2 で確定** | **861,493** | なし | 同上 |
| K1-08 | W_ens | ETHRegistry | `setResolver(tokenId(seller-b), P_bc)` | 40,420 | K1-07 | 同上 |
| K1-09 | W_ens | ETHRegistry | `setResolver(tokenId(seller-c), P_bc)` | 40,420 | K1-07 | 同上 |
| K1-10 | W_vet | VerifiableFactory | `deployProxy(UserRegistryImpl `0xA80338aA…0263`, SALT_U, initialize([(W_vet, ALL_ROLES)]))` → **U** | 178,021 | なし | 別 salt で作り直す |
| K1-11 | W_vet | ETHRegistry | `setSubregistry(tokenId(vet402.eth), U)` ← **打つ直前に simulate を打ち直し、`atst.vet402.eth` と `<hash>.obs.vet402.eth` の `findResolver` が `R_vet` のままであることを同じ出力に印字する。違ったら進まない** | 57,520 | K1-10 | `setSubregistry(tokenId, 0x0)` で外せる（**`ETHRegistry.revokeRoles(vet402, ROLE_SET_SUBREGISTRY)` は絶対に打たない**） |
| K1-12 | W_vet | VerifiableFactory | `deployProxy(impl, SALT_A1, initialize([(W_vet,ALL)], [setText(dns("agent-1.vet402.eth"),"x402-policy",<§3.5.1 の7キー・178 バイト>), setText(class), setAddress(60, K_ag1)]))` → **P_AG1 `0xd3F4818c0bB93e54780525b21380D44D6D06bcd6`** | **462,532** | なし | 別 salt |
| K1-13（09-24 更新: ガス 172,536 → **149,897**。他人が先に `agent-1` のラベルを登録し、共有の箱 `LabelStore` への初回書き込みが消えたため・`rehearsal/EXPECTED_DIFF.md` §3） | W_vet | U | `register("agent-1", K_ag1, 0, P_AG1, ROLE_RENEW, <expiry>)` | 172,536 | K1-10・K1-12 | `U.unregister("agent-1")`（72,604）→ 再 `register`（132,797） |
| K1-14 | W_vet | P_AG1 | `grantSetterRoles(setText(dns("agent-1.vet402.eth"), "x402-policy", ""), K_ag1)` ← **`initialize` の calls に入れると revert** | 87,452 | K1-12 | `P_AG1.revokeRoles(keccak256("x402-policy"), 0x10, K_ag1)` |
| K1-15（同上: 170,381 → **147,742**） | W_vet | U | `register("agent-2", K_ag2, 0, **0**, ROLE_RENEW\|ROLE_CAN_TRANSFER_ADMIN, <expiry>)` ← **対照**（専用リゾルバ無し＝親の wildcard に落ちる） | 170,381 | K1-10 | `unregister` |
| **K1-15b** | W_vet | **R_vet** | `grantSetterRoles(setText(*, "x402-policy", ""), K_ag2)` ← **これが無いと §3.5 の before/after が成立しない**。K1-15 だけでは `K_ag2` も親のキーで revert する（C-18【実測・sim】）。打つと `K_ag2` が `agent-2` だけでなく **`vet402.eth` 本体と `atst.vet402.eth` の `x402-policy` も書けるようになる＝これが "after"**。**漏れの実演は `eth_call` / simulate の出力だけ**（live で書かない・§1.6） | **87,452** | K1-15 | `R_vet.revokeRoles(keccak256("x402-policy"), 0x10, K_ag2)` |

**seller-d 一式（審査員ボタンの書き込み先。`from` は全部 W_ens・K1-04/05/06 と同型）**

v4.2 まで `seller-d` は本文に1行しか出てこず、**K1 に tx が1本も無かった**（§3.7 の本文も `seller-a.eth` のままだった）。**このままでは会期初日を全部打っても、審査員ボタンの書き込み先が存在しない。**下の5行を K1 に足す。**すべて `eth_simulateV1` で実測した**【block 11,735,943・全行 OK】。

| # | from | 宛先 | 関数・引数の要点 | gas | 罠 |
|---|---|---|---|---|---|
| **K1-D1** | W_ens | MockUSDC → ETHRegistrar | **登録の3 tx**: `MockUSDC.approve(ETHRegistrar, max)`（46,330）→ `ETHRegistrar.commit(commitment)`（45,426）→ **60 秒待つ** → `ETHRegistrar.register("seller-d", W_ens, …, 1年)`（223,093）。`admin.ts register-d` が待ちも含めて打つ | **314,849**（3 tx） | **家賃は MockUSDC 払い**（8.000021 / 1年。残高 968.304368 で足りる）。**ETH 建ての `getRegisterPrice` は revert する**。`MIN_COMMITMENT_AGE` = **60 秒**なので commit と register は別ブロック |
| **K1-D2** | W_ens | VerifiableFactory | `deployProxy(impl, SALT_D, initialize([(W_ens,ALL)], calls))` → **P_d `0x9CF7990dAB364d1738ABB09532b953Ec48269831`**。`calls` は K1-04 と同型（本物の 266 バイトの約束・`agent-endpoint[x402]`・`setAddress`） | **575,239** | 予定アドレスは B0 で `--print-predicted` で取り直す |
| **K1-D3** | W_ens | ETHRegistry | `setResolver(tokenId(seller-d), P_d)` | **40,420** | 戻しは `setResolver` で元へ（40,420 見込み） |
| **K1-D4** | W_ens | P_d | `grantSetterRoles(setText(dns("seller-d.eth"),"x402-offer",""), W_op)` ← **審査員ボタンの鍵の委任。この tx の `ResourceArgument` を `/tokyo` からリンクする**（§3.7.1） | **87,356** | 戻しは `P_d.revokeRoles(keccak256("x402-offer"), 0x10, W_op)`（38,317） |
| **K1-D5** | W_ens | P_d | **B5b で打つ**: `setText(dns("seller-d.eth"), "attestations[x402-offer][atst.vet402.eth]", <envelope base64>)` | **160,526** | K1 ではなく **B5b の4本目** |
| | | | **seller-d 一式の合計** | **1,178,390** | `seller-d.eth` は 09-19 時点で `isAvailable = true`【実測】 |

**seller-e 一式（Intercepta の枠を使うときだけ・§3.10。鍵が無ければ1本も打たない）**

| # | from | 宛先 | 関数・引数の要点 | gas（見込み） | 罠 |
|---|---|---|---|---|---|
| **K1-E1** | W_ens | MockUSDC → ETHRegistrar | 登録の3 tx（K1-D1 と同型・`admin.ts register-e`） | **≈ 314,849** | **家賃は MockUSDC**（1年ぶん）。60 秒の待ちは K1 の他の tx と重ねる |
| **K1-E2** | W_ens | ETHRegistry | `setResolver(tokenId(seller-e), P_bc)` ← **`P_bc` を再利用。新しいリゾルバは配備しない** | **40,420** | `P_bc` は seller-b/c と共有なので、**`x402-offer` の委任は誰にも出さない**（出すと F1 の穴を自分で踏む） |
| **K1-E3** | W_ens | P_bc | `setText(dns("seller-e.eth"), "x402-offer", <payTo が要注意アドレスの1行 JSON>)` | **≈ 160,526（暫定）** | **新規の長文の初回書き込み**なので、審査員ボタンの上書き（78,506・warm・同長）の値を当ててはいけない。同型の新規長文 K1-D5 の実測 160,526 を暫定に置く |
| | | | **seller-e 一式の合計** | **≈ 515,795（暫定）** | **未実測**。`P_bc` に seller-e の記録を作る／`Linked` で名前と記録を結ぶ tx が別に要るかは **B0 の `eth_simulateV1` で確かめてから行を確定する**（seller-a/b/c は `deployProxy` の `initialize` の中で作っている）。関門 4,800,000 の余裕の内側 |

**K1-post（K1 の直後に別枠で打つ・4 tx）**

K1-15c・K1-15d は **K1-post へ移した**。理由は、**鍵を持ち替える段（15c は W_ens・15d は W_vet）が判定点①（B5a・09:30）の 15 分前に入っていた**からで、賞の本文は live tx を要求していない。**B5b の後ろへ回してもよい**（U7 の主張は変わらない）。

| # | from | 宛先 | 関数・引数 | gas | なぜ |
|---|---|---|---|---|---|
| K1-post-1 | W_vet | U | `register("atst", W_vet, 0, **0x0**, ROLE_RENEW, <expiry>)` | **168,049** | `U` に `atst` を**リゾルバ無しで先に押さえる**。誰かが resolver ≠ 0 で登録すると `atst.vet402.eth` が他人のリゾルバに解決する【実測】。**予約だけでは塞がらない**ので T7 まで打つ（§3.5） |
| K1-post-2 | W_vet | U | `register("obs", W_vet, 0, **0x0**, ROLE_RENEW, <expiry>)` | **168,037** | 観測ログのラベルを同じ理由で押さえる |
| **K1-15c** | **W_ens** | ETHRegistry | `setSubregistry(tokenId("seller-a.eth"), U)` ← **U7（namespace aliasing via a shared registry）を本番で満たす1本**。`vet402.eth` と `seller-a.eth` という**別の持ち主の2つの名前**が同じ `U` を共有する。**署名は W_ens だけ**（W_vet は `EACUnauthorizedAccountRoles(…,0x100000,0x502B59Fb…)` で revert）【実測・sim 11,734,203】 | **57,532** | `setSubregistry(seller-a, 0)`（35,392）で完全に戻る。`U.revokeRootRoles(UNEMANCIPATED)` の後でも戻せる【実測・sim】。`seller-a.eth` 自身の記録は打っても無傷【実測・sim】 |
| **K1-15d** | W_vet | P_AG1 | `linkToNode(dns("agent-1.seller-a.eth"), namehash("agent-1.vet402.eth"))` ← **record aliasing と namespace aliasing の違いを画で分ける1本**。同じ方針 JSON が `agent-1.seller-a.eth` からも読める | **64,282** | `linkToRecord(dns("agent-1.seller-a.eth"), 0)` で切り離す |

**K1-15c を打つ前の条件**: B0（09-25 21:00）で `node rehearsal/run.mjs --h13` を再走させ、`A3`〜`A5`（`seller-a.eth` 本体の3つの記録）が全部読めることを確認してから `--live` に進む。**ここが違ったら打たない。**
**K1-post は鍵を持ち替える段である**（post-1/2 と 15d は W_vet・15c は W_ens）。上から打つ人が飛ばさないよう、表の `from` 列をそのまま読む。

**資金の tx（別採番。`K1-16` / `K1-17` という呼び方はしない）**

| # | from | チェーン | 中身 | gas |
|---|---|---|---|---|
| **BS-01** | W_ens | **Base Sepolia** | W_pay へ USDC 5 と ETH 少々 | — |
| **BS-02** | W_pay | **Base Sepolia** | W_ens へ USDC 0.01 ＝ **`SEED_TX`**（D1-a の `minChainReceipts` が数える受領）。`.env.tokyo.local` に追記 | — |
| **BS-03** | W_ens | **Sepolia**（名前は BS だが送り先はこちら） | **W_op へ 0.05 ETH**。**0.02 ETH では足りない**——押下1回 157,012 gas ＝ 今日の価格で 0.000161461 ETH で、1日 60 回を3日ぶん＋床 0.005 ETH を賄うには 0.05 が要る（0.02 だと床を残して 92 回・ガス価格が3倍なら 30 回で尽きる）【実測にもとづく計算・`guards/GAS.md` §6】 | 21,000 |

**注意**
- BS-01・BS-02 が無いと B5a が買えない。**未知の tx は Blockscout が `null` を返すので静かに落ちる** → `jq -r .status` が `ok` であることを必ず見る
- **別の道（b/c を今の共有リゾルバに残す）**: K1-07〜09 を `R_shared.revokeRootRoles(ALL, 0xd45a2E00…A5D9)` ＋ `R_shared.multicall[setText ×4〜6]` の 2 tx（約 350k gas）に置き換える。その場合 **記録 ID は b=2・c=3** になり、`R_shared` に `seller-a` の箱（ID 1）が残り、「別の売り手は書けない」が成立しない → 画面と提出文を「この鍵は W_ens のリゾルバの `x402-offer` キーだけ（3名とも）」に変えて開示する
- **鍵の控え（K1 の完成の定義）**: `cp $DEMO/.env.tokyo.local ~/tokyo-keys-backup.env && chmod 600 ~/tokyo-keys-backup.env`。加えて Takeshi が K_atst・W_obs・W_op・W_pay・K_ag1 の秘密鍵をパスワードマネージャに手で控える（**失うと置いた証明を署名し直せない＝会期がやり直し**）

**K1 の判定コマンド（AI が打つ）**
```bash
node $DEMO/src/run.ts census vet402.eth seller-a.eth seller-b.eth seller-c.eth seller-d.eth agent-1.vet402.eth agent-2.vet402.eth
# 期待の1行: "K1 ok: root(vet402)=W_vet only, root(P_a)=root(P_bc)=root(P_d)=W_ens only,
#             P_a.roles(keccak(x402-offer), W_op)=0x10, P_d.roles(keccak(x402-offer), W_op)=0x10,
#             P_bc.roleCount(keccak(x402-offer))=0, recordIds a/b/c distinct,
#             atst.vet402.eth -> K_atst, agent-1 policy readable via P_AG1,
#             vet402.eth x402-policy empty, R_vet.roles(keccak(x402-policy), K_ag2)=0x10,
#             atst/obs still resolve via R_vet, 4 offers match on 2 RPCs"
curl -sL "https://base-sepolia.blockscout.com/api/v2/transactions/$SEED_TX" | jq -r .status   # 期待: ok
```
**`vet402.eth x402-policy empty`** と **`agent-1 policy readable via P_AG1`** の2つが §3.5.3 の (a)(b) を同時に確かめる行。**`P_d.roles(…)=0x10`** が審査員ボタンの書き込み先が在ることを確かめる行。どれかが崩れたら K1 は未完了。

**デモで打つ tx（K1 とは別。順番を固定する）**

| 順 | tx | from | gas【実測・sim】 | なぜこの順でなければならないか |
|---|---|---|---|---|
| D-1 | `P_a.setText(dns("seller-a.eth"),"x402-offer", …10001…)` | W_op | **78,506** | 場面2の「1文字変える」（本物の 266 バイトの値で測った。仮の 39 バイトの 52,297 ではない） |
| D-1r | 同じキーを `…10000…` に戻す | W_op | **78,506** | 撮影の片付け。**押下1回＝この2本で 157,012**（審査員ボタンも同じ） |
| D-2 | `P_bc.linkToRecord(dns("seller-b.eth"), 0)` ＝ **切り離し** | W_ens | 41,355 | b の全キー（addr 含む）が一度に空 → `ens_offer_missing` |
| D-3 | `P_bc.linkToRecord(dns("seller-b.eth"), 1)` ＝ **b を戻す** | W_ens | 63,267 | **c をつなぐ前に必ず b を戻す**（下） |
| D-4 | `P_bc.linkToRecord(dns("seller-c.eth"), 1)` ＝ **c を b の箱へ** | W_ens | 46,167 | c が b の約束と envelope をバイト単位で返す → `ens_attestation_signer_mismatch` |
| D-5 | `P_bc.linkToRecord(dns("seller-c.eth"), 2)` ＝ **c を戻す** | W_ens | 46,167 | 片付け |
| D-6a | `U.unregister("agent-1")` | W_vet | **72,604** | 方針が消えて払わない |
| D-6b | `U.register("agent-1", …)` ＝ 戻す | W_vet | **132,797** | `unregister` の直後は記憶が温かいので K1-13（172,536）より安い【実測】 |
| **T7** | `U.revokeRootRoles(UNEMANCIPATED, W_vet)` ＝ **解放**（`isEmancipated()` false → true） | W_vet | 44,050 | U8 の "forever names with no parent control"。**予約ラベルを自分で壊す道を塞ぐ唯一の構造的な手**（§3.5）。**必ず D-6b の後に打つ**。枠は **B7**（§6.2） |

**T7（解放）は D-6 の後**【実測・sim】: `UNEMANCIPATED` の正しいビット列は `SET_SUBREGISTRY \| SET_RESOLVER \| UNREGISTER \| ROLE_UPGRADE`（各 admin 側 `<<128` 込み）で、**`ROLE_UNREGISTER` が入っている**。つまり T7 を先に打つと **`U.unregister("agent-1")` が `EACUnauthorizedAccountRoles(…, 0x1000, W_vet)` で revert する**——D-6 が打てなくなる。
（解放の後でも `setSubregistry(seller-a, 0)`（35,392）と `setSubregistry(vet402, 0)`（35,380）は成功する。解放は `U` の**中**の支配を外すだけで、親 ETHRegistry 側の付け外しは塞がない【実測・sim】。→ K1-15c の戻し方は解放後も有効。）

**順番を入れ替えてはいけない理由**【実測・sim scene3 の S3alt】: 先に c をつないでから b を切り離すと、**b を戻した後も c は b の箱（記録 ID 1）を指したまま残る**（c の `x402-offer` が `20000`＝b の値のまま）。片付けの tx が1本増えるだけでなく、**撮影の最後に seller-c が他人の約束を名乗っている状態**になる。計画の順（**切り離し → 戻す → つなぐ → 戻す**、すなわち D-2 → D-3 → D-4 → D-5）は成立しているので、**この順を固定とする**。
**空の箱にはつなげない**【実測・sim S3trap】: b を切り離したまま `linkToNode(c → namehash("seller-b.eth"))` も `linkToRecord(c, 99)` も `InvalidRecord()` で revert する。順番の罠ではなく「箱が空なら常に出る」。
**W_op は `linkToRecord` を打てない**（`EACUnauthorizedAccountRoles(0x0, 0x10000000, W_op)`【実測・sim trap-4】）。D-2〜D-5 は W_ens が打つ。
---

## 5. テスト

**置き場（S7・3つのパッケージで同じ規則にそろえる）**

| パッケージ | red の間（B1〜B5） | 本線（B6 以降） | 走らせる glob |
|---|---|---|---|
| `$SDK` | `$SDK/test/tokyo/*.test.mjs`（本線の glob `test/*.test.mjs` の**外**） | `git mv` → `$SDK/test/tokyo-*.test.mjs` | `test/*.test.mjs` |
| `$MCP` | `$MCP/test/tokyo/*.test.mjs` | `git mv` → **`$MCP/test/tokyo-*.test.mjs`** | `test/*.test.mjs` |
| `$DEMO` | `$DEMO/test/tokyo/*.test.mjs` | `git mv` → **`$DEMO/test/tokyo-*.test.mjs`** | `test/*.test.mjs` |

**3つとも同じ形**（`test/tokyo/` で red → `test/tokyo-*.test.mjs` で本線）。`git mv` のときに **import の `../../dist/…` を `../dist/…` に同じコミットで書き換える**。v4 の「`$MCP/test/tokyo/pay-if-trusted-ens.test.mjs`（B1 で本線の置き場に入れる）」は置き場と時期が食い違っていたので、上の表で1つにした。

**ファイルの分け方**
| ファイル（本線に移した後の名前） | 中身 |
|---|---|
| `$SDK/test/tokyo-regression.test.mjs` | T29・T30・T30b。**新しいモジュールを import しない** |
| `$SDK/test/tokyo-ens-attestation-unit.test.mjs` | U01〜U04 と T01〜T19・T24 を `checkEnsOffer` の直呼びで |
| `$SDK/test/tokyo-pay-or-refuse-ens.test.mjs` | T01〜T28・T31〜T35・T39〜T48（**T41b を含む**）を `payOrRefuse` 経由で |
| `$DEMO/test/tokyo-observe-attester.test.mjs` | T36・T37・T49 |
| `$MCP/test/tokyo-pay-if-trusted-ens.test.mjs` | T38 |
| （数に入れない）`$WT/tests/tokyo-mutate.test.ts`・`$WT/tests/tokyo-mutate.pg.test.ts` | W01〜W06（§3.7.1 の関門6つ）。**`npx tsx --test tests/…` で走る**（`node --test` は `@/` を解決できない・§2.7）。置き場は `$WT/test/` ではなく **`$WT/tests/`**（既存の glob `tests/*.test.ts` に入る）。Next.js 側なので `T`／`U` の本数に数えない |

**規則**
- テスト名は `T01 ` のように **ID＋半角スペース**で始め、宣言は行頭の `test("` で書く
- **新しいモジュールは各テストの中で `await import("../../dist/ens-attestation.js")`**。ファイル先頭で静的 import しない
- ENS は `EnsRpc`（§3.2）の**偽物を2つ**注入し、ネットワークに出ない。偽物が実装するのは **`readContract`・`getBlock`・`getBlockNumber`・`getChainId` の4つだけ**で、`as unknown as PublicClient` のようなキャストを書かない（キャストが要るならそれは `EnsRpc` の定義が広すぎる合図）。**`findExactOwner`・`resolveText`・`resolveAddr` は `ens-read.ts` が輸出する関数であって、client のメソッドではない**（v4 の「偽物のメソッド名は `findExactOwner` に揃える」は誤り）
- 期待はすべて理由コードの中身で書く。署名の検査は anvil の既知鍵で作った envelope を使う
- DAG-CBOR のバイト列の正解は `@ipld/dag-cbor@9.2.6` を scratch で1回だけ走らせて作り、**16 進でテストに貼る**（依存には足さない）
- **任意機能のテストは `{ skip: !process.env.TOKYO_OPT_* }` で書く**（その機能を有効にしたときだけ走る）

| ID | 何を確かめるか | 入力 | 期待 | skip の env |
|---|---|---|---|---|
| U01 | payload のバイト列 | 固定の `n,a,k,v,t` | `@ipld/dag-cbor` の 16 進と一致・`a` は 20 バイト・キー順 `a,k,n,t,v`・**`encodePayload(…).length === 282`**・**envelope は 79 バイト** | — |
| U02 | envelope の hex と base64 | 同じ envelope を両方で | 同じ `{version:1,t,sig}` | — |
| U03 | tag 違い・4要素・署名 64 バイト | 各1つ | 各 `ens_attestation_malformed` | — |
| U04 | 参照実装の版2 | `p,h` で署名した envelope（**`p`＝記録キー・`h`＝値の keccak256**【一次未確認】） | 既定では `ens_attestation_malformed`／`profiles` に足せば有効・digest が版1と**違う**ことを固定 | — |
| T01 | 有効な証明（正の対照） | 2系統一致・固定一致・鮮度内・402 が約束どおり | ENS 段を通り `/decision` がちょうど1回・決定行に `source:"ens"` | — |
| T02 | **約束を1文字変えた** | `amount` `10000→10001`・envelope はそのまま | REFUSE `ens_attestation_signer_mismatch`・行に `recovered` と `expected`・signer 参照 0 | — |
| T03 | **vet402 に届かない＋1文字変えた** | T02 ＋ `apiUrl` への fetch が全部 throw | REFUSE `ens_attestation_signer_mismatch`（`evidence_unavailable` を含まない）・`apiUrl` への fetch **0 回** | — |
| T04 | 持ち主が移った | `findExactOwner` が別アドレス | REFUSE `ens_attestation_signer_mismatch` | — |
| T05a | 記録の切り離し | `linkToRecord(name,0)` の後＝`x402-offer` と envelope と addr が空 | REFUSE `ens_offer_missing` | — |
| T05b | envelope だけ消えた | 約束あり・envelope 空 | REFUSE `ens_attestation_missing` | — |
| T06 | **他の名前の箱につなぐ** | UR の読み取りが**別の名前 n2 の有効な約束と envelope をバイト単位でそのまま**返す（n2 では VALID の組） | REFUSE `ens_attestation_signer_mismatch` | `TOKYO_OPT_LINK` |
| T07 | 別の名前に写した envelope | 名前 `n2` に `n` 用の envelope | REFUSE `ens_attestation_signer_mismatch` | — |
| T08 | attester が鍵を替えた | `resolveAddr(atst)` が新アドレス・設定は旧 | REFUSE `ens_attester_unpinned`（署名の比較まで進まない） | — |
| T09 | attester 名に addr が無い | `resolveAddr → null` | REFUSE `ens_attester_unresolved` | — |
| T10 | 信頼していない attester | `attestations[x402-offer][evil.eth]` だけ | REFUSE `ens_attestation_missing` | — |
| T11 | 別の種類だけを信じる attester | `recordKeys:["com.x"]` | REFUSE `ens_attestation_missing` | — |
| T12 / T13 | 古い証明／未来の証明 | `now − t = maxAgeSeconds + 1` ／ `t = now + 301` | 各 REFUSE `ens_attestation_stale` | — |
| T14 | 未登録・RESERVED・wildcard のサブ名 | `findExactOwner → 0x0` の3枝。**サブ名の枝では偽の `findNearestOwner` が親の持ち主を返しても使わない** | REFUSE `ens_name_unresolved`・**`findNearestOwner` への呼び出し 0 回** | — |
| T15 | 2系統の値が違う | 同じブロックで `x402-offer` が1文字違う | REFUSE `ens_evidence_unavailable`＋`evidence_unavailable` | — |
| T16 | head が古い／2系統の head が離れている | timestamp が 10 分前／差 4 ブロック | 各 REFUSE `ens_evidence_unavailable` | — |
| T17 | RPC が落ちた | `resolveText` が throw | REFUSE `ens_evidence_unavailable`・`x402-pay.js` 未評価 | — |
| T18 | 約束が壊れている（証明は有効） | JSON でない値に正しく署名 | REFUSE `ens_offer_malformed` | — |
| T19 | `agent-endpoint[x402]` が約束と違う | URL が別 | REFUSE `ens_offer_mismatch` | — |
| T20 | 呼び手の `resource` が約束と違う | 別 URL | REFUSE `ens_offer_mismatch`・402 への fetch 0 | — |
| T21〜T23 | 402 の payTo／額／チェーン・資産が約束と違う | 各1つ | REFUSE `ens_offer_mismatch`＋`payee_mismatch`／`price_above_declared`／`chain_or_asset_mismatch`・署名前 | — |
| T24 | 閾値 2 で片方欠ける | `minValid:2`・有効1つ | REFUSE `ens_attestation_missing` | — |
| T25 | 読みと署名の間に変わった | 1回目有効・再検証で `v` が変わる | REFUSE `ens_attestation_signer_mismatch`・`x402-pay.js` 未評価 | — |
| T26 | **ENS の拒否は免除できない** | T02 ＋ `requireVet402Allow:false` と床 | REFUSE `ens_attestation_signer_mismatch`（`allowed_by_caller_policy` を含まない） | — |
| T27 | 呼び出し側エラー | `payeeName` だけ／`"seller a.eth"`／`network:"base"`＋`payeeName`／`trustedAttesters:[]`／`minValid:3`（信頼2）／`maxAgeSeconds:10`／`network:"sepolia"` | 各 throw `invalid_ens_config`／`invalid_payee_name`／`invalid_ens_chain`／`invalid_attestation_policy`（×3）／`invalid_network`・RPC 0 | — |
| T28 | `payee` と約束の payTo が違う | `payee:0xAAA…`・約束 `0xBBB…` | REFUSE `payee_mismatch`・`/decision` 0 本 | — |
| T29 | 既存 B8 の回帰 | `payee:"vitalik.eth"` | throw `invalid_payee_address`（今の文言）・fetch 0。**実装なしで緑になってよい** | — |
| T30 | 名前を使わない呼び手は viem を読み込まない | `dist/pay-or-refuse.js` の静的 import グラフ | `ens-attestation.js`・`ens-read.js`・`atst-codec.js`・`viem` を含まない（`ens-reasons.js` は含んでよい）。**実装なしで緑になってよい** | — |
| **T30b** | **パッケージの入口も viem を読み込まない** | `dist/index.js` の静的 import グラフ（`exports` の `"."`） | `viem`・`ens-attestation.js`・`ens-read.js`・`atst-codec.js` を含まない。`@vet402/sdk/ens`（`dist/ens.js`）**だけ**が viem を含む。**実装なしで緑になってよい**——ただし `"./ens"` の exports を足した後は `dist/ens.js` が存在することも同時に確かめる | — |
| T31 | testnet の正の対照 | `base-sepolia`・payee は 0x・床を満たす | `signTypedData` 1回・domain `{name:"USDC", version:"2", chainId:84532, verifyingContract:0x036CbD53…CF7e}`・`/payments/x402` への POST 0 | **`TOKYO_OPT_TESTNET_PAY`** |
| T32 | profile の取り違え（**4枝と期待を1対1に固定**） | 下の表 | 下の表 | **`TOKYO_OPT_TESTNET_PAY`** |
| T33 | D1-a の床 | `minChainReceipts:1`・0 件／reader が throw／片系統に canary なし | `insufficient_chain_evidence`／`evidence_unavailable`＋`chain_evidence_unavailable`（2枝目・3枝目とも） | **`TOKYO_OPT_TESTNET_PAY`** |
| T34 | 補助の走査 | 3枝: (a) `t` の後に `TextUpdated(recordId_n, keccak256("x402-offer"))` があり今は元の値 (b) `t` の後に `Linked(*, node)` があり今は元の箱 (c) **つながった別の名前経由の `TextUpdated`（node はログに出ない）** | 各 REFUSE `ens_record_changed_after_attestation`（オフなら ENS 段を通る） | `TOKYO_OPT_SCAN` |
| T35 | 親名の持ち主が変わった | `anchor.owner` ≠ `findExactOwner(dns("vet402.eth"))` | REFUSE `ens_attester_anchor_changed` | `TOKYO_OPT_ANCHOR` |
| T36 | 観測ログの組み立て | `/decision` の固定応答 | addr・contenthash の書き込みが無い・`description` に "Not the seller's name"・`last_purchase_id` が無ければ throw `observation_without_purchase` | — |
| T37 | attester は条件を満たさなければ署名しない | 402 ≠ 約束／本文に required キー欠け／購入後に `v` が変わった | 各 envelope なし・K_atst の `signMessage` 参照 0 | — |
| T38 | MCP | `pay_if_trusted` に `payeeName`・偽の `/decision` は ALLOW・ENS は T02 | REFUSE `ens_attestation_signer_mismatch`・`/decision` への fetch 0 本 | `TOKYO_OPT_MCP` |
| T39 | **vet402 に届かなくても払える** | 届かない（throw）＋証明有効＋`minEnsAttestations:1`＋`minChainReceipts:1`＋`requireVet402Allow:false` | paid・`signTypedData` 1回・`vet402_unreachable` と `allowed_by_caller_policy`・`policy_override.waived.source:"vet402_unreachable"`・`floors_met` に `minEnsAttestations` | `TOKYO_OPT_UNREACHABLE` |
| T40 | 届かない＋既定の `requireVet402Allow` | T39 から外す | REFUSE `evidence_unavailable` | 同上 |
| T41〜T43 | 届いたが degraded／BLOCK／401・429 | 各＋T39 の床 | REFUSE `evidence_unavailable`／`payee_recommendation_block`／`evidence_unavailable` | 同上 |
| **T41b** | **200 で「読めたが判定になっていない」（fail-closed・G5b）** | T39 の床のまま、`/decision` が **HTTP 200** で（**4枝**）①壊れた JSON／②空 body ＋ 204／③3xx／**④`recommendation` が `allow`・`warn`・`block` のどれでもない**（`{}`・`null`・`{"ok":true}`。JSON としては読めるので①では捕まらない） | 4枝とも REFUSE `evidence_unavailable`。**`vet402_unreachable` を含まない・`signTypedData` の参照 0 回**（パース失敗も「知らない `recommendation`」も「届かなかった」に落とさないことを固定する） | 同上 |
| T44 | 届かない＋vet402 の台帳の床 | T39 に `minL1Deliveries:1` | REFUSE `evidence_unavailable` | 同上 |
| T45 | ENS の床の呼び出し側エラー（3枝） | (a) `minEnsAttestations` を `payeeName` なしで／(b) `minEnsAttestations:0` だけで `requireVet402Allow:false`／**(c) `minEnsAttestations:1` と `evidence.source:"subgraph"` を一緒に** | (a) throw `invalid_evidence_policy`／(b) throw `invalid_policy`／**(c) throw しない**（新しい床は `source` の制約を受けない・§3.3.3 S4） | 同上 |
| T46 | ENS の床が足りない | 届かない＋有効1＋`minEnsAttestations:2` | REFUSE `insufficient_ens_attestations` | 同上 |
| T47 | **届かない経路でも約束が変われば払えない** | T39 で再検証の `x402-offer` が1文字違う | REFUSE `ens_attestation_signer_mismatch`・`x402-pay.js` 未評価・支払いは起きない | 同上 |
| T48 | **配備の食い違い** | 同じブロックで `UH.ROOT_REGISTRY()` ≠ `UR.ROOT_REGISTRY()` | REFUSE `ens_evidence_unavailable`＋`evidence_unavailable` | — |
| T49 | **エージェントの方針が読めない**（5枝） | (a) `x402-policy` が空／(b) JSON でない／(c) 7キーに足りない／(d) 知らないキーが1つある（例 `minL1Deliveries`）／**(e) 値は正しいが `UR.resolve` が返したリゾルバが `P_AG1` でない**（＝親 `R_vet` の wildcard・§3.5.3 の罠） | 各 `payOrRefuse` を**呼ばずに** `agent_policy_missing`（`examples/` 側の語）。(e) は**値が有効な JSON でも拒否する**ことを固定 | `TOKYO_OPT_AGENTNS` |
| T49 の (f)（**同じ `test("T49 …")` の中。新しい ID を作らない**） | **方針から引数への写し**（§3.5.2） | §3.5.1 の7キー JSON ＋ `trusted-attesters.json` に `atst.vet402.eth` と `evil.eth` | `payOrRefuse` に渡る `trustedAttesters` が **`atst.vet402.eth` 1件だけ**（アドレスはローカルの値）・`maxPerTxUsd === 0.05`・`network === "base-sepolia"`・`evidence.minEnsAttestations === 1`。`trust` が空集合になる入力では `agent_policy_missing` | `TOKYO_OPT_AGENTNS` |

**T32 の4枝と期待（1対1・曖昧を消す）**

| 枝 | 入力 | 期待する理由コード（順序も固定） |
|---|---|---|
| (a) | `network:"base-sepolia"` に**本番 Base の 402**（`network:"eip155:8453"`・本番 USDC） | REFUSE `["no_eligible_accept","chain_or_asset_mismatch"]` |
| (b) | `network:"base"`（既定）に**testnet の 402**（`eip155:84532`） | REFUSE `["no_eligible_accept","chain_or_asset_mismatch"]` |
| (c) | `network:"base-sepolia"` の 402 だが **`asset` が本番 USDC** `0x833589fC…2913` | REFUSE `["chain_or_asset_mismatch"]`（`network` は合うので `no_eligible_accept` は**出ない**） |
| (d) | EIP-712 domain の取り違え（testnet に本番の `verifyingContract` ／ 本番に testnet の `verifyingContract`・両方向） | REFUSE `["chain_or_asset_mismatch"]`・**`signTypedData` の参照 0 回** |

**本数**: U 4 ＋ T **52**（T05 が a/b の2行・T30b・T41b を足した）＝ **56 の ID**。

**数え方は「一意の ID」で数える。行数で数えない。**同じ ID が2つのファイルに出る（例: T01〜T28 は unit と `payOrRefuse` 経由の両方にある）ので、**行数で数えると 77 を返して関門が意味を失う**【実測】。

```bash
# red の間（B1）
cat $SDK/test/tokyo/*.test.mjs $DEMO/test/tokyo/*.test.mjs $MCP/test/tokyo/*.test.mjs \
  | grep -oE '^test\("(T|U)[0-9]+[a-z]?' | sed 's/^test("//' | sort -u | wc -l      # B1 の期待: 56
# 本線に移した後（B6）
cat $SDK/test/tokyo-*.test.mjs $DEMO/test/tokyo-*.test.mjs $MCP/test/tokyo-*.test.mjs \
  | grep -oE '^test\("(T|U)[0-9]+[a-z]?' | sed 's/^test("//' | sort -u | wc -l      # B6 の期待: 56
```
**B1 も B6 も期待は「一意の ID が 56」**。`TOKYO_OPT_*` を落とした分は skip として ID が残るので、**本線に移しても数は減らない**（v4.2 の「B6 は 52 以上」は行数で数えていた時代の値で、もう使わない）。**この数字を正典とする**。`$WT/tests/tokyo-mutate.test.ts` の W01〜W06 は**この数に入れない**（§3.7.1）。
**実装なしで緑になってよいのは T29・T30・T30b の3本だけ。4本目が緑なら、そのテストは何も確かめていない。**

**走らせ方**
```bash
# SDK / MCP / DEMO（ビルド後の .mjs。ここは素の node --test でよい）
cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/tokyo/*.test.mjs 2>&1 \
  | grep -oE '✔ [TU][0-9]+b?[ab]? ' | tr -d '✔ ' | sort -u | tr '\n' ' '   # B1 の期待: "T29 T30 T30b "
cd $SDK && npm run build >/dev/null && node --test --test-reporter=spec test/*.test.mjs 2>&1 | grep -E '^ℹ fail'   # B6 の期待: ℹ fail 0
cd $MCP && node --test --test-reporter=spec test/*.test.mjs 2>&1 | grep -E '^ℹ fail'    # B6 の期待: ℹ fail 0
cd $DEMO && node --test --test-reporter=spec test/*.test.mjs 2>&1 | grep -E '^ℹ fail'   # B6 の期待: ℹ fail 0
cd $SDK && npm test 2>&1 | grep -E '^ℹ (pass|fail)'      # 既存の回帰。期待: fail 0・pass は 1,735 以上

# App 側（`@/` のエイリアスがあるので tsx。**node --test では走らない**・§2.7）
cd $WT && npx tsx --test tests/tokyo-mutate.test.ts 2>&1 | grep -E '^ℹ fail'      # 判定点③の期待: ℹ fail 0
cd $WT && npx tsx --test tests/tokyo-mutate.pg.test.ts 2>&1 | grep -E '^ℹ fail'   # TEST_DATABASE_URL が無ければ skip
```
**`cd ~/vouch-tokyo && npm ci` を先に打つ**（`~/vouch` の `node_modules` は空で `tsx` も入っていない【実測 09-19】。会期の夜中に `npm ci` から始めない・§6.2 の B0）。
---

## 10. 用語と固定値

### 10.1 アドレス・名前・鍵

| キー | 値 | 備考 |
|---|---|---|
| UR / UniversalHelper / Root / ETHRegistry / ETHRegistrar / impl / VF / UserRegistryImpl / LabelStore / MockUSDC | §2.1 の表 | チェックサムのまま書く |
| W_vet | `0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6` | `vet402.eth` の持ち主・EOA |
| W_ens | `0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6` | `seller-a/b/c/d.eth` の持ち主・**EIP-7702 委任つき**・売り手の受取先（`x402-offer.payTo`） |
| R_vet | `0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391` | `vet402.eth` の今のリゾルバ |
| R_shared | `0x49f5022dDe516B92AC1609158bC6AdC772088055` | 売り手3名が今共有しているリゾルバ |
| 自分のスマートアカウント（R_vet） / （R_shared） | `0xE96b16ab865Aede373C6DE768b3943FA615f173f`（`owner()`=W_vet） / `0xd45a2E001A8e0681A7C4AFa27fa88fFF0FA1A5D9`（`owner()`=W_ens） | **剥がさない**（09-24 決定）。旧記述: app.ens.dev のスマートアカウント。K1-01 で剥がす |
| P_a / P_bc | `0xC54403186Db35B9D92cc393Ae665D3960117ac14` / `0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf` | K1 で作る予定アドレス（W_ens・salt 固定）【実測・sim】 |
| **P_d**（seller-d 専用・**審査員ボタンの書き込み先**） | **`0x9CF7990dAB364d1738ABB09532b953Ec48269831`** | K1-D2 の予定アドレス（W_ens・`SALT_D`）【実測・sim・block 11,735,943】。B0 で取り直す |
| U（自前 UserRegistry） | **`0xB093cEC6D1Cc355c40020f0df5103ecEFfD30dac`** | K1-10 の予定アドレス（W_vet・`SALT_U = keccak("tokyo-2026/agents.vet402.eth")`）【実測・sim・block 11733994】。B0 で取り直す |
| P_AG1（agent-1 専用リゾルバ） | **`0xd3F4818c0bB93e54780525b21380D44D6D06bcd6`** | K1-12 の予定アドレス（W_vet・`SALT_A1 = keccak("tokyo-2026/agent-1.vet402.eth")`）【実測・sim・block 11733994】。B0 で取り直す |
| K_atst / W_obs / **W_op** / W_pay / K_ag1 / K_ag2 | 会期中に `keys.ts init` が作る | **会期前に人が作らない**。**W_op のアドレスは今【未確認】**——BS-03 で 0.05 Sepolia ETH を受け取り、`P_a` と `P_d` の `x402-offer` だけを書ける鍵。本番 env の `TOKYO_OPERATOR_PRIVATE_KEY` はこれ |
| `seller-d.eth` | **会期中に W_ens で登録する**（K1-D1）。09-19 時点で `isAvailable = true`【実測】 | 家賃は **8.000021 MockUSDC / 1年**・`MIN_COMMITMENT_AGE` 60 秒・**ETH 建ての価格取得は revert する**【実測】 |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | EIP-712 name `"USDC"`・version `"2"`・decimals 6・chainId 84532 |
| Base 本番 USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 既定経路。変えない |
| 購入元（本番 L1） | `0xc9c7b38c0942914fc8ea12063bc92dcd3b581670` | 触らない（製品運用） |
| 予定アドレスの取り直し | `node $DEMO/src/admin.ts deploy-resolvers --dry-run --print-predicted` | B0。`VerifiableFactory.deployProxy` のアドレスは**送り手と salt だけ**で決まるので、initData を本物の JSON に替えても**同じ**【実測・sim E4】 |

### 10.2 env 名とパス

```bash
WT=~/vouch-tokyo
SDK=$WT/packages/sdk
MCP=$WT/packages/mcp-server
DEMO=$WT/examples/tokyo-2026-demo
TOKYO_PATHS="packages/sdk packages/mcp-server examples/tokyo-2026-demo docs/tokyo-2026 skills/pay-or-refuse SKILL.md AI_USAGE.md src/app/tokyo src/app/api/tokyo tests/agent-skill-plugin.test.ts tests/caller-policy-sdk-parity.test.ts tests/tokyo-mutate.test.ts tests/tokyo-mutate.pg.test.ts tests/helpers/env-graph.ts scripts/sql package-lock.json examples/tokyo-2026-demo/package-lock.json next.config.ts vercel.json ':!docs/tokyo-2026/prework'"
set -a; . $DEMO/.env.tokyo.local; set +a
```
**`TOKYO_PATHS` はこの1文字列だけを正典とする**（§8.5 と**1バイト同じ**。二つの定義が食い違ったらどちらも信じない）。
- **`package-lock.json`・`examples/tokyo-2026-demo/package-lock.json`・`next.config.ts`・`vercel.json` を含む**。請求の言い方を「挙げたパス＋それらが必要とする lockfile と設定の変更」にする以上、フィルタにも入っていなければ提出文と合わない
- **`tests/tokyo-mutate*.ts`・`tests/helpers/env-graph.ts`・`scripts/sql` を含む**（審査員ボタンの関門6本と DDL は会期中の成果物）
- **末尾の `':!docs/tokyo-2026/prework'` を落とすと会期前の設計物が請求範囲に入る**。**両方の定義に残す**

`.env.tokyo.local`（手元・`chmod 600`・`.gitignore:35` の `.env*` で無視されることを `git check-ignore -v` で確認済み【実測】）に入れるもの:
`ENS_SEPOLIA_RPC_URL` / `_2` / `_3`・`VET402_API_URL`・`AGENT_NAME`・`SEED_TX`・`W_VET` / `W_ENS` / **`TOKYO_W_OP_ADDRESS`**（gas の関門が読む。**3鍵とも**）・秘密鍵 6つ。

**本番（Vercel）側の env は4つだけ**（`src/app/api/tokyo/**` が読んでよい全部。**W01 がこの4つとの完全一致を強制する**）:

| env | 何に使う | 備考 |
|---|---|---|
| `DATABASE_URL` | `tokyo_mutations`・`tokyo_mutation_log`・`ip_rate_limits`・`runtime_flags`・`job_leases` | **既にある**（足さない） |
| `TOKYO_OPERATOR_PRIVATE_KEY` | W_op の委任鍵（Sepolia 限定） | **新しく足す唯一の鍵** |
| `TOKYO_SEPOLIA_RPC_URL` | 審査員ボタンが使う Sepolia RPC | 新規 |
| `TOKYO_JUDGE_BUTTON_DISABLED` | 停止の保険（`"1"` の1値だけが止め。**正典は DB の `runtime_flags.tokyo_button_halt`**） | 新規 |

**他の `*_PRIVATE_KEY` を `src/app/api/tokyo/**` から参照しない。**`@/lib/api/ip-rate-limit` と `@/lib/api/client-ip` を import すると env 名が 19 に増えて W01 が赤になる【実測】。使ってよい既存 lib は **`@/lib/db/client`・`@/lib/util/log`・`@/lib/cron/lease` の3本だけ**。
控え: `cp $DEMO/.env.tokyo.local ~/tokyo-keys-backup.env && chmod 600 ~/tokyo-keys-backup.env`。

### 10.3 記録のキー

| キー | 置き場 | 誰が書ける |
|---|---|---|
| `x402-offer` | `seller-a/b/c.eth`・**`seller-d.eth`** | 持ち主（W_ens）と、**`P_a` と `P_d` の上では W_op**（`P_bc` の上では W_op は書けない） |
| `agent-endpoint[x402]` | 同上・`vet402.eth` | 持ち主だけ |
| `attestations[x402-offer][atst.vet402.eth]` | `seller-a/b/c/d.eth` | **持ち主だけ**（W_op は `EACUnauthorizedAccountRoles`） |
| `addr(60)` | `atst.vet402.eth`（＝K_atst）ほか | 持ち主だけ（W_obs は不可） |
| 観測ログの 15 キー（`class`・`description`・`x402.*`） | `<resourceId>.obs.vet402.eth`（登録しない） | 持ち主と W_obs |
| `x402-policy` | **`agent-1.vet402.eth` だけ**（`P_AG1` の上）。**`vet402.eth`（R_vet）には値を置かない**——§3.5.3 の罠 | 持ち主（W_vet）と、`P_AG1` の上では K_ag1。K1-15b の後は `R_vet` の上で K_ag2 も書けるが、**live では書かない**（漏れの実演は `eth_call` だけ） |

### 10.4 拒否語（新しく足す 17 語）

| 置き場 | 語 |
|---|---|
| `packages/sdk/src/ens-reasons.ts`（13） | `ens_name_unresolved`・`ens_offer_missing`・`ens_offer_malformed`・`ens_offer_mismatch`・`ens_attestation_missing`・`ens_attestation_malformed`・`ens_attestation_signer_mismatch`・`ens_attestation_stale`・`ens_attester_unresolved`・`ens_attester_unpinned`・`ens_attester_anchor_changed`・`ens_record_changed_after_attestation`・`ens_evidence_unavailable` |
| `pay-or-refuse.ts` に直接（4） | `insufficient_chain_evidence`・`chain_evidence_unavailable`・`insufficient_ens_attestations`・`vet402_unreachable`（拒否ではない印） |
| throw（呼び出し側の誤り） | `invalid_payee_name`・`invalid_ens_config`・`invalid_ens_chain`・`invalid_attestation_policy`・`invalid_network`・`invalid_evidence_policy` |
| `examples/` だけの語（SDK にも SKILL.md にも入れない） | `observation_without_purchase`・`agent_policy_missing` |

**17 語すべてを `skills/pay-or-refuse/SKILL.md` の表（141-157 行）に同じコミットで足す**（`tests/agent-skill-plugin.test.ts` が過不足なし一致を強制する）。**サーバ側の語彙（`src/lib/observatory/vocabulary.ts`・`src/lib/decision/caller-policy.ts`・`docs/openapi.yaml`）には足さない**（parity テストが赤になる。新語はすべて SDK だけの語）。

### 10.5 定数

| 名 | 値 |
|---|---|
| `ATST_TAG` | `1635021684`（`0x61747374` = `atst`） |
| `ROLE_SET_TEXT` | `0x10` |
| `ROLE_SET_ADDRESS` | `1 << 0` |
| `ROLE_LINK` | `1 << 28` |
| `ROLE_CAN_TRANSFER_ADMIN` | `(1 << 28) << 128`（**`ROLE_CAN_TRANSFER` という定数は存在しない**） |
| `UNEMANCIPATED_ROLE_BITMAP` | `SET_SUBREGISTRY\|SET_RESOLVER\|UNREGISTER\|UPGRADE` と各 ADMIN（**`ROLE_RENEW` は含まない**） |
| `ALL_ROLES` | `0x1111…1111` |
| `U` の予約ラベル | **`atst`・`obs`**（K1-post-1/2 で `resolver=0` で register。`admin.ts agents` は `register`・`setResolver`・`unregister` のどれを打とうとしても落ちる。**構造的に閉じるのは T7**） |
| **`output.required`** | **`["result","observed_at"]`**（§3.3.1 で決定）。`x402-offer` の1行 JSON は **266 バイト**になる |
| **審査員ボタンの定数**（`src/app/api/tokyo/_lib/constants.ts` と `~/hackathon-monitor/gas-budget.mjs` に同じ値） | `TOKYO_CHAIN_ID = 11155111`／書き込み先は **`P_d` × `dns("seller-d.eth")` × `x402-offer` × 2値**／`W_OP_FLOOR_WEI = 5_000_000_000_000_000n`（0.005 ETH）／`PRESS_GAS = 157_012`（mutate 78,506 ＋ reset 78,506【実測】）／`GAS_SAFETY = 3`／**1日の上限 60 回**／`REVERT_AFTER_MS = 90_000`（**「90 秒経ったら次の来訪で戻す」であって「90 秒後に自動で戻る」ではない**） |
| **鍵ごとのガスの関門**（`GAS_BUDGET`・**数字はこの1か所だけ**） | **W_vet 4,200,000**（実測 2,953,236）／**W_ens 4,800,000**（実測 3,546,604・seller-d 一式 1,178,390 込み）／**W_op 3,300,000**（押下1回 157,012 × 21）。**安全係数 3**（今日の 1.028 gwei の3倍まで緑）。**1つの合計 gas を正典にしない**（§4） |
| **BS-03** | **W_ens → W_op に 0.05 Sepolia ETH**（0.02 では 1日 60 回×3日＋床に足りない） |
| `/tokyo` の期待反転（preflight・`rehearsal/checks/b0.mjs` の `TOKYO_EVENT_START`） | **2026-09-26T06:30:00Z**（それまでは 404 が正常） |
| 提出タグ | **`tokyo-2026-submission`**（B11 の凍結の commit・請求は `pre-tokyo-2026..tokyo-2026-submission`） |
| `keccak256("x402-offer")` | `0xddc51409…`（`ResourceArgument` と `EACRolesChanged` の resource） |
| `keccak256("attestations[x402-offer][atst.vet402.eth]")` | `0x2363e661…` |
| `keccak256("x402-policy")` | `0x1c0754232f48fc306cedd0a65442157964f44f2481314faec5a4bee29b1d877f` |
| ENSIP-29 payload の大きさ | **282 バイト**（§2.3 のデモの約束で・canonical DAG-CBOR） |
| ENSIP-29 envelope の大きさ | **79 バイト**（tag ＋ 3要素 ＋ 署名 65 バイト。base64 で 108 文字） |
| `IPermissionedResolver` の interfaceId | `0x8c2427cc` |
| テストの本数 | **一意の ID が 56**（U 4 ＋ T 52）。B1 も B6 も同じ。W01〜W06 は数に入れない |
| 参照コミット | **`e8ff1eb`**（`pay-or-refuse.ts` は `d350540` から1行も動いていない） |
| 既定値 | `minValid: 1`・`maxAgeSeconds: 86400`・`futureSkewSeconds: 300`・`maxHeadLagSeconds: 120`・`profiles: ["ensip29-draft"]`・`sinceIssuanceScan: false` |

### 10.6 使ってはいけない値・語（新 ABI / 新配備 / 09-19 の再測に存在しない）

会期中にこれらを見たら、写した先が古い文書である。**止めて §2・§4・§10.5 を引き直す。**

**ABI と配備**

| 使ってはいけない | 正しいもの |
|---|---|
| `clearRecords` / `recordVersions` / `VersionChanged` / `ROLE_CLEAR` | `linkToRecord(dns(name), 0)`・`Linked` |
| `setAlias` / `getAlias` / `AliasChanged` / `ROLE_SET_ALIAS` / `alias-prepare` | `linkToNode` / `linkToRecord`・`Linked`・`unlink`/`link`/`relink` |
| `authorizeTextRoles` | `grantSetterRoles`（**リゾルバ単位のキー**。旧より粗い） |
| `UniversalResolverV2.findOwner` | `UniversalHelper.findExactOwner` |
| `setText(bytes32 node, …)` / `setAddr` | `setText(bytes dnsName, …)` / `setAddress`（**DNS 形式の名前**） |
| `TextChanged` / `AddressChanged` | `TextUpdated` / `AddressUpdated`（**recordId に付く**） |
| `supportsInterface(0x91413117)` | `supportsInterface(0x8c2427cc)` |
| `contracts-v2` の SHA `97a57293` を期待値にすること | チェーンから読む（`probe-rpc.ts --deployment`）。docs の SHA は参考として打つだけで止めない |
| `0xeEeE…eEeE`（e が 40 個の Universal Resolver） | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` |
| `0x14F09Fd05d4585759e54844dc9b00147131Cf243`（小文字 `dc9b`） | `0x14F09Fd05d4585759e54844DC9B00147131Cf243` |
| `own-resolver` サブコマンド | `deploy-resolvers`（＋`revokeRootRoles` は K1-01） |
| `.eth` の家賃を ETH で払う／`getRegisterPrice` を ETH 建てで呼ぶ | **MockUSDC 払い**（8.000021 / 1年）。ETH 建ては **revert する**【実測】 |

**tx の本数と gas（09-19 の再測で全部動いた。古い数字を1つも残さない）**

| 使ってはいけない | 正しいもの |
|---|---|
| **K1 の合計 gas を1つの数字で言うこと**: `3,218,146` / `3,388,515` / **`3,388,563`** / `3,476,015` / `3,510,377` / **`3,597,829`** | **鍵ごとの実測合計と関門**（§4・§10.5）。**W_vet 実測 2,953,236／関門 4,200,000・W_ens 実測 3,546,604／関門 4,800,000・W_op 押下1回 157,012／関門 3,300,000** |
| **K1 を「16 tx」「17 tx」「Sepolia 18 tx」と書くこと** | **Sepolia 26 tx**（**Intercepta の枠を使う版だけ 31 tx**。それ以外の数は誤り）（本体 22 ＝ K1-01〜15 ＋ K1-15b ＋ seller-d 6／K1-post 4／BS-03 1）＋ **Base Sepolia 2**（BS-01・BS-02） |
| **`K1-16` / `K1-17`** | **`K1-15c`（`setSubregistry(seller-a, U)`・W_ens）／`K1-15d`（`linkToNode`・W_vet）／資金は `BS-01`・`BS-02`・`BS-03`** |
| K1-04 の **448,516** / **563,793**（448,516+115,277）/ **552,393** | **575,239**（`output.required = ["result","observed_at"]` で約束 266 バイト・§3.3.1） |
| K1-07 の **539,375** | **861,493**（**K1-07 にも本物の約束を入れる。計画は K1-04 にしか足していなかった**） |
| K1-12 の **393,345** | **462,532**（§3.5.1 の7キー・178 バイト） |
| K1-post の「約 17 万【推定】」 | **168,049 / 168,037**【実測】 |
| B5b の **418,854** | **447,378**（160,526＋143,426＋143,426。9通り測って 418,854 は**再現しない**）。**seller-d ぶんの B5b-d 160,526 は別**（seller-d 一式に入っている） |
| D-1 の **52,297**（39 バイトの仮値） | **78,506**（本物の 266 バイト）。**押下1回は mutate ＋ reset = 157,012** |
| `U.unregister` の **72,652** ／ 戻しの `register` に **172,536** | **72,604** ／ **132,797**（`unregister` の直後は記憶が温かい【実測】） |
| 案A 設置 5 tx の **888,838** / **888,874**、および B0 の合格条件を「888,874 ±5%」と書くこと | **その組の合計はもう使わない**（K1-12 が 393,345 → 462,532 に動いたので両方とも古い）。B0 の合格条件は **`preflight-tokyo.mjs` の `gas_budget.ok` が3鍵とも true** |
| 「1 gas も違わない」「DESIGN.md の値と 1 gas も違わない」 | **ガスは calldata の中身で動く**。実鍵と仮鍵の差は全 15 tx で +1,092（+0.03%）だが、**文字列は 1 文字 12 gas・32 バイト境界で +約 22,800**【実測】 |
| W_vet のガスの関門 **4,000,000** | **4,200,000** |
| W_ens のガスの関門 **1,200,000** / **1,600,000** / **2,200,000**、実必要 **1,369,316** | **関門 4,800,000・実必要 3,546,604**（K1-07 の本物の文字列 +322,118 と **seller-d 一式 +1,178,390** が入っていなかった） |
| **K1 に `seller-d` の tx が1本も無い状態** | **K1-D1〜K1-D4（本体・6 tx・1,017,864）＋ B5b-d（160,526）**。合計 **1,178,390**。**無いと審査員ボタンの書き込み先が存在しない** |
| BS-03 を **0.02 ETH** にすること | **0.05 ETH**（0.02 では床を残して 92 回・ガス価格3倍なら 30 回で尽きる） |

**審査員ボタン（W01〜W06。現物に当てて形が変わった）**

| 使ってはいけない | 正しいもの |
|---|---|
| **審査員ボタンが `seller-a.eth` を壊すこと** | **`seller-d.eth`**（§3.7.1・W06-c が固定する）。`seller-a.eth` は README・CLI の例・場面2の主役 |
| 審査員ボタンの関門を **4つ**と書くこと | **6つ**（W01〜W06） |
| W01 を「専用の env 名を**1つだけ**読む」と書くこと／`process.env` 全体を assert すること | **許可リストと完全一致**（`DATABASE_URL`・`TOKYO_OPERATOR_PRIVATE_KEY`・`TOKYO_SEPOLIA_RPC_URL`・`TOKYO_JUDGE_BUTTON_DISABLED` の4つ）。**全体を見ると本番の他の鍵 env 4つで必ず落ち、外すと `l1-purchase` が止まる** |
| `src/app/api/tokyo/**` から `@/lib/api/ip-rate-limit` / `@/lib/api/client-ip` / `@/lib/observatory/kill-switch` を import すること | 使ってよいのは **`@/lib/db/client`・`@/lib/util/log`・`@/lib/cron/lease` の3本だけ**（`ip-rate-limit` を引くと読む env が 19 に増える【実測】）。IP は `_lib/ip.ts` の3行・停止判定は `_lib/halt.ts` に**写す** |
| 上限のカウンタを **KV / Redis / インメモリの Map / ファイル**に置くこと | **Postgres の1文 upsert**（`ip_rate_limits`・鍵 `tokyo-mutate-day:<YYYY-MM-DD>`）。**読んでから書く2文にしない** |
| 停止スイッチを **env だけ**にすること／**`/api/admin/spending-halt` を流用すること** | **正典は DB の1行 `runtime_flags.tokyo_button_halt`**（SQL 1文・§3.7.1）。env は保険。admin route は `l1_spending_halt` 固定で**本物の L1 購入まで止まる**【実測】 |
| 1日の上限 **200 回** | **60 回**（W_op の資金の実測から。200 回には 0.0373 ETH が要る） |
| W05 を「**90 秒で自動復帰**」と書くこと／`after()` の中の `setTimeout` で戻すこと | **「次に誰かが来たときに戻す」**（`mutate` の先頭・`state`・`reset` の3か所で `ensureReverted()`）。`~/vouch` 自身の実測で、期限 24,000ms の仕事が 59,957ms かかり **setTimeout は一度も発火しなかった** |
| W06 を「**審査時間外は 404**」にすること | **撤回**（パートナー審査は非同期【一次】）。W06 は **書き込み先の4点がソース定数** |
| 判定を `node --test $WT/test/tokyo-mutate.test.ts` と書くこと | **`npx tsx --test tests/tokyo-mutate.test.ts`**（`tests/*.test.ts` の 174 本が `@/` を使い、素の `node --test` は解決できない【実測】）。置き場も `$WT/test/` ではなく **`$WT/tests/`** |
| `grep -rn 'signTypedData\|PRIVATE_KEY'` をリポ全体に当てること | **`$WT/src/app/tokyo $WT/src/app/api/tokyo/verify` に限る**。`mutate`・`reset`・`state` は除外範囲 |

**主張・言い方・提出物**

| 使ってはいけない | 正しいもの |
|---|---|
| 「vet402 に**一度も問い合わせない**」「vet402 **抜きで**払う」 | 「**問い合わせには行く。返ってこなくても床が満たされていれば払う**」（§3.3.3 の言い方の表） |
| 画面や台詞の **`vet402 API calls: 0`** ／ **"it never asked me"** | **`vet402 API: unreachable (asked, no answer)`**。判定: `grep -rn 'API calls: 0\|never asked me' $WT/docs/tokyo-2026 $WT/src/app/tokyo \| wc -l` → `0` |
| **英語の禁止文字列**（機械検査に掛ける）: `without vet402` / `without asking vet402` / `vet402 is not needed` | `The attestation validates from Sepolia and local config alone.` 判定: `grep -rni 'without vet402\|without asking vet402\|vet402 is not needed' $WT/docs/tokyo-2026 $WT/README.md \| wc -l` → `0` |
| `cut-vet402` を 404 で作ること／G6 の「4xx（404 を除く）」 | **接続不能か 503 だけが「届かない」**。**4xx は 404 を含めて全部「届いた」扱い**（免除しない） |
| G5 の「届かない」に **200 で本文が壊れている場合**を含めること | **含めない。拒否する**（G5b の**4枝**。`recommendation` が allow/warn/block のどれでもない 200 も拒否） |
| **`npx @vet402/tokyo-demo verify …`** も **`npx github:kzmttkc/vet402#… verify …`** も提出文に書くこと | **`git clone --depth 1 --branch tokyo-2026-submission https://github.com/kzmttkc/vet402 && cd vet402/examples/tokyo-2026-demo && npm ci && npm run verify -- seller-a.eth`**（後者は `bin` が無く `could not determine executable to run` で落ちる【実測 09-24】）。`@vet402/tokyo-demo` は npm に**存在しない（404）**【実測 09-19】 |
| 「**npm 公開済み・0.7.0**」と書くこと | **npm の latest は 0.6.0・リポが 0.7.0**【実測 09-19】 |
| 最小提出で **live demo のリンクを外す**こと | **外さない**（両枠の資格要件）。`/tokyo` が落ちたら**同じ URL に読み取り専用の静的な最小ページ**を出す |
| 提出文の **em ダッシュ**／冒頭3行に `ENSv2` が1語も無いこと | em ダッシュ 0・**冒頭3行に ENSv2 を2回以上、2行目に Enhanced Access Control** |
| ENS の欄を**1本**にして両枠に貼り回すこと | **2本書く**（$6,000 用と $4,000 用・§8.1 の 7）。**本命は $4,000** |
| prework に **`PLAN_v4.3.md` 全文**を入れること／「会期前の成果物を全部入れる」と書くこと | **許可リスト方式**＋**公開版は `prework/PLAN_PUBLIC.md`（§2〜§5・§10 の抜粋）**。§1・§6〜§9 と `rivals/`・`JUDGE_SIM.md`・`MOAT.md`・`ENS_FEEDBACK_DRAFT.md`・`FINDINGS.md`・`a8/`・`HOMEWORK.md`・`guards/` は入れない |
| 請求の範囲を `pre-tokyo-2026..main` と書くこと | **`pre-tokyo-2026..tokyo-2026-submission`**（`main` は提出後も動く） |
| `TOKYO_PATHS` から lockfile と設定（`package-lock.json`・`examples/tokyo-2026-demo/package-lock.json`・`next.config.ts`・`vercel.json`）や `tests/tokyo-mutate*.ts`・`scripts/sql` を落とすこと | **入れる**。`':!docs/tokyo-2026/prework'` も**両方の定義に残す** |
| **`git mv` と中身の修正を1つのコミットにまとめること**／最小提出を web UI の単発コミットで済ませること | **分ける**（規約は履歴の無い提出を既定で失格扱いにする【一次】） |
| §8.2 の 2:55–3:25 から **D-5** を落とすこと | **D-2 → D-3 → D-4 → D-5** で撮る。落とすと seller-c が他人の約束を名乗ったまま画に残る |
| 「作者自身が拒まれる」を **W_vet** の鍵で見せること | 見せるのは **W_op**（約束は書けて証明は書けない・§1.5） |
| `linkToRecord(seller-c, R_b)`（第2引数にリゾルバのアドレス） | `linkToRecord(dns("seller-c.eth"), 1)`（**第2引数は recordId**） |
| 場面3で「つないでから切り離す」順 | **切り離し → 戻す → つなぐ → 戻す**（§4 の D-2〜D-5） |
| T7（解放）を D-6 より**前**に打つこと／T7 を live で打たずに済ませること | **T7 は D-6b の後・B7 の最後に live で打つ**。`UNEMANCIPATED` に `ROLE_UNREGISTER` が入るので先に打つと `unregister` が revert する。**打たないと予約ラベルの乗っ取りが塞がらない**（`setResolver` 1本・48,235 gas） |
| 親 `R_vet` に `x402-policy` を書くこと | 書かない（§3.5.3）。`readAgentPolicy` は答えたリゾルバが `P_AG1` でなければ `agent_policy_missing` |
| `AgentPolicy` の `floor: "l2_match"` の1キー | §3.5.1 の **7キー** |
| 審査員ボタンの鍵を**公開**すること | **サーバー側に置く**（H4 の決定・オーナー承認 09-19 08:5x） |
| 場面1に**会期中の mainnet 購入**を選ぶこと | **会期開始（09-25 12:00 UTC）より前に settled した購入**だけ |
| 「85.1% は照合できる宣言が無い」 | 「照合できた 992 件のうち **42.4% が不一致**」【実測 09-16】。提出前に取り直す |
| 「会期前に撮った予備録画」 | 存在しない。**会期中の全部の成功実行を画面収録で残す** |
| 「委任はキー単位より細かい」 | 「**リゾルバ上の全ての名前にまたがるキー単位**」で、旧より粗い |
| 「記録を変えても名前を名指しするイベントが出ない」 | **つなぎ替えは `Linked` が node を indexed で出す** |

**計器・手順・宿題**

| 使ってはいけない | 正しいもの |
|---|---|
| 「A3 の 20/20 の組（sentio ＋ ethpandaops）で `eth_simulateV1` も回る」／「ガスを2系統で照合した」 | **simulate を出すのは sentio だけ**（ethpandaops は `-32601`・25 秒かけて落ちる）。**予備は3本目 `0xrpc.io/sep`**。**ガスは1系統の値**（価格と残高だけ2系統一致）【実測】 |
| `/tokyo` の期待反転を **09-25 12:00Z** / **09-26 13:00Z** にすること | **2026-09-26T06:30:00Z**（`rehearsal` は `TOKYO_EVENT_START` で動かせる） |
| 09-24 の判定を「**ファイルが在る**」にすること | **`cd rehearsal && npm ci && node run.mjs --all` が exit 0**（`2` は期待と違う・`1` は読めない＝不合格ではない） |
| `rehearsal/run.mjs --record` を**会期中に**打つこと | 打つのは鎖の状態を意図して変えた後だけ。**差分を消すために打つと関門が無くなる** |
| 予約ラベル（`atst`・`obs`）を register しただけで「塞いだ」と書くこと | **`setResolver` 1本（48,235 gas）で同じ乗っ取りが起きる**。禁止を `register`・`setResolver`・`unregister` に広げ、**T7 まで打つ** |
| **監視・検証スクリプトが他のリポの `node_modules` を借りること** | 自前の `package.json` を持つ（`~/hackathon-monitor/` と `rehearsal/` は直した。**`hw/src/*.mjs` が残り**）。09-19 に `~/vouch/node_modules` が空で**実際に落ちていた** |
| 会期の夜中に `npm ci` から始めること／手元の node 26.3.0 のまま走らせること | **B0 の最初の3行**（`node -v` が 24.x・`npm ci` が exit 0・`rehearsal` が exit 0）。`engines.node` と CI と本番は **24.x** |
| `grep -c 'input\.payee' … ` が **`0`** になることを判定にすること | **7 行当たるのが正しい**（読み取り4か所＋型・コメント・throw の3行）。§3.3.2 の2行の判定を使う |
| テストの本数 54・55／B1 の 56 を**行数**で数えること／B6 の期待を **50・51・52** にすること | **一意の ID が 56**（B1 も B6 も同じ）。行数で数えると **77** を返す【実測】 |
| 宿題を「13件すべて完了」と書くこと／「完全に閉じたのは4件」と書くこと | **完全に閉じたのは H4・H6・H8・H9・H12 の5件**。他は条件つきか未了。**H14（node と `node_modules`）を足した** |
| `output.required` のキー名を**未定のまま**にすること | **`["result","observed_at"]`**（§3.3.1 で決定）。未定のままだと K1-04 と K1-07 が ±23,000 動く |
| 人の稼働 23.0h・22.25h の見積もり | §6.2 の表（**22.0h**・連続 36 時間の中） |
| `grep -c` / `grep -vc` を判定の最後に置くこと | `… \| grep … \| wc -l`（`grep -c` は一致 0 件で `0` を出して **exit 1**） |
| `grep -cP`（macOS） | `… \| LC_ALL=C grep '[^ -~]' \| wc -l` |
| 参照コミット `5547fe55` / `d350540` | **`e8ff1eb`**（`pay-or-refuse.ts` は `d350540` から無変更なのでアンカーは有効・§2.7） |
| `pay-or-refuse.ts` の 0.6.0 時代の行番号（`:494-502`・`:591`・`:846-848` など） | §3.3.2 の grep アンカー表 |

**この表は機械検査に掛ける。**新しい禁止語を足したら、同じターンで判定コマンド（§8.5 の請求フィルタと上の英語・日本語の grep）にも足す。

---

**この文書はここで終わる。末尾に追記節を作らない。**
v4.1 は監査のたびに末尾へ追記したので本文と末尾が食い違い、上から読む実装エージェントが古い指示で動く状態になった。v4.2 でそれを畳み込んだが、**同じ日のうちに追記が5本また積み上がった**（3回目の敵対監査の2本・関門の確定・ガスの確定・予行演習の作り直し）。追記は速いので、また積む。**次に指摘が出たら、本文の該当節を直し、`CHANGES_v43.md` に「いつ・何を・なぜ」の1行を足す。追記節は作らない。**

**この版で残っている【未確認】（消し方も書いてある。勝手に消さない）**

| # | 場所 | 中身 | いつ消えるか |
|---|---|---|---|
| 1 | §2.1 | `docs.ens.domains` の ENSv2 API 解説ページは JS 描画で機械確認できない | 消さない（**チェーンから読む**と決めてある） |
| 2 | §2.3 / §3.1 / §5 U04 | 参照実装 版2 の `p`＝記録キー・`h`＝値の keccak256 という**写しの解釈** | 会場の **Q2** |
| 3 | §2.6 / §9 R5 | 場面1の5件が当日も ALLOW のままか／引き直しで何が残るか | **09-26 21:20 JST（12:00 UTC の回の完了後）** |
| 4 | §2.8 | 規約の2つの疑い（Continuity 否定の FAQ／賞金が払われるまで作業禁止）と、**Continuity の下位トラックがどちらか** | 09-25 21:40 の口頭確認と、プロジェクト作成の画面 |
| 5 | §4 / §10.1 | **W_op のアドレス**（会期中に `keys.ts init` が作る）。preflight は `TOKYO_W_OP_ADDRESS` が無ければ `skipped` | **BS-03 を打った直後に preflight をもう1回** |
| 6 | §4 / §10.5 | ガスは**その calldata での上限の見積もり**。本番の実鍵とは 1 gas 単位で一致しない | 本番で打つまで消えない（**消さないのが正しい**） |
| 7 | §4 | Sepolia の baseFee が会期中に跳ねるか。測ったのは直近 1,032 ブロック（約 3.4 時間）だけで、安全係数 3 は実測の振れから導いた値ではない | 会期当日の `eth_gasPrice` |
| 8 | §3.7.1 | **審査員が実際に何回押すか**（実績が無い。1日 20〜40 回・3日で最大 120 回と置いた【推定】） | 審査期間中の `tokyo_mutation_log` |
| 9 | §5.5 H1 | `eth_simulateV1` は sentio（予備 `0xrpc.io/sep`）でしか回らず、回ごとに揺れる | B0 |
| 10 | §5.5 H7 | 受取人スコア 41 / 境界 40 ＝ **余裕1点**。BLOCK か WARN かは再測するまで分からない | B0（09-25 21:00） |
| 11 | §5.5 H10 | ENSIP-29 草案 PR #85 は 09-19 時点の値。動く可能性（R1） | 09-24 夜と B0 |
| 12 | §5.5 H11 | app.ens.dev の登録画面の文言 | 09-25 会場 |
| 13 | §5.5 H14 | 手元に node 24 が無い。`~/vouch/node_modules` が空 | 09-24 昼 |
| 14 | §8.4 | ENS への**公開分の件数**（4 件か 5 件か。F2〜F6 を統合できるか） | 送る直前（提出後） |
| 15 | §1.7 | 「他の参加者の名前で1回買う」の gas（相手側のリゾルバは共有で、こちらは払わない） | 当日 13:45 |
| 16 | §8.6 | 開示メールの返信（09-19 から 0 通） | 来なければ来ないまま提出する |

---

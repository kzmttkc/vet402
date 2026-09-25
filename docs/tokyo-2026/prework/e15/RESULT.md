# E15 会期前の予行演習と計数（ENSv2 Sepolia 09-15 配備・取り直し後の4名）

- 実行: 2026-09-18 JST。読み取りと `eth_simulateV1`（`validation:false`）だけ。署名 0・送信 0・commit 0
- 固定ブロック: **11730357〜11730363**（実行ごとに `min(2系統) - 3`）。読み取りは sentio・pandaops の2系統、simulate は sentio のみ（pandaops は `eth_simulateV1` を受けない）
- 印: 【実測】自分で RPC を叩いた／【実測・simulate】`eth_simulateV1`／【一次】ソース／【推定】

## 0. 結論

1. **4つの名前は app.ens.dev が作ったリゾルバに既に向いている**。`seller-a/b/c.eth` は **1つの共有リゾルバ `0x49f5022dDe516B92AC1609158bC6AdC772088055`**（記録 ID 1/2/3・addr 既定で書き済み）、`vet402.eth` は専用 `0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391`。PLAN_DIFF §8 が前提にした「まっさら」ではない【実測】
2. **root の保持者は2者**（持ち主 + app.ens.dev のスマートアカウント）。09-15 配備前と同じ。HCA は剥がす前に実際に `setText` が通る【実測・simulate】→ `revokeRootRoles` は**やる必要がある**
3. E1〜E15 は**全項目が期待どおり**。K1 は **9 tx・合計 gas 2,329,308**（推奨の並び。`revokeRootRoles` は **1回**）

## 1. 計数（A0・A6 の作り直し）【実測 2系統一致・block 11730341】

| 名前 | 持ち主（findExactOwner） | status | tokenId = resource | 今のリゾルバ | 記録 ID | 既定の addr |
|---|---|---|---|---|---|---|
| vet402.eth | `0x502B59Fb…b8e6`（W_vet） | 2 | `6114550924…168576` | `0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391`（専用） | 1 | W_vet |
| seller-a.eth | `0xC0f58Df8…9fa6`（W_ens） | 2 | `7857707296…520256` | `0x49f5022dDe516B92AC1609158bC6AdC772088055`（**3名で共有**） | 1 | W_ens |
| seller-b.eth | 同上 | 2 | `7210757250…916672` | 同上（共有） | 2 | W_ens |
| seller-c.eth | 同上 | 2 | `5303968232…721280` | 同上（共有） | 3 | W_ens |

- `isAvailable` は4つとも false・expiry は 1821178728〜1821179124（2027-09 ごろ）
- どちらのリゾルバも `supportsInterface(0x8c2427cc)` true・`(0x91413117)` false・`VF.verifyContract` = impl `0x14F09Fd05d4585759e54844DC9B00147131Cf243`
- `getRecordCount()`: R_vet = 1・R_shared = **3**（名前ごとに別の箱。つながってはいない）
- text は4つとも空（`x402-offer`・`description`・`avatar` = `""`）。**addr だけ既定で書かれている**（09-17 の `pandas.eth` 1件の観測＝addr 無しとは違う挙動）
- 登録簿側のロール: `roles(resource, owner)` = `0x1111…`相当の登録簿ロール・`isOnlyAssignee(resource, ALL, owner)` = **true**（登録簿には HCA はいない）

### root 全ロールの保持者（`EACRolesChanged` resource 0 の全履歴）【実測】

| リゾルバ | 付与のブロック / tx | 保持者 | 今の値 |
|---|---|---|---|
| R_vet `0x3368…8391` | 11721578 / `0xdcab8a45…f149` | `0xE96b16ab865Aede373C6DE768b3943FA615f173f`（**app.ens.dev のスマートアカウント**） | ALL_ROLES |
| 同 | 同じ tx | `0x502B59Fb…b8e6`（W_vet） | ALL_ROLES |
| R_shared `0x49f5…8055` | 11721545 / `0xca6c2f28…7f81` | `0xd45a2E001A8e0681A7C4AFa27fa88fFF0FA1A5D9`（**同 スマートアカウント・W_ens 用**） | ALL_ROLES |
| 同 | 同じ tx | `0xC0f58Df8…9fa6`（W_ens） | ALL_ROLES |
| （参考）pandas の `0xD2A3…6cd2` | 11717478 | 持ち主 `0xb60EA8C8…20A9` だけ | ALL_ROLES |

- `ResourceArgument` はどのリゾルバも **0件**（キー単位の委任はまだ無い）
- コード長: W_vet = EOA（コード無し）・**W_ens は 7702 委任つき**（code 23 byte）・HCA は2つとも 156 hex（同じ形）
- **`revokeRootRoles` を打つ回数**: 推奨の並びでは **1回**（R_vet だけ。seller は新しい `P_bc` に移すので HCA は最初から居ない）。b/c を今の共有リゾルバに残す道を選ぶなら **2回**

## 2. E1〜E15 の結果【実測 / 実測・simulate】

| # | 対象・関数 | from | 4byte | 結果 | 期待どおり |
|---|---|---|---|---|---|
| E1 | `UR.ROOT_REGISTRY` / `UH.ROOT_REGISTRY` / `Root.getSubregistry("eth")` / `impl.supportsInterface(0x8c2427cc)` | 誰でも | — | `0x9703DBD2…a9cE` ×2・`0x657eA849…E09E`・true | ○ |
| E2 | `isAvailable` ×4・`getState` ×4・`findExactOwner` ×4 | 誰でも | — | false・status 2・持ち主一致（上の表） | ○ |
| E3 | `findExactOwner(x.obs.vet402.eth)` / `findNearestOwner(同)` / `findExactOwner(atst.vet402.eth)` | 誰でも | — | `0x0` / `(W_vet, 6)` / `0x0` | ○ |
| E4 | `VF.deployProxy(impl, SALT, init)`（eth_call） | W_ens | `0x5d84121a` | P_a = `0xC54403186Db35B9D92cc393Ae665D3960117ac14`・P_bc = `0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf`。initData を変えても同じ・送り手を W_vet にすると `0x16209C47…ff9C` | ○ |
| E5 | `ETHRegistry.setResolver` | W_ens / W_op | `0x4b0bddd2` | OK(gas 40,420) / **`EACUnauthorizedAccountRoles(0x115f4e02…,0x1000000,W_op)`** | ○ |
| E6 | deployProxy→setResolver→`grantSetterRoles`→`roles` | W_ens | `0xccd3eaff` | OK・ログ `ResourceArgument`+`EACRolesChanged`・`roles = 0x10` | ○ |
| E7 | `P_a.setText(seller-a.eth,"x402-offer",…10001…)`→`UR.resolve` | W_op / 誰でも | `0xc7279f88` | OK(56,961)・`TextUpdated` 1本・UR が新しい値を返す | ○ |
| E8-1 | `P_a.setText(seller-a.eth, attestations[x402-offer][atst.vet402.eth])` | W_op | `0xc7279f88` | **`EACUnauthorizedAccountRoles(0x2363e661…,0x10,W_op)`** | ○ |
| E8-2 | `R_shared.setText(seller-b.eth,"x402-offer")`（別リゾルバ・実在） | W_op | `0xc7279f88` | **`EACUnauthorizedAccountRoles(0xddc51409…,0x10,W_op)`** | ○ |
| E8-2b | `P_bc.setText(seller-b.eth,"x402-offer")`（同じ simulate で配備した別リゾルバ） | W_op | `0xc7279f88` | **同上 revert** | ○ |
| E8-3 | `P_a.linkToRecord(seller-a.eth, 0)` | W_op | `0x35378097` | **`EACUnauthorizedAccountRoles(0x0, 0x10000000, W_op)`** | ○ |
| E8-4 | `P_a.grantSetterRoles(…, W_op2)` | W_op | `0xccd3eaff` | **`EACCannotGrantRoles(0xddc51409…,0x10,W_op)`** | ○ |
| E8-5 | `P_a.grantRoles(keccak("x402-offer"),0x10,W_op2)` | W_op | `0x1a2a3a2a`※ | **`EACCannotGrantRoles(…,W_op2)`** | ○ |
| E8-6 | `P_a.setText(zz.seller-a.eth,"x402-offer")`（開示） | W_op | `0xc7279f88` | **OK**（委任は同じリゾルバ上の全 node に効く。未登録サブ名は `findExactOwner` 0 なので段2で止まる） | ○（開示どおり） |
| E9 | 新 `P_bc` を配備→`setResolver` ×2→`getRecordId`→切り離し→戻す→`seller-c`→`R_b`→戻す | W_ens | `0x35378097` | R_b=1・R_c=2。切り離しで `x402-offer` も envelope も `""`、`Linked` 1本・`TextUpdated` 0本。`seller-c` に `R_b` をつなぐと **b の約束と `ENVELOPE_B` がそのまま読める**。戻すのは 1 tx | ○ |
| E9b | 今の共有リゾルバ `R_shared` で同じ流れ | W_ens | 同上 | R_b=**2**・R_c=**3**。同じ結果。ただし **W_ens は同じリゾルバで `seller-a` の約束も書ける**（分離できていない） | ○ |
| E10 | `linkToRecord(seller-b,0)` → `linkToNode(seller-c, namehash(seller-b))` | W_ens | `0x5d27b8e5` | 2本目が **`InvalidRecord()`**。順番を入れ替えても（箱が空なら）同じ | ○ |
| E11 | `setAddress(atst…,60,K_atst)`→`multicall(grantSetterRoles ×15)`→W_obs が `setText`／`setAddress`→`UR.resolve(addr)` | W_vet / W_obs | `0xb4436dde`・`0xac9650d8` | OK・OK(918,878・`ResourceArgument`+`EACRolesChanged` 30本)・OK・**`EACUnauthorizedAccountRoles(0xc6bb06cb…,0x1,W_obs)`**・`K_atst` が返る。※W_obs は `vet402.eth` の同じキーも書ける（開示） | ○ |
| E12 | `deployProxy(initialize の calls に grantSetterRoles)` | W_ens | `0x5d84121a` | **`EACCannotGrantRoles(0xddc51409…,0x10,0x9e726Eb5…841C)`**（VerifiableFactory が msg.sender） | ○ |
| E13 | root 保持者の一覧・`isOnlyAssignee`・`revokeRootRoles` | 誰でも / W_vet / W_ens | `0x…` | 剥がす前: `isOnlyAssignee(0,ALL,持ち主)` = **false**・`hasRootRoles(ALL,HCA)` = true・**HCA の `setText` は通る**。`revokeRootRoles(ALL,HCA)` OK(41,137)→ `isOnlyAssignee` true・HCA の `setText` は revert | ○ |
| E14 | viem 2.55.1 `getEnsResolver`/`getEnsAddress`/`getEnsText`（blockNumber 固定・4名・2系統）＋ canary | 誰でも | — | 例外なし・2系統一致。resolver と addr は上の表どおり・text は **null（K1 前なので期待どおり）**。canary は `LabelRegistered` 11721400-11721700 で **17件が2系統一致**、うち自分の `seller-a@11721545`・`seller-b@11721555`・`seller-c@11721565`・`vet402@11721578` | ○ |
| E15 | `P_a.revokeRoles(keccak("x402-offer"),0x10,W_op)` → W_op の `setText` | W_ens / W_op | `0xdfa70d8b` | OK(38,317)・`EACRolesChanged` → 以後 **`EACUnauthorizedAccountRoles`** | ○ |

※E8-5 の 4byte は `grantRoles(uint256,uint256,address)` = `0x7c300586`【実測】。

## 3. K1 で打つ tx（順番・推奨）【実測・simulate 一括で通した。合計 gas 2,329,308・9 tx】

| # | from | 宛先 | 関数・引数の要点 | gas | 依存 |
|---|---|---|---|---|---|
| K1-01 | W_vet | R_vet `0x3368…8391` | `revokeRootRoles(ALL_ROLES, 0xE96b16ab…173f)` | 41,137 | なし。**これが「持ち主だけ」の根拠になる** |
| K1-02 | W_vet | R_vet | `multicall[setText(vet402.eth,"agent-endpoint[x402]"), setText(vet402.eth,"class"), setAddress(atst.vet402.eth,60,K_atst)]` | 172,786 | K1-01 の後に打つ（順序は任意だが開示の都合） |
| K1-03 | W_vet | R_vet | `multicall[grantSetterRoles(setText(*,key_i,""), W_obs) ×15]` | 918,878 | K1-01。`ResourceArgument` が 15 本残る |
| K1-04 | W_ens | VF `0x9e72…841C` | `deployProxy(impl, SALT_A=keccak("tokyo-2026/seller-a.eth"), initialize([(W_ens,ALL)], [setText×3, setAddress]))` → **P_a `0xC544…ac14`** | 448,516 | なし |
| K1-05 | W_ens | ETHRegistry | `setResolver(tokenId(seller-a), P_a)` | 40,420 | K1-04（アドレスは事前計算できるので並べて署名可） |
| K1-06 | W_ens | P_a | `grantSetterRoles(setText(dns("seller-a.eth"),"x402-offer",""), W_op)` | 87,356 | K1-04。**initialize の calls に入れると revert（E12）** |
| K1-07 | W_ens | VF | `deployProxy(impl, SALT_BC=keccak("tokyo-2026/seller-bc.eth"), initialize([(W_ens,ALL)], [b の setText×2+setAddress, c の setText×2+setAddress]))` → **P_bc `0xd6A0…d2bf`** | 539,375 | なし。**記録 ID は b=1・c=2 で確定** |
| K1-08 | W_ens | ETHRegistry | `setResolver(tokenId(seller-b), P_bc)` | 40,420 | K1-07 |
| K1-09 | W_ens | ETHRegistry | `setResolver(tokenId(seller-c), P_bc)` | 40,420 | K1-07 |

**別の道（b/c を今の共有リゾルバに残す）**: K1-07〜09 を `R_shared.revokeRootRoles(ALL, 0xd45a2E00…A5D9)` + `R_shared.multicall[setText ×4〜6]` の 2 tx に置き換える（`revokeRootRoles` は計 2回）。gas は約 350k で安いが、(a) `R_shared` に `seller-a` の箱（ID 1）が残る、(b) 記録 ID が b=2・c=3 になる、(c) root の履歴に HCA の付与と剥がしが並ぶ。**推奨は上の 9 tx**。

デモ（場面3）で打つ tx はこれと別: `P_a.setText(x402-offer)`(W_op・56,961) → `P_bc.linkToRecord(seller-b.eth, 0)`(41,355) → `P_bc.linkToRecord(seller-b.eth, 1)`(63,267) → `P_bc.linkToRecord(seller-c.eth, 1)`(46,167) → `P_bc.linkToRecord(seller-c.eth, 2)`(46,167)。

## 4. 計画に直しが要る点

1. **§8 E4/E6/E9 の前提が違う**。4名はもう app.ens.dev のリゾルバに向いている。E4 の `deployProxy` は「新しく作る」でよいが、**E9 の R_b/R_c は「新 P_bc なら 1/2」「今の共有リゾルバなら 2/3」**。台本に固定値を書くなら P_bc 前提で 1/2
2. **§4.5 P28 の「会期前は app.ens.dev のリゾルバ」は正しいが、保持者は2者**。`revokeRootRoles` を K1 の**最初**に置く（打つのは 1回）。剥がす前に HCA が実際に書けることを simulate で確認済みなので、開示にも「剥がすまでは2者が書けた」と書ける
3. **依頼文の impl アドレスはチェックサム誤り**。`0x14F09Fd05d4585759e54844dc9b00147131Cf243` は viem が拒否する。正は **`0x14F09Fd05d4585759e54844DC9B00147131Cf243`**（`VF.verifyContract` の戻り値と一致）
4. **app.ens.dev は既定で addr を書く**（4名とも）。「既定の記録は無い」という 09-17 の観測（pandas 1件）は取り下げる。`seller-b` を切り離すと **addr も `0x0` になる**（E9b-4b）ので、場面3の「全キーが一度に空」は addr を含む
5. **E8-2 の「別の売り手は revert」は、リゾルバを分けて初めて成立**。今の共有リゾルバのままだと W_ens が3名を横断して書けてしまう（E9b-10）。P_a を分ける理由を提出文に1行で書く
6. **canary は 11717398（pandas）から自分の登録に差し替えられる**。`LabelRegistered` の `seller-a@11721545` など4本が2系統一致。§4.5 P27 をこれで置き換える
7. **W_ens は 7702 委任つきのアカウント**（code 23 byte）。「持ち主 = EOA」と書かない
8. `linkToNode` の `InvalidRecord` は**箱が空なら順番に関係なく出る**（E10-3）。「順番の罠」ではなく「空の箱にはつなげない」と書くほうが正確

## 5. 使ったファイル

- `/private/tmp/claude-501/-Users-takeshi-Takeshi-Automation/8ff986e2-9ab4-4db3-bd00-c6f757683384/scratchpad/e15/lib.mjs`（共通・アドレス・ABI 読み込み）
- 同 `census.mjs` → `census_result.json`（計数）
- 同 `e15.mjs` → `e15_result.json`（E1〜E15）
- 同 `k1.mjs` → `k1_result.json`（K1 の 9 tx を順番どおり simulate）
- 同 `probe_hca.mjs`（HCA が書けるかの単独確認）
- 同 `EAC.sol`（`https://raw.githubusercontent.com/ensdomains/contracts-v2/d9affea0/contracts/src/access-control/EnhancedAccessControl.sol`）
- 同 `PLAN_DIFF.md`（`origin/kabau-trust-board` からの控え）・`ref/`（既存スクリプトと新 ABI の控え）

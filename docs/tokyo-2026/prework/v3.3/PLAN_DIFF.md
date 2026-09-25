# PLAN_v3 → v3.3 差分案（ENSv2 Sepolia 09-15 配備の ABI に合わせる）

- 作成: 2026-09-17 09:0x JST（読み取りと scratchpad への書き込みだけ。commit・署名・送信 0）
- 対象: `origin/kabau-trust-board@c1feaba6` の `.company/departments/hackathon/tokyo-2026/PLAN_v3.md`（991行・sha256 `78364dce…4714`）と `CONCEPT_v3.md`（95行）。行番号はこの版
- 印: 【実測】自分で RPC を叩いた（sentio＝`https://sepolia.rpc.sentio.xyz`・pandaops＝`https://rpc.sepolia.ethpandaops.io`）／【実測・simulate】sentio の `eth_simulateV1`（署名なし・送信なし・状態はその呼び出しの中だけ。pandaops はこのメソッドを受けない【実測】）／【一次】ソースの URL と行／【推定】／【未確認】
- 控え（同じディレクトリ）: `sim.mjs`→`sim_result.json`（39手順）・`sim2.mjs`→`sim2_result.json`（11手順）・`reads.mjs`→`reads_result.json`（2系統・block 11720074 固定）・`topics.mjs`・`roles_app.mjs`・`src/`（ソースの控え）・`cv2/`（contracts-v2 の clone）

---

## 0. 結論

1. **作品の中心は変えなくてよい**。ENSIP-29 の検証は「今の ENS データで payload を組み直す」ので、読み取りの関数名が変わるだけで REFUSE の性質は同じ（持ち主 = `UniversalHelper.findExactOwner`、記録 = Universal Resolver 経由の `resolve`）
2. **09-17 08:5x の要約の1点は誤り**。`grantSetterRoles` は「呼び出し単位」でも「名前単位」でもなく、**リゾルバ単位のキー委任**。setter の呼び出しデータのうち名前は捨てられ、セレクタとキーだけが使われる。`seller-a.eth` の `x402-offer` だけを委任するには、**seller-a.eth 専用のリゾルバを作る**しかない
3. 場面3の続きは **`linkToRecord(name, 0)`（記録の切り離し＝clearRecords の代わり）** と **`linkToRecord(seller-c, <seller-b の記録ID>)`（他の名前の証明つき記録にそのままつなぐ＝別名の代わり）** に置き換える。どちらも ENSIP-29 は REFUSE。元に戻すのは1 tx（`linkToRecord(name, 元の記録ID)`）で、証明の置き直しが要らない

影響箇所: **PLAN_v3.md 81か所・CONCEPT_v3.md 5か所・計 86か所**（§3 の表）。テストの期待値の変更 6本（T04・T05a・T06・T14・T34・T35）＋追加提案 1本。

---

## 1. 一次資料の確定

### 1.1 09-15 配備に対応するソース
- contracts-v2 の commit `5fb88dc`（2026-09-15T12:57+09:00）の本文: "Fresh v2 set deployed from **d9affea0** (PR #427 tip, includes post-audit-2)"【一次】
- 配備表を更新した commit: `07690a9`（branch `deploy/sepolia-migration-20260915`）・一式の再配備 `71a3b73`（branch `migration-resilience-and-verification`・"Phases 1-7 ran on live Sepolia"）【一次】
- `git diff d9affea0 71a3b73 -- contracts/src` は空（ソースは同じ）【実測 clone】。`71a3b73:contracts/deployments/sepolia/PermissionedResolverImpl.json` の `address` = `0x14f09fd0…f243`、`UniversalHelper` = `0x33f571aa…7df5`、`UniversalResolverV2` = `0x5d25c1d6…03e3`、`ETHRegistry` = `0x657ea849…e09e`（オンチェーンの新アドレスと一致）【一次】
- 今回の変更の元: `c6956ce` "Refactored `PermissionedResolver` (inodes w/o versioning) (#354)"（`97a57293..d9affea0` の間）【一次】
- 以下 `PR.sol` = `https://github.com/ensdomains/contracts-v2/blob/d9affea05c8df672d1ce69b036b6ad699aadaed9/contracts/src/resolver/PermissionedResolver.sol`、同じ commit で `EAC.sol` = `src/access-control/EnhancedAccessControl.sol`、`Lib.sol` = `src/resolver/libraries/PermissionedResolverLib.sol`、`ARR.sol` = `src/resolver/AbstractRecordResolver.sol`、`IPR.sol` = `src/resolver/interfaces/IPermissionedResolver.sol`、`IRR.sol` = `src/resolver/interfaces/IRecordResolver.sol`、`UH.sol` = `src/universalResolver/UniversalHelper.sol`、`LibRes.sol` = `src/universalResolver/libraries/LibResolution.sol`、`PReg.sol` = `src/registry/PermissionedRegistry.sol`、`IPReg.sol` = `src/registry/interfaces/IPermissionedRegistry.sol`
- 注意: `LibRegistry.sol` は `LibResolution.sol` に改名された（`97a57293` にはあり `71a3b73` には無い）【実測 clone】
- docs.ens.domains/ensv2/* は旧 ABI のまま（R2 節の実測）。**docs を根拠にしない**

### 1.2 新しい ABI の要点（旧 → 新）
| 旧（07-30・`97a57293`） | 新（09-15・`d9affea0`） | 出典 |
|---|---|---|
| `setText(bytes32 node, string, string)` `0x10f13a8c` | `setText(bytes name, string key, string value)` `0xc7279f88`（DNS 形式の名前） | `PR.sol:221-228` |
| `setAddr(bytes32,address)`・`setAddr(bytes32,uint256,bytes)` | `setAddress(bytes name, uint256 coinType, bytes addressBytes)` `0xb4436dde` | `PR.sol:164-175` |
| `authorizeTextRoles(bytes,string,address,bool)` `0xf2d1eb25` | `grantSetterRoles(bytes setter, address account)` `0xccd3eaff`（取り消しは `revokeRoles(resource, role, account)` `0xdfa70d8b`） | `PR.sol:254-261`・`EAC.sol:146-156` |
| `setAlias(bytes,bytes)`・`getAlias` | `linkToNode(bytes sourceName, bytes32 targetNode)` `0x5d27b8e5`・`linkToRecord(bytes sourceName, uint256 recordId)` `0x35378097`・`getRecordId(bytes32)` `0xfaf10086`・`getRecordCount()` | `PR.sol:231-251`・`264-271` |
| `clearRecords(bytes32)`・`recordVersions` | **後継なし**（`Cleared(uint256)` は ABI にあるが、どこからも emit されない【実測 `git grep "emit Cleared"` 0件】） | `IRR.sol:40-42` |
| `initialize(address admin, uint256 roleBitmap, bytes[] calls)` `0x7058b559` | `initialize((address account,uint256 roleBitmap)[] grants, bytes[] calls)` `0x33cc44a0` | `PR.sol:119-126`・`IPermissionedResolverInitializable.sol:12` |
| `text(bytes32,string)` などの直接の view | **無い**。読み取りは `resolve(bytes name, bytes data)` だけ（`data` の node は無視され、`name` の namehash で引く） | `ARR.sol:110-159` |
| `grantRoles(resource, role, account)` | **常に revert**（`EACCannotGrantRoles`）。キーの委任は `grantSetterRoles` だけ | `PR.sol:297-304` |
| `IPermissionedResolver` の interfaceId `0x91413117` | `0x8c2427cc` | `IPR.sol:8`／【実測】impl で `0x8c2427cc` true・`0x91413117` false（2系統一致） |
| UR `findOwner(bytes)` | `UniversalHelper.findExactOwner(bytes)` `0x78b8187f`・`findNearestOwner(bytes)` `0x4f50b731` | `UH.sol:39-53` |
| 残るもの | `grantRootRoles`・`revokeRootRoles`・`roles`・`hasRoles`・`multicall`・`ETHRegistry.setResolver/getState/getResolver`・`VerifiableFactory.deployProxy` | abidiff.txt |

### 1.3 イベント（topic0 は新 ABI から計算【実測 `topics.mjs`】）
| 旧 | 新 | topic0（新） |
|---|---|---|
| `TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)` | `TextUpdated(uint256 indexed recordId, string indexed keyHash, string key, string value)` | `0x14cf4389d9a790cb32a054e033d7e3d3b78119dee4fea3c0983aac1db3f54015` |
| `AddressChanged(bytes32 indexed node, uint256, bytes)`／`AddrChanged` | `AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes)` | `0x5856fffa4d8f7605f45813e1cc223ac63a6fa1f09ca60f0e6a6525317bc7fa41` |
| `AliasChanged(bytes indexed, bytes indexed, bytes, bytes)` | `Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)`（`recordId=0` は切り離し） | `0x66fd1d4edf16fc35ee08adaecfdf6fd5f75283da903b50f642558d6e0ba630ff` |
| `VersionChanged(bytes32 indexed node, uint64)` | なし | — |
| `NamedTextResource(uint256 indexed resource, bytes name, bytes32 indexed keyHash, string key)` | `ResourceArgument(uint256 indexed resource, bytes arg)`（初めて委任されたキーのときだけ） | `0x92e004abe10c8757cf5990633f6f6e2a40d9b458d29c9dace3fc41c953b46fc2` |
| `EACRolesChanged`・`Upgraded` | 同じ | `0x0d35bf72…ba3c`・`0xbc7cd75a…2d3b` |
| 登録簿 `ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)`・`TransferSingle`・`TokenRegenerated` | 同じ（ETHRegistry の event は新旧で topic0 が全部一致） | `0x9b6b420f…a8d5`・`0xc3d58168…0f62`・`0x4adeae13…7d58` |

**監視で効く違い**: 記録の変更イベントは **node ではなく recordId に付く**。名前がどの記録を指すかは `Linked` で変わり、そのとき `TextUpdated` は1本も出ない。さらに、つながった別の名前経由で書いても同じ recordId の `TextUpdated` が出るだけで、この名前の node はどこにも出ない【実測・simulate 手順22-23】。

---

## 2. 確かめた事実（依頼の6問）

### Q1 `grantSetterRoles(bytes, address)` は何を委任するか
- **委任の単位は「そのリゾルバ上の、setter の種類 × 引数（キー）」。名前は含まない**【一次】
  - `decodeSetter` は呼び出しデータから**セレクタと第2引数だけ**を取り、名前（第1引数）は読み捨てる: `(, string memory key) = abi.decode(setter[4:], (bytes, string)); arg = bytes(key); roleBitmap = ROLE_SET_TEXT;` … `resource = uint256(keccak256(arg))`（`PR.sol:317-320`・`336`）
  - `grantSetterRoles` は `_checkCanGrantRoles(resource, roleBitmap, msg.sender)` の後 `_grantRoles(resource, roleBitmap, account, true)`（`PR.sol:254-261`）。`setText` の検査は `onlyRoles(PermissionedResolverLib.resource(key), ROLE_SET_TEXT)`（`PR.sol:221-224`）で、`resource(key)` は `keccak256(bytes(key))`（`Lib.sol:68-70`）。`onlyRoles` は root との OR（`EAC.sol:463-465`）
  - ENS 自身のテストが明記: `grantSetterRoles(abi.encodeCall(PermissionedResolver.setText, ("", key, "")), friend)` の後 "friend can change setText(key) on any name"（`test/unit/resolver/PermissionedResolver.t.sol:912-927@71a3b73`）
  - 対応する setter は `setAddress`（coinType）・`setText`（key）・`setData`（key）・`setABI`（contentType）・`setInterface`（interfaceId）だけ。`setName`・`setContenthash`・`linkTo*` は root 専用（`PR.sol:307-338`・`180`・`213`・`233`・`245`）
- **実測・simulate**（`sim_result.json`・block 11720074）:
  - 手順06: `grantSetterRoles(setText(dns("pandas.eth"),"x402-offer",""), OP)` → `ResourceArgument(resource=keccak("x402-offer"), arg="x402-offer")`・`EACRolesChanged(resource=0xddc51409…, OP, 0→16)`
  - 手順08: OP が `pandas.eth` の `x402-offer` を書ける／**手順09: OP が同じリゾルバの `sharks.eth` の `x402-offer` も書ける**／手順10: 未登録のサブ名 `zz.pandas.eth` にも書ける（記録が新しく作られる）
  - 手順11: OP が `attestations[x402-offer][atst.vet402.eth]` を書く → `EACUnauthorizedAccountRoles(0x2363e661…, 0x10, OP)`／手順12: OP が他人に委任 → `EACCannotGrantRoles`／手順13: OP が `linkToRecord` → `EACUnauthorizedAccountRoles(0x0, 0x10000000, OP)`／手順33: `revokeRoles(keccak("x402-offer"), 0x10, OP)` の後は OP も書けない／手順34: `grantRoles` は持ち主でも `EACCannotGrantRoles`
  - `decodeSetter(setText(dns("seller-a.eth"),"x402-offer",""))` と `decodeSetter(setText("","x402-offer","anything"))` は同じ `(0x783430322d6f66666572, 0xddc51409…, 16)`【実測 2系統一致】
- **「seller-a.eth の x402-offer だけ」を渡す正しい呼び方**（3 tx、すべて W_ens から）:
  ```
  # 1. seller-a.eth 専用のリゾルバを作る（記録は initialize の calls で同時に置ける）
  initA = PermissionedResolver.initialize(
            [(W_ens, 0x1111…1111)],                                   # root は W_ens だけ
            [ setText(dns("seller-a.eth"), "x402-offer", OFFER_A),
              setText(dns("seller-a.eth"), "agent-endpoint[x402]", "https://vet402.com/api/tokyo/seller"),
              setAddress(dns("seller-a.eth"), 60, abi.encodePacked(W_ens)) ])
  P_a = VerifiableFactory(0x9e726Eb5…e841C).deployProxy(0x14F09Fd0…F243, SALT_A, initA)
  # 2. seller-a.eth をそのリゾルバに向ける
  ETHRegistry(0x657eA849…E09E).setResolver(getState(labelhash("seller-a")).tokenId, P_a)
  # 3. キーを委任（名前の欄は読まれないが、読みやすさのため seller-a.eth を入れる）
  P_a.grantSetterRoles(setText(dns("seller-a.eth"), "x402-offer", ""), W_op)
  ```
  - 残る範囲（開示）: W_op は P_a の上の**どの node でも** `x402-offer` を書ける。P_a に解決されるのは `seller-a.eth` と、その**未登録のサブ名**だけ（`LibRes.sol:58-85`）。サブ名は `findExactOwner` が 0 なので `ens_name_unresolved` で止まり、証明も無い【実測・simulate 手順10・38】
  - **`grantSetterRoles` を `initialize` の calls に入れてはいけない**: calls の中の `msg.sender` は VerifiableFactory で、`EACCannotGrantRoles(keccak("x402-offer"), 0x10, 0x9e726Eb5…)` で配備ごと revert【実測・simulate sim2 A10】（calls の権限検査が飛ぶのは `_checkRoles` だけで、`_checkCanGrantRoles` は飛ばない: `PR.sol:369-378`・`EAC.sol:396-405`）
  - プロキシのアドレスは送り手と salt だけで決まり、initData を変えても同じ【実測 sim2: `0xC5440318…ac14` が両方】→ `setResolver` を先に組める（A7 の注意4は有効）

### Q2 `linkToNode`・`linkToRecord` の意味と、ENSIP-29 への影響
- **意味**【一次】: 記録は ID つきの箱（`_records[recordId]`）で、名前（node）は箱の ID を指すだけ（`_recordIds[node]`・`PR.sol:94-100`）。setter は「その名前の箱が無ければ新しく作る」（`_ensureRecord`・`PR.sol:352-360`）。`linkToNode(name, targetNode)` は `name` を `targetNode` が今使っている箱に向ける（箱が無ければ `InvalidRecord`・`PR.sol:231-240`）。`linkToRecord(name, id)` は ID を直接指定、`0` は切り離し（`PR.sol:243-251`・`IPR.sol:34-37`）。どちらも root の `ROLE_LINK`（`1<<28`・`Lib.sol:48`）だけ。読み取りは箱が 0 なら「既定の箱」（`_recordIds[bytes32(0)]`）を使う（`PR.sol:381-387`）
- **旧 `setAlias` との違い**:
  | | 旧 `setAlias(from, to)` | 新 `linkToNode`／`linkToRecord` |
  |---|---|---|
  | 仕組み | 読むときに node を書き換える（`getAlias`） | 2つの名前が**同じ箱を共有**する |
  | 書き込み | 元の名前の記録は隠れるだけ | **どちらの名前で書いても同じ箱が変わる**【実測・simulate 手順22-23: sharks 経由で書いた `VIA_LINK` が pandas でも読める】 |
  | 先の準備 | 別名先の node に記録を書いておく（`alias-prepare`） | 既にある箱につなぐだけ。箱が無い node へは `InvalidRecord`【実測 手順31】 |
  | 消す | 別名を外す | `linkToRecord(name, 0)`＝**全キーが一度に空**。元の ID につなぎ直せば全部戻る【実測 手順26-30】 |
  | イベント | `AliasChanged` | `Linked(recordId, node, name)`・`TextUpdated` は出ない |
- **Universal Resolver 経由の読み取り**【実測・simulate】: 手順20-21 `linkToNode(sharks, namehash(pandas))` の後、UR の `text(sharks, x402-offer)` と `text(sharks, attestations[…])` は **pandas の約束と envelope をバイト単位で返す**。手順25・27-28 切り離しの後はどちらも `""`
- **ENSIP-29 の検証がどう変わるか**:
  - つないだ場合（`seller-c` → `seller-b` の箱）: 検証は `n = seller-c.eth` で payload を組み直す。envelope は `n = seller-b.eth` で署名されたものなので、`a`・`k`・`v`・`t` が全部同じでも復元される署名者は変わる → `ens_attestation_signer_mismatch`【推定: 草案 58-64行（payload に `n`）・123行 "The envelope is republished under a different ENS name"。T07 と同じ入力】
  - 切り離した場合: `x402-offer` も envelope も `""` → `ens_offer_missing`（語の優先で attester の語より先）【実測: 値が空になること／推定: 語の選択は §2.4 の優先順】
  - つなぎ直した場合: 元の箱が戻り、`t` が鮮度内なら**再び VALID**。これは「変えて戻す」（I7）と同じ種類で、保護しないものに足す
- → **場面3の置き換え案は §4.2**

### Q3 `clearRecords` の後継が無い今、「一括で消す／版を上げる」操作は残っているか
| 候補 | 効果 | 権限 | 場面に使えるか |
|---|---|---|---|
| **`linkToRecord(name, 0)`** | その名前の全キーが空（既定の箱が空なら）。1 tx・`Linked(0, node, name)`・`TextUpdated` 0本 | リゾルバ root の `ROLE_LINK` | **使う**（clearRecords の場面の直接の置き換え。元に戻すのも1 tx） |
| `ETHRegistry.setResolver(tokenId, 別のリゾルバ／0x0)` | 読み先ごと変わる。全キーが空 | 登録簿の `ROLE_SET_RESOLVER`（持ち主） | 使える（`ResolverUpdated`）。ただし戻す時にリゾルバの向け直しが要り、UR の `findResolver` 側の話になるので、ENSv2 の Permissioned Resolver の見せ場としては弱い |
| リゾルバの UUPS アップグレード | 実装ごと変わる | root の `ROLE_UPGRADE`（`PR.sol:345-349`） | 使わない（場面にしない） |
| 名前の失効・unregister | `getResolver` が 0（`PReg.sol:283-286`）・`findExactOwner` 0 | 登録簿の `ROLE_UNREGISTER`（持ち主に付くかは【未確認】） | 使わない（取り直しになる） |
| 版を上げる操作 | **無い**（#354 "inodes w/o versioning"） | — | — |

### Q4 記録の変更で出るイベント（監視・補助の走査用）
§1.3 の表のとおり。走査は **node → recordId の対応を先に作る**必要がある:
1. `UR.findResolver(dns(n))` で B 時点のリゾルバ R を得る
2. `R.getRecordId(namehash(n))` を `t` のブロックと B で読む（ID が違えば変わっている）
3. `Linked` を topic2 = `namehash(n)` で `t..B` に読む（1本でもあれば変わっている）
4. `TextUpdated` を topic1 ∈ {上の recordId}・topic2 ∈ {`keccak256("x402-offer")`, `keccak256("attestations[x402-offer][atst.vet402.eth]")`} で読む（**topic2 は `string indexed keyHash` なので keccak256(key)**）
5. 登録簿 `ResolverUpdated`（tokenId は `TokenRegenerated` で変わるので `getState` の tokenId を t と B で両方）・`TransferSingle`・`LabelUnregistered`／リゾルバ `Upgraded`
（`EACRolesChanged` は誰が書けるかの表示用。失効の判定には使わない）

### Q5 `findExactOwner`／`findNearestOwner` の意味と、持ち主の判定に何を使うか
- **意味**【一次】: 両方とも根の登録簿から名前を上から辿り、各階層で `IOwnedRegistry.findOwner(label)`（＝`getOwner(labelhash)`、期限切れなら 0・`PReg.sol:309-311`・`342-344`）を読む。0 でない所を「見つかった所」として覚える（`LibRes.sol:236-257`）。`findExactOwner` は**見つかった所が名前そのものの時だけ**返し、それ以外は 0（`LibRes.sol:92-99`）。`findNearestOwner` は一番近い祖先の持ち主と、そのオフセットを返す（`LibRes.sol:107-113`・`UH.sol:43-53`）
- **`ens.eth` が 0x0 の理由**【実測 2系統一致・block 11720074】: `ETHRegistry.getState(labelhash("ens"))` = `status 1`（`RESERVED`）・`latestOwner 0x0`・expiry 1853483388。`RESERVED` は「期限内だが持ち主 0」（`PReg.sol:689-697`・`IPReg.sol:23-27`）なので `getOwner` が 0 → 完全一致の持ち主は無い → `findExactOwner` 0x0。近い持ち主は1つ上の `eth`（根の登録簿で `0x84D3a426…39D3` が持つ・`findExactOwner(dns("eth"))` も同じ）→ `findNearestOwner(ens.eth)` = `(0x84D3a426…, offset 4)`（`\x03ens` の4バイト先が `eth`）
- **何を使うべきか**:
  | 候補 | 使うか | 理由 |
  |---|---|---|
  | **`UniversalHelper.findExactOwner(dns(n))`** | **ENSIP-29 の段2（manager `a`）に使う** | 旧 `findOwner` の直接の後継。期限切れ・RESERVED・未登録のサブ名で 0 を返す【実測・simulate 手順37-38: `pandas.eth`→持ち主・`zz.pandas.eth`→0】。階層を問わない |
  | `findNearestOwner` | **使わない** | wildcard のサブ名（`<id>.obs.vet402.eth`）で親の持ち主（W_vet）を返す【実測 手順39: `zz.pandas.eth`→(持ち主, 3)】。段2に使うと、サブ名に写した証明の `a` が親と一致しうる |
  | `ETHRegistry.getState(labelhash).latestOwner` | **単独では使わない**。2LD の第2経路の照合にだけ（`status == 2` かつ `latestOwner == a`） | `latestOwnerOf` は期限を見ない（`PReg.sol:366-368`）。`status` は期限と持ち主から作る（`PReg.sol:353-363`） |
  | `ETHRegistry.ownerOf(tokenId)` | 使わない | 権限が変わると tokenId が作り直され（`TokenRegenerated`・`PReg.sol:566-580`）、古い tokenId では 0（`PReg.sol:371-381`） |
  | リゾルバの EAC の root | 使わない | 書ける人であって、名前の持ち主ではない（app.ens.dev の旧登録では HCA も root を持っていた） |
- **UniversalHelper は UR と別のアドレス**（UR の入口 `0xeEeE…EeEe` はプロキシで固定、Helper `0x33f5…7df5` は直の配備）→ 読むたびに `UH.ROOT_REGISTRY() == UR.ROOT_REGISTRY()` を同じブロックで確かめる（違えば `ens_evidence_unavailable`）。今は両方 `0x9703…a9cE`【実測 2系統一致】

### Q6 新 `initialize((address,uint256)[], bytes[])` の引数と、`deployProxy` の calldata
- **引数**【一次】: `grants` は `Grant{address account; uint256 roleBitmap}` の配列で、**すべて root（resource 0）に付く**（`PR.sol:122-124`・`IEACGrantInitializable.sol:5-8`）。`calls` は `multicall(calls)` で自分に delegatecall され、初期化中は `_checkRoles` を飛ばす（`PR.sol:125`・`369-378`・`ARR.sol:95-106`）。キー単位の付与は grants では書けない
- app.ens.dev（HCA 経由）の方針は `grants.length == 2`・`[ (HCA, ALL_ROLES), (owner, ALL_ROLES) ]` を強制（`src/hca/libraries/HCAResolverPolicyLib.sol:139-146@71a3b73`）。一方、新配備で登録された実例 `pandas.eth` のリゾルバ `0xD2A36AeD…6cd2` の root 付与は持ち主1件だけ（block 11717478）【実測・1件だけ】→ 取り直し後の A0 で数え直す
- **自前のリゾルバを作る calldata**（`vet402.eth` 用。W_vet から）:
  ```
  initV = initialize([(W_vet, 0x1111…1111)], [])                                   # selector 0x33cc44a0
  deployProxy(0x14F09Fd05d4585759e54844DC9B00147131Cf243, uint256(keccak256(initV)), initV)   # 0x5d84121a → VerifiableFactory 0x9e726Eb5…41C
  ```
  eth_call の戻り値（予定アドレス）: W_vet → `0xD21Bd8585E3BEbE4d55441dae4C42380a963b7A1`、W_ens（同じ形）→ `0x0e318eD4A6Edbc70d9DE8939082D825a5EcE9ceD`【実測 2系統一致・block 11720074】。salt を変えれば別のアドレス（seller-a 専用と b/c 共有を W_ens から2つ作る）
  - simulate で `deployProxy` → `Upgraded`・`ResolverCreated`・`EACRolesChanged(0, owner, 0→ALL)`・`Initialized(1)`・`ProxyDeployed` の5本【実測 手順01】

---

## 3. 影響箇所の一覧（86か所）

依存の記号: **F**=`findOwner`／**T**=`setText(bytes32)`／**A**=`setAddr`／**K**=`authorizeTextRoles`／**L**=`setAlias`・別名／**C**=`clearRecords`・版／**I**=`initialize`／**E**=旧イベント名／**D**=旧アドレス・旧 commit・旧 interfaceId／**O**=`own-resolver`・HCA の root 剥がし／**N**=旧配備で登録した名前・旧配備の実測値（取り直しで無効）

| # | 行 | 引用（要約） | 依存 | 置き換え |
|---|---|---|---|---|
| P01 | 35 | `findOwner(dns("vet402.eth"))` → `0x0` | F・N | §4.1 |
| P02 | 51 | I9「`authorizeTextRoles` で委任された鍵」・REPRO §1 の `translator.nymspace.eth` | K・N | §4.1 |
| P03 | 91 | 場面「委任鍵で `x402-offer` … `attestations[…]` は `EACUnauthorizedAccountRoles`」 | K | §4.2 |
| P04 | 93 | 場面 clearRecords・`VersionChanged` | C・E | §4.2 |
| P05 | 94 | 場面 別名・`setAlias`・`c-v2.eth` | L | §4.2 |
| P06 | 108 | `LibRegistry.sol:21-45` | D | §4.3 |
| P07 | 109 | EAC「`authorizeTextRoles`」「観測パイプラインの鍵は text だけ」 | K | §4.3 |
| P08 | 110 | 「`clearRecords` が版を上げて記録が消える」 | C | §4.3 |
| P09 | 111 | 「記録の別名」「別名の差し替え」 | L | §4.3 |
| P10 | 152 | manager → `UniversalResolverV2.findOwner(dns(n))` | F | §4.4 |
| P11 | 170 | デプロイ表 `97a57293` | D | §4.4 |
| P12 | 171 | 「Sepolia は `97a57293` のまま」 | D | §4.4 |
| P13 | 172 | UR 実装 `0x4a1817d1…3c70` | D | §4.4 |
| P14 | 173 | `findOwner(bytes)`・`translator.nymspace.eth` | F・N | §4.4 |
| P15 | 174 | `ETHRegistrar 0xa88553f4…a2cc` | D | §4.4 |
| P16 | 175 | wildcard `LibRegistry.sol`・nymspace の実測 | D・N | §4.4 |
| P17 | 176 | `resolve()` と別名（`getAlias`・`PermissionedResolver.sol:508-536`） | L | §4.4 |
| P18 | 177 | `setAlias`・`ROLE_SET_ALIAS`・`AliasChanged` | L・E | §4.4 |
| P19 | 178 | clearRecords・`ROLE_CLEAR`・`VersionChanged` | C・E | §4.4 |
| P20 | 179 | `authorizeTextRoles`・`resource(node, partHash(key))` | K | §4.4 |
| P21 | 180 | topic0 `TextChanged`・`VersionChanged`・`AliasChanged`・`AddressChanged` | E | §4.4 |
| P22 | 182 | viem `getEnsText` の `blockNumber` 【未確認】 | —（確認） | §4.4 |
| P23 | 183 | 告知 "most recent deployment was on July 30" | D | §4.4 |
| P24 | 184 | app.ens.dev の `initialize(e.hca, 0x1111…, [])`・`setAddr(node,60,wallet)` | I・A | §4.4 |
| P25 | 185 | 登録で持ち主が受け取るロール（docs） | D（docs 旧） | §4.4 |
| P26 | 221 | §1.7 デプロイの行 `97a57293…` だけ | D | §4.5 |
| P27 | 223 | §1.7 RPC の行 `findOwner(vet402.eth)`・nymspace・canary block 11600002 `AddressChanged` | F・E・N | §4.5 |
| P28 | 224 | §1.7 名前の状態 `findOwner`・`supportsInterface(0x91413117)`・`own-resolver` | F・D・O | §4.5 |
| P29 | 239 | `ens-since-issuance.ts` の `TextChanged`・`VersionChanged`・`AliasChanged` | E | §4.6 |
| P30 | 243 | `admin.ts` の `own-resolver`・`setAddr`・`setText` の multicall・`authorizeTextRoles`・`setAlias`・`clearRecords` | O・A・T・K・L・C | §4.6 |
| P31 | 359 | `ens_name_unresolved`「`findOwner` が `0x0`」 | F | §4.7 |
| P32 | 360 | `ens_offer_missing`「clearRecords の後を含む」 | C | §4.7 |
| P33 | 385 | §2.5 段2 `UR.findOwner` | F | §4.8 |
| P34 | 386 | §2.5 段3「別名が効く」 | L | §4.8 |
| P35 | 393 | §2.5 段10 `TextChanged(node,…)`・`VersionChanged`・`AliasChanged` | E | §4.8 |
| P36 | 401 | §2.6 `multicall(setText…)` を W_obs | T | §4.9 |
| P37 | 425 | §2.7「K1 の最初に `admin.ts own-resolver`」 | O | §4.10 |
| P38 | 426 | §2.7 W_obs に root `ROLE_SET_TEXT`・census `others` 0 | K | §4.10 |
| P39 | 427 | §2.7 attester の手順 (2)「`findOwner` が `a`」 | F | §4.10 |
| P40 | 452 | §2.9 保護しないもの（`Linked` のつなぎ直しが無い） | L | §4.11 |
| P41 | 496 | T04 `findOwner` が別アドレス | F | §5 |
| P42 | 497 | T05a clearRecords | C | §5 |
| P43 | 499 | T06 別名の差し替え | L | §5 |
| P44 | 507 | T14 `findOwner → 0x0` | F | §5 |
| P45 | 527 | T34 `TextChanged(node,"x402-offer")` | E | §5 |
| P46 | 528 | T35 `findOwner("vet402.eth")` | F | §5 |
| P47 | 573 | B1 判定 `admin.ts --help` の7語 `own-resolver\|…\|clear\|alias-prepare\|alias` | O・C・L | §4.12 |
| P48 | 574 | K1 `own-resolver`・`authorizeTextRoles("x402-offer", W_op)`・census | O・K | §4.12 |
| P49 | 580 | B7 `admin.ts clear`・`alias-prepare`・`alias` | C・L | §4.12 |
| P50 | 597 | TK4-c No のとき「B7 の clear と別名の通しを省いて」 | C・L | §4.12 |
| P51 | 604 | 切り捨て #4 別名 | L | §6 |
| P52 | 605 | 切り捨て #5 clearRecords | C | §6 |
| P53 | 648 | 開示 #2「登録 tx 4件」「別名先 `c-v2.eth` は登録しない」 | N・L | §4.13 |
| P54 | 676 | How it's made `UniversalResolverV2.findOwner`・"record aliases apply" | F・L | §4.14 |
| P55 | 685 | ENS 欄 "clearRecords and alias swaps" | C・L | §4.14 |
| P56 | 688 | feedback 候補（新配備で見つけた点が無い） | —（追加） | §4.14 |
| P57 | 720 | Q2 "is UniversalResolverV2.findOwner the right 'current manager'" | F | §4.15 |
| P58 | 726 | Q2 表「findOwner で読んだと開示」 | F | §4.15 |
| P59 | 729 | Q3 "record aliases apply"・"resolver event model" | L・E | §4.15 |
| P60 | 735 | Q3 表「別名はリゾルバを直接読むべき」 | L | §4.15 |
| P61 | 756 | TK3「別名先の `c-v2.eth` は登録しない」 | L・N | §4.16 |
| P62 | 770 | 件数の注「`admin.ts own-resolver` に置き換えた」 | O | §4.16 |
| P63 | 775 | A0「`own-resolver` の要否を決める」 | O | §4.16 |
| P64 | 777 | A2「`findOwner(dns("vet402.eth"))` が W_vet のままか」 | F | §4.16 |
| P65 | 778 | A3 `findOwner`・canary の getLogs | F・E | §4.16 |
| P66 | 782 | A7 `initialize(owner, ALL_ROLES, [])`・`setAddr`・`setText`・`authorizeTextRoles`・`setAlias`・`clearRecords` | I・A・T・K・L・C | §4.16・§8 |
| P67 | 784 | A9 発注文「`own-resolver` を含む」「別名の順」 | O・L | §4.16 |
| P68 | 799 | 付録 8-A 手順5（app.ens.dev の画面の流れは旧配備のコードから推定） | D | §4.17 |
| P69 | 805 | A0 表 持ち主 `UniversalResolverV2.findOwner` | F | §4.17 |
| P70 | 806 | A0 表 `supportsInterface(0x91413117)` | D | §4.17 |
| P71 | 807 | A0 表 `getAssigneeCount(0, ROLE_SET_ADDR \| ROLE_SET_TEXT)`・HCA の root | O（名前は `ROLE_SET_ADDRESS` に。ビットは同じ `1<<0`） | §4.17 |
| P72 | 809 | A0 表 既定の addr「登録コードが `setAddr(node, 60, wallet)`」 | A | §4.17 |
| P73 | 811 | A0 表「A2 で `findOwner` を毎朝」 | F | §4.17 |
| P74 | 820 | R2「デプロイ表の SHA が `97a57293` でない」 | D | §4.18 |
| P75 | 823 | §9 補足「A2 が毎朝 `findOwner`」「root がスマートアカウント…`own-resolver` で差し替える」 | F・O | §4.18 |
| P76 | 891 | 追記 A0 `findOwner` = W_vet・リゾルバ `0xf8E7…6Bfc`・`supportsInterface(0x91413117)` | F・D・N | §4.19 |
| P77 | 892-893 | 追記 A0 HCA `0x7070…ADA3`・「`revokeRootRoles` で外す」 | O・N | §4.19 |
| P78 | 903-905 | 追記 A6 共有リゾルバ `0xea77…Be91`・「alias は…このまま使える」「`clearRecords` の範囲と `VersionChanged`」 | N・L・C・E | §4.19 |
| P79 | 936 | 気づき帳の例「clearRecords の版上げをキーごとの TextChanged で見落とす」 | C・E | §4.19 |
| P80 | 989 | R2 節「`authorizeTextRoles` は `grantSetterRoles(setter の呼び出しデータ, account)`」 | K（言い換えは正しい） | §4.19 |
| P81 | 990 | R2 節「**キー単位より細かい委任**を見せられる（EAC の見せ場が強くなる）」 | K（**誤り**） | §4.19 |
| C01 | CONCEPT 21 | 「検証エージェントには判定キーだけ委任（`authorizeTextRoles`）」 | K | §4.20 |
| C02 | CONCEPT 22 | 「`TextChanged`（値つき）・`TransferSingle`・`TokenRegenerated`・`EACRolesChanged`」 | E | §4.20 |
| C03 | CONCEPT 37 | 「リゾルバ差し替え・alias・clearRecords・アップグレード」 | L・C | §4.20 |
| C04 | CONCEPT 70 | v4 の変更4「`clearRecords()` は記録の版を上げる方式…alias の差し替えと版の上昇でも REFUSE…`authorizeTextRoles`」 | C・L・K | §4.20 |
| C05 | CONCEPT 76 | 置き換え後のデモ3「続けて clearRecords／alias の差し替えでも REFUSE」 | C・L | §4.20 |

計画書の外で同じ依存を持つもの（数に入れない・書き換えは各担当）: `tokyo-2026/a7/a7_dryrun.mjs`（旧 ABI の 12 本）／`~/hackathon-monitor/ens-names.mjs`（R2 節で書き換え済みとある）／REPRO.md §1（nymspace の再現は旧配備）。

---

## 4. 節ごとの置き換え案（旧 → 新）

### 4.1 前置き・改善提案
**P01（L35）** 旧: 「`findOwner(dns("vet402.eth"))` → `0x0`」
→ 新（文末に追記）: 「※ 09-14 の値は 07-30 配備のもの。09-15 の配備し直しで `vet402.eth` は再び空き（`isAvailable` true・`getState` status 0・`UniversalHelper.findExactOwner` 0x0【実測 2系統一致・block 11720074】）」

**P02（L51・I9）** 旧: 「約束のキーだけを `authorizeTextRoles` で委任された鍵…他人の既存の付与（`translator.nymspace.eth`）への eth_call／estimateGas で再現」
→ 新: 「**売り手 seller-a.eth 専用の PermissionedResolver** の上で `grantSetterRoles(setText(dns("seller-a.eth"),"x402-offer",""), W_op)` で委任された鍵。委任はリゾルバ単位のキー（名前は含まない・`PR.sol:307-338`）なので、名前を1つに絞るためにリゾルバを分ける。委任キーは成功・他キーは `EACUnauthorizedAccountRoles`・他の売り手のリゾルバでも revert を、09-17 に `eth_simulateV1` で再現【実測・simulate】。自分の名前では K1 の census で確かめる」

### 4.2 §0 デモ台本（場面3）
**P03（L91）** 旧: 「売り手サーバーの委任鍵で `x402-offer` の `"amount":"10000"` → `"10001"`（Sepolia tx 1ブロック）。同じ鍵で `attestations[…]` を書く eth_call は `EACUnauthorizedAccountRoles`」
→ 新: 「売り手サーバーの委任鍵 W_op で `P_a.setText(dns("seller-a.eth"), "x402-offer", …"10001"…)`（Sepolia tx 1ブロック）。同じ鍵で `attestations[x402-offer][atst.vet402.eth]` を書く eth_call は `EACUnauthorizedAccountRoles(keccak256(key), 0x10, W_op)`、`seller-b.eth` の約束を書く eth_call も revert（別のリゾルバ）」
声: 旧 "The seller's server key can edit the promise. It cannot touch the attestation." → 新 "The seller's server key can edit this one promise. Not the attestation, and not another seller's promise."

**P04（L93）** 旧:
`| 175–195 | clearRecords | seller-b.eth の持ち主が clearRecords（VersionChanged）→ REFUSE ens_offer_missing | "Clearing the records bumps the resolver version. Same answer." |`
→ 新:
`| 175–195 | 記録の切り離し | seller-b.eth の持ち主が P_bc.linkToRecord(dns("seller-b.eth"), 0)（Linked(0, node)・TextUpdated は 0 本）→ REFUSE ens_offer_missing | "Unlinking the name from its record empties every key at once, and no text event fires. Same answer." |`

**P05（L94）** 旧:
`| 195–215 | 別名の差し替え | 前もって seller-c.eth の持ち主が…namehash(c-v2.eth)…に別の約束と envelope の写しを書いておき、ここで setAlias(seller-c.eth → c-v2.eth) → REFUSE ens_attestation_signer_mismatch | "Point the name at a copy with a different promise. The copy does not validate." |`
→ 新:
`| 195–215 | 他の名前の記録につなぐ | seller-c.eth の持ち主が P_bc.linkToRecord(dns("seller-c.eth"), R_b)（R_b＝seller-b の記録 ID。直前に seller-b を戻しておく）→ /tokyo に seller-c.eth の約束と envelope が seller-b.eth とバイト単位で同じと表示 → REFUSE ens_attestation_signer_mismatch | "Now seller-c shows seller-b's promise and attestation, byte for byte. The attestation is bound to the name, so it still refuses." |`
- 前もっての書き込み（`alias-prepare`）が不要になる。戻すのは `linkToRecord(seller-c, R_c)` の1 tx で、証明の置き直しは要らない
- 順番の罠: seller-b を切り離したまま `linkToNode(seller-c, namehash(seller-b))` を打つと `InvalidRecord`（箱の無い node へはつなげない）【実測 手順31 と同じ条件】→ **ID 指定の `linkToRecord` を使う**

### 4.3 §0 賞の条件との対応
- **P06（L108）** 旧: 「`LibRegistry.sol:21-45`」→ 新: 「`LibResolution.sol:58-85`（`findUnvalidatedResolver`・@d9affea0）」
- **P07（L109）** 旧: 「売り手のサーバー鍵には `x402-offer` だけを委任（`authorizeTextRoles`）。観測パイプラインの鍵は text だけ、attester のアドレス記録は持ち主だけ」 → 新: 「売り手のサーバー鍵には、その売り手だけに使うリゾルバの上で `x402-offer` キーだけを委任（`grantSetterRoles`）。観測パイプラインの鍵は観測ログの 15 キーだけ（キーごとの `grantSetterRoles`）、attester のアドレス記録（`setAddress`）は持ち主だけ」｜確かめ方: 旧「`roles()` の表示と…」→ 新「`roles(keccak256("x402-offer"), W_op) = 0x10`・`roleCount(keccak256(attestations[…])) = 0`・`ResourceArgument` のログと `EACUnauthorizedAccountRoles` の eth_call」
- **P08（L110）** 旧: 「Permissioned Resolver｜`clearRecords` が版を上げて記録が消える → 失効｜場面3 clearRecords」 → 新: 「Permissioned Resolver｜記録は ID つきの箱で、名前は箱を指すだけ。`linkToRecord(name, 0)` で全キーが一度に消える → 失効｜場面3 切り離し」
- **P09（L111）** 旧: 「記録の別名｜別名の差し替えでも失効（Universal Resolver 経由で読む）｜場面3 alias」 → 新: 「記録のつなぎ（linked records）｜他の名前の証明つきの箱にそのままつないでも失効（Universal Resolver 経由で読む）｜場面3 つなぎ」

### 4.4 §1 外部の事実（ENSIP-29 の解釈と §1.3）
- **P10（L152）** 旧: 「ENSv2 での「manager」（→ `UniversalResolverV2.findOwner(dns(n))`）」 → 新: 「（→ `UniversalHelper.findExactOwner(dns(n))`。`findNearestOwner` は使わない）」
- **P11（L170）** 旧行を置換: `| 配備の同定 | 09-15 配備。contracts-v2 の d9affea0 から（commit 5fb88dc の本文）。docs.ens.domains の表は 97a57293 のまま（古い） | 【一次】5fb88dc・07690a9・71a3b73／【実測】UR.ROOT_REGISTRY()・UH.ROOT_REGISTRY() = 0x9703…a9cE、Root.getSubregistry("eth") = 0x657e…E09E（2系統一致・block 11720074） |`
- **P12（L171）** 旧: 「Sepolia は `97a57293` のまま…→ §9 R2」 → 新: 「09-15 に #354（"inodes w/o versioning"）を含む一式へ配備し直し済み（R2 発生）。前回からの間隔 34・32・46日【実測】」
- **P13（L172）** 旧: 「実装 UniversalResolverV2 `0x4a1817d1…3c70`」 → 新: 「中継 ManagedUniversalResolverProxy `0x6d80F217…42e6F1`・実装 UniversalResolverV2 `0x5d25C1D6…03e3`（09-15 13:36Z から）。持ち主の読み取りは UniversalHelper `0x33f571aa…7df5`」
- **P14（L173）** 旧: 「`findOwner(bytes name) returns (address)`（UR V2 ABI）。`translator.nymspace.eth` → …、`vet402.eth` → `0x0`」 → 新: 「`UniversalHelper.findExactOwner(bytes name) returns (address)`（`UH.sol:39-41`）。完全一致の持ち主だけ、期限切れ・RESERVED・未登録のサブ名は 0。`ens.eth` は RESERVED なので 0、`findNearestOwner` は `(0x84D3…39D3, 4)`【実測 2系統一致】。`nymspace.eth` は新配備に無い」
- **P15（L174）** 旧: 「`ETHRegistrar 0xa88553f4…a2cc`…」 → 新: 「`ETHRegistrar 0xAbe76F6C…94ca` の `isAvailable`: `vet402`・`seller-a`・`seller-b`・`seller-c` とも true【実測 2系統一致・block 11720074】」
- **P16（L175）** 旧: 「【一次】`LibRegistry.sol:21-45@97a57293`／【実測】nymspace の未登録サブ名…」 → 新: 「【一次】`LibResolution.sol:58-85@d9affea0`（`getResolver` が 0 でなければ覚え、node は常に更新）／`PermissionedResolver.sol:381-387`（箱の無い node は既定の箱）【実測・simulate】`yy.pandas.eth` の `x402-offer` は `""`（親の値は漏れない）・`zz.pandas.eth` に書けばその箱ができる」
- **P17（L176）** 旧の「`resolve()` と別名」行を置換: `| resolve() とつなぎ | 読み取りは resolve(name, data) だけ（data の node は無視、name の namehash で箱を引く）。名前は _recordIds[node] で箱 ID を指し、箱 0 なら既定の箱（ARR.sol:110-159・PR.sol:94-100・381-387）。linkToNode/linkToRecord で2つの名前が同じ箱を共有し、どちらから書いても両方変わる | 【一次】／【実測・simulate】手順19-23 |`
- **P18（L177）** 旧「別名の設定」行を置換: `| つなぎの設定 | linkToNode(bytes, bytes32)・linkToRecord(bytes, uint256)（0 は切り離し）。root の ROLE_LINK（1<<28）だけ。箱の無い node へは InvalidRecord。イベント Linked(recordId, node, name) | PR.sol:231-251・Lib.sol:48／【実測・simulate】手順13・31 |`
- **P19（L178）** 旧「clearRecords」行を置換: `| 一括で消す | clearRecords と版は廃止（#354）。代わりは linkToRecord(name, 0)（全キーが空・TextUpdated は出ない）。元の箱 ID につなぎ直すと全部戻る。Cleared(uint256) は ABI にあるが emit されない | PR.sol:243-251・IRR.sol:40-42／【実測・simulate】手順26-30 |`
- **P20（L179）** 旧「キー単位の委任」行を置換: `| キーの委任 | grantSetterRoles(bytes setter, address account)（0xccd3eaff）。setter の呼び出しデータからセレクタとキーだけを読み、resource = keccak256(key)。名前は読まない → そのリゾルバ上の全ての名前に効く。取り消しは revokeRoles(keccak256(key), ROLE_SET_TEXT, account)。grantRoles は常に revert | PR.sol:254-261・297-338・Lib.sol:68-70／ENS のテスト PermissionedResolver.t.sol:912-927／【実測・simulate】手順06-12・32-34 |`
- **P21（L180）** 旧 topic0 の行を §1.3 の表で置換（`TextUpdated 0x14cf4389…`・`Linked 0x66fd1d4e…`・`AddressUpdated 0x5856fffa…`・`ResourceArgument 0x92e004ab…`・`EACRolesChanged`/`Upgraded`/`ResolverUpdated` は同じ）。注に「記録のイベントは node ではなく recordId に付く」
- **P22（L182）** 【未確認】を解消: 「viem 2.55.1 の `sepolia.contracts.ensUniversalResolver` は `0xeeee…eeee` のまま。`getEnsAddress`・`getEnsText`・`getEnsResolver` に `blockNumber: 11720074n` を渡して、新配備の `pandas.eth` で2系統とも例外なく返る（resolver `0xD2A3…6cd2`・addr/text は null）【実測】。値ありの読み取りは K1 後に確かめる」
- **P23（L183）** 旧: 「"The most recent deployment was on July 30, 2026."」 → 新: 「09-15 に配備し直し（R2）。告知の日付は 09-24 に取り直す【未確認】」
- **P24（L184）** 旧: 「`initialize(e.hca, 0x1111…1111, [])`…`setAddr(node, 60, wallet)`」 → 新: 「新しい app.ens.dev は HCA の方針で `initialize([(HCA, ALL), (owner, ALL)], calls)` を強制（`HCAResolverPolicyLib.sol:139-146@71a3b73`）。ただし新配備で登録された `pandas.eth` のリゾルバの root 付与は持ち主の1件だけで、addr の記録も無かった【実測・1件】→ 取り直し後の A0 で数える」
- **P25（L185）** 注を足す: 「docs は 07-30 のまま。取り直し後に `ETHRegistry.roles(getState(labelhash).resource, owner)` で実測する」

### 4.5 §1.7 会期初日に取り直す一覧
- **P26（L221）** 旧: `| デプロイ | curl …docs.ens.domains/learn/deployments … | 97a57293… だけ | §9 R2 |`
  → 新: `| 配備 | node $DEMO/src/probe-rpc.ts --deployment | 2系統・同じブロックで UR.ROOT_REGISTRY() = UH.ROOT_REGISTRY() = 0x9703DBD2…a9cE・Root.getSubregistry("eth") = 0x657eA849…E09E・PermissionedResolverImpl 0x14F09Fd0…F243 の supportsInterface(0x8c2427cc) = true | §9 R2（配備し直し）。docs の SHA は参考として打つが止めない |`
- **P27（L223）** 旧: 「同じブロックでの `findOwner(vet402.eth)`・`getEnsText(translator.nymspace.eth, agent-endpoint[mcp])` が一致・canary（block 11600002 の `AddressChanged`）が両方に含まれる」
  → 新: 「同じブロックでの `UH.findExactOwner(dns("vet402.eth"))`・`getEnsResolver("vet402.eth")`・`getEnsAddress("vet402.eth")` が一致・canary（**block 11717398 の ETHRegistry `LabelRegistered`（label `pandas`）**。K1 の後は自分の `grantSetterRoles` tx の `ResourceArgument`）が両方に含まれる」
- **P28（L224）** 旧: 「`findOwner` が W_vet／W_ens・リゾルバが `supportsInterface(0x91413117)` true・リゾルバの root 保持者を記録（…K1 の `own-resolver` の後に持ち主だけ）」
  → 新: 「`findExactOwner` が W_vet／W_ens・`ETHRegistry.getState(labelhash)` が status 2 で `latestOwner` 一致・リゾルバが `supportsInterface(0x8c2427cc)` true・リゾルバの root 保持者（`EACRolesChanged` resource 0 の履歴）を記録（会期前は app.ens.dev のリゾルバ。K1 の後は `vet402.eth` の保持者が W_vet だけ、`seller-a.eth` は P_a で W_ens だけ、`seller-b/c.eth` は P_bc で W_ens だけ）」

### 4.6 §2.1 モジュール構成
- **P29（L239）** 旧: 「`t` から今までの `TextChanged`・`VersionChanged`・`AliasChanged`・`ResolverUpdated`・`TransferSingle` の走査」 → 新: 「`t` から今までの、リゾルバの `Linked`（node で絞る）・`TextUpdated`（recordId と keyHash で絞る）・`Upgraded`、登録簿の `ResolverUpdated`・`TransferSingle`・`TokenRegenerated`・`LabelUnregistered` の走査（§2.5 段10）」
- **P30（L243）** 旧: 「`admin.ts`（持ち主の書き込み: `own-resolver`（…`VerifiableFactory.deployProxy` で作り `ETHRegistry.setResolver`）・`grantRootRoles`・`setAddr`・`setText` の multicall・`authorizeTextRoles`・`setAlias`・`clearRecords`・ETH/USDC の送金。…）」
  → 新: 「`admin.ts`（持ち主の書き込み: `deploy-resolvers`（`VerifiableFactory.deployProxy(impl, salt, initialize([(owner, ALL_ROLES)], calls))` で `P_a`（seller-a 専用）・`P_bc`（seller-b/c 共有）・必要なら `P_vet` を作り `ETHRegistry.setResolver`）・`setAddress(dns(name), 60, addr)`・`setText(dns(name), key, value)` の multicall・`grantSetterRoles(setText(dns(name), key, ""), account)`（W_op に1キー、W_obs に 15 キーを multicall）・`unlink`（`linkToRecord(dns(name), 0)`）・`link`（`linkToRecord(dns(name), <相手の recordId>)`）・`relink`（census で控えた元の recordId に戻す）・`revokeRootRoles`（census で持ち主以外の root が見つかった時だけ）・ETH/USDC の送金。**`--dry-run` は同じ calldata を持ち主から eth_call、連続する手順は `eth_simulateV1`（sentio）で通す**）」

### 4.7 §2.4 拒否理由コード
- **P31（L359）** 旧: 「`findOwner` が `0x0`（未登録・期限切れ・登録していない wildcard のサブ名）」 → 新: 「`UniversalHelper.findExactOwner` が `0x0`（未登録・期限切れ・RESERVED・登録していない wildcard のサブ名）」
- **P32（L360）** 旧: 「`x402-offer` が空（clearRecords の後を含む）」 → 新: 「`x402-offer` が空（`linkToRecord(name, 0)` の後・リゾルバの差し替え後を含む）」

### 4.8 §2.5 検証手順
- **P33（L385）** 旧: 「**草案 2**: `a = UR.findOwner(dns(normalize(n)))`（1.3）。`0x0` → `ens_name_unresolved`」
  → 新: 「**草案 2**: `a = UniversalHelper.findExactOwner(dns(normalize(n)))`（1.3）。同じブロックで `UH.ROOT_REGISTRY() == UR.ROOT_REGISTRY()` でなければ `ens_evidence_unavailable`。`0x0` → `ens_name_unresolved`。`n` が `.eth` の2LD なら `ETHRegistry.getState(labelhash).status == 2 && latestOwner == a` も照合し、違えば `ens_evidence_unavailable`（`findNearestOwner` は使わない）」
- **P34（L386）** 旧: 「（Universal Resolver 経由なので別名が効く＝他の読者と同じ値）」 → 新: 「（Universal Resolver の `resolve` 経由なので、つながった箱の値が返る＝他の読者と同じ値。リゾルバの直の view は無い）」
- **P35（L393）** 旧: 「売り手のリゾルバの `TextChanged(node, k)`・`TextChanged(node, attestationKey)`・`VersionChanged(node)`・`AliasChanged`（node を問わず）と ETHRegistry の `ResolverUpdated`・`TransferSingle`」
  → 新: 「(a) 売り手のリゾルバ R で `getRecordId(node)` を `t` のブロックと `B` で読み、違えば変更あり (b) R の `Linked` を topic2 = node で読み、1本でもあれば変更あり (c) R の `TextUpdated` を topic1 ∈ {(a) の recordId}・topic2 ∈ {`keccak256(k)`, `keccak256(attestationKey)`} で読む (d) R の `Upgraded` (e) ETHRegistry の `ResolverUpdated`（`t` と `B` の tokenId の両方）・`TransferSingle`・`TokenRegenerated`・`LabelUnregistered`。1000 ブロックずつ2系統＋canary」

### 4.9 §2.6 観測ログ
- **P36（L401）** 旧: 「node = `namehash("<resourceId 64桁>.obs.vet402.eth")`（登録しない・wildcard）。`vet402.eth` のリゾルバへ `multicall(setText…)` を W_obs で1 tx」
  → 新: 「名前 = `dns("<resourceId 64桁>.obs.vet402.eth")`（登録しない・wildcard。setter は DNS 形式の名前を取る）。`vet402.eth` のリゾルバへ `multicall(setText(dns(name), key, value)…)` を W_obs で1 tx（W_obs は §2.7 の 15 キーだけを委任されている）」

### 4.10 §2.7 鍵の扱い
- **P37（L425）** 旧: 「**K1 の最初に `admin.ts own-resolver` で、持ち主が root を持つリゾルバに差し替える**（app.ens.dev の登録ではリゾルバの root がスマートアカウントになる・§1.3）」
  → 新: 「**K1 の最初に `admin.ts deploy-resolvers`**: W_ens は `P_a`（seller-a 専用・委任先）と `P_bc`（seller-b/c 共有・つなぎの場面）を作って向ける。W_vet は取り直し後の census で root が W_vet だけなら app.ens.dev のリゾルバのまま、他の保持者がいれば `revokeRootRoles(ALL_ROLES, 他者)`（1 tx）」
- **P38（L426）** 旧: 「W_obs には root の `ROLE_SET_TEXT` だけを付ける（addr を書けない）→ …§1.7 の census で `others` 0 を判定にする」
  → 新: 「W_obs には観測ログの 15 キー（`class`・`description`・`x402.resource`・`x402.method`・`x402.l2`・`x402.declaration-sha256`・`x402.response-sha256`・`x402.purchase`・`x402.purchase-block`・`x402.observed-at`・`x402.source`・`x402.rerun`・`x402.pipeline-commit`・`x402.attested-name`・`x402.attested-t`）を `grantSetterRoles` で1つずつ（multicall で1 tx）。addr は書けない（`setAddress` は `EACUnauthorizedAccountRoles`【実測・simulate sim2 A5】）→ パイプラインの鍵が漏れても attester は乗っ取れない。**ただし委任はリゾルバ単位なので、W_obs は `vet402.eth`・`atst.vet402.eth` の同じ 15 キー（`description` など）も書ける**【実測 sim2 A6】（開示）。census の判定: `hasRoles(0, ROLE_SET_ADDRESS, W_obs)` false・`roles(0, W_obs)` 0・root 保持者は W_vet だけ」
- **P39（L427）** 旧: 「(2) `findOwner` が `a`」 → 新: 「(2) `UniversalHelper.findExactOwner(dns(n))` が `a`」

### 4.11 §2.9 保護しないもの
- **P40（L452）** 足す: 「／持ち主が `linkToRecord` で元の箱につなぎ直した時（証明は再び有効になる。「変えて戻す」と同じ種類で、補助の走査の `Linked` で見つける）」

### 4.12 §4 時間割
- **P47（L573・B1 の判定）** 旧: `grep -cE '^  (own-resolver|k1a|k1b|publish-attestations|clear|alias-prepare|alias)'` → `7`
  → 新: `grep -cE '^  (deploy-resolvers|k1a|k1b|publish-attestations|unlink|link|relink)'` → `7`
- **P48（L574・K1）** 旧: 「`admin.ts own-resolver --dry-run` → `--live`（W_vet と W_ens がそれぞれ自分が root を持つ PermissionedResolver を作り `setResolver`…）→ `admin.ts k1a --live`（`atst.vet402.eth` の addr＝K_atst・W_obs に root `ROLE_SET_TEXT`・ETH 送金）→ `admin.ts k1b --live`（…`seller-a/b/c.eth` の約束と `authorizeTextRoles("x402-offer", W_op)`）」／判定「各リゾルバの root 保持者が持ち主だけ（`others` 0）…W_op で `attestations[…]` を書く eth_call が `EACUnauthorizedAccountRoles`」
  → 新: 「`admin.ts deploy-resolvers --dry-run`（eth_simulateV1）→ `--live`（W_ens: `deployProxy` ×2＝P_a・P_bc、初期化の calls で3名の `x402-offer`・`agent-endpoint[x402]`・`setAddress(60)` を置く → `setResolver` ×3。W_vet: census で他の root があれば `revokeRootRoles`）→ `admin.ts k1a --live`（W_vet: `setAddress(dns("atst.vet402.eth"), 60, K_atst)`・W_obs へ 15 キーの `grantSetterRoles`（multicall）・ETH 送金）→ `admin.ts k1b --live`（W_pay への USDC/ETH・`SEED_TX`・W_ens: `P_a.grantSetterRoles(setText(dns("seller-a.eth"),"x402-offer",""), W_op)`）」
  判定（新）: 「`run.ts census …` → `vet402.eth` の root 保持者が W_vet だけ・P_a と P_bc の root 保持者が W_ens だけ・`P_a.roles(keccak256("x402-offer"), W_op)` = `0x10`・`P_bc.roleCount(keccak256("x402-offer"))` = 0・3名の `getRecordId` が 0 でなく互いに違う（R_a・R_b・R_c を控える）・`atst.vet402.eth → <K_atst>`・3名の `x402-offer` が2系統一致・W_op で `attestations[…]` を書く eth_call が `EACUnauthorizedAccountRoles`・W_op で `P_bc.setText(dns("seller-b.eth"),"x402-offer",…)` の eth_call も revert」。人の時間は +0 〜 +0.25h（tx が 3〜4 本増える）【推定】
- **P49（L580・B7）** 旧: 「`admin.ts clear seller-b.eth --live` → `pay` → `reset seller-b.eth`／`admin.ts alias-prepare seller-c.eth --to c-v2.eth --live` → `admin.ts alias seller-c.eth --to c-v2.eth --live` → `pay` → `admin.ts alias seller-c.eth --clear --live`」／判定「clear の後 `ens_offer_missing`／別名の後 `ens_attestation_signer_mismatch`」
  → 新: 「`admin.ts unlink seller-b.eth --live` → `pay seller-b.eth` → `admin.ts relink seller-b.eth --live`／`admin.ts link seller-c.eth --to-record-of seller-b.eth --live`（`linkToRecord(dns("seller-c.eth"), R_b)`）→ `pay seller-c.eth` → `admin.ts relink seller-c.eth --live`（`linkToRecord(…, R_c)`）」／判定「切り離しの後 `ens_offer_missing`／つないだ後 `ens_attestation_signer_mismatch` かつ `/api/tokyo/verify?name=seller-c.eth` の `offerRaw` が seller-b と一致／relink の後 `run.ts verify` で3名 `VALID`（**証明の置き直し無し**）」
- **P50（L597）** 旧: 「B7 の clear と別名の通しを省いて」 → 新: 「B7 の unlink と link の通しを省いて」

### 4.13 §5.5 開示
- **P53（L648）** 旧: 「`vet402.eth`・`seller-a/b/c.eth`（仮）の登録 tx 4件。…（別名先 `c-v2.eth` は登録しない）」 → 新: 「09-15 の ENS の配備し直しで 07-30 配備の登録は無効になり、09-1X に取り直した登録 tx 4件（旧配備の4件も併記）。記録・権限・リゾルバの作成・つなぎ・証明・Base Sepolia の受領はすべて会期中に作ること」

### 4.14 §6 提出物
- **P54（L676）** 旧: "It reads the manager with UniversalResolverV2.findOwner, reads x402-offer and the attestation through the Universal Resolver (so record aliases apply), …"
  → 新: "It reads the manager with UniversalHelper.findExactOwner, reads x402-offer and the attestation through the Universal Resolver (so linked records apply), …"
- **P55（L685）** 旧: "Enhanced Access Control lets the seller's server key edit only the offer. clearRecords and alias swaps invalidate it the same way a one-character edit does."
  → 新: "Enhanced Access Control lets the seller's server key call setText only for the x402-offer key, on a resolver that serves only that seller. Unlinking the name from its record, or linking it to another name's attested record, invalidates it the same way a one-character edit does."
- **P56（L688）** feedback 候補に足す（会期中に実際に踏んだら書く）: (a) 09-15 の配備し直しの後も docs.ens.domains/ensv2 が 07-30 の ABI（`setAlias`・`authorizeTextRoles`・`findOwner`）を載せている (b) `grantSetterRoles` が setter の名前を読まないので、app.ens.dev のように持ち主ごとに1つのリゾルバを使い回すと、サーバー鍵への1キーの委任が持ち主の全ての名前に効く（docs での明記の提案） (c) `Cleared(uint256)` が ABI にあるが emit されない (d) `TextUpdated` が recordId に付くので、node で監視する索引は `Linked` を追う必要がある (e) `ens.eth` のような RESERVED の名前で `findExactOwner` と `findNearestOwner` が違う値を返す。**送るのは提出後・オーナー承認の後**（09-17 07:5x 追記どおり）

### 4.15 §7 ENS メンターへの問い
- **P57（L720）** 旧: "And on ENSv2, is UniversalResolverV2.findOwner the right 'current manager' for step 2, with the address encoded as 20 raw bytes?"
  → 新: "And on ENSv2 after the September 15 redeploy, is UniversalHelper.findExactOwner the right 'current manager' for step 2 (rather than findNearestOwner), with the address encoded as 20 raw bytes?"
- **P58（L726）** 旧: 「間に合わなければ「findOwner で読んだ」と開示」 → 新: 「間に合わなければ「findExactOwner で読んだ」と開示」
- **P59（L729）** 旧: "vet402 reads attestations through the Universal Resolver, so record aliases apply, … Will the Sepolia deployment or the resolver event model change before Sunday's judging? Is reading through the Universal Resolver the intended way to validate an attestation on an aliased name?"
  → 新: "vet402 reads attestations through the Universal Resolver, so linked records apply, and it pins one block across two RPCs. The Sepolia contracts were redeployed on September 15. Will they change again before Sunday's judging? And is reading through the Universal Resolver the intended way to validate an attestation on a name that is linked to another record?"
- **P60（L735）** 旧: 「別名はリゾルバを直接読むべき｜場面3の別名を切り捨て #4 で落とし…」 → 新: 「つながった名前はリゾルバを直接読むべき｜場面3のつなぎを切り捨て #4 で落とし、`/tokyo` に `getRecordId` と UR の値を並べて違いを見せる」／「変更が来る」の行: 旧「デプロイ表の SHA を1時間ごとに取り直す」→ 新「`UR.ROOT_REGISTRY()` と impl のアドレスを1時間ごとに読む」

### 4.16 §8 会期前の準備
- **P61（L756・TK3）** 旧: 「`vet402.eth` は 09-14 時点で空いている…別名先の `c-v2.eth` は登録しない」 → 新: 「09-15 の配備し直しで4名とも空き【実測 09-17】。**取り直す**（手番リスト #6）。記録は会期中に置く（事前作業は登録だけ）」
- **P62（L770）** 旧: 「K1 で持ち主が自分のリゾルバに差し替える手順（`admin.ts own-resolver`）に置き換えた」 → 新: 「K1 の `admin.ts deploy-resolvers`（売り手は専用・共有の2つを作る。vet402.eth は census の結果で決める）に置き換えた」
- **P63（L775・A0）** 旧: 「`own-resolver` の要否を決める」 → 新: 「**取り直しの直後にやり直す**。`vet402.eth` のリゾルバの root 保持者から `revokeRootRoles` の要否を決める（売り手の側は K1 で自前のリゾルバを作るので要否に関係しない）」
- **P64（L777・A2）** 旧: 「**`findOwner(dns("vet402.eth"))` が W_vet のままか**」 → 新: 「**`UniversalHelper.findExactOwner(dns("vet402.eth"))` が W_vet のままか・`UR.ROOT_REGISTRY()` が `0x9703…a9cE` のままか**」
- **P65（L778・A3）** 旧: 「同じブロックに固定した `findOwner`・`getEnsText`・`getEnsAddress` と canary の getLogs を各 20 回」 → 新: 「（09-17 に旧関数で 20/20 済み）新しい関数で5回だけ取り直す: 同じブロックの `findExactOwner`・`getEnsResolver`・`getEnsAddress`・新 canary（block 11717398 `LabelRegistered`）の getLogs」
- **P66（L782・A7）** 旧の8関数を §8 の練習項目 E1〜E14 に置き換え。判定: 旧「8関数とも eth_call 成功」→ 新「E1〜E14 の期待どおり（成功と revert の両方）」
- **P67（L784・A9）** 旧: 「`keys.ts`/`admin.ts`（`own-resolver` を含む）は B1…別名の順」 → 新: 「`keys.ts`/`admin.ts`（`deploy-resolvers`・`unlink`・`link`・`relink` を含む）は B1…つなぎの順（`linkToRecord` を ID 指定で・seller-b を戻してから seller-c をつなぐ）・**`grantSetterRoles` を `initialize` の calls に入れない**・setter は DNS 形式の名前・読み取りは `resolve` 経由」

### 4.17 付録 8-A
- **P68（L799）** 注を足す: 「この手順表は 07-30 配備の app.ens.dev のコードから推定した。09-15 以降の app の画面は【未確認】。取り直しの時に違えば文言をそのまま伝える」
- **P69（L805）** 旧: 「`UniversalResolverV2.findOwner(dns("vet402.eth"))`」 → 新: 「`UniversalHelper.findExactOwner(dns("vet402.eth"))` と `ETHRegistry.getState(labelhash("vet402"))`（status 2・`latestOwner`）」
- **P70（L806）** 旧: 「`supportsInterface(0x91413117)`」 → 新: 「`supportsInterface(0x8c2427cc)`」
- **P71（L807）** 旧: 「`getAssigneeCount(0, ROLE_SET_ADDR | ROLE_SET_TEXT)`…root はスマートアカウント（HCA）が持ち…`own-resolver` を必須にする」 → 新: 「`getAssigneeCount(0, ROLE_SET_ADDRESS | ROLE_SET_TEXT)`・`isOnlyAssignee(0, ROLE_SET_TEXT, W_vet)`。HCA の方針は root を HCA と持ち主の2者に付ける形（`HCAResolverPolicyLib.sol:139-146`）、新配備の実例 `pandas.eth` は持ち主1者だけ【実測・1件】。2者なら K1 で `revokeRootRoles(ALL_ROLES, HCA)`」
- **P72（L809）** 旧: 「W_vet（登録コードが `setAddr(node, 60, wallet)` を入れている【一次】）」 → 新: 「W_vet の見込み【未確認】（新配備の `pandas.eth` は addr が null だった【実測・1件】）。無ければ K1 で `setAddress(dns("vet402.eth"), 60, W_vet)`」
- **P73（L811）** 旧: 「A2 で `findOwner` を毎朝読む」 → 新: 「A2 で `findExactOwner` と `UR.ROOT_REGISTRY()` を毎朝読む」

### 4.18 §9 リスク
- **P74（L820・R2）** 旧の兆候「デプロイ表の SHA が `97a57293` でない」・見るもの「`curl …/learn/deployments …`」・出たら「SHA が変わったら ABI とアドレスを取り直す」
  → 新: 兆候「`UR.ROOT_REGISTRY()` が `0x9703…a9cE` でない・impl `0x14F0…F243` の `supportsInterface(0x8c2427cc)` が false・`findExactOwner(vet402.eth)` が 0」・見るもの「`probe-rpc.ts --deployment`（§1.7）・`ens-names.mjs`（毎朝）」・出たら「**09-15 に一度起きた**。名前の取り直し（Takeshi）→ ABI の取り直し → A7 の練習のやり直し。次は 10月中旬以降と推定（間隔 34・32・46日）。09-24 夜と B0 で1回ずつ手で打つ」
- **P75（L823）** 旧: 「A2 が毎朝 `findOwner` を読む」「app.ens.dev で登録した名前のリゾルバの root がスマートアカウントにあり…K1 の `own-resolver` で差し替える」 → 新: 「A2 が毎朝 `findExactOwner` と `ROOT_REGISTRY` を読む（09-15 に実際に起きた）」「…root に HCA がいれば K1 で `revokeRootRoles`。売り手の名前は K1 で自前のリゾルバに差し替える」

### 4.19 追記節（L889〜990）
- **P76〜P78（L889-907）** 各節の見出しの直後に1行足す（本文は書き換えない・台帳の規律）: 「※ 07-30 配備の記録。09-15 の配備し直しで、ここのアドレス・リゾルバ・root 保持者・名前の登録はすべて無効（09-17 R2 節）」
- **P79（L936）** 旧の例「clearRecords の版上げをキーごとの TextChanged で見落とす」 → 新の例「09-15 の配備し直しの後も docs が旧 ABI／`grantSetterRoles` が名前を読まない／`Linked` でつなぎ替えても `TextUpdated` が出ない（recordId で監視しないと見落とす）」
- **P80・P81（L989-990）** 訂正を1行追記（元の行は残す）: 「**訂正（09-17 09:0x）**: `grantSetterRoles` は setter の呼び出しデータから**セレクタとキーだけ**を読み、名前は読まない（`PermissionedResolver.sol:307-338@d9affea0`・ENS のテスト "friend can change setText(key) on any name"）。委任は『キー単位より細かい』のではなく**『リゾルバ上の全ての名前にまたがるキー単位』で、旧 `authorizeTextRoles`（名前×キー）より粗い**。seller-a.eth だけに絞るには専用のリゾルバを作る（PLAN_DIFF §2 Q1）」

### 4.20 CONCEPT_v3.md
- **C01（L21）** 旧: 「検証エージェントには判定キーだけ委任（`authorizeTextRoles`）」 → 新: 「委任はキー単位（`grantSetterRoles`・リゾルバ上の全ての名前に効く）」
- **C02（L22）** 旧: 「`TextChanged`（値つき）・`TransferSingle`・`TokenRegenerated`・`EACRolesChanged`」 → 新: 「`TextUpdated`（recordId と値つき）・`Linked`（名前の指す箱の変更）・`TransferSingle`・`TokenRegenerated`・`EACRolesChanged`」
- **C03（L37）** 旧: 「（リゾルバ差し替え・alias・clearRecords・アップグレード）」 → 新: 「（リゾルバ差し替え・つなぎ／切り離し（`Linked`）・アップグレード）」
- **C04（L70）** 旧: 「Permissioned Resolver の `clearRecords()` は記録の版を上げる方式（キーごとの `TextChanged` を見る関門は見落とす）。…alias の差し替えと版の上昇でも REFUSE。売り手のサブ名には `authorizeTextRoles` で約束のキーだけ委任し…」
  → 新: 「Permissioned Resolver の記録は ID つきの箱で、名前は箱を指すだけ。`linkToRecord(name, 0)` で全キーが一度に消え、`linkToRecord(name, 他の名前の箱)` で他の名前の約束と証明がそのまま見える。どちらも `TextUpdated` は出ず、記録のイベントは名前ではなく箱 ID に付くので、名前とキーで変更を監視する関門は見落とす。支払いの時点で UniversalResolver から読み直し、切り離しとつなぎでも REFUSE。売り手の名前には専用のリゾルバで `grantSetterRoles` により約束のキーだけ委任し、attestation のキーと他の売り手の約束には権限が無いことを画面で見せる」
- **C05（L76）** 旧: 「続けて clearRecords／alias の差し替えでも REFUSE」 → 新: 「続けて記録の切り離し／他の名前の記録へのつなぎでも REFUSE」

---

## 5. テスト（§3）の期待値の変更

| ID | 旧 | 新 |
|---|---|---|
| T04 | 入力「`findOwner` が別アドレス」 | 入力「`UniversalHelper.findExactOwner` が別アドレス」。期待は同じ `ens_attestation_signer_mismatch` |
| T05a | 名前「clearRecords（全部空）」 | 名前「切り離し（`linkToRecord(name, 0)`・全部空）」。入力・期待は同じ（`ens_offer_missing`） |
| T06 | 「別名の差し替え｜UR の読み取りが別名先の `v'` と写した envelope を返す」 | 「他の名前の箱につなぐ｜UR の読み取りが**別の名前 n2 の有効な約束と envelope をバイト単位でそのまま**返す（n2 では VALID の組）」→ 期待 `ens_attestation_signer_mismatch`。偽物の fixture は T07 と共有してよい |
| T14 | 「`findOwner → 0x0`」 | 「`findExactOwner → 0x0`（3枝: 未登録／RESERVED／wildcard のサブ名。**サブ名の枝では偽の `findNearestOwner` が親の持ち主を返しても使わない**）」→ `ens_name_unresolved`。`findNearestOwner` への呼び出し 0 回 |
| T34 | 「`t` の後に `TextChanged(node,"x402-offer")` があり今は元の値」 | 3枝: (a) `t` の後に `TextUpdated(recordId_n, keccak256("x402-offer"))` があり今は元の値 (b) `t` の後に `Linked(*, node)` があり今は元の箱 (c) つながった別の名前経由の `TextUpdated(recordId_n, …)`（node はログに出ない）→ 各 `ens_record_changed_after_attestation` |
| T35 | 「`anchor.owner` ≠ `findOwner("vet402.eth")`」 | 「`anchor.owner` ≠ `findExactOwner(dns("vet402.eth"))`」 |
| T48（追加提案） | — | 「配備の食い違い｜同じブロックで `UH.ROOT_REGISTRY()` ≠ `UR.ROOT_REGISTRY()`」→ `ens_evidence_unavailable`＋`evidence_unavailable`。本数は 52 → 53（B6 の判定 `≥ 48` → `≥ 49`） |

変更なし: U01〜U04・T01〜T03・T05b・T07〜T13・T15〜T33・T36〜T47（ENS の読み取りは偽物の注入で、関数名に依存しない）。ただし偽物の `EnsReadClients` のメソッド名を `findOwner` → `findExactOwner` に揃える（T01 ほか全ての fixture の共通部）。

---

## 6. 切り捨ての順番（§4 L599-611）

- #4 旧「**場面3の別名の差し替え**（1文字と clearRecords は残す）」→ 新「**場面3の他の名前の記録へのつなぎ**（1文字と切り離しは残す）」
- #5 旧「**場面3の clearRecords**（1文字だけ残す）」→ 新「**場面3の記録の切り離し**（1文字だけ残す）」
- #4 と #5 を両方落とすなら `P_bc` を作らず、seller-b/c は app.ens.dev のリゾルバのまま（K1 の tx が 2 本減る）
- 新しい注（順番には入れない・軸 i〜iii ではない）: **K1 で seller-a 専用のリゾルバが間に合わなければ**、3名共有のリゾルバで委任し、画面と提出文を「この鍵は W_ens のリゾルバの `x402-offer` キーだけ（3名とも）」に変えて開示する

---

## 7. 作品として強くなる点・弱くなる点

**強くなる点**: ENSv2 でなければ書けない読み方が、旧版より鋭くなる。記録は名前ではなく箱 ID に付き、`Linked` で名前の指す箱を替えても、つながった別の名前から書いても、その名前とキーを名指しするイベントは出ない【実測・simulate】。「名前とキーで変更を監視する関門は構造的に見落とし、今の ENS データから組み直す ENSIP-29 だけが失効を落とさない」と、作品の中心の設計判断を ENSv2 の新しいデータモデルで正当化できる。場面3のつなぎは「他の名前の約束と証明がバイト単位で同じでも払わない」を見せられ、草案 123行（別の名前に置き直した envelope は無効）をそのまま実演する。前もって写しを書く準備が消え、撮り直しは `linkToRecord` 1 tx で戻せて証明の置き直しも要らない（B7 と B9a の tx と待ち時間が減る）。委任は `grantSetterRoles` の `ResourceArgument` ログにキー名が平文で残るので、`/tokyo` で「この鍵が書けるのは `x402-offer` だけ」をチェーンの記録から表示できる。

**弱くなる点**: 旧 `authorizeTextRoles` の「名前×キー」の委任が無くなり、委任はリゾルバ上の全ての名前にまたがる。「seller-a.eth の約束だけ」を守るには売り手ごとにリゾルバを作る必要があり、K1 の tx が増え（約 +3 本）、主張も「名前1つ」ではなく「専用のリゾルバの1キー」になる。つまり 09-17 08:5x の要約にあった「EAC の見せ場が細かくなる」は逆で、細かさは落ちる。clearRecords の「版を上げる」話は消え、切り離しは元に戻せるので「消したら終わり」ではなく「戻せば証明が生き返る」を開示に足す。W_obs の 15 キーの委任も `vet402.eth`・`atst.vet402.eth` の同じキーに効く（addr は守られる）。名前の取り直しでオーナーの署名が1回増え、A0・A6・A7 の実測をやり直す必要がある。docs.ens.domains が旧 ABI のままなので、審査員やメンターが docs を見て話すと関数名が食い違う恐れがある（提出文に「09-15 配備の ABI で検証」と日付を書く）。

---

## 8. 会期前の新しい練習項目（名前の取り直し後に実行する前提）

読み取りは2系統（sentio・pandaops）で同じブロックに固定。連続する書き込みの練習は sentio の `eth_simulateV1`（`validation:false`）で、署名も送信もしない。`R_vet` は `vet402.eth` の取り直し後のリゾルバ、`P_a`・`P_bc` は E4 で出した予定アドレス。

| # | 関数 | from | 期待 |
|---|---|---|---|
| E1 | `UR(0xeEeE…EeEe).ROOT_REGISTRY()`・`UH(0x33f5…7df5).ROOT_REGISTRY()`・`Root(0x9703…a9cE).getSubregistry("eth")`・`impl(0x14F0…F243).supportsInterface(0x8c2427cc)` | 誰でも | `0x9703…a9cE` ×2・`0x657e…E09E`・true（09-17 済み【実測】。09-24 夜と B0 でもう一度） |
| E2 | `ETHRegistrar.isAvailable(label)`・`ETHRegistry.getState(labelhash(label))`・`UH.findExactOwner(dns(name))`（4名） | 誰でも | false・status 2・`latestOwner` = W_vet／W_ens・`findExactOwner` = 同じ |
| E3 | `UH.findExactOwner(dns("x.obs.vet402.eth"))`・`UH.findNearestOwner(同)` | 誰でも | `0x0`・`(W_vet, 6)`（`\x01x\x03obs` の6バイト先が `vet402.eth`。段2で nearest を使わないことの確認） |
| E4 | `VerifiableFactory.deployProxy(impl, SALT_A, initialize([(W_ens,ALL)], [setText×2, setAddress(60)]))`・同 `SALT_BC`（seller-b/c の記録） | W_ens | それぞれ予定アドレス `P_a`・`P_bc` を返す（initData を変えてもアドレスは同じ） |
| E5 | `ETHRegistry.setResolver(getState(labelhash("seller-a")).tokenId, P_a)` | W_ens／W_op | 成功／`EACUnauthorizedAccountRoles` |
| E6 | simulate: E4 → E5（×3）→ `P_a.grantSetterRoles(setText(dns("seller-a.eth"),"x402-offer",""), W_op)` → `P_a.roles(keccak256("x402-offer"), W_op)` | W_ens | 成功・`ResourceArgument(keccak("x402-offer"), "x402-offer")`・`0x10` |
| E7 | simulate（E6 の続き）: `P_a.setText(dns("seller-a.eth"),"x402-offer",…"10001"…)` → `UR.resolve(dns("seller-a.eth"), text(namehash,"x402-offer"))` | W_op／誰でも | 成功・`TextUpdated(R_a, keccak("x402-offer"))`・新しい値 |
| E8 | simulate（E6 の続き）: `P_a.setText(dns("seller-a.eth"),"attestations[x402-offer][atst.vet402.eth]","x")`・`P_bc.setText(dns("seller-b.eth"),"x402-offer","x")`・`P_a.linkToRecord(dns("seller-a.eth"),0)`・`P_a.grantSetterRoles(…, W_op2)`・`P_a.grantRoles(keccak("x402-offer"),0x10,W_op2)` | W_op | 順に `EACUnauthorizedAccountRoles(keccak(attKey),0x10,W_op)`・`EACUnauthorizedAccountRoles(keccak("x402-offer"),0x10,W_op)`・`EACUnauthorizedAccountRoles(0,0x10000000,W_op)`・`EACCannotGrantRoles`・`EACCannotGrantRoles` |
| E9 | simulate: E4(P_bc) → `setResolver` ×2 → `P_bc.getRecordId(namehash("seller-b.eth"))`（= R_b）→ `P_bc.linkToRecord(dns("seller-b.eth"), 0)` → `UR.resolve(seller-b, text x402-offer)` → `P_bc.linkToRecord(dns("seller-b.eth"), R_b)` → `P_bc.linkToRecord(dns("seller-c.eth"), R_b)` → `UR.resolve(seller-c, text x402-offer)`・`UR.resolve(seller-c, text attestations[…])` → `P_bc.linkToRecord(dns("seller-c.eth"), R_c)` | W_ens | `Linked(0, node_b)`・`""`・`Linked(R_b, node_b)`・`Linked(R_b, node_c)`・seller-b と同じ値×2・`Linked(R_c, node_c)` |
| E10 | simulate: `P_bc.linkToRecord(dns("seller-b.eth"),0)` → `P_bc.linkToNode(dns("seller-c.eth"), namehash("seller-b.eth"))` | W_ens | 2本目が `InvalidRecord`（順番の罠の確認） |
| E11 | simulate: `R_vet.setAddress(dns("atst.vet402.eth"), 60, K_atst)` → `R_vet.multicall([grantSetterRoles(setText(dns("x.obs.vet402.eth"), key_i, ""), W_obs) ×15])` → W_obs で `setText(dns("<id>.obs.vet402.eth"),"x402.l2","conform")`・`setAddress(dns("atst.vet402.eth"),60,W_obs)` → `UR.resolve(dns("atst.vet402.eth"), addr(namehash))` | W_vet／W_obs | 成功・成功（30 ログ）・成功・`EACUnauthorizedAccountRoles(…,0x1,W_obs)`・K_atst |
| E12 | `deployProxy(impl, salt, initialize([(W_ens,ALL)], [grantSetterRoles(…, W_op)]))` | W_ens（eth_call） | `EACCannotGrantRoles(…, 0x9e726Eb5…)`（初期化の calls に委任を入れないことの確認） |
| E13 | `R_vet` の `EACRolesChanged`（resource 0）の全履歴・`isOnlyAssignee(0, ROLE_SET_TEXT, W_vet)`／他者がいれば simulate で `revokeRootRoles(ALL_ROLES, 他者)` | 誰でも／W_vet | 保持者の一覧・true なら `revokeRootRoles` 不要／成功 |
| E14 | viem `getEnsAddress`・`getEnsText`・`getEnsResolver`（`blockNumber` 固定・4名）と canary `LabelRegistered`（block 11717398・ETHRegistry）の getLogs | 誰でも | 2系統一致・例外なし（K1 前は text が null）・canary が両方に1件 |
| E15 | `P_a.revokeRoles(keccak256("x402-offer"), 0x10, W_op)`（会期後の後始末の練習） | W_ens | 成功・以後 W_op の `setText` は revert |

---

## 9. 未確認として残すもの
- 取り直し後の app.ens.dev が作るリゾルバの root 保持者（HCA が入るか）と、既定の addr を置くか（実例は `pandas.eth` 1件だけ）
- 09-15 以降の app.ens.dev の登録画面の文言と流れ（付録 8-A）
- 登録で持ち主に付く登録簿のロールが docs（旧）と同じか（`ROLE_SET_RESOLVER` は `pandas.eth` の持ち主の simulate で `setResolver` が通ったので持っている【実測・simulate 手順02】。`ROLE_UNREGISTER` などは未確認）
- viem の `getEnsText` が、つないだ名前で UR 経由の値を返すこと（UR の `resolve` を直接呼んだ simulate では確認済み。viem の関数そのものは K1 の後に）
- ENSIP-29 草案 PR #85 の head が `e00c345` のままか（今回は見ていない。§1.7 の既存の行で B0 に確認）

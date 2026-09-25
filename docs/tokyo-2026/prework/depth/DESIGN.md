# 案A・案B の設計と実測（ENSv2 の要素を会期2時間以内で最大化する）

- 実行: 2026-09-19 JST。**読み取りと `eth_call` / `eth_simulateV1` のみ。署名 0・送信 0・commit 0**
- 固定ブロック: `latest - 3`（sentio）。印は【実測】自分で RPC を叩いた／【実測・sim】`eth_simulateV1`／【一次】ソース原文／【推定】
- スクリプト: `depth/d.mjs`（D-01〜D-20）・`d2.mjs`（期限・取消・aliasing）・`d3.mjs`（極短期限・親支配・emancipation・委任registrar）・`d4.mjs`/`d5.mjs`（案B）。結果は同名 `*_result.json`

---

## 0. 結論（先に）

1. **案A は採る。** 賞の本文が挙げる要素 8 個のうち、いま 2 個（record aliasing・EAC）→ **8 個全部**になる。必要な書き込みは **5 tx・合計 888,838 gas**（エージェント1体）。全部 simulate で通っている【実測・sim】
2. **案A は既存の設計を壊さない。** `vet402.eth` に自前レジストリをぶら下げても、`atst.vet402.eth`・`x.obs.vet402.eth` は今までどおり `R_vet` の wildcard で解決する【実測・sim D-10/D-11】
3. **案B は会期では採らない。** 一次資料を読んだら**前提が逆だった**（下記 §3）。案B 自体は筋が良く、ENS の草案が「取り消しが無い」と認めている穴を塞ぐが、attester の名前は **デモの生命線**（ENSIP-29 の段6が全部そこを引く）なので、単一障害点を増やす価値がない。**実装0時間で ENS の feedback 欄に書くのが最大利得**
4. 中心の主張「ENSv2 でなければ成立しない」は、**期限・取り消し・譲渡不可では言えない**（ENSv1 の NameWrapper が fuses で全部できる）。言えるのは次の3つだけ。これを前に出す:
   - (a) 委任が**キー単位**で、**名前ごとのリゾルバ**でしか閉じない【実測・sim D-08 vs T9】
   - (b) 取り消しで**記録と委任が同時に死ぬ**（EAC の resource の版が上がる）【実測・sim B3b】
   - (c) **任意の自前レジストリ契約**を親の下に挿せる（v1 の NameWrapper は固定の1契約）【一次】

---

## 1. 前提の裏取り【実測】

| 項目 | 値 | 出どころ |
|---|---|---|
| `UserRegistryImpl`（Sepolia） | **`0xA80338aAA8D23831cEa25E858D1774534aBb0263`** | docs.ens.domains/learn/deployments。同ページの VF・ETHRegistry・Root・PermissionedResolverImpl・UniversalHelper の5件が既知と一致。オンチェーンで code 18,841 byte・`LABEL_STORE()` = `0x375C082021E677a40eA2AE094D050602dba90992`・`canUpgradeFrom(0)` = true【実測】 |
| `LabelStore` | `0x375C082021E677a40eA2AE094D050602dba90992` | 同上・上の一致で裏取り済み |
| `vet402.eth` の今の subregistry | `0x0`（まっさら） | `ETHRegistry.getSubregistry("vet402")`【実測】 |
| `W_vet` の `vet402.eth` 上のロール | `0x1110000000000000000000000000000001100000`・`hasRoles(ROLE_SET_SUBREGISTRY)` = **true** | 【実測】= 追加の権限付与は要らない |
| 現在の `findResolver` | `vet402.eth` / `atst.vet402.eth` / `x.obs.vet402.eth` / `agent-1.vet402.eth` すべて `R_vet 0x3368…8391` | 【実測】 |

※チェックサム誤りは viem が拒否する（e15 §4-3 の再発防止）。上の表記をそのまま使う。

---

## 2. 案A — `vet402.eth` の下に自前の subname registry を置き、払う側のエージェントに名前空間を与える

### 2.1 形

```
vet402.eth                         ETHRegistry（ENS の）
  └ subregistry = U                UserRegistry（自前・VerifiableFactory で配備）
      ├ agent-1   resolver = P_AG1  専用 PermissionedResolver
      │            x402-policy = {"v":1,"trust":["atst.vet402.eth"],"floor":"l2_match","max":"50000"}
      │            addr(60)     = K_ag1
      │            期限あり・譲渡不可・親が取り消せる
      └ agent-2   resolver = 0      親 R_vet の wildcard に落ちる（対照）
  （atst / <hash>.obs は登録しない＝今までどおり R_vet の wildcard）
```

関門の読み方: 払う前に **払う側のエージェント自身の名前**から `x402-policy` を読み、その方針（信じる attester の一覧・証拠の床・上限）を当てる。「エージェントが名前を持ち、名前が方針を持つ」。

### 2.2 賞の本文との1対1（原文は逐語）【一次】

賞ページ `https://ethglobal.com/events/tokyo2026/prizes`（ENS・2枠 $10,000）。

| # | 賞の本文（原文） | 今 | 案A | 実測の根拠 |
|---|---|---|---|---|
| 1 | "Explore the new hierarchical registry structure" | ✗ | ✓ | D-02 `setSubregistry(vet402→U)` 57,520 gas |
| 2 | "resolve subnames straight off a parent's resolver with wildcard resolution" | ✓ | ✓ 対照つき | D-15 `agent-2.vet402.eth` → `R_vet` |
| 3 | "**deploy your own subname registry** to tokenize and manage subnames under your own rules" | ✗ | ✓ | D-01 `VF.deployProxy(UserRegistryImpl)` 178,021 gas |
| 4 | "Enhanced Access Control … **letting an account edit only certain text records on a name**" | △ | ✓ | D-05 委任 → D-06 OK／D-07 `EACUnauthorizedAccountRoles`（addr は不可）／D-08 親のリゾルバは不可 |
| 5 | "Give subnames **their own Permissioned Resolver** so they fully own their data" | ✗ | ✓ | D-03 `P_AG1` 393,333 gas・T1a で `UR.resolve` が方針 JSON を返す |
| 6 | "record aliasing at the resolver level" | ✓ | ✓ | T3 `linkToNode` 64,282 gas |
| 7 | "**namespace aliasing via a shared registry**" | ✗ | ✓ | T3 `seller-a.eth` も同じ U へ → `agent-1.seller-a.eth` が同じ持ち主・同じリゾルバ |
| 8 | "expiring, revocable, non-transferable vs. transferable, even **forever names with no parent control**" | ✗ | ✓ 4つ全部 | T5（120秒の名前）・T2（`unregister`）・D-13（`TransferDisallowed`）・T7（`isEmancipated` true → 親の `unregister`/`setResolver` が revert） |
| 9 | "Bonus … **agents as namespaces, each with their own identity and permissions**" | ✗ | ✓ 中心 | 上の全部 |

Continuity 枠（$4,000）の本文も同じ語を挙げ、末尾に "consider giving agents their own namespace and delegated permissions within your integration" とある。案A はこの一文の逐語の答えになる。

### 2.3 実測の要点

| 測った事 | 結果 | 番号 |
|---|---|---|
| `agent-1.vet402.eth` が解決するか | `"{\"v\":1,\"trust\":[\"atst.vet402.eth\"],…}"` via `P_AG1` | T1a |
| **既存の名前を壊さないか** | `atst.vet402.eth`・`x.obs.vet402.eth` は `setSubregistry` 後も `R_vet` のまま | D-10・D-11 |
| 期限 | `expiry = now+120` で登録 → **+180秒で `""`**・`getStatus` = 0（AVAILABLE）。`renew` で復活し、また読める | T5a/b/c |
| 取り消し | `unregister` 72,604 gas → `findExactOwner` = `0x0`・`UR.resolve` = `""`（`R_vet` に落ちるが記録が無い） | T2 |
| 譲渡不可 | `ROLE_CAN_TRANSFER_ADMIN` を与えずに登録 → `unsafeTransfer` が **`TransferDisallowed`** | D-13 |
| 親の支配を外す | `U.revokeRootRoles(UNEMANCIPATED_ROLE_BITMAP)` 44,050 gas → `isEmancipated()` = true・親の `unregister`/`setResolver` が revert。ただし**登録は続けられる** | T7 |
| 親が名前空間ごと差し替える道を塞ぐ | `ETHRegistry.revokeRoles(vet402, ROLE_SET_SUBREGISTRY)` → 以後 `setSubregistry` が revert | T6 |
| エージェントが自分で名前を取る | `U.grantRootRoles(ROLE_REGISTRAR, K_bot)` → `K_bot` の `register` が通り、権限のない鍵は `EACUnauthorizedAccountRoles(0x0,0x1,…)` | T8 |
| namespace aliasing | `seller-a.eth` の subregistry も U へ → `agent-1.seller-a.eth` の `findResolver` = `P_AG1`・`findExactOwner` = `K_ag1`。**記録は別 node なので空**。`linkToNode` を足して初めて同じ方針が読める | T3 |

### 2.4 「ENSv2 でなければ」を支える3つ（ここだけ言い切る）

- **(a) 委任は名前ごとのリゾルバでしか閉じない**。`PermissionedResolver` の EAC resource は**キー文字列の keccak**（`PermissionedResolverLib.resource(string)`・`keccak("x402-policy")` = `0x1c0754232f48fc306cedd0a65442157964f44f2481314faec5a4bee29b1d877f`【実測】）。名前は入らない。
  - 専用リゾルバあり → `K_ag1` は `agent-1` の方針だけ書ける。親 `vet402.eth` に同じキーを書こうとすると `EACUnauthorizedAccountRoles`【D-08】
  - 専用リゾルバなし（親 `R_vet` にキーを委任）→ **`K_ag2` は `vet402.eth` 本体の `x402-policy` も書けてしまう**【T9】
  - つまり賞の本文の "edit only certain text records **on a name**" は、**専用リゾルバを配ることでしか成立しない**。これを画面で before/after で見せる
- **(b) 取り消しで委任が死ぬ**。`unregister` → 同じラベルを別の持ち主で再登録すると `getResource` が `…00000000` → `…00000001` に上がり、第三者の鍵の `hasRoles` が **true → false**【B3b】。ENSv1 のリゾルバの承認は再登録後も生き残る（後述 §3 の cedricbrown の指摘そのもの）
- **(c) 親の下に挿すのが「任意の契約」**。`setSubregistry(anyId, IRegistry)` は自作の契約を受ける。v1 の NameWrapper は固定の1契約【一次 `PermissionedRegistry.sol:145`】

**言わない**: 「期限つき・取り消し可・譲渡不可のサブ名は ENSv2 でしかできない」。ENSv1 の NameWrapper が fuses（`PARENT_CANNOT_CONTROL`・`CANNOT_TRANSFER`）と expiry で同じことをする。**この一文を提出文に書くと審査員に即刺される。**

### 2.5 K1 に足す tx（推奨の並び）【実測・sim】

| # | from | 宛先 | 関数 | gas | 依存 |
|---|---|---|---|---|---|
| K1-10 | W_vet | VF | `deployProxy(UserRegistryImpl, SALT_U, initialize([(W_vet, ALL_ROLES)]))` → **U** | 178,021 | なし |
| K1-11 | W_vet | ETHRegistry | `setSubregistry(tokenId(vet402.eth), U)` | 57,520 | K1-10（U は送り手＋salt で先に決まる） |
| K1-12 | W_vet | VF | `deployProxy(PermissionedResolverImpl, SALT_A1, initialize([(W_vet,ALL)], [setText(x402-policy), setText(class), setAddress(60,K_ag1)]))` → **P_AG1** | 393,333 | なし |
| K1-13 | W_vet | U | `register("agent-1", K_ag1, 0, P_AG1, ROLE_RENEW, <expiry>)` | 172,524 | K1-10・K1-12 |
| K1-14 | W_vet | P_AG1 | `grantSetterRoles(setText(*, "x402-policy", ""), K_ag1)` | 87,440 | K1-12。**`initialize` の calls に入れると revert（E12 と同じ）** |
| （任意）K1-15 | W_vet | U | `register("agent-2", K_ag2, 0, 0, ROLE_RENEW\|ROLE_CAN_TRANSFER_ADMIN, <expiry>)` | 170,369 | 対照用。専用リゾルバ無し＝親の wildcard |

**合計 5 tx・888,838 gas**（K1-15 を足して 6 tx・1,059,207）。既存の K1 は 9 tx・2,329,308 gas なので、**14 tx・3.2M gas** になる。

デモで打つ tx: `U.unregister(agent-1)` 72,604 ／ `U.renew` 41,764 ／ `P_AG1.setText(x402-policy)`（エージェント自身が）53,984。

**順序の注意**: K1-11 は `atst.vet402.eth` と `x.obs.vet402.eth` の解決経路に触る。09-25 の B0 で simulate を打ち直し、両者が `R_vet` のままであることを確かめてから打つ。

### 2.6 デモの見え方（今の台本への足し方）

今の 4 分枠は 240 秒で埋まっている。**足すのではなく置き換える**。

| 秒 | 置き換え前 | 置き換え後（案A） |
|---|---|---|
| 40–55 | 場面2 準備（売り手の記録） | そのまま＋1行: `agent-1.vet402.eth` の `x402-policy` を表示。"The payer is a name too. Its policy says which attesters it trusts." |
| 175–195 | 場面3 `clearRecords`（**そもそも関数が無い**。実体は `linkToRecord(name,0)`） | **`U.unregister(agent-1)` → 同じ `tokyo pay` が REFUSE**。"I revoked the agent's own name. Its policy is gone, so it will not pay." |
| 195–215 | 別名の差し替え（record aliasing） | **そのまま残す**（賞の項目6。案A の項目7 と対になる） |

- **期限の見せ方**: ライブ枠は時刻が読めないので **取り消し（ボタン）をライブに、期限切れ（120秒の名前）を動画に**置く。動画なら 120 秒待つ画を編集で詰められる
- **見え方が良くなるか**: 良くなる。今の失効は全部「売り手が悪いことをした」の話。案A は**払う側の権限を、払う側の名前で**見せるので、賞の "agents as namespaces" にそのまま当たる。かつ (a) の before/after は 10 秒で「なぜ専用リゾルバが要るのか」を証明できる

### 2.7 既存の設計との衝突

| 衝突しうる点 | 実測の結論 |
|---|---|
| `atst.vet402.eth`（ENSIP-29 の段6）が読めなくなる | **ならない**。`U` に `atst` を登録しない限り、`R_vet` の wildcard のまま【D-10】 |
| `<hash>.obs.vet402.eth`（場面1） | **ならない**【D-11】 |
| CONCEPT v4 の「協力していない売り手に名前を作らない」 | 抵触しない。案A で名前を配るのは**自分のエージェント**だけ |
| PLAN §0 の台本にある `clearRecords` | **その関数は存在しない**（v4.2 で訂正済み・§0 は未反映）。置き換えるなら案A の取り消しのほうが素直 |
| `sinceIssuanceScan`（切り捨て #2） | 無関係 |

---

## 3. 案B — attester の名前空間を自前レジストリへ

### 3.1 前提が逆だった【一次】

ENS フォーラム `https://discuss.ens.domains/t/ensip-text-record-attestations/22376`。

- **09-11 #11 jkm.eth**: "Under this scheme, an attester's identity should be tied to the top-level ENS name, as it has ownership over any subnames."
- **09-15 #13 jkm.eth（これを取り下げている）**: "Now that I think more about it, this actually isn't a concern for this mechanism. Example.eth is the authority. It points to a resolver it trusts, and that resolver returns records that it trusts. So really, consumers who have decided to accept example.eth as an authority can accept the chain of trust that is atst.example.eth without any other information."
- **ENSIP-29 本文（PR #85 head `e00c345`）**: "It is RECOMMENDED for attesters to run their attestation service under a dedicated subname, for example `atst.example.eth`."

→ **`atst.vet402.eth` は草案の推奨形そのもの。案B は「矛盾しないか」ではなく「穴を塞ぐか」の話になる。**

塞ぐ穴は2つ、どちらも当事者が書いている:
- **09-11 #11 jkm.eth**: "It's important to point out that there is **no revocation mechanism**. Attestations are simply self-invalidating if there is a change of private keys."
- **09-11 #10 cedricbrown**: "on an unwrapped parent, **re-registration does not clear the subnodes**, so atst.example.eth keeps resolving to the old address until the new owner touches it."

### 3.2 実測 — 案B は動く。ただし罠が1つある

| # | 何を測ったか | 結果 |
|---|---|---|
| B1 | `atst` を U に登録（専用リゾルバ `P_AT` に addr = K_atst）。`R_vet` には atst の addr を**書かない** → `UR.resolve(addr)` = `K_atst` → `unregister` → **`0x0`** | ✓ **取り消し1本で attester を一括失効できる**（ENSIP-29 の段6が全件で落ちる） |
| B2 | 同じ構成だが `R_vet` にも `setAddress(atst.vet402.eth, 60, K_atst)` がある（**= 今の K1-02 のまま**） → `unregister` 後も `UR.resolve(addr)` が **`0x41…A7` を返し続ける**（`R_vet` の wildcard が蘇らせる） | ✗ **罠**。案B を採るなら K1-02 から `setAddress(atst.vet402.eth)` を必ず外す |
| B3b | 第三者の鍵に `grantRoles` → `unregister` → 別の持ち主で再登録 → `getResource` が `…00` → `…01`、`hasRoles` が **true → false** | ✓ cedricbrown の指摘に ENSv2 が答えている（v1 では生き残る） |

### 3.3 判断: 会期では採らない【推定・根拠は下記】

- **理由1（致命的）**: `atst.vet402.eth` は ENSIP-29 の検証の段6・段7 が毎回引く。ここを自前レジストリ経由にすると、レジストリの取り違え・期限の設定ミス・B2 の罠のどれか1つで**場面2も場面3も一斉に死ぬ**。20 時間・ソロ・余裕ゼロで単一障害点を増やす取引に見合わない
- **理由2**: 得られる絵（「attester の名前を取り消す → 全証明が無効」）は、場面3 の「1文字変える → REFUSE」と画面上ほぼ同じ REFUSE。**新しい印象を1つも増やさない**
- **理由3（採らなくても点が取れる）**: 案B の価値は「ENS 自身が開いていると書いた穴に、ENSv2 の機能で答えた」ことそのもの。これは **§6.3 の ENS feedback 欄に 5 行書けば全部伝わる**。実装時間 0・リスク 0

**代わりにやること（実装0時間）**: §6.3 の feedback 欄に、B1・B2・B3b の実測を添えて次を書く。

> ENSIP-29 draft says there is no revocation mechanism, and the thread notes that a re-registered parent does not clear its subnodes. On ENSv2 both are answered by the registry itself: put the attester subname in your own `UserRegistry`, and `unregister` invalidates every attestation that name ever signed, because step 6 resolves to `0x0`. Re-registration bumps the EAC resource, so delegations do not survive either. One trap worth documenting: if the parent's resolver also holds an `addr` record for the same subname, wildcard resolution resurrects the old key after `unregister` — the attester subname must not have a record on the parent resolver.

（会場の ENS メンターへの Q にも1本回せる。§7 の枠内）

**格上げの条件**: 09-26 12:00 の判定点②が緑で、かつ B7 が 13:00 までに終わったときだけ、`atst-demo.vet402.eth`（本番の envelope には使わない別の attester 名）で 20 秒の取り消しデモを足してよい。本番の `atst.vet402.eth` には触らない。

---

## 4. 切り捨ての提案（20 時間に収める）

案A の追加費用【推定】:
- **人**: K1 の枠（09-26 08:00–09:00）に 5 tx。TK4-c が Yes なら `admin.ts agents --dry-run` → `--live` → census で **+0.2h**。No（ウォレットで手署名）なら **+0.4h**
- **AI**: `admin.ts agents` の実装・関門が払う側の名前から `x402-policy` を読む分岐・`/tokyo` の表示で **2〜3h**（夜間枠）
- **デモ**: **+0 秒**（置き換えで賄う）

落とす順（`PLAN_v3.md` §4 の切り捨て表の番号）:

| 順 | 落とすもの | 理由 | 主張は弱るか |
|---|---|---|---|
| 1 | **#2 補助の走査（`sinceIssuanceScan`・T34）** | もともと切り捨て順2番。AI 時間だけの費用で、デモの秒も人の時間も使わない。落としたことは開示済みの扱い | **弱らない**（元から「保護しないものとして開示」の扱い） |
| 2 | **#5 場面3 の `clearRecords`（実体は `linkToRecord(name,0)`）** | 20 秒。伝える事（記録が一度に消える＝失効）が案A の取り消し・期限に**完全に包含される**。しかも §0 の台本は存在しない関数名で書かれており、どのみち書き直しが要る | **弱らない**。むしろ賞の本文の未着手項目が 6 個埋まる分、強くなる |
| 3 | （まだ足りなければ）**#1 MCP `pay_if_trusted` への反映** | もともと切り捨て順1番 | 弱らない（語彙の表は残る） |

**落とさない**: #4 別名の差し替え（record aliasing は賞の本文の項目6。案A の項目7 namespace aliasing と対になって "combine it all" を満たす）。軸 i・ii・iii は一切触らない。

---

## 5. 会期前にできる準備

### 5.1 `eth_call` の予行演習（今日ぶんは済み。09-25 21:00 の B0 で打ち直す）

`depth/d.mjs` `d2.mjs` `d3.mjs` `d4.mjs` `d5.mjs` をそのまま再実行する。合格条件:

| 判定 | 合格 |
|---|---|
| `UserRegistryImpl` の実在 | code > 0・`LABEL_STORE()` = `0x375C0820…0992` |
| D-01〜D-05 | 全部 OK・合計 888,838 ±5% |
| **D-10・D-11** | `setSubregistry` 後も `atst.vet402.eth`・`x.obs.vet402.eth` の `findResolver` が `0x3368…8391` |
| T1a | `UR.resolve(agent-1.vet402.eth, text("x402-policy"))` が方針 JSON |
| D-08・T9 | D-08 が `EACUnauthorizedAccountRoles`、T9 の最後が **OK**（＝専用リゾルバが要る証拠） |
| T5b | `+180s` で `""`・`getStatus` = 0 |
| D-13 | `TransferDisallowed` |
| T7 | `isEmancipated` = true・親の `unregister` が revert |

### 5.2 正典に足す値

- `UserRegistryImpl` = `0xA80338aAA8D23831cEa25E858D1774534aBb0263`（チェックサム形。小文字で書くと viem が拒否する）
- `LabelStore` = `0x375C082021E677a40eA2AE094D050602dba90992`
- `ROLE_CAN_TRANSFER_ADMIN` = `(1 << 28) << 128`（**`ROLE_CAN_TRANSFER` という定数は存在しない**）
- `UNEMANCIPATED_ROLE_BITMAP` = `SET_SUBREGISTRY|SET_RESOLVER|UNREGISTER|UPGRADE` と各 ADMIN（`ROLE_RENEW` は**含まない**）

### 5.3 発注文に足す1文

> `examples/tokyo-2026-demo/src/admin.ts` に `agents` サブコマンドを足す。`--dry-run` は `eth_simulateV1` で 5 本（`deployProxy(UserRegistryImpl)` → `ETHRegistry.setSubregistry(vet402.eth)` → `deployProxy(PermissionedResolverImpl)` → `UserRegistry.register("agent-1", …, expiry)` → `grantSetterRoles(setText(*,"x402-policy",""), K_ag1)`）を順に通し、**`atst.vet402.eth` と `<hash>.obs.vet402.eth` の `findResolver` が `0x3368…8391` のままであることを同じ出力に印字する**。ここが違ったら `--live` に進まない。関門は `payOrRefuse` の前に、**払う側のエージェント自身の名前**（`AGENT_NAME` 環境変数）から Universal Resolver 経由で `x402-policy` を読み、`trust` の一覧・`floor`・`max` を当てる。読めなければ `agent_policy_missing` で払わない。進捗も最終報告も日本語で書く。

### 5.4 会場の ENS メンターへの問い（§7 の枠に1本差し替え候補）

> Q: Can one project be submitted to both "Best Use of ENSv2" and "Best Integration of ENSv2 into an Existing Project", or does entering the Continuity track exclude the first?

（$6,000 側の資格要件に Continuity 除外の文言は無い【一次・賞ページ逐語】が、確かめる価値がある）

---

## 6. 採らないと結論したもの

- **案B の会期中の実装**（§3.3）。理由は単一障害点と、絵の重複。feedback 欄に回す
- **`atst.vet402.eth` を `R_vet` から外すこと**。案B を採らないので K1-02 は今のまま。**案B を採る決定に変わった場合のみ**、K1-02 から `setAddress(atst.vet402.eth, 60, K_atst)` を外す（B2 の罠）
- **`ETHRegistry.revokeRoles(vet402, ROLE_SET_SUBREGISTRY)`（T6）を本番で打つこと**。一度打つと `vet402.eth` の subregistry を二度と差し替えられない。会期の作品のために本物の名前を不可逆にしない。**デモでは simulate の出力を見せる**（賞の "forever names with no parent control" は U 側の `isEmancipated`（T7）で十分満たす）

# ETHOnline 2026 — fixtures（B1 / B2）と、会期前に判明した設計上のブロッカー

> 取得 2026-08-25（JST）。一次データ = 本番DB（読み取りのみ・Neon `vouch`）と、
> 本番 https://vet402.com/payee/{address}（エンジンをリクエスト毎に実行する公開面）。
> **ローカル実行の判定は使っていない**——`.env.production.local` の `BLOCKSCOUT_API_URL` /
> `BASE_RPC_URL` は `vercel env pull` のマスクで空で、ローカルのエンジンは公開Blockscoutに
> 落ちて 429/timeout を踏み、実際には WARN の相手を fail-closed の BLOCK と報告した
> （0x76a6…: ローカル BLOCK 39 / 本番 **WARN 69**）。計器が違えば数字も違う。

## 1. 会期前に見つけた最大の問題: **ALLOW が誰にも出ない**

しきい値は `allow: 70 / warn: 40`（`src/lib/chain/config.ts`）。
一方 payee エンジンには thin ceiling があり、受領実績の無い payee は **69 で頭打ち**
（`PAYEE_THIN_SCORE_CEILING = allow - 1`・2026-08-13 のスコア操作対策）。
thin を抜ける条件は2つのどちらか:

- `x402_payments` に **3件以上の支払い × 独立した資金源2つ以上**（funder 折り畳み後）
- L1 配達実績が **3件以上 × 独立した買い手2人以上**

本番の実測（2026-08-25）:

| 事実 | 値 | 出典 |
|---|---|---|
| `x402_payments` の行数 | **0** | 本番DB |
| L1 settled の payee ごとの distinct buyer | **全て 1**（買い手は vet402 の観測所だけ） | 本番DB |

→ **本番のどの payee も dataDepth = thin、つまり上限 69、つまり ALLOW は構造的に出ない。**
公開面でも確認: 0x76a672… は **69/100 WARN**（cap ちょうど）、0xffc458… は 52/100 WARN。

これは ETHOnline の会期スコープを直撃する。WIN_EV の勝ち筋は
「BLOCK は署名しない **かつ** ALLOW で実 Base tx を1件出す」だが、
`trustPolicy: allow-only` のままでは **自前 seller も含めて全員 WARN で拒否**され、
動画の ALLOW 25秒は撮れない。自前 seller の payTo は定義上 thin だからである。

### やってはいけない解き方

自分の seller を自分で何度も買って受領実績を作る。funder が同一なら独立payerに数えられない
（2026-08-13 の対策がまさにこれ）し、通れば通ったで
「測る対象を自分で作った」ことになる。vet402 の憲法（中立・自己取引の禁止）に反する。

### 会期入りまでに決めること（実装は 9/4 以降）

1. **既定は allow-only のまま**（fail-closed を弱めない）。
2. `payOrRefuse` に**呼び手が明示する policy** を1つ足す（動詞は増やさない）。
   デモは2本立てになる: 既定 policy で**カタログ全体が拒否される**実測（0/N が ALLOW に届かない）を見せ、
   次に開示済みの policy（例 `{minScore: 60, requireEvidence: "l1-delivery"}`）で、
   vet402 自身が48回配達を観測している endpoint に実際に払って attest する。
   拒否が先、支払いが後。どちらも本物で、どちらも嘘をつかない。
3. これは大会用の細工ではなく**製品の欠陥の是正**でもある。今日の買い手向けAPIは
   誰に対しても WARN しか返せず、呼び手は判断に使えない。金に一番近い段がそこで詰まっている。

### 実装状況（2026-08-25 更新）

上の 2 は **実装済み**（9/4 を待たずに前倒し。会期の細工ではなく製品欠陥の是正だから）。

- `@vet402/sdk`: `trustPolicy: "evidence"` ＋ `requireEvidence`
  （`minL1Deliveries` / `minL1DistinctBuyers` / `minX402Payments` / `minDistinctPayers`）。
- `@vet402/middleware`: `policy: "evidence"` を同じ意味論で対称に実装（H-4 の対称性を維持）。
  `scoreSource: "payee"` 必須（wallet ビーコンに実績信号が無いため）。
- **既定は allow-only のまま**。evidence は WARN を通すが、degraded / stale /
  partial-measurement / BLOCK の拒否は allow-only と同一に保つ——`custom` が
  静かに落としてしまう関門を、ここでは落とさない。
- 下限が全部ゼロの `requireEvidence` は構築時に拒否（それは block-only であり、そう書くべき）。
  実績フィールドの欠落は 0 扱い（不在は合格ではない）。
- **npm へは未公開**。公開は別途 Takeshi 承認。Python SDK は未対応。

デモの2本立て（既定でカタログ全体が拒否される絵 → 開示済み policy で実払い）は、
`policy` 引数を足す作業なしにこのまま撮れる。

## 2. BLOCK フィクスチャ（本番実測・要再測）

L1 で1度も settle しない payee は、それだけでは BLOCK にならない（受領実績の薄さは WARN 止まり）。

| address | L1 attempts / settled (30d) | 本番スコア 2026-08-25 | 備考 |
|---|---|---|---|
| `0x76a672eee56d29d475b0715cc03b8c99d70ec8a2` | 77 / **0** | **69 WARN**（thin cap） | api.sirenic.eu 系 |
| `0xffc458db291b4abce020fe3de4f91f2770e537b1` | 13 / **0** | **52 WARN** | api.aidress.ai 系 |

**2026-08-25 追測（30件・本番面）: BLOCK は1件も出なかった。**
settle する相手・1度もしない相手・delisted・直近10日に初出の若いwallet を横断して30件採点し、
**30/30 が WARN**（最低 41・最高 69・cap の 69 が最頻）。つまり本番の買い手向け判定は今日、
**事実上ひとつの値しか返していない**。ALLOW は構造的に出ず、BLOCK も観測されない。

→ BLOCK フィクスチャは作れない。動画の「拒否」は BLOCK ではなく
**policy による拒否**で撮る（設計は [`DESIGN_payOrRefuse.md`](./DESIGN_payOrRefuse.md)）。
偽の BLOCK は作らない。40 に最も近いのは `0x04ad1362…`(41) と `0x01b34d04…`(43) で、
会期までに 40 を割る可能性はあるので 09-04 / 09-09 / 09-12 に再測する。

## 3. ALLOW 候補（＝ L1 が実際に settle している endpoint。現状はどれも WARN）

支払い先として「本物に届く」ことだけは実測できている相手。policy 決定後の支払い対象候補。

| address | settled / failed (21d) | 最小単価 | 直近 | サンプル resource |
|---|---|---|---|---|
| `0x36038e1d712c5e39f35952164ec58ec2b96caee7` | 48 / 0 | 0.020 USDC | 2026-08-23 | kronossignals.com/api/v1/alerts/btc |
| `0xcc42ed39a06b6cf3f484307ef76b88bf56fb305f` | 45 / 8 | 0.001 USDC | 2026-08-23 | x402-factory.com/v1/aviation/delay-risk/:iata |
| `0x32793f68dc2ea26bbc75eb900da120069e8b6d02` | 12 / 0 | 0.005 USDC | 2026-08-23 | coingecko.use.x402atlas.com/coin |
| `0x446e51deab3ae656c99e65369e8ef1148d23d7f7` | 12 / 0 | 0.005 USDC | 2026-08-21 | dns.use.x402atlas.com/a |

全て Base（`eip155:8453`）・USDC・$1 未満。**primary は 0x36038e1d…**（21日で失敗0・48件settle・
単価 $0.02 なので5回試しても $0.1）。

## 4. 再測の予定

- 09-04 / 09-09 / 09-12 に本番面で再スコア（thin cap の解消状況と、BLOCK 候補の探索）。
- 数字が動いたらこのファイルを更新する。**09-03 に凍結**（ROADMAP D3）。

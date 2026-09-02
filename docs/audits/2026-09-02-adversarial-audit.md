# vet402 敵対的監査 2026-09-02（main 9db3944）

5 領域を独立の監査員（サブエージェント）で並行実施し、意思決定に関わる上位所見は執行部が本番 DB / 本番サイト / ローカル再現で裏取りした（「裏取り」列）。変更は行っていない。

## 総括

| 領域 | P0 | P1 | P2 | 主題 |
|---|---|---|---|---|
| 可用性＋テキスト | 0 | 8 | 17 | 測定対象の妥当性（パステンプレート）、方法論と台帳の矛盾、CSR のみのページ |
| デザイン | 0 | 3 | 10 | /observatory の最初の画面に操作対象なし、表が紙幅超、login に RFC 奥付 |
| セキュリティ | 0 | 1 | 8 | SSRF ガードの IPv6 迂回。認可・SQL・秘密・課金・CSP は所見なし |
| コード品質＋完全性 | 1 | 16 | 38 | Solana 索引の欠落固定、契約（OpenAPI）の漂流、計画未達 8 |
| 導線 | 0 | 9 | 6 | 段 2 の入口ゼロ、受領証への到達経路なし、主 CTA 未計測 |

## 裏取り済みの上位所見

| # | 所見 | 裏取り（2026-09-02 15:40 JST） |
|---|---|---|
| A1 | パステンプレート URL（`/:id` 等）をそのまま L0/L1 で測っている | endpoints 1,034 件。L1 161 回（settle_failed 153 / settled 6 / claimed 2）、署名額 7,200,000 units ≈ $7.20、公開 fail 12 件 |
| A2 | 方法論 §6・FAQ Q8「L1 は Base のみ」と台帳が矛盾 | Solana の L1 行 38 件（claimed 26 / failed 10 / no_receipt 2） |
| A3 | /observatory/state「Mainnets only」に Solana devnet | devnet（EtWTRAB…）の active endpoint 33 件。`chains.ts` の TESTNET_LABELS は Base Sepolia のみ |
| S1 | SSRF ガード: IPv6 マップド/NAT64 の埋め込み IPv4 を公開扱い | `isPublicUnicastIp("::ffff:7f00:1")` → true。`new URL("http://[::ffff:127.0.0.1]/")` は `[::ffff:7f00:1]` に正規化されドット表記の防御が効かない。到達経路にキー不要の `POST /api/v1/demo/verify` を含む |
| C1 | Solana 決済索引: `LIMIT 40` 固定・`until` 無し・予算切れでもチェックポイント前進 | Solana の payTo は 37 件（<40）で現在は未発火。構造欠陥として妥当 |
| T1 | /accuracy /leaderboard /status が CSR のみ | /accuracy の SSR 本文に数値 0、"Loading the accuracy ledger" |
| T2 | LP §B の Visa 根拠リンク | HTTP 500 |
| F8 | header「Get API key」にクリック計測なし | `SiteHeader.tsx` に TrackedLink 0 件 |
| F3/F4 | /decisions /impact に受領証リンクなし | 両ファイルに basescan 参照 0 件 |
| F7 | 取った email に送る手段がない | package.json に送信ライブラリ 0 件 |

## 領域別の所見（要約）

### 可用性＋テキスト（P1 8）
- A1 テンプレート URL: L0 は `unverified(path_template)` に、L1 対象から除外、既公開 fail は corrections へ
- A2 方法論・FAQ を実態（Base + Solana、Solana は再読なし）に合わせる
- A3 `chainLabel` に Solana Devnet を追加し TESTNET_LABELS へ
- npm スコープ: LP/docs「@vouchscore が唯一」と `npm i @vet402/sdk` が自己矛盾 → 「@vet402 が正典、@vouchscore は旧名」
- 主読者が頁ごとに逆（LP=買い手、FAQ Q5/Legal=売り手）
- L2 語彙: LP `conform/mismatch/undeclared` vs 方法論 `match/mismatch/no_declaration/not_checked`
- T1 CSR のみ 3 頁、T2 Visa リンク 500
- P2: og:image 24 頁欠落、/demo の title 二重、sitemap 欠落 7 頁、/docs と /agent が 404、DIRECTION CONTRACT コメントが本番 HTML に配信、401 本文に案内なし、数字の突合不能（520 vs 980、14,968 vs 14,967）、Network 列の `eip155:8453`/`base` 混在、/status の二重否定、leaderboard の 3 呼称 ほか

### デザイン（Audit 15/20・Nielsen 29/40・本文コントラスト不合格 0）
- P1: /dashboard/login に RFC 奥付（`shell.tsx:87-93`）／/observatory の最初の画面に操作対象なし（検索 y=831・図 y=1046・表 y=1177 @1280）／表が紙幅 665px 超で主要列が初期非表示（/observatory 1264px、state By chain は 390 で数値列 0）
- P2: 積み上げバーの fail 段が実比 7.5 倍で注記なし・バー本体は色のみ／「Select a segment」だが押せるのは凡例／時間軸で非同日 2 点が重なる（09-01 23:40 と 09-02 05:40）／漏斗 3 段目 2.78px @390／state の折れ線が別文法／H1 `break-all`／figcaption 90ch／390 で H1 17px:H2 16px／1/3 endpoint の最初の画面に L1 なし／コピーボタンがコード末尾に重なる
- 報告書: `.impeccable/audit-2026-09-02-figures.md`

### セキュリティ（80 ルート全読）
- P1 S1 SSRF IPv6 迂回。修正: 8 グループ展開で `::ffff:0:0/96`・`::/96`・`64:ff9b::/96`・`2002::/16` の埋め込み v4 を `isPublicIPv4` へ。テストに 5 形式追加
- P2: L0/L1 の DNS リバインディング窓（webhook 同様のソケット固定を）／`Idempotency-Key` 再送で `/decision` を再計算し月次枠を実質消費しない／異議 7 日 3 件が TOCTOU／pg 例外を丸ごと console.error 11 箇所／signup にメール確認なし（先取り登録）／`npm audit` high 3（bigint-buffer、Solana L1 既定 OFF）／SSE `/observatory/live` が 55 秒占有／`lookup.ts:121` LIKE の `_` 未エスケープ
- 所見なし（根拠付き）: 認可・IDOR・cron 認証・予算の原子性・Stripe 署名/冪等・CSP/HSTS/CORS・秘密のコミット・エラー本文の露出

### コード品質＋完全性（typecheck 0・eslint warning 1・tests 937 pass/36 skip・next build 緑）
- P0 C1 Solana 索引の欠落固定（`index-solana.ts:28-29,66-72,85-90,132-134`）
- P1: OpenAPI `ErrorResponse.error` enum に新規 12 語なし／新規 8 ルートの 200 schema なし（SellerFacts 等が SURFACES 外）／`invalidateDecisionCache` 呼び出し 0／L1 異議（subject=l1）が L0 再測定のみ／`offer_stability` が本番で `drifting` になり得ない／`REGISTRY_WRITE_TIERS` 未実装／Registry フックの `settled` が自己申告／§7.3「1 分以内」は settled 起点のみ（購入→逆引き最短 2h）／受け入れテストが文字列 grep 相当／passport `facts_summary` テスト 0／L2 mismatch diff 非公開／SDK・MCP README 不一致／docs/api・llms.txt に新規 9 ルート 0／corrections・decision_lookups の失敗を無言で握りつぶす／`index-evm.ts` テスト 0／`recipient` 別名が strict 経路にも
- P2 主要: badge の `revalidate`+`force-dynamic` 併記（死んだ宣言）／`layout.tsx:136` の `headers()` で全ページ動的＝各頁の `revalidate` 無効／LP が毎リクエスト DB 5 往復（TTFB +100〜300ms）／`l0-accuracy` 分母膨張／`.catch(() => null)` 32 箇所／drizzle 戻り値正規化 39 箇所インライン／判定リテラル型 8 箇所別定義／`purchaseOne` 418 行／`src/lib` テスト無し 54 ファイル／`uuid` 未使用依存／`%25` 二重復号で 500

### 導線（3 読者の旅程）
- P1: F1 hero 主 CTA が payee ウォレット識別へ（製品の核＝endpoint 検証は fold から到達不能）※DESIGN.md は hero を再設計禁止としており**オーナー判断**／F2 観測所に L1 列なし（受領証つき 520 本がどれか不明）／F3 /decisions の endpoint・受領証がリンクでない／F4 /impact に tx ハッシュ 0／F5 /accuracy が 3 表とも 0 件／F6 endpoint 頁に異議入口なし／F7 段 2 の入口ゼロ・送信手段なし／F8 header CTA 未計測／F9 mobile §4 行動リンク 16px
- P2: /impact /decisions の inbound 1 本・sitemap 外／孤立 5 頁（/partners が唯一の email フォームで横はみ出し）／検索着地に製品説明なし／mobile hero 2 本目が fold で切れる／価格・無料枠が fold 外／payee クレームが API-only
- 最短 5 手: ①観測所 L1 列＋受領証あり既定並び ②/decisions リンク化＋/impact に最新受領証 5 件 ③endpoint 頁に通知・異議の email 欄 ④header と全 /signup を TrackedLink ⑤hero 主 CTA と §4 ボタン化

## オーナー判断が要るもの
1. F1: hero 主 CTA の行き先（DESIGN.md の凍結と衝突）
2. A1: テンプレート URL の扱い（unverified 化＋既公開 fail の訂正＝公開判定の書き換え）
3. MCP `check_resource_decision` の既定 role=payer が「払う前の判定」の凍結文言とほぼ同文（ハッカソン側の線引き）

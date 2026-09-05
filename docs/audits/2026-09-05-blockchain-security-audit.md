# vet402 ブロックチェーン製品セキュリティ監査（防御側・2026-09-05）

対象コミット `ec7a038`（main）。本番 https://vet402.com。読み取り専用で実施し、攻撃手順・PoC・呼び出し順は書かない。
実施: 執行部（統合・裏取り）＋ 監査エージェント 3 系統（A/B/C/I/G、E/F/H/M、D/N/決済検証。いずれも Opus）。
詳細は同日の 3 報告（scratch）を本文書に畳んだ。数字はすべて 2026-09-05 06:30〜07:00 JST の実測。

---

## 0. 監査条件

| 項目 | 内容 |
|---|---|
| 対象 | vet402 — x402 決済の観測所。L0（402 壁の探針）/ L1（自社資金で実購入・受領証をチェーンで照合）/ L2（スキーマ）/ decision API。**自社コントラクト無し**。触るのは Base の USDC（EIP-3009 を EIP-712 で署名）・Solana の SPL USDC・ERC-8004 Registry |
| 種別 | エージェント決済（買い手）。**売り手の x402 面は無い**（`src/app/api` に 402 応答 0 件・facilitator 呼び出し 0 件を実測。有料面は Stripe のみ） |
| アカウントモデル | EOA ホットウォレット 3 本（L1 購入・Registry 書き込み・Solana）。鍵は Vercel production env |
| ユーザー資金 | **触れない**。動くのは vet402 自身の運転資金（実測 Base USDC 46.20 / ETH 0.002、Solana USDC 6.19 / SOL 0.005）と、Stripe 経由の顧客カード決済 |
| 目的 | エージェント支出・x402 の権限設計（＋定期ヘルスチェック） |
| 見えた情報 | 全コード・本番 DB（SELECT）・本番 HTTP 応答・Vercel env 名・GitHub 設定・DNS/whois・チェーン残高（eth_call） |
| 見ていない情報 | Vercel/GitHub/Neon のメンバー・2FA・トークン棚卸し／RPC 提供者の内部／Vercel 側のアクセスログ保持期間／session.ts 本体 |
| 仮定 | 開発機は FileVault On（実測）。`DEMO_L1_ENABLED` は本番 env に**無い**（実測）＝デモは L0 のみ |

---

## 1. 厳しい診断

**この製品が実際に信じているもの。** 売り手・カタログ・ファシリテーター・RPC の 4 境界はコードが名指しで疑っており、402 応答の scheme / network / asset / EIP-712 ドメイン / payTo / 金額 のすべてを固定値かカタログ宣言との一致で縛る。信じているのは実行基盤である。Vercel（鍵と cron）・GitHub（main への push が 1 分弱で本番）・Neon（単一の全権ロール）・そして開発機のローカル控え 1 ファイル。ここに技術的な防壁は無い。

**今いちばん危険な信頼の一点。** 単一の鍵 `OBSERVATORY_WALLET_PRIVATE_KEY` は人間の関与なしに毎日実資金を動かす。ただしその資金は $46 程度で、上限は単一 SQL の原子予約で守られている。より重いのは**金ではなく台帳**である。`neondb_owner` と GitHub アカウントはどちらも「第三者が検算できる測定」という商品そのものを偽造でき、しかも同じ人・同じ機械・同じファイルに集まっている。

**損失シナリオ上位 5（クラス名）**

| # | クラス | 影響 | 成立に必要な前提 | 公開情報の証拠 | 未検証 | 今読む画面・文書 |
|---|---|---|---|---|---|---|
| 1 | 単一ホストへの秘密集約（Key management） | 資金 $46 + 台帳の全書き込み + admin 検閲 + 課金の同時取得 | 開発機 1 台の侵害 | ローカル控えに署名鍵・DB・admin・cron・Stripe が同居（変数名で確認）。launchd 3 本が毎日読む | Time Machine / クラウド同期への混入 | ASSET_REGISTRY の鍵表 |
| 2 | 実行時キルスイッチの不在（Operational control） | 異常を見つけても次の署名を止められない。露出は残りの日次枠 | 夜間に異常が起き、env 変更＋再デプロイが間に合わない | `budget.ts` は `process.env` のみ。DB に停止フラグ無し。起動点 4 系統 | 再デプロイ失敗時の挙動 | `budget.ts` / `l1-runner.ts` |
| 3 | 単一 RPC への全面信頼（Single source of truth） | 偽・改竄レシートが `settled` を通り、公開台帳・バッジ・スコアに恒久記録 | RPC 提供者または経路の侵害 | chainId・レシート・ログ・nonce をすべて同一 RPC から取る。第二プロバイダとの突合 0 件 | RPC 提供者の正直さ | `settlement-verify.ts` / `client.ts` |
| 4 | 証拠層の崩れ（Evidence tier collapse） | 公開の `settled` 1,629 のうち 1,558（95.6%）が nonce 束縛なしの旧判定。強い 71 行と区別できない | 無し（既に成立している状態） | 本番 SQL。ただし tx 重複 0 件・決済時刻は認可窓内（全 1,589 行が −1〜+62 秒）＝**使い回しの痕跡は無い** | 40 行の時刻未取得 | 方法論ページ・`/api/v1/observatory/state` |
| 5 | 変更制御の欠落（Change control） | CI が赤でも main → 本番。署名鍵を持つプロセスで無審査コードが動く | main への push 権限 1 つ | ruleset は force-push と削除の禁止のみ。30 日 515 コミット・PR は全期間 1 件。**9/4 監査記録の「ブランチ保護済み」は実態と食い違う** | — | `gh api rulesets/22261481` |

**5 秒セキュリティテスト: 条件付き合格。** 接続前に「誰が鍵を持つか」（vet402 自身・ユーザーの鍵は不要）「何にサインするか」（所有証明のみ・資金は動かない）「失敗したら誰が損するか」（vet402 の運転資金）は方法論と FAQ で読める。落ちるのは署名本文で、`Vouch verified payee registration` という**サイトに存在しない名前**で始まり、要求元ドメインが 1 行も無い。

---

## 2. スコアカード

各軸 0/3/6/9/10。**総合点は平均しない。資金が動く軸（権限・運用・エージェント支出・不変条件）の最低点＝ 6 が総合を決める。**

| 軸 | 点 | 根拠 1 行 | 比較対象 |
|---|---|---|---|
| 信頼モデル（A） | 9 | 4 つの外部境界がコード内に名指しで書かれ、破られたときの影響が「可用性と測定の正しさ」に限定。減点は基盤側が無防備 | coinbase/x402 リファレンス実装（同等以下）／オンチェーン境界を持つ小規模 DeFi（上） |
| 権限とアップグレード（B・C） | **6** | 粒度と最小化は良い（cron 16/16 認可・admin は理由必須＋透明性ログ）。だが署名鍵・DB owner・GitHub が 1 人 1 台 1 ファイルに集約、DB は単一全権ロール、main は無審査 push | Safe + 分離ロール運用（上）／単一 EOA + 単一 env の一般的 x402 クライアント（下） |
| コントラクト表面（D） | 9 | 自社コントラクト無し。EIP-712 ドメインをオンチェーン実測値で固定し売り手由来を拒否、署名前に 9 段の拒否漏斗。減点は単一 RPC と行の宣言チェーン未突合 | coinbase/x402 client（ドメインを `accept.extra` から読む既定。vet402 の方が厳しい） |
| 署名UX（E） | 6 | リプレイ防止（両方向 10 分窓＋単調書き込み）・改行注入防止・fail-closed は水準が高い。署名本文にオリジンが無く名乗りが 3 種類、disputes は構造的ブラインド署名 | Rabby / Safe / Coinbase Wallet |
| フロント供給網（F） | 6 | nonce CSP・HSTS preload・frame-ancestors none・正規ドメイン統一（llms.txt 32/32）は 9 相当。CI が門でない・本番 high 3・CAA/DNSSEC 無し・actions 可変タグ。**secret scanning 無効は本日有効化済み** | OpenSSF Scorecard の Branch-Protection / Pinned-Dependencies / Vulnerabilities |
| 経済と不変条件（G） | 9 | 日次 ≤ $25（実測最大 $20.52）・1 件 ≤ $1（最大 1.000000）・settled ⇒ 検証済み 1,629/1,629・in_flight 残留 0 を本番データで確認。減点は 95.6% が弱い判定、Registry の不変条件が一度も成立していない | 形式検証つきコントラクト（上）／不変条件がテストにしか無い実装（下） |
| 運用監視（H） | **6** | 「気づける力」は独立採点 **9**（無音死 3 件を自力で発見し計器を足した）。だが実行時停止が無く、警報は朝の定期報告まで届かず（最大 ~10h）、runbook・開示ポリシー無し | SRE 最低線（kill switch / on-call / runbook / secrets manager） |
| 監査証拠（N） | 6 | 自前 2 回の記録は具体的（対象コミット・本番実測・モデル比較・漏れ率台帳）。第三者ゼロ、9/4 の是正は同日自己申告、§D に「その tx がその購入のものか」の問いが無い | Zellic / Trail of Bits の公開レポートを持つプロトコル |
| エージェント支出（I） | 9 | 自分で署名して支出するが、上限はコードと単一 SQL で強制され、ランタイムは自分で上げられない（LLM 依存ゼロ）。減点はキルスイッチ到達時間が未定義 | ウォレット方針で上限を強制する運用（上）／env にしか上限が無い実装（下） |
| プライバシー（M） | 9 | ポリシーがコードから実測して書かれ、自分の虚偽記載を自己訂正している。差分は Low 2 件 | GDPR Art.13/14 |

---

## 3. 権限表

| 役割 | 種別 | できること | 1 鍵 compromise 時 | 遅延 | 確認状態 |
|---|---|---|---|---|---|
| `OBSERVATORY_WALLET_PRIVATE_KEY` | EOA（Base） | L1 購入の EIP-3009 署名 | USDC 46.20 / ETH 0.002 を即時全額流出。vet402 の payer を騙った偽レシート | 即時・不可逆 | 観察（残高は eth_call 実測） |
| `REGISTRY_OPERATOR_PRIVATE_KEY` | EOA（Base） | ERC-8004 に vet402 名義で verdict | ETH 0.009 は些末。**vet402 名義の偽検証結果をオンチェーンに恒久記録** | 即時・不可逆 | 観察（ローカル控え無し＝良い） |
| `OBSERVATORY_SOLANA_SECRET_KEY` | ed25519 | Solana L1 署名 | USDC 6.19 / SOL 0.005 流出 | 即時 | 推論（残高は 9/3 値） |
| `DATABASE_URL`（`neondb_owner`） | DB 全権 | アプリ・移行・ローカル script が同一ロール。ロール/DB 作成可・RLS バイパス | 公開台帳の任意書き換え・DROP。中心主張の全面偽造 | 即時 | 観察（9/4 に回転済み） |
| `CRON_SECRET` | Bearer | 16 本の cron を任意起動（l1-purchase 含む） | 日次枠内で購入を強制発火。上限は破れない | 即時 | 観察（16/16 が `authorizeCron`） |
| `ADMIN_SECRET` | Bearer | deep health・gate2・**グローバル・ブラックリスト** | 任意アドレスを全網で BLOCK（理由必須・透明性ログ自動掲載） | 即時 | 観察 |
| `API_KEY_PEPPER` / `DASHBOARD_SESSION_SECRET` | 秘密 | キー・セッションのハッシュ材料 | 既存キー/セッションの偽造 | 即時 | 観察（api_keys 4 件） |
| `STRIPE_*` | SaaS 鍵 | 課金・webhook | 偽 webhook でプラン昇格 | 即時 | 観察 |
| Vercel チーム `gokaku` env 書き込み | 管理面 | 上限（1 件は最大 $25 まで）・機能フラグ・鍵の差し替え | 上限再定義・任意鍵へ差し替え | env 変更＋再デプロイ 31s〜1m | 観察（メンバーは未観測） |
| GitHub `kzmttkc` | 管理面 | main へ直接 push → 自動本番 | **署名鍵を持つプロセスで任意コード** | 1 分弱 | 観察（ruleset 2 規則のみ） |
| 開発機のローカル控え 1 ファイル | 保管 | 上のうち署名鍵・DB・admin・cron・Stripe を平文保持 | 上記の**同時**発生 | 即時 | 観察（mode 600・FileVault On） |

---

## 4. 署名・承認のコピー監査

現行文は本番 GET の実文。

| # | 現行文（引用） | ユーザーが誤解する点 | 差し替え完成文 | 防ぐ失敗 |
|---|---|---|---|---|
| E-a payee 登録 | `Vouch verified payee registration` / `wallet: 0x…` / `name: …` / `issued: …Z` / `This signature only proves control of the wallet above.` | 製品名が「Vouch」でサイトに存在しない。要求元ドメインが無い | `vet402.com — verified payee registration` / `domain: vet402.com` / `wallet: 0x…` / `name: …` / `issued: …Z (valid 10 minutes)` / `This signature proves control of the wallet above. It moves no funds and grants no spending approval.` | 同一本文を出す偽サイトへの署名流用。10 分窓を知らず `signature_expired` |
| E-b x402 書き戻し | `Vouch x402 settlement attestation` / `wallet:` / `tx:` / `This signature only proves control of the wallet above for this settlement.` | 署名の結果（公開スコアに算入）が書かれていない | `vet402.com — x402 settlement attestation` / `domain: vet402.com` / `wallet:` / `tx:` / `Effect: this settlement will be counted toward the public score of the wallet above on vet402.com.` / `This signature moves no funds.` | 「所有証明のつもりが公開登録だった」という後からの異議 |
| E-c contributions | `vet402:contribution:v1:<id>:<verdict>:<status>:<ms>:<issued>`（単一行） | コロン区切りの塊。どの endpoint にどの判定かが読めない | 改行区切り: `vet402.com — external observation` / `endpoint:` / `verdict: pass` / `http status: 200` / `latency: 412 ms` / `issued:` / `Recorded in the public ledger. Not counted in the published verdict (v0).` | ブラインド署名。UI の表示と別の verdict を署名させる差し替え |
| E-d disputes | `vet402:dispute:v1:<id>:<subject>:<sha256(reason)>:<issued>` | 異議の本文が sha256 でしか入らず、署名画面で主張内容が読めない。再測定の結果が不利でも公開される | `vet402.com — measurement dispute` / `endpoint:` / `subject:` / `reason (first 200 chars): …` / `reason sha256:` / `issued:` / `Filing this will trigger a re-measurement whose result is published, including if it confirms the original verdict.` | 表示と別の本文を署名させること。不利な再測定を知らずに提出 |
| E-e watch 登録 | `vet402 observatory watch registration` … | ここだけ正しい名乗り。全体で Vouch / vet402 / vet402.com の 3 種混在 | 全メッセージの 1 行目を `vet402.com — <purpose>` に統一し `domain:` 行を必須に | 名乗りが揺れる限り偽物を識別できない |
| E-f API キー発行 | `New API key (copy now — shown once):` | 保管先と漏洩時の影響が無い | `New API key — shown once. Store it in a secret manager, not in a repo or a chat. Anyone holding it can spend your monthly quota and read your query logs. Lost it? Revoke and issue a new one; there is no recovery.` | チャット/リポへの貼り付け |
| E-g キー失効 | `Revoke this API key? This cannot be undone.` | 影響範囲（webhook 停止）が無い | `Revoke this key? Every integration using it stops immediately, including its webhooks. This cannot be undone — issue a new key first if you are rotating.` | 本番連携を止める事故 |
| E-h Stripe 中止 | `Checkout cancelled. No charge was made. You are still on {plan}.` | 誤解点なし。最良の承認文言 | 変更不要 | — |
| E-i プレイグラウンド | 「This page lets you run the L0 step yourself」 | 実測: 本番に `DEMO_L1_ENABLED` は**無い**＝デモは L0 のみ。文言と実装は一致 | 変更不要。L1 デモを有効化する日は「real, paid purchase from vet402's own wallet」を実行ボタンの直下に | 有効化時の「無料モック」誤解 |

良い点（実測）: 固定行の改行結合・制御文字と改行の拒否・`issued` の両方向 10 分窓・単一 SQL の単調書き込み・GET プレビューと失敗時の `expectedMessage`・fail-closed 検証。シード・秘密鍵を送らせる導線は無い（P0 該当なし）。

---

## 5. 証拠つき指摘（パターン単位）

| # | 名前（クラス） | 証拠 | 最悪影響 | 重大度 | 緊急度 | 今確認する手順（読む・見る） | 緩和の方針 |
|---|---|---|---|---|---|---|---|
| S-1 | 実行時キルスイッチの不在（Operational control）**— 同日是正 `1fddaf2`・本番実証済み** | `budget.ts:24` は `process.env` のみ。`grep PAUSE\|kill_switch` 0 件。起動点 4 系統。走行中バッチは自前デッドライン 210s のみ | 異常時に次の署名を止められない。露出は残りの日次枠 | Medium | **P0** | `budget.ts` と `schema.ts`（停止フラグ表が無いこと） | DB の 1 行を署名直前で読み fail-closed で止まる。再デプロイ不要。`acquireLease` は例外時に「通す」ので流用しない |
| S-2 | 秘密の集約と監視・実行の未分離（Key management / SoD） | ローカル控え 1 本に署名鍵・DB・admin・cron・Stripe（変数名で確認）。`vet402_l1_canary.py` がそれを読み実購入 cron を叩き直す | 1 台の侵害で資金・台帳・検閲・課金が同時に渡る。カナリアの誤判定が支出になる | High | P1 | `grep -oE '^[A-Z_0-9]+=' <控え>`（値は読まない）。`fdesetup status`（**On を実測**） | 署名鍵と DATABASE_URL をローカルから外す。カナリア用に cron 起動だけの別秘密。資金鍵と管理秘密を別ファイル |
| S-3 | 単一 RPC への全面信頼（Single source of truth） | `client.ts:96-101` は 1 本だけ選ぶ。`settlement-verify.ts:159-259` は chainId・レシート・ログ・nonce をすべて同一 RPC から。Blockscout は決済突合に未使用 | 偽レシートが settled を通り恒久記録。中心主張が第三者に検算できない 1 本の接続に載る | High | P1 | 本番 `INDEXER_RPC_URL` / `BASE_RPC_URL` の名前の有無（実測: 両方あり）。無作為 30 行を別プロバイダで再読 | 日次で無作為 n 件を独立プロバイダで再読し、食い違いを fail-loud。判定ロジックは共通のまま「読む口」だけ分離 |
| S-4 | 証拠層の崩れ（Evidence tier collapse）**— 同日是正 `ae5ff67`・本番: `l1.settledNonceBound 71 / settledAmountPayeeOnly 1,558 / settledTimeWindowOk 1,589`・`l1.byChain`（Base nonceBound 71 / Solana 0）・方法論 2 段落・corrections 1 行** | `settlement_verified=true` 1,629 のうち `auth_nonce IS NULL` 1,558（95.6%）。照合器は NULL 行しか引かず再照合されない。公開 `l1.settled=1629` はこの合計 | 弱い規則で確定した行が強い行と区別されず公開 | Medium | P1 | 上の SQL。決済時刻 − 試行時刻を全行で（実測 1,589 行が −1〜+62 秒・tx 重複 0） | 「決済時刻が認可窓内」を遡及の関門として足し層を分ける。公開面に 2 層を出す。無実の売り手を refuted にしない |
| S-5 | 変更制御の欠落と記録の食い違い（Change control / Self-graded remediation） | ruleset 22261481 は `non_fast_forward` と `deletion` のみ。9/4 記録は「main のブランチ保護」を実施済みと記載 | CI 赤でも本番へ。次の監査がここを再検査しない | Medium | P1 | `gh api repos/kzmttkc/vet402/rulesets/22261481` | CI 失敗を即時通知（issue）に載せ、資金経路 4 ファイルは required check の対象に。**9/4 記録を実測へ訂正** |
| S-6 | 署名本文のオリジン束縛欠如と名乗りの分裂（Signature phishing resistance）**— 同日是正 `4ba2274`・本番実測: 1 行目 `vet402.com — verified payee registration`・`domain:` 行必須・旧形式は 09-21 まで互換** | 本番実文 `Vouch verified payee registration`。`x402-verify.ts:23`。`verify-message.ts:107` | 同一本文を出す偽サイトが正規署名を集められる | Medium | P1 | `curl -sL ".../api/v1/payees/verify?wallet=…&name=X"` の `message` に `vet402.com` が無いことを見る | 1 行目 `vet402.com — <purpose>`・`domain:` 行必須。旧形式は読み取り互換のみ |
| S-7 | disputes のブラインド署名（Signed-payload legibility） | `disputes.ts:46-53` が本文を sha256 でしか畳まない | 表示と別の本文を署名させられる。公開訂正の根拠が署名者に読めない | Medium | P1 | 同ファイルを読む | 先頭 200 字の平文＋sha256 の併記（v2 接頭辞） |
| S-8 | 警報の到達遅延（Alert delivery） | canary / zero_success / watchdog は `state/ALERTS.md` 追記のみ。即時は uptime workflow（`/api/health` の 200 だけ） | 資金経路の異常が朝まで届かない（最大 ~10h） | Medium | P1 | 3 スクリプトを `grep -n ALERTS` | 資金経路に限り GitHub issue（無料でメール）へ横展開。全件は通知しない |
| S-9 | DB 単一全権ロール（Least privilege） | `\du`: ロール作成・DB 作成・レプリケーション・RLS バイパス。監査すら owner で実施 | `DATABASE_URL` 漏洩＝台帳の DDL 権限 | Medium | P1 | `psql -c '\du'` | 読み取り専用ロールと DML のみのアプリロール。owner は移行だけ |
| S-10 | 本番依存の high 3（Vulnerable dependency） | `npm audit --omit=dev`: `@solana/spl-token` → `bigint-buffer`（GHSA-3gc7-fjrx-p6mg）。**修正版は無く**、audit の fix は spl-token 0.1.8 への major ダウングレードのみ | Solana 署名経路のバッファ処理に既知 overflow。悪用条件は未検証 | Medium | P1 | `npm audit --omit=dev` | 上流の修正を監視。Solana は少額（$6）に留める。代替: `@solana/kit` 系への移行を 90 日で検討 |
| S-11 | 不可逆操作の関門が資金リポに無い（Missing guardrail） | 管理リポの PreToolUse は `~/vouch` に効かない | 9/4 に鍵を失った操作クラスが鍵のある側で無防備 | Medium | P1 | `~/vouch/.claude/` を見る | **本日 `settings.local.json` に同じ関門を設置（gitignored）** |
| S-12 | CAA 無し・DNSSEC 未署名（Domain control） | `dig CAA` 空・whois `DNSSEC: unsigned`。レジストラロックはあり | 任意 CA が証明書を発行できる | Low | P1 | 上 2 コマンド | Porkbun で CAA（Let's Encrypt 限定）と DNSSEC を有効化（**Takeshi 手番**） |
| S-13 | Actions 可変タグ・plausible が strict-dynamic で無制約（Supply chain） | `actions/*@v4`・`sha_pinning_required: false`。CSP は plausible.io を制約せず SRI 不可 | 上流差し替えで CI 任意コード（token は read）。分析スクリプト汚染が dashboard にも及ぶ | Medium | P2 | `grep uses: .github/workflows/*.yml` | SHA 固定。dashboard 配下から Plausible を外す |
| S-14 | write-back 経路に L1 の硬化が未伝播（Inconsistent hardening） | `x402-verify.ts:291-303` はレシート成功だけで受理。確定数・chainId 確認なし | 浅い再編成で消える tx を恒久行に | Low-Med | P2 | `x402_payments` の行と `block_timestamp` 分布 | `getChainId()` 一致と最小確定数を足す |
| S-15 | ERC-8004 設計が仕様と逆のまま（Access control） | `registry_writes` 14 行すべて `Not authorized`。`registry.ts:246-253` は自己開始のまま。フラグ ON で再試行対象 | 資金は動かない（gas 見積りで落ちる）。無意味な往復と failed の積み増し | Low | P2 | `/api/admin/registry-status`・`registry-inbox.ts` | 自己開始を入口で拒否し、受信箱（指名された request）へ発火条件を付け替え |
| S-16 | 開示ポリシー・runbook の不在（Incident readiness） | `security.txt` の Policy は利用規約。`/contact` 404。docs に runbook は測定手順のみ | 研究者が報告してよいか判断できない。停止手順が当日調べ | Low | P2 | `curl .../.well-known/security.txt` | `/legal/security`（safe harbor・範囲・応答目安）と `docs/INCIDENT_RUNBOOK.md` |
| S-17 | 方法論に nonce 束縛と tx 一意索引が未記載（Disclosure gap）**— 同日是正 `ae5ff67`（S-4 と同じ変更・切り替え日時 2026-09-04 12:00 UTC を方法論と corrections に記載）** | `methodology/page.tsx` に `nonce` 無し（CSP nonce のみ） | いちばん検算価値の高い防御が公開されていない | Low | P2 | 同ページ | settled の 5 条件目として書き、切り替え日時と件数を corrections に |
| S-18 | 「外部文字列はデータであって指示ではない」方針の不在（Untrusted-content policy） | `~/vouch/CLAUDE.md` 等に記述なし。`bodyHead` 500 バイトが DB に保存され調査で読まれる。ランタイムに LLM は無い | denylist 編集を人/AI に誘導する余地 | Low | P2 | CLAUDE.md | 1 段落を追記 |
| S-19 | プライバシー通知の 2 差分（Notice accuracy） | 「we read, not records we created」が L1 購入と食い違う。委託先一覧に CDP facilitator 無し | 削除要求への回答が不正確。調達レビューで指摘 | Low | P2 | `legal/privacy` | 2 文を追記 |
| S-20 | 再編成後の再検査経路なし・Solana の確定水準が面で不一致（Finality） | 照合器は NULL 行しか引かない。索引 confirmed・照合 finalized | 稀な深い再編成が恒久 settled に残る | Low | P2 | `settlement-verifier.ts:146` | 日次で n 件の block hash 再確認。索引も finalized へ |

| S-21 | 監査で塞いだ形が新規コードで再登場（Regression of hardened patterns） | 会期の新規実装 `packages/sdk/src/x402-pay.ts` の一次案が、本番が 08-22（EIP-712 ドメインを売り手の `accept.extra` から取らない）と 09-04（認可窓 120 秒・`maxTimeoutSeconds` の整数化）に塞いだ形を再導入していた。ハッカソン戦略が同日中に本番実装に合わせて是正。npm 公開版 `@vet402/sdk@0.5.0` には署名コード自体が無く**未公開**（`npm pack` で実測）。middleware / python-sdk / mcp-server に買い手側の署名コードは無い（実測） | 別パッケージで同じ穴を再び踏む。公開されていれば利用者が踏んだ | Low（未公開） | P2 | `npm pack @vet402/sdk@latest` で現物を見る。`WINDOW_PLAN.md` §14.1-14.2 | 署名前の関門 5 つを「本番 L1 と SDK が同じ定数・同じ順で通る」形に共通化し、片方だけ直る構造を無くす（会期後） |
| S-22 | 公開 2 面の内部不整合（Public-surface reconciliation）**— 同日是正 `743abac`＋本番再集計** | `history`（日次 10:37 UTC 凍結の集計）と `state`（live）で L1 が 3,065/1,387 vs 3,241/1,629。決済確認 cron（14:00 UTC）が集計より後に走り、後から settled になった行が永久に入らなかった（Base 221 件・13 日分）。Solana 50 vs 38 は `network` NULL の 53 行（金は動いていない）を旧集計が attempts に数えていたため。ディストリビューション戦略が第三者として発見 | 検証を売る製品の内部不整合。外部の誤りより重い | Medium | P1 | `history` の 98 日合計と `state.l1` を同時取得して差を見る | 集計を直近 14 日毎回再計算（冪等）・全期間再集計・応答に `coverageFrom` / `rolledUpThrough` / `lastRollupAt` / `semantics`。**本番で差 0 を実測** |
---

## 6. 実行計画

各件: 仮説 / 確認方法 / ICE（Impact・Confidence・Ease 各 1-5）/ 成功条件 / 戻し条件。攻撃の実施は成功条件にしない。

**今日**

| 件 | 仮説 | 確認方法 | ICE | 成功条件 | 戻し条件 | 状態 |
|---|---|---|---|---|---|---|
| GitHub の secret scanning / push protection / Dependabot を有効化 | 鍵の誤 push を「事故後に気づく」から「事故らせない」へ | `gh api repos/kzmttkc/vet402 --jq .security_and_analysis` | 4/5/5 | 3 つとも `enabled` | 誤検知で push が止まる場合は bypass 理由を記録して個別解除 | **完了（実測 enabled）** |
| 不可逆操作の関門を `~/vouch` に設置 | 鍵のある側で `vercel env rm` 等を止める | `~/vouch/.claude/settings.local.json` | 4/5/5 | 同じコマンド群が止まる | 誤停止が続くなら matcher を狭める | **完了（gitignored）** |
| 停止手段の実測とデモ経路の確認 | 本番でデモは L1 を撃てない | `vercel env ls production` に `DEMO_L1_ENABLED` が無い | 3/5/5 | 無い | — | **完了（無し＝L0 のみ）** |

**7 日**

| 件 | 仮説 | 確認方法 | ICE | 成功条件 | 戻し条件 |
|---|---|---|---|---|---|
| DB 1 行の実行時キルスイッチ（S-1） | 再デプロイ無しで次の署名から止まる | pg テストで halted 時に予約が消費されない。本番で GET が現在値を返す | 5/5/4 | 停止 POST から次の購入試行が `halted` で戻る。deep health に表示 | フラグ表が壊れたら fail-closed で止まる（安全側） **→ 完了（同日 main `1fddaf2`）。本番実証: 停止 POST → `/api/cron/l1-purchase` が `attempted:0, halted:true` で戻り購入行 0 → 解除 → deep health `spending_halt: off`。runbook `docs/INCIDENT_RUNBOOK.md`** |
| ローカル控えから署名鍵と DATABASE_URL を外し、カナリアに cron 専用秘密（S-2） | 監視役が支出権限を持たない | 控えの変数名一覧に鍵が無い。カナリアが専用秘密で 200 | 5/4/3 | launchd 3 本が新秘密で動き、控えに鍵が無い | 復旧手順（Vercel から再設定）を runbook に先に書く |
| 第二 RPC による日次サンプル再照合（S-3） | 単一接続の偽応答を検出できる | 無作為 30 行の logs 一致率 | 5/4/3 | 食い違い 0 件が日次で記録され、1 件でも出れば ALERTS | 第二プロバイダ障害は「未照合」扱いで否定に倒さない |
| settled の 2 層公開と方法論・corrections 追記（S-4・S-17） | 強度を隠さず示す | `/api/v1/observatory/state` に `settled_nonce_bound` が出る | 4/5/4 | 71/1,558 の内訳が公開され、切り替え日時が corrections に | — |
| 署名本文のドメイン束縛と名乗り統一（S-6） | 偽サイトへの流用を署名者が見抜ける | GET プレビューの 1 行目が `vet402.com —` | 4/5/4 | 全 5 面が新形式。旧形式は受理しない（猶予 7 日） | 既存の SDK 利用者が落ちる場合は旧形式の受理期間を延ばす |
| CI 失敗の即時通知と actions SHA 固定（S-5・S-13） | 赤 main が 10 分以内に issue になる | 失敗 run が issue を開く | 3/5/5 | issue 自動起票。`uses:` が全て SHA | — |
| 9/4 監査記録の「ブランチ保護済み」を実測へ訂正（S-5） | 記録と実態の一致 | 記録の文言 | 3/5/5 | 「force-push と削除の禁止のみ」と書き直す | — |

**30 日**

| 件 | 仮説 | 確認方法 | ICE | 成功条件 | 戻し条件 |
|---|---|---|---|---|---|
| 読み取り専用ロールと DML 専用アプリロール（S-9） | 漏洩＝DDL にならない | `\du` と各接続の current_user | 4/4/3 | 監査・now.py・ローカルは RO、アプリは DML、移行だけ owner | 権限不足の 500 が出たら owner に戻し、足りない GRANT を追加 |
| 資金経路の警報を GitHub issue へ（S-8） | 深夜の異常が 10 分で届く | zero_success の L1 判定で issue | 4/5/4 | 実障害 1 件が issue で届く | 通知過多なら判定を絞る |
| disputes / contributions の人間可読 v2（S-7） | ブラインド署名を無くす | 署名画面の実文 | 3/5/4 | v2 のみ受理 | — |
| write-back の chainId・確定数（S-14） | L1 と同じ硬化 | テスト | 3/5/5 | 浅い tx が拒否される | — |
| `/legal/security` と `docs/INCIDENT_RUNBOOK.md`（S-16） | 報告と停止の最初の 1 手が読める | security.txt の Policy が新ページを指す | 3/5/5 | safe harbor・範囲・応答目安・最初の 1 コマンド | — |
| CAA と DNSSEC（S-12・**Takeshi 手番**） | 身元の最下層を固める | `dig CAA`・whois | 3/5/4 | CAA 1 行・DNSSEC signed | 証明書更新が失敗したら CAA を一時削除 |
| ERC-8004 の発火条件を受信箱へ（S-15） | 仕様どおりの向きで書ける | 受信箱に request があれば応答 tx | 3/4/3 | 成功 1 件の tx | 0 件なら OFF のまま |

**90 日**

| 件 | 仮説 | 確認方法 | ICE | 成功条件 | 戻し条件 |
|---|---|---|---|---|---|
| 外部レビュー（収益が立ってから） | 自前監査の漏れ率を第三者で測る | `external_findings.json` の them 件数 | 4/3/2 | them が増えない | — |
| バウンティは見送り、開示ポリシーで代替 | トラクション 0 で賞金は不要 | — | 2/5/5 | — | — |
| 定期再監査の型に「その tx がその購入のものか」を追加（N） | 最重要欠陥はこの問いからしか出ない | `PENTEST_SCOPE.md` §D | 3/5/5 | §D に 1 行 | — |
| 再編成サンプル監視と Solana 確定水準の統一（S-20） | 深い再編成に気づける | 日次 n 件の block hash | 2/4/4 | 食い違い 0 件が記録される | — |
| Solana 依存の置き換え検討（S-10） | high 3 を消す | `npm audit` | 3/3/2 | high 0 | 移行で照合が壊れるなら戻す |

---

## 7. 再現すべき強み（最大 3 つ）

1. **「売り手が言った」を「我々が読んだ」に置き換える。** settled を書けるのは照合器だけで、ランナーは claimed 止まり。同じ原則を write-back・Registry・通知にも横展開する。
2. **金の関門は単一 SQL 文に置く。** 予約・上限・冪等をひとつの文で評価し、read-then-write の隙を作らない。キルスイッチも同じ場所・同じ作法で置く。
3. **規律ではなく計器を足す。** 無音死 3 件を自力で見つけ、そのたびに検知器を増やした。次は「届くまで」の時間を同じやり方で縮める。

---

### 7.1 同日追記 — 会期の実装で 3 度出た「壊れて見えない」型（再現すべき強みの裏側）

エラーが出ず、それらしい別の理由で正しく見える答えが返る。監査の道具でも設計でも同じ形で出た。
- `minSubgraphReceipts` が既定 `source` で黙って無視される（床を指定したのに拒否も警告も出ない）
- カタログ外（`/decision` 404）経路で `policy.evidence` が丸ごと無視される（いちばん要る場所で効いていない）
- The Graph Gateway は鍵無しで HTTP 200＋GraphQL `errors`（`response.ok` だけ見ると「認証失敗」が「受領 0」にすり替わる）
- 本監査の道具側: `db:drift` が unique 制約を読まず欠落を 0 件で通した／claims 抽出器が `<code>/files/*</code>` の `/*` をコメント開始と誤読し断定 10 件を走査から外した
**対処の型**: 「触ったファイル」でなく「壊した不変条件」で検査する（main 投入前はリポ直下の全体テストを 1 回・`verify-the-invariant-not-the-files-touched`）／新しいテストは実装なしで緑にならないかを変異で確かめる／「不在」と「0」をエラーに見せる。
同日追加の公開フィールド（ハッカソンの `payOrRefuse` が「新鮮さを装わない」ために読む）: `state.spendingHalted`・`state.l1.lastAttemptAt`・`/decision` の `spending_halted`・`facts.l1.last_attempt_at`・`not_attempted_reason`（`spending_halted` | `no_eligible_accept` | null）。停止中の未試行を売り手の落ち度に見せない。

## 8. Kill list（今やってはいけないこと）

- 署名鍵をローカルの控えや別のリポ・チャットへコピーする（Vercel と物理媒体以外に置かない）
- 1 件上限 `OBSERVATORY_L1_MAX_PURCHASE_UNITS` を env で引き上げる（上げる方向の設定面を持たない）
- `acquireLease` をキルスイッチ代わりに使う（例外時に「通す」設計）
- `REGISTRY_WRITES_ENABLED` を設計修正前に ON にする（14 行が再試行される）
- `DEMO_L1_ENABLED` を文言修正なしで ON にする
- 「監査済み」「ブランチ保護済み」を実測なしで記録に書く
- 無限承認・単一 EOA へのユーザー資金・エージェントへの無期限署名権限（該当なし。今後も作らない）
- シードや秘密鍵をサポートへ送れと書く（該当なし）

---

## 9. 次に確認する証拠（未観測のうち最初の 5 つ）

| # | 定義 | 見る場所 | 分かれば合格 / 分からなければ不合格 |
|---|---|---|---|
| 1 | 第二 RPC で `settlement_verified=true` 無作為 30 行のレシート logs が一致するか | 別プロバイダの `getTransactionReceipt` | 30/30 一致で合格。1 件でも食い違えば S-3 は Critical |
| 2 | Neon の PITR 設定と、1 回の復元実演 | Neon コンソール → Backups。復元先ブランチで行数一致 | 復元できて合格。設定だけでは不合格 |
| 3 | Vercel チーム `gokaku` と GitHub `kzmttkc` のメンバー・トークン・2FA | 各ダッシュボードの Settings | メンバー 1・PAT 棚卸し済み・2FA On で合格 |
| 4 | Resend 経由の record 通知が 1 件でも配信されたか | 通知台帳の `status='sent'` 件数 | 1 件以上で合格。0 件なら registry と同型の「成功 0」 |
| 5 | Registry / Solana 鍵の回転が実施されたか | `vercel env ls` の更新日（9/13 以降） | 更新されていれば合格 |

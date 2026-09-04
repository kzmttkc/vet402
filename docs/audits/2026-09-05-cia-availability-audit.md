# vet402 機密性・完全性・可用性（CIA）＋機能/ネットワーク可用性 監査（2026-09-05）

同日の 2 監査（防御側 9 軸 `2026-09-05-blockchain-security-audit.md`・レッドチーム `2026-09-05-red-team-attack-tree.md`）を
CIA の三軸に組み直し、**それらが見ていなかった可用性**を新たに実測して足した。数字はすべて 2026-09-05 07:30〜08:10 JST の一次データ。
読み取り専用で実施。実装したのは監視計器 2 本（管理リポ）のみで、本番には触れていない。

## 0. 総括

| 軸 | 点（0/3/6/9/10） | 一行 |
|---|---|---|
| 機密性 C | **6** | 秘密の設計（sensitive env・定数時間比較・fail-closed・PII の最小化）は良い。落とすのは「1 台 1 ファイルに全秘密」と「共有 production env から署名鍵が読める」構造 |
| 完全性 I | **6 → 7** | 台帳の検証（settled の定義・nonce 束縛・一意索引・db:drift）は強い。**外部の不変スナップショットが無かった**のを本日塞いだ（復元・改竄検知・削除検知を実証） |
| 可用性 A | **3 → 4** | **直近 18 日で障害 3 件・合計 13 時間（約 97%）・最長 10 時間 36 分は原因が記録されていない**。Neon PITR 6 時間・単一 DB・単一 RPC・Vercel Hobby（SLA 無し）・Time Machine 停止。本日、台帳の RPO を「6 時間」から「1 日・オフボックス」に下げた |
| 機能可用性 | **7** | fail-closed・レート制限・キルスイッチ（本日）・cron 16 本すべて日次（Hobby 安全）・deep health による自己診断 |
| ネットワーク | **6** | CSP nonce / HSTS preload / frame DENY は上位。**CAA 空・DNSSEC 未署名**（手番待ち）。本日 CT 監視を導入 |

**総合は最低点の可用性（4）が決める。** セキュリティは 2 日で大きく上げたが、「壊れたら戻せるか・どれだけ止まるか」が最も弱い。

## 1. 機密性（Confidentiality）

**守れているもの（実測）**
- 署名 3 鍵・DB・admin・cron・pepper・Stripe は Vercel で `type: sensitive`（dashboard/pull/API で読み戻し不可）。
- 秘密の比較はすべて `secureCompare`（sha256 → timingSafeEqual・定数時間）。env 未設定は fail-closed。本番 env バリデータが低エントロピーを拒否。
- API キーは pepper 付きハッシュ保存・exact match。セッションは 32 バイト乱数・sha256 保存・httpOnly/secure/sameSite=strict・ログイン時に既存セッション全削除。
- PII: IP は 90 日で NULL 化、購読者 IP は一方向ハッシュ、Plausible は cookieless。プライバシーポリシーはコードから実測して書かれ、差分は Low 2 件のみ。
- ログ・エラー・health・API 応答・source map・過去コミットに秘密の実値が無い（レッドチーム KC-6 で確認）。
- 公開リポ: secret scanning・push 保護・Dependabot を本日有効化。

**落としているもの**
- **C-1 秘密の集約（High）**: 開発機 1 ファイル（mode 600・FileVault On）に署名鍵・DB・admin・cron・Stripe が同居し、launchd 3 本が毎日読む。検知器（カナリア）が支出権限を持つ。→ WO S-2（秘密の分離・cron 専用秘密）。
- **C-2 署名鍵が共有 production env から読める（High）**: Vercel にビルド/実行の分離は無く、無審査 push・依存侵害・admin 鍵集約の 3 チェーンが収束。→ WO 最優先「署名鍵の隔離」。
- **C-3 DB 単一全権ロール（Medium）**: 監査すら owner で行う。→ WO S-9。
- C-4 `/operator-log` の理由文の逐語公開は透明性の器を悪用されうる（Low）。

## 2. 完全性（Integrity）

**守れているもの（実測）**
- `settled` を書けるのは照合器だけ。定義は「我々がチェーンで読んだ」（Transfer 5 条件＋nonce の AuthorizationUsed＋32 確定＋chainId 毎回確認）。tx 一意索引で再利用不能（本番 distinct 1,634/1,634）。
- 決済索引の失敗は ok:false、lease で二重実行なし、`db:drift` が schema.ts と本番を毎日突合（本日 unique 制約も比較対象に）。
- 公開面の数字と正典の突合（surface_scan・claims canary）が毎朝走る。
- 本日、公開台帳の復元を実証: `x402_l1_purchases` 3,294 行を snapshot から TEMP 表へ戻し、manifest と一致・status 内訳（settled 1,629）も保持。

**落としているもの**
- **I-1 証拠層の崩れ（Medium）**: settled 1,629 のうち 1,558（95.6%）は nonce 束縛なしの旧判定。痕跡は無いが公開面で区別されていない。→ WO S-4（2 層公開）。
- **I-2 単一 RPC（High）**: chainId・レシート・ログ・nonce を同一 RPC 1 本から取る。→ WO S-3。
- **I-3 外部不変スナップショットの不在（High）→ 本日塞いだ**: `scripts/vet402_ledger_snapshot.py`（毎日 04:20・公開表 8 本＋settlements 日次集約・sha256 連鎖・前日の再検証・行数急減の検知・iCloud 複製・30 日保持）。scratch で改竄（BadGzipFile）と削除（20% 減）の両方が警報になることを実証。**顧客データ（api_keys・trust_events）は含めない**（機密性）。
- I-4 再編成後の再検査経路なし・Solana の確定水準が面で不一致（Low）。→ WO S-20。

## 3. 可用性（Availability）— 本監査で新たに実測

### 3.1 実績

| 障害 | 開始 → 復旧（UTC） | 継続 | 原因 |
|---|---|---|---|
| #2 | 2026-08-18 23:56 → 08-19 01:45 | 1h49m | 503 `status=error`（記録なし） |
| #3 | 2026-08-21 21:00 → 21:36 | 36m | 503 `degraded`（記録なし） |
| #6 | 2026-08-27 02:26 → 13:02 | **10h36m** | 503 `degraded`（**記録なし**） |
| （9/2） | 2026-09-02 20:43 UTC〜 | 索引停止 17 回 | Neon 512MB 上限（53100）。ok:true で報告されていた（9/4 是正） |

- 監視窓 8/18〜9/5（約 432 時間）で **停止 13 時間 → 約 97.0%**。月換算で 99% を割る。
- **3 件とも事後検証（postmortem）が無い。** 10 時間 36 分の障害が「503 degraded」の一行しか残っていない。uptime workflow は起票と自動クローズはするが、原因を書く手順が無い。
- 検知は良い（10 分間隔・GitHub issue 自動）。**復旧が遅い**のは、深夜（JST 11:26〜22:02）で人が見ていなかったから。深夜の障害は人が起きるまで続く＝ MTTR が人の睡眠に依存。

### 3.2 構造（単一障害点）

| 層 | 実測 | 判定 |
|---|---|---|
| ホスティング | Vercel **Hobby**（SLA 無し・関数の同時実行と実行時間に上限・リージョン指定なし＝既定 1 リージョン） | 単一 |
| DB | Neon 1 プロジェクト・1 ブランチ・aws-us-east-2・**PITR 保持 6 時間（21600 秒）**・548 MB | 単一・**RPO 6h** |
| バックアップ | Neon の PITR のみだった → 本日 **オフボックス日次スナップショット**（ローカル＋iCloud・復元実証済み） | **RPO 1 日（公開台帳）** |
| RPC | Base 1 本・Solana 1 本。第二プロバイダ無し | 単一 |
| 決済索引の遅れ | settlements 82 ブロック（良）・feedback 36,934 ブロック（閾値内・約 20 時間） | 許容 |
| cron | 16 本すべて日次（Hobby の制約内）。同時刻 10:30 に 2 本 | 許容 |
| 開発機（launchd 9 本・秘密の控え） | **Time Machine の宛先がマウントできず停止**。iCloud Drive は生きている | **バックアップ無し** |
| DNS | Porkbun・CAA 空・DNSSEC 未署名・転送/削除ロック有効・期限 2027-08-12 | 手番待ち |

### 3.3 RTO / RPO（定義されていなかったので、本監査で定める）

| 資産 | RPO（失ってよい期間） | RTO（戻すまで） | 現状 |
|---|---|---|---|
| 公開台帳（購入・受領証・endpoint・集約） | **1 日**（本日から） | 1 時間（snapshot → `\copy`・手順は script 冒頭） | 達成（復元実証） |
| 生の settlements（30 日分・379MB） | 6 時間（Neon PITR）。それ以上は再索引で再構築可能（チェーンが正） | 再索引 数時間 | 許容（チェーンから再構築できる） |
| 顧客データ（api_keys・trust_events・購読） | 6 時間（Neon PITR） | Neon の復元 | **弱い**（オフボックス無し。顧客 4 キー・実害小・要判断） |
| サイト稼働 | — | 現状 MTTR 36 分〜10 時間 | **弱い**（深夜依存） |

### 3.4 可用性の是正（順序）

1. **本日**: オフボックス日次スナップショット（完了）・CT 監視（完了）・キルスイッチ（完了）。
2. **手番（費用あり・要承認）**: Neon の PITR 保持を 6 時間 → 7 日へ。Launch プランは履歴を保存量で課金。実測の増分（1 日 2〜3 万行 × 1.1 KB ≈ 30 MB/日 × 7 日 ≈ 0.2 GB）で **月 $0.1 未満**。→ TAKESHI_TODO。
3. **手番**: Time Machine の宛先を復旧（開発機の秘密の控えと launchd の設定が現在バックアップ無し）。
4. **7 日**: postmortem の型（`docs/INCIDENT_RUNBOOK.md` に「障害 issue を閉じるとき原因を 3 行書く」を追加）。uptime workflow の issue 本文に deep health の失敗チェック名を自動で入れる（今は 503 の一行）。
5. **30 日**: 第二 RPC（S-3）・DB ロール分離（S-9）。深夜障害の自動復旧（Vercel の再デプロイ／Neon のコンピュート再起動を watchdog から叩ける経路。**資金経路には触れない**）。
6. **90 日**: Vercel Pro への移行判断（SLA・関数上限・複数リージョン）は収益が立ってから（`traction-before-infra-spend`）。

## 4. 機能可用性

- fail-closed が全面に貫かれている（読めない入力を「確認済み」と報告しない・degraded は BLOCK）。
- **実行時キルスイッチ**（本日）: DB 1 行で次の署名から止まる。本番実証済み。
- レート制限（IP 単位・デモのグローバル日次サブ予算）・lease による cron 排他・予算の単一 SQL 予約。
- 弱点: 走行中バッチは自前デッドライン 210 秒でしか止まらない。demo L1 は本番 OFF。

## 5. ネットワーク可用性・完全性

- CSP `nonce + strict-dynamic`・HSTS preload・`frame-ancestors 'none'`・`X-Frame-Options: DENY`・`permissions-policy` 最小・`poweredByHeader: false`。
- サードパーティスクリプトは Plausible 1 本（strict-dynamic で無制約・SRI 不可）。
- **CAA 空・DNSSEC 未署名**（手番）。本日 **CT ログ監視**（`scripts/vet402_cert_watch.py`・毎日 08:10・許可外 CA を ALERTS へ・初回 6 件すべて Let's Encrypt）。
- 応答時間（日本から）: `/` TTFB 1.03 秒（`no-store`・エッジ MISS）・`/observatory` 0.82 秒。→ 本日 SEO 実装でエッジキャッシュ/ISR 化（別報告）。

## 6. 本日入れた計器 2 本（管理リポ・launchd・cron_watchdog が無音死も監視）

| 計器 | 何を守るか | 実証 |
|---|---|---|
| `vet402_cert_watch.py`（08:10） | 許可外 CA の証明書発行（ドメイン乗っ取りの初動） | 本番 6 件すべて許可内。launchd 実走 exit 0 |
| `vet402_ledger_snapshot.py`（04:20） | 公開台帳の RPO 1 日・改竄/削除の検知・Mac 喪失への耐性（iCloud） | 復元 3,294 行一致／改竄・削除の警報を scratch で実証／12.5 MB/日・iCloud 複製済み |

## 7. 次に取る証拠（未観測）
1. 8/27 の 10h36m 障害の原因（Vercel のログは保持期限で消えている可能性。deep health の失敗チェック名を issue に残す仕組みを先に入れる）。
2. Neon PITR 延長後の実復元リハーサル（ブランチ復元で行数一致）。
3. Time Machine 復旧後の初回バックアップ完了。
4. iCloud 側スナップショットが別デバイスから読めること（Mac 喪失シナリオの実証）。
5. 第二 RPC での無作為 30 行の再照合（完全性の中心主張の外部検算）。

# vet402 — 知財資産台帳（IP Inventory）

> 目的: このリポジトリ（vet402）に関わる知財・識別子資産を1箇所に列挙し、
> 各項目に「所有をどう証明するか」を紐づける。買収・助成金・提携のデュー
> デリジェンスで最初に見られる表。
> 更新規律: 資産の取得・喪失・名義変更が起きた日に本表を更新する。
> 記載の実測日: **2026-08-20**（各行の確認方法欄に一次確認手段を明記）。

## 資産一覧

| # | 資産 | 現状 (2026-08-20 実測) | 名義/管理主体 | 所有の証明方法（第三者が検証できる手順） |
|---|---|---|---|---|
| 1 | ドメイン `vet402.com` | 取得済み・稼働中（本番サイト）。登録 2026-08-12、期限 **2027-08-12**、レジストラ **Porkbun LLC**（whois実測） | KIZUNA Creation（Porkbunアカウント） | `whois vet402.com`（Registrar/Creation/Expiry）＋Porkbunダッシュボードのログイン実演。DNS変更権限の実演（TXTレコード追加）が最終証明 |
| 2 | npm `@vet402/sdk` | **v0.3.0 公開済み**（`npm view @vet402/sdk version` 実測） | npmアカウント（publish権限保持者） | `npm view @vet402/sdk` の maintainers 表示＋新バージョンのpublish実演。リポ内 `packages/` との対応 |
| 3 | npm `@vet402/middleware` | **v0.3.0 公開済み**（同上実測） | 同上 | 同上 |
| 4 | npm `@vet402/mcp-server` | **v0.1.1 公開済み**（同上実測） | 同上 | 同上 |
| 5 | npm org/scope `@vet402` | **未取得**（2026-08-20 実測: `registry.npmjs.org/@vet402/…` は404＝スコープ配下パッケージ無し。org頁は403でorg存在自体は未確定）。**取得はTakeshi手番（TODO）** | — | 取得後: npm orgの管理画面＋`npm org ls vet402`。取得前に第三者に取られるリスクがある点に注意（squatting） |
| 6 | X (Twitter) アカウント `@vet_402` | 運用中（製品公式） | KIZUNA Creation（ペルソナ運用） | アカウントへのログイン実演／プロフィールからvet402.comへの相互リンク（サイト側フッターに逆リンクがあること） |
| 7 | GitHub リポジトリ `kzmttkc/vet402` | 稼働中（このリポの origin。`git remote -v` 実測: `https://github.com/kzmttkc/vet402.git`） | GitHubアカウント `kzmttkc` | リポのAdmin画面実演／`kzmttkc` としての署名付きコミット。コミット履歴の連続性がそのまま開発事実の証明になる |
| 8 | ソースコード著作権 | 本リポ全体。**MIT License, Copyright (c) 2026 KIZUNA Creation**（`LICENSE` 実測） | KIZUNA Creation | `LICENSE` ファイル＋git履歴（初コミットからの authorship）。外部コントリビューション分は `CLA.md`（2026-08-20制定）でライセンス付与を担保 |
| 9 | 商標「vet402」 | **未出願**（日本・米国とも）。現時点はコモンロー上の使用実績のみ | — | 出願後: 出願番号／登録番号。現状の使用実績証明: サイトのWayback Machineスナップショット・X投稿履歴・npm公開日時（`npm view … time`） |
| 10 | 観測データベース（x402カタログ日次スナップショット・L0/L1測定結果・ライフサイクルイベント） | 本番DBに蓄積中（2026-08-20時点: 17,722エンドポイント・L1 845試行/341 settle・snapshots日次） | KIZUNA Creation（DBアクセス権保持者） | 公開API（`/api/v1/observatory/state`・`/history`・`export.csv`）の提供者であること＝ドメイン管理（#1）に帰着。データ自体の真正性はオンチェーンtx hashで第三者検証可能 |
| 11 | ブランド/ドキュメント資産（`docs/brand.md`・サイトのRFC-paper様式・方法論文書） | リポ内で管理・公開中 | KIZUNA Creation | #7・#8 と同一（git履歴） |

## 既知のギャップ（優先度順）

1. **`@vet402` npm org 未取得**（#5）— squattingリスク。取得はnpmログインが必要なTakeshi手番。
2. **商標未出願**（#9）— 現時点はトラクション優先の判断。出願判断の材料（使用実績の日付証拠）は本表の各行が兼ねる。
3. **X アカウントの2FA/復旧経路**・**Porkbunアカウントの2FA** — 資産#1・#6の実効支配はアカウントセキュリティに依存する。台帳としては証明方法欄の「ログイン実演」が可能な状態を維持することが本質。

## この表にないもの（誤解防止）

- `vouch-phase2` はローカルディレクトリ名であり資産名ではない（正式名は vet402、リポは `kzmttkc/vet402`）。
- 課金・契約の全社台帳は `~/Takeshi_Automation/ASSET_REGISTRY.md`（正典）。本表はvet402の知財に限る。

# ETHGlobal Tokyo 2026 —— vet402 の会期計画（正典・2026-09-06 起草）

> ミッション（Takeshi 2026-09-06）: **ハッカソンで受賞すること。ETHOnline だけでなく ETH Tokyo も、その先の全イベントも。**
> ETHOnline の正典は [`../ethonline-2026/WINDOW_PLAN.md`](../ethonline-2026/WINDOW_PLAN.md)。本ファイルは Tokyo 専用。

## 1. 一次データ（2026-09-06 20:4x 実読・`ethglobal.com/events/tokyo2026`）

| 項目 | 値 | 出所 |
|---|---|---|
| 会期 | **2026-09-25（金）〜27（日）**・Toranomon Hills Forum 5F（現地） | 公開ページ |
| 応募締切 | 2026-09-11 14:59Z ＝ **09-11 23:59 JST**（我々には掛からない・下記） | 埋め込み JSON |
| **我々の状態** | **hacker として受理・参加確定済み**（06-30 受理メール／08-19 "You've confirmed your spot"・`kazumototakeshi@gmail.com`） | Gmail【一次】 |
| ステーク | **未確認**。ダッシュボードは正本アカウントでしか見えない（Takeshi 手番で確認） | — |
| トラック | Classic／**Extend Open Source**（既存 OSS リポに新機能）／**Ship a Feature**（既存製品に新機能を OSS で）。**vet402 は Continuity（Extend Open Source）で出る** | 公開ページ |
| 規定 | ETHOnline と同文: 事前作業の明確な文書化・AI 利用のファイル単位の明示・spec/prompt の同梱・動画 2〜4 分・720p・AI 音声不可・スマホ動画不可 | `info/details` |
| 賞金総額 | $75,000（09-06 時点）: World $15k（詳細未公開）／ENS $10k（詳細未公開）／Uniswap Foundation $10k（Stack Contribution）／1inch $7k（SwapVM 必須）／Sui $5k（DeFi & Payments） | `prizes` |
| 賞と vet402 の適合 | **09-06 時点で x402／agent／AI を名指しする枠は 0**。World と ENS の詳細待ち。パートナーは「10+」で**増える** | `prizes` の語彙検索 |
| 事前イベント | 09-15 21:00 Beginner's Workshop／09-17 20:00 Virtual Team Formation（任意） | 公開ページ |

## 2. 方針（決めたこと）

1. **ETHOnline の提出（09-14 01:00 JST）が先。** Tokyo の実装は 09-14 以降に始める。ETHOnline 提出物の再利用は「事前作業」として全部開示する
2. **境界タグ** `pre-ethglobal-tokyo-2026` を会期開始（09-25 現地開始時刻）直前に打つ。提出差分 = タグ..main。ETHOnline と同じ規律（`PROMPTS/` 日次・`AI_USAGE.md`・`CHANGED_FILES.md`）
3. **狙う枠は賞の詳細が出てから決める**（World・ENS の詳細、追加パートナー）。09-06 時点の候補: Sui「DeFi & Payments / Payment flows」（vet402 は Solana/Base 実装で Sui 未対応。**新規チェーンは財団の締切が見えてから**——[[vet402-chain-breakdown-for-grants]]）。x402 系のスポンサーが入れば最優先
4. **現地**: Takeshi が Toranomon Hills に 3 日間居る。私はリモートで実装・検証・提出文を持つ。**動画の声は Takeshi**（ETHOnline と同じ）

## 3. 監視（機械で）

- `ethglobal-discord-watch`（08:00/20:00）に **Tokyo の `prizes` ページ再読**を足す: パートナー追加・World/ENS の詳細公開を拾う → 本ファイル §1 を更新
- `#announcements` の Tokyo 関連（ステーク期限・提出締切の告知）

## 4. Takeshi 手番（TODO に検算行つきで記載）

- ステークが済んでいるかをダッシュボードで確認（正本アカウント）。未なら期限内にステーク
- 09-25〜27 現地参加の予定確保（カレンダー）

## 5. 未確認（測っていない）

- ステークの要否・額・期限【未確認】
- 提出締切の時刻（会期最終日 09-27 のどこか）【未確認・提出フォーム開放後に読む】
- Continuity の「事前作業の書面開示」の窓口（ETHOnline は 09-05 に書面で開示済み。Tokyo は別に要るか）【未確認】

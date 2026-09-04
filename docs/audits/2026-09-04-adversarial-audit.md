# vet402 敵対的監査 2026-09-04（第 2 回・6 系統・自前）

Takeshi 決定: 有料監査（Zellic）は買わない。「今回指摘された穴を完璧に修正、関連する部分やまだ見つかっていない穴を第三者敵対複数精密監査で見つけて」。
起点は Zellic の 2 質問（署名方式の記述漏れ・staging 不在）と、それを確かめる過程で見つかった Preview の本番鍵共有、
それを直そうとして本番 env を消した執行部の事故。

## 監査 6 本の要約（上位所見は執行部が本番 DB / チェーン / ローカル再現で裏取り）

| 系統 | モデル | P0 | P1 | P2 | 核心 |
|---|---|---|---|---|---|
| A 金の経路 | Fable | 0 | 2 | 5 | tx ハッシュ再利用で settled を偽装できる |
| A' 金の経路（同一プロンプト） | **Opus** | 0 | **4** | 6 | 同上＋予約後 throw で冷却が発火しない（PoC 2 件実走）・wrong_chain が恒久 refuted・Registry の TOCTOU |
| B 認可・IDOR・レート制限 | Fable | 0 | 0 | 4 | 所見なし（根拠つき）。Idempotency-Key で再計算が無料 |
| C 秘密・env・不可逆操作 | Fable | (1) | 6 | 7 | 破壊操作の関門なし・main 無保護・秘密 32/37 本に控え無し・会話ログに DB パスワード。「旧鍵回収不能 P0」は誤り（Takeshi の個人財布） |
| D 依存・インフラ | Fable | **1** | 3 | 11 | **決済索引が 9/2 20:43 UTC から 17 回連続失敗し ok:true で報告**。真因は Neon 無料枠 512 MB 超過（pg 53100）。32,767 パラメータ上限も実在 |
| E 主張・導線 | Fable | **5** | 17 | 11 | settled と delivered の混同（settled 1,452 のうち非 2xx 120）・優先売り手 4 社の日次購入が未開示・/decisions の 30 日集計が 200 行止まり・FAQ/llms が Solana 未対応のまま・playground の daily 主張 |

**モデル比較**: 同一プロンプトで Opus が P1 4 / PoC 2 件、Fable が P1 2。最重要所見は両方が発見。以後、金の経路と認可は Opus。

## 是正（同日・main へ）

| 系統 | 入ったもの | 本番確認 |
|---|---|---|
| A（Opus） | 署名 nonce を行へ保存し `AuthorizationUsed(payer, nonce)` を照合で要求／`UNIQUE (network, lower(tx_hash))`／署名可能性を予約前に検査・整数化・冷却に request_error／wrong_chain・malformed_tx は一時扱いでバッチ中断／Registry の日次上限を単一文・逐次発火・failed 再試行可／UTC 日境界／Solana memo 自前・feePayer 検査・受領額判定／認可窓 120s・遅延決済の回収／demo に lease | DDL 適用（重複 0 件確認後に一意索引）・デプロイ済み |
| B（Opus） | FAQ Q8/llms の Solana／方法論 §6 に優先 4 社を開示・§8 書き換え／settled・delivered・attempts の 3 値を API・バッジ・登録簿・state に／decisions の窓集計／playground の daily 撤去／規約 §13・§16／custody を customer funds に／unverified の主因を実測に／L2 語彙対応表／FAQ Q6 に probe402／corrections を昇格と誤り訂正の別表に／プライバシーに 3 テーブルと Resend／claims.yaml +30 | canary 50/50 true・decisions totals 51/1,452/1,531/74（旧 3/96/98） |
| C | watchdog を Resend へ／now.py に ALERTS 未読／cron 8 本に try/catch／schema に job_leases と部分索引／db:drift／badge の死んだ宣言／engines.node／Neon 拒否ガード／Idempotency-Key は保存応答を再送／demo 予算は成立時のみ | 統合・デプロイ済み（19:00〜21:10）。`db:drift` は unique() 制約を読んでいなかった → 是正 `a62784b` |
| D | 分母ラベル（on record / fetched of catalog / share of attempts vs endpoints）／L1Ratio／accuracy の空表示／390px の購入表に HTTP 列 | デプロイ済み |
| E（Opus） | `settlement_daily`（生行 7 日＋日次集約・DELETE…RETURNING の単一文で二重計上なし）／census は生行 ∪ 集約／resolve の窓外応答／buyer-facts の縮み是正 | 表と索引を本番へ作成。生行の保持は **7 日→30 日**（30 日窓の指標が畳みで劣化しない・月 $0.3 程度）。cron は F の統合後に復帰、本番で 1 回手動実行 → 本番に `settlement_daily_key` が無く失敗 → 制約を足して 48 行を畳み成功 |
| F | coverage.ts / l0-accuracy / probe-runner / l1-runner の 30 日述語を生行 ∪ 集約に／rollup cron 復帰 | 統合・デプロイ済み。coverage-rollup-window.pg.test は保持 7 日を env で強制して畳みを起こす |
| 執行部 | 決済索引の 32,767 パラメータ回避・失敗を ok:false に・lease・deep health に遅れ検出／Preview の本番鍵共有を解消（新鍵を production のみ・Takeshi 入金・tx `0xee65aa5c…` で復旧確認）／不可逆操作の PreToolUse 関門／main の ruleset（**force-push と削除の禁止のみ**。レビュー必須・CI 必須は無い——2026-09-05 監査で訂正）／chmod 600／死んだ CDP キー削除／Neon を従量制へ（Takeshi） | 実測済み |

## 外部指摘の漏れ率
2 件中 1 件は外部（Zellic）が先。`state/external_findings.json`。目標 0。

## 残り
- 会話ログに残った本番 DB パスワードの失効（Neon のパスワード回転）
- Registry と Solana の鍵を控え付きの新鍵へ（Takeshi の送金 2 回・9/13 後）
- Solana RPC を専用キーへ（Takeshi・無料枠）

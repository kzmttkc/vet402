# PROMPTS —— 会期中にオーナーが出した判断と指示（抜粋）

> ETHGlobal の規約（Use of AI Tools · Spec-Driven Development）:
> "you must include **all spec files, prompts, and planning artifacts** in your submission repository.
> Judges need to see the full picture of **how you directed the AI**, not just the generated output."

## このディレクトリの方針

ここは、vet402 の ETHOnline 2026 参加範囲について、オーナー（提出者本人）が関与した立案・指示・実装のアイデア・提案を、審査に要る情報だけ日ごとに抜粋したものです。会話の全文ではありません。入れたのは、製品と提出物の設計判断、戦略（例: パートナー賞を優先する判断）、機能の要求（例: 支払い上限は運用者が決める・読めない証拠では払わない）、A/B の設計と事前登録、デモとライブ審査の構成、提出文の構成と主語の規則、審査員の目線からの要求、公開と支出の承認とその対象です。除いたのは、進捗の問い合わせや作業の確認、ツールや画面の操作についてのやり取り、応答の書き方への注文、画像、個人名・メールアドレス・鍵などの秘密です。短い発言は原文で引き、固有名や数字の明らかな誤記は直して〔原文: …〕を添えました。長い発言は趣旨を変えずに要旨にしています。各日のファイルは「その日の判断」と「反映したコミット（git の外で行ったものはその旨）」を並べ、最後にその日の発注に書いた設計の要点を置いています。

## 置き方

- ファイル名: `YYYY-MM-DD-<短い主題>.md`（例 `2026-09-04-day0-red-tests.md`）
- 1 項目 = 1 つの判断。見出しに要旨と時刻（JST）、本文に短い原文か要旨、末尾に `反映:` の行
- ローカルの絶対パス・会話記録のファイル名は載せない

## 何が planning artifact か（規約が見たいもの）

| 種類 | このリポでの実体 |
|---|---|
| 仕様 | [`WINDOW_PLAN.md`](../WINDOW_PLAN.md)（正典）・[`DESIGN_payOrRefuse.md`](../DESIGN_payOrRefuse.md) |
| 制約と禁止 | [`../../../AGENTS.md`](../../../AGENTS.md) 冒頭のフリーズ・[`GIT_RULES.md`](../GIT_RULES.md) |
| 検証の設計 | WINDOW_PLAN §4（失敗テスト22本と「呼べない」の4層証明） |
| 実測の記録 | [`GRAPH_EVIDENCE.md`](../GRAPH_EVIDENCE.md)・[`fixtures.md`](../fixtures.md)・[`VERIFY_2026-09-02.md`](../VERIFY_2026-09-02.md) |
| **判断と指示（日ごとの抜粋）** | **このディレクトリ** |

## 人間が握っているもの（AI に委ねていない判断）

規約の "meaningful contributions from team members" に対する事実の列挙。装飾しない。

- ETHGlobal への申請とトラック選択、ステーク、提出クリック
- **実オンチェーン支出の承認**（デモ用の鍵と資金は人間が持つ）
- 動画の音声（AI 音声は規約で自動却下）
- スポンサー窓口での発言
- 会期スコープの取捨（例: 2026-09-03 に World AgentKit 枠を落とす判断）
- フィクスチャ差し替えの可否、キルスイッチの発動

# PROMPTS —— 会期中に AI をどう指揮したかの記録

> ETHGlobal の規約（Use of AI Tools · Spec-Driven Development）:
> "you must include **all spec files, prompts, and planning artifacts** in your submission repository.
> Judges need to see the full picture of **how you directed the AI**, not just the generated output."
>
> **その日の指示文を、その日のうちにここへ置く。** 後からまとめて書き起こしたものは planning artifact ではない。
> 2026-09-03 時点でリポに prompt が 0 件だったため、会期初日から運用を始める。

## 置き方

- ファイル名: `YYYY-MM-DD-<短い主題>.md`（例 `2026-09-04-day0-red-tests.md`）
- 中身: **実際に投げた指示文をそのまま**。要約しない。編集しない
- 1日に複数あればファイルを分ける。返ってきた成果物のコミットハッシュを末尾に1行

## 何が planning artifact か（規約が見たいもの）

| 種類 | このリポでの実体 |
|---|---|
| 仕様 | [`WINDOW_PLAN.md`](../WINDOW_PLAN.md)（正典）・[`DESIGN_payOrRefuse.md`](../DESIGN_payOrRefuse.md) |
| 制約と禁止 | [`../../../AGENTS.md`](../../../AGENTS.md) 冒頭のフリーズ・[`GIT_RULES.md`](../GIT_RULES.md) |
| 検証の設計 | WINDOW_PLAN §4（失敗テスト22本と「呼べない」の4層証明） |
| 実測の記録 | [`GRAPH_EVIDENCE.md`](../GRAPH_EVIDENCE.md)・[`fixtures.md`](../fixtures.md)・[`VERIFY_2026-09-02.md`](../VERIFY_2026-09-02.md) |
| **指示文** | **このディレクトリ** |

## 人間が握っているもの（AI に委ねていない判断）

規約の "meaningful contributions from team members" に対する事実の列挙。装飾しない。

- ETHGlobal への申請とトラック選択、ステーク、提出クリック
- **実オンチェーン支出の承認**（デモ用の鍵と資金は人間が持つ）
- 動画の音声（AI 音声は規約で自動却下）
- スポンサー窓口での発言
- 会期スコープの取捨（例: 2026-09-03 に World AgentKit 枠を落とす判断）
- フィクスチャ差し替えの可否、キルスイッチの発動

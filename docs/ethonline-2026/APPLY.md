# ETHOnline / Tokyo — 申請文（人が貼る）

> 2026-08-25。ETHOnline Continuity は **2026-08-23 提出済み**（`continuity-track`・審査中）。
> このファイルは **Tokyo 用のコピー**と、Hedera への確認文。申請そのものは人間。

提出済みの ETHOnline 本文は [`../hackathons/STRATEGY.md`](../hackathons/STRATEGY.md) §5.7 のまま凍結する。
会期中の動詞仕様は [`DESIGN_payOrRefuse.md`](./DESIGN_payOrRefuse.md)（policy + L1 証拠。ALLOW は構造的に出ない）。
提出文を自己訂正して送り直さない。聞かれたら DESIGN を口頭で補う。

## Tokyo 2026 — Extend Open Source（15分・同じリポ）

**Dashboard:** https://ethglobal.com/events/tokyo2026  
締切の目安: **2026-09-23**（ETHOnline 会期中でも、先に出す）。

Track: **Extend Open Source**  
Repo: https://github.com/kzmttkc/vet402 (MIT, maintained by this team)  
Site: https://vet402.com

vet402 is an independent verification layer for the x402 agent-payment economy. It already buys what endpoints sell, publishes successes and failures with evidence, and exposes ALLOW / WARN / BLOCK via SDK and MCP. During ETHOnline 2026 we are adding **payOrRefuse** (refuse before sign unless a caller-declared policy says pay).

We are not submitting the existing product as Tokyo work. During Tokyo we will add **resolve-then-pay**: the payee is an ENS name; `payOrRefuse` runs after resolution. We will not implement that feature before Tokyo kickoff.

Git boundary: tag `pre-tokyo-2026` (2026-09-24). Work on branch `tokyo-2026` with commit prefix `tokyo:`. Pre-existing files we touch will be listed in `docs/ethonline-2026/CHANGED_FILES.md` (or the Tokyo equivalent).

## Hedera への確認（Discord / パートナー、名指し）

Pascal 回答（2026-08-23）: 既存公開 API に依存する提出は Continuity 扱いで、`continuity track` ラベルの賞のみ対象、と理解している。

Please confirm: is a Continuity Track submission eligible for **Hedera 🤖 AI & Agentic Payments** ($6,000, Blocky402 / Hedera x402 gate), or only for **Hedera ♻️ Continuity** ($1,000, existing Hedera project)? If the main AI & Agentic Payments track excludes Continuity, is a Continuity bracket planned?

We maintain https://github.com/kzmttkc/vet402 (Base L1 purchases today). We can add a Hedera + Blocky402 seller in-window if the main track accepts Continuity submissions.

## World AgentKit Continuity

Continuity-labeled. No chain change. If we ship `payer.requireHumanBacked` on `payOrRefuse` **in-window** (see `DESIGN_payOrRefuse.md`), this is pick #1. Confirm World ID Sandbox remote test + feedback doc after the feature exists — do not claim it now.

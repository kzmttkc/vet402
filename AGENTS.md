<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ⛔ ETHOnline 2026 Continuity フリーズ（2026-08-26 〜 09-04 00:00 UTC）

このリポは ETHGlobal の **Continuity トラック**で提出される。賞の対象は**会期中(09-04→09-13)の差分だけ**で、
会期前に入れた実装は「既存」として開示される——つまり**今書くと賞の対象から外れる**。

**09-04 まで新規実装を入れない対象**:
- `packages/sdk` / `packages/middleware` の支払い判定まわり（SpendGuard の policy / evidence 系）
- `payOrRefuse` / `pay_if_trusted`（まだ存在しない。会期中の新規はこれ）
- **製品定義書 §9.3 の「買い手モード」**——リクエスト前に `/decision?role=payer` を引き、
  BLOCK/未検証なら送金しない配線。上と同じものなので同じく 9/4 まで入れない
  （`/decision` API 本体と売り手モードは 9/2 に入れてよい。詳細 [`docs/ethonline-2026/SPEC_1_2_IMPACT.md`](docs/ethonline-2026/SPEC_1_2_IMPACT.md) §0）
- `examples/` のデモエージェント・自前 seller

**入れてよいもの**: 既存機能の不具合修正・セキュリティ・観測所の運用・ドキュメント・仕様・調査。

2026-08-25 に evidence policy が会期前に `packages/sdk` と `packages/middleware` へ入った
（ee16294 / 44c3420）。取り消さず「既存」として開示する。詳細と現在の線引きは
[`docs/ethonline-2026/ROADMAP.md`](docs/ethonline-2026/ROADMAP.md) §4.0。

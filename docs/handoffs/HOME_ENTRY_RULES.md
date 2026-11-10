# フロント頁エントリの運用ルール（2026-11-10）

## 方針

vet402 の能力は随時アップグレードするが、**フロント頁に情報を積み上げない**。利用者が「何をしたいか」で入口が三つに分かれ、詳細は各先の頁に載せる。

## 三つの入口（順序固定）

| 見出し | 先の頁 | 計測イベント |
|--------|--------|----------------|
| Before you pay | `/x402/check-a-seller` | `entry_before_pay` |
| While you pay | `/docs/api`（アンカー `#quickstart`） | `entry_while_pay` |
| After you pay | `/observatory` | `entry_after_pay` |

## アップグレード項目の載せ方

1. **完了した項目だけ**を反映する。素材一覧は  
   `/Users/takeshi/Takeshi_Automation/output/1110/upgrade_article/facts.md`  
   の表のうち「本番の確かめ」列に記載がある行に限る。
2. **まず詳細頁へ書く**：該当する入口（上表）に対応する先の頁に、何が変わったか・どこで使うかを追記する。
3. **フロント頁は最小限**：その入口に関係する場合のみ、`ENTRY_CARDS` の **一文（sentence）** を差し替える。見出し・リンク先・カード枚数は変えない（要オーナー承認）。
4. **`tests/home-density.test.ts` を緑に保つ**：セクション数・カード数・語数上限を超えたらマージしない。定数変更はオーナー承認が必要（テスト内コメント参照）。

## 検証

- `npx tsx --test tests/home-density.test.ts`
- `npx tsx --test tests/site-events.test.ts`（新イベント名が `SITE_EVENTS` と src の使用箇所で一致）

## 実装の場所

- フロント頁本体: `src/app/page.tsx`（`ENTRY_CARDS`）
- イベント正典: `src/lib/site-events.ts`
- 密度テスト: `tests/home-density.test.ts`

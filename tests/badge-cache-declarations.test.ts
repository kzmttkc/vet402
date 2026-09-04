// ============================================================
// badge 3 ルートの「死んだ宣言」を消す（2026-09-04 監査 D・P2）。
//
// `export const revalidate = N` と `export const dynamic = "force-dynamic"` が併記されていた。
// force-dynamic の下では revalidate は効かない（ISR は動的ルートに適用されない）——
// 読む人に「5 分でキャッシュされる」と信じさせるだけの宣言。実際の CDN 窓は手書きの
// Cache-Control（s-maxage）が担保している。宣言を消し、コメントを実態に合わせる。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROUTES = [
  "src/app/api/badge/[address]/route.ts",
  "src/app/api/badge/agent/[agentId]/route.ts",
  "src/app/api/badge/endpoint/[id]/route.ts",
];

for (const rel of ROUTES) {
  test(`${rel}: revalidate を持たず、force-dynamic と手書き Cache-Control で鮮度を決める`, () => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    assert.doesNotMatch(src, /export const revalidate\s*=/, "force-dynamic の下で効かない revalidate が残っている");
    assert.match(src, /export const dynamic = "force-dynamic"/);
    assert.match(src, /s-maxage=\d+/, "CDN 窓を決める Cache-Control が無い");
  });
}

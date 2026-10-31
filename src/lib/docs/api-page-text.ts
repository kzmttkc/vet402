// ============================================================
// /docs/api の冒頭の直答（2026-10-31 AEO）。tests/seo-aeo-llmo-1031.test.ts が検査する。
//
// 「vet402 とは何か」「x402 の売り手を払う前にどう確かめるか」に 2 文で答える。
// 主張は既存の面にあるものだけ: 1 文目はトップの冒頭（src/app/page.tsx）、2 文目は
// この頁の Quickstart 1 番（resolve → decision・鍵なし・ALLOW / WARN / BLOCK と L0–L2 の事実）。
// 英語のみ・一人称は vet402・em ダッシュを使わない。
// ============================================================

export const API_DOCS_ANSWER =
  "vet402 buys from x402 APIs itself and publishes what came back, so your agent can check a seller before it pays. " +
  "Resolve the seller's URL to a resource_id, then read its decision (ALLOW, WARN or BLOCK, with the L0 to L2 facts behind it); neither call needs a key.";

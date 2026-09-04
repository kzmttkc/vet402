// ============================================================
// /llms.txt の Cache-Control を /llms-full.txt と揃える（2026-09-04 監査 D・P2）。
//
// 本番実測（2026-09-04）: /llms.txt（public/ の静的ファイル）は Vercel 既定の
// `public, max-age=0, must-revalidate`、/llms-full.txt（route handler）は `public, max-age=3600`。
// 同じ読者（エージェント）向けの同じ種類の文書で鮮度の約束が違う理由は無い。
// 静的ファイルはコードで header を返せないので next.config.ts の headers() で揃える。
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../next.config";

test("/llms.txt の Cache-Control は /llms-full.txt と同じ値", async () => {
  const full = readFileSync(join(process.cwd(), "src/app/llms-full.txt/route.ts"), "utf8");
  const m = full.match(/"Cache-Control":\s*"([^"]+)"/);
  assert.ok(m, "llms-full.txt route に Cache-Control が無い");
  const expected = m[1];

  const headers = await nextConfig.headers!();
  const entry = headers.find((h) => h.source === "/llms.txt");
  assert.ok(entry, "next.config.ts の headers() に /llms.txt が無い");
  const cc = entry.headers.find((h) => h.key.toLowerCase() === "cache-control");
  assert.ok(cc, "/llms.txt に Cache-Control が無い");
  assert.equal(cc.value, expected);
});

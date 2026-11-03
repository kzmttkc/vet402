// ============================================================
// 公開面の数字の文（2026-11-03 の監査で見つかった型）。値は本番の API が正で、ここは文の形を固定する。
//   - 率と分母を同じ文に置く（「N of them (x%)」の先行詞が分母でない文を作らない）
//   - 同じ文の中で千区切りあり・なしを混ぜない
//   - 日付のない固定値を本文に置かない
//   - /accuracy の listed は state の active と同じ除外に 30 日窓を足したもの。C1 の分母は依頼の記録を外す
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endpointReceiptBadge, settleExcludingVet402Side } from "@/lib/badge/receipt-badge";
import { FRESHNESS_LEAD } from "@/lib/observatory/freshness";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("/impact: 測定の率は active の分母と同じ文に置く", () => {
  const src = read("src/app/impact/page.tsx");
  assert.doesNotMatch(src, /measuredLast7d\.toLocaleString\(\)\}<\/strong> of them/);
  assert.match(src, /measuredLast7d\.toLocaleString\(\)\}<\/strong> of the\{" "\}\s*<strong>\{coverage\.activeEndpoints\.toLocaleString\(\)\}<\/strong> active records \(\s*<strong>\{coverage\.pct\}%/);
});

test("/decisions・/impact: 件数は千区切りを通す", () => {
  const raw = /\{(feed\.totals\.\w+|decisions\.totals\.\w+|backtest\.(avoided|forgone)\.count)\}/;
  for (const p of ["src/app/decisions/page.tsx", "src/app/impact/page.tsx"]) assert.doesNotMatch(read(p), raw, p);
});

test("/observatory/methodology: 上限の上の行数は読んだ日を添える", () => {
  assert.match(read("src/app/observatory/methodology/page.tsx"), /337 signed rows in the ledger were above \$0\.25 when read on 2026-11-03/);
});

test("Freshness: 読者に届く Cache-Control の実際を言う（llms.txt と生成元が同じ文）", () => {
  assert.match(FRESHNESS_LEAD, /the CDN removes `s-maxage` and `stale-while-revalidate` from the copy you receive and keeps `max-age`/);
  assert.ok(read("public/llms.txt").includes(FRESHNESS_LEAD));
});

test("active の述語: /accuracy の listed と C1 の分母は依頼の記録を外す", () => {
  const coverage = read("src/lib/observatory/coverage-report.ts");
  assert.match(coverage, /const notCounted = sql`\$\{operatorExclusionPredicate\("e"\)\} AND \$\{notSellerRetestRequestSourceSql\(\)\}`/);
  assert.equal(coverage.match(/e\.status = 'active'/g)?.length, coverage.match(/AND \$\{notCounted\}/g)?.length);
  assert.match(read("src/lib/scoring/l0-accuracy.ts"), /AND \$\{notSellerRetestRequestSourceSql\(\)\}\) AS c1_fresh/);
});

test("purchases API とバッジは同じ分母: vet402 の側を外した率を両方が同じ関数で出す", () => {
  // 監査の実例 api.exa.ai/search: 47 件・45 settled・vet402 の側 2 件（settled 0）
  assert.deepEqual(settleExcludingVet402Side(47, 45, { count: 2, settled: 0 }), { attempts: 45, settled: 45, ratePct: 100 });
  const badge = endpointReceiptBadge({ attemptCount: 47, settledCount: 45, vet402Side: { count: 2, settled: 0 } });
  assert.match(badge.label, /^45\/45 settled/);
  assert.match(badge.label, /vet402 side 2/);
  // 全部 vet402 の側なら分母 0 で率は null（0% と言わない）
  assert.deepEqual(settleExcludingVet402Side(2, 0, { count: 2 }), { attempts: 0, settled: 0, ratePct: null });
  // settled の行が vet402 の側なら settled からも引く
  assert.deepEqual(settleExcludingVet402Side(4, 3, { count: 1, settled: 1 }), { attempts: 3, settled: 2, ratePct: 66.7 });
  const route = read("src/app/api/v1/observatory/endpoints/[id]/purchases/route.ts");
  assert.match(route, /\.\.\.result,\s+vet402SideCount: sides \? sides\.vet402Side : null/, "existing fields stay, and an unreadable classification is null");
  for (const k of ["vet402SideCount", "attemptCountExcludingVet402Side", "settledCountExcludingVet402Side", "settleRatePctExcludingVet402Side", "vet402SideNote"]) assert.ok(read("docs/openapi.yaml").includes(`${k}:`), k);
});

test("export の 1 行の説明: 依頼の記録を含むと面で同じに言う", () => {
  for (const p of ["src/lib/sellers/export.ts", "src/app/docs/api/page.tsx", "public/llms.txt"]) assert.match(read(p), /records opened for a seller's re-test request included/, p);
  assert.match(read("docs/openapi.yaml").replace(/\s+/g, " "), /records opened for a seller's re-test request included/);
});

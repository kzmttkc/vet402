// ============================================================
// 既公開 fail の訂正（2026-09-02 監査 A1・オーナー決定・一回もの・冪等）。
//
// パステンプレート URL（src/lib/observatory/path-template.ts）を L0 でそのまま
// 叩き、2 連続 fail で公開 fail にしていた endpoint（本番実測 12 件）を
// unverified(path_template) へ戻す。各 endpoint に対して:
//   (a) unverified / fail_reason=path_template の probe 行を 1 行挿入
//       （publishedVerdict は最新行を見るので公開判定が unverified に戻る。
//        既存の fail 行は消さない——叩いてしまった事実も履歴に残す）
//   (b) correction_log に subject=endpoint / level=l0 / fail → unverified /
//       reason=path_template / note を記録（§10・訂正は消さない）
//
// 既定は dry-run（件数と id・URL を印字するだけ）。--apply で書く。
// 冪等: 公開判定が既に unverified の endpoint は対象に入らないので、2 回目は 0 件。
//
// Run:
//   DATABASE_URL=... npm run correct:path-templates            # dry-run
//   DATABASE_URL=... npm run correct:path-templates -- --apply # 書き込み
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";
import { MIN_CONSECUTIVE_FAILS_TO_PUBLISH } from "@/lib/observatory/l0-probe";
import { PATH_TEMPLATE_PG_REGEX, PATH_TEMPLATE_REASON } from "@/lib/observatory/path-template";
import {
  correctionPayload,
  selectPathTemplateCorrections,
  type CorrectionCandidate,
} from "@/lib/observatory/path-template-correction";
import { recordCorrection } from "@/lib/observatory/corrections";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // SQL 側は広めに拾い（同じ正規表現）、確定は JS の isPathTemplate（正典）で行う。
  // 直近 N 件の verdict は publishedVerdict と同じ「新しい順」。
  const raw = await db.execute(sql`
    SELECT e.id::text AS id, e.resource_url, e.method,
           coalesce(lp.verdicts, '{}'::text[]) AS verdicts
    FROM x402_endpoints e
    LEFT JOIN LATERAL (
      SELECT array_agg(v.verdict ORDER BY v.probed_at DESC) AS verdicts
      FROM (
        SELECT verdict, probed_at FROM x402_l0_probes p
        WHERE p.endpoint_id = e.id
        ORDER BY probed_at DESC
        LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
      ) v
    ) lp ON true
    WHERE split_part(e.resource_url, '?', 1) ~* ${PATH_TEMPLATE_PG_REGEX}
    ORDER BY e.first_seen_at ASC
  `);
  const rows = rowsOf<{ id: string; resource_url: string; method: string | null; verdicts: string[] }>(raw);
  const candidates: CorrectionCandidate[] = rows.map((r) => ({
    id: r.id,
    resourceUrl: r.resource_url,
    verdictsNewestFirst: r.verdicts ?? [],
  }));
  const targets = selectPathTemplateCorrections(candidates);
  const methodOf = new Map(rows.map((r) => [r.id, r.method]));

  console.log(
    `${apply ? "[apply]" : "[dry-run]"} template_urls=${rows.length} published_fail=${targets.length}`,
  );
  for (const t of targets) console.log(`  ${t.id}  ${t.resourceUrl}`);
  if (!apply) {
    console.log("(nothing written — pass --apply to insert the unverified rows and corrections)");
    process.exit(0);
  }

  let corrected = 0;
  for (const t of targets) {
    const payload = correctionPayload(t);
    const method = (methodOf.get(t.id) ?? "GET").toUpperCase();
    // (a) probe 行。外向き要求は出していない（http_status NULL・latency NULL）。
    await db.execute(sql`
      INSERT INTO x402_l0_probes
        (endpoint_id, method, verdict, dialect, http_status, has_402_challenge, accepts_valid,
         price_consistent, metadata_consistent, latency_ms, fail_reason, raw_response_meta)
      VALUES
        (${t.id}::uuid, ${method}, 'unverified', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         ${PATH_TEMPLATE_REASON},
         ${JSON.stringify({ error: PATH_TEMPLATE_REASON, trigger: "correction", script: "correct-path-template-fails", method })}::jsonb)
    `);
    // (b) 訂正ログ。
    const id = await recordCorrection(payload);
    if (!id) throw new Error(`correction_log insert returned no id for ${t.id}`);
    corrected++;
  }
  console.log(`corrected=${corrected}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

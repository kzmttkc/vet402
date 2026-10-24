#!/usr/bin/env -S npx tsx
// ============================================================
// 公開一覧（src/lib/settlements/measurement-payers.ts）の payer を
// settlements と settlement_daily で wash_flag measurement に揃える。
//
// vet402 自身の行（wash_flag test）は動かさない。一覧に無い payer は動かさない。
// 既定は数えるだけ。書くのは --apply のときだけ。
//
// このセッションでは本番 DB に対して実行しない。実行は vet402.com がやる。
//
//   DATABASE_URL=... npx tsx scripts/backfill-measurement-payers.ts
//   DATABASE_URL=... npx tsx scripts/backfill-measurement-payers.ts --apply
//
// 2 回目の --apply は移す行が 0 になる（冪等）。
// 実行後、センサスと seller facts の settlement_30d_real は wash_flag none だけを
// 数えるので、移した件数ぶん real が減り、settlement_30d_measurement が増える。
// settlement_daily は 45 日より古い日を持たない。それより古い個票はもう無い。
// ============================================================
import { getDb } from "@/lib/db/client";
import { MEASUREMENT_PAYERS } from "@/lib/settlements/measurement-payers";
import { reclassifyMeasurementPayers } from "@/lib/settlements/reclassify-measurement";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const report = await reclassifyMeasurementPayers(db, { apply });
  console.log(JSON.stringify({ payers: MEASUREMENT_PAYERS.map((p) => ({ name: p.name, payerId: p.payerId })), ...report }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

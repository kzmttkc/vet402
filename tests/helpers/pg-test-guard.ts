// ============================================================
// pg テストの TRUNCATE を本番へ向けないガード（2026-09-04 監査 D・P2）。
//
// tests/*.pg.test.ts は TEST_DATABASE_URL を DATABASE_URL に入れて TRUNCATE から始まる。
// scripts/db-preflight.ts と同じ規則で、ホストが *.neon.tech なら database 名に関わらず拒否する
// （本番 vouch も、2026-08-14 に誤適用があった neondb も、Neon 上のものはテストの相手ではない）。
// 各 pg テストの TRUNCATE より前に呼ぶ。tests/pg-test-guard.test.ts が呼び順を固定している。
// ============================================================

export function assertTestDatabaseIsNotProduction(url: string | undefined): void {
  if (!url) throw new Error("pg-test-guard: TEST_DATABASE_URL が空");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("pg-test-guard: TEST_DATABASE_URL が URL として読めない");
  }
  if (parsed.hostname.endsWith(".neon.tech")) {
    throw new Error(
      `pg-test-guard: refusing Neon host ${parsed.hostname} — pg tests TRUNCATE the observatory ledger; ` +
        "use a local or CI database (scripts/report-test-gates.mjs に手順)",
    );
  }
}

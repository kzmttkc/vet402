#!/usr/bin/env -S npx tsx
// vet402 reproducibility CLI — ledger anchor chain verification (次波②).
// 公開APIだけで、日次rootの鎖を第三者が検証する。検査は2つ:
//   linked     day N の prevRoot == day N-1 の rootHash（連結）
//   contiguous 日付が1日も飛んでいない（連続）
// 2026-09-02 監査: 連結だけを見ていたため、cron が1回落ちて欠けた日を飛ばして
// 繋いだ鎖を5日間「chainIntact: true」と言い続けた。intact は両方を要求する。
// root そのものの再計算には生の購入行が必要（self-host か research アクセス）
// ——出来ること/出来ないことは cli/README.md に正直に書いてある。
// Usage: npx tsx cli/verify-anchors.ts [--days 30] [--base https://vet402.com]

type Row = { day: string; rootHash: string; prevRoot: string | null };

const DAY_MS = 86_400_000;

function missingDaysBetween(from: string, to: string, have: readonly string[]): string[] {
  const set = new Set(have);
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!set.has(d)) out.push(d);
  }
  return out;
}

/** src/lib/observatory/anchors.ts の chainContinuity と同じ規則（CLI は依存を持たない）。 */
function chainContinuity(newestFirst: readonly Row[]) {
  let linked = true;
  const gaps: string[] = [];
  for (let i = 0; i + 1 < newestFirst.length; i++) {
    const newer = newestFirst[i];
    const older = newestFirst[i + 1];
    const ok = newer.prevRoot === older.rootHash;
    if (!ok) linked = false;
    const holes = missingDaysBetween(older.day, newer.day, [older.day, newer.day]);
    gaps.push(...holes);
    console.log(
      `${newer.day} <- ${older.day}: ${ok ? "LINKED" : "BROKEN"}${holes.length ? ` (GAP: ${holes.join(",")})` : ""}`,
    );
  }
  return { linked, contiguous: gaps.length === 0, gaps, intact: linked && gaps.length === 0 };
}

async function main() {
  const di = process.argv.indexOf("--days");
  const days = di >= 0 ? Number(process.argv[di + 1]) : 30;
  const bi = process.argv.indexOf("--base");
  const base = bi >= 0 ? process.argv[bi + 1] : "https://vet402.com";
  const res = await fetch(`${base}/api/v1/observatory/anchors?days=${days}`);
  const { anchors } = (await res.json()) as { anchors: Row[] };
  const r = chainContinuity(anchors);
  console.log(
    JSON.stringify({ days: anchors.length, linked: r.linked, contiguous: r.contiguous, gaps: r.gaps, chainIntact: r.intact }),
  );
  process.exit(r.intact ? 0 : 1);
}
main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});

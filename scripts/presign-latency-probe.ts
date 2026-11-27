// ============================================================
// POST /api/v1/check/presign の速さを測り、public/data/presign-latency.json に書く（2026-11-27 F7）。
//
// 使い方: npx tsx scripts/presign-latency-probe.ts [--n 30] [--seller <402 を返す URL>] [--api https://vet402.com]
//   1. 売り手の URL を払わずに 1 回 GET し、返った 402（PAYMENT-REQUIRED ヘッダ、無ければ本文）を取る
//   2. その本文を { challenge, url } にして vet402 へ n 回、順に POST する（並べない。同じ IP の枠に収める）
//   3. 応答の Server-Timing presign;dur（回数制限から応答までのサーバ内の時間）と、手元の往復の時間を記録する
//   4. 200 で返った回だけを数え、p50・p99（nearest-rank）と件数を JSON に書く
// 書いた JSON を commit して出すと、https://vet402.com/data/presign-latency.json に載る。
// 数えるのはこのスクリプトが呼んだ回だけ（ほかの呼び手の回は数えない）。DB には何も書かない。
// ============================================================
import { writeFileSync } from "node:fs";

const UA = "vet402-presign-latency-probe/1";
const TARGET_P99_MS = 300;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** nearest-rank の分位（q は 0〜1）。空なら null。 */
export function nearestRank(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

async function main(): Promise<void> {
  const n = Number(arg("n", "30"));
  const seller = arg("seller", "https://1gateway.dev/v1/news/brief");
  const api = arg("api", "https://vet402.com");
  const out = arg("out", "public/data/presign-latency.json");

  const unpaid = await fetch(seller, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "follow" });
  if (unpaid.status !== 402) throw new Error(`seller answered ${unpaid.status}, not 402`);
  const header = unpaid.headers.get("payment-required");
  const challenge: unknown = header ?? (await unpaid.json());

  const server: number[] = [];
  const wall: number[] = [];
  let non200 = 0;
  let firstBody: Record<string, unknown> | null = null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await fetch(`${api}/api/v1/check/presign`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ challenge, url: seller }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const elapsed = performance.now() - t0;
    if (res.status !== 200) {
      non200++;
      continue;
    }
    firstBody ??= body;
    const m = /presign;dur=([0-9.]+)/.exec(res.headers.get("server-timing") ?? "");
    if (m) server.push(Number(m[1]));
    wall.push(elapsed);
  }
  server.sort((a, b) => a - b);
  wall.sort((a, b) => a - b);
  const p99 = round1(nearestRank(server, 0.99));
  const doc = {
    endpoint: "POST /api/v1/check/presign",
    measured_at: new Date().toISOString(),
    measured_by: UA,
    definition:
      "server_ms is the Server-Timing presign;dur value of each 200 response: the time from the start of the route handler to the response, rate limit and lookup included, network and platform routing not included. " +
      "wall_ms is the round trip measured by the probe, network included. p50 and p99 are nearest-rank over the 200 responses of this run. " +
      "The probe sends the calls one after another with the same 402, so later calls can hit the 60-second check cache. " +
      "This file counts the calls of this probe run only, not other callers.",
    seller_url: seller,
    requests: n,
    samples: server.length,
    non_200: non200,
    server_ms: { p50: round1(nearestRank(server, 0.5)), p99, max: round1(server.length ? server[server.length - 1]! : null) },
    wall_ms: { p50: round1(nearestRank(wall, 0.5)), p99: round1(nearestRank(wall, 0.99)) },
    target_p99_server_ms: TARGET_P99_MS,
    target_met: server.length >= 20 && p99 !== null && p99 <= TARGET_P99_MS,
    example: firstBody
      ? {
          recommendation: firstBody.recommendation ?? null,
          rules_version: firstBody.rules_version ?? null,
          matching_accepts: firstBody.matching_accepts ?? null,
        }
      : null,
  };
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(JSON.stringify({ samples: doc.samples, server_ms: doc.server_ms, wall_ms: doc.wall_ms, target_met: doc.target_met, non_200: non200 }));
}

if (process.argv[1]?.endsWith("presign-latency-probe.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

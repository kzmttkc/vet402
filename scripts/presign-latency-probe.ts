// ============================================================
// POST /api/v1/check/presign の速さを測り、public/data/presign-latency.json に書く（2026-11-27 F7）。
//
// 使い方（同じ売り手を続けて確かめる系列。server_ms・wall_ms・cold_start_*）:
//   npx tsx scripts/presign-latency-probe.ts [--n 200] [--interval-ms 1100] [--seller <402 を返す URL>] [--api https://vet402.com]
//   1. 売り手の URL を払わずに 1 回 GET し、返った 402（PAYMENT-REQUIRED ヘッダ、無ければ本文）を取る
//   2. その本文を { challenge, url } にして vet402 へ n 回、順に POST する（並べない。同じ IP の枠に収める）
//   3. 応答の Server-Timing presign;dur（回数制限から応答までのサーバ内の時間）と、手元の往復の時間を記録する
//   4. 200 で返った回だけを数える。1 回目は cold_start として別に記録し、p50・p99（nearest-rank）は残りで出す
//
// 使い方（初めて確かめる売り手の系列。distinct_sellers。2026-11-28）:
//   npx tsx scripts/presign-latency-probe.ts --distinct-sellers 100 [--interval-ms 1100] [--api https://vet402.com]
//   1. 公開の GET /api/v1/delivery/sellers.json?min_delivered=1 から、30 日に届けた売り手の GET の URL を 1 ホスト 1 本で選ぶ
//   2. URL ごとに本物の 402 を取ってから presign に 1 回だけ送る。同じ URL を 2 回送らない（402 を返さない URL は飛ばす）
//   3. 1 回ごとに presign;dur・往復・Server-Timing cache の desc（direct / fresh / prefetch / coalesced）を記録する
//   4. 既存の JSON の同じ売り手の系列は消さずに、distinct_sellers だけを書き換える
// --interval-ms: presign を呼ぶ間隔。鍵なしの枠は 1 IP で毎分 60 回なので、既定 1100ms で枠に当たらない。
// 書いた JSON を commit して出すと、https://vet402.com/data/presign-latency.json に載る。
// 数えるのはこのスクリプトが呼んだ回だけ（ほかの呼び手の回は数えない）。DB には何も書かない。
// ============================================================
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const UA = "vet402-presign-latency-probe/2";
const TARGET_P99_MS = 300;
const SAME_SELLER_DEFAULT = "https://1gateway.dev/v1/news/brief";
const SELLER_FETCH_TIMEOUT_MS = 10_000;

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

/** p50・p99（nearest-rank）と max。並べ替えは写しで行い、渡した配列は変えない。 */
export function summarize(values: readonly number[]): { p50: number | null; p99: number | null; max: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: round1(nearestRank(sorted, 0.5)),
    p99: round1(nearestRank(sorted, 0.99)),
    max: round1(sorted.length ? sorted[sorted.length - 1]! : null),
  };
}

/** Server-Timing から presign;dur と cache の desc を取る。無ければ null。 */
export function parseServerTiming(header: string | null): { presignMs: number | null; cachePath: string | null } {
  const h = header ?? "";
  const dur = /(?:^|,)\s*presign;dur=([0-9.]+)/.exec(h);
  const desc = /(?:^|,)\s*cache;dur=[0-9.]+;desc="([^"]*)"/.exec(h);
  return { presignMs: dur ? Number(dur[1]) : null, cachePath: desc ? desc[1]! : null };
}

/**
 * sellers.json の行から、30 日に届けた（delivered_30d >= 1）https の GET の URL を、1 ホスト 1 本で選ぶ。
 * 届けた回数の多い順、同数は URL の順。exclude の URL とそのホストは選ばない。同じ URL は返さない。
 */
export function pickDistinctSellerUrls(rows: readonly unknown[], exclude: readonly string[] = []): string[] {
  type Row = { url: string; delivered: number };
  const excludedHosts = new Set<string>();
  for (const u of exclude) {
    try {
      excludedHosts.add(new URL(u).hostname);
    } catch {
      // 読めない URL は除外の対象にしない
    }
  }
  const ok: Row[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.url !== "string" || row.method !== "GET") continue;
    const delivered = typeof row.delivered_30d === "number" ? row.delivered_30d : 0;
    if (delivered < 1) continue;
    let parsed: URL;
    try {
      parsed = new URL(row.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    ok.push({ url: row.url, delivered });
  }
  ok.sort((a, b) => b.delivered - a.delivered || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const seenHosts = new Set<string>(excludedHosts);
  const seenUrls = new Set<string>();
  const out: string[] = [];
  for (const row of ok) {
    const host = new URL(row.url).hostname;
    if (seenHosts.has(host) || seenUrls.has(row.url)) continue;
    seenHosts.add(host);
    seenUrls.add(row.url);
    out.push(row.url);
  }
  return out;
}

export type DistinctSample = {
  url: string;
  status: number;
  server_ms: number | null;
  wall_ms: number;
  cache_path: string | null;
};

export type DistinctRun = {
  samples: DistinctSample[];
  skipped_not_402: number;
  skipped_fetch_error: number;
  posted_urls: string[];
};

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 候補の URL を順に 1 回ずつ、本物の 402 を取ってから presign に送る。n 回送ったら止める。
 * 同じ URL は 2 回送らない（候補に重複があっても飛ばす）。402 を返さない URL は送らずに数えるだけ。
 */
export async function runDistinctSellers(opts: {
  candidates: readonly string[];
  n: number;
  api: string;
  intervalMs: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DistinctRun> {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => performance.now());
  const posted = new Set<string>();
  const run: DistinctRun = { samples: [], skipped_not_402: 0, skipped_fetch_error: 0, posted_urls: [] };
  for (const url of opts.candidates) {
    if (run.posted_urls.length >= opts.n) break;
    if (posted.has(url)) continue;
    let challenge: unknown;
    try {
      const unpaid = await fetchFn(url, {
        headers: { "user-agent": UA, accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(SELLER_FETCH_TIMEOUT_MS),
      });
      if (unpaid.status !== 402) {
        run.skipped_not_402++;
        continue;
      }
      const header = unpaid.headers.get("payment-required");
      challenge = header ?? (await unpaid.json());
    } catch {
      run.skipped_fetch_error++;
      continue;
    }
    if (run.posted_urls.length > 0 && opts.intervalMs > 0) await sleep(opts.intervalMs);
    posted.add(url);
    run.posted_urls.push(url);
    const t0 = now();
    const res = await fetchFn(`${opts.api}/api/v1/check/presign`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ challenge, url }),
    });
    await res.text();
    const elapsed = now() - t0;
    const timing = parseServerTiming(res.headers.get("server-timing"));
    run.samples.push({ url, status: res.status, server_ms: timing.presignMs, wall_ms: elapsed, cache_path: timing.cachePath });
  }
  return run;
}

/** distinct_sellers の系列。200 で presign;dur がある回だけを数え、cache の経路の内訳を付ける。 */
export function distinctSellersSeries(run: DistinctRun, requested: number, measuredAt: string) {
  const ok = run.samples.filter((s) => s.status === 200 && s.server_ms !== null);
  const cachePath: Record<string, number> = {};
  for (const s of ok) {
    const k = s.cache_path ?? "none";
    cachePath[k] = (cachePath[k] ?? 0) + 1;
  }
  return {
    measured_at: measuredAt,
    requested_sellers: requested,
    requests: run.posted_urls.length,
    samples: ok.length,
    non_200: run.samples.filter((s) => s.status !== 200).length,
    skipped_not_402: run.skipped_not_402,
    skipped_fetch_error: run.skipped_fetch_error,
    cache_path: cachePath,
    server_ms: summarize(ok.map((s) => s.server_ms!)),
    wall_ms: summarize(ok.map((s) => s.wall_ms)),
  };
}

const DISTINCT_DEFINITION =
  "distinct_sellers is a separate run for the first check of a seller: the probe picks sellers that delivered in the last 30 days from GET /api/v1/delivery/sellers.json?min_delivered=1 (one GET URL per host, most deliveries first, the same-seller probe's host left out), " +
  "fetches each seller's real 402 without paying, and sends it to presign once. No URL is sent twice. URLs that did not answer 402 are skipped and counted, not sent. " +
  "server_ms and wall_ms are defined as above; p50 and p99 are nearest-rank over the responses with status 200 of that run, and max is the slowest. " +
  "cache_path counts the Server-Timing cache desc of those responses (none when the desc was missing): direct and coalesced read the seller in the request; fresh is a value the 60-second check cache returned, which on a first check is either the read made in this request (nothing was cached) or a value another caller left in the last 60 seconds; prefetch is a value read ahead in the background.";

/** 同じ売り手の系列の定義。remaining は 1 回目を除いた 200 の件数（warmup_samples）。 */
export function sameSellerDefinition(remaining: number): string {
  return (
    "server_ms is the Server-Timing presign;dur value of each 200 response: the time from the start of the route handler to the response, rate limit and lookup included, network and platform routing not included. " +
    "wall_ms is the round trip measured by the probe, network included. " +
    "cold_start_server_ms and cold_start_wall_ms are from the first 200 of the run (cold check cache and instance warmup on the probe's seller URL). " +
    `p50 and p99 are nearest-rank over the remaining ${remaining} responses with status 200 (all but the first), counted in warmup_samples. ` +
    "The probe sends the calls one after another with the same 402 to seller_url, so later calls can hit the 60-second check cache: server_ms is the speed of checking the same seller again, not of a first check. " +
    `target_met judges server_ms of this same-seller series only: true when warmup_samples is 20 or more and server_ms.p99 is at or under target_p99_server_ms (${TARGET_P99_MS}). It does not judge cold_start_server_ms or distinct_sellers. ` +
    "This file counts the calls of this probe run only, not other callers."
  );
}

function readExisting(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchSellerRows(api: string): Promise<unknown[]> {
  const res = await fetch(`${api}/api/v1/delivery/sellers.json?min_delivered=1`, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (res.status !== 200) throw new Error(`sellers.json answered ${res.status}`);
  const body = (await res.json()) as { rows?: unknown };
  if (!Array.isArray(body.rows)) throw new Error("sellers.json has no rows");
  return body.rows;
}

async function mainDistinct(count: number, api: string, out: string, intervalMs: number): Promise<void> {
  const existing = readExisting(out);
  if (!existing) throw new Error(`${out} is missing; run the same-seller probe first`);
  const sameSeller = typeof existing.seller_url === "string" ? existing.seller_url : SAME_SELLER_DEFAULT;
  const candidates = pickDistinctSellerUrls(await fetchSellerRows(api), [sameSeller]);
  const run = await runDistinctSellers({ candidates, n: count, api, intervalMs });
  const series = distinctSellersSeries(run, count, new Date().toISOString());
  const remaining = typeof existing.warmup_samples === "number" ? existing.warmup_samples : Math.max(0, Number(existing.samples ?? 0) - 1);
  const doc = {
    ...existing,
    definition: sameSellerDefinition(remaining),
    distinct_sellers_definition: DISTINCT_DEFINITION,
    distinct_sellers: series,
  };
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(JSON.stringify(series));
}

async function main(): Promise<void> {
  const api = arg("api", "https://vet402.com");
  const out = arg("out", "public/data/presign-latency.json");
  const intervalMs = Number(arg("interval-ms", "1100"));
  const distinct = arg("distinct-sellers", "");
  if (distinct) {
    const count = Number(distinct);
    if (!Number.isInteger(count) || count < 1) throw new Error("--distinct-sellers needs a positive integer");
    await mainDistinct(count, api, out, intervalMs);
    return;
  }

  const n = Number(arg("n", "200"));
  const seller = arg("seller", SAME_SELLER_DEFAULT);

  const unpaid = await fetch(seller, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "follow" });
  if (unpaid.status !== 402) throw new Error(`seller answered ${unpaid.status}, not 402`);
  const header = unpaid.headers.get("payment-required");
  const challenge: unknown = header ?? (await unpaid.json());

  const serverAll: number[] = [];
  const wallAll: number[] = [];
  let non200 = 0;
  let firstBody: Record<string, unknown> | null = null;
  for (let i = 0; i < n; i++) {
    if (i > 0 && intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
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
    if (!m) throw new Error(`call ${i + 1}: 200 without Server-Timing presign;dur`);
    serverAll.push(Number(m[1]));
    wallAll.push(elapsed);
  }

  const coldStartServer = serverAll.length > 0 ? serverAll[0]! : null;
  const coldStartWall = wallAll.length > 0 ? wallAll[0]! : null;
  const server = serverAll.slice(1);
  const wall = wallAll.slice(1);
  server.sort((a, b) => a - b);
  wall.sort((a, b) => a - b);
  const p99 = round1(nearestRank(server, 0.99));
  const existing = readExisting(out);
  const doc = {
    endpoint: "POST /api/v1/check/presign",
    measured_at: new Date().toISOString(),
    measured_by: UA,
    definition: sameSellerDefinition(server.length),
    seller_url: seller,
    requests: n,
    samples: serverAll.length,
    warmup_samples: server.length,
    non_200: non200,
    cold_start_server_ms: round1(coldStartServer),
    cold_start_wall_ms: round1(coldStartWall),
    server_ms: {
      p50: round1(nearestRank(server, 0.5)),
      p99,
      max: round1(server.length ? server[server.length - 1]! : null),
    },
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
    // 初めて確かめる売り手の系列は別の実行で書く。同じ売り手の実行では消さない。
    ...(existing && existing.distinct_sellers
      ? { distinct_sellers_definition: existing.distinct_sellers_definition, distinct_sellers: existing.distinct_sellers }
      : {}),
  };
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    JSON.stringify({
      samples: doc.samples,
      warmup_samples: doc.warmup_samples,
      cold_start_server_ms: doc.cold_start_server_ms,
      server_ms: doc.server_ms,
      wall_ms: doc.wall_ms,
      target_met: doc.target_met,
      non_200: non200,
    }),
  );
}

if (process.argv[1]?.endsWith("presign-latency-probe.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

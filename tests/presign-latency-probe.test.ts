// 2026-11-28: presign の遅延の「初めて確かめる売り手」系列（distinct_sellers）の計算と、同じ URL を2回送らないこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  distinctSellersSeries,
  parseServerTiming,
  pickDistinctSellerUrls,
  runDistinctSellers,
  sameSellerDefinition,
  summarize,
} from "../scripts/presign-latency-probe";

const row = (url: string, delivered: number, method = "GET") => ({ url, method, delivered_30d: delivered });

test("presign probe: Server-Timing gives presign;dur and the cache desc", () => {
  assert.deepEqual(
    parseServerTiming('cache;dur=412.3;desc="direct", terms;dur=0.4, sign;dur=1.2, presign;dur=420.9'),
    { presignMs: 420.9, cachePath: "direct" },
  );
  assert.deepEqual(parseServerTiming("sign;dur=1.0, presign;dur=3.5"), { presignMs: 3.5, cachePath: null });
  assert.deepEqual(parseServerTiming(null), { presignMs: null, cachePath: null });
});

test("presign probe: summarize is nearest-rank p50 and p99 with max, and does not reorder the input", () => {
  const values = Array.from({ length: 100 }, (_, i) => 100 - i);
  const copy = [...values];
  assert.deepEqual(summarize(values), { p50: 50, p99: 99, max: 100 });
  assert.deepEqual(values, copy);
  assert.deepEqual(summarize([]), { p50: null, p99: null, max: null });
  assert.deepEqual(summarize([7.25]), { p50: 7.3, p99: 7.3, max: 7.3 });
});

test("presign probe: sellers are delivered https GET URLs, one per host, most deliveries first, excluded host left out", () => {
  const urls = pickDistinctSellerUrls(
    [
      row("https://a.example/one", 3),
      row("https://a.example/two", 9),
      row("https://b.example/x", 5),
      row("https://b.example/x", 5),
      row("https://c.example/never", 0),
      row("http://d.example/plain", 4),
      row("https://e.example/post", 8, "POST"),
      row("https://1gateway.dev/v1/other", 50),
      row("not a url", 2),
      null,
    ],
    ["https://1gateway.dev/v1/news/brief"],
  );
  assert.deepEqual(urls, ["https://a.example/two", "https://b.example/x"]);
  assert.equal(new Set(urls).size, urls.length);
});

function fakeFetch(statusOf: (url: string) => number) {
  const posted: string[] = [];
  let clock = 0;
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/api/v1/check/presign")) {
      const body = JSON.parse(String(init?.body)) as { url: string; challenge: unknown };
      posted.push(body.url);
      clock += 100;
      const path = posted.length === 1 ? "direct" : posted.length === 2 ? "coalesced" : "fresh";
      return new Response("{}", {
        status: 200,
        headers: { "server-timing": `cache;dur=1.0;desc="${path}", presign;dur=${posted.length * 10}` },
      });
    }
    const status = statusOf(input);
    return new Response(JSON.stringify({ x402Version: 2, accepts: [] }), { status });
  };
  return { fetchFn, posted, now: () => clock };
}

test("presign probe: distinct run fetches the real 402 first, never posts the same URL twice, and skips non-402", async () => {
  const f = fakeFetch((url) => (url.includes("free") ? 200 : 402));
  const sleeps: number[] = [];
  const run = await runDistinctSellers({
    candidates: ["https://a.example/p", "https://a.example/p", "https://free.example/p", "https://b.example/p", "https://c.example/p", "https://d.example/p"],
    n: 3,
    api: "https://vet402.test",
    intervalMs: 1100,
    fetchFn: f.fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: f.now,
  });
  assert.deepEqual(f.posted, ["https://a.example/p", "https://b.example/p", "https://c.example/p"]);
  assert.equal(new Set(f.posted).size, f.posted.length);
  assert.deepEqual(run.posted_urls, f.posted);
  assert.equal(run.skipped_not_402, 1);
  assert.deepEqual(sleeps, [1100, 1100]);

  const series = distinctSellersSeries(run, 3, "2026-11-28T00:00:00.000Z");
  assert.equal(series.requests, 3);
  assert.equal(series.samples, 3);
  assert.equal(series.non_200, 0);
  assert.equal(series.skipped_not_402, 1);
  assert.deepEqual(series.cache_path, { direct: 1, coalesced: 1, fresh: 1 });
  assert.deepEqual(series.server_ms, { p50: 20, p99: 30, max: 30 });
});

test("presign probe: distinct series counts only 200 with presign;dur, non-200 apart", () => {
  const series = distinctSellersSeries(
    {
      samples: [
        { url: "https://a.example/", status: 200, server_ms: 500, wall_ms: 900, cache_path: "direct" },
        { url: "https://b.example/", status: 429, server_ms: 1, wall_ms: 50, cache_path: null },
        { url: "https://c.example/", status: 200, server_ms: 700, wall_ms: 1200, cache_path: null },
      ],
      skipped_not_402: 0,
      skipped_fetch_error: 2,
      posted_urls: ["https://a.example/", "https://b.example/", "https://c.example/"],
    },
    100,
    "2026-11-28T00:00:00.000Z",
  );
  assert.equal(series.requested_sellers, 100);
  assert.equal(series.samples, 2);
  assert.equal(series.non_200, 1);
  assert.equal(series.skipped_fetch_error, 2);
  assert.deepEqual(series.cache_path, { direct: 1, none: 1 });
  assert.deepEqual(series.server_ms, { p50: 500, p99: 700, max: 700 });
  assert.deepEqual(series.wall_ms, { p50: 900, p99: 1200, max: 1200 });
});

test("presign latency file: the definition names the real count after the first and what target_met judges", () => {
  const doc = JSON.parse(readFileSync("public/data/presign-latency.json", "utf8")) as {
    definition: string;
    warmup_samples: number;
    samples: number;
    distinct_sellers?: { samples: number; requests: number; cache_path: Record<string, number>; server_ms: { p50: number | null; p99: number | null; max: number | null } };
  };
  assert.equal(doc.warmup_samples, doc.samples - 1);
  assert.equal(doc.definition, sameSellerDefinition(doc.warmup_samples));
  assert.ok(doc.definition.includes(`remaining ${doc.warmup_samples} responses`));
  assert.ok(doc.definition.includes("target_met judges server_ms of this same-seller series only"));
  if (doc.distinct_sellers) {
    const d = doc.distinct_sellers;
    assert.equal(Object.values(d.cache_path).reduce((a, b) => a + b, 0), d.samples);
    assert.ok(d.samples <= d.requests);
    if (d.samples > 0) assert.ok(d.server_ms.p50! <= d.server_ms.p99! && d.server_ms.p99! <= d.server_ms.max!);
  }
});

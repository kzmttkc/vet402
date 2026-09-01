import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";

/**
 * GET /api/v1/observatory/live — 観測のライブフィード（C10・SSE）。
 *
 * 新しい L0 プローブと L1 実購入を、発生からポーリング間隔（5秒）以内で
 * 流す。サーバレスの実行上限内で 55 秒ごとに接続を閉じる——SSE クライアント
 * は自動再接続し、Last-Event-ID で取りこぼさない（イベントIDは
 * probe/purchase の作成時刻をミリ秒で刻む）。
 *
 * 語彙は他の公開面と同一の閉集合。ここに「ライブ用の演出」は無い——
 * 流れているのは台帳に書かれたそのままの行。
 */

export const maxDuration = 60;

const POLL_MS = 5_000;
const WINDOW_MS = 55_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-live:${ip}`, 10, 60_000);
  if (!limited.allowed) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }
  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "observatory_unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const lastEventId = request.headers.get("last-event-id");
  let cursor = Number(lastEventId ?? NaN);
  if (!Number.isFinite(cursor)) cursor = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, id: number, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const startedAt = Date.now();
      send("hello", cursor, { note: "ledger rows as they land; reconnect with Last-Event-ID" });
      try {
        while (Date.now() - startedAt < WINDOW_MS) {
          const raw = await db.execute(sql`
            SELECT * FROM (
              SELECT 'probe' AS kind, p.probed_at AS at, e.resource_key,
                     p.verdict AS a, coalesce(p.fail_reason, '') AS b
              FROM x402_l0_probes p JOIN x402_endpoints e ON e.id = p.endpoint_id
              WHERE p.probed_at > to_timestamp(${cursor / 1000})
              UNION ALL
              SELECT 'purchase' AS kind, pu.attempted_at AS at, e.resource_key,
                     pu.status AS a, coalesce(pu.tx_hash, '') AS b
              FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
              WHERE pu.attempted_at > to_timestamp(${cursor / 1000})
            ) ev ORDER BY at ASC LIMIT 100
          `);
          const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
            kind: string;
            at: string | Date;
            resource_key: string;
            a: string;
            b: string;
          }[];
          for (const r of rows) {
            const ts = new Date(r.at).getTime();
            cursor = Math.max(cursor, ts);
            send(r.kind, ts, {
              at: new Date(ts).toISOString(),
              resourceKey: r.resource_key,
              ...(r.kind === "probe"
                ? { verdict: r.a, failReason: r.b || null }
                : { status: r.a, txHash: r.b || null }),
            });
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch {
        /* window closes; client reconnects */
      }
      send("bye", cursor, { reconnect: true });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

"use client";

import { useEffect, useState } from "react";
import { livenessBannerMessage } from "@/lib/health/banner-message";

/**
 * Public outage strip. Does not run scoring probes here — layout used to
 * import both engines on every HTML page and `connection()` forced the home
 * memo dynamic. The same two-probe answer lives at GET /api/health (rate
 * limited, 60s memo). This client reads that JSON once per minute.
 */
const CACHE_KEY = "vet402.liveness";
const CACHE_TTL_MS = 60_000;

function readCache(): string | null | undefined {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { at: number; message: string | null };
    if (Date.now() - parsed.at > CACHE_TTL_MS) return undefined;
    return parsed.message;
  } catch {
    return undefined;
  }
}

function writeCache(message: string | null): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), message }));
  } catch {
    // Private mode / quota — the next page view will refetch.
  }
}

export function StatusBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      const cached = readCache();
      if (cached !== undefined) {
        if (!cancelled) setMessage(cached);
        return;
      }

      void fetch("/api/health", { headers: { accept: "application/json" } })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as { status?: string } | null;
          if (body?.status === "rate_limited") return;
          const next = livenessBannerMessage(body?.status);
          writeCache(next);
          if (!cancelled) setMessage(next);
        })
        .catch(() => {
          // A broken client network is not a scoring outage. Stay silent.
        });
    };

    load();
    const id = window.setInterval(load, CACHE_TTL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!message) return null;

  return (
    <div
      role="status"
      className="border-b border-amber-700 bg-amber-50 px-4 py-2 text-center text-[0.84375rem] text-amber-900 sm:px-6 md:px-8"
    >
      {message}
    </div>
  );
}

export default StatusBanner;

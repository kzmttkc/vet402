"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  freshLivenessCache,
  healthBodyUpdatesBanner,
  livenessBannerMessage,
} from "@/lib/health/banner-message";

/**
 * Public outage line. Does not run scoring probes here — layout used to
 * import both engines on every HTML page and `connection()` forced the home
 * memo dynamic. The same two-probe answer lives at GET /api/health (rate
 * limited, 60s memo). This client reads that JSON once per minute.
 *
 * On `/` the strip is not painted (`variant="quiet"`). The same sentence is
 * the second sentence of the ledger read-at line, so the headline does not move.
 */
const CACHE_KEY = "vet402.liveness";
const CACHE_TTL_MS = 60_000;

type Listener = (message: string | null) => void;
let currentMessage: string | null = null;
const listeners = new Set<Listener>();

function publish(message: string | null): void {
  currentMessage = message;
  for (const listener of listeners) listener(message);
}

function readCache(): string | null | undefined {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { at?: number; message?: unknown };
    if (typeof parsed.at !== "number") return undefined;
    if (!("message" in parsed)) return undefined;
    if (parsed.message !== null && typeof parsed.message !== "string") return undefined;
    return freshLivenessCache(parsed.message, parsed.at, Date.now(), CACHE_TTL_MS);
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

function LivenessSentence({ message, linkClassName }: { message: string; linkClassName?: string }) {
  const label = "See status";
  const at = message.indexOf(label);
  if (at < 0) return <>{message}</>;
  return (
    <>
      {message.slice(0, at)}
      <Link href="/status" className={linkClassName ?? "underline underline-offset-[3px]"}>
        {label}
      </Link>
      {message.slice(at + label.length)}
    </>
  );
}

/** Second sentence under the ledger time. Renders nothing until a real failure is known. */
export function HomeLivenessNote({ linkClassName }: { linkClassName?: string }) {
  const message = useLivenessMessage();
  if (!message) return null;
  return (
    <>
      {" "}
      <LivenessSentence message={message} linkClassName={linkClassName} />
    </>
  );
}

function useLivenessMessage(): string | null {
  const [message, setMessage] = useState<string | null>(currentMessage);
  useEffect(() => {
    listeners.add(setMessage);
    setMessage(currentMessage);
    return () => {
      listeners.delete(setMessage);
    };
  }, []);
  return message;
}

export function StatusBanner({ variant = "strip" }: { variant?: "quiet" | "strip" }) {
  const [message, setMessage] = useState<string | null>(currentMessage);

  useEffect(() => {
    let cancelled = false;

    const apply = (next: string | null) => {
      publish(next);
      if (!cancelled) setMessage(next);
    };

    const load = (bypassCache: boolean) => {
      if (!bypassCache) {
        const cached = readCache();
        if (cached !== undefined) {
          apply(cached);
          return;
        }
      }

      void fetch("/api/health", { headers: { accept: "application/json" } })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as { status?: string } | null;
          // Non-OK, a missing status, and rate_limited leave the line as it is.
          if (!healthBodyUpdatesBanner(res.ok, body?.status)) return;
          const next = livenessBannerMessage(body?.status);
          writeCache(next);
          apply(next);
        })
        .catch(() => {
          // A broken client network is not a scoring outage. Stay silent.
        });
    };

    load(false);
    // The interval bypasses the cache. A cache hit on the tick would skip the
    // fetch for another full TTL, so a recovered index would stay on screen.
    const id = window.setInterval(() => load(true), CACHE_TTL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (variant === "quiet" || !message) return null;

  return (
    <div
      role="status"
      className="border-b px-4 py-2 text-center text-[0.8125rem] sm:px-6 md:px-8"
    >
      <LivenessSentence message={message} />
    </div>
  );
}

export default StatusBanner;

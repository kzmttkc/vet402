"use client";

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics";

// 2026-08-06 growth: mount-once view tracker for server components (the LP,
// /docs/api and /payee/:address are all RSC pages). Fire once per page load,
// never on re-render. Events go to first-party site_events_daily via track().
export default function TrackView({
  event,
  props,
  withUtmSource,
  withReferrerType,
}: {
  event: string;
  props?: Record<string, string | number | boolean>;
  /** Adds source=utm_source|"direct" (Verilot lp_view parity). */
  withUtmSource?: boolean;
  /**
   * Adds referrer="external"|"internal"|"direct". Coarse on purpose: we want
   * to see badge-embed inflow (external referrer) on /payee/:address without
   * recording the referring URL itself.
   */
  withReferrerType?: boolean;
}) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const extra: Record<string, string | number | boolean> = { ...props };
    if (withUtmSource) {
      extra.source =
        new URLSearchParams(window.location.search).get("utm_source") ||
        "direct";
    }
    if (withReferrerType) {
      try {
        const ref = document.referrer;
        extra.referrer = !ref
          ? "direct"
          : new URL(ref).hostname === window.location.hostname
            ? "internal"
            : "external";
      } catch {
        extra.referrer = "direct";
      }
    }
    track(event, Object.keys(extra).length > 0 ? extra : undefined);
    // Intentionally mount-once: deps would refire on prop identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

"use client";

// First-party site usage counts (2026-11-09). The browser sends {e,p,r} to /api/v1/site-events
// on vet402.com itself. No third-party analytics script. Props stay in the signature for callers
// but are not transmitted (no PII on the wire).
//
// Fire-and-forget: analytics must never throw or block navigation.

type SiteEventPayload = { e: string; p: string; r: string };

function currentPathname(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
}

/** Shared transport for track() and PageViewBeacon. */
export function sendSiteEvent(payload: SiteEventPayload): void {
  try {
    const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: "application/json" });
  if (typeof navigator !== "undefined" && navigator.sendBeacon?.("/api/v1/site-events", blob)) return;
    void fetch("/api/v1/site-events", {
      method: "POST",
      body: json,
      headers: { "content-type": "application/json" },
      keepalive: true,
      cache: "no-store",
    });
  } catch {
    /* analytics must never break the page */
  }
}

function referrerHostFromProp(props?: Record<string, string | number | boolean>): string {
  const r = props?.r;
  if (typeof r === "string" && r.trim()) return r.trim().slice(0, 253);
  return "internal";
}

export function track(
  event: string,
  props?: Record<string, string | number | boolean>
) {
  try {
    sendSiteEvent({ e: event, p: currentPathname(), r: referrerHostFromProp(props) });
    (window as unknown as { clarity?: (cmd: string, name: string) => void }).clarity?.("event", event);
  } catch {
    /* analytics must never break the page */
  }
}

/** Outbound / mailto clicks for funnel actions (href host only, no navigation blocking). */
export function trackOutboundFromHref(href: string): void {
  try {
    if (href.startsWith("mailto:")) {
      track("contact_click", { r: "internal" });
      return;
    }
    if (!/^https?:\/\//i.test(href)) return;
    const host = new URL(href).hostname.toLowerCase();
    let event = "outbound_other";
    if (host === "github.com" || host.endsWith(".github.com")) event = "outbound_github";
    else if (host === "npmjs.com" || host.endsWith(".npmjs.com")) event = "outbound_npm";
    else if (host === "x.com" || host === "twitter.com" || host === "t.co" || host.endsWith(".twitter.com"))
      event = "outbound_x";
    track(event, { r: "internal" });
  } catch {
    /* analytics must never break the page */
  }
}

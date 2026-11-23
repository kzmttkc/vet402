"use client";

import dynamic from "next/dynamic";

// Code-split, still server-rendered (no client-only option).
const ApiEndpointsSection = dynamic(() => import("@/components/docs/ApiEndpointsSection"), {
  // Rendered on the server too: crawlers, agents and the surface canary read this reference from the HTML (the client-only option emptied it 2026-11-21..23, issue #107).
  loading: () => <p className="text-[0.84375rem] text-brand">Loading endpoint reference…</p>,
});

export default ApiEndpointsSection;

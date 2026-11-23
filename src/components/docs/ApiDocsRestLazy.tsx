"use client";

import dynamic from "next/dynamic";

const ApiDocsRest = dynamic(() => import("@/components/docs/ApiDocsRest"), {
  // Rendered on the server too: crawlers, agents and the surface canary read this reference from the HTML (the client-only option emptied it 2026-11-21..23, issue #107).
  loading: () => <p className="text-[0.84375rem] text-brand">Loading API reference…</p>,
});

export default function ApiDocsRestLazy({ inviteRequired }: { inviteRequired: boolean }) {
  return <ApiDocsRest inviteRequired={inviteRequired} />;
}
"use client";

import { SITE_URL } from "@/lib/site-url";
import { track } from "@/lib/analytics";
import { useEffect } from "react";

export default function DashboardIntegrationsPage() {
  const base =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/v1`
      : `${SITE_URL}/api/v1`;

  useEffect(() => {
    track("integrations_view");
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="dash-title">Integrations</h2>
        <p className="dash-lede">Same scores via REST, MCP, or x402 middleware.</p>
      </div>

      <section className="dash-card space-y-3">
        <h3 className="text-base font-semibold">Direct API</h3>
        <p className="text-sm text-zinc-700">Bearer API key. Primary path for gateways and backends.</p>
        <ul className="space-y-1 font-mono text-xs text-zinc-800">
          <li>GET {base}/payees/:address/score</li>
          <li>GET {base}/wallets/:address/score</li>
          <li>GET {base}/agents/:agentId/score</li>
          <li>POST {base}/scores/batch</li>
          <li>POST {base}/payments/x402</li>
        </ul>
        <p className="text-sm text-zinc-700">
          Spec:{" "}
          <a className="underline" href="/docs/api">
            API reference
          </a>
          {" · "}
          <a className="underline" href="https://www.npmjs.com/package/@vet402/sdk">
            npm i @vet402/sdk
          </a>
        </p>
      </section>

      <section className="dash-card space-y-3">
        <h3 className="text-base font-semibold">MCP</h3>
        <p className="text-sm text-zinc-700">
          Agent runtimes can self-check before paying: <code>check_wallet_trust</code>,{" "}
          <code>check_agent_trust</code>, <code>explain_trust_score</code>,{" "}
          <code>attest_x402_payment</code>.
        </p>
        <p className="text-sm text-zinc-700">
          <a className="underline" href="https://www.npmjs.com/package/@vet402/mcp-server">
            npm i @vet402/mcp-server
          </a>
          {" · "}
          <a className="underline" href="/docs/api">
            API reference
          </a>
        </p>
      </section>

      <section className="dash-card space-y-3">
        <h3 className="text-base font-semibold">x402 trust gate</h3>
        <p className="text-sm text-zinc-700">
          Middleware that blocks <code>BLOCK</code> payers and can write settlements back.
        </p>
        <p className="text-sm text-zinc-700">
          <a className="underline" href="https://www.npmjs.com/package/@vet402/middleware">
            npm i @vet402/middleware
          </a>
          {" · "}
          <a className="underline" href="/docs/api">
            API reference
          </a>
        </p>
      </section>
    </div>
  );
}

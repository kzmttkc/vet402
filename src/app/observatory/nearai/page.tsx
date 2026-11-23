import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";
import { NEAR_AI_INFERENCE_SDK_PIN } from "@/lib/nearai/live-probe";
import { getNearAiStore } from "@/lib/nearai/store";
import { countStrictUpToDateMachines } from "@/lib/nearai/read-public";
import type { NearAiProbeOutput } from "@/lib/nearai/probe-types";

export const metadata: Metadata = pageMetadata({
  title: "NEAR AI TEE attestation — vet402 re-verification record",
  description:
    "vet402 re-runs NEAR AI Inference SDK verification (pin 085a304) daily against Cloud attestation endpoints. Gateway keyless ECDSA, Intel PCS TDX, NVIDIA NRAS JWKS. No API key.",
  path: "/observatory/nearai",
});

export const revalidate = 600;

function gpuCellLabel(modelId: string, gpuPass: boolean, output: NearAiProbeOutput | null | undefined): string {
  if (gpuPass) return "pass";
  const probed = output?.nearaiModelsProbed.find((m) => m.modelId === modelId);
  const missing = probed?.candidates?.some((c) => c.gpu.present === false);
  if (missing) return "not provided";
  return "fail";
}

export default async function ObservatoryNearAiPage() {
  const store = getNearAiStore();
  const run = await store.getLatestRun();
  const snapshot = run ? await store.getLatestPublicSnapshot() : null;
  const machineCount = run ? countStrictUpToDateMachines(run.output) : 0;
  const probeOutput = run?.output ?? null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 font-sans text-neutral-900">
      <p className="text-sm text-neutral-600">
        <Link href="/observatory/state" className="underline">
          Observatory
        </Link>
        {" / NEAR AI TEE"}
      </p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">NEAR AI TEE — vet402 re-verification record</h1>
      <p className="mt-3 text-base leading-relaxed text-neutral-800">
        vet402 re-runs the published verification steps from the{" "}
        <a
          href="https://github.com/nearai/inference-sdk/blob/085a304/go/docs/verification-guide.md"
          className="underline"
        >
          NEAR AI Inference SDK
        </a>{" "}
        (pinned commit <code className="font-mono text-sm">{NEAR_AI_INFERENCE_SDK_PIN}</code>) once a day at 09:00 UTC
        against NEAR AI Cloud&apos;s public attestation endpoints (no API key). Checks include Gateway TLS binding
        (keyless <strong>ECDSA</strong> requests), Intel DCAP via the SDK default <strong>Intel PCS</strong>, optional
        compose-manager nested TDX, RTMR3 replay, and NVIDIA NRAS GPU JWT verification (ES384 against NVIDIA JWKS when
        evidence is present).
      </p>
      <p className="mt-3 text-sm leading-relaxed text-neutral-700">
        Out-of-date TCB with valid cryptography is labeled <strong>Advisory</strong> (SDK default also accepts{" "}
        <code className="font-mono">OutOfDate</code> and <code className="font-mono">TDRelaunchAdvised</code>). Missing
        GPU evidence is <strong>not provided</strong>, never a pass. PCCS or NRAS outages are <strong>Unverified</strong>.
        Two consecutive serious mismatches are required before a model is confirmed failed; serious mismatches may be held
        for a private report. Known differences from the SDK client: vet402 does not load NEAR&apos;s response signature
        or use ed25519 for gateway probes; model probes use keyless ECDSA; image provenance / deployment verifier hooks
        are not run; Phala PCCS remains available via <code className="font-mono">NEARAI_USE_PHALA_PCCS=1</code>.
      </p>
      {!snapshot ? (
        <p className="mt-6 text-neutral-700">No published run yet.</p>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-1 gap-3 border-t border-neutral-200 pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-neutral-600">Last run (UTC)</dt>
              <dd className="font-mono">{snapshot.runCompletedAt}</dd>
            </div>
            <div>
              <dt className="text-neutral-600">Private TEE models shown</dt>
              <dd>{snapshot.nearaiModelCount}</dd>
            </div>
            <div>
              <dt className="text-neutral-600">Collateral (PCCS)</dt>
              <dd className="font-mono text-xs break-all">{probeOutput?.pccsUrl ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-neutral-600">Gateway TCB</dt>
              <dd>
                {snapshot.gateway.tcbStatus} ({snapshot.gateway.status})
              </dd>
            </div>
            <div>
              <dt className="text-neutral-600">UpToDate candidate instances (this run)</dt>
              <dd>{machineCount}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm font-mono text-neutral-600">
            Machine JSON: /api/v1/observatory/nearai
          </p>
          <div className="mt-8 overflow-x-auto border border-neutral-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">TCB</th>
                  <th className="px-3 py-2 font-medium">GPU</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">#</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.models.map((m) => (
                  <tr key={m.modelId} className="border-t border-neutral-200">
                    <td className="px-3 py-2 font-mono text-xs">{m.modelId}</td>
                    <td className="px-3 py-2">{m.tcbStatus}</td>
                    <td className="px-3 py-2">{gpuCellLabel(m.modelId, m.gpuPass, probeOutput)}</td>
                    <td className="px-3 py-2">
                      {m.status === "advisory" && m.advisoryIds.length > 0
                        ? `Advisory (${m.advisoryIds.join(", ")})`
                        : m.status}
                    </td>
                    <td className="px-3 py-2">{m.candidateCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
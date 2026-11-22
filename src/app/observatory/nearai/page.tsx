import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/seo";
import { getNearAiStore } from "@/lib/nearai/store";
import { countStrictUpToDateMachines } from "@/lib/nearai/read-public";

export const metadata: Metadata = pageMetadata({
  title: "NEAR AI TEE attestation — vet402 re-verification record",
  description:
    "vet402 re-verifies NEAR AI Cloud public TEE attestation on a published schedule (Gateway, Intel TDX, NVIDIA NRAS). No API key.",
  path: "/observatory/nearai",
});

export const revalidate = 600;

export default async function ObservatoryNearAiPage() {
  const store = getNearAiStore();
  const run = await store.getLatestRun();
  const snapshot = run ? await store.getLatestPublicSnapshot() : null;
  const machineCount = run ? countStrictUpToDateMachines(run.output) : 0;

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
        vet402 reads NEAR AI Cloud&apos;s public attestation endpoints on the published schedule (no API key) and records
        whether Gateway TLS binding, Intel TDX quotes, and NVIDIA NRAS GPU checks still verify. Out-of-date TCB with valid
        cryptography is labeled <strong>Advisory</strong>, not Fail. PCCS or NRAS outages are <strong>Unverified</strong>,
        not counted as NEAR&apos;s failure.
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
                    <td className="px-3 py-2">{m.gpuPass ? "pass" : "—"}</td>
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
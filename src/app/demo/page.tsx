import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "60-second demo | vet402",
  description:
    "One minute: we buy from an x402 endpoint with real USDC on Base, publish the receipt, and publish the failures with the same weight.",
};

const SHOTS = [
  ["0:05", "The public x402 catalog we track, measured every day"],
  ["0:14", "One endpoint — paid with real USDC on Base, receipt attached"],
  ["0:25", "The same payment on-chain: 0.02 USDC transferred on Base"],
  ["0:35", "Failures carry the same weight — paid, and nothing settled"],
  ["0:44", "Every aggregate is public JSON — no key needed"],
];

export default function DemoPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">vet402 in 60 seconds</h1>
      <p className="mt-3 text-sm leading-relaxed opacity-80">
        No narration, no slides — every frame is a live page you can open yourself. Recorded 2026-08-25.
      </p>
      <video
        className="mt-8 w-full rounded-lg border"
        src="/vet402-demo.mp4"
        controls
        playsInline
        preload="metadata"
      />
      <ul className="mt-8 space-y-2 text-sm">
        {SHOTS.map(([t, label]) => (
          <li key={t} className="flex gap-3">
            <span className="font-mono opacity-60">{t}</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm opacity-80">
        Check it without us:{" "}
        <a className="underline" href="/api/v1/observatory/state">/api/v1/observatory/state</a> ·{" "}
        <a className="underline" href="/observatory/methodology">methodology</a> ·{" "}
        <a className="underline" href="/accuracy">accuracy ledger</a>
      </p>
    </main>
  );
}

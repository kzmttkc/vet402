// Read-only dry run of the Arkiv ruling gate (src/lib/observatory/arkiv-ruling-gate.ts) against the live
// Arkiv and Arc testnet nodes. It reads rulings only: no key, no wallet, no payment.
// Usage: npx tsx scripts/arkiv-ruling-gate-dryrun.ts [payTo ...]
import { checkArkivRuling } from "@/lib/observatory/arkiv-ruling-gate";

const DEFAULTS = [
  // Seller F
  "0x1401bd7c7fab3fe8a429672fc1c5371456c8445d",
  // An address with no ruling.
  "0x1111111111111111111111111111111111111111",
];

const isoSeconds = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function main(): Promise<void> {
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULTS;
  for (const payTo of targets) {
    const result = await checkArkivRuling(payTo);
    const detail =
      result.action === "block"
        ? `verdict=${result.verdict} claim=${result.claimId}`
        : result.action === "allow"
          ? `reason=${result.reason}`
          : `error=${JSON.stringify(result.error)}`;
    console.log(`${isoSeconds()} gate=${result.action} payTo=${payTo} ${detail}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

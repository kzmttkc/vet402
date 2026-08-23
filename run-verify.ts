import { runSettlementVerification } from "@/lib/observatory/settlement-verifier";
async function main() {
  for (let i = 1; i <= 12; i++) {
    const s = await runSettlementVerification({ limit: 120, budgetMs: 150_000 });
    console.log(`round ${i}: ${JSON.stringify(s)}`);
    if (s.scanned === 0) break;
  }
}
main().then(() => process.exit(0));

/**
 * Coinbase AgentKit integration sketch: where SpendGuard sits in a real
 * payment flow.
 *
 * Division of responsibility (deliberate — this is what keeps Vouch
 * non-custodial and outside every money-transmission category):
 *
 *   SpendGuard  — DECIDES:  allow / deny + reasons. No keys, no funds.
 *   AgentKit    — EXECUTES: holds the wallet, signs, submits the transfer.
 *
 * This file compiles as-is; the AgentKit calls themselves are commented so
 * the example carries no heavyweight dependency (`@coinbase/agentkit` pulls
 * in a full wallet stack). Uncomment and `npm install @coinbase/agentkit`
 * to run it for real.
 */
import { createVouchClient, type SpendDecision } from "@vet402/sdk";

// --- 1. One guard per agent process, configured from your risk policy -----

const vouch = createVouchClient({
  apiUrl: process.env.VOUCH_API_URL ?? "https://agent-trust-tawny.vercel.app/api/v1",
  apiKey: process.env.VOUCH_API_KEY!,
});

const guard = vouch.createSpendGuard({
  maxPerTxUsd: 10, // no single payment above $10
  dailyBudgetUsd: 50, // at most $50/day from this process
  minPayeeScore: 40, // payee must score >= 40
  blockOnRecommendation: true, // and must not be BLOCK
});

// --- 2. AgentKit wallet setup (commented: heavyweight dependency) ---------

// import { AgentKit, CdpWalletProvider } from "@coinbase/agentkit";
//
// const walletProvider = await CdpWalletProvider.configureWithWallet({
//   apiKeyName: process.env.CDP_API_KEY_NAME!,
//   apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY!,
//   networkId: "base-mainnet",
// });
// const agentKit = await AgentKit.from({ walletProvider });

// --- 3. The pre-payment gate ----------------------------------------------

export async function payWithGuard(
  payee: string,
  amountUsd: number,
): Promise<{ paid: boolean; decision: SpendDecision; txHash?: string }> {
  // Ask Vouch BEFORE any signing happens.
  const decision = await guard.evaluate({ payee, amountUsd });

  if (!decision.allow) {
    // Surface the machine-readable reasons to the agent loop / operator log.
    console.error(`payment denied: ${decision.reasons.join(", ")}`);
    return { paid: false, decision };
  }

  try {
    // Execution is AgentKit's job — SpendGuard never sees the key material.
    //
    // const transfer = await walletProvider.nativeTransfer(
    //   payee as `0x${string}`,
    //   usdToEth(amountUsd),
    // );
    // return { paid: true, decision, txHash: transfer };
    const txHash = "0x<agentkit-transfer-hash>"; // placeholder for the sketch
    return { paid: true, decision, txHash };
  } catch (error) {
    // The guard reserved amountUsd against today's budget when it allowed
    // the payment. The transfer failed, so return the reservation.
    guard.release(amountUsd);
    throw error;
  }
}

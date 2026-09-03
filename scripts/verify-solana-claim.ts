/**
 * Solana の決済主張を 1 件、オンチェーンで読んで**判定を印字するだけ**の道具。
 *
 * なぜ要るか: 照合器（src/lib/observatory/settlement-verify-solana.ts）を
 * 本番の実データで確かめるため。単体テストはモックで語彙と分岐を固定するが、
 * 「本物の tx を本物の RPC で読んだら settled になるか」は別の問いで、
 * それを確かめずに完了と言わない。
 *
 * **DB には一切書かない（SELECT のみ）。** 台帳を動かすのは日次 cron の
 * runSettlementVerification だけで、この道具はその判断を先取りしない。
 *
 * Usage:
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   DATABASE_URL=... \
 *   npx tsx scripts/verify-solana-claim.ts <purchase-id | tx-signature> [...]
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db/client";
import { SOLANA_USDC_MINT } from "../src/lib/observatory/sol402-payer";
import {
  createSolanaVerifyRpc,
  usdcOwnerDelta,
  verifySolanaSettlement,
} from "../src/lib/observatory/settlement-verify-solana";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Claim = {
  id: string;
  tx_hash: string;
  network: string;
  pay_to: string;
  payer: string;
  amount_units: string;
  status: string;
  settlement_verify_reason: string | null;
};

async function loadClaim(key: string): Promise<Claim | null> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const raw = UUID_RE.test(key)
    ? await db.execute(sql`
        SELECT id::text AS id, tx_hash, network, pay_to, payer, amount_units, status, settlement_verify_reason
        FROM x402_l1_purchases WHERE id = ${key}::uuid LIMIT 1`)
    : await db.execute(sql`
        SELECT id::text AS id, tx_hash, network, pay_to, payer, amount_units, status, settlement_verify_reason
        FROM x402_l1_purchases WHERE tx_hash = ${key} LIMIT 1`);
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Claim[];
  return rows[0] ?? null;
}

async function main() {
  const keys = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (keys.length === 0) {
    console.error("usage: tsx scripts/verify-solana-claim.ts <purchase-id | tx-signature> [...]");
    process.exit(2);
  }

  const rpc = await createSolanaVerifyRpc();
  if (!rpc) {
    console.error("SOLANA_RPC_URL is not set (this tool never falls back to a public RPC silently).");
    process.exit(2);
  }
  console.log(`rpc genesis: ${await rpc.getGenesisHash()}`);

  let failures = 0;
  for (const key of keys) {
    const claim = await loadClaim(key);
    console.log("\n" + "=".repeat(72));
    if (!claim) {
      console.log(`${key}: no x402_l1_purchases row`);
      failures++;
      continue;
    }
    console.log(`purchase   ${claim.id}`);
    console.log(`ledger     status=${claim.status} reason=${claim.settlement_verify_reason ?? "-"}`);
    console.log(`network    ${claim.network}`);
    console.log(`tx         ${claim.tx_hash}`);
    console.log(`expected   payer=${claim.payer} payTo=${claim.pay_to} amount=${claim.amount_units} (USDC 6dp)`);

    const result = await verifySolanaSettlement(
      {
        txHash: claim.tx_hash,
        network: claim.network,
        expectedPayTo: claim.pay_to,
        expectedPayer: claim.payer,
        expectedAmountUnits: claim.amount_units,
      },
      { rpc },
    );

    // 根拠を印字する——「OK」だけでは、何を読んで OK と言ったのか誰も確かめられない。
    const status = await rpc.getSignatureStatus(claim.tx_hash);
    const tx = await rpc.getTransaction(claim.tx_hash, { maxSupportedTransactionVersion: 0 });
    const pre = tx?.meta?.preTokenBalances ?? [];
    const post = tx?.meta?.postTokenBalances ?? [];
    const payee = usdcOwnerDelta(pre, post, claim.pay_to, SOLANA_USDC_MINT);
    const payerDelta = usdcOwnerDelta(pre, post, claim.payer, SOLANA_USDC_MINT);
    console.log(
      `evidence   confirmationStatus=${status.value?.confirmationStatus ?? "-"} err=${JSON.stringify(status.value?.err ?? null)} slot=${tx?.slot ?? "-"}`,
    );
    console.log(
      `evidence   USDC delta payTo=${payee.delta} payer=${payerDelta.delta} (mint ${SOLANA_USDC_MINT})`,
    );
    console.log(
      `evidence   blockTime=${typeof tx?.blockTime === "number" ? new Date(tx.blockTime * 1000).toISOString() : "-"}`,
    );

    if (result.ok) {
      console.log(
        `VERDICT    settled (slotDistance=${result.confirmations} slot=${result.blockNumber} blockTime=${result.blockTimestamp?.toISOString() ?? "-"})`,
      );
    } else {
      console.log(`VERDICT    NOT settled — ${result.reason}${result.detail ? `: ${result.detail}` : ""}`);
      failures++;
    }
    console.log("(no database write was performed)");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

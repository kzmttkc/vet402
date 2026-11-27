// ============================================================
// Hedera の公開面（chains.ts の公開名・HashScan のリンク・l1-facilitator の blocky402）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { explorerTxUrl, publicChainLabel, chainIdentity, chainLabel, toCaip2 } from "@/lib/observatory/chains";
import { l1FacilitatorIdSql } from "@/lib/observatory/l1-facilitator";

const TXID = "0.0.10571514@1795739901.710706809";

test("公開名・リンク・facilitator: Hedera は Stellar と同じく id の完全一致", () => {
  assert.equal(publicChainLabel("hedera:mainnet"), "Hedera");
  assert.deepEqual(chainIdentity(chainLabel(toCaip2("hedera:mainnet"))), { chain: "hedera:mainnet", label: "Hedera", network: "hedera:mainnet" });
  assert.equal(explorerTxUrl("hedera:mainnet", TXID), "https://hashscan.io/mainnet/transaction/0.0.10571514-1795739901-710706809");
  assert.equal(explorerTxUrl("hedera:testnet", TXID), null);
  assert.equal(explorerTxUrl("hedera:mainnet", "ab".repeat(32)), null);
  assert.match(l1FacilitatorIdSql("pu"), /hedera:mainnet', 'hedera:testnet'\) THEN 'blocky402'/);
});

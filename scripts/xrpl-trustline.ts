/**
 * XRPL の購入元アカウントに RLUSD の trust line を張る（オーナーがローカルで 1 回打つ道具）。
 *
 * なぜ要るか: XRPL で IOU（RLUSD）を受け取るには、発行者への trust line が先に要る。
 * L1 の XRPL レーン（src/lib/observatory/xrpl402-payer.ts）は RLUSD しか払わないので、
 * これが無いと残高が 0 のまま署名に至らない（payer_unfunded）。
 *
 * 何をするか:
 *   1. OBSERVATORY_XRPL_SEED から鍵を読み、アドレスと XRP 残高・OwnerCount を印字する
 *   2. すでに RLUSD の trust line があれば、その限度額と残高を印字して終わる
 *   3. なければ TrustSet（LimitAmount = 100 RLUSD・NoRipple）に署名して submit し、hash と engine_result を印字する
 *   4. validated になるまで最大 30 秒 `tx` で待つ
 *
 * 必要な資金: 基本準備金 1 XRP + trust line の追加準備金 0.2 XRP + 手数料（12 drops）。
 * 秘密は印字しない。DB には触らない。
 *
 * Usage:
 *   OBSERVATORY_XRPL_SEED=s... [XRPL_RPC_URL=https://s1.ripple.com:51234/] [TRUST_LIMIT=100] \
 *   npx tsx scripts/xrpl-trustline.ts [--dry-run]
 */
import { Wallet } from "xrpl";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_ISSUER,
  XRPL_FEE_DROPS,
  XRPL_RESERVE_BASE_DROPS,
  XRPL_RESERVE_INC_DROPS,
  createXrplJsonRpc,
  getAccountSequence,
  getValidatedLedgerIndex,
  xrplRpcUrl,
} from "../src/lib/observatory/xrpl402-payer";

/** TrustSet の tfSetNoRipple（発行者を経由した rippling を止める、一般的な設定）。 */
const TF_SET_NO_RIPPLE = 0x00020000;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const seed = process.env.OBSERVATORY_XRPL_SEED?.trim();
  if (!seed) throw new Error("OBSERVATORY_XRPL_SEED is not set");
  const limit = process.env.TRUST_LIMIT?.trim() || "100";
  if (!/^\d+(\.\d+)?$/.test(limit)) throw new Error(`TRUST_LIMIT is not a decimal: ${limit}`);
  const wallet = Wallet.fromSeed(seed);
  const rpc = createXrplJsonRpc({ url: xrplRpcUrl(), timeoutMs: 15_000 });
  console.log(JSON.stringify({ address: wallet.classicAddress, rpc: xrplRpcUrl(), issuer: RLUSD_ISSUER, limit }));

  const info = await rpc("account_info", { account: wallet.classicAddress, ledger_index: "validated" });
  const data = info.account_data as { Balance: string; OwnerCount: number; Sequence: number };
  const reserve = XRPL_RESERVE_BASE_DROPS + XRPL_RESERVE_INC_DROPS * BigInt(data.OwnerCount ?? 0);
  console.log(JSON.stringify({ balanceDrops: data.Balance, ownerCount: data.OwnerCount, reserveDrops: String(reserve), spendableDrops: String(BigInt(data.Balance) - reserve) }));

  const lines = await rpc("account_lines", { account: wallet.classicAddress, peer: RLUSD_ISSUER, ledger_index: "validated" });
  const existing = (Array.isArray(lines.lines) ? (lines.lines as { currency: string; limit: string; balance: string }[]) : []).find(
    (l) => l.currency.toUpperCase() === RLUSD_CURRENCY_HEX || l.currency === "RLUSD",
  );
  if (existing) {
    console.log(JSON.stringify({ trustLine: "exists", limit: existing.limit, balance: existing.balance }));
    return;
  }
  if (BigInt(data.Balance) - reserve < XRPL_RESERVE_INC_DROPS + BigInt(XRPL_FEE_DROPS)) {
    throw new Error(`insufficient XRP: need ${XRPL_RESERVE_INC_DROPS + BigInt(XRPL_FEE_DROPS)} drops above the current reserve for a new trust line`);
  }

  const [sequence, validated] = await Promise.all([getAccountSequence(wallet.classicAddress, rpc), getValidatedLedgerIndex(rpc)]);
  const tx = {
    TransactionType: "TrustSet" as const,
    Account: wallet.classicAddress,
    LimitAmount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: limit },
    Fee: XRPL_FEE_DROPS,
    Sequence: sequence,
    LastLedgerSequence: validated + 20,
    Flags: TF_SET_NO_RIPPLE,
  };
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, tx }));
    return;
  }
  const signed = wallet.sign(tx);
  const submitted = await rpc("submit", { tx_blob: signed.tx_blob });
  console.log(JSON.stringify({ submitted: true, hash: signed.hash, engineResult: submitted.engine_result, engineResultMessage: submitted.engine_result_message }));

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const t = await rpc("tx", { transaction: signed.hash, binary: false });
      if (t.validated === true) {
        const meta = t.meta as { TransactionResult?: string } | undefined;
        console.log(JSON.stringify({ validated: true, hash: signed.hash, result: meta?.TransactionResult, explorer: `https://livenet.xrpl.org/transactions/${signed.hash}` }));
        return;
      }
    } catch {
      /* not yet */
    }
  }
  console.log(JSON.stringify({ validated: false, hash: signed.hash, note: "not validated within 30s; check the explorer before retrying" }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e).slice(0, 500) }));
  process.exit(1);
});

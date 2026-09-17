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
 *   5. `--swap-xrp <XRP額>` があれば、台帳上で XRP を RLUSD に替える（2026-09-17・購入元には XRP だけを入れる運用）。
 *      自分宛ての cross-currency Payment（Amount = RLUSD・SendMax = XRP・tfPartialPayment + DeliverMin で滑り 2% まで）。
 *      `book_offers` で見積もりを取り「XRP x → RLUSD 約 y（レート）」を印字し、`--yes` が無ければそこで止まる。
 *      事前検査: 残高 − 準備金(1 + 0.2×OwnerCount) − 手数料 ≥ 交換額。結果は tx hash と meta.delivered_amount。
 *
 * 必要な資金: 基本準備金 1 XRP + trust line の追加準備金 0.2 XRP + 手数料（12 drops）+ 交換する XRP。
 * 秘密は印字しない。DB には触らない。`--dry-run` は何にも署名しない。
 *
 * Usage:
 *   OBSERVATORY_XRPL_SEED=s... [XRPL_RPC_URL=https://s1.ripple.com:51234/] [TRUST_LIMIT=100] \
 *   npx tsx scripts/xrpl-trustline.ts [--dry-run] [--swap-xrp 8 [--yes]]
 */
import { Wallet } from "xrpl";
import { buildXrpToRlusdSwap, dropsToXrp, quoteXrpToRlusd, swapPreflight, xrpToDrops, type XrplBookOffer } from "../src/lib/observatory/xrpl-swap";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_ISSUER,
  XRPL_FEE_DROPS,
  XRPL_RESERVE_BASE_DROPS,
  XRPL_RESERVE_INC_DROPS,
  createXrplJsonRpc,
  getAccountSequence,
  getValidatedLedgerIndex,
  XRPL_RPC_URL_DEFAULT,
  unitsToRlusdValue,
  type XrplRpc,
} from "../src/lib/observatory/xrpl402-payer";

/** この script だけが公開ノードへ倒れてよい（署名器・照合器・索引は XRPL_RPC_URL 必須）。 */
const RPC_URL = process.env.XRPL_RPC_URL?.trim() || XRPL_RPC_URL_DEFAULT;

/** TrustSet の tfSetNoRipple（発行者を経由した rippling を止める、一般的な設定）。 */
const TF_SET_NO_RIPPLE = 0x00020000;

/** `--flag value`。flag があるのに値が無い／別の flag が続くときは黙って null にせず止める（2026-09-17 レビュー #7b）。 */
function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value (e.g. ${flag} 8)`);
  return v;
}

/** submit 済みの tx が validated になるまで最大 30 秒待ち、meta を返す。 */
async function waitValidated(rpc: XrplRpc, hash: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const t = await rpc("tx", { transaction: hash, binary: false });
      if (t.validated === true) return (t.meta as Record<string, unknown>) ?? {};
    } catch {
      /* not yet */
    }
  }
  return null;
}

async function swapXrp(rpc: XrplRpc, wallet: Wallet, xrp: string, opts: { dryRun: boolean; yes: boolean; pendingTrustLines?: number }): Promise<void> {
  const swapDrops = xrpToDrops(xrp);
  if (swapDrops === null) throw new Error(`--swap-xrp is not a positive XRP amount (6 decimals): ${xrp}`);

  // 事前検査は trust line を張った **後** の OwnerCount で。dry-run で TrustSet を送っていないときは
  // その分（pendingTrustLines）を足して見る（2026-09-17 レビュー #7a）。
  const info = await rpc("account_info", { account: wallet.classicAddress, ledger_index: "validated" });
  const data = info.account_data as { Balance: string; OwnerCount: number };
  const ownerCount = (data.OwnerCount ?? 0) + (opts.pendingTrustLines ?? 0);
  const pre = swapPreflight({ balanceDrops: BigInt(data.Balance), ownerCount, swapDrops });
  console.log(JSON.stringify({ swap: "preflight", balanceXrp: dropsToXrp(BigInt(data.Balance)), reserveXrp: dropsToXrp(pre.reserveDrops), spendableXrp: dropsToXrp(pre.spendableDrops), swapXrp: xrp, ok: pre.ok }));
  if (!pre.ok) throw new Error(`insufficient XRP: spendable ${dropsToXrp(pre.spendableDrops)} < swap ${xrp}`);

  const book = await rpc("book_offers", {
    taker_gets: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER },
    taker_pays: { currency: "XRP" },
    ledger_index: "validated",
    limit: 50,
  });
  const quote = quoteXrpToRlusd(Array.isArray(book.offers) ? (book.offers as XrplBookOffer[]) : [], swapDrops);
  console.log(
    JSON.stringify({
      swap: "quote",
      message: `XRP ${xrp} → RLUSD 約 ${unitsToRlusdValue(quote.deliveredUnits)}（レート ${quote.ratePerXrp === null ? "n/a" : quote.ratePerXrp.toFixed(4)} RLUSD/XRP・滑り上限 2%）`,
      filled: quote.filled,
      offersRead: Array.isArray(book.offers) ? book.offers.length : 0,
    }),
  );
  if (!quote.filled) throw new Error(`order book too thin for ${xrp} XRP (only ${dropsToXrp(quote.spentDrops)} XRP fillable in the top 50 offers)`);

  const [sequence, validated] = await Promise.all([getAccountSequence(wallet.classicAddress, rpc), getValidatedLedgerIndex(rpc)]);
  const tx = buildXrpToRlusdSwap({ account: wallet.classicAddress, sequence, validatedLedgerIndex: validated, swapDrops, quotedUnits: quote.deliveredUnits });
  if (opts.dryRun) {
    console.log(JSON.stringify({ swap: "dry-run", tx }));
    return;
  }
  if (!opts.yes) {
    console.log(JSON.stringify({ swap: "stopped", note: "add --yes to sign and submit the swap above" }));
    return;
  }
  const signed = wallet.sign(tx);
  const submitted = await rpc("submit", { tx_blob: signed.tx_blob });
  console.log(JSON.stringify({ swap: "submitted", hash: signed.hash, engineResult: submitted.engine_result, engineResultMessage: submitted.engine_result_message }));
  const meta = await waitValidated(rpc, signed.hash);
  if (!meta) {
    console.log(JSON.stringify({ swap: "unknown", hash: signed.hash, note: "not validated within 30s; check the explorer before retrying" }));
    return;
  }
  console.log(
    JSON.stringify({
      swap: "validated",
      hash: signed.hash,
      result: meta.TransactionResult,
      deliveredAmount: meta.delivered_amount ?? meta.DeliveredAmount ?? null,
      explorer: `https://livenet.xrpl.org/transactions/${signed.hash}`,
    }),
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const yes = process.argv.includes("--yes");
  const swapXrpAmount = argValue("--swap-xrp");
  const seed = process.env.OBSERVATORY_XRPL_SEED?.trim();
  if (!seed) throw new Error("OBSERVATORY_XRPL_SEED is not set");
  const limit = process.env.TRUST_LIMIT?.trim() || "100";
  if (!/^\d+(\.\d+)?$/.test(limit)) throw new Error(`TRUST_LIMIT is not a decimal: ${limit}`);
  const wallet = Wallet.fromSeed(seed);
  const rpc = createXrplJsonRpc({ url: RPC_URL, timeoutMs: 15_000 });
  console.log(JSON.stringify({ address: wallet.classicAddress, rpc: RPC_URL, issuer: RLUSD_ISSUER, limit }));

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
    if (swapXrpAmount !== null) await swapXrp(rpc, wallet, swapXrpAmount, { dryRun, yes });
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
    // TrustSet はまだ送っていないので、交換の事前検査は「trust line 1 本ぶんの準備金が増えた後」で見る。
    if (swapXrpAmount !== null) await swapXrp(rpc, wallet, swapXrpAmount, { dryRun, yes, pendingTrustLines: 1 });
    return;
  }
  const signed = wallet.sign(tx);
  const submitted = await rpc("submit", { tx_blob: signed.tx_blob });
  console.log(JSON.stringify({ submitted: true, hash: signed.hash, engineResult: submitted.engine_result, engineResultMessage: submitted.engine_result_message }));

  const meta = await waitValidated(rpc, signed.hash);
  if (!meta) {
    console.log(JSON.stringify({ validated: false, hash: signed.hash, note: "not validated within 30s; check the explorer before retrying" }));
    return;
  }
  console.log(JSON.stringify({ validated: true, hash: signed.hash, result: meta.TransactionResult, explorer: `https://livenet.xrpl.org/transactions/${signed.hash}` }));
  if (meta.TransactionResult !== "tesSUCCESS") return;
  if (swapXrpAmount !== null) await swapXrp(rpc, wallet, swapXrpAmount, { dryRun, yes });
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e).slice(0, 500) }));
  process.exit(1);
});

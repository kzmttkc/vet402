// ============================================================
// XRPL の L1 決済照合（2026-09-17）。settlement-verify.ts の xrpl 経路。
//
// EVM（EIP-3009 nonce）・Solana（我々の memo）と同じ厳しさを XRPL の形で要求する:
//   - tx は `validated: true` かつ `meta.TransactionResult === "tesSUCCESS"`（XRPL の確定は
//     validated の有無で決まる。未 validated は not_final で未確認のまま置く）。
//   - Payment の Destination が期待した payTo、Account が我々の payer。
//   - `meta.delivered_amount` が RLUSD（固定の通貨コード + 発行者）で期待額以上。
//     XRP（drops の文字列）で届いていたら amount_mismatch——v1 は RLUSD しか払っていない。
//   - **その tx は我々が署名したものか**: 署名済み blob の hash（x402_l1_purchases.auth_nonce）と
//     claimed tx の hash が一致すること。我々は提出前に hash を知っているので、売り手が別の
//     tx（過去の受取・他人の支払い）を返しても結びつかない（nonce_not_used）。
//   - RPC が答えない・形が読めないものは一時的な理由で返し、台帳の status を倒さない。
//   - network が xrpl:0 でなければ wrong_chain（計器の故障として鳴る）。server_info の
//     network_id が 0 以外なら同じく wrong_chain（別ネットワークの同名 tx を読まない）。
// ============================================================
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import type { SettlementVerifyResult } from "./settlement-verify";
import { RLUSD_ISSUER, XRPL_MAINNET_CAIP2, createXrplJsonRpc, isRlusdAsset, rlusdToUnitsFloor, type XrplRpc } from "./xrpl402-payer";

/** XRPL の epoch（2000-01-01T00:00:00Z）と Unix epoch の差（秒）。 */
export const RIPPLE_EPOCH_OFFSET_SECONDS = 946_684_800;

export function rippleTimeToDate(rippleSeconds: unknown): Date | null {
  if (typeof rippleSeconds !== "number" || !Number.isFinite(rippleSeconds)) return null;
  return new Date((rippleSeconds + RIPPLE_EPOCH_OFFSET_SECONDS) * 1000);
}

const unavailable = (detail: string): SettlementVerifyResult => ({ ok: false, reason: "rpc_unavailable", detail: detail.slice(0, 200) });

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null => (typeof v === "object" && v !== null ? (v as Rec) : null);

/**
 * `tx` の応答は API v1（tx のフィールドが最上位）と v2（`tx_json` の下）で形が違う。両方読む。
 */
export function readXrplTxResponse(r: Rec): {
  tx: Rec;
  meta: Rec | null;
  validated: boolean;
  ledgerIndex: number | null;
  hash: string | null;
  closeTime: Date | null;
} {
  const tx = asRec(r.tx_json) ?? r;
  const meta = asRec(r.meta) ?? asRec(r.meta_data);
  const ledgerIndex = typeof r.ledger_index === "number" ? r.ledger_index : typeof tx.ledger_index === "number" ? tx.ledger_index : null;
  const hash = typeof r.hash === "string" ? r.hash : typeof tx.hash === "string" ? tx.hash : null;
  const closeTime =
    typeof r.close_time_iso === "string" ? new Date(r.close_time_iso) : rippleTimeToDate(typeof tx.date === "number" ? tx.date : r.date);
  return { tx, meta, validated: r.validated === true, ledgerIndex, hash, closeTime };
}

/**
 * 1 件の XRPL 決済主張をチェーンで確かめる。期待値は **我々が署名したときの値**を渡すこと。
 */
export async function verifyXrplSettlement(
  input: {
    txHash: string;
    network: string;
    expectedPayTo: string;
    expectedPayer: string;
    expectedAmountUnits: string;
    /** 我々が署名した blob の hash（x402_l1_purchases.auth_nonce）。旧行は null。 */
    expectedAuthNonce?: string | null;
  },
  deps?: { rpc?: XrplRpc },
): Promise<SettlementVerifyResult> {
  const { txHash, network, expectedPayTo, expectedPayer, expectedAmountUnits } = input;

  if (!isWellFormedSettlementTx(txHash, "xrpl")) return { ok: false, reason: "malformed_tx" };
  const hash = txHash.trim().toUpperCase();
  if (network !== XRPL_MAINNET_CAIP2) {
    return { ok: false, reason: "wrong_chain", detail: `unusable network id: ${network}`.slice(0, 200) };
  }
  let expectedUnits: bigint;
  try {
    expectedUnits = BigInt(expectedAmountUnits);
  } catch {
    return { ok: false, reason: "amount_mismatch", detail: "unparseable expected amount" };
  }
  if (expectedUnits <= 0n) return { ok: false, reason: "amount_mismatch", detail: "non-positive expected amount" };

  // 署名した blob の hash と一致しない claimed tx は、読む前に「我々のものではない」。
  const expectedHash = input.expectedAuthNonce?.trim().toUpperCase();
  if (expectedHash && expectedHash !== hash) {
    return { ok: false, reason: "nonce_not_used", detail: `claimed ${hash} is not the blob we signed (${expectedHash})`.slice(0, 200) };
  }

  let rpc: XrplRpc;
  try {
    rpc = deps?.rpc ?? createXrplJsonRpc();
  } catch (error) {
    // XRPL_RPC_URL 未設定。公開 RPC へ黙って倒れない（Solana と同じ・TRANSIENT）。
    return unavailable(String(error));
  }

  // いま読んでいるのは本当に mainnet か（network_id 無し = 0 = mainnet）。
  try {
    const info = asRec((await rpc("server_info", {})).info);
    const networkId = info?.network_id;
    if (typeof networkId === "number" && networkId !== 0) {
      return { ok: false, reason: "wrong_chain", detail: `rpc network_id ${networkId} is not mainnet (0)` };
    }
  } catch (error) {
    return unavailable(String(error));
  }

  let raw: Rec;
  try {
    raw = await rpc("tx", { transaction: hash, binary: false });
  } catch (error) {
    const text = String(error);
    if (/txnNotFound/.test(text)) return { ok: false, reason: "tx_not_found" };
    return unavailable(text);
  }
  const r = readXrplTxResponse(raw);
  if (!r.validated) return { ok: false, reason: "not_final", detail: "tx is not in a validated ledger yet" };
  if (!r.meta) return unavailable("tx returned without meta");
  const result = r.meta.TransactionResult;
  if (result !== "tesSUCCESS") {
    return { ok: false, reason: "tx_reverted", detail: `TransactionResult ${String(result)}`.slice(0, 200) };
  }
  if (r.tx.TransactionType !== "Payment") {
    return { ok: false, reason: "no_matching_transfer", detail: `TransactionType ${String(r.tx.TransactionType)}`.slice(0, 200) };
  }
  if (r.tx.Destination !== expectedPayTo) {
    return { ok: false, reason: "payee_mismatch", detail: `Destination ${String(r.tx.Destination)} != ${expectedPayTo}`.slice(0, 200) };
  }
  if (r.tx.Account !== expectedPayer) {
    return { ok: false, reason: "payer_mismatch", detail: `Account ${String(r.tx.Account)} != ${expectedPayer}`.slice(0, 200) };
  }

  // 届いた額は meta.delivered_amount（部分払い・経路をまたぐ支払いでも「実際に届いた」側）。
  const delivered = r.meta.delivered_amount ?? r.meta.DeliveredAmount;
  const iou = asRec(delivered);
  if (!iou) {
    return {
      ok: false,
      reason: "amount_mismatch",
      detail: typeof delivered === "string" ? `delivered in XRP (${delivered} drops), expected RLUSD` : "delivered_amount unreadable",
    };
  }
  if (typeof iou.currency !== "string" || !isRlusdAsset(iou.currency) || iou.issuer !== RLUSD_ISSUER) {
    return { ok: false, reason: "amount_mismatch", detail: `delivered ${String(iou.currency)}/${String(iou.issuer)} is not RLUSD`.slice(0, 200) };
  }
  const deliveredUnits = typeof iou.value === "string" ? rlusdToUnitsFloor(iou.value) : null;
  if (deliveredUnits === null) return unavailable(`delivered_amount.value unreadable: ${String(iou.value)}`);
  if (deliveredUnits < expectedUnits) {
    return { ok: false, reason: "amount_mismatch", detail: `${expectedPayTo} received ${deliveredUnits} < expected ${expectedUnits}`.slice(0, 200) };
  }

  return {
    ok: true,
    blockTimestamp: r.closeTime,
    // validated は確定そのもの（Solana の finalized と同じ意味）。0 を返すと未確定に見えるので 1。
    confirmations: 1n,
    blockNumber: BigInt(r.ledgerIndex ?? 0),
  };
}

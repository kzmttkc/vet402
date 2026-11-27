// ============================================================
// Hedera の L1 決済照合（2026-11-27）。settlement-verify.ts の hedera 経路。
//
// 読むのは公開の mirror node（/api/v1/transactions/<id>）。期待値は我々が署名したときの値:
//   - 取引 ID は署名の時点で決まる（facilitator の fee payer の口座 + 我々の valid start）。台帳の auth_nonce に
//     残した ID と、売り手が返した ID が一致しなければ、読む前に「我々の取引ではない」（nonce_not_used）。
//   - mirror node の親の記録（nonce 0・scheduled false）が CRYPTOTRANSFER で result が SUCCESS。
//   - HBAR の送金で、払い手が −期待額・受取先が +期待額（tinybar で完全一致）。tinybar は台帳の
//     raw_response_meta.hedera.nativeAmount（USD 6 桁の amount_units ではない）。
//   - mirror node が答えない・形が読めないものは一時的な理由で返し、台帳の status を倒さない。
//   - 404 は tx_not_found（照合器の規則どおり、期限の日数までは一時的に扱われる）。
// ============================================================
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { redactUrls } from "./redact";
import type { SettlementVerifyResult } from "./settlement-verify";
import { HBAR_ASSET, HEDERA_MIRROR_NODE_URLS, isHederaNetwork, mirrorHederaTxId, normalizeHederaTxId } from "./hedera402-payer";

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);

const unavailable = (detail: string): SettlementVerifyResult => ({
  ok: false,
  reason: "rpc_unavailable",
  detail: redactUrls(detail).slice(0, 200),
});

export type HederaMirrorFetch = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;

const defaultFetch: HederaMirrorFetch = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    const body = res.status === 200 ? await res.json() : null;
    return { status: res.status, json: async () => body };
  } finally {
    clearTimeout(timer);
  }
};

/** mirror node の consensus_timestamp（`秒.ナノ秒`）→ Date（ミリ秒まで）。 */
export function hederaConsensusToDate(ts: unknown): Date | null {
  if (typeof ts !== "string" || !/^[0-9]{1,12}\.[0-9]{1,9}$/.test(ts)) return null;
  const [sec, nanos] = ts.split(".");
  return new Date(Number(sec) * 1000 + Math.floor(Number(nanos.padEnd(9, "0")) / 1_000_000));
}

function sumFor(transfers: unknown, account: string): bigint | null {
  if (!Array.isArray(transfers)) return null;
  let total = 0n;
  for (const t of transfers) {
    const r = asRec(t);
    if (!r) return null;
    if (r.account !== account) continue;
    if (typeof r.amount !== "number" || !Number.isSafeInteger(r.amount)) return null;
    total += BigInt(r.amount);
  }
  return total;
}

/**
 * 1 件の Hedera 決済主張を mirror node で確かめる。期待値は **我々が署名したときの値**を渡すこと。
 */
export async function verifyHederaSettlement(
  input: {
    txHash: string;
    network: string;
    expectedPayTo: string;
    expectedPayer: string;
    expectedAmountUnits: string;
    /** 我々が署名した取引の ID（x402_l1_purchases.auth_nonce）。 */
    expectedAuthNonce?: string | null;
    /** 払った額（tinybar）と資産（raw_response_meta.hedera）。 */
    expectedNativeAmount?: string | null;
    expectedNativeAsset?: string | null;
  },
  deps?: { fetchImpl?: HederaMirrorFetch },
): Promise<SettlementVerifyResult> {
  const { txHash, network, expectedPayTo, expectedPayer } = input;
  if (!isWellFormedSettlementTx(txHash, "hedera")) return { ok: false, reason: "malformed_tx" };
  if (!isHederaNetwork(network)) {
    return { ok: false, reason: "wrong_chain", detail: `unusable network id: ${network}`.slice(0, 200) };
  }
  const claimed = normalizeHederaTxId(txHash)!;
  const expectedId = normalizeHederaTxId(input.expectedAuthNonce ?? null);
  if (!expectedId) {
    // 取引 ID を持たない行は、その取引が我々のものだと言えない。推測で期待値を作らない。
    return { ok: false, reason: "nonce_not_used", detail: "no signed transaction id on the purchase row" };
  }
  if (expectedId !== claimed) {
    return { ok: false, reason: "nonce_not_used", detail: `claimed ${claimed} is not the transaction we signed (${expectedId})`.slice(0, 200) };
  }
  if ((input.expectedNativeAsset ?? HBAR_ASSET) !== HBAR_ASSET) {
    return { ok: false, reason: "amount_mismatch", detail: `unsupported asset ${String(input.expectedNativeAsset)}`.slice(0, 200) };
  }
  const nativeText = input.expectedNativeAmount ?? null;
  if (nativeText === null || !/^[0-9]{1,19}$/.test(nativeText) || BigInt(nativeText) <= 0n) {
    return { ok: false, reason: "amount_mismatch", detail: "expected tinybar amount missing on the purchase row" };
  }
  const expectedTinybars = BigInt(nativeText);

  const fetchImpl = deps?.fetchImpl ?? defaultFetch;
  const base = HEDERA_MIRROR_NODE_URLS[network];
  let body: unknown;
  try {
    const res = await fetchImpl(`${base}/api/v1/transactions/${mirrorHederaTxId(claimed)}`);
    if (res.status === 404) return { ok: false, reason: "tx_not_found" };
    if (res.status !== 200) return unavailable(`mirror node http ${res.status}`);
    body = await res.json();
  } catch (error) {
    return unavailable(String(error));
  }
  const list = asRec(body)?.transactions;
  if (!Array.isArray(list)) return unavailable("mirror node returned no transactions list");
  if (list.length === 0) return { ok: false, reason: "tx_not_found" };
  const parent = list.map(asRec).find((t) => t !== null && t.nonce === 0 && t.scheduled === false) ?? null;
  if (!parent) return unavailable("mirror node returned no parent transaction record");
  if (normalizeHederaTxId(parent.transaction_id) !== claimed) {
    return unavailable(`mirror node returned ${String(parent.transaction_id)} for ${claimed}`);
  }
  if (parent.result !== "SUCCESS") {
    return { ok: false, reason: "tx_reverted", detail: `result ${String(parent.result)}`.slice(0, 200) };
  }
  if (parent.name !== "CRYPTOTRANSFER") {
    return { ok: false, reason: "no_matching_transfer", detail: `transaction type ${String(parent.name)}`.slice(0, 200) };
  }
  const credited = sumFor(parent.transfers, expectedPayTo);
  const debited = sumFor(parent.transfers, expectedPayer);
  if (credited === null || debited === null) return unavailable("transfers unreadable");
  if (credited !== expectedTinybars) {
    return {
      ok: false,
      reason: credited === 0n ? "payee_mismatch" : "amount_mismatch",
      detail: `${expectedPayTo} received ${credited} tinybar, expected ${expectedTinybars}`.slice(0, 200),
    };
  }
  // 手数料は fee payer（facilitator）が払う。払い手の減りはちょうど額。
  if (debited !== -expectedTinybars) {
    return {
      ok: false,
      reason: debited === 0n ? "payer_mismatch" : "amount_mismatch",
      detail: `${expectedPayer} moved ${debited} tinybar, expected -${expectedTinybars}`.slice(0, 200),
    };
  }
  const consensus = typeof parent.consensus_timestamp === "string" ? parent.consensus_timestamp : null;
  const blockTimestamp = hederaConsensusToDate(consensus);
  if (!consensus || !blockTimestamp) return unavailable("consensus_timestamp unreadable");

  // その取引を含む record file（mirror node の block）。timestamp の絞りは block の終わりの時刻に掛かる
  // （2026-11-27 実測）ので、終わりが取引以後の最初の block を取り、始まりが取引以前であることを確かめる。
  let blockNumber: bigint;
  try {
    const res = await fetchImpl(`${base}/api/v1/blocks?timestamp=gte:${consensus}&order=asc&limit=1`);
    if (res.status !== 200) return unavailable(`mirror node blocks http ${res.status}`);
    const blocksBody = asRec(await res.json());
    const first = Array.isArray(blocksBody?.blocks) ? asRec(blocksBody!.blocks[0]) : null;
    const range = asRec(first?.timestamp);
    const from = typeof range?.from === "string" ? range.from : null;
    const to = typeof range?.to === "string" ? range.to : null;
    if (!first || typeof first.number !== "number" || !from || !to) return unavailable("block for the transaction not readable yet");
    const ns = (t: string) => BigInt(t.split(".")[0]) * 1_000_000_000n + BigInt((t.split(".")[1] ?? "0").padEnd(9, "0"));
    if (!(ns(from) <= ns(consensus) && ns(consensus) <= ns(to))) return unavailable("block range does not contain the transaction");
    blockNumber = BigInt(first.number);
  } catch (error) {
    return unavailable(String(error));
  }

  // mirror node に載った記録は consensus に達している（Hedera に reorg は無い）。0 は未確定に見えるので 1。
  return { ok: true, blockTimestamp, confirmations: 1n, blockNumber };
}

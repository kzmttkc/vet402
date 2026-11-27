// ============================================================
// KPI 着金集計で「自社起点の入金」として除外する払い手（Base EVM）。
// 本番 DB の x402_l1_purchases.payer 全集はここには載せない（C3）。
// 買い手向け再計算で DB が使えるときは settlements/own-wallets と突き合わせる。
// ============================================================
import { parsePartyId } from "@/lib/ids/canonical";
import { operatorPayToDenylist } from "@/lib/observatory/operator";
import { BASE_CHAIN_ID } from "@/lib/x402/base-usdc";
import { VET402_BASE_USDC_PAY_TO } from "@/lib/kpi/payto";

const BASE_CAIP = `eip155:${BASE_CHAIN_ID}`;

/**
 * コード上固定の自社ウォレット（錨定・RwaAnchor デプロイ者）。
 * fixtures/rwa/anchor.json `anchored_by`、packages/rwa/onchain.json `deployer` と同じ。
 */
export const VET402_ANCHOR_OPERATOR_WALLET = VET402_BASE_USDC_PAY_TO;

/**
 * vet402 自身の Robinhood 向け L1 払い手（Base でも同じ EVM アドレス）。
 * tests/fixtures/evm-lane/robinhood-roots.json の payer と同じ。2026-11 に payTo へ 0.01 USDC を送っている
 * （2026-11-27 に Base 公開 RPC で確認）。自社起点なので売上から除外する（C6）。
 */
export const VET402_ROBINHOOD_L1_PAYER = "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51";

/** 自社の払い手・錨定財布としてコードに固定されている Base アドレス。 */
export const VET402_STATIC_OWN_PAYER_ADDRESSES_BASE: readonly string[] = [
  VET402_ANCHOR_OPERATOR_WALLET,
  VET402_ROBINHOOD_L1_PAYER,
];

function normalizeEvm(addr: string): string {
  return addr.trim().toLowerCase();
}

/**
 * 期間内の着金集計から除外する `from` アドレス集合（小文字）。
 * - 静的リスト（上記）
 * - VET402_OPERATOR_PAYTO（operator.ts）
 * - OBSERVATORY_TEST_WALLETS の eip155:8453 行
 * - VET402_KPI_EXTRA_OWN_PAYERS（カンマ区切りの 0x アドレス、テスト・買い手用の明示追加）
 */
export function vet402OwnPayerAddressesBase(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const out = new Set<string>();
  for (const a of VET402_STATIC_OWN_PAYER_ADDRESSES_BASE) out.add(normalizeEvm(a));
  for (const a of operatorPayToDenylist()) out.add(normalizeEvm(a));
  for (const raw of (env.OBSERVATORY_TEST_WALLETS ?? "").split(",")) {
    const v = raw.trim();
    const parsed = v ? parsePartyId(v) : null;
    if (parsed && (parsed.chain === BASE_CAIP || parsed.chain === "base")) {
      out.add(normalizeEvm(parsed.address));
    }
  }
  for (const raw of (env.VET402_KPI_EXTRA_OWN_PAYERS ?? "").split(",")) {
    const v = raw.trim();
    if (v.startsWith("0x") && v.length === 42) out.add(normalizeEvm(v));
  }
  return out;
}

export type OwnPayerExclusion = { excluded: true; reason: string } | { excluded: false };

export function exclusionForInboundTransfer(
  from: string,
  to: string,
  ownPayers: ReadonlySet<string>,
): OwnPayerExclusion {
  const fromL = normalizeEvm(from);
  const toL = normalizeEvm(to);
  if (fromL === toL) return { excluded: true, reason: "self_transfer" };
  if (ownPayers.has(fromL)) return { excluded: true, reason: "own_payer" };
  return { excluded: false };
}
export const X402_REVENUE_V = 1 as const;

export type X402RevenueReadStatus = "ok" | "unreadable";

export type X402InboundTransfer = {
  txHash: string;
  blockNumber: string;
  /** ISO-8601 UTC、秒精度 */
  blockTimeUtc: string;
  from: string;
  to: string;
  /** USDC 6 桁の atomic 単位（文字列整数） */
  amountUnits: string;
  excluded: boolean;
  exclusionReason: string | null;
};

export type X402RevenueDailyRow = {
  day: string;
  transferCount: number;
  amountUnits: string;
  excludedTransferCount: number;
  excludedAmountUnits: string;
};

export type X402RevenueTotals = {
  transferCount: number | null;
  amountUnits: string | null;
  excludedTransferCount: number | null;
  excludedAmountUnits: string | null;
  includedTransferCount: number | null;
  includedAmountUnits: string | null;
};

export type X402RevenueAggregate = {
  v: typeof X402_REVENUE_V;
  readStatus: X402RevenueReadStatus;
  /** unreadable のとき必須。ok のときは省略可。 */
  readDetail?: string;
  periodStart: string;
  periodEndExclusive: string;
  chainId: number;
  asset: string;
  payToAddresses: string[];
  source: "alchemy" | "public_rpc" | null;
  /** 読み手が見た最新の時刻（ISO-8601 UTC）。読めなかったときは null */
  readThroughUtc: string | null;
  /** readThroughUtc が期間の終わり以降なら true。進行中の月は false（凍結に使わない） */
  periodComplete: boolean;
  daily: X402RevenueDailyRow[];
  totals: X402RevenueTotals;
  /** 決定的順: blockTimeUtc ↑, blockNumber ↑, txHash ↑, from ↑, amountUnits ↑ */
  transfers: X402InboundTransfer[];
};
// ============================================================
// x402 Base USDC 着金の集計（除外・日次・決定的並び）。
// ============================================================
import { getAddress, type Address } from "viem";
import { BASE_CHAIN_ID, USDC } from "@/lib/x402/base-usdc";
import { vet402BaseUsdcPayToAddresses } from "@/lib/kpi/payto";
import { exclusionForInboundTransfer, vet402OwnPayerAddressesBase } from "@/lib/kpi/own-payers";
import {
  readPayToInboundUsdcWindow,
  type JsonRpcFetch,
  type RawInboundUsdc,
} from "@/lib/kpi/x402-revenue-reader";
import type {
  X402InboundTransfer,
  X402RevenueAggregate,
  X402RevenueDailyRow,
  X402RevenueTotals,
} from "@/lib/kpi/x402-revenue-types";
import { X402_REVENUE_V } from "@/lib/kpi/x402-revenue-types";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseUtcDay(day: string): Date | null {
  if (!DAY_RE.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function utcDayFromUnixSeconds(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function addUnits(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

function compareTransfers(a: RawInboundUsdc, b: RawInboundUsdc): number {
  const ta = Number(a.timeStamp);
  const tb = Number(b.timeStamp);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const bn = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (bn !== 0n) return bn < 0n ? -1 : 1;
  if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
  const fa = a.from.toLowerCase();
  const fb = b.from.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  // 同じ tx・同じ送り手の Transfer が複数あるとき、入力の順に依らないよう額で並べる。
  const va = BigInt(a.value);
  const vb = BigInt(b.value);
  if (va !== vb) return va < vb ? -1 : 1;
  return 0;
}

export function mapRawToInbound(
  rows: readonly RawInboundUsdc[],
  ownPayers: ReadonlySet<string>,
): X402InboundTransfer[] {
  const sorted = [...rows].sort(compareTransfers);
  return sorted.map((r) => {
    const ex = exclusionForInboundTransfer(r.from, r.to, ownPayers);
    return {
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      blockTimeUtc: new Date(Number(r.timeStamp) * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
      from: getAddress(r.from),
      to: getAddress(r.to),
      amountUnits: r.value,
      excluded: ex.excluded,
      exclusionReason: ex.excluded ? ex.reason : null,
    };
  });
}

export function aggregateDaily(transfers: readonly X402InboundTransfer[]): X402RevenueDailyRow[] {
  const byDay = new Map<string, X402RevenueDailyRow>();
  for (const t of transfers) {
    const day = utcDayFromUnixSeconds(Math.floor(Date.parse(t.blockTimeUtc) / 1000));
    let row = byDay.get(day);
    if (!row) {
      row = {
        day,
        transferCount: 0,
        amountUnits: "0",
        excludedTransferCount: 0,
        excludedAmountUnits: "0",
      };
      byDay.set(day, row);
    }
    row.transferCount += 1;
    row.amountUnits = addUnits(row.amountUnits, t.amountUnits);
    if (t.excluded) {
      row.excludedTransferCount += 1;
      row.excludedAmountUnits = addUnits(row.excludedAmountUnits, t.amountUnits);
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function computeTotals(transfers: readonly X402InboundTransfer[]): X402RevenueTotals {
  let transferCount = 0;
  let amountUnits = "0";
  let excludedTransferCount = 0;
  let excludedAmountUnits = "0";
  for (const t of transfers) {
    transferCount += 1;
    amountUnits = addUnits(amountUnits, t.amountUnits);
    if (t.excluded) {
      excludedTransferCount += 1;
      excludedAmountUnits = addUnits(excludedAmountUnits, t.amountUnits);
    }
  }
  const includedTransferCount = transferCount - excludedTransferCount;
  const includedAmountUnits = (BigInt(amountUnits) - BigInt(excludedAmountUnits)).toString();
  return {
    transferCount,
    amountUnits,
    excludedTransferCount,
    excludedAmountUnits,
    includedTransferCount,
    includedAmountUnits,
  };
}

export type FetchX402RevenueOptions = {
  budgetMs?: number;
  ownPayers?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  /** 公開 RPC の差し替え（試験用）。 */
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  skipAlchemy?: boolean;
};

/**
 * 公開索引から着金を読み、除外後の日次集計を返す。
 * 索引が読めない payTo が 1 つでもあれば全体を unreadable（件数 0 と混ぜない）。
 */
export async function fetchX402RevenueAggregate(
  periodStart: string,
  periodEndExclusive: string,
  options: FetchX402RevenueOptions = {},
): Promise<X402RevenueAggregate> {
  const from = parseUtcDay(periodStart);
  const toEx = parseUtcDay(periodEndExclusive);
  const payTos = vet402BaseUsdcPayToAddresses().map((a) => getAddress(a));
  const base: X402RevenueAggregate = {
    v: X402_REVENUE_V,
    readStatus: "unreadable",
    periodStart,
    periodEndExclusive,
    chainId: BASE_CHAIN_ID,
    asset: USDC,
    payToAddresses: payTos,
    source: null,
    readThroughUtc: null,
    periodComplete: false,
    daily: [],
    totals: {
      transferCount: null,
      amountUnits: null,
      excludedTransferCount: null,
      excludedAmountUnits: null,
      includedTransferCount: null,
      includedAmountUnits: null,
    },
    transfers: [],
  };

  if (!from || !toEx || from >= toEx) {
    return { ...base, readDetail: "invalid_period" };
  }

  const ownPayers = options.ownPayers ?? vet402OwnPayerAddressesBase(options.env);
  const rawAll: RawInboundUsdc[] = [];
  let source: "alchemy" | "public_rpc" | null = null;
  let readThroughSec = Infinity;
  const details: string[] = [];

  for (const payTo of payTos) {
    const read = await readPayToInboundUsdcWindow(payTo as Address, from, toEx, {
      budgetMs: options.budgetMs,
      rpcUrl: options.rpcUrl,
      fetchImpl: options.fetchImpl,
      skipAlchemy: options.skipAlchemy,
    });
    if (!read.ok) {
      details.push(`${payTo}:${read.detail}`);
      continue;
    }
    source = source ?? read.source;
    if (read.source !== source) {
      details.push(`${payTo}:mixed_sources`);
      continue;
    }
    rawAll.push(...read.transfers);
    readThroughSec = Math.min(readThroughSec, read.readThroughSec);
  }

  if (details.length > 0) {
    return { ...base, readDetail: details.join(";") };
  }

  const transfers = mapRawToInbound(rawAll, ownPayers);
  const daily = aggregateDaily(transfers);
  const totals = computeTotals(transfers);

  return {
    ...base,
    readStatus: "ok",
    source,
    readThroughUtc: Number.isFinite(readThroughSec) ? new Date(readThroughSec * 1000).toISOString() : null,
    periodComplete: Number.isFinite(readThroughSec) && readThroughSec * 1000 >= toEx.getTime(),
    daily,
    totals,
    transfers,
  };
}

/** テスト・買い手再計算用: 生の着金行から集計だけ行う。 */
export function buildX402RevenueFromRaw(
  periodStart: string,
  periodEndExclusive: string,
  raw: readonly RawInboundUsdc[],
  ownPayers: ReadonlySet<string>,
  source: "alchemy" | "public_rpc",
  readThroughUtc: string | null = null,
): X402RevenueAggregate {
  const payTos = vet402BaseUsdcPayToAddresses().map((a) => getAddress(a));
  const transfers = mapRawToInbound(raw, ownPayers);
  return {
    v: X402_REVENUE_V,
    readStatus: "ok",
    periodStart,
    periodEndExclusive,
    chainId: BASE_CHAIN_ID,
    asset: USDC,
    payToAddresses: payTos,
    source,
    readThroughUtc,
    periodComplete:
      readThroughUtc !== null && Date.parse(readThroughUtc) >= Date.parse(`${periodEndExclusive}T00:00:00.000Z`),
    daily: aggregateDaily(transfers),
    totals: computeTotals(transfers),
    transfers,
  };
}
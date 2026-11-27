// ============================================================
// 月次 KPI JSON（JCS 正規化・sha256）。値は非公開（C2）— repo 内計算用。
// ============================================================
import { createHash } from "node:crypto";
import { jcsSerialize } from "@/lib/signing/jcs";
import type { X402RevenueAggregate } from "@/lib/kpi/x402-revenue-types";

export const KPI_MONTHLY_V = 1 as const;

export type KpiInputStripe = {
  readStatus: "ok" | "unreadable" | "pending";
  readDetail?: string;
};

export type KpiInputEventLog = {
  readStatus: "ok" | "unreadable" | "pending";
  /** イベントログが存在する最初の UTC 日（無ければ null） */
  logStartDay: string | null;
  readDetail?: string;
};

export type KpiMonthlyMetrics = {
  /** x402 Base USDC 着金（除外後）atomic 合計。算べないとき null */
  x402BaseUsdcIncludedAmountUnits: string | null;
  /** Stripe 入金（将来）。 */
  stripeRevenueCents: number | null;
  /** §6 の派生指標は入力が揃うまで null */
  paidCustomers: number | null;
  revenueUsd: string | null;
  retentionRate: number | null;
  arpuUsd: string | null;
};

export type KpiMonthlyExclusions = {
  /** 読めなかった月は null（0 と混ぜない） */
  x402ExcludedTransferCount: number | null;
  x402ExcludedAmountUnits: string | null;
  /** D6・初回掲載など、台帳に載せる除外件数（I0 では x402 側のみ実績） */
  notes: string[];
};

export type KpiMonthlyDocument = {
  v: typeof KPI_MONTHLY_V;
  month: string;
  periodStart: string;
  periodEndExclusive: string;
  computedAt: string;
  inputs: {
    x402BaseUsdc: X402RevenueAggregate | { readStatus: "unreadable"; readDetail: string };
    stripe: KpiInputStripe;
    eventLog: KpiInputEventLog;
  };
  metrics: KpiMonthlyMetrics;
  exclusions: KpiMonthlyExclusions;
  coverage: {
    externalCallerSubjectSince: string | null;
    discoveryKpiSince: string | null;
    planMetricsSince: string | null;
    /** 着金を読んだ x402 の受取（CAIP-2 と資産） */
    x402NetworksRead: string[];
    /**
     * 同じ payTo で課金しているが、まだ読んでいない受取。ここが空になるまで revenueUsd は null のまま。
     * eip155:4663 USDG = GET /api/v1/rwa/paid/facts（packages/rwa/x402.ts）。
     */
    x402NetworksNotRead: string[];
  };
};

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function kpiMonthPeriod(month: string): { periodStart: string; periodEndExclusive: string } | null {
  const m = MONTH_RE.exec(month.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const periodStart = `${m[1]}-${m[2]}-01`;
  const nextY = mon === 12 ? y + 1 : y;
  const nextM = mon === 12 ? 1 : mon + 1;
  const periodEndExclusive = `${String(nextY).padStart(4, "0")}-${String(nextM).padStart(2, "0")}-01`;
  return { periodStart, periodEndExclusive };
}

export type BuildKpiMonthlyInput = {
  month: string;
  computedAt?: string;
  x402: X402RevenueAggregate;
  stripe?: KpiInputStripe;
  eventLog?: KpiInputEventLog;
};

export function buildKpiMonthlyDocument(input: BuildKpiMonthlyInput): KpiMonthlyDocument {
  const period = kpiMonthPeriod(input.month);
  if (!period) throw new Error(`buildKpiMonthlyDocument: invalid month ${input.month}`);

  const stripe: KpiInputStripe = input.stripe ?? { readStatus: "pending", readDetail: "stripe_not_configured" };
  const eventLog: KpiInputEventLog = input.eventLog ?? {
    readStatus: "pending",
    logStartDay: null,
    readDetail: "event_log_not_deployed",
  };

  const x402Input =
    input.x402.readStatus === "ok"
      ? input.x402
      : { readStatus: "unreadable" as const, readDetail: input.x402.readDetail ?? "x402_unreadable" };

  const metrics: KpiMonthlyMetrics = {
    x402BaseUsdcIncludedAmountUnits:
      input.x402.readStatus === "ok" ? input.x402.totals.includedAmountUnits : null,
    stripeRevenueCents: null,
    paidCustomers: null,
    revenueUsd: null,
    retentionRate: null,
    arpuUsd: null,
  };

  const exclusions: KpiMonthlyExclusions = {
    x402ExcludedTransferCount:
      input.x402.readStatus === "ok" ? input.x402.totals.excludedTransferCount : null,
    x402ExcludedAmountUnits:
      input.x402.readStatus === "ok" ? input.x402.totals.excludedAmountUnits : null,
    notes:
      input.x402.readStatus === "ok"
        ? []
        : ["x402_onchain_unreadable: revenue metrics that need chain data stay null"],
  };

  return {
    v: KPI_MONTHLY_V,
    month: input.month,
    periodStart: period.periodStart,
    periodEndExclusive: period.periodEndExclusive,
    computedAt: input.computedAt ?? new Date().toISOString(),
    inputs: {
      x402BaseUsdc: x402Input,
      stripe,
      eventLog,
    },
    metrics,
    exclusions,
    coverage: {
      externalCallerSubjectSince: null,
      discoveryKpiSince: null,
      planMetricsSince: null,
      x402NetworksRead: ["eip155:8453 USDC"],
      x402NetworksNotRead: ["eip155:4663 USDG"],
    },
  };
}

export function serializeKpiMonthlyDocument(doc: KpiMonthlyDocument): string {
  return jcsSerialize(doc);
}

export function hashKpiMonthlyDocument(doc: KpiMonthlyDocument): string {
  return createHash("sha256").update(serializeKpiMonthlyDocument(doc), "utf8").digest("hex");
}

/** 日次 root 用の 1 行（実装は次段階。規則は monthly-freeze と同型）。 */
export function kpiMonthlyAnchorLine(month: string, contentSha256: string): string {
  return `kpi-freeze:v1:${month}:${contentSha256}`;
}
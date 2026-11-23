import type { getCollateralAndVerify } from "@phala/dcap-qvl";

export type VerifyQvlFn = (quoteBytes: Buffer) => ReturnType<typeof getCollateralAndVerify>;

export type TdQuoteFields = {
  tdAttributes: Buffer;
  reportData: Buffer;
  mrConfigId: Buffer;
  rtMr3: Buffer;
};

/** Normalize td10 / td15 / td15ex reports to fields used across verification (SDK `quote.go`). */
export function extractTdQuoteFields(verified: Awaited<ReturnType<typeof getCollateralAndVerify>>): TdQuoteFields | null {
  const report = verified.report;
  const type = report.type;
  if (type !== "td10" && type !== "td15" && type !== "td15ex") return null;

  let base: {
    tdAttributes: Uint8Array;
    reportData: Uint8Array;
    mrConfigId: Uint8Array;
    rtMr3: Uint8Array;
  };

  if (type === "td10") {
    const td = report.data as {
      tdAttributes: Uint8Array;
      reportData: Uint8Array;
      mrConfigId: Uint8Array;
      rtMr3: Uint8Array;
    };
    base = td;
  } else if (type === "td15") {
    const td = report.data as { base: typeof base };
    base = td.base;
  } else {
    const td = report.data as { base: { base: typeof base } };
    base = td.base.base;
  }

  if (Buffer.from(base.tdAttributes).length < 1) return null;

  return {
    tdAttributes: Buffer.from(base.tdAttributes),
    reportData: Buffer.from(base.reportData),
    mrConfigId: Buffer.from(base.mrConfigId),
    rtMr3: Buffer.from(base.rtMr3),
  };
}
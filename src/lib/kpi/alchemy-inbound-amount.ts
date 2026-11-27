// KPI I0: USDC amount from Alchemy's authoritative rawContract.value hex.
// Missing or unparseable → null (never conflate with zero revenue).

export type AlchemyRawContractSlice = {
  rawContract?: { value?: string | null } | null;
};

/**
 * Decimal atomic units for KPI inbound USDC, or null when the row cannot be read.
 * Real zero transfers return "0"; missing rawContract.value returns null.
 */
export function kpiAmountUnitsFromAlchemyRaw(raw: AlchemyRawContractSlice): string | null {
  const hex = raw.rawContract?.value;
  if (hex === undefined || hex === null || hex === "") return null;
  try {
    return BigInt(hex).toString();
  } catch {
    return null;
  }
}
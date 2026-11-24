// GET /api/v1/observatory/export.csv の列構成（既定 21 列 + 任意の末尾列）。
import { EXPORT_CSV_COLUMNS, EXPORT_CSV_COLUMNS_SINCE_2026_11_17 } from "@/lib/observatory/export-columns";
import { erc8004AgentColumnSql } from "@/lib/observatory/erc8004-export-agent";

export const EXPORT_CSV_QUERY_ALLOWED = ["days", "include"] as const;
export const EXPORT_CSV_INCLUDE_ERC8004_AGENT = "erc8004_agent" as const;

export type LedgerExportCsvShape = {
  columns: readonly string[];
  extraSelectSql: string;
};

/** `?include=erc8004_agent` のときだけ末尾に erc8004_agent を足す。 */
export function ledgerExportCsvShape(includeErc8004Agent: boolean): LedgerExportCsvShape {
  if (!includeErc8004Agent) {
    return { columns: EXPORT_CSV_COLUMNS, extraSelectSql: "" };
  }
  return {
    columns: [...EXPORT_CSV_COLUMNS, ...EXPORT_CSV_COLUMNS_SINCE_2026_11_17],
    extraSelectSql: `, (${erc8004AgentColumnSql("pu")}) AS erc8004_agent`,
  };
}
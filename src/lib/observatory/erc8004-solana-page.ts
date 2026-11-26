import { ERC8004_SOLANA_CAIP, ERC8004_SOLANA_PAGE_PATH } from "@/lib/observatory/erc8004-solana-constants";
import type { Erc8004MatchRead } from "@/lib/observatory/erc8004-match";
import { erc8004MatchedFraction } from "@/lib/observatory/erc8004-page";

export const ERC8004_SOLANA_MATCH_RULE =
  "A registered 8004-solana agent counts when the base58 payTo on a vet402 Solana purchase row equals the indexed owner or agentWallet of that agent. Addresses are compared with exact case.";

export const ERC8004_SOLANA_NOT_COUNTED =
  "Agent display names, hostname overlap and registration-file endpoint URLs are not counted in the address match.";

export function erc8004SolanaFraction(data: Erc8004MatchRead) {
  return erc8004MatchedFraction(ERC8004_SOLANA_CAIP, data);
}

export { ERC8004_SOLANA_PAGE_PATH, ERC8004_SOLANA_CAIP };
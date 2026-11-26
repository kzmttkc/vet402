// ============================================================
// 8004-solana Identity Registry index (read-only HTTP, daily in runIdentityIndexes).
// Solana owner and agent_wallet are stored with original base58 case.
// ============================================================
import {
  ERC8004_SOLANA_AGENTS_PATH,
  ERC8004_SOLANA_CAIP,
  ERC8004_SOLANA_DB_CHAIN_ID,
  ERC8004_SOLANA_INDEX_MIN_INTERVAL_MS,
  ERC8004_SOLANA_INDEX_PAGE_LIMIT,
  ERC8004_SOLANA_INDEX_SCOPE,
  ERC8004_SOLANA_INDEXER_ORIGIN,
  ERC8004_SOLANA_STATS_PATH,
  ERC8004_SOLANA_X402_SCOPE,
} from "@/lib/observatory/erc8004-solana-constants";
import { applyErc8004SolanaAgentRows } from "@/lib/db/erc8004-chain-index";
import { erc8004StateCheckpointScope } from "@/lib/db/erc8004-chain-index";
import { getIndexerCheckpoint, setIndexerCheckpoint, setIndexerCheckpoints } from "@/lib/db/owner-index";
import { DeadlineExceededError } from "@/lib/util/deadline";
import { logServerInfoSafe, logServerWarnSafe } from "@/lib/util/log-safe";

export type Erc8004SolanaAgentRow = {
  agent_id: string | number;
  owner?: string | null;
  agent_wallet?: string | null;
  block_slot?: number | string | null;
};

export type Erc8004SolanaIndexDeps = {
  now: () => number;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  getCheckpoint: (scope: string) => Promise<bigint | null>;
  setCheckpoints: typeof setIndexerCheckpoints;
  applyRows: typeof applyErc8004SolanaAgentRows;
  shouldStop?: () => boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function agentIdOf(row: Erc8004SolanaAgentRow): bigint | null {
  const raw = row.agent_id;
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return BigInt(String(raw));
  } catch {
    return null;
  }
}

function lastSlotOf(rows: readonly Erc8004SolanaAgentRow[]): bigint {
  let max = 0n;
  for (const r of rows) {
    const slot = r.block_slot;
    if (slot === null || slot === undefined || slot === "") continue;
    const n = BigInt(String(slot));
    if (n > max) max = n;
  }
  return max;
}

async function fetchJson<T>(deps: Erc8004SolanaIndexDeps, path: string): Promise<T> {
  const url = `${ERC8004_SOLANA_INDEXER_ORIGIN}${path}`;
  const res = await deps.fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "vet402-erc8004-solana-index/1" },
  });
  if (!res.ok) throw new Error(`indexer_http_${res.status}`);
  return (await res.json()) as T;
}

async function readX402DeclaredCount(deps: Erc8004SolanaIndexDeps): Promise<number | null> {
  try {
    const stats = await fetchJson<{ x402Support?: number; x402_support?: number; agents_x402?: number }>(
      deps,
      ERC8004_SOLANA_STATS_PATH,
    );
    const n = stats.x402Support ?? stats.x402_support ?? stats.agents_x402;
    return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
  } catch {
    return null;
  }
}

export type Erc8004SolanaIndexResult =
  | { chain: typeof ERC8004_SOLANA_CAIP; status: "skipped"; reason: string }
  | { chain: typeof ERC8004_SOLANA_CAIP; status: "error"; error: string }
  | {
      chain: typeof ERC8004_SOLANA_CAIP;
      status: "ok";
      agentsWritten: number;
      lastSlot: string;
      pages: number;
      x402Declared: number | null;
      partial: boolean;
      stoppedBy?: string;
    };

export async function indexErc8004Solana(
  options?: {
    maxPages?: number;
    timeBudgetMs?: number;
    startedAt?: number;
    deps?: Partial<Erc8004SolanaIndexDeps>;
  },
): Promise<Erc8004SolanaIndexResult> {
  const deps: Erc8004SolanaIndexDeps = {
    now: Date.now,
    fetch: globalThis.fetch.bind(globalThis),
    sleep: defaultSleep,
    getCheckpoint: getIndexerCheckpoint,
    setCheckpoints: setIndexerCheckpoints,
    applyRows: applyErc8004SolanaAgentRows,
    ...options?.deps,
  };
  const startedAt = options?.startedAt ?? deps.now();
  const maxPages = options?.maxPages ?? 50;
  const budget = options?.timeBudgetMs ?? 120_000;
  const guard = () => {
    if (deps.shouldStop?.()) throw new DeadlineExceededError("erc8004-solana-index", 0);
    if (deps.now() - startedAt > budget) throw new DeadlineExceededError("erc8004-solana-index", budget);
  };

  try {
    let offset = 0;
    let pages = 0;
    let agentsWritten = 0;
    let lastSlot = 0n;
    const owners: { agentId: bigint; owner: string }[] = [];
    const wallets: { agentId: bigint; wallet: string | null }[] = [];

    while (pages < maxPages) {
      guard();
      const path = `${ERC8004_SOLANA_AGENTS_PATH}?limit=${ERC8004_SOLANA_INDEX_PAGE_LIMIT}&offset=${offset}&order=block_slot.asc`;
      const batch = await fetchJson<Erc8004SolanaAgentRow[]>(deps, path);
      if (!Array.isArray(batch) || batch.length === 0) break;
      pages += 1;
      for (const row of batch) {
        const id = agentIdOf(row);
        if (id === null) continue;
        const owner = typeof row.owner === "string" && row.owner.trim() ? row.owner.trim() : null;
        const wallet =
          typeof row.agent_wallet === "string" && row.agent_wallet.trim() ? row.agent_wallet.trim() : null;
        if (owner) owners.push({ agentId: id, owner });
        wallets.push({ agentId: id, wallet });
      }
      const slot = lastSlotOf(batch);
      if (slot > lastSlot) lastSlot = slot;
      if (batch.length < ERC8004_SOLANA_INDEX_PAGE_LIMIT) break;
      offset += batch.length;
      await deps.sleep(ERC8004_SOLANA_INDEX_MIN_INTERVAL_MS);
    }

    if (pages === 0) {
      return { chain: ERC8004_SOLANA_CAIP, status: "skipped", reason: "indexer_empty" };
    }

    guard();
    await deps.applyRows({ owners, wallets });
    agentsWritten = new Set([...owners.map((o) => o.agentId), ...wallets.map((w) => w.agentId)]).size;

    const existing = await deps.getCheckpoint(ERC8004_SOLANA_INDEX_SCOPE);
    const slotForCheckpoint = lastSlot > 0n ? lastSlot : (existing ?? 0n);
    const x402 = await readX402DeclaredCount(deps);
    const stateScope = erc8004StateCheckpointScope(ERC8004_SOLANA_CAIP);
    await deps.setCheckpoints([
      { scope: ERC8004_SOLANA_INDEX_SCOPE, lastBlock: slotForCheckpoint },
      { scope: stateScope, lastBlock: slotForCheckpoint },
      ...(x402 !== null ? [{ scope: ERC8004_SOLANA_X402_SCOPE, lastBlock: BigInt(x402) }] : []),
    ]);

    logServerInfoSafe("erc8004-solana-index", {
      chain: ERC8004_SOLANA_CAIP,
      agentsWritten,
      lastSlot: slotForCheckpoint.toString(),
      pages,
      x402,
    });

    return {
      chain: ERC8004_SOLANA_CAIP,
      status: "ok",
      agentsWritten,
      lastSlot: slotForCheckpoint.toString(),
      pages,
      x402Declared: x402,
      partial: pages >= maxPages,
    };
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      logServerWarnSafe("erc8004-solana-index.partial", error.message);
      return {
        chain: ERC8004_SOLANA_CAIP,
        status: "ok",
        agentsWritten: 0,
        lastSlot: "0",
        pages: 0,
        x402Declared: null,
        partial: true,
        stoppedBy: "time_budget",
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { chain: ERC8004_SOLANA_CAIP, status: "error", error: msg };
  }
}

export async function indexErc8004SolanaChains(
  options?: Parameters<typeof indexErc8004Solana>[0],
): Promise<Erc8004SolanaIndexResult[]> {
  const r = await indexErc8004Solana(options);
  return [r];
}
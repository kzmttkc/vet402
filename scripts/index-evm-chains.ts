#!/usr/bin/env -S npx tsx
// ============================================================
// Base 以外の EVM 決済索引だけを回す（2026-11-08）。
//
// scripts/index-settlements.ts は launchd が 2 時間ごとに回すが、そのジョブには Base の RPC しか渡していない。
// Base は 1 回に約 4 万件のログを書くので、他のチェーンの RPC を足して予算を等分させない。
// Celo・Arc・Tempo・Arbitrum One は、この CLI を別のジョブで回す。
//
// 対象は EVM_INDEX_CHAINS から Base（eip155:8453）を除いたもの。
// eip155:8453 を渡されたら何も索引しない（二重に回さない）。
// RPC は各チェーンの env（CELO_RPC_URL、ARC_RPC_URL、TEMPO_RPC_URL、ARBITRUM_RPC_URL、
// BNB_RPC_URL など）。このファイルに公開 RPC の URL は書かない。
// env が無いチェーンは indexEvmChain が `${rpcEnv}_unset` で返し、失敗には数えない。
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/index-evm-chains.ts --chains eip155:42220,eip155:5042 --budget-ms 1200000
// --budget-ms を省くと 20 分（index-settlements と同じ既定）。
// ============================================================
import { loadWashClassifier } from "@/lib/settlements/context";
import {
  EVM_INDEX_CHAINS,
  indexErrorSkipped,
  indexEvmChain,
  indexFatalErrorText,
  isEvmChainIndexable,
  type EvmIndexChain,
  type EvmIndexSummary,
} from "@/lib/settlements/index-evm";

/** Base。既存の index-settlements が索引する。 */
const BASE_CAIP2 = "eip155:8453";

/** index-settlements と同じ既定（20 分）。 */
const DEFAULT_BUDGET_MS = 20 * 60_000;

/**
 * `--chains` のカンマ区切りを known の行に解決する。
 * 空、未知の id、Base（eip155:8453）は throw する。重複は先に出た 1 本にまとめる。
 * 並びは引数の順（表の順ではない）。
 */
export function parseChainsArg(raw: string, known: readonly EvmIndexChain[]): EvmIndexChain[] {
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (ids.length === 0) {
    throw new Error("chains が空です。CAIP-2 をカンマ区切りで指定してください（例: eip155:42220,eip155:5042）");
  }
  const byCaip = new Map<string, EvmIndexChain>();
  for (const chain of known) {
    if (!byCaip.has(chain.caip2)) byCaip.set(chain.caip2, chain);
  }
  const seen = new Set<string>();
  const out: EvmIndexChain[] = [];
  for (const id of ids) {
    if (id === BASE_CAIP2) {
      throw new Error("eip155:8453（Base）は index-settlements が索引します。この CLI では回しません");
    }
    const chain = byCaip.get(id);
    if (!chain) {
      throw new Error(`未知のチェーンです: ${id}。EVM_INDEX_CHAINS にある CAIP-2 を指定してください`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(chain);
  }
  return out;
}

/**
 * 索引できる本数で予算を等分する（最低 1 本）。
 * 索引できないチェーンには予算を割かない。1 本も索引できなくても 0 では割らない。
 */
export function budgetPerChain(budgetMs: number, chains: readonly EvmIndexChain[]): number {
  const indexable = chains.filter(isEvmChainIndexable).length;
  return Math.floor(budgetMs / Math.max(1, indexable));
}

function argError(message: string): void {
  console.error(`index-evm-chains: ${message}`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  const chainsAt = process.argv.indexOf("--chains");
  const chainsRaw = chainsAt >= 0 ? process.argv[chainsAt + 1] : undefined;
  if (chainsRaw === undefined || chainsRaw.startsWith("--")) {
    argError("--chains がありません。CAIP-2 をカンマ区切りで指定してください（例: eip155:42220,eip155:5042）");
    return;
  }
  let chains: EvmIndexChain[];
  try {
    chains = parseChainsArg(chainsRaw, EVM_INDEX_CHAINS);
  } catch (error) {
    argError(error instanceof Error ? error.message : String(error));
    return;
  }

  const budgetAt = process.argv.indexOf("--budget-ms");
  let budgetMs = DEFAULT_BUDGET_MS;
  if (budgetAt >= 0) {
    const budgetRaw = process.argv[budgetAt + 1];
    // フラグだけあって値が無いときは、既定の 20 分で索引を始めない。
    if (budgetRaw === undefined || budgetRaw.startsWith("--")) {
      argError("--budget-ms の値がありません");
      return;
    }
    budgetMs = Number(budgetRaw);
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      argError("--budget-ms は正の数です");
      return;
    }
  }

  // ここから先が DB と RPC。引数が壊れていたら上で戻る。
  const classifier = await loadWashClassifier();
  // 早く終わった本（caught_up など）の残りは、まだ回していない本へ回す（残り時間を残りの本数で割り直す）。
  const startedAt = Date.now();
  const evm: EvmIndexSummary[] = [];
  for (const [i, chain] of chains.entries()) {
    const remainingMs = Math.max(0, budgetMs - (Date.now() - startedAt));
    const perChain = budgetPerChain(remainingMs, chains.slice(i));
    try {
      evm.push(await indexEvmChain(chain, { budgetMs: perChain, classifier }));
    } catch (error) {
      // indexEvm() と同じ。1 本が投げても残りは続ける。呼び手は error: で失敗と数える。
      evm.push({ chain: chain.caip2, skipped: indexErrorSkipped(error), payees: 0, logs: 0, inserted: 0, updated: 0 });
    }
  }
  const ok = !evm.some((row) => typeof row.skipped === "string" && row.skipped.startsWith("error:"));
  console.log(JSON.stringify({ ok, at: new Date().toISOString(), evm }));
  if (!ok) process.exitCode = 1;
}

// テストは純関数だけを import する。このファイルが入口のときだけ索引する。
const entry = process.argv[1] ?? "";
if (!process.argv.includes("--test") && /(?:^|[\\/])index-evm-chains\.ts$/.test(entry)) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: indexFatalErrorText(error) }));
      process.exit(1);
    });
}

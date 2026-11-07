// ============================================================
// ERC-8004 段階 A（2026-11-08）: vet402 が買った相手と ERC-8004 の登録エージェントの照合。
//
// 数えるのは、購入行の payTo と Base の ERC-8004 Identity Registry の agent の
// 持ち主（owner_agents）または agentWallet（agents.wallet）の**アドレス完全一致**だけ。
// 名前の近さ・あいまい一致・登録ファイルの endpoint は数えない。
//
// - 読みは DB だけ（リクエストの経路で RPC も HTTP も引かない）。
// - 読めなかった時は 0 を出さず status: "unavailable"。失敗はキャッシュしない
//   （unstable_cache は投げた関数の結果を保存しない）。
// - 索引の無いチェーン（Ethereum・BNB）は not_indexed。0 件とは書かない。
// - owner_agents.owner と agents.wallet は書き込み側で小文字に揃えてある
//   （owner-index-writer.ts・agent-wallet-index.ts）ので、その側に lower() を掛けず索引を使う。
//
// state API は retrievedAt を「取得時刻」と宣言している面なので、この塊は自分の readAt を持つ。
// ============================================================
import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { getIndexerCheckpoint, OWNER_INDEX_CHECKPOINT } from "@/lib/db/owner-index";
import { PUBLIC_READ_REVALIDATE } from "./public-read-revalidate";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const ERC8004_INDEXED_CHAIN = "eip155:8453" as const;
const NOT_INDEXED_CHAINS = ["eip155:1", "eip155:56"] as const;
const MAX_LISTED = 200;

export type Erc8004MatchRow = { agentId: string; payTo: string; purchases: number; settled: number };

export type Erc8004MatchInput =
  | { checkedAt: string; error: string }
  | {
      checkedAt: string;
      scannedAgents: number;
      indexBlock: string;
      ownerMatches: Erc8004MatchRow[];
      /** null = agentWallet の索引が空（走査していない）。[] = 走査して一致なし。 */
      walletMatches: Erc8004MatchRow[] | null;
    };

export type Erc8004Match = {
  agentId: string;
  chainId: typeof ERC8004_INDEXED_CHAIN;
  payTo: string;
  matchKind: "owner" | "agent_wallet";
  purchases: number;
  settled: number;
};

export type Erc8004ScannedChain = {
  status: "scanned";
  scannedAgents: number;
  matchedAgents: number;
  indexBlock: string;
};
export type Erc8004NotIndexedChain = { status: "not_indexed" };

export type Erc8004MatchSummary =
  | { status: "unavailable"; checkedAt: string; reason: string }
  | {
      status: "ok";
      checkedAt: string;
      scannedAgents: number;
      matchedAgents: number;
      matchedPayTo: number;
      matchedPurchases: number;
      matchedSettled: number;
      byChain: {
        "eip155:8453": Erc8004ScannedChain;
        "eip155:1": Erc8004NotIndexedChain;
        "eip155:56": Erc8004NotIndexedChain;
      };
      matches: Erc8004Match[];
      notes: string[];
    };

export const ERC8004_AGENT_WALLET_EMPTY_NOTE = "agent_wallet index empty";

/**
 * 購入は payTo に属し、agent には属さない。1 つの payTo が複数の agent を持つと、
 * 同じ購入の集計が agent ごとに並ぶ（同じ purchases・settled）。合計はそれを 1 回だけ数える。
 */
export function summarizeErc8004Match(input: Erc8004MatchInput): Erc8004MatchSummary {
  if ("error" in input) {
    return { status: "unavailable", checkedAt: input.checkedAt, reason: input.error };
  }

  const matches: Erc8004Match[] = [
    ...input.ownerMatches.map((r) => toMatch(r, "owner")),
    ...(input.walletMatches ?? []).map((r) => toMatch(r, "agent_wallet")),
  ];

  const agents = new Set(matches.map((m) => m.agentId));
  // 実データでは同じ payTo の行は同じ (purchases, settled) を持つので 1 回だけ足す。
  // 数の違う行は別の購入の集計として足す（合格の表の 1 本目）。
  const countsByPayTo = new Map<string, Set<string>>();
  for (const m of matches) {
    const seen = countsByPayTo.get(m.payTo) ?? new Set<string>();
    seen.add(`${m.purchases}:${m.settled}`);
    countsByPayTo.set(m.payTo, seen);
  }
  let matchedPurchases = 0;
  let matchedSettled = 0;
  for (const seen of countsByPayTo.values()) {
    for (const key of seen) {
      const [p, s] = key.split(":").map(Number);
      matchedPurchases += p;
      matchedSettled += s;
    }
  }

  const listed = [...matches]
    .sort((a, b) => b.purchases - a.purchases || a.payTo.localeCompare(b.payTo) || compareIds(a.agentId, b.agentId))
    .slice(0, MAX_LISTED);

  const notIndexed = Object.fromEntries(NOT_INDEXED_CHAINS.map((c) => [c, { status: "not_indexed" as const }])) as {
    "eip155:1": Erc8004NotIndexedChain;
    "eip155:56": Erc8004NotIndexedChain;
  };

  return {
    status: "ok",
    checkedAt: input.checkedAt,
    scannedAgents: input.scannedAgents,
    matchedAgents: agents.size,
    matchedPayTo: countsByPayTo.size,
    matchedPurchases,
    matchedSettled,
    byChain: {
      [ERC8004_INDEXED_CHAIN]: {
        status: "scanned",
        scannedAgents: input.scannedAgents,
        matchedAgents: agents.size,
        indexBlock: input.indexBlock,
      },
      ...notIndexed,
    },
    matches: listed,
    notes: input.walletMatches === null ? [ERC8004_AGENT_WALLET_EMPTY_NOTE] : [],
  };
}

function toMatch(r: Erc8004MatchRow, matchKind: Erc8004Match["matchKind"]): Erc8004Match {
  return {
    agentId: String(r.agentId),
    chainId: ERC8004_INDEXED_CHAIN,
    payTo: r.payTo.toLowerCase(),
    matchKind,
    purchases: Number(r.purchases),
    settled: Number(r.settled),
  };
}

function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * 照合の SQL（完全一致だけ）。先に購入側の payTo（約 2,000 種）を小文字で畳み、
 * そこから owner_agents（約 110 万行）と agents を索引で引く。
 * match_kind 'owner' | 'agent_wallet' の行を返す。
 */
export const ERC8004_MATCH_SQL = `
WITH paid AS (
  SELECT lower(pay_to) AS pay_to,
         count(*)::int AS purchases,
         count(*) FILTER (WHERE status = 'settled')::int AS settled
  FROM x402_l1_purchases
  WHERE pay_to IS NOT NULL
  GROUP BY lower(pay_to)
)
SELECT 'owner' AS match_kind, oa.agent_id::text AS agent_id, paid.pay_to, paid.purchases, paid.settled
FROM paid
JOIN owner_agents oa ON oa.owner = paid.pay_to
UNION ALL
SELECT 'agent_wallet' AS match_kind, a.agent_id::text AS agent_id, paid.pay_to, paid.purchases, paid.settled
FROM paid
JOIN agents a ON a.wallet = paid.pay_to AND a.chain_id = 8453
`;

const COUNTS_SQL = `
SELECT (SELECT count(*) FROM owner_agents)::bigint::text AS scanned_agents,
       (SELECT count(*) FROM agents WHERE wallet IS NOT NULL AND chain_id = 8453)::int AS wallet_rows
`;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

/** DB から読んで要約する。投げた例外は unavailable の入力に変える。 */
export async function readErc8004Match(): Promise<Erc8004MatchSummary> {
  const checkedAt = new Date().toISOString();
  try {
    const db = getDb();
    if (!db) return summarizeErc8004Match({ checkedAt, error: "database_not_configured" });
    const indexBlock = await getIndexerCheckpoint(OWNER_INDEX_CHECKPOINT);
    if (indexBlock === null) return summarizeErc8004Match({ checkedAt, error: "owner_index_checkpoint_unreadable" });

    const [countsRaw, matchRaw] = await Promise.all([
      db.execute(sql.raw(COUNTS_SQL)),
      db.execute(sql.raw(ERC8004_MATCH_SQL)),
    ]);
    const counts = rowsOf(countsRaw)[0];
    if (!counts) return summarizeErc8004Match({ checkedAt, error: "agent_counts_unreadable" });

    const ownerMatches: Erc8004MatchRow[] = [];
    const walletMatches: Erc8004MatchRow[] = [];
    for (const r of rowsOf(matchRaw)) {
      const row = {
        agentId: String(r.agent_id),
        payTo: String(r.pay_to),
        purchases: Number(r.purchases),
        settled: Number(r.settled),
      };
      (r.match_kind === "agent_wallet" ? walletMatches : ownerMatches).push(row);
    }

    return summarizeErc8004Match({
      checkedAt,
      scannedAgents: Number(counts.scanned_agents),
      indexBlock: indexBlock.toString(),
      ownerMatches,
      walletMatches: Number(counts.wallet_rows) > 0 ? walletMatches : null,
    });
  } catch (error) {
    // 公開の reason は固定の語だけ。DB の文言（接続先など）は外に出さずログへ。
    logServerErrorSafe("erc8004_match", error);
    return summarizeErc8004Match({ checkedAt, error: "query_failed" });
  }
}

export type Erc8004MatchRead = Erc8004MatchSummary & { readAt: string };

class Erc8004Unavailable extends Error {
  constructor(readonly summary: Erc8004MatchSummary) {
    super("erc8004 match unavailable");
  }
}

const readErc8004MatchCachedInner = unstable_cache(
  async (): Promise<Erc8004MatchRead> => {
    const summary = await readErc8004Match();
    // 失敗を窓のあいだ居座らせない: 投げて unstable_cache に保存させない。
    if (summary.status !== "ok") throw new Erc8004Unavailable(summary);
    return { ...summary, readAt: summary.checkedAt };
  },
  ["observatory:erc8004-match:readAt"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory", "erc8004"] },
);

/** 公開の集計と同じ窓で載せる。失敗は保存せず、その場の unavailable を返す。 */
export async function getErc8004MatchCached(): Promise<Erc8004MatchRead> {
  try {
    return await readErc8004MatchCachedInner();
  } catch (error) {
    if (error instanceof Erc8004Unavailable) return { ...error.summary, readAt: error.summary.checkedAt };
    logServerErrorSafe("erc8004_match_cache", error);
    const checkedAt = new Date().toISOString();
    return { status: "unavailable", checkedAt, reason: "query_failed", readAt: checkedAt };
  }
}

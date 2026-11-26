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
// - Ethereum（eip155:1）と BNB Chain（eip155:56）は 2026-11-10（要件 3.10）から自分の索引
//   （erc8004_chain_agents・索引のジョブは src/lib/indexer/erc8004-chain-indexer.ts）を読み、
//   byChain に scanned か unavailable で出す。not_indexed は出さない。読めない鎖は 0 と書かず
//   unavailable と理由だけ。トップレベルの数（scannedAgents・matched*）は Base のまま。
// - owner_agents.owner と agents.wallet は書き込み側で小文字に揃えてある
//   （owner-index-writer.ts・agent-wallet-index.ts）ので、その側に lower() を掛けず索引を使う。
//
// state API は retrievedAt を「取得時刻」と宣言している面なので、この塊は自分の readAt を持つ。
// ============================================================
import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { getIndexerCheckpoint, OWNER_INDEX_CHECKPOINT } from "@/lib/db/owner-index";
import {
  ERC8004_EXTRA_CHAINS,
  erc8004StateCheckpointScope,
  type Erc8004ExtraChain,
} from "@/lib/db/erc8004-chain-index";
import {
  ERC8004_SOLANA_CAIP,
  ERC8004_SOLANA_DB_CHAIN_ID,
} from "@/lib/observatory/erc8004-solana-constants";
import { PUBLIC_READ_REVALIDATE } from "./public-read-revalidate";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const ERC8004_INDEXED_CHAIN = "eip155:8453" as const;
export { ERC8004_EXTRA_CHAINS, type Erc8004ExtraChain, ERC8004_SOLANA_CAIP };
const MAX_LISTED = 200;

/**
 * state API の erc8004.about（2026-11-10 に route.ts から移した。試験が文を直接読む）。
 * 一致の数を採用や利用者の数として書かない。公開の英語の決まり（we・ダッシュ・セミコロンを置かない）。
 */
export const ERC8004_ABOUT =
  "Exact address equality between the payTo of vet402 purchase rows and the owner or agentWallet of an agent in vet402's index of the ERC-8004 Identity Registry. On EVM chains the comparison uses lowercase addresses. On Solana mainnet base58 addresses keep their original case. The top-level counts are Base. byChain gives Base, Ethereum, BNB Chain and Solana each on its own, with the agents scanned, the agents matched and the block or slot the index has read to. A chain whose index cannot be read says unavailable with a reason and carries no counts. Each purchase row counts once even when its payTo owns several agents. readAt is when these counts were read from the database, cached up to 5 minutes.";

export type Erc8004MatchRow = { agentId: string; payTo: string; purchases: number; settled: number };

/** 1 つの鎖の索引の読み。Base とそれ以外で同じ形。 */
export type Erc8004ChainInput =
  | { error: string }
  | {
      scannedAgents: number;
      indexBlock: string;
      ownerMatches: Erc8004MatchRow[];
      /** null = agentWallet の索引が空（走査していない）。[] = 走査して一致なし。 */
      walletMatches: Erc8004MatchRow[] | null;
      /**
       * 全件の数を SQL で数えた時に渡す。行は上位だけ（一覧用）なので、数はこちらを使う。
       * 無い時は渡された行から数える。
       */
      totals?: Erc8004MatchTotals;
    };

export type Erc8004MatchInput =
  | { checkedAt: string; error: string }
  | ({ checkedAt: string } & Exclude<Erc8004ChainInput, { error: string }> & {
      /** Ethereum・BNB Chain の読み。渡されない鎖は unavailable（chain_index_not_read）。 */
      extraChains?: Partial<Record<Erc8004ExtraChain, Erc8004ChainInput>>;
      /** 8004-solana の読み。渡されないときは unavailable（chain_index_not_read）。 */
      solanaChain?: Erc8004ChainInput;
      /** 状態読み索引の進み（byChain の state* フィールド）。 */
      stateProgress?: Partial<
        Record<Erc8004ExtraChain | typeof ERC8004_INDEXED_CHAIN | typeof ERC8004_SOLANA_CAIP, Erc8004StateProgress>
      >;
      matched_pay_to_owner_only?: number;
      matched_pay_to_wallet_confirmed?: number;
    });

export type Erc8004MatchTotals = {
  matchedAgents: number;
  matchedPayTo: number;
  matchedPurchases: number;
  matchedSettled: number;
};

/** owner だけ一致した payTo と agentWallet でも一致した payTo（段階 D 条件 1・結び間違いの監視）。 */
export type Erc8004MatchBinding = {
  ownerOnlyPayTo: number;
  walletConfirmedPayTo: number;
  /** walletConfirmedPayTo / (ownerOnly + walletConfirmed)。分母 0 なら null。 */
  walletConfirmedShare: number | null;
};

export type Erc8004Match = {
  agentId: string;
  chainId: typeof ERC8004_INDEXED_CHAIN | Erc8004ExtraChain | typeof ERC8004_SOLANA_CAIP;
  payTo: string;
  matchKind: "owner" | "agent_wallet";
  purchases: number;
  settled: number;
};

export type Erc8004StateProgress = {
  stateIndexToken: string;
  stateSupplyEstimate: string | null;
  stateLap: number;
};

export type Erc8004ScannedChain = {
  status: "scanned";
  scannedAgents: number;
  matchedAgents: number;
  indexBlock: string;
  stateIndexToken?: string;
  stateSupplyEstimate?: string | null;
  stateLap?: number;
};
/** 索引が読めない鎖。数を持たない（0 と書かない）。 */
export type Erc8004UnavailableChain = { status: "unavailable"; reason: string };

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
        "eip155:1": Erc8004ScannedChain | Erc8004UnavailableChain;
        "eip155:56": Erc8004ScannedChain | Erc8004UnavailableChain;
        [ERC8004_SOLANA_CAIP]: Erc8004ScannedChain | Erc8004UnavailableChain;
      };
      matches: Erc8004Match[];
      notes: string[];
      matchBinding: Erc8004MatchBinding;
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

  const matches = chainMatches(input, ERC8004_INDEXED_CHAIN);
  const totals = input.totals ?? totalsFromRows(matches);

  // Ethereum・BNB Chain は鎖ごとに数える。agentId は鎖ごとの番号なので、Base の数には混ぜない。
  const extra = {} as Record<Erc8004ExtraChain, Erc8004ScannedChain | Erc8004UnavailableChain>;
  const extraMatches: Erc8004Match[] = [];
  for (const chain of ERC8004_EXTRA_CHAINS) {
    const read = input.extraChains?.[chain];
    if (!read) {
      extra[chain] = { status: "unavailable", reason: "chain_index_not_read" };
    } else if ("error" in read) {
      extra[chain] = { status: "unavailable", reason: read.error };
    } else {
      const rows = chainMatches(read, chain);
      extraMatches.push(...rows);
      const prog = input.stateProgress?.[chain];
      extra[chain] = {
        status: "scanned",
        scannedAgents: read.scannedAgents,
        matchedAgents: (read.totals ?? totalsFromRows(rows)).matchedAgents,
        indexBlock: read.indexBlock,
        ...(prog
          ? {
              stateIndexToken: prog.stateIndexToken,
              stateSupplyEstimate: prog.stateSupplyEstimate,
              stateLap: prog.stateLap,
            }
          : {}),
      };
    }
  }

  let solanaByChain: Erc8004ScannedChain | Erc8004UnavailableChain = {
    status: "unavailable",
    reason: "chain_index_not_read",
  };
  const solanaRead = input.solanaChain;
  if (solanaRead) {
    if ("error" in solanaRead) {
      solanaByChain = { status: "unavailable", reason: solanaRead.error };
    } else {
      const rows = chainMatches(solanaRead, ERC8004_SOLANA_CAIP);
      extraMatches.push(...rows);
      const prog = input.stateProgress?.[ERC8004_SOLANA_CAIP];
      solanaByChain = {
        status: "scanned",
        scannedAgents: solanaRead.scannedAgents,
        matchedAgents: (solanaRead.totals ?? totalsFromRows(rows)).matchedAgents,
        indexBlock: solanaRead.indexBlock,
        ...(prog
          ? {
              stateIndexToken: prog.stateIndexToken,
              stateSupplyEstimate: prog.stateSupplyEstimate,
              stateLap: prog.stateLap,
            }
          : {}),
      };
    }
  }

  const matchBinding = matchBindingOf(input);

  const listed = [...matches, ...extraMatches]
    // SQL の ORDER BY（purchases DESC, pay_to COLLATE "C", agent_id の数の順）と同じ順。鎖が違えば鎖の順。
    .sort(
      (a, b) =>
        b.purchases - a.purchases ||
        compareBytes(a.payTo, b.payTo) ||
        compareBytes(a.chainId, b.chainId) ||
        compareIds(a.agentId, b.agentId),
    )
    .slice(0, MAX_LISTED);

  return {
    status: "ok",
    checkedAt: input.checkedAt,
    scannedAgents: input.scannedAgents,
    ...totals,
    byChain: {
      [ERC8004_INDEXED_CHAIN]: {
        status: "scanned",
        scannedAgents: input.scannedAgents,
        matchedAgents: totals.matchedAgents,
        indexBlock: input.indexBlock,
        ...(input.stateProgress?.[ERC8004_INDEXED_CHAIN]
          ? {
              stateIndexToken: input.stateProgress[ERC8004_INDEXED_CHAIN]!.stateIndexToken,
              stateSupplyEstimate: input.stateProgress[ERC8004_INDEXED_CHAIN]!.stateSupplyEstimate,
              stateLap: input.stateProgress[ERC8004_INDEXED_CHAIN]!.stateLap,
            }
          : {}),
      },
      ...extra,
      [ERC8004_SOLANA_CAIP]: solanaByChain,
    },
    matches: listed,
    notes: input.walletMatches === null ? [ERC8004_AGENT_WALLET_EMPTY_NOTE] : [],
    matchBinding,
  };
}

function matchBindingOf(input: Exclude<Erc8004MatchInput, { error: string }>): Erc8004MatchBinding {
  const ownerOnly = Number(input.matched_pay_to_owner_only ?? 0);
  const walletConfirmed = Number(input.matched_pay_to_wallet_confirmed ?? 0);
  const denom = ownerOnly + walletConfirmed;
  return {
    ownerOnlyPayTo: ownerOnly,
    walletConfirmedPayTo: walletConfirmed,
    walletConfirmedShare: denom > 0 ? Math.round((walletConfirmed / denom) * 10_000) / 100 : null,
  };
}

function chainMatches(
  read: Exclude<Erc8004ChainInput, { error: string }>,
  chainId: Erc8004Match["chainId"],
): Erc8004Match[] {
  return [
    ...read.ownerMatches.map((r) => toMatch(r, "owner", chainId)),
    ...(read.walletMatches ?? []).map((r) => toMatch(r, "agent_wallet", chainId)),
  ];
}

function totalsFromRows(matches: Erc8004Match[]): Erc8004MatchTotals {
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

  return { matchedAgents: agents.size, matchedPayTo: countsByPayTo.size, matchedPurchases, matchedSettled };
}

function toMatch(r: Erc8004MatchRow, matchKind: Erc8004Match["matchKind"], chainId: Erc8004Match["chainId"]): Erc8004Match {
  const preserveCase = chainId === ERC8004_SOLANA_CAIP;
  return {
    agentId: String(r.agentId),
    chainId,
    payTo: preserveCase ? r.payTo : r.payTo.toLowerCase(),
    matchKind,
    purchases: Number(r.purchases),
    settled: Number(r.settled),
  };
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIds(a: string, b: string): number {
  return a.length - b.length || compareBytes(a, b);
}

/**
 * 照合の SQL（完全一致だけ）。1 往復で 1 行を返す。
 * 先に購入側の payTo（約 2,000 種）を小文字で畳み、そこから owner_agents（約 110 万行）と
 * agents を索引で引く。数（agent・payTo・購入・settled）は全件を SQL の中で数え、
 * 一覧は上位 200 行だけを top（JSON）で運ぶ。購入は paid の側で payTo ごとに 1 回だけ足す。
 * 2026-11-08 本番の EXPLAIN ANALYZE: owner_agents の件数 73ms（並列の全件走査）、照合 53ms（索引のみ）。
 * scannedAgents は公開する数なので推定（reltuples）にしない。窓は 300 秒。
 */
export const ERC8004_MATCH_SQL = `
WITH paid AS (
  SELECT lower(pay_to) AS pay_to,
         count(*)::int AS purchases,
         count(*) FILTER (WHERE status = 'settled')::int AS settled
  FROM x402_l1_purchases
  WHERE pay_to IS NOT NULL
  GROUP BY lower(pay_to)
),
m AS (
  SELECT 'owner' AS match_kind, oa.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN owner_agents oa ON oa.owner = paid.pay_to
  UNION ALL
  SELECT 'agent_wallet' AS match_kind, a.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN agents a ON a.wallet = paid.pay_to AND a.chain_id = 8453
)
SELECT
  (SELECT count(*) FROM owner_agents)::bigint::text AS scanned_agents,
  (SELECT count(*) FROM agents WHERE wallet IS NOT NULL AND chain_id = 8453)::int AS wallet_rows,
  (SELECT count(DISTINCT agent_id) FROM m)::int AS matched_agents,
  (SELECT count(DISTINCT pay_to) FROM m)::int AS matched_pay_to,
  (SELECT coalesce(sum(purchases), 0) FROM paid WHERE pay_to IN (SELECT pay_to FROM m))::bigint::text AS matched_purchases,
  (SELECT coalesce(sum(settled), 0) FROM paid WHERE pay_to IN (SELECT pay_to FROM m))::bigint::text AS matched_settled,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM (
     SELECT match_kind, agent_id::text AS agent_id, pay_to, purchases, settled
     FROM m
     ORDER BY m.purchases DESC, m.pay_to COLLATE "C", m.agent_id
     LIMIT ${MAX_LISTED}
   ) t) AS top,
  (SELECT count(*)::int FROM (
     SELECT DISTINCT pay_to FROM m WHERE match_kind = 'owner'
     EXCEPT
     SELECT DISTINCT pay_to FROM m WHERE match_kind = 'agent_wallet'
   ) o) AS matched_pay_to_owner_only,
  (SELECT count(DISTINCT pay_to)::int FROM m WHERE match_kind = 'agent_wallet') AS matched_pay_to_wallet_confirmed
`;

/**
 * Ethereum・BNB Chain の照合（2026-11-10・要件 3.10）。Base の ERC8004_MATCH_SQL と同じ完全一致・
 * 同じ数え方を、erc8004_chain_agents の 1 つの鎖に当てる。1 鎖 1 往復で、索引の到達点
 * （indexer_checkpoints の erc8004_state:<caip2>）も同じ行で返す。
 * owner と wallet は書き込み側（erc8004-chain-index.ts）で小文字に揃えてあるので lower() を掛けない。
 * {{chain_id}} と {{scope}} は erc8004ChainMatchQuery が bind 引数に置き換える（文字列を埋め込まない）。
 */
export const ERC8004_CHAIN_MATCH_SQL_TEXT = `
WITH paid AS (
  SELECT lower(pay_to) AS pay_to,
         count(*)::int AS purchases,
         count(*) FILTER (WHERE status = 'settled')::int AS settled
  FROM x402_l1_purchases
  WHERE pay_to IS NOT NULL
  GROUP BY lower(pay_to)
),
m AS (
  SELECT 'owner' AS match_kind, ca.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN erc8004_chain_agents ca ON ca.chain_id = {{chain_id}} AND ca.owner = paid.pay_to
  UNION ALL
  SELECT 'agent_wallet' AS match_kind, ca.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN erc8004_chain_agents ca ON ca.chain_id = {{chain_id}} AND ca.wallet = paid.pay_to
)
SELECT
  (SELECT last_block FROM indexer_checkpoints WHERE scope = {{scope}})::text AS index_block,
  (SELECT count(*) FROM erc8004_chain_agents WHERE chain_id = {{chain_id}} AND owner IS NOT NULL)::bigint::text AS scanned_agents,
  (SELECT count(*) FROM erc8004_chain_agents WHERE chain_id = {{chain_id}} AND wallet IS NOT NULL)::int AS wallet_rows,
  (SELECT count(DISTINCT agent_id) FROM m)::int AS matched_agents,
  (SELECT count(DISTINCT pay_to) FROM m)::int AS matched_pay_to,
  (SELECT coalesce(sum(purchases), 0) FROM paid WHERE pay_to IN (SELECT pay_to FROM m))::bigint::text AS matched_purchases,
  (SELECT coalesce(sum(settled), 0) FROM paid WHERE pay_to IN (SELECT pay_to FROM m))::bigint::text AS matched_settled,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM (
     SELECT match_kind, agent_id::text AS agent_id, pay_to, purchases, settled
     FROM m
     ORDER BY m.purchases DESC, m.pay_to COLLATE "C", m.agent_id
     LIMIT ${MAX_LISTED}
   ) t) AS top,
  (SELECT count(*)::int FROM (
     SELECT DISTINCT pay_to FROM m WHERE match_kind = 'owner'
     EXCEPT
     SELECT DISTINCT pay_to FROM m WHERE match_kind = 'agent_wallet'
   ) o) AS matched_pay_to_owner_only,
  (SELECT count(DISTINCT pay_to)::int FROM m WHERE match_kind = 'agent_wallet') AS matched_pay_to_wallet_confirmed
`;

const ERC8004_CHAIN_IDS: Record<Erc8004ExtraChain, number> = { "eip155:1": 1, "eip155:56": 56 };

/**
 * 8004-solana 照合。pay_to は小文字化せず、Solana mainnet の購入行だけを分母にする。
 */
export const ERC8004_SOLANA_MATCH_SQL_TEXT = `
WITH paid AS (
  SELECT pay_to,
         count(*)::int AS purchases,
         count(*) FILTER (WHERE status = 'settled')::int AS settled
  FROM x402_l1_purchases
  WHERE pay_to IS NOT NULL
    AND network = {{network}}
  GROUP BY pay_to
),
m AS (
  SELECT 'owner' AS match_kind, ca.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN erc8004_chain_agents ca ON ca.chain_id = {{chain_id}} AND ca.owner = paid.pay_to
  UNION ALL
  SELECT 'agent_wallet' AS match_kind, ca.agent_id, paid.pay_to, paid.purchases, paid.settled
  FROM paid
  JOIN erc8004_chain_agents ca ON ca.chain_id = {{chain_id}} AND ca.wallet = paid.pay_to
)
SELECT
  (SELECT last_block FROM indexer_checkpoints WHERE scope = {{scope}})::text AS index_block,
  (SELECT count(*) FROM erc8004_chain_agents WHERE chain_id = {{chain_id}} AND owner IS NOT NULL)::bigint::text AS scanned_agents,
  (SELECT count(*) FROM erc8004_chain_agents WHERE chain_id = {{chain_id}} AND wallet IS NOT NULL)::int AS wallet_rows,
  (SELECT count(DISTINCT agent_id) FROM m)::int AS matched_agents,
  (SELECT count(DISTINCT pay_to) FROM m)::int AS matched_pay_to,
  (SELECT coalesce(sum(purchases), 0) FROM paid WHERE pay_to IN (SELECT pay_to FROM m))::bigint::text AS matched_purchases,
  (SELECT coalesce(sum(settled), 0) FROM paid WHERE pay_to IN (SELECT pay_to FROM m))::bigint::text AS matched_settled,
  (SELECT coalesce(json_agg(t), '[]'::json) FROM (
     SELECT match_kind, agent_id::text AS agent_id, pay_to, purchases, settled
     FROM m
     ORDER BY m.purchases DESC, m.pay_to COLLATE "C", m.agent_id
     LIMIT ${MAX_LISTED}
   ) t) AS top,
  (SELECT count(*)::int FROM (
     SELECT DISTINCT pay_to FROM m WHERE match_kind = 'owner'
     EXCEPT
     SELECT DISTINCT pay_to FROM m WHERE match_kind = 'agent_wallet'
   ) o) AS matched_pay_to_owner_only,
  (SELECT count(DISTINCT pay_to)::int FROM m WHERE match_kind = 'agent_wallet') AS matched_pay_to_wallet_confirmed
`;

export function erc8004SolanaMatchQuery() {
  const params: Record<string, unknown> = {
    chain_id: ERC8004_SOLANA_DB_CHAIN_ID,
    scope: erc8004StateCheckpointScope(ERC8004_SOLANA_CAIP),
    network: ERC8004_SOLANA_CAIP,
  };
  const parts = ERC8004_SOLANA_MATCH_SQL_TEXT.split(/\{\{(chain_id|scope|network)\}\}/);
  return sql.join(parts.map((p, i) => (i % 2 === 1 ? sql`${params[p]}` : sql.raw(p))));
}

/** ERC8004_CHAIN_MATCH_SQL_TEXT の {{chain_id}}・{{scope}} を bind 引数にした 1 文。 */
export function erc8004ChainMatchQuery(chain: Erc8004ExtraChain) {
  const params: Record<string, unknown> = { chain_id: ERC8004_CHAIN_IDS[chain], scope: erc8004StateCheckpointScope(chain) };
  const parts = ERC8004_CHAIN_MATCH_SQL_TEXT.split(/\{\{(chain_id|scope)\}\}/);
  // split の捕獲で、奇数番目が引数の名前になる。
  return sql.join(parts.map((p, i) => (i % 2 === 1 ? sql`${params[p]}` : sql.raw(p))));
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

/** 照合の SQL の 1 行を、要約の入力に直す（Base と他の鎖で同じ列）。 */
function chainInputOf(row: Record<string, unknown>) {
  const top = (typeof row.top === "string" ? JSON.parse(row.top) : (row.top ?? [])) as Record<string, unknown>[];
  const ownerMatches: Erc8004MatchRow[] = [];
  const walletMatches: Erc8004MatchRow[] = [];
  for (const r of top) {
    const match = {
      agentId: String(r.agent_id),
      payTo: String(r.pay_to),
      purchases: Number(r.purchases),
      settled: Number(r.settled),
    };
    (r.match_kind === "agent_wallet" ? walletMatches : ownerMatches).push(match);
  }
  return {
    scannedAgents: Number(row.scanned_agents),
    ownerMatches,
    walletMatches: Number(row.wallet_rows) > 0 ? walletMatches : null,
    totals: {
      matchedAgents: Number(row.matched_agents),
      matchedPayTo: Number(row.matched_pay_to),
      matchedPurchases: Number(row.matched_purchases),
      matchedSettled: Number(row.matched_settled),
    },
  };
}

/**
 * 1 つの鎖の索引を DB から読む。投げても、その鎖だけが unavailable になり Base は ok のまま。
 * 状態読みが一度も進んでいない鎖（erc8004_state の checkpoint 行が無い）だけ
 * index_not_started。どちらも数を持たない。
 */
async function readSolanaChainIndex(db: NonNullable<ReturnType<typeof getDb>>): Promise<Erc8004ChainInput> {
  try {
    const row = rowsOf(await db.execute(erc8004SolanaMatchQuery()))[0];
    if (!row) return { error: "agent_counts_unreadable" };
    if (row.index_block === null || row.index_block === undefined) return { error: "index_not_started" };
    return { indexBlock: String(row.index_block), ...chainInputOf(row) };
  } catch (error) {
    logServerErrorSafe(`erc8004_match.${ERC8004_SOLANA_CAIP}`, error);
    return { error: "query_failed" };
  }
}

async function readChainIndex(db: NonNullable<ReturnType<typeof getDb>>, chain: Erc8004ExtraChain): Promise<Erc8004ChainInput> {
  try {
    const row = rowsOf(await db.execute(erc8004ChainMatchQuery(chain)))[0];
    if (!row) return { error: "agent_counts_unreadable" };
    if (row.index_block === null || row.index_block === undefined) return { error: "index_not_started" };
    return { indexBlock: String(row.index_block), ...chainInputOf(row) };
  } catch (error) {
    // 公開の reason は固定の語だけ（表が無い・接続先などの DB の文言はログへ）。
    logServerErrorSafe(`erc8004_match.${chain}`, error);
    return { error: "query_failed" };
  }
}

async function readErc8004StateProgress(
  db: NonNullable<ReturnType<typeof getDb>>,
  caip2: string,
): Promise<Erc8004StateProgress | null> {
  const scope = erc8004StateCheckpointScope(caip2);
  const rows = rowsOf(
    await db.execute(sql`
      SELECT last_block::text AS last_block, chain_tip_at_run::text AS supply, last_cursor
      FROM indexer_checkpoints WHERE scope = ${scope}
    `),
  );
  const row = rows[0];
  if (!row || row.last_block == null) return null;
  return {
    stateIndexToken: String(row.last_block),
    stateSupplyEstimate: row.supply != null ? String(row.supply) : null,
    stateLap: Number.parseInt(String(row.last_cursor ?? "0"), 10) || 0,
  };
}

/** DB から読んで要約する。投げた例外は unavailable の入力に変える。 */
export async function readErc8004Match(): Promise<Erc8004MatchSummary> {
  const checkedAt = new Date().toISOString();
  try {
    const db = getDb();
    if (!db) return summarizeErc8004Match({ checkedAt, error: "database_not_configured" });
    const indexBlock = await getIndexerCheckpoint(OWNER_INDEX_CHECKPOINT);
    if (indexBlock === null) return summarizeErc8004Match({ checkedAt, error: "owner_index_checkpoint_unreadable" });

    const row = rowsOf(await db.execute(sql.raw(ERC8004_MATCH_SQL)))[0];
    if (!row) return summarizeErc8004Match({ checkedAt, error: "agent_counts_unreadable" });

    const entries = await Promise.all(
      ERC8004_EXTRA_CHAINS.map(async (chain) => [chain, await readChainIndex(db, chain)] as const),
    );
    const solanaChain = await readSolanaChainIndex(db);
    const progressEntries = await Promise.all(
      [ERC8004_INDEXED_CHAIN, ...ERC8004_EXTRA_CHAINS, ERC8004_SOLANA_CAIP].map(
        async (chain) => [chain, await readErc8004StateProgress(db, chain)] as const,
      ),
    );
    const stateProgress = Object.fromEntries(progressEntries.filter(([, p]) => p !== null)) as Partial<
      Record<Erc8004ExtraChain | typeof ERC8004_INDEXED_CHAIN | typeof ERC8004_SOLANA_CAIP, Erc8004StateProgress>
    >;

    return summarizeErc8004Match({
      checkedAt,
      indexBlock: indexBlock.toString(),
      ...chainInputOf(row),
      matched_pay_to_owner_only: Number(row.matched_pay_to_owner_only ?? 0),
      matched_pay_to_wallet_confirmed: Number(row.matched_pay_to_wallet_confirmed ?? 0),
      extraChains: Object.fromEntries(entries),
      solanaChain,
      stateProgress,
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

type CacheFn = typeof unstable_cache;

/**
 * キャッシュの包みを差し替えられる形で作る（本番は unstable_cache。テストは tsx の中で
 * incrementalCache が無く unstable_cache が投げるので、素通しの包みで成功の経路を試す）。
 */
export function makeErc8004CachedReader(
  cache: CacheFn,
  read: () => Promise<Erc8004MatchSummary> = readErc8004Match,
): () => Promise<Erc8004MatchRead> {
  const inner = cache(
    async (): Promise<Erc8004MatchRead> => {
      const summary = await read();
      // 失敗を窓のあいだ居座らせない: 投げて unstable_cache に保存させない。
      if (summary.status !== "ok") throw new Erc8004Unavailable(summary);
      return { ...summary, readAt: summary.checkedAt };
    },
    ["observatory:erc8004-match:readAt"],
    { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory", "erc8004"] },
  );
  /** 公開の集計と同じ窓で載せる。失敗は保存せず、その場の unavailable を返す。 */
  return async () => {
    try {
      return await inner();
    } catch (error) {
      if (error instanceof Erc8004Unavailable) return { ...error.summary, readAt: error.summary.checkedAt };
      logServerErrorSafe("erc8004_match_cache", error);
      const checkedAt = new Date().toISOString();
      return { status: "unavailable", checkedAt, reason: "query_failed", readAt: checkedAt };
    }
  };
}

let cachedReader = makeErc8004CachedReader(unstable_cache);

/** テストの差し替え口。null で本番の unstable_cache に戻す。 */
export function __setErc8004CacheForTests(cache: CacheFn | null): void {
  cachedReader = makeErc8004CachedReader(cache ?? unstable_cache);
}

export function getErc8004MatchCached(): Promise<Erc8004MatchRead> {
  return cachedReader();
}

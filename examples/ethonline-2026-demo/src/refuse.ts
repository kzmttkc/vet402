/**
 * `refuse` —— 台本 0:45–1:15 と 1:15–1:30。
 *
 * 相手は拒否側フィクスチャ `0xb15a55e8…`（`agent.api.0x.org`・WINDOW_PLAN §10 / fixtures §6）。
 * **この相手が悪いのではない。我々がまだ一度も買っていない。** だから既定の policy は払わない。
 *
 * 画は2カラム。
 *   左 [A] 我々の `/decision?role=payer` の生の応答（判定・理由コード・L0/L1 の事実）
 *   右 [B] The Graph の x402 Base subgraph の生の応答
 *          （`_meta.block.number` と `deployment` を必ず映す——**live を読んだ唯一の自明な証明**）
 *
 * 判定は `payOrRefuse` が出す。デモは呼ぶだけで、**判定を写経しない**。
 * `policy.evidence.source: "both"` を渡すのは、`payOrRefuse` が judgement の**前に**
 * 両方の源を読むから（DESIGN §3.5 / D14）——拒否したときにも、もう一方の源が
 * 何を知っているかが決定行に残る。§3.1 の核はまさに我々が拒否する相手について成り立つ。
 */
import { payOrRefuse } from "../../../packages/sdk/dist/index.js";
import type { Emitter } from "./emit.ts";
import { renderRefuse, type RefuseView } from "./render.ts";
import { VET402_API, computeResourceId, instrument, requireEnv } from "./probe.ts";

/** 拒否側フィクスチャ。撮影前に L1 実績が付いていないか再確認する（fixtures.md §6）。 */
export const REFUSE_TARGET = {
  method: "GET",
  url: "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote",
  payee: "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59",
  amountUsd: 0.01,
} as const;

/** 呼び手が名指しする証拠の床（rehearsal-c1.md「会期で使う policy」）。 */
export const MIN_L1_DELIVERIES = 3;
export const MIN_SUBGRAPH_RECEIPTS = 1;

export type RunRefuseOptions = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  emit: Emitter;
  /** 既定は「触れたら落ちる」account。拒否経路には署名の手段が最初から無い。 */
  account?: unknown;
  color?: boolean;
};

function tripwireAccount(): unknown {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`refuse path touched account.${String(property)} — that must never happen`);
      },
    },
  );
}

export async function runRefuse(
  options: RunRefuseOptions,
): Promise<{ view: RefuseView; result: Awaited<ReturnType<typeof payOrRefuse>> }> {
  requireEnv(options.env, ["GRAPH_API_KEY", "VOUCH_API_KEY"]);

  const net = instrument(options.fetch);
  const resourceId = await computeResourceId(REFUSE_TARGET.method, REFUSE_TARGET.url);

  const result = await payOrRefuse({
    payee: REFUSE_TARGET.payee,
    resource: REFUSE_TARGET.url,
    method: REFUSE_TARGET.method,
    amountUsd: REFUSE_TARGET.amountUsd,
    account: options.account ?? tripwireAccount(),
    fetch: net.fetch,
    apiKey: options.env.VOUCH_API_KEY,
    resourceId,
    source: "agent-demo",
    policy: {
      maxPerTxUsd: 1,
      evidence: {
        source: "both",
        minL1Deliveries: MIN_L1_DELIVERIES,
        minSubgraphReceipts: MIN_SUBGRAPH_RECEIPTS,
        graphApiKey: options.env.GRAPH_API_KEY,
      },
    },
  });

  const decision = result.decision.decision as
    | {
        recommendation?: string;
        reason_codes?: string[];
        degraded?: boolean;
        facts?: { l0?: Record<string, unknown>; l1?: Record<string, unknown> };
        scoredAt?: string;
      }
    | null;
  const raw = net.subgraphRaw as
    | {
        data?: {
          _meta?: { block?: { number?: number; timestamp?: number }; deployment?: string };
          x402AddressSummaries?: Record<string, string>[];
        };
      }
    | undefined;
  const meta = raw?.data?._meta;
  const row = raw?.data?.x402AddressSummaries?.[0];

  const view: RefuseView = {
    resource: { method: REFUSE_TARGET.method, url: REFUSE_TARGET.url },
    payee: REFUSE_TARGET.payee,
    ranAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    vet402: decision
      ? {
          endpoint: `${VET402_API}/resources/${resourceId}/decision?role=payer`,
          recommendation: String(decision.recommendation ?? "—"),
          reasonCodes: Array.isArray(decision.reason_codes) ? decision.reason_codes : [],
          degraded: decision.degraded === true,
          l0: {
            status: String(decision.facts?.l0?.status ?? "—"),
            observed_at: (decision.facts?.l0?.observed_at as string | null) ?? null,
            dialect: (decision.facts?.l0?.dialect as string | null) ?? null,
          },
          l1: {
            n_delivered: Number(decision.facts?.l1?.n_delivered ?? 0),
            n_settled: Number(decision.facts?.l1?.n_settled ?? 0),
            n_attempts: Number(decision.facts?.l1?.n_attempts ?? 0),
            observed_at: (decision.facts?.l1?.observed_at as string | null) ?? null,
          },
          scoredAt: String(decision.scoredAt ?? ""),
        }
      : null,
    // 数字を作らない: `_meta.block.number` が返っていないなら subgraph 列は「読めなかった」。
    subgraph:
      typeof meta?.block?.number === "number"
        ? {
            endpoint: `${VET402_API}`,
            block: { number: meta.block.number, timestamp: meta.block.timestamp },
            deployment: meta.deployment,
            row: row
              ? {
                  role: row.role,
                  totalPayments: row.totalPayments,
                  totalVolumeDecimal: row.totalVolumeDecimal,
                  firstPaymentTimestamp: row.firstPaymentTimestamp,
                  lastPaymentTimestamp: row.lastPaymentTimestamp,
                }
              : null,
          }
        : null,
    outcome: {
      status: result.status,
      signed: result.signed,
      nonce: result.nonce,
      txHash: result.txHash,
      reasonCodes: result.decision.reason_codes,
      evidence: result.decision.evidence,
    },
    requests: net.calls,
  };

  options.emit.lines(renderRefuse(view, { color: options.color === true }));
  return { view, result };
}

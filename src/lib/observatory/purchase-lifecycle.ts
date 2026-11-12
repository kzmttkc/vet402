// ============================================================
// B1 購入の段階（ABSORB）。台帳の status は export.csv の意味のまま残す。
// 段階は state API と /sellers にだけ出す。分からない行は delivered にも
// not_delivered にも寄せない。鎖の組み直しで取り消した行は消さず reorg_revoked へ移す。
// not_delivered は争いの公開段（e6PublicStage）と同じ語。
// ============================================================
import { heldReasonOf, isDelivered } from "@/lib/observatory/delivery";

export const LIFECYCLE_STAGES = [
  "http_402",
  "signed",
  "settlement_claimed",
  "chain_reread",
  "delivered",
  "held",
  "not_delivered",
  "reorg_revoked",
  "unknown",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const LIFECYCLE_NOTE =
  "Each purchase row is counted once under lifecycle. When a chain reorganization revokes a row, vet402 keeps the row and moves it to reorg_revoked. The row does not leave the total. A row vet402 cannot place stays unknown. unknown is not delivered and it is not not_delivered.";

export const LIFECYCLE_STAGE_COPY: Record<LifecycleStage, string> = {
  http_402: "vet402 received HTTP 402 and did not sign.",
  signed: "vet402 signed a payment and has no settlement claim on the row.",
  settlement_claimed: "vet402 has a settlement claim from the seller and has not confirmed that claim by reading the chain.",
  chain_reread: "vet402 read the payment on the chain and does not yet call the delivery delivered, held, or not_delivered.",
  delivered: "vet402 read the payment on the chain and the paid request returned a 2xx other than 202 with a body vet402 did not record as empty.",
  held: "vet402 holds the row for the same held_reason as the ledger. vet402 does not count the row as delivered or as not_delivered.",
  not_delivered: "vet402 read the payment on the chain and did not get a delivery. The word matches the trade dispute stage not_delivered.",
  reorg_revoked: "vet402 read the chain again and the payment was revoked. vet402 keeps the row in this stage.",
  unknown: "vet402 cannot place the row on a stage. The row stays here.",
};

const CLAIM_STATUSES = new Set(["settle_claimed", "settle_claimed_unverifiable"]);
const SIGNED_UNCONFIRMED = new Set(["settle_failed", "delivered_no_receipt"]);
/** 402 を読んで署名前に止めた行。予算や停止は 402 を見たと断定しない。 */
const SAW_402 = new Set(["no_eligible_accept", "price_mismatch", "payto_mismatch", "payto_operator_self"]);

export type LifecycleInput = {
  status: string;
  httpStatusPaid: number | null;
  txHash?: string | null;
  payloadNonEmpty?: boolean | null;
  attemptedAt?: string | null;
  network?: string | null;
  settlementConfirmed?: boolean | null;
  reorgRevokedAt?: string | null;
  meta?: Record<string, unknown> | null;
};

export type LifecycleTransition = { stage: LifecycleStage; at: string };

export type LifecycleRow = {
  id: string;
  status: string;
  httpStatusPaid: number | null;
  txHash: string | null;
  payloadNonEmpty: boolean | null;
  attemptedAt: string;
  network: string | null;
  settlementConfirmed: boolean | null;
  reorgRevokedAt: string | null;
  transitions: LifecycleTransition[];
};

export type LifecycleCounts = {
  stages: Record<LifecycleStage, number>;
  total: number;
};

export function reorgRevokedAtOf(row: Pick<LifecycleInput, "reorgRevokedAt" | "meta">): string | null {
  if (typeof row.reorgRevokedAt === "string" && row.reorgRevokedAt.length > 0) return row.reorgRevokedAt;
  const life = row.meta?.purchaseLifecycle;
  if (!life || typeof life !== "object") return null;
  const at = (life as { reorgRevokedAt?: unknown }).reorgRevokedAt;
  return typeof at === "string" && at.length > 0 ? at : null;
}

/** いまの段階。reorg は他の段階より先に見る。held は delivered と not_delivered より先。 */
export function lifecycleStageOf(row: LifecycleInput): LifecycleStage {
  if (reorgRevokedAtOf(row)) return "reorg_revoked";
  const held = heldReasonOf({
    status: row.status,
    httpStatusPaid: row.httpStatusPaid,
    txHash: row.txHash ?? null,
    attemptedAt: row.attemptedAt ?? null,
    network: row.network ?? null,
  });
  if (held) return "held";
  if (row.status === "settled") {
    if (isDelivered({ status: row.status, httpStatusPaid: row.httpStatusPaid, payloadNonEmpty: row.payloadNonEmpty })) {
      return "delivered";
    }
    const code = row.httpStatusPaid;
    if (code === null || code === 202) return "chain_reread";
    return "not_delivered";
  }
  if (CLAIM_STATUSES.has(row.status)) return "settlement_claimed";
  if (row.settlementConfirmed === true && SIGNED_UNCONFIRMED.has(row.status)) return "chain_reread";
  if (SIGNED_UNCONFIRMED.has(row.status)) return "signed";
  if (SAW_402.has(row.status)) return "http_402";
  return "unknown";
}

export function lifecycleAtOf(row: LifecycleInput): string | null {
  return reorgRevokedAtOf(row) ?? (typeof row.attemptedAt === "string" && row.attemptedAt.length > 0 ? row.attemptedAt : null);
}

export function emptyLifecycleCounts(): LifecycleCounts {
  const stages = {} as Record<LifecycleStage, number>;
  for (const stage of LIFECYCLE_STAGES) stages[stage] = 0;
  return { stages, total: 0 };
}

export function countLifecycle(rows: readonly LifecycleInput[]): LifecycleCounts {
  const counts = emptyLifecycleCounts();
  for (const row of rows) {
    counts.stages[lifecycleStageOf(row)] += 1;
    counts.total += 1;
  }
  return counts;
}

/** 行を開く。取り消しはまだ付けない。最初の遷移時刻は attemptedAt。 */
export function openLifecycleRow(input: LifecycleInput & { id: string }): LifecycleRow {
  const attemptedAt = typeof input.attemptedAt === "string" && input.attemptedAt.length > 0 ? input.attemptedAt : "1970-01-01T00:00:00Z";
  const opened: LifecycleInput = {
    status: input.status,
    httpStatusPaid: input.httpStatusPaid,
    txHash: input.txHash ?? null,
    payloadNonEmpty: input.payloadNonEmpty ?? null,
    attemptedAt,
    network: input.network ?? null,
    settlementConfirmed: input.settlementConfirmed ?? null,
    reorgRevokedAt: null,
  };
  return {
    id: input.id,
    status: input.status,
    httpStatusPaid: input.httpStatusPaid,
    txHash: input.txHash ?? null,
    payloadNonEmpty: input.payloadNonEmpty ?? null,
    attemptedAt,
    network: input.network ?? null,
    settlementConfirmed: input.settlementConfirmed ?? null,
    reorgRevokedAt: null,
    transitions: [{ stage: lifecycleStageOf(opened), at: attemptedAt }],
  };
}

/**
 * 鎖の組み直しで取り消す。行は残す。台帳の status は変えない。
 * 移った時刻を遷移に足す。同じ行への 2 回目は遷移を増やさない。
 */
export function revokeForChainReorg(row: LifecycleRow, at: string): LifecycleRow {
  if (typeof at !== "string" || at.length === 0) {
    throw new Error("revokeForChainReorg: at is required");
  }
  if (row.reorgRevokedAt) return row;
  return {
    ...row,
    status: row.status,
    reorgRevokedAt: at,
    transitions: [...row.transitions, { stage: "reorg_revoked", at }],
  };
}

export type PublishedLifecycle = {
  stages: Record<LifecycleStage, number>;
  total: number;
  order: readonly LifecycleStage[];
  note: string;
};

export function publishLifecycle(counts: LifecycleCounts): PublishedLifecycle {
  return {
    stages: counts.stages,
    total: counts.total,
    order: LIFECYCLE_STAGES,
    note: LIFECYCLE_NOTE,
  };
}

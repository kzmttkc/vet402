// NEAR AI TEE day roots — independent from L1 canonicalDayPayload.
import { createHash } from "node:crypto";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type NearAiAnchorRow = {
  id: number;
  modelId: string;
  tcbStatus: string;
  publicStatus: string;
  gpuPass: boolean;
  advisoryIds: string[];
  candidateCount: number;
  probedAt: string;
};

export function nearAiDayPayload(day: string, rows: readonly NearAiAnchorRow[]): string {
  const sorted = [...rows].sort((a, b) => a.modelId.localeCompare(b.modelId) || a.id - b.id);
  return JSON.stringify({
    v: 1,
    kind: "nearai_tee",
    day,
    rows: sorted.map((r) => ({
      id: r.id,
      model_id: r.modelId,
      tcb_status: r.tcbStatus,
      public_status: r.publicStatus,
      gpu_pass: r.gpuPass,
      advisory_ids: r.advisoryIds,
      candidate_count: r.candidateCount,
      probed_at: r.probedAt,
    })),
  });
}

export function nearAiDayRootHash(prevRoot: string | null, day: string, rows: readonly NearAiAnchorRow[]): string {
  const payload = nearAiDayPayload(day, rows);
  return createHash("sha256")
    .update(prevRoot ?? "genesis", "utf8")
    .update("\n")
    .update(payload, "utf8")
    .digest("hex");
}

export function nearAiRowSha256(modelId: string, tcbStatus: string, publicStatus: string, gpuPass: boolean, probedAt: string): string {
  const body = JSON.stringify({ modelId, tcbStatus, publicStatus, gpuPass, probedAt });
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function assertUtcDay(day: string): boolean {
  return DAY_RE.test(day);
}
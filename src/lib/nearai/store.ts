import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { nearaiDayRoots, nearaiHeldTargets, nearaiModelProbes, nearaiProbeRuns } from "@/lib/db/schema";
import { nearAiDayPayload, nearAiDayRootHash, type NearAiAnchorRow } from "./anchors";
import { processProbeRun, snapshotFromRun, type NearAiRunRecord } from "./process-run";
import type { NearAiProbeOutput } from "./probe-types";
import type { NearAiPublicSnapshot } from "./read-public";
import { isSeriousCryptoFailure } from "./failure-class";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SealNearAiDayResult =
  | { status: "sealed"; day: string; rootHash: string; prevRoot: string | null; entryCount: number }
  | { status: "unchanged"; day: string; rootHash: string }
  | { status: "conflict_frozen"; day: string }
  | { status: "unavailable" };

export interface NearAiStore {
  ingestProbeOutput(output: NearAiProbeOutput, utcDay: string): Promise<NearAiRunRecord>;
  getLatestRun(): Promise<NearAiRunRecord | null>;
  getLatestPublicSnapshot(): Promise<NearAiPublicSnapshot | null>;
  getAnchorRowsForDay(day: string): Promise<NearAiAnchorRow[]>;
  getDaySeal(day: string): Promise<{
    rootHash: string;
    prevRoot: string | null;
    entryCount: number;
    payload: string;
  } | null>;
  latestRootBefore(day: string): Promise<string | null>;
  sealDay(day: string): Promise<SealNearAiDayResult>;
}

export class MemoryNearAiStore implements NearAiStore {
  private runs: NearAiRunRecord[] = [];
  private held = new Set<string>();
  private serious: Record<string, string | null> = {};
  private dayRoots = new Map<string, { rootHash: string; prevRoot: string | null; entryCount: number; payload: string }>();
  private rowId = 1;

  async ingestProbeOutput(output: NearAiProbeOutput, utcDay: string): Promise<NearAiRunRecord> {
    const runId = this.runs.length + 1;
    const run = processProbeRun(
      output,
      utcDay,
      runId,
      randomUUID(),
      this.serious,
      this.held,
      this.rowId,
    );
    this.rowId += run.models.length;
    for (const m of run.models) {
      if (m.held) this.held.add(m.modelId);
      const fc = m.rawFailureClass;
      if (m.held) this.held.add(m.modelId);
      if (fc && isSeriousCryptoFailure(fc)) this.serious[m.modelId] = fc;
      else if (!m.held && m.publicStatus !== "pending_reverify") this.serious[m.modelId] = null;
    }
    if (run.gatewayHeld) this.held.add("gateway");
    this.runs.push(run);
    return run;
  }

  async getLatestRun(): Promise<NearAiRunRecord | null> {
    return this.runs[this.runs.length - 1] ?? null;
  }

  async getLatestPublicSnapshot(): Promise<NearAiPublicSnapshot | null> {
    const run = await this.getLatestRun();
    if (!run) return null;
    return snapshotFromRun(run);
  }

  async getAnchorRowsForDay(day: string): Promise<NearAiAnchorRow[]> {
    const run = this.runs.find((r) => r.utcDay === day);
    if (!run) return [];
    return run.models
      .filter((m) => !m.held)
      .map((m) => ({
        id: m.id,
        modelId: m.modelId,
        tcbStatus: m.tcbStatus,
        publicStatus: m.publicStatus,
        gpuPass: m.gpuPass,
        advisoryIds: m.advisoryIds,
        candidateCount: m.candidateCount,
        probedAt: m.probedAt,
      }));
  }

  async getDaySeal(day: string) {
    return this.dayRoots.get(day) ?? null;
  }

  async latestRootBefore(day: string): Promise<string | null> {
    const days = [...this.dayRoots.keys()].filter((d) => d < day).sort();
    return days.length ? (this.dayRoots.get(days[days.length - 1]!)?.rootHash ?? null) : null;
  }

  async sealDay(day: string): Promise<SealNearAiDayResult> {
    if (!DAY_RE.test(day)) return { status: "unavailable" };
    const rows = await this.getAnchorRowsForDay(day);
    const prev = await this.latestRootBefore(day);
    const payloadJson = nearAiDayPayload(day, rows);
    const rootHash = nearAiDayRootHash(prev, day, rows);
    const existing = this.dayRoots.get(day);
    if (existing) {
      if (existing.rootHash !== rootHash) return { status: "conflict_frozen", day };
      return { status: "unchanged", day, rootHash };
    }
    this.dayRoots.set(day, { rootHash, prevRoot: prev, entryCount: rows.length, payload: payloadJson });
    return { status: "sealed", day, rootHash, prevRoot: prev, entryCount: rows.length };
  }

  /** Test helper: reset state. */
  reset(): void {
    this.runs = [];
    this.held = new Set();
    this.serious = {};
    this.dayRoots = new Map();
    this.rowId = 1;
  }
}

function pgStore(db: NonNullable<ReturnType<typeof getDb>>): NearAiStore {
  const memory = new MemoryNearAiStore();
  return {
    async ingestProbeOutput(output, utcDay) {
      try {
        const [run] = await db
          .insert(nearaiProbeRuns)
          .values({
            runUuid: randomUUID(),
            startedAt: new Date(output.startedAt),
            completedAt: new Date(output.completedAt),
            utcDay,
            pccsUrl: output.pccsUrl,
            nearaiModelCount: output.catalogSummary.nearaiCount,
            gatewayOk: Boolean(output.gateway.ok),
            gatewayTcbStatus: output.gateway.tcbStatus ?? null,
            runStatus: "ok",
            summaryJson: output,
          })
          .returning();
        const runId = run!.id;
        const prevRun = await db.select().from(nearaiProbeRuns).orderBy(desc(nearaiProbeRuns.id)).limit(2);
        const prevSerious: Record<string, string | null> = {};
        const heldRows = await db.select().from(nearaiHeldTargets);
        const held = new Set<string>(heldRows.map((h: { targetKey: string }) => h.targetKey));
        const processed = processProbeRun(output, utcDay, runId, randomUUID(), prevSerious, held, prevRun.length ? prevRun[0]!.id * 1000 : 1);
        for (const m of processed.models) {
          await db.insert(nearaiModelProbes).values({
            runId,
            utcDay,
            modelId: m.modelId,
            candidateCount: m.candidateCount,
            tcbStatus: m.tcbStatus,
            advisoryIdsJson: m.advisoryIds,
            gpuPass: m.gpuPass,
            publicStatus: m.publicStatus,
            failureClass: m.rawFailureClass,
            rowSha256: m.rowSha256,
            held: m.held,
            probedAt: new Date(m.probedAt),
          });
          if (m.held && m.rawFailureClass) {
            await db
              .insert(nearaiHeldTargets)
              .values({ targetKey: m.modelId, failureClass: m.rawFailureClass, confirmedAt: new Date() })
              .onConflictDoNothing();
          }
        }
        return processed;
      } catch (e) {
        if (isMissingSchemaError(e)) return memory.ingestProbeOutput(output, utcDay);
        throw e;
      }
    },
    async getLatestRun() {
      try {
        const [row] = await db.select().from(nearaiProbeRuns).orderBy(desc(nearaiProbeRuns.id)).limit(1);
        if (!row) return null;
        const output = row.summaryJson as NearAiProbeOutput;
        const modelRows = await db.select().from(nearaiModelProbes).where(eq(nearaiModelProbes.runId, row.id));
        const processed = processProbeRun(output, row.utcDay, row.id, row.runUuid, {}, new Set(), 1);
        processed.models = modelRows.map((r: (typeof nearaiModelProbes.$inferSelect)) => ({
          id: r.id,
          runId: r.runId,
          modelId: r.modelId,
          candidateCount: r.candidateCount,
          tcbStatus: r.tcbStatus,
          advisoryIds: r.advisoryIdsJson as string[],
          gpuPass: r.gpuPass,
          publicStatus: r.publicStatus as NearAiRunRecord["models"][0]["publicStatus"],
          rawFailureClass: r.failureClass,
          rowSha256: r.rowSha256,
          probedAt: r.probedAt.toISOString(),
          held: r.held,
        }));
        return processed;
      } catch (e) {
        if (isMissingSchemaError(e)) return memory.getLatestRun();
        throw e;
      }
    },
    async getLatestPublicSnapshot() {
      const run = await this.getLatestRun();
      if (!run) return null;
      return snapshotFromRun(run);
    },
    async getAnchorRowsForDay(day) {
      try {
        const rows = await db
          .select()
          .from(nearaiModelProbes)
          .where(and(eq(nearaiModelProbes.utcDay, day), eq(nearaiModelProbes.held, false)));
        return rows.map((r: (typeof nearaiModelProbes.$inferSelect)) => ({
          id: r.id,
          modelId: r.modelId,
          tcbStatus: r.tcbStatus,
          publicStatus: r.publicStatus,
          gpuPass: r.gpuPass,
          advisoryIds: r.advisoryIdsJson as string[],
          candidateCount: r.candidateCount,
          probedAt: r.probedAt.toISOString(),
        }));
      } catch (e) {
        if (isMissingSchemaError(e)) return memory.getAnchorRowsForDay(day);
        throw e;
      }
    },
    async getDaySeal(day) {
      try {
        const [row] = await db.select().from(nearaiDayRoots).where(eq(nearaiDayRoots.day, day));
        if (!row) return null;
        return {
          rootHash: row.rootHash,
          prevRoot: row.prevRoot,
          entryCount: row.entryCount,
          payload: row.payloadJson,
        };
      } catch (e) {
        if (isMissingSchemaError(e)) return memory.getDaySeal(day);
        throw e;
      }
    },
    async latestRootBefore(day) {
      try {
        const rows = await db
          .select({ rootHash: nearaiDayRoots.rootHash })
          .from(nearaiDayRoots)
          .where(lt(nearaiDayRoots.day, day))
          .orderBy(sql`${nearaiDayRoots.day} desc`)
          .limit(1);
        return rows[0]?.rootHash ?? null;
      } catch (e) {
        if (isMissingSchemaError(e)) return memory.latestRootBefore(day);
        return null;
      }
    },
    async sealDay(day) {
      try {
        const rows = await this.getAnchorRowsForDay(day);
        const prev = await this.latestRootBefore(day);
        const payloadJson = nearAiDayPayload(day, rows);
        const rootHash = nearAiDayRootHash(prev, day, rows);
        const existing = await this.getDaySeal(day);
        if (existing) {
          if (existing.rootHash !== rootHash) return { status: "conflict_frozen", day };
          return { status: "unchanged", day, rootHash };
        }
        await db.insert(nearaiDayRoots).values({
          day,
          rootHash,
          prevRoot: prev,
          entryCount: rows.length,
          payloadJson,
          sealedAt: sql`now()`,
        });
        void payloadJson;
        return { status: "sealed", day, rootHash, prevRoot: prev, entryCount: rows.length };
      } catch (e) {
        if (isMissingSchemaError(e)) return memory.sealDay(day);
        throw e;
      }
    },
  };
}

let testStore: NearAiStore | null = null;
const defaultMemory = new MemoryNearAiStore();

export function setNearAiStoreForTests(store: NearAiStore | null): void {
  testStore = store;
}

export function getNearAiStore(): NearAiStore {
  if (testStore) return testStore;
  const db = getDb();
  if (db) return pgStore(db);
  return defaultMemory;
}

export function getDefaultMemoryNearAiStore(): MemoryNearAiStore {
  return defaultMemory;
}

export async function sealNearAiDay(day: string): Promise<SealNearAiDayResult> {
  return getNearAiStore().sealDay(day);
}
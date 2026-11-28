// presign / check の cache miss 用: DB 往復の conn・問い合わせ・app を AsyncLocalStorage で束ねる（値は ms と本数のみ）。

import { AsyncLocalStorage } from "node:async_hooks";
import { takeDbClientInitMs } from "@/lib/db/client";

export type DbMissTimingPhase = "resolve" | "decide";

export type DbMissTimingSlice = {
  conn?: number;
  q?: number;
  qn?: number;
  app?: number;
  cold?: number;
};

type Scope = {
  phase: DbMissTimingPhase;
  conn: number;
  q: number;
  qn: number;
  connInitTaken: boolean;
};

const storage = new AsyncLocalStorage<Scope>();

export async function runDbMissTimingPhase<T>(
  phase: DbMissTimingPhase,
  fn: () => Promise<T>,
): Promise<{ value: T; slice: Pick<DbMissTimingSlice, "conn" | "q" | "qn"> }> {
  const scope: Scope = { phase, conn: 0, q: 0, qn: 0, connInitTaken: false };
  const value = await storage.run(scope, fn);
  return { value, slice: { conn: scope.conn, q: scope.q, qn: scope.qn } };
}

export function sliceWithApp(slice: Pick<DbMissTimingSlice, "conn" | "q" | "qn">, wallMs: number): DbMissTimingSlice {
  const conn = slice.conn ?? 0;
  const q = slice.q ?? 0;
  const qn = slice.qn ?? 0;
  return { conn, q, qn, app: Math.max(0, wallMs - conn - q) };
}

/** 1 回の db.execute（または同等）を計測する。スコープが無ければそのまま実行。 */
export async function timedDbExecute(fn: () => Promise<unknown>): Promise<unknown> {
  const scope = storage.getStore();
  if (!scope) return fn();
  if (!scope.connInitTaken) {
    scope.conn += takeDbClientInitMs();
    scope.connInitTaken = true;
  }
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    scope.q += performance.now() - t0;
    scope.qn += 1;
  }
}

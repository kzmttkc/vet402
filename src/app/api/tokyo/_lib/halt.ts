// ============================================================
// 審査員ボタンの停止スイッチ（W03）。正典は DB の1行 runtime_flags.tokyo_button_halt。
//
// decideHalt は src/lib/observatory/kill-switch.ts の写し（W01: 既存 lib は3本しか
// import しない）。同じ5入力で同じ答えを返すことを tests/tokyo-mutate.test.ts が
// 本家と突き合わせて固定する（本家を import するのはテストだけ）。
//
//   表が無い / 行が無い → 止めない（未導入は停止指示ではない）
//   行が enabled       → 止める
//   DB に届かない・例外 → 止める（読めないならガス代を守る側へ倒す）
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { HALT_FLAG } from "./constants";

export type HaltProbe =
  | { kind: "row"; enabled: boolean; reason: string | null }
  | { kind: "absent" }
  | { kind: "schema_missing" }
  | { kind: "unreachable"; detail: string };

export type HaltVerdict = { halted: boolean; reason: string; source: HaltProbe["kind"] };

const REASON_MAX = 300;
const clip = (text: string) => (text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text);

export function decideHalt(probe: HaltProbe): HaltVerdict {
  switch (probe.kind) {
    case "row":
      if (!probe.enabled) return { halted: false, reason: "flag_off", source: "row" };
      return {
        halted: true,
        reason: clip(`halted_by_operator: ${probe.reason?.trim() || "(no reason recorded)"}`),
        source: "row",
      };
    case "absent":
      return { halted: false, reason: "no_flag_row", source: "absent" };
    case "schema_missing":
      return { halted: false, reason: "flag_table_absent", source: "schema_missing" };
    case "unreachable":
      return { halted: true, reason: clip(`halt_flag_unreadable: ${probe.detail}`), source: "unreachable" };
  }
}

const UNDEFINED_COLUMN = "42703";
const UNDEFINED_TABLE = "42P01";

/** drizzle はドライバの例外を包むので、.cause を数段たどって SQLSTATE を見る（src/lib/db/pg-errors.ts と同じ手）。 */
export function isMissingSchemaError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code =
      typeof current === "object" && current !== null && "code" in current
        ? (current as { code?: unknown }).code
        : undefined;
    if (code === UNDEFINED_COLUMN || code === UNDEFINED_TABLE) return true;
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

/** DB を1回読んで probe を作る。DATABASE_URL が無いときは「読めない」＝止める側。 */
export async function probeTokyoHalt(): Promise<HaltProbe> {
  const db = getDb();
  if (!db) return { kind: "unreachable", detail: "DATABASE_URL is not configured" };
  try {
    const raw = await db.execute(sql`SELECT enabled, reason FROM runtime_flags WHERE name = ${HALT_FLAG}`);
    const row = rowsOf(raw)[0];
    if (!row) return { kind: "absent" };
    return {
      kind: "row",
      enabled: row.enabled === true || row.enabled === "t" || row.enabled === "true",
      reason: typeof row.reason === "string" ? row.reason : null,
    };
  } catch (error) {
    if (isMissingSchemaError(error)) return { kind: "schema_missing" };
    return { kind: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
}

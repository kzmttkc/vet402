// ============================================================
// 観測所の公開ルートを DB なしで通すための偽の DB（npm test 用。2026-11-11 3.8）。
//
// 製品の SQL を PgDialect で文字列にし、どの読みかを文で見分けて、試験が置いた「表の行」を返す。
// 返すのは表の中身だけで、根やハッシュは計算しない（計算は製品のコードと試験の書き下しがする）。
// 書き込み（INSERT と UPDATE）は writes に残し、表にも反映する。知らない文は投げて落とす。
// 本物の SQL の絞り込みは tests/*.pg.test.ts が Postgres で確かめる。
// ============================================================
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** canonicalDayPayload が選ぶ列（この順で返す）。 */
export type FakeL1Row = {
  id: string;
  endpoint_id: string;
  attempted_at: string;
  status: string;
  network: string;
  asset: string | null;
  pay_to: string | null;
  amount_units: string | null;
  spent_units: string | null;
  payer: string | null;
  tx_hash: string | null;
  http_status_paid: number | null;
  latency_ms: number | null;
  l2_schema: string | null;
};

export type FakeAnchorRow = {
  day: string;
  root_hash: string;
  prev_root: string | null;
  entry_count: number;
  anchored_tx: string | null;
};

export type FakeObservatoryTables = {
  l1: FakeL1Row[];
  ledger_anchors: FakeAnchorRow[];
  /** traceable-by-chain の SELECT が返す行（SQL の絞り込みの後の形）。 */
  traceableCandidates?: Record<string, unknown>[];
  /** ホームの最新 1 件の SELECT が返す行。無ければホームは null。 */
  homeLatest?: Record<string, unknown>[];
};

export type FakeObservatoryDb = {
  execute(query: unknown): Promise<unknown[]>;
  insert(table: unknown): unknown;
  tables: FakeObservatoryTables;
  writes: { sql: string; params: unknown[] }[];
  reads: string[];
};

const L1_COLUMNS: (keyof FakeL1Row)[] = [
  "id", "endpoint_id", "attempted_at", "status", "network", "asset", "pay_to", "amount_units",
  "spent_units", "payer", "tx_hash", "http_status_paid", "latency_ms", "l2_schema",
];

function dayParam(params: unknown[]): string {
  const d = params.find((p) => typeof p === "string" && DAY_RE.test(p));
  if (typeof d !== "string") throw new Error(`fake db: no day parameter in ${JSON.stringify(params)}`);
  return d;
}

const byDayDesc = (a: FakeAnchorRow, b: FakeAnchorRow) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0);

export function observatoryFakeDb(tables: FakeObservatoryTables): FakeObservatoryDb {
  const writes: { sql: string; params: unknown[] }[] = [];
  const reads: string[] = [];
  const anchors = () => [...tables.ledger_anchors].sort(byDayDesc);

  async function execute(query: unknown): Promise<unknown[]> {
    const { sql: raw, params } = dialect.sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]);
    const text = raw.replace(/\s+/g, " ").trim();
    reads.push(text);

    if (/FROM x402_l1_purchases pu WHERE pu\.attempted_at >= /.test(text) && /ORDER BY pu\.id ASC$/.test(text)) {
      const day = dayParam(params);
      return tables.l1
        .filter((r) => r.attempted_at.slice(0, 10) === day)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => Object.fromEntries(L1_COLUMNS.map((c) => [c, r[c]])));
    }
    if (/^SELECT day, root_hash, prev_root, entry_count, anchored_tx FROM ledger_anchors ORDER BY day DESC LIMIT/.test(text)) {
      const span = Number(params[params.length - 1]);
      return anchors().slice(0, span).map((r) => ({ ...r }));
    }
    if (/^SELECT day, root_hash, prev_root FROM ledger_anchors WHERE day = /.test(text)) {
      const day = dayParam(params);
      return anchors().filter((r) => r.day === day).map(({ day: d, root_hash, prev_root }) => ({ day: d, root_hash, prev_root }));
    }
    if (/^SELECT root_hash, anchored_tx FROM ledger_anchors WHERE day = /.test(text)) {
      const day = dayParam(params);
      return anchors().filter((r) => r.day === day).map(({ root_hash, anchored_tx }) => ({ root_hash, anchored_tx }));
    }
    if (/^SELECT day, prev_root FROM ledger_anchors WHERE day > .* ORDER BY day ASC LIMIT 1$/.test(text)) {
      const day = dayParam(params);
      const next = anchors().reverse().find((r) => r.day > day);
      return next ? [{ day: next.day, prev_root: next.prev_root }] : [];
    }
    if (/^SELECT 1 FROM ledger_anchors WHERE day > /.test(text)) {
      const day = dayParam(params);
      return anchors().some((r) => r.day > day) ? [{ "?column?": 1 }] : [];
    }
    if (/^SELECT root_hash FROM ledger_anchors WHERE day < .* ORDER BY day DESC LIMIT 1$/.test(text)) {
      const day = dayParam(params);
      const prev = anchors().find((r) => r.day < day);
      return prev ? [{ root_hash: prev.root_hash }] : [];
    }
    if (/^INSERT INTO ledger_anchors /.test(text)) {
      writes.push({ sql: text, params });
      const [day, root_hash, prev_root, entry_count] = params as [string, string, string | null, number];
      if (!tables.ledger_anchors.some((r) => r.day === day)) {
        tables.ledger_anchors.push({ day, root_hash, prev_root, entry_count: Number(entry_count), anchored_tx: null });
      }
      return [];
    }
    if (/^UPDATE ledger_anchors /.test(text)) {
      writes.push({ sql: text, params });
      const [root_hash, prev_root, entry_count, day] = params as [string, string | null, number, string];
      const row = tables.ledger_anchors.find((r) => r.day === day);
      if (row) Object.assign(row, { root_hash, prev_root, entry_count: Number(entry_count) });
      return [];
    }
    if (/row_number\(\) OVER/.test(text) && /FROM x402_l1_purchases pu JOIN x402_endpoints e/.test(text)) {
      return (tables.traceableCandidates ?? []).map((r) => ({ ...r }));
    }
    if (/AS window_rows/.test(text)) {
      const latest = tables.homeLatest ?? [];
      return [{ window_rows: latest.length, window_settled: latest.length, window_from: null, window_to: null }];
    }
    if (/AS l2_declared_schema/.test(text) && /LIMIT 8$/.test(text)) {
      return (tables.homeLatest ?? []).map((r) => ({ ...r }));
    }
    if (/^SELECT id::text AS id, resource_id, endpoint_hash/.test(text) && /FROM x402_endpoints WHERE id = /.test(text)) {
      return [];
    }
    throw new Error(`fake db: unhandled query: ${text.slice(0, 160)}`);
  }

  // consumeIpRateLimit の insert(...).values(...).onConflictDoUpdate(...).returning() は、枠を数えない（空の戻り = 通す）。
  const insert = () => ({
    values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }),
  });

  return { execute, insert, tables, writes, reads };
}

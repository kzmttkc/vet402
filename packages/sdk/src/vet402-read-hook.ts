/**
 * Read-only vet402 hook under a payment fetch wrapper. Does not sign or send funds.
 * When vet402 is unreachable, payment proceeds and the hook reports empty context.
 */

import type { StoredDecision } from "./pay-or-refuse.js";

const DEFAULT_STORE_PATH = ".vet402/decisions.jsonl";
const DEFAULT_OBSERVATORY_API = "https://vet402.com/api/v1";
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STORE_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

export type Vet402ReadStatus = "ok" | "none" | "timeout" | "unreachable" | "truncated";

export type Vet402ReadSnapshot = {
  deliveredRatePct: number | null;
  vet402Unreachable: boolean;
};

export type Vet402LocalRecord = {
  readonly at: string;
  readonly status: StoredDecision["status"];
  readonly recommendation: StoredDecision["recommendation"];
  readonly source: string;
  readonly resource: string;
};

export type Vet402ReadBeforePayResult = Vet402ReadSnapshot & { status?: Vet402ReadStatus };

export type Vet402ReadHookOptions = {
  readBeforePay?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Vet402ReadBeforePayResult>;
  /** Defaults to env VET402_API_URL or hosted production API. */
  observatoryApiBase?: string;
  /** JSONL path for local decision rows. Defaults to `.vet402/decisions.jsonl` (same as {@link DEFAULT_DECISION_STORE} on the package root export). */
  store?: string;
  /** When `false`, the hook does not read the local decision store. */
  readLocalRecords?: false;
  /** Max wait for `readBeforePay` and local store reads. Default 5000 ms. Values that are not positive or not finite use the default. */
  readTimeoutMs?: number;
  /** Max bytes read from the local JSONL store (tail slice when larger). Default 1 MiB. Non-positive or non-finite values use the default. */
  maxStoreBytes?: number;
  /** Max observatory response body bytes. Default 65536. Non-positive or non-finite values use the default. */
  maxResponseBytes?: number;
};

const lastSnapshotByFetch = new WeakMap<typeof fetch, Vet402ReadSnapshot>();
const lastSnapshotStatusByFetch = new WeakMap<typeof fetch, Vet402ReadStatus>();
const lastLocalRecordsByFetch = new WeakMap<typeof fetch, Vet402LocalRecord[] | undefined>();
const lastLocalStatusByFetch = new WeakMap<typeof fetch, Vet402ReadStatus | undefined>();

export function getVet402ReadSnapshot(fetchFn: typeof fetch): Vet402ReadSnapshot | undefined {
  return lastSnapshotByFetch.get(fetchFn);
}

export function getVet402LocalRecords(fetchFn: typeof fetch): Vet402LocalRecord[] | undefined {
  return lastLocalRecordsByFetch.get(fetchFn);
}

export function getVet402ReadResult(
  fetchFn: typeof fetch,
):
  | {
      snapshot: Vet402ReadSnapshot;
      snapshotStatus: Vet402ReadStatus;
      local: { status: Vet402ReadStatus; records: Vet402LocalRecord[] } | undefined;
    }
  | undefined {
  const snapshot = lastSnapshotByFetch.get(fetchFn);
  if (snapshot === undefined) return undefined;
  const snapshotStatus = lastSnapshotStatusByFetch.get(fetchFn) ?? "unreachable";
  const records = lastLocalRecordsByFetch.get(fetchFn);
  if (records === undefined) {
    return { snapshot, snapshotStatus, local: undefined };
  }
  const localStatus = lastLocalStatusByFetch.get(fetchFn) ?? "unreachable";
  return { snapshot, snapshotStatus, local: { status: localStatus, records } };
}

function resolvePositiveFinite(ms: number | undefined, fallback: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return fallback;
  return ms;
}

function resolveReadTimeoutMs(ms: number | undefined): number {
  return resolvePositiveFinite(ms, DEFAULT_READ_TIMEOUT_MS);
}

function resolveMaxStoreBytes(n: number | undefined): number {
  return resolvePositiveFinite(n, DEFAULT_MAX_STORE_BYTES);
}

function resolveMaxResponseBytes(n: number | undefined): number {
  return resolvePositiveFinite(n, DEFAULT_MAX_RESPONSE_BYTES);
}

const UNREACHABLE_SNAPSHOT: Readonly<Vet402ReadSnapshot> = Object.freeze({
  deliveredRatePct: null,
  vet402Unreachable: true,
});

const TIMEOUT_SNAPSHOT: Readonly<Vet402ReadSnapshot> = Object.freeze({
  deliveredRatePct: null,
  vet402Unreachable: true,
});

function snapshotFromRate(
  deliveredRatePct: number | null,
  vet402Unreachable: boolean,
): Vet402ReadSnapshot {
  return { deliveredRatePct, vet402Unreachable };
}

function stripStatusFromReadResult(result: Vet402ReadBeforePayResult): {
  snapshot: Vet402ReadSnapshot;
  status?: Vet402ReadStatus;
} {
  const { status, deliveredRatePct, vet402Unreachable } = result;
  return { snapshot: { deliveredRatePct, vet402Unreachable }, status };
}

function inferReadBeforePayStatus(snapshot: Vet402ReadSnapshot): Vet402ReadStatus {
  if (snapshot.vet402Unreachable) return "unreachable";
  if (snapshot.deliveredRatePct === null) return "none";
  return "ok";
}

async function withReadTimeout<T>(
  task: () => Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([task(), timeoutResult]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requestResourceUrl(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return typeof input?.url === "string" ? input.url : "";
  } catch {
    return "";
  }
}

function toLocalRecord(row: StoredDecision): Vet402LocalRecord {
  return {
    at: row.at,
    status: row.status,
    recommendation: row.recommendation,
    source: row.source,
    resource: row.resource,
  };
}

const LOCAL_STORE_LINE_CHUNK = 200;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

type LocalReadOutcome = { status: Vet402ReadStatus; records: Vet402LocalRecord[] };

function parseMatchingLines(
  text: string,
  resource: string,
  deadlineAt: number,
  truncated: boolean,
): Promise<LocalReadOutcome> {
  return (async () => {
    const rows: Vet402LocalRecord[] = [];
    const lines = text.split("\n");
    for (let offset = 0; offset < lines.length; offset += LOCAL_STORE_LINE_CHUNK) {
      if (Date.now() > deadlineAt) return { status: "timeout" as const, records: [] };
      const end = Math.min(offset + LOCAL_STORE_LINE_CHUNK, lines.length);
      for (let i = offset; i < end; i++) {
        if (Date.now() > deadlineAt) return { status: "timeout" as const, records: [] };
        const trimmed = lines[i].trim();
        if (trimmed === "") continue;
        try {
          const row = JSON.parse(trimmed) as StoredDecision;
          if (row && typeof row.resource === "string" && row.resource === resource) {
            rows.push(toLocalRecord(row));
          }
        } catch {
          continue;
        }
      }
      if (end < lines.length) {
        await yieldToEventLoop();
        if (Date.now() > deadlineAt) return { status: "timeout" as const, records: [] };
      }
    }
    if (truncated) return { status: "truncated" as const, records: rows };
    if (rows.length === 0) return { status: "none" as const, records: [] };
    return { status: "ok" as const, records: rows };
  })();
}

async function readLocalRecordsForResource(
  storePath: string,
  resource: string,
  deadlineAt: number,
  maxStoreBytes: number,
): Promise<LocalReadOutcome> {
  const { stat, open } = await import("node:fs/promises");
  let st;
  try {
    st = await stat(storePath);
  } catch {
    return { status: "unreachable", records: [] };
  }
  if (Date.now() > deadlineAt) return { status: "timeout", records: [] };

  let text: string;
  let truncated = false;
  if (st.size > maxStoreBytes) {
    truncated = true;
    const handle = await open(storePath, "r");
    try {
      const start = Math.max(0, st.size - maxStoreBytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      text = buf.toString("utf8");
      const firstNewline = text.indexOf("\n");
      if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    } finally {
      await handle.close();
    }
  } else {
    // Read at most the size seen by stat, so a file that grows after stat still stays under the cap.
    try {
      const handle = await open(storePath, "r");
      try {
        const buf = Buffer.alloc(st.size);
        const { bytesRead } = await handle.read(buf, 0, st.size, 0);
        text = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return { status: "unreachable", records: [] };
    }
  }
  if (Date.now() > deadlineAt) return { status: "timeout", records: [] };
  return parseMatchingLines(text, resource, deadlineAt, truncated);
}

function parseObservatoryBody(body: string): { snapshot: Vet402ReadSnapshot; status: Vet402ReadStatus } {
  let parsed: {
    l1?: { attempts?: number; delivered?: number };
    deliveredOfAttemptsPct?: number | null;
  };
  try {
    parsed = JSON.parse(body) as {
      l1?: { attempts?: number; delivered?: number };
      deliveredOfAttemptsPct?: number | null;
    };
  } catch {
    return { snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" };
  }
  const fromField = parsed.deliveredOfAttemptsPct;
  if (typeof fromField === "number" && Number.isFinite(fromField)) {
    return {
      snapshot: snapshotFromRate(fromField, false),
      status: "ok",
    };
  }
  const attempts = parsed.l1?.attempts ?? 0;
  const delivered = parsed.l1?.delivered ?? 0;
  if (attempts <= 0) {
    return { snapshot: snapshotFromRate(null, false), status: "none" };
  }
  const pct = Math.round((delivered / attempts) * 1000) / 10;
  return { snapshot: snapshotFromRate(pct, false), status: "ok" };
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

/** Default observatory read uses Node http/https only (not global or wrapped fetch). In non-Node runtimes pass `readBeforePay`. */
async function defaultReadObservatoryState(
  apiBase: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ snapshot: Vet402ReadSnapshot; status: Vet402ReadStatus }> {
  if (!isNodeRuntime()) {
    return { snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" };
  }

  const targetUrl = `${apiBase.replace(/\/$/, "")}/observatory/state`;

  return withReadTimeout(
    () => nodeObservatoryGet(targetUrl, timeoutMs, maxResponseBytes),
    timeoutMs,
    () => ({ snapshot: TIMEOUT_SNAPSHOT, status: "timeout" as const }),
  );
}

function nodeObservatoryGet(
  targetUrl: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ snapshot: Vet402ReadSnapshot; status: Vet402ReadStatus }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: import("node:http").ClientRequest | undefined;

    const finish = (out: { snapshot: Vet402ReadSnapshot; status: Vet402ReadStatus }) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(out);
    };

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      finish({ snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" });
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const isHttp = parsed.protocol === "http:";
    if (!isHttps && !isHttp) {
      finish({ snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" });
      return;
    }

    const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
    const path = `${parsed.pathname}${parsed.search}`;

    timer = setTimeout(() => {
      req?.destroy();
      finish({ snapshot: TIMEOUT_SNAPSHOT, status: "timeout" });
    }, timeoutMs);

    const importMod = isHttps ? import("node:https") : import("node:http");

    importMod
      .then((mod) => {
        req = mod.request(
          {
            hostname: parsed.hostname,
            port,
            path,
            method: "GET",
            headers: { Accept: "application/json" },
          },
          (res) => {
            const code = res.statusCode ?? 0;
            if (code < 200 || code >= 300) {
              res.resume();
              finish({ snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" });
              return;
            }

            const chunks: Buffer[] = [];
            let total = 0;
            let bodyTruncated = false;

            res.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (bodyTruncated) return;
              if (total > maxResponseBytes) {
                bodyTruncated = true;
                req?.destroy();
                res.destroy();
                finish({
                  snapshot: { deliveredRatePct: null, vet402Unreachable: true },
                  status: "truncated",
                });
                return;
              }
              chunks.push(chunk);
            });

            res.on("end", () => {
              if (bodyTruncated || settled) return;
              const body = Buffer.concat(chunks).toString("utf8");
              finish(parseObservatoryBody(body));
            });

            res.on("error", () => {
              if (!settled) finish({ snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" });
            });
          },
        );

        req.on("error", () => {
          if (!settled) finish({ snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" });
        });

        req.end();
      })
      .catch(() => {
        finish({ snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" });
      });
  });
}

export function createVet402ReadHook(options: Vet402ReadHookOptions = {}): (fetchImpl: typeof fetch) => typeof fetch {
  const envBase = typeof process !== "undefined" ? process.env?.VET402_API_URL : undefined;
  const apiBase = options.observatoryApiBase ?? envBase ?? DEFAULT_OBSERVATORY_API;
  const readTimeoutMs = resolveReadTimeoutMs(options.readTimeoutMs);
  const maxStoreBytes = resolveMaxStoreBytes(options.maxStoreBytes);
  const maxResponseBytes = resolveMaxResponseBytes(options.maxResponseBytes);

  const defaultReadBeforePay = async (): Promise<Vet402ReadBeforePayResult> => {
    const { snapshot, status } = await defaultReadObservatoryState(apiBase, readTimeoutMs, maxResponseBytes);
    return { ...snapshot, status };
  };

  const readBeforePay = options.readBeforePay ?? defaultReadBeforePay;
  const storePath = options.store ?? DEFAULT_STORE_PATH;
  const readLocal = options.readLocalRecords !== false;

  return (fetchImpl: typeof fetch) => {
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const resource = requestResourceUrl(input);
      let snapshot: Vet402ReadSnapshot = UNREACHABLE_SNAPSHOT;
      let snapshotStatus: Vet402ReadStatus = "unreachable";
      let localRecords: Vet402LocalRecord[] | undefined = readLocal ? [] : undefined;
      let localStatus: Vet402ReadStatus | undefined = readLocal ? "none" : undefined;

      const snapshotTask = withReadTimeout(
        async (): Promise<{ snapshot: Vet402ReadSnapshot; status: Vet402ReadStatus }> => {
          try {
            const raw = await readBeforePay(input, init);
            const { snapshot: snap, status } = stripStatusFromReadResult(raw);
            const st = status ?? inferReadBeforePayStatus(snap);
            return { snapshot: snap, status: st };
          } catch {
            return { snapshot: UNREACHABLE_SNAPSHOT, status: "unreachable" };
          }
        },
        readTimeoutMs,
        () => ({ snapshot: TIMEOUT_SNAPSHOT, status: "timeout" as const }),
      );

      const localDeadlineAt = Date.now() + readTimeoutMs;
      const localTask = readLocal
        ? withReadTimeout(
            () =>
              readLocalRecordsForResource(storePath, resource, localDeadlineAt, maxStoreBytes).catch(
                (): LocalReadOutcome => ({ status: "unreachable", records: [] }),
              ),
            readTimeoutMs,
            (): LocalReadOutcome => ({ status: "timeout", records: [] }),
          )
        : Promise.resolve(undefined);

      const [snapshotResult, localResult] = await Promise.all([snapshotTask, localTask]);
      snapshot = snapshotResult.snapshot;
      snapshotStatus = snapshotResult.status;
      if (readLocal && localResult) {
        localRecords = localResult.records;
        localStatus = localResult.status;
      }

      lastSnapshotByFetch.set(wrapped, snapshot);
      lastSnapshotStatusByFetch.set(wrapped, snapshotStatus);
      lastLocalRecordsByFetch.set(wrapped, localRecords);
      lastLocalStatusByFetch.set(wrapped, localStatus);
      return fetchImpl(input, init);
    };
    return wrapped;
  };
}

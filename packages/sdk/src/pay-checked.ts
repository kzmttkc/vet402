/**
 * Resolve a resource, read vet402's payer decision, and pay with `payOrRefuse`
 * only when the caller's own spend rules allow it. The rules see the payments
 * this process has already recorded in the local decision store — the same
 * JSONL file `appendDecision` writes — including a pending line written before
 * the signature. vet402 does not hold the limit.
 *
 * Calls on one store are exclusive from the read through that pending write:
 * an in-process queue, plus a `<store>.lock` file taken with `openSync(path, "wx")`.
 * The payment runs after the lock is released. The pending line is then replaced
 * by one settled or failed line, so a finished call stays a single row and the
 * pending spend is not counted twice.
 *
 * `payOrRefuse` is called as it stands. This file does not sign anything itself
 * and does not touch `account` / `svm` until that call.
 */
import { appendDecision, DEFAULT_DECISION_STORE, payOrRefuse } from "./pay-or-refuse.js";
import type { PayerAccount, PayReceipt, SvmPayOptions } from "./pay-or-refuse.js";
import { clientIdentityHeaders } from "./user-agent.js";
import {
  evaluateSpendRules,
  SPEND_RULE_REFUSALS,
  type SpendIntent,
  type SpendRecord,
  type SpendRuleRefusal,
  type SpendRules,
} from "./spend-rules.js";

const DEFAULT_ORIGIN = "https://vet402.com";
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SVM_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type PayCheckedInput = {
  /** Resource URL. Also the `q` sent to `GET /api/v1/resolve`. */
  url: string;
  /** Local limits. See {@link evaluateSpendRules}. */
  rules: SpendRules;
  /**
   * What this payment is supposed to cost, in USD. The same number is checked
   * against the rules and handed to `payOrRefuse` as `amountUsd`.
   */
  amountUsd: number;
  /** JSONL path. Default {@link DEFAULT_DECISION_STORE}. */
  store?: string;
  /** Fetch implementation. Default is the global `fetch`. Passed through to `payOrRefuse`. */
  fetch?: typeof fetch;
  /**
   * API origin, default `https://vet402.com`. A value that already ends in
   * `/api/v1` is used as the API root.
   */
  baseUrl?: string;
  /**
   * When set, a later call with the same key, URL, amount and rules returns the
   * settled or failed result and does not pay again. A key that still has only
   * a pending line refuses with `payment_pending` and does not pay. A reused
   * key with a different payment throws `idempotency_mismatch` and does not pay.
   */
  idempotencyKey?: string;
} & ({ account: PayerAccount; svm?: undefined } | { svm: SvmPayOptions; account?: undefined });

/** Why `payChecked` did not pay, when the reason is not a spend rule. */
export type PayCheckedStop = "store_unreadable" | "payment_pending" | "payee_unknown";

export type PayCheckedResult = {
  /** True only when `payOrRefuse` returned `status: "paid"`. */
  paid: boolean;
  /**
   * True when the seller's paid response (the re-send that carried the payment
   * header) is 2xx other than 202 and its body is not empty.
   */
  delivered: boolean;
  /** The spend rule or store stop that blocked the payment, or null when it proceeded. */
  refusedBy: SpendRuleRefusal | PayCheckedStop | null;
  /** `payOrRefuse`'s receipt, or null when the payment did not happen. */
  receipt: PayReceipt | null;
  /** First evidence URL on the payer decision, or null when the decision had none. */
  evidenceUrl: string | null;
  /**
   * Set when the payment was already attempted and the settled or failed line
   * could not be written. The pending line stays in the store and still counts.
   */
  recordError?: string;
};

type SavedSpend = {
  payTo: string;
  host: string;
  resourceId: string;
  amountUsd: number;
  at: number;
};

type CheckedState = "pending" | "settled" | "failed";

type SavedChecked = {
  state?: CheckedState;
  /** Matches the pending row to the settled or failed row that replaces it. */
  pendingId?: string;
  idempotencyKey?: string | null;
  rulesJson?: string;
  amountUsd?: number;
  url?: string;
  /** Copied beside `spend` so a pending row carries the payee on its own. */
  payTo?: string;
  /** Unix milliseconds. Copied beside `spend` for the same reason. */
  at?: number;
  /** Present when this row counts as a spend. A refusal leaves it null. */
  spend?: SavedSpend | null;
  result?: PayCheckedResult | null;
};

type SavedLine = { payChecked?: SavedChecked };

function apiRoot(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? DEFAULT_ORIGIN).replace(/\/$/, "");
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPayee(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tail = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  return EVM_ADDRESS.test(tail) || SVM_ADDRESS.test(tail) ? tail : null;
}

function resourceIdOf(body: unknown): string | null {
  if (!isPlain(body) || !isPlain(body.resource)) return null;
  const id = body.resource.resource_id;
  return typeof id === "string" && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

function payeeOf(decision: unknown, resolved: unknown): string | null {
  if (isPlain(decision) && isPlain(decision.facts) && Array.isArray(decision.facts.payees)) {
    for (const candidate of decision.facts.payees) {
      const payee = asPayee(candidate);
      if (payee) return payee;
    }
  }
  if (isPlain(resolved) && isPlain(resolved.resource)) return asPayee(resolved.resource.payee_id);
  return null;
}

function evidenceUrlOf(decision: unknown): string | null {
  if (!isPlain(decision) || !Array.isArray(decision.evidence)) return null;
  for (const row of decision.evidence) {
    if (isPlain(row) && typeof row.url === "string" && row.url.length > 0) return row.url;
  }
  return null;
}

/**
 * Delivery rate over conclusive attempts (`n_attempts − n_inconclusive`).
 * Inconclusive attempts are not the seller's misses. No usable counts → null,
 * which fails a written floor.
 */
function deliveryRateOf(decision: unknown): number | null {
  if (!isPlain(decision) || !isPlain(decision.facts) || !isPlain(decision.facts.l1)) return null;
  const l1 = decision.facts.l1;
  const delivered = l1.n_delivered;
  const attempts = l1.n_attempts;
  if (typeof delivered !== "number" || typeof attempts !== "number") return null;
  if (!Number.isFinite(delivered) || !Number.isFinite(attempts) || delivered < 0 || attempts < 0) return null;
  const rawInconclusive = l1.n_inconclusive;
  const inconclusive =
    typeof rawInconclusive === "number" && Number.isFinite(rawInconclusive) && rawInconclusive >= 0
      ? rawInconclusive
      : 0;
  const conclusive = attempts - inconclusive;
  if (!(conclusive > 0)) return null;
  return delivered / conclusive;
}

function intentFromDecision(decision: unknown, payTo: string, host: string, resourceId: string, amountUsd: number): SpendIntent {
  const degraded = isPlain(decision) && decision.degraded === true;
  const recommendationRaw = isPlain(decision) ? decision.recommendation : null;
  const recommendation =
    !degraded && (recommendationRaw === "ALLOW" || recommendationRaw === "WARN" || recommendationRaw === "BLOCK")
      ? recommendationRaw
      : null;
  return {
    payTo,
    host,
    resourceId,
    amountUsd,
    recommendation,
    deliveryRate: degraded ? null : deliveryRateOf(decision),
  };
}

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}

/** The paid re-send is the request that carries the x402 payment header. The 402 probe does not. */
function isPaidResend(init: RequestInit | undefined): boolean {
  const headers = headerMap(init?.headers);
  return typeof headers["payment-signature"] === "string" || typeof headers["x-payment"] === "string";
}

async function readBody(response: { clone?: () => { text?: () => Promise<string>; json?: () => Promise<unknown> }; text?: () => Promise<string>; json?: () => Promise<unknown> }): Promise<unknown> {
  const source = typeof response.clone === "function" ? response.clone() : response;
  if (typeof source.text === "function") {
    try {
      const text = await source.text();
      if (text.trim() === "") return "";
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    } catch {
      return "";
    }
  }
  if (typeof source.json === "function") {
    try {
      return await source.json();
    } catch {
      return "";
    }
  }
  return "";
}

/** 2xx, but not 202, and the body is not empty. */
function isDelivered(status: number, body: unknown): boolean {
  if (!Number.isInteger(status) || status < 200 || status >= 300 || status === 202) return false;
  if (body == null) return false;
  if (typeof body === "string") return body.trim() !== "";
  return true;
}

async function readJson(response: { json?: () => Promise<unknown> }): Promise<unknown> {
  if (typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const PAY_CHECKED_STOPS: readonly PayCheckedStop[] = ["store_unreadable", "payment_pending", "payee_unknown"];
const LOCK_LIMIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 20;

class StoreLockError extends Error {
  constructor(message = "store_unreadable") {
    super(message);
    this.name = "StoreLockError";
  }
}

type LockHeld = { fd: number; path: string; token: string };
type NodeFs = typeof import("node:fs");

const storeTails = new Map<string, Promise<unknown>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const text = String(error);
  return text === "" ? "store_unreadable" : text;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isPayCheckedRefusal(value: unknown): value is SpendRuleRefusal | PayCheckedStop {
  if (typeof value !== "string") return false;
  return (SPEND_RULE_REFUSALS as readonly string[]).includes(value) || (PAY_CHECKED_STOPS as readonly string[]).includes(value);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/** A lock whose pid is gone, or whose timestamp is older than 60 seconds, may be removed. */
function lockIsStale(lockPath: string, fs: NodeFs): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  let pid = Number.NaN;
  let at = Number.NaN;
  try {
    const row = JSON.parse(raw) as { pid?: unknown; at?: unknown };
    if (typeof row.pid === "number") pid = row.pid;
    if (typeof row.at === "number") at = row.at;
  } catch {
    pid = Number.NaN;
    at = Number.NaN;
  }
  // An empty or half-written lock has no pid yet. Leave a fresh one alone.
  if (!Number.isFinite(pid) || !Number.isFinite(at)) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  if (Date.now() - at > LOCK_STALE_MS) return true;
  return !pidAlive(pid);
}

function createLock(fs: NodeFs, lockPath: string): { ok: true; held: LockHeld } | { ok: false; fatal: boolean; message: string } {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return { ok: false, fatal: false, message: "" };
    return { ok: false, fatal: true, message: errorText(error) };
  }
  try {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    try {
      fs.fsyncSync(fd);
    } catch {
      // The exclusive file is the lock. A missing fsync still leaves the pid readable.
    }
    return { ok: true, held: { fd, path: lockPath, token } };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // The fd is already unusable.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // The next acquire treats a leftover lock with no live pid as stale.
    }
    return { ok: false, fatal: true, message: errorText(error) };
  }
}

async function acquireStoreLock(store: string): Promise<LockHeld> {
  const fs = await import("node:fs");
  const lockPath = `${store}.lock`;
  const started = Date.now();
  for (;;) {
    const created = createLock(fs, lockPath);
    if (created.ok) return created.held;
    if (created.fatal) throw new StoreLockError(created.message);
    if (lockIsStale(lockPath, fs)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another caller removed it, or replaced it. Try again.
      }
    }
    if (Date.now() - started >= LOCK_LIMIT_MS) throw new StoreLockError("store_unreadable");
    const remaining = LOCK_LIMIT_MS - (Date.now() - started);
    await sleep(Math.max(1, Math.min(LOCK_RETRY_MS, remaining)));
  }
}

function releaseStoreLock(held: LockHeld, fs: NodeFs): void {
  try {
    fs.closeSync(held.fd);
  } catch {
    // Already closed.
  }
  try {
    const row = JSON.parse(fs.readFileSync(held.path, "utf8")) as { token?: unknown };
    if (row.token === held.token) fs.unlinkSync(held.path);
  } catch {
    // Already removed, or a newer lock owns the path.
  }
}

/** Same-process calls share a promise chain. Other processes share the lock file. */
function withStoreLock<T>(store: string, task: () => Promise<T>): Promise<T> {
  const prev = storeTails.get(store) ?? Promise.resolve();
  const run = prev.then(() => withFileLock(store, task), () => withFileLock(store, task));
  storeTails.set(
    store,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function withFileLock<T>(store: string, task: () => Promise<T>): Promise<T> {
  const held = await acquireStoreLock(store);
  const fs = await import("node:fs");
  try {
    return await task();
  } finally {
    releaseStoreLock(held, fs);
  }
}

type StoreRead = { ok: true; lines: SavedLine[] } | { ok: false };

/**
 * A missing file is an empty history. Any other read error, a line that is not
 * JSON, or a payChecked spend with a bad payTo / amountUsd / at stops the call.
 * Lines from other sources are skipped.
 */
async function readStore(store: string): Promise<StoreRead> {
  const { readFile, stat } = await import("node:fs/promises");
  try {
    const info = await stat(store);
    if (info.isDirectory()) return { ok: false };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { ok: true, lines: [] };
    return { ok: false };
  }
  let text: string;
  try {
    text = await readFile(store, "utf8");
  } catch {
    return { ok: false };
  }
  const lines: SavedLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      return { ok: false };
    }
    if (!isPlain(row)) continue;
    if (row.payChecked != null && (!isPlain(row.payChecked) || spendShapeBroken(row.payChecked))) {
      return { ok: false };
    }
    lines.push(row as SavedLine);
  }
  return { ok: true, lines };
}

function spendShapeBroken(payChecked: Record<string, unknown>): boolean {
  if (!("spend" in payChecked) || payChecked.spend == null) return false;
  const spend = payChecked.spend;
  if (!isPlain(spend)) return true;
  if (typeof spend.payTo !== "string") return true;
  if (typeof spend.amountUsd !== "number" || !Number.isFinite(spend.amountUsd)) return true;
  if (typeof spend.at !== "number") return true;
  return false;
}

function resultOf(value: unknown): PayCheckedResult | null {
  if (!isPlain(value) || typeof value.paid !== "boolean" || typeof value.delivered !== "boolean") return null;
  if (!(value.refusedBy === null || isPayCheckedRefusal(value.refusedBy))) return null;
  if (!(value.evidenceUrl === null || typeof value.evidenceUrl === "string")) return null;
  if (!(value.receipt === null || isPlain(value.receipt))) return null;
  const result: PayCheckedResult = {
    paid: value.paid,
    delivered: value.delivered,
    refusedBy: value.refusedBy,
    receipt: value.receipt as PayReceipt | null,
    evidenceUrl: value.evidenceUrl,
  };
  if (typeof value.recordError === "string" && value.recordError !== "") result.recordError = value.recordError;
  return result;
}

function historyOf(lines: SavedLine[]): SpendRecord[] {
  const closedIds = new Set<string>();
  const closedKeys = new Set<string>();
  for (const line of lines) {
    const saved = line.payChecked;
    if (!saved || saved.state === "pending") continue;
    if (typeof saved.pendingId === "string") closedIds.add(saved.pendingId);
    if (typeof saved.idempotencyKey === "string" && saved.idempotencyKey.length > 0) closedKeys.add(saved.idempotencyKey);
  }
  const history: SpendRecord[] = [];
  for (const line of lines) {
    const saved = line.payChecked;
    const spend = saved?.spend;
    if (!spend) continue;
    if (typeof spend.payTo !== "string") continue;
    if (typeof spend.amountUsd !== "number" || !Number.isFinite(spend.amountUsd)) continue;
    if (typeof spend.at !== "number") continue;
    if (saved?.state === "pending") {
      if (typeof saved.pendingId === "string" && closedIds.has(saved.pendingId)) continue;
      if (typeof saved.idempotencyKey === "string" && saved.idempotencyKey.length > 0 && closedKeys.has(saved.idempotencyKey)) {
        continue;
      }
    }
    history.push({
      payTo: spend.payTo,
      host: typeof spend.host === "string" ? spend.host : "",
      resourceId: typeof spend.resourceId === "string" ? spend.resourceId : "",
      amountUsd: spend.amountUsd,
      at: spend.at,
    });
  }
  return history;
}

type IdempotencyHit =
  | { kind: "none" }
  | { kind: "replay"; result: PayCheckedResult }
  | { kind: "pending" };

/**
 * A settled or failed row for this key is returned as-is. A pending row with
 * no settled or failed row refuses. A different payment under the same key throws.
 */
function idempotencyHit(lines: SavedLine[], key: string, url: string, amountUsd: number, rulesJson: string): IdempotencyHit {
  let replay: PayCheckedResult | null = null;
  let pending = false;
  for (const line of lines) {
    const saved = line.payChecked;
    if (!saved || saved.idempotencyKey !== key) continue;
    if (saved.url !== url || saved.amountUsd !== amountUsd || saved.rulesJson !== rulesJson) {
      throw new Error(
        "idempotency_mismatch: this idempotencyKey was already used for a different url, amount or rules",
      );
    }
    if (saved.state === "pending") {
      pending = true;
      continue;
    }
    const result = resultOf(saved.result);
    if (result) replay = result;
  }
  if (replay) return { kind: "replay", result: replay };
  if (pending) return { kind: "pending" };
  return { kind: "none" };
}

function unpaid(refusedBy: PayCheckedResult["refusedBy"], evidenceUrl: string | null): PayCheckedResult {
  return { paid: false, delivered: false, refusedBy, receipt: null, evidenceUrl };
}

type DecisionRow = Parameters<typeof appendDecision>[0];

function decisionRow(input: {
  recommendation: "ALLOW" | "REFUSE";
  reasonCodes: string[];
  atMs: number;
  status: "paid" | "refused" | "failed";
  url: string;
  txHash: string | null;
  nonce: string | null;
  checked: SavedChecked;
}): DecisionRow {
  return {
    recommendation: input.recommendation,
    reason_codes: input.reasonCodes,
    verdict_source: "local_policy",
    evidence: [],
    decision: null,
    payeeScore: null,
    policy_override: null,
    source: "pay-checked",
    at: new Date(input.atMs).toISOString(),
    status: input.status,
    resource: input.url,
    txHash: input.txHash,
    nonce: input.nonce,
    payChecked: input.checked,
  } as DecisionRow;
}

async function appendRow(store: string, row: DecisionRow): Promise<void> {
  await appendDecision(row, { store });
}

/** Swap the pending row for the final one. A direct write, so a read-only file fails. */
async function replacePending(store: string, pendingId: string, line: string): Promise<void> {
  const { readFile, writeFile, appendFile } = await import("node:fs/promises");
  const text = await readFile(store, "utf8");
  let found = false;
  const parts = text.split("\n").map((part) => {
    if (found || part.trim() === "") return part;
    try {
      const row = JSON.parse(part) as { payChecked?: { pendingId?: string } };
      if (row?.payChecked?.pendingId === pendingId) {
        found = true;
        return line;
      }
    } catch {
      return part;
    }
    return part;
  });
  if (!found) {
    await appendFile(store, `${line}\n`, "utf8");
    return;
  }
  let body = parts.join("\n");
  if (!body.endsWith("\n")) body += "\n";
  await writeFile(store, body, "utf8");
}

type Payer = { kind: "account"; account: PayerAccount } | { kind: "svm"; svm: SvmPayOptions };

function payerOf(input: PayCheckedInput): Payer {
  if (input.svm !== undefined && input.account === undefined) return { kind: "svm", svm: input.svm };
  if (input.account !== undefined && input.svm === undefined) return { kind: "account", account: input.account };
  throw new Error("invalid_payer: pass account (Base, EIP-3009) or svm (Solana), and only one of them");
}

type RemoteRead = { resolved: unknown; decision: unknown; resourceId: string | null };

async function loadRemote(input: PayCheckedInput, fetchImpl: typeof fetch, key: string | null): Promise<RemoteRead> {
  const root = apiRoot(input.baseUrl);
  const apiHeaders: Record<string, string> = { accept: "application/json", ...clientIdentityHeaders() };
  if (key) apiHeaders["Idempotency-Key"] = key;

  let resolved: unknown = null;
  try {
    const response = await fetchImpl(`${root}/resolve?q=${encodeURIComponent(input.url)}`, { headers: apiHeaders });
    const body = await readJson(response);
    if (response.ok) resolved = body;
  } catch {
    resolved = null;
  }
  const resourceId = resourceIdOf(resolved);

  let decision: unknown = null;
  if (resourceId) {
    try {
      const response = await fetchImpl(`${root}/resources/${resourceId}/decision?role=payer`, { headers: apiHeaders });
      const body = await readJson(response);
      if (response.ok && isPlain(body)) decision = body;
    } catch {
      decision = null;
    }
  }
  return { resolved, decision, resourceId };
}

type Prepared =
  | { kind: "result"; result: PayCheckedResult }
  | { kind: "pay"; pendingId: string; spentAt: number; payTo: string; resourceId: string };

async function prepare(input: {
  store: string;
  rules: PayCheckedInput["rules"];
  rulesJson: string;
  key: string | null;
  url: string;
  host: string;
  amountUsd: number;
  evidenceUrl: string | null;
  payTo: string | null;
  resourceId: string | null;
  decision: unknown;
}): Promise<Prepared> {
  const read = await readStore(input.store);
  if (!read.ok) return { kind: "result", result: unpaid("store_unreadable", input.evidenceUrl) };

  if (input.key) {
    const hit = idempotencyHit(read.lines, input.key, input.url, input.amountUsd, input.rulesJson);
    if (hit.kind === "replay") return { kind: "result", result: hit.result };
    if (hit.kind === "pending") return { kind: "result", result: unpaid("payment_pending", input.evidenceUrl) };
  }

  const spentAt = Date.now();
  const resourceId = input.resourceId ?? "";
  const verdict = evaluateSpendRules(
    input.rules,
    intentFromDecision(input.decision, input.payTo ?? "", input.host, resourceId, input.amountUsd),
    historyOf(read.lines),
    spentAt,
  );
  if (!verdict.allow) {
    const result = unpaid(verdict.refusedBy, input.evidenceUrl);
    await appendRow(
      input.store,
      decisionRow({
        recommendation: "REFUSE",
        reasonCodes: result.refusedBy ? [result.refusedBy] : [],
        atMs: spentAt,
        status: "refused",
        url: input.url,
        txHash: null,
        nonce: null,
        checked: {
          state: "failed",
          idempotencyKey: input.key,
          rulesJson: input.rulesJson,
          amountUsd: input.amountUsd,
          url: input.url,
          spend: null,
          result,
        },
      }),
    );
    return { kind: "result", result };
  }
  if (!input.payTo) {
    const result = unpaid("payee_unknown", input.evidenceUrl);
    await appendRow(
      input.store,
      decisionRow({
        recommendation: "REFUSE",
        reasonCodes: ["payee_unknown"],
        atMs: spentAt,
        status: "refused",
        url: input.url,
        txHash: null,
        nonce: null,
        checked: {
          state: "failed",
          idempotencyKey: input.key,
          rulesJson: input.rulesJson,
          amountUsd: input.amountUsd,
          url: input.url,
          spend: null,
          result,
        },
      }),
    );
    return { kind: "result", result };
  }

  const pendingId = `${process.pid}-${spentAt}-${Math.random().toString(16).slice(2)}`;
  const spend: SavedSpend = {
    payTo: input.payTo,
    host: input.host,
    resourceId,
    amountUsd: input.amountUsd,
    at: spentAt,
  };
  try {
    await appendRow(
      input.store,
      decisionRow({
        recommendation: "ALLOW",
        reasonCodes: [],
        atMs: spentAt,
        status: "refused",
        url: input.url,
        txHash: null,
        nonce: null,
        checked: {
          state: "pending",
          pendingId,
          idempotencyKey: input.key,
          rulesJson: input.rulesJson,
          amountUsd: input.amountUsd,
          url: input.url,
          payTo: input.payTo,
          at: spentAt,
          spend,
          result: null,
        },
      }),
    );
  } catch {
    return { kind: "result", result: unpaid("store_unreadable", input.evidenceUrl) };
  }
  return { kind: "pay", pendingId, spentAt, payTo: input.payTo, resourceId };
}

async function executePayment(
  input: PayCheckedInput,
  fetchImpl: typeof fetch,
  payer: Payer,
  payTo: string,
  resourceId: string,
): Promise<{ payment: Awaited<ReturnType<typeof payOrRefuse>>; delivered: boolean }> {
  // A property, not a `let`. A closure assignment to a `let` is invisible to
  // control-flow analysis, which then narrows the still-`null` binding to `never`.
  const observed: ({ status: number; body: unknown } | null)[] = [null];
  const wrapped: typeof fetch = async (resource, init) => {
    const response = await fetchImpl(resource, init);
    if (isPaidResend(init)) {
      observed[0] = {
        status: typeof response.status === "number" ? response.status : 0,
        body: await readBody(response),
      };
    }
    return response;
  };
  const common = {
    payee: payTo,
    resource: input.url,
    amountUsd: input.amountUsd,
    fetch: wrapped,
    apiUrl: apiRoot(input.baseUrl),
    ...(resourceId !== "" ? { resourceId } : {}),
  };
  const payment =
    payer.kind === "svm"
      ? await payOrRefuse({ ...common, svm: payer.svm })
      : await payOrRefuse({ ...common, account: payer.account });
  const seen = observed[0];
  return { payment, delivered: seen !== null && isDelivered(seen.status, seen.body) };
}

export async function payChecked(input: PayCheckedInput): Promise<PayCheckedResult> {
  if (typeof input.url !== "string" || input.url.trim() === "") {
    throw new Error("invalid_url: pass the http(s) URL of the resource to pay");
  }
  let host: string;
  try {
    const parsed = new URL(input.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
    host = parsed.host;
    if (host === "") throw new Error("no host");
  } catch {
    throw new Error("invalid_url: pass the http(s) URL of the resource to pay");
  }
  if (typeof input.amountUsd !== "number" || !Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
    throw new Error("invalid_amount_usd: pass a finite, non-negative USD amount");
  }
  // Presence only. Reading `account.sign*` here would make a refusal look like a signature.
  const payer = payerOf(input);
  const fetchImpl = input.fetch ?? fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("invalid_fetch: pass the fetch implementation payChecked should use");
  }

  const store = input.store ?? DEFAULT_DECISION_STORE;
  const rulesJson = JSON.stringify(input.rules ?? null);
  const key = typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0 ? input.idempotencyKey : null;
  const remote = await loadRemote(input, fetchImpl, key);
  const evidenceUrl = evidenceUrlOf(remote.decision);
  const payTo = payeeOf(remote.decision, remote.resolved);

  let prepared: Prepared;
  try {
    prepared = await withStoreLock(store, () =>
      prepare({
        store,
        rules: input.rules,
        rulesJson,
        key,
        url: input.url,
        host,
        amountUsd: input.amountUsd,
        evidenceUrl,
        payTo,
        resourceId: remote.resourceId,
        decision: remote.decision,
      }),
    );
  } catch (error) {
    if (error instanceof StoreLockError) return unpaid("store_unreadable", evidenceUrl);
    throw error;
  }
  if (prepared.kind === "result") return prepared.result;

  const { payment, delivered } = await executePayment(input, fetchImpl, payer, prepared.payTo, prepared.resourceId);
  const signed = payment.signed === true || payment.status === "paid";
  const result: PayCheckedResult = {
    paid: payment.status === "paid",
    delivered,
    refusedBy: null,
    receipt: payment.receipt ?? null,
    evidenceUrl: evidenceUrl ?? evidenceUrlOf(payment.decision.decision),
  };
  const finalState: CheckedState = payment.status === "paid" ? "settled" : "failed";
  const row = decisionRow({
    recommendation: payment.status !== "refused" ? "ALLOW" : "REFUSE",
    reasonCodes: [],
    atMs: prepared.spentAt,
    status: payment.status,
    url: input.url,
    txHash: payment.txHash,
    nonce: payment.nonce,
    checked: {
      state: finalState,
      pendingId: prepared.pendingId,
      idempotencyKey: key,
      rulesJson,
      amountUsd: input.amountUsd,
      url: input.url,
      payTo: prepared.payTo,
      at: prepared.spentAt,
      spend: signed
        ? {
            payTo: prepared.payTo,
            host,
            resourceId: prepared.resourceId,
            amountUsd: input.amountUsd,
            at: prepared.spentAt,
          }
        : null,
      result,
    },
  });
  try {
    await withStoreLock(store, () => replacePending(store, prepared.pendingId, JSON.stringify(row)));
  } catch (error) {
    // The signature already exists. Return it with the write error attached.
    return { ...result, recordError: errorText(error) };
  }
  return result;
}

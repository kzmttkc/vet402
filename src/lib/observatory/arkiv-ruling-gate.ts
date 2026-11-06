// Ported from vet402-mumbai packages/sealed-delivery/src/rulings.ts (isRuledAgainst with verifyOnArc: true, and rulingOnArc), 2026-11-06.
// Unlike the source, a read that fails here pays as before (fail-open): only a ruling Arc confirms stops a payment.
// A JSON-RPC call answered 429 (Arkiv or Arc) is tried once more, only when the retry fits inside the time cap.
//
// 買い手が払う直前に読む関門（2026-11-06）。vet402 が Arkiv に書いた Silent / Fraud の判定のうち、Arc の
// SealedDelivery の事象で確かめられたものが 7 日以内にある payTo にだけ払わない。読めない・時間切れ・例外は
// 今までどおり払う（allow_unread）。依存は足さず、fetch の JSON-RPC だけで読む。

/** Arkiv's testnet, where vet402 writes its `vet402_verdict` entities. The public endpoint needs no key. */
export const ARKIV_RPC = "https://rpc.rabdi.db-chain.testnet.arkiv.network";
/**
 * Overrides ARKIV_RPC, for example with an endpoint that carries an access key in its path. Unset, unparsable
 * or not https: reads the public one (the value is never echoed, so a key in it does not reach an error).
 */
export function arkivRpcUrl(): string {
  return httpsOverride(process.env.VET402_ARKIV_RPC_URL, ARKIV_RPC);
}

/** Overrides ARC_TESTNET_RPC with VET402_ARC_TESTNET_RPC_URL, under the same https: check as arkivRpcUrl. */
export function arcTestnetRpcUrl(): string {
  return httpsOverride(process.env.VET402_ARC_TESTNET_RPC_URL, ARC_TESTNET_RPC);
}

function httpsOverride(value: string | undefined, fallback: string): string {
  const raw = value?.trim();
  if (!raw) return fallback;
  try {
    return new URL(raw).protocol === "https:" ? raw : fallback;
  } catch {
    return fallback;
  }
}
/** A ruling stops payment to that address for this long, counted from the Arkiv block it was written in. */
export const RULING_SECONDS = 604_800;
/** Arc's testnet, where the SealedDelivery contract rules. The public endpoint needs no key. */
export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";
/** vet402's SealedDelivery deployments on Arc testnet: the current one and the version before it. */
export const SEALED_DELIVERY_ARC_TESTNET = ["0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B", "0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5"];
/** topic0 of `Silent(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)`. */
export const SILENT_TOPIC = "0xc5aa6a021d29c353e570edaf6cf7a316167639021132ced196609cf63baf7411";
/** topic0 of `Fraud(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)`. */
export const FRAUD_TOPIC = "0xd701d68c0783ed08a7c6c128cbe19074948f794dd05363075f21ea67cdb48a88";
/** The only writer whose rulings this gate trusts: vet402's own Arkiv key. */
export const RULING_WRITER = "0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5";
/** Whole-read wall clock. Past it the buyer pays as before. */
export const ARKIV_RULING_GATE_TIMEOUT_MS = 3000;
/** How long one payTo's answer is reused inside this process. */
export const ARKIV_RULING_CACHE_MS = 10 * 60 * 1000;
/** A JSON-RPC call answered 429 is tried once more after this wait. A Retry-After above RETRY_MAX_WAIT_MS is not retried. */
export const RETRY_WAIT_MS = 400;
export const RETRY_MAX_WAIT_MS = 800;
/** The retry is made only when, after the wait, at least this much of the read's time cap is left for the request. */
export const RETRY_REQUEST_RESERVE_MS = 500;
/** After this many timed-out reads in a row, the rest of a batch is not read (createBatchRulingBreaker). */
export const ARKIV_RULING_BREAKER_UNREAD = 2;

const PAGE = 100;
const MAX_PAGES = 20;
/** Arc's node refuses an eth_getLogs range much wider than this. */
const LOG_STEP = 10_000n;
const MAX_LOG_READS = 50;
const MAX_CACHE_ENTRIES = 1000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export type ArkivRulingResult =
  | { action: "block"; verdict: string; claimId: string }
  | { action: "allow"; reason: "no_ruling" | "not_evm" | "disabled" }
  /** timedOut: the read ran out of its time cap (the only unread the batch breaker counts). */
  | { action: "allow_unread"; error: string; timedOut?: true };

export type ArkivRulingCheck = (payTo: string, opts?: { fetch?: typeof fetch; timeoutMs?: number }) => Promise<ArkivRulingResult>;

interface ArcRuling {
  claimId: string;
  claimTx?: string | null;
  contract?: string | null;
  chainId?: bigint | number | string | null;
  verdict: string;
  /** Unix seconds the ruling reached Arkiv. The event has to be on Arc by then. */
  writtenAt: number;
}

interface RulingRow {
  createdAt?: string;
  attributes?: { name: string; value: unknown }[];
}

/** The query string, the same one a buyer can run by hand with `arkiv_query`. It matches `pay_to` or `seller`. */
export function rulingQuery(payTo: string, writer: string): string {
  if (!ADDRESS.test(payTo) || !ADDRESS.test(writer)) throw new Error("payTo and writer must be 0x addresses");
  const address = payTo.toLowerCase();
  return `arkiv.schema = str('vet402_verdict') AND kind = str('verdict') AND (pay_to = str('${address}') OR seller = str('${address}')) AND $owner = addr(${writer})`;
}

/** One read's transport: the fetch, the read's absolute deadline (ms since epoch) and the signal the timer aborts. */
interface Rpc {
  fetch: typeof fetch;
  deadline: number;
  signal: AbortSignal;
}

/**
 * The wait before the one retry: Retry-After (seconds or an HTTP date) when it parses, else RETRY_WAIT_MS.
 * null when Retry-After asks for more than RETRY_MAX_WAIT_MS: retrying sooner than the node asked is wasted
 * (Arkiv's anonymous tier answers `retry-after: 8`), so the 429 stands.
 */
function retryWaitMs(retryAfter: string | null): number | null {
  let wait = RETRY_WAIT_MS;
  const text = retryAfter?.trim() ?? "";
  if (/^\d+(\.\d+)?$/.test(text)) wait = Number(text) * 1000;
  else if (text !== "" && Number.isFinite(Date.parse(text))) wait = Date.parse(text) - Date.now();
  if (wait > RETRY_MAX_WAIT_MS) return null;
  return Math.max(0, wait);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function call<T>(rpc: Rpc, url: string, method: string, params: unknown[], node = "Arkiv"): Promise<T> {
  const send = () =>
    rpc.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  let res = await send();
  if (res.status === 429) {
    // One retry, and only when it fits inside the read's time cap. Otherwise the 429 stands (allow_unread).
    const wait = retryWaitMs(res.headers.get("retry-after"));
    if (wait !== null && rpc.deadline - Date.now() >= wait + RETRY_REQUEST_RESERVE_MS) {
      await res.body?.cancel().catch(() => undefined);
      await sleep(wait, rpc.signal);
      res = await send();
    }
  }
  if (!res.ok) throw new Error(`${node} answered ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(`${node} refused ${method}: ${body.error?.message ?? "no result"}`);
  return body.result;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

/**
 * True when Arc holds the contract's Silent or Fraud event for this ruling's claim, against this payTo
 * address, after the claim's own transaction and no later than the ruling reached Arkiv. A failed read throws.
 */
async function rulingOnArc(payTo: string, ruling: ArcRuling, rpc: Rpc): Promise<boolean> {
  const arcUrl = arcTestnetRpcUrl();
  const arc = <T>(method: string, params: unknown[]) => call<T>(rpc, arcUrl, method, params, "Arc");
  const claimId = ruling.claimId.toLowerCase();
  const claimTx = ruling.claimTx ?? "";
  const contract = (ruling.contract ?? "").toLowerCase();
  const topic = ruling.verdict === "silent" ? SILENT_TOPIC : ruling.verdict === "fraud" ? FRAUD_TOPIC : null;
  const accepted = SEALED_DELIVERY_ARC_TESTNET.map((a) => a.toLowerCase());
  if (!ADDRESS.test(payTo) || !BYTES32.test(claimId) || !BYTES32.test(claimTx) || !ADDRESS.test(contract) || !topic) return false;
  if (!accepted.includes(contract) || ruling.chainId === null || ruling.chainId === undefined) return false;
  // A chain id the row cannot spell as an integer does not count. Only the row is skipped, not the read.
  let chainId: bigint;
  try {
    chainId = BigInt(ruling.chainId);
  } catch {
    return false;
  }
  if (BigInt(await arc<string>("eth_chainId", [])) !== chainId) return false;

  // The claim itself: mined, and carrying this claim id from this contract.
  const receipt = await arc<{ status?: string; blockNumber: string; logs?: { address: string; topics?: string[] }[] } | null>(
    "eth_getTransactionReceipt",
    [claimTx],
  );
  if (!receipt || receipt.status !== "0x1") return false;
  if (!(receipt.logs ?? []).some((log) => log.address.toLowerCase() === contract && log.topics?.[1]?.toLowerCase() === claimId)) return false;

  // finalize or prove emits the ruling in a later transaction, so the logs are read forward from the claim.
  const seller = `0x${payTo.slice(2).toLowerCase().padStart(64, "0")}`;
  const latest = BigInt(await arc<string>("eth_blockNumber", []));
  let from = BigInt(receipt.blockNumber);
  for (let read = 0; read < MAX_LOG_READS && from <= latest; read++) {
    if (read > 0) {
      const block = await arc<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(from), false]);
      if (!block || Number(BigInt(block.timestamp)) > ruling.writtenAt) return false;
    }
    const to = from + LOG_STEP - 1n < latest ? from + LOG_STEP - 1n : latest;
    const logs = await arc<unknown[]>("eth_getLogs", [{ address: contract, fromBlock: hex(from), toBlock: hex(to), topics: [topic, claimId, null, seller] }]);
    if (logs.length > 0) return true;
    from = to + 1n;
  }
  return false;
}

/**
 * The first Silent or Fraud ruling from vet402's writer against this payTo within 7 days that Arc confirms,
 * or null. isRuledAgainst(payTo, { writer, verifyOnArc: true }) of the source, returning the ruling it found.
 * A failed read throws, and so does more rows than the read takes (2,000).
 */
type BlockTiming = { current_block: number; current_block_time: number; duration: number };

/**
 * One row as rulingOnArc needs it, or null when it is out of the window, names another address, or cannot be
 * read (a malformed createdAt or attribute list). A malformed row is skipped; it never fails the whole read.
 */
function rowRuling(row: RulingRow, timing: BlockTiming, payTo: string): ArcRuling | null {
  try {
    if (!row.createdAt) return null;
    const age = (BigInt(timing.current_block) - BigInt(row.createdAt)) * BigInt(timing.duration);
    if (age >= BigInt(RULING_SECONDS)) return null;
    const value = (name: string) => {
      const found = row.attributes?.find((a) => a.name === name)?.value;
      return found === undefined || found === null ? null : String(found);
    };
    // Either column matched the query. When `pay_to` is there it decides, as on the receipts page.
    const against = value("pay_to") ?? value("seller");
    if (against !== null && against.toLowerCase() !== payTo.toLowerCase()) return null;
    return {
      claimId: value("claim_id") ?? "",
      claimTx: value("claim_tx"),
      contract: value("contract"),
      chainId: value("chain_id"),
      verdict: value("verdict") ?? "",
      writtenAt: timing.current_block_time - Number(age),
    };
  } catch {
    return null;
  }
}

async function findArcConfirmedRuling(payTo: string, rpc: Rpc): Promise<ArcRuling | null> {
  const query = rulingQuery(payTo, RULING_WRITER);
  const url = arkivRpcUrl();
  const timing = await call<BlockTiming>(rpc, url, "arkiv_getBlockTiming", []);
  const select = { key: true, createdAt: true, attributes: true };
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call<{ data?: RulingRow[] }>(rpc, url, "arkiv_query", [
      query,
      { select, limit: `0x${PAGE.toString(16)}`, offset: `0x${(page * PAGE).toString(16)}` },
    ]);
    const rows = Array.isArray(result.data) ? result.data : [];
    for (const row of rows) {
      const ruling = rowRuling(row, timing, payTo);
      if (!ruling) continue;
      // A failed Arc read throws past this loop, so the caller pays as before (allow_unread).
      if (await rulingOnArc(payTo, ruling, rpc)) return ruling;
    }
    if (rows.length < PAGE) return null;
  }
  throw new Error(`More than ${MAX_PAGES * PAGE} rulings. Not all were read.`);
}

const cache = new Map<string, { at: number; result: ArkivRulingResult }>();

/** Test seam: forget every cached answer. */
export function resetArkivRulingCache(): void {
  cache.clear();
}

export function arkivRulingGateEnabled(): boolean {
  return process.env.VET402_ARKIV_RULING_GATE?.trim().toLowerCase() !== "off";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * block only when vet402's writer has an Arc-confirmed Silent or Fraud ruling against payTo within 7 days.
 * A payTo that is not a 0x address (Solana, Stellar, XRPL, ...) is not read. A failed, slow or thrown read
 * is allow_unread: the caller pays as before. Answers from a completed read are cached for 10 minutes.
 */
export async function checkArkivRuling(payTo: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<ArkivRulingResult> {
  if (!arkivRulingGateEnabled()) return { action: "allow", reason: "disabled" };
  if (!ADDRESS.test(payTo)) return { action: "allow", reason: "not_evm" };
  const key = payTo.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ARKIV_RULING_CACHE_MS) return cached.result;

  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ARKIV_RULING_GATE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`arkiv ruling read timed out after ${timeoutMs}ms`)), timeoutMs);
  // A fetch that ignores the signal still loses the race once the clock runs out.
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  timedOut.catch(() => undefined);
  const signalled: typeof fetch = (input, init) => {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    return fetchImpl(input, { ...init, signal: controller.signal });
  };
  try {
    const ruling = await Promise.race([findArcConfirmedRuling(payTo, { fetch: signalled, deadline, signal: controller.signal }), timedOut]);
    const result: ArkivRulingResult = ruling
      ? { action: "block", verdict: ruling.verdict, claimId: ruling.claimId.toLowerCase() }
      : { action: "allow", reason: "no_ruling" };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, { at: Date.now(), result });
    return result;
  } catch (error) {
    // The signal is aborted only by the timer, so an aborted signal means the read ran out of time.
    if (controller.signal.aborted) return { action: "allow_unread", error: messageOf(error), timedOut: true };
    return { action: "allow_unread", error: messageOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One batch's breaker. After ARKIV_RULING_BREAKER_UNREAD timed-out reads in a row, the rest of the batch is
 * answered allow_unread without a read, so an Arkiv outage costs at most two timeouts per batch instead of
 * one per EVM candidate. A failure that answers at once (429, 5xx, a refused call) is not counted: it costs
 * no time, and the cron runs once a day, so two early 429s must not leave the whole day unread. A completed
 * read (block or no_ruling) sets the count back to 0.
 */
export function createBatchRulingBreaker(check: ArkivRulingCheck): ArkivRulingCheck {
  let unreadStreak = 0;
  return async (payTo, opts) => {
    if (unreadStreak >= ARKIV_RULING_BREAKER_UNREAD) {
      if (!arkivRulingGateEnabled()) return { action: "allow", reason: "disabled" };
      if (!ADDRESS.test(payTo)) return { action: "allow", reason: "not_evm" };
      return { action: "allow_unread", error: "breaker open for this batch" };
    }
    const result = await check(payTo, opts);
    if (result.action === "allow_unread") {
      if (result.timedOut) unreadStreak++;
    } else if (result.action === "block" || result.reason === "no_ruling") unreadStreak = 0;
    return result;
  };
}

import type { BlockTag } from "viem";
import type { getPublicClient } from "./client";
import { mapWithConcurrency } from "@/lib/util/concurrency";
import { type Deadline, DeadlineExceededError, createDeadline } from "@/lib/util/deadline";

type ChainClient = ReturnType<typeof getPublicClient>;
export type ChainGetLogsParams = Parameters<ChainClient["getLogs"]>[0];
type ChainLog = Awaited<ReturnType<ChainClient["getLogs"]>>[number];

/** Max blocks per eth_getLogs request (Alchemy Base ≈ 2k–10k; default conservative). */
export function getLogsChunkSize(): bigint {
  const raw = process.env.GET_LOGS_CHUNK_BLOCKS;
  if (!raw) return 2_000n;
  try {
    const size = BigInt(raw);
    return size > 0n ? size : 2_000n;
  } catch {
    return 2_000n;
  }
}

/**
 * How many eth_getLogs chunks to fetch in parallel.
 *
 * Wide catch-up ranges (250k blocks / 2k chunk = ~125 sequential round-trips
 * per event) were the owner-indexer's dominant follow-through cost: at
 * ~150-300ms per Neon-region → RPC round-trip that is 20-40s of pure waiting,
 * per event, per run. A small fixed fan-out cuts that near-linearly while
 * staying well inside Alchemy's concurrent-request budget. Kept conservative
 * (default 4) and env-tunable so ops can dial it to 1 (identical to the old
 * strictly-sequential behaviour) if a provider starts rate-limiting — the
 * per-chunk exponential backoff + bisection in fetchRange still absorbs bursts
 * regardless of this value. Do NOT raise this into the tens: the goal is to
 * outpace Base's block production, not to hammer the RPC.
 */
export function getLogsChunkConcurrency(): number {
  const raw = process.env.GET_LOGS_CHUNK_CONCURRENCY;
  if (!raw) return 4;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(1, Math.min(8, Math.floor(parsed)));
}

function getLogsChunkDelayMs(): number {
  const raw = process.env.GET_LOGS_CHUNK_DELAY_MS;
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveToBlock(
  client: ChainClient,
  toBlock: bigint | BlockTag | undefined,
): Promise<bigint> {
  if (typeof toBlock === "bigint") return toBlock;
  if (toBlock === undefined || toBlock === "latest" || toBlock === "pending") {
    return client.getBlockNumber();
  }
  if (toBlock === "earliest") {
    return 0n;
  }
  if (toBlock === "safe" || toBlock === "finalized") {
    // "safe"/"finalized" refer to the latest safe/finalized block, not
    // genesis — resolve the actual block number via the tag rather than
    // defaulting to 0n (which would silently collapse the range to nothing
    // useful, or worse, to "from genesis").
    const block = await client.getBlock({ blockTag: toBlock });
    return block.number ?? (await client.getBlockNumber());
  }
  throw new Error(`resolveToBlock: unsupported block tag "${String(toBlock)}"`);
}

/** JSON-RPC error code some providers (e.g. Base's public RPC) use for rate limiting. */
const JSON_RPC_RATE_LIMIT_CODE = -32016;

/**
 * Provider codes that mean "this range asked for too much" — the one class of
 * failure a narrower range can actually fix.
 *   -32005  generic "limit exceeded" (Infura/Alchemy result-cap)
 *   -32614  Base public RPC's "eth_getLogs is limited to a 10,000 range"
 */
const RANGE_TOO_WIDE_CODES = new Set([-32005, -32614]);

const RANGE_TOO_WIDE_PATTERNS = [
  "more than", // "query returned more than 10000 results"
  "limited to", // "eth_getLogs is limited to a 10,000 range"
  "block range", // "exceeds maximum block range", "block range is too wide"
  "range is too",
  "range too",
  "too many results",
  "response size", // "response size exceeded"
  "response too large",
  "result set too large",
  "query timeout", // provider gave up on a wide scan; a narrower one may land
  "took too long",
  "range limit",
];

/**
 * Is this error one that BISECTING can plausibly resolve?
 *
 * WHY THIS GATE EXISTS (2026-08-12 incident). fetchRange used to bisect on
 * ANY error. For a failure that halving can never fix — a provider rejecting
 * the request shape ("JSON is not a valid request object."), an expired key,
 * a dead endpoint — that turns ONE failed call into ~2^depth failed calls.
 * Production logs showed a 2,000-block chunk bisected down to 15-block ranges:
 * thousands of doomed requests, which is what consumed the scoring path's
 * entire time budget and produced the "Score unavailable" outage.
 *
 * Bisection is for over-wide ranges. Everything else must fail fast so the
 * caller's `*_unavailable` degradation path can run honestly.
 */
/**
 * Drop the lines viem appends that echo OUR request back at us — the endpoint
 * URL, the serialized request body, and the library version. Only the
 * provider's own words should decide whether a range was too wide.
 */
function stripRequestEcho(message: string | undefined): string {
  if (!message) return "";
  return message
    .split("\n")
    .filter((line) => !/^\s*(URL|Request body|Version):/i.test(line))
    .join("\n");
}

/**
 * Failures a narrower range can NEVER fix, whatever else the error says.
 *
 * WHY THIS OVERRIDE EXISTS (2026-08-12, second incident). The echo-stripping
 * below was supposed to stop our own request body from triggering bisection,
 * and its tests pass. Production still bisected a 680-block query all the way
 * down to 20 blocks, logging `matched=text:block range` on an error whose
 * shortMessage was "JSON is not a valid request object." — a range keyword
 * reached the matcher through some field the stripper does not cover.
 *
 * Chasing which field is the wrong fix. The invariant is simpler and does not
 * depend on knowing: if the provider is telling us the REQUEST is malformed,
 * or that we are not allowed to make it, then halving the block range cannot
 * change the answer. Those verdicts are final, so they are checked first and
 * they win — no matter what other words the message happens to contain.
 */
const NEVER_RANGE_PATTERNS = [
  "not a valid request object", // provider rejects the request shape outright
  "invalid request",
  "parse error",
  "method not found",
  "method not supported",
  "does not exist/is not available",
  "unauthorized",
  "invalid api key",
  "forbidden",
];

function unfixableByBisectionReason(text: string): string | null {
  return NEVER_RANGE_PATTERNS.find((candidate) => text.includes(candidate)) ?? null;
}

export function rangeTooWideReason(error: unknown): string | null {
  const err = error as {
    code?: number;
    status?: number;
    details?: string;
    shortMessage?: string;
    message?: string;
    cause?: { code?: number; details?: string; shortMessage?: string; message?: string };
  };

  // Checked before ANYTHING else, including the numeric codes: a provider that
  // rejects the request shape may still attach a range-ish code or message,
  // and bisecting on it multiplies one doomed call into ~2^depth doomed calls.
  const shapeText = [
    err?.details,
    err?.shortMessage,
    stripRequestEcho(err?.message),
    err?.cause?.details,
    err?.cause?.shortMessage,
    stripRequestEcho(err?.cause?.message),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (unfixableByBisectionReason(shapeText)) return null;

  if (err?.code !== undefined && RANGE_TOO_WIDE_CODES.has(err.code)) return `code:${err.code}`;
  if (err?.cause?.code !== undefined && RANGE_TOO_WIDE_CODES.has(err.cause.code)) {
    return `cause.code:${err.cause.code}`;
  }

  // Match the provider's complaint, not our own outgoing request. viem embeds
  // the request URL and the FULL request body inside error.message, so a naive
  // substring test there is really testing our own payload — and the payload
  // of a wide scan naturally contains range-ish words. Those echo lines are
  // stripped in shapeText above, which is the same text matched here.
  // err.message still has to be considered because plain (non-viem) errors
  // carry their text nowhere else.
  const pattern = RANGE_TOO_WIDE_PATTERNS.find((candidate) => shapeText.includes(candidate));
  return pattern ? `text:${pattern}` : null;
}

export function isRangeTooWideError(error: unknown): boolean {
  return rangeTooWideReason(error) !== null;
}

/**
 * The block-range ceiling the provider STATES in its rejection, if it states one
 * ("eth_getLogs is limited to a 2,000 range" → 2000n).
 *
 * WHY (2026-09-29). Base's public RPC lowered its eth_getLogs ceiling from
 * 10,000 to 2,000 blocks. Production still asked for 8,000-block chunks, so
 * every chunk bisected 8000→4000→2000: two doomed round-trips before each
 * useful one, which also tripped the provider's rate limit (-32016). The
 * wallet→agent tail scan could no longer finish inside its 3s identity budget,
 * so the weekly benchmark-scan recorded 0 of 42 (all
 * `deadline_exceeded:agent_resolve` / `agent_resolve_unavailable`) and uncached
 * paid wallet scores answered 503. When the provider tells us the number, use
 * it instead of guessing by halves.
 */
export function providerStatedRangeLimit(error: unknown): bigint | null {
  const err = error as {
    details?: string;
    shortMessage?: string;
    message?: string;
    cause?: { details?: string; shortMessage?: string; message?: string };
  };
  const text = [
    err?.details,
    err?.shortMessage,
    stripRequestEcho(err?.message),
    err?.cause?.details,
    err?.cause?.shortMessage,
    stripRequestEcho(err?.cause?.message),
  ]
    .filter(Boolean)
    .join(" ");
  const match = /limited to an? ([\d,]+) (?:block )?range/i.exec(text);
  if (!match) return null;
  try {
    const limit = BigInt(match[1]!.replace(/,/g, ""));
    return limit > 0n ? limit : null;
  } catch {
    return null;
  }
}

/**
 * Per-endpoint ceilings learned from provider rejections, so the NEXT scan
 * against the same endpoint starts at the stated width instead of paying the
 * rejection again. In-memory only (a warm instance), keyed by chain + URL; the
 * URL never leaves this map (not logged).
 */
const learnedRangeCaps = new Map<string, bigint>();

function rangeCapKey(client: ChainClient): string {
  const c = client as { chain?: { id?: number }; transport?: { url?: string } };
  return `${c?.chain?.id ?? "?"}:${c?.transport?.url ?? ""}`;
}

/** TEST-ONLY: forget learned ceilings between tests. */
export function __resetLearnedRangeCapsForTests(): void {
  learnedRangeCaps.clear();
}

function isRateLimitError(error: unknown): boolean {
  const err = error as {
    status?: number;
    code?: number;
    details?: string;
    message?: string;
    cause?: { code?: number; details?: string };
  };
  if (err?.status === 429 || err?.code === 429 || err?.cause?.code === 429) return true;
  if (err?.code === JSON_RPC_RATE_LIMIT_CODE || err?.cause?.code === JSON_RPC_RATE_LIMIT_CODE) {
    return true;
  }
  const text = `${err?.details ?? ""} ${err?.cause?.details ?? ""} ${err?.message ?? ""}`.toLowerCase();
  return text.includes("rate limit");
}

/**
 * RPC client errors (viem HttpRequestError) embed the full request URL —
 * which includes the provider API key as a path segment — in error.message.
 * Strip it before logging so provider keys never land in Vercel logs.
 */
function redactSecrets(message: string | undefined): string {
  if (!message) return "";
  return message.replace(/https?:\/\/\S+/g, "[redacted-url]");
}

const RATE_LIMIT_MAX_RETRIES = 7;
const RATE_LIMIT_BASE_DELAY_MS = 800;

async function fetchRange(
  client: ChainClient,
  params: Omit<ChainGetLogsParams, "fromBlock" | "toBlock">,
  fromBlock: bigint,
  toBlock: bigint,
  rateLimitRetries = 0,
  deadline?: Deadline,
): Promise<ChainLog[]> {
  if (fromBlock > toBlock) return [];
  deadline?.throwIfExpired("getLogsChunked");

  try {
    return await client.getLogs({
      ...params,
      fromBlock,
      toBlock,
    } as ChainGetLogsParams);
  } catch (error) {
    if (error instanceof DeadlineExceededError) throw error;

    if (isRateLimitError(error) && rateLimitRetries < RATE_LIMIT_MAX_RETRIES) {
      const backoff = RATE_LIMIT_BASE_DELAY_MS * 2 ** rateLimitRetries;
      // Don't sleep past the deadline just to make a call we can't afford.
      if (deadline && backoff >= deadline.remaining()) {
        throw new DeadlineExceededError("getLogsChunked", backoff);
      }
      console.log(
        `[chunked-logs] rate-limited ${fromBlock}-${toBlock}, retry ${rateLimitRetries + 1}/${RATE_LIMIT_MAX_RETRIES}`,
      );
      await sleep(backoff);
      return fetchRange(client, params, fromBlock, toBlock, rateLimitRetries + 1, deadline);
    }

    // Only an over-wide range is fixable by halving. Bisecting on anything
    // else (bad request shape, auth failure, dead endpoint) multiplies one
    // failure into ~2^depth failures — the 2026-08-12 outage. Fail fast and
    // let the caller degrade honestly.
    const rangeReason = rangeTooWideReason(error);
    if (!rangeReason) {
      const err = error as { code?: number; details?: string; shortMessage?: string };
      console.log(
        `[chunked-logs] non-range failure on ${fromBlock}-${toBlock}, not bisecting` +
          ` code=${err?.code} details=${JSON.stringify(err?.details ?? err?.shortMessage)?.slice(0, 200)}`,
      );
      throw error;
    }

    const span = toBlock - fromBlock;

    // The provider named its ceiling and this range exceeds it: split at that
    // width directly (no halving). If the stated number turns out to be wrong,
    // the pieces fail again with a width <= the claim, this branch no longer
    // applies, and plain bisection below takes over — no loop.
    const stated = providerStatedRangeLimit(error);
    if (stated !== null && span + 1n > stated) {
      learnedRangeCaps.set(rangeCapKey(client), stated);
      console.log(
        `[chunked-logs] provider limit ${stated} blocks; splitting ${fromBlock}-${toBlock} at that width`,
      );
      const out: ChainLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += stated) {
        const end = start + stated - 1n > toBlock ? toBlock : start + stated - 1n;
        out.push(...(await fetchRange(client, params, start, end, 0, deadline)));
      }
      return out;
    }

    if (span <= 0n) {
      console.log(
        `[chunked-logs] giving up on block ${fromBlock}: ${(error as Error)?.constructor?.name} ${redactSecrets((error as Error)?.message).slice(0, 200)}`,
      );
      throw error;
    }
    console.log(
      `[chunked-logs] bisecting ${fromBlock}-${toBlock} matched=${rangeReason} due to: ${redactSecrets((error as Error)?.message).slice(0, 150)}`,
    );

    const mid = fromBlock + span / 2n;
    const left = await fetchRange(client, params, fromBlock, mid, 0, deadline);
    const right = await fetchRange(client, params, mid + 1n, toBlock, 0, deadline);
    return [...left, ...right];
  }
}

/**
 * eth_getLogs over a wide block range, splitting into chunks and bisecting on RPC range errors.
 *
 * Chunks are fetched with a small bounded fan-out (getLogsChunkConcurrency) to
 * outpace Base's block production during catch-up, but the returned logs are
 * always reassembled in ascending block order so callers that rely on ordering
 * (e.g. transfer replay) see exactly what the old sequential scan produced.
 */
export async function getLogsChunked(
  client: ChainClient,
  params: ChainGetLogsParams & { fromBlock: bigint },
  chunkSize = getLogsChunkSize(),
  concurrency = getLogsChunkConcurrency(),
  options?: {
    /** Wall-clock ceiling for the whole scan. Required on request paths. */
    deadlineMs?: number;
    /** Override the env pacing delay (batch pacing must not leak into live requests). */
    delayMs?: number;
  },
): Promise<ChainLog[]> {
  const deadline =
    options?.deadlineMs === undefined ? undefined : createDeadline(options.deadlineMs);
  const toBlock = await resolveToBlock(client, params.toBlock);
  const fromBlock = params.fromBlock;
  const { fromBlock: _ignoredFrom, toBlock: _ignoredTo, ...rest } = params;
  void _ignoredFrom;
  void _ignoredTo;

  if (fromBlock > toBlock) return [];

  // A ceiling this endpoint already stated wins over the configured width.
  const learnedCap = learnedRangeCaps.get(rangeCapKey(client));
  if (learnedCap !== undefined && learnedCap < chunkSize) chunkSize = learnedCap;

  // Pre-compute the chunk ranges up front so fetches can fan out while the
  // per-chunk order in the final array stays deterministic (index-aligned).
  const ranges: { start: bigint; end: bigint }[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    ranges.push({ start, end });
  }

  const delayMs = options?.delayMs ?? getLogsChunkDelayMs();
  const effectiveConcurrency = Math.max(1, concurrency);

  // Sequential path preserved byte-for-byte for concurrency === 1 (and when a
  // pacing delay is configured, so the delay keeps its "space out RPC calls"
  // meaning rather than becoming a no-op under parallelism).
  if (effectiveConcurrency === 1 || delayMs > 0) {
    const results: ChainLog[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const { start, end } = ranges[i]!;
      deadline?.throwIfExpired("getLogsChunked");
      const logs = await fetchRange(client, rest, start, end, 0, deadline);
      results.push(...logs);
      if (delayMs > 0 && i < ranges.length - 1) {
        if (deadline && delayMs >= deadline.remaining()) {
          throw new DeadlineExceededError("getLogsChunked", delayMs);
        }
        await sleep(delayMs);
      }
    }
    return results;
  }

  const perChunk = await mapWithConcurrency(
    ranges,
    effectiveConcurrency,
    ({ start, end }) => fetchRange(client, rest, start, end, 0, deadline),
  );

  const results: ChainLog[] = [];
  for (const logs of perChunk) results.push(...logs);
  return results;
}

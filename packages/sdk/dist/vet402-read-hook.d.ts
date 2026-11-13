/**
 * Read-only vet402 hook under a payment fetch wrapper. Does not sign or send funds.
 * When vet402 is unreachable, payment proceeds and the hook reports empty context.
 */
import type { StoredDecision } from "./pay-or-refuse.js";
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
export type Vet402ReadBeforePayResult = Vet402ReadSnapshot & {
    status?: Vet402ReadStatus;
};
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
export declare function getVet402ReadSnapshot(fetchFn: typeof fetch): Vet402ReadSnapshot | undefined;
export declare function getVet402LocalRecords(fetchFn: typeof fetch): Vet402LocalRecord[] | undefined;
export declare function getVet402ReadResult(fetchFn: typeof fetch): {
    snapshot: Vet402ReadSnapshot;
    snapshotStatus: Vet402ReadStatus;
    local: {
        status: Vet402ReadStatus;
        records: Vet402LocalRecord[];
    } | undefined;
} | undefined;
export declare function createVet402ReadHook(options?: Vet402ReadHookOptions): (fetchImpl: typeof fetch) => typeof fetch;

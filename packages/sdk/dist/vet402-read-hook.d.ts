/**
 * Read-only vet402 hook under a payment fetch wrapper. Does not sign or send funds.
 * When vet402 is unreachable, payment proceeds and the hook reports empty context.
 */
export type Vet402ReadSnapshot = {
    deliveredRatePct: number | null;
    vet402Unreachable: boolean;
};
export type Vet402ReadHookOptions = {
    readBeforePay?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Vet402ReadSnapshot>;
    /** Defaults to env VET402_API_URL or hosted production API. */
    observatoryApiBase?: string;
};
export declare function getVet402ReadSnapshot(fetchFn: typeof fetch): Vet402ReadSnapshot | undefined;
export declare function createVet402ReadHook(options?: Vet402ReadHookOptions): (fetchImpl: typeof fetch) => typeof fetch;

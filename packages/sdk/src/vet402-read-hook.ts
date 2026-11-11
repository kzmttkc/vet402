/**
 * Read-only vet402 hook under a payment fetch wrapper. Does not sign or send funds.
 * When vet402 is unreachable, payment proceeds and the hook reports empty context.
 */

const DEFAULT_OBSERVATORY_API = "https://vet402.com/api/v1";

export type Vet402ReadSnapshot = {
  deliveredRatePct: number | null;
  vet402Unreachable: boolean;
};

export type Vet402ReadHookOptions = {
  readBeforePay?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Vet402ReadSnapshot>;
  /** Defaults to env VET402_API_URL or hosted production API. */
  observatoryApiBase?: string;
};

const lastSnapshotByFetch = new WeakMap<typeof fetch, Vet402ReadSnapshot>();

export function getVet402ReadSnapshot(fetchFn: typeof fetch): Vet402ReadSnapshot | undefined {
  return lastSnapshotByFetch.get(fetchFn);
}

async function defaultReadObservatoryState(apiBase: string): Promise<Vet402ReadSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/observatory/state`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { deliveredRatePct: null, vet402Unreachable: true };
    const body = (await res.json()) as {
      l1?: { attempts?: number; delivered?: number };
      deliveredOfAttemptsPct?: number | null;
    };
    const fromField = body.deliveredOfAttemptsPct;
    if (typeof fromField === "number" && Number.isFinite(fromField)) {
      return { deliveredRatePct: fromField, vet402Unreachable: false };
    }
    const attempts = body.l1?.attempts ?? 0;
    const delivered = body.l1?.delivered ?? 0;
    if (attempts <= 0) return { deliveredRatePct: null, vet402Unreachable: false };
    const pct = Math.round((delivered / attempts) * 1000) / 10;
    return { deliveredRatePct: pct, vet402Unreachable: false };
  } catch {
    return { deliveredRatePct: null, vet402Unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

export function createVet402ReadHook(options: Vet402ReadHookOptions = {}): (fetchImpl: typeof fetch) => typeof fetch {
  const envBase = typeof process !== "undefined" ? process.env?.VET402_API_URL : undefined;
  const apiBase = options.observatoryApiBase ?? envBase ?? DEFAULT_OBSERVATORY_API;
  const readBeforePay =
    options.readBeforePay ??
    (async (): Promise<Vet402ReadSnapshot> => defaultReadObservatoryState(apiBase));

  return (fetchImpl: typeof fetch) => {
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      let snapshot: Vet402ReadSnapshot = { deliveredRatePct: null, vet402Unreachable: true };
      try {
        snapshot = await readBeforePay(input, init);
      } catch {
        snapshot = { deliveredRatePct: null, vet402Unreachable: true };
      }
      lastSnapshotByFetch.set(wrapped, snapshot);
      return fetchImpl(input, init);
    };
    return wrapped;
  };
}

/**
 * How this SDK names itself to vet402's own API: `User-Agent: vet402-sdk/<version>`.
 *
 * The server counts key-less calls by client name (`src/lib/api/client-usage.ts`,
 * `DISTRIBUTED_CLIENTS`) and reads the version as three groups of digits. Without
 * this header every SDK call arrives as Node's default `node` and is counted as
 * `other`.
 *
 * The header goes on requests to vet402's API only. Requests to a seller (the 402
 * fetch and the paid re-send), to a Solana RPC and to The Graph are built
 * elsewhere and do not use it: a seller has no need to learn which SDK is paying,
 * and those requests keep the shape they had in 0.7.0.
 *
 * A constants-only module with no imports, so `pay-or-refuse.ts` can import it
 * statically without pulling anything into the refuse path.
 */
/** Kept equal to `package.json`'s `version` by `test/user-agent.test.mjs`. */
export declare const SDK_VERSION = "0.7.2";
export declare const SDK_USER_AGENT = "vet402-sdk/0.7.2";
/**
 * The headers that name this SDK, for a request to vet402's API. Empty in a
 * browser. Read at call time, not at import time.
 */
export declare function clientIdentityHeaders(): Record<string, string>;

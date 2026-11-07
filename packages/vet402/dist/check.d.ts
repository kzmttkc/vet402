import { DEFAULT_API_URL, type DecisionRecommendation } from "@vet402/sdk";
export { DEFAULT_API_URL };
/** Public page of one record. Same form as the hosted MCP server's record_url. */
export declare const RECORD_URL_BASE = "https://vet402.com/observatory/e/";
export type CheckOptions = {
    /** API key from https://vet402.com/dashboard/keys. Optional: without one no Authorization header is sent. */
    apiKey?: string;
    /** Defaults to {@link DEFAULT_API_URL}. */
    apiUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
};
/** Terms of the last purchase where content came back. Null on CheckFound when there is none. */
export type VerifiedTerms = {
    purchase_id: string | null;
    pay_to: string;
    asset: string;
    amount: string;
    decimals: 6;
    network: string;
    scheme: "exact" | "charge";
    protocol: "x402" | "mpp";
    verified_at: string;
};
export type CheckFound = {
    recommendation: DecisionRecommendation;
    reasonCodes: string[];
    verifiedTerms: VerifiedTerms | null;
    resourceId: string;
    evidenceUrl: string;
    /** When check read the decision. */
    retrievedAt: string;
    /** When vet402 scored it. */
    scoredAt: string;
};
export type CheckUnknown = {
    recommendation: "UNKNOWN";
    reason: string;
};
export type CheckResult = CheckFound | CheckUnknown;
export declare function check(url: string, opts?: CheckOptions): Promise<CheckResult>;

import type { PayerAccount, PayReceipt, SvmPayOptions } from "./pay-or-refuse.js";
import { type SpendRuleRefusal, type SpendRules } from "./spend-rules.js";
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
} & ({
    account: PayerAccount;
    svm?: undefined;
} | {
    svm: SvmPayOptions;
    account?: undefined;
});
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
export declare function payChecked(input: PayCheckedInput): Promise<PayCheckedResult>;

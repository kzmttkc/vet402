/**
 * Tool-error sanitizer, extracted from index.ts (2026-08-22) so it can be
 * tested without importing index.ts — that module calls `main()` at load and
 * would connect a stdio transport inside the test process. Behaviour is
 * unchanged; only the file it lives in moved.
 */
import { VouchApiError } from "./vouch-client.js";
// Every error code the Vouch API can return for the endpoints this MCP server calls
// (agents/:id/score, wallets/:address/score, payees/:address/score, payments/x402).
// Keep in sync with src/app/api/v1/* and docs/openapi.yaml ErrorResponse.error enum.
export const KNOWN_ERROR_CODES = new Set([
    "invalid_request",
    "invalid_agent_id",
    "invalid_wallet_address",
    "invalid_tx_hash",
    "attestation_unverifiable",
    "missing_api_key",
    "invalid_api_key",
    "auth_unavailable",
    "rate_limit_exceeded",
    "scoring_unavailable",
    "payment_ingest_unavailable",
]);
/**
 * 呼び出し側の誤りで、**メッセージを我々自身のコードが組み立てる**もの（SDK の
 * `assertEvidencePolicy` / `assertOverridePolicy` と MCP の `assertPolicy`）。上流の文字列を
 * 含まないので、そのまま通してよい。`request_failed` に潰すと、呼び手（モデル）は
 * 「床を書き忘れた」のか「上流が落ちた」のか区別できず、直す場所が分からない。
 */
export const CALLER_ERROR_PREFIXES = ["invalid_policy:", "invalid_evidence_policy:"];
/** Stable code returned when the trust lookup never answered. */
export const LOOKUP_TIMEOUT_MESSAGE = "lookup_timeout: the trust lookup did not answer in time — the payee was NOT checked";
/**
 * Turn an arbitrary thrown value into a string the model may see.
 *
 * Allow-list by design: anything not on the known-code list collapses to
 * `request_failed`, so an upstream stack trace or a URL with a key in it can
 * never reach the transcript.
 */
export function sanitizeToolError(error) {
    if (!(error instanceof Error))
        return "request_failed";
    // A timed-out lookup, named rather than flattened into "request_failed"
    // (2026-08-22, when vouch-client gained AbortSignal.timeout). The model's
    // correct move differs: "request_failed" reads as a bad request it should
    // stop repeating, while a timeout is an upstream that may answer on retry.
    // Either way the payee was NOT vetted — fail closed, do not pay. The return
    // value is a fixed literal, so nothing from the error object leaks.
    if (error.name === "TimeoutError" || error.name === "AbortError") {
        return LOOKUP_TIMEOUT_MESSAGE;
    }
    if (CALLER_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix)))
        return error.message;
    if (!KNOWN_ERROR_CODES.has(error.message))
        return "request_failed";
    const reason = error instanceof VouchApiError ? error.reason : undefined;
    return reason ? `${error.message}: ${reason}` : error.message;
}

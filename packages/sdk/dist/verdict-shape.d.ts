/**
 * How a verdict word and a data-quality flag are read — written once so the
 * two money paths (`payOrRefuse`, `SpendGuard`) cannot drift apart again.
 *
 * 2026-09-07 added `typeof !== "boolean"` to the `/decision` branch of
 * `payOrRefuse` after a third-party audit paid on `degraded: "true"`. The same
 * fix never reached the payee-score branch or `SpendGuard`, and a 2026-09-08
 * refutation pass measured both still paying on `degraded: "true"` / `1` and on
 * `recommendation: " BLOCK "` — a BLOCK with whitespace around it stopped being
 * a BLOCK, so `requireVet402Allow: false` waived it and signed.
 *
 * The rule these helpers hold:
 *
 *  - **Normalisation is one-way.** Trim and upper-case only when asking "is
 *    this a refusal?". A padded `" ALLOW "` is NOT read as ALLOW — taking an
 *    unrecognised serialisation as permission is the loosening direction, and
 *    a gate that stops money only widens toward refusing.
 *  - **A quality flag we cannot read is not a measurement.** `degraded` must be
 *    an actual boolean and `signalsUnavailable`, when present, an actual array.
 *    Any other shape means the server said something we do not understand, and
 *    an ungraded read is the same as no read at all.
 *
 * These helpers never allow anything. Every one of them answers "must this be
 * refused?", so a `false` return is only ever the absence of THIS reason to
 * refuse — the caller's other gates still have their say.
 */
/**
 * Is this verdict word a BLOCK? Compared after trimming surrounding whitespace
 * and upper-casing, so `" BLOCK "`, `"\tblock\n"` and `"BLOCK"` are one answer.
 * Non-strings are stringified the way the previous inline comparison did, so a
 * broken shape keeps landing in "not a BLOCK, and not an ALLOW either".
 */
export declare function isBlockVerdict(value: unknown): boolean;
/**
 * What is wrong with this score's data-quality fields, if anything?
 *
 * Returns a reason to refuse, or `null` when this particular question found
 * nothing wrong. Three answers, deliberately distinct because the policies
 * treat them differently:
 *
 *  - `"degraded"`   — `degraded` is `true`, or is not a boolean at all. Either
 *                     way there is no gradeable measurement behind the score.
 *  - `"unreadable"` — `signalsUnavailable` is present but is not an array. The
 *                     server said something about measurability in a shape we
 *                     do not understand, which is not the same as saying
 *                     "nothing was unmeasurable". Every fail-closed policy
 *                     denies on this, including `block-only`, which otherwise
 *                     tolerates a partial read.
 *  - `"partial"`    — a real, readable list of inputs that could not be
 *                     measured. `block-only` deliberately allows these.
 *
 * `signalsUnavailable: undefined` stays readable for back-compat with servers
 * predating the field — the API has always sent it, and omission is the one
 * shape already treated as "nothing was unmeasurable".
 */
export declare function scoreQualityDefect(score: {
    degraded?: unknown;
    signalsUnavailable?: unknown;
} | null | undefined): "degraded" | "unreadable" | "partial" | null;
/**
 * A non-null plain object? Arrays, primitives and `null` are not read as a
 * decision body (A1). Moved here from `pay-or-refuse.ts` on 2026-09-08 so
 * {@link decisionResponseDefect} — and through it the demo's two mirrors — asks
 * the same question the money path asks.
 */
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/**
 * The only shape accepted as an x402 `amount`: ASCII digits only (no empty
 * string, sign, decimal point, whitespace, `0x` or exponent).
 *
 * `Number()` reads `"0x10"`, `"1e4"`, `"9999.5"` and `" 10000 "` as numbers
 * inside the ceiling, but **what gets signed is the raw string** — so a gate
 * that measures the parsed number is measuring something the seller never
 * offered. Moved here from `pay-or-refuse.ts` on 2026-09-08, when a refutation
 * pass measured the demo's gate table doing exactly that `Number()` read and
 * printing `10000 units = $0.01` for a 402 that only ever said `"1e4"`.
 */
export declare function isDecimalUnits(amount: unknown): amount is string;
/**
 * What is wrong with a `GET /resources/{id}/decision` response, if anything?
 *
 *  - `"uncatalogued"` — a 404 whose body is a readable `{ error: "not_found" }`.
 *    Not a defect: §3.1 hands the judgement to the 402's payTo and the payee
 *    score for that address. **Every other 404 is unreadable**, and so is every
 *    other status.
 *  - `"unreadable"`   — not reached at all (`status: null`), not a 2xx, or a 2xx
 *    whose body is not a plain object (broken JSON, `null`, `"ok"`, `[]`).
 *    No verdict was read, so there is no verdict to honour.
 *  - `null`           — a usable decision body.
 *
 * Written here because a 2026-09-08 refutation pass measured the demo's gate
 * table folding 400 / 429 / 500 / 503 / timeout / broken-JSON into the *same*
 * branch as a 404 not-found — "fall back to the payee score" — and predicting
 * `would sign and send` on all ten, where `payOrRefuse` refuses on all ten. The
 * branch order below mirrors that function's `/decision` read exactly, and
 * `examples/ethonline-2026-demo/test/gate-parity.test.mjs` runs both against
 * the same 78 worlds so they cannot drift apart again.
 */
export declare function decisionResponseDefect(read: {
    status: number | null;
    body: unknown;
}): "uncatalogued" | "unreadable" | null;

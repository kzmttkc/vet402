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

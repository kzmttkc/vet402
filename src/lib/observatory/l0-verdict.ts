// Public L0 word. Kept out of l0-probe.ts so /sellers can import it without
// loading the probe, which imports the payment lanes.
//
// publishedVerdict is the probe streak only. publicProbeWord is what a page
// or a count may call that streak: a delisted fail streak is withdrawn, not fail.

/** Published-fail gate: fewer consecutive fails than this renders as `unverified`. */
export const MIN_CONSECUTIVE_FAILS_TO_PUBLISH = 2;

/**
 * The verdict a probe streak supports, newest first. A pass passes through.
 * A fail is publishable only when the newest MIN_CONSECUTIVE_FAILS_TO_PUBLISH
 * probes all failed. A single fail stays unverified.
 */
export function publishedVerdict(newestFirst: readonly string[]): "pass" | "fail" | "unverified" {
  const latest = newestFirst[0];
  if (latest === "pass") return "pass";
  if (latest === "fail") {
    let streak = 0;
    for (const v of newestFirst) {
      if (v !== "fail") break;
      streak++;
    }
    return streak >= MIN_CONSECUTIVE_FAILS_TO_PUBLISH ? "fail" : "unverified";
  }
  return "unverified";
}

/** Catalog status written when a complete discovery fetch no longer lists the route. */
export function isCatalogWithdrawn(status: string | null | undefined): boolean {
  return status === "delisted";
}

export type ProbeWord = "pass" | "fail" | "unverified" | "withdrawn";

/**
 * Word a public page or count uses. A pass stays a pass, including on a
 * delisted route. A fail streak on a delisted route is withdrawn.
 */
export function publicProbeWord(status: string | null | undefined, newestFirst: readonly string[]): ProbeWord {
  const verdict = publishedVerdict(newestFirst);
  if (verdict === "fail" && isCatalogWithdrawn(status)) return "withdrawn";
  return verdict;
}

export function tallyProbeWords(
  rows: readonly { status: string; verdicts: readonly string[] }[],
): { pass: number; fail: number; unverified: number; withdrawn: number } {
  const out = { pass: 0, fail: 0, unverified: 0, withdrawn: 0 };
  for (const row of rows) out[publicProbeWord(row.status, row.verdicts)]++;
  return out;
}

/**
 * Paid-attempt statuses other than settled.
 * Same set as PAID_ATTEMPT_STATUSES in reader.ts, minus settled.
 * A test pins the two lists together.
 */
export const NONSETTLED_PAID_ATTEMPT_STATUSES = [
  "settle_failed",
  "delivered_no_receipt",
  "settle_claimed_unverifiable",
  "settle_claimed",
  "settle_claim_refuted",
] as const;

/** A non-settled paid attempt on a delisted route. Settled rows keep the money fact. */
export function purchaseShownAsWithdrawn(
  catalogStatus: string | null | undefined,
  purchaseStatus: string | null | undefined,
): boolean {
  return (
    isCatalogWithdrawn(catalogStatus) &&
    !!purchaseStatus &&
    (NONSETTLED_PAID_ATTEMPT_STATUSES as readonly string[]).includes(purchaseStatus)
  );
}

export const WITHDRAWN_FROM_CATALOG = "withdrawn from the catalog";

/** One public sentence. No first person, no semicolon, no dash. Names the public L0 fail count only. */
export function withdrawnFromCatalogSentence(): string {
  return "Withdrawn from the catalog. This route is absent from a complete fetch of the public discovery catalog, so it is left out of the public L0 fail count.";
}

/** Short note under a purchase row that is shown as withdrawn. */
export function withdrawnL0FailNote(): string {
  return "Left out of the public L0 fail count.";
}

export function withdrawnRoutesHeading(): string {
  return "Withdrawn from the catalog";
}

export function withdrawnRoutesParagraph(): string {
  return `${withdrawnFromCatalogSentence()} These routes are not in the counts above.`;
}

export function withdrawnStateLabel(): string {
  return "Withdrawn from the catalog (delisted, and the newest probes would publish as fail). Left out of the public L0 fail count.";
}

export function withdrawnChainNote(): string {
  return "Fail in this table leaves out routes withdrawn from the catalog. Wdn is that share of n.";
}

export function withdrawnAbbrTitle(): string {
  return "Withdrawn from the catalog";
}

/** Figure 1 caption clause. `n` is the withdrawn segment. */
export function withdrawnBandCountSentence(n: number): string {
  return `${n.toLocaleString()} withdrawn from the catalog are left out of the public L0 fail count.`;
}

/**
 * Reading of the production L0 CSV at retrievedAt, before this wording shipped.
 * published_verdict had no withdrawn value yet. listed=false fail rows are the
 * streaks the delisted rule moves out of the public L0 fail count.
 */
export const L0_CSV_WITHDRAWAL_READING = {
  retrievedAt: "2026-10-23T22:46:17.388Z",
  rows: 85939,
  publishedVerdictFail: 7376,
  listedFail: 2483,
  notListedFail: 4893,
} as const;

/** Past tense. The counts are the retrieval above, not a live query. */
export function catalogWithdrawalCorrectionAction(): string {
  const r = L0_CSV_WITHDRAWAL_READING;
  const n = (v: number) => v.toLocaleString("en-US");
  return [
    "From 2026-10-24 a route absent from a complete fetch of the public discovery catalog is published as withdrawn from the catalog.",
    "It is left out of the public L0 fail count and counted as withdrawnFail on /observatory/state.",
    "Probe rows and purchase rows stay as recorded.",
    "A pass on a delisted route stays a pass.",
    `On the L0 CSV retrieved at ${r.retrievedAt}, published_verdict fail was ${n(r.publishedVerdictFail)} of ${n(r.rows)} rows.`,
    `Of that fail count, ${n(r.listedFail)} rows were still listed and ${n(r.notListedFail)} were not listed.`,
    "/decision stays BLOCK on two consecutive L0 fails, including a route withdrawn from the catalog.",
  ].join(" ");
}

/** Driver may return a text[] as a JS array or as `{fail,fail}`. */
export function parseProbeVerdicts(v: readonly string[] | string | null | undefined): string[] {
  if (v == null) return [];
  if (typeof v !== "string") return [...v];
  const inner = v.replace(/^\{|\}$/g, "");
  return inner === "" ? [] : inner.split(",").map((x) => x.replace(/^"|"$/g, ""));
}

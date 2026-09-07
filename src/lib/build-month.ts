// 2026-09-07 ETHOnline site consistency (F9): the RFC-style header on /, /docs/api,
// /faq and /blog carried a hand-written "August 2026" that outlived the month.
// One source for that slot: the month the page was rendered — build time for a
// static page, request time for a dynamic one. Revision dates on /legal/* are
// facts about the documents and do not come from here.
const MONTH_YEAR_UTC = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "September 2026" — the current month in UTC, in the RFC header's own format. */
export function buildMonth(now: Date = new Date()): string {
  return MONTH_YEAR_UTC.format(now);
}

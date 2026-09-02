/**
 * Escape a string for use INSIDE a LIKE / ILIKE pattern, so `%`, `_` and `\`
 * match themselves. Backslash is Postgres's default escape character, so no
 * ESCAPE clause is needed at the call site.
 *
 * Bound values are not injection — but wildcards inside a bound value still
 * act as wildcards. One rule, two callers: /observatory search
 * (reader.searchLikePattern, 2026-08-22 audit) and the payee/domain reverse
 * lookup (resolve/lookup.ts, 2026-09-02 audit: `a_b.example` matched
 * `axb.example`).
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function logServerError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[vouch] ${context}: ${message}`);
}

/**
 * `.catch(logAndSwallow("ctx"))` — keep the caller alive (the side effect is
 * best-effort) but never make the failure invisible. Replaces the
 * `.catch(() => null)` pattern the 2026-09-02 audit flagged on corrections
 * and decision_lookups.
 */
export function logAndSwallow(context: string): (error: unknown) => undefined {
  return (error) => {
    logServerError(context, error);
    return undefined;
  };
}

/** Recursively sort object keys so the same JSON value always stringifies the same way. */
export function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortKeysDeep(value), null, space);
}

/** Line-level drift count (trailing newlines normalized). */
export function countLineDrift(expected: string, actual: string): number {
  const norm = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);
  const a = norm(expected).split("\n");
  const b = norm(actual).split("\n");
  const max = Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < max; i++) {
    if ((a[i] ?? "") !== (b[i] ?? "")) n++;
  }
  return n;
}
/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 * Numbers and strings follow JSON.stringify / ECMAScript NumberToString rules.
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JcsError";
  }
}

function compareUtf16CodeUnits(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

function serializeNumber(value: number): string {
  if (Number.isNaN(value) || value === Infinity || value === -Infinity) {
    throw new JcsError("Non-finite number");
  }
  return JSON.stringify(value);
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function serialize(value: unknown): string {
  if (value === undefined) {
    throw new JcsError("Top-level undefined");
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) {
      throw new JcsError("Lone surrogate");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new JcsError("Unsupported type");
  }
  if (Array.isArray(value)) {
    return "[" + value.map((entry) => (entry === undefined ? "null" : serialize(entry))).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  keys.sort(compareUtf16CodeUnits);
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") + "}";
}

export function jcsSerialize(value: unknown): string {
  return serialize(value);
}
/** Wave-1 public English rules (no we/our/us, no em/en dash, no semicolon). */
const FORBIDDEN = /\b(we|our|us)\b|[;]|—|–/;

export function assertPublicEnglishSurface(text: string): void {
  if (FORBIDDEN.test(text)) {
    throw new Error("public English surface violates wave-1 rules");
  }
}

export function publicEnglishOk(text: string): boolean {
  return !FORBIDDEN.test(text);
}

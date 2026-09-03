// ============================================================
// 登録簿の check を本番へ当てる本体。取得は注入する（テストで実 API を叩かないため）。
// 読み取り専用 — GET だけ、キーの要らない面だけ。
// ============================================================
import { evaluateAssertion } from "./evaluate";
import type { Claim } from "./yaml";

export type FailedClaim = { id: string; quote: string; expected: string; actual: unknown };
export type CanaryReport = { ok: boolean; checked: number; failed: FailedClaim[] };

export type FetchJson = (url: string) => Promise<unknown>;

/**
 * check を持つ主張だけを評価する。URL は 1 本につき 1 回しか取りに行かない。
 * 取得に失敗した主張は「落ちた主張」として数える（黙って緑にしない）。
 */
export async function runClaimChecks(claims: Claim[], fetchJson: FetchJson): Promise<CanaryReport> {
  const withCheck = claims.filter((c): c is Claim & { check: NonNullable<Claim["check"]> } => c.check !== null);

  const urls = [...new Set(withCheck.map((c) => c.check.url))];
  const bodies = new Map<string, { data?: unknown; error?: string }>();
  await Promise.all(
    urls.map(async (url) => {
      try {
        bodies.set(url, { data: await fetchJson(url) });
      } catch (e) {
        bodies.set(url, { error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  const failed: FailedClaim[] = [];
  for (const c of withCheck) {
    const body = bodies.get(c.check.url)!;
    if (body.error !== undefined) {
      failed.push({ id: c.id, quote: c.quote, expected: c.check.assert, actual: `fetch failed: ${body.error}` });
      continue;
    }
    let result;
    try {
      result = evaluateAssertion(c.check.assert, body.data);
    } catch (e) {
      failed.push({
        id: c.id,
        quote: c.quote,
        expected: c.check.assert,
        actual: `unreadable assertion: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (!result.ok) {
      failed.push({ id: c.id, quote: c.quote, expected: c.check.assert, actual: result.actual });
    }
  }

  return { ok: failed.length === 0, checked: withCheck.length, failed };
}

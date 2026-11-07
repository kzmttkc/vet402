/**
 * Evidence that someone other than vet402 uses it, for the state API's `adoption` (2026-11-08).
 *
 * Two sources, each with its period and read time:
 *  - npm downloads of @vet402/sdk over npm's own last-month window (the npm downloads API),
 *  - keyed decision calls by key owners outside vet402 (owner_relation external or
 *    prezenti_grantee), taken only from the monthly values /api/v1/usage/monthly already
 *    publishes: closed months, chains on the public list, at least 3 owners per group.
 * A figure that cannot be published is left out, field and all. Nothing here can name a user.
 */
import { fetchSdkDownloads } from "@/lib/about/npm-downloads";
import {
  latestPublishableMonth,
  parseMonthlyUsageQuery,
  PUBLIC_USAGE_CHAINS,
  readPublishedMonthlyDecisionUsage,
  type MonthlyDecisionUsage,
} from "@/lib/api/decision-usage";
import { SITE_URL } from "@/lib/site-url";

export type SdkDownloads = {
  package: "@vet402/sdk";
  downloads: number;
  start: string;
  end: string;
  readAt: string;
  source: string;
};

export type KeyedDecisionCalls = {
  chain: string;
  month: string;
  ownerRelation: "external" | "prezenti_grantee";
  owners: number;
  calls: number;
  source: string;
};

export type Adoption = {
  sdkDownloads?: SdkDownloads;
  keyedDecisionCalls?: KeyedDecisionCalls[];
};

const OUTSIDE = new Set(["external", "prezenti_grantee"]);

/** Only groups outside vet402 that the monthly table already publishes with a call count. Exported for tests. */
export function outsideCalls(usage: MonthlyDecisionUsage): KeyedDecisionCalls[] {
  const out: KeyedDecisionCalls[] = [];
  for (const r of usage.relations) {
    if (!r.owner_relation || !OUTSIDE.has(r.owner_relation)) continue;
    if (typeof r.owners !== "number" || typeof r.calls !== "number" || r.calls <= 0) continue;
    out.push({
      chain: usage.chain,
      month: usage.month,
      ownerRelation: r.owner_relation as KeyedDecisionCalls["ownerRelation"],
      owners: r.owners,
      calls: r.calls,
      source: `${SITE_URL}/api/v1/usage/monthly?chain=${encodeURIComponent(usage.chain)}&month=${usage.month}`,
    });
  }
  return out;
}

/** npm-downloads.ts prints "2026-11-07 12:00 UTC" for the page; JSON carries ISO 8601. */
export function isoFromReadAt(readAt: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(readAt);
  return m ? `${m[1]}T${m[2]}:00Z` : readAt;
}

export async function readAdoption(now: Date = new Date()): Promise<Adoption> {
  const month = latestPublishableMonth(now);
  const [downloads, usage] = await Promise.all([
    fetchSdkDownloads(),
    Promise.all(
      PUBLIC_USAGE_CHAINS.map(async (chain) => {
        const query = parseMonthlyUsageQuery(chain, month);
        if (!query.ok) return null;
        return readPublishedMonthlyDecisionUsage(query, now).catch(() => null);
      }),
    ),
  ]);
  const adoption: Adoption = {};
  if (downloads) {
    adoption.sdkDownloads = {
      package: "@vet402/sdk",
      downloads: downloads.downloads,
      start: downloads.start,
      end: downloads.end,
      readAt: isoFromReadAt(downloads.readAt),
      source: "https://api.npmjs.org/downloads/point/last-month/@vet402/sdk",
    };
  }
  const calls = usage.flatMap((u) => (u ? outsideCalls(u) : []));
  if (calls.length > 0) adoption.keyedDecisionCalls = calls;
  return adoption;
}

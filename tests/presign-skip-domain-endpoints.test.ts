// presign / checkSeller 経路: resource 当たりでは endpointsByDomain を読まない（2026-11-28）。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import { resourceId as toResourceId, endpointHash } from "@/lib/ids/canonical";
import { resolve, resolveForRoute } from "@/lib/resolve/lookup";
import { checkSeller } from "@/lib/mcp/tools";
import type { McpDeps } from "@/lib/mcp/tools";

const URL = "https://listed-seller.example/api";
const OTHER = "https://other-on-host.example/x";
const MISS = "https://unknown.example/nope";

function countingDb(hitUrl: string, hostRows: { url: string }[] = []) {
  let domainReads = 0;
  let resourceReads = 0;
  const getId = toResourceId("GET", hitUrl);
  const db = {
    get domainReads() {
      return domainReads;
    },
    get resourceReads() {
      return resourceReads;
    },
    execute: async (q: unknown) => {
      const { PgDialect } = await import("drizzle-orm/pg-core");
      const dialect = new PgDialect();
      const { sql: text, params } = dialect.sqlToQuery(q as Parameters<typeof dialect.sqlToQuery>[0]);
      const flat = text.replace(/\s+/g, " ");
      if (/resource_key LIKE/.test(flat) || (/resource_key = /.test(flat) && /OR/.test(flat))) {
        domainReads++;
        return {
          rows: hostRows.map((r, i) => ({
            observatory_id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
            endpoint_hash: endpointHash(r.url),
            resource_id: toResourceId("GET", r.url),
            canonical_url: r.url,
            method: "GET",
            payee_id: null,
            status: "active",
            first_seen: null,
            last_seen: null,
            network: "eip155:8453",
          })),
        };
      }
      if (/resource_id IN/.test(flat) || (/resource_id = /.test(flat) && !/x402_resource_aliases/.test(flat))) {
        resourceReads++;
        if (params.includes(getId)) {
          return {
            rows: [
              {
                observatory_id: "00000000-0000-0000-0000-000000000099",
                endpoint_hash: endpointHash(hitUrl),
                resource_id: getId,
                canonical_url: hitUrl,
                method: "GET",
                payee_id: null,
                status: "active",
                first_seen: null,
                last_seen: null,
                network: "eip155:8453",
              },
            ],
          };
        }
        return { rows: [] };
      }
      if (/x402_resource_aliases/.test(flat)) return { rows: [] };
      return { rows: [] };
    },
  };
  return db;
}

afterEach(() => {
  __setDbForTests(null);
});

test("skipDomainEndpointsOnResourceHit: 当たりでは endpointsByDomain を読まない", async () => {
  const db = countingDb(URL, [{ url: OTHER }]);
  __setDbForTests(db as never);
  const r = await resolve(URL, { skipDomainEndpointsOnResourceHit: true });
  assert.ok(r.resource);
  assert.equal(r.endpoints, undefined);
  assert.equal(db.domainReads, 0);
  assert.equal(db.resourceReads, 1);
});

test("skipDomainEndpointsOnResourceHit: 外れでは endpoints を読み、公開 resolve と同じ形", async () => {
  const dbSkip = countingDb(URL, [{ url: OTHER }]);
  __setDbForTests(dbSkip as never);
  const skipped = await resolve(MISS, { skipDomainEndpointsOnResourceHit: true });
  assert.equal(dbSkip.domainReads, 1, "resource が外れたあと domain を 1 本読む");
  const dbDefault = countingDb(URL, [{ url: OTHER }]);
  __setDbForTests(dbDefault as never);
  const normal = await resolve(MISS);
  const { disclaimer: _a, ...skipBody } = skipped;
  const { disclaimer: _b, ...normalBody } = normal;
  assert.deepEqual(skipBody, normalBody, "外れの応答は公開 resolve と同じ");
});

test("公開 resolve（オプションなし）: 当たっても endpoints を並列で読む", async () => {
  const hostRows = [{ url: OTHER }];
  const db = countingDb(URL, hostRows);
  __setDbForTests(db as never);
  const r = await resolve(URL);
  assert.ok(r.resource);
  assert.equal(r.endpoints?.length, 1);
  assert.equal(db.domainReads, 1);
  assert.equal(db.resourceReads, 1);
});

test("resolveForRoute: オプションなしの URL は従来どおり", async () => {
  const hostRows = [{ url: OTHER }];
  const db = countingDb(URL, hostRows);
  __setDbForTests(db as never);
  const { result, usageNetwork } = await resolveForRoute(URL);
  assert.ok(result.resource);
  assert.equal(result.endpoints?.length, 1);
  assert.equal(usageNetwork, "eip155:8453");
  assert.equal(db.domainReads, 1);
});

test("checkSeller: resource 当たりの成功応答は endpoints を使わない（same_host_listings は空）", async () => {
  const db = countingDb(URL, [{ url: OTHER }]);
  __setDbForTests(db as never);
  const deps: Pick<McpDeps, "resolve" | "resolveForRoute" | "decide" | "l1Purchases"> = {
    resolve: (q, opts) => resolve(q, opts),
    resolveForRoute: (q, opts) => resolveForRoute(q, opts),
    decide: async () =>
      ({
        recommendation: "proceed",
        reason_codes: [],
        reasons: [],
        facts: { l1: { n_attempts: 0, n_delivered: 0, last_attempt_at: null }, l0: { status: "unknown" }, payees: [] },
        verified_terms: null,
        verified_pay_to_by_network: [],
        spending_halted: null,
        refunds: null,
        freshness: { l0: null, l1: null, l2: null },
        scoredAt: "2026-11-28T00:00:00.000Z",
        rules_version: "test",
        l1_basis: { n_paid_undelivered: 0 },
        evidence_age: null,
      }) as never,
    l1Purchases: async () => [],
  };
  const out = await checkSeller(deps, { url: URL });
  assert.equal(out.not_in_catalog, false);
  assert.deepEqual(out.same_host_listings, []);
  assert.equal(db.domainReads, 0);
});
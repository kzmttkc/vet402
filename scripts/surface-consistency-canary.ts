#!/usr/bin/env tsx
// ============================================================
// 面の間のずれを毎日機械で突き合わせる計器（surface-consistency canary）。
//
//   npx tsx scripts/surface-consistency-canary.ts [--out report.json] [--max 60]
//
// 同じ出品について、面ごとに言うことが違うかを見る。監査の周回で人が見つけていた
// 「/decision は BLOCK、売り手頁は not tried」「記録頁は L2 mismatch、判定は数えない」の類を、ここで毎日拾う。
//
// 面: /api/v1/resources/{id}/decision・MCP の check_resource_decision と同じ呼び出し（packages/mcp-server の
// resourceDecision をそのまま使う: url → /resolve → /decision）・/api/v1/sellers/export.csv・/sellers/{host}・
// /observatory/e/{id}・/api/v1/observatory/export.csv・/api/v1/observatory/l0/export.csv・
// 理由コードの一覧（/docs/api#reason-codes・/openapi.yaml・/llms.txt・/llms-full.txt）。
//
// **実装を見ない**: src/lib/decision・src/lib/sellers は import しない。本番が返す文字列だけを比べるので、
// 判定・/sellers・export・MCP の分類がどう組まれていても（1 つの関数に寄せる前でも後でも）動く。
//
// 読み取りのみ（GET だけ・鍵なし）。要求は 1 秒に 1 回以下、鍵なしの /decision は 10 回/分の枠の内側
// （6.5 秒に 1 回）。429・503 は Retry-After を待って 3 回まで取り直す。
// 緑にしない条件（fail-loud）: 食い違いが 1 件でもある・取れた面が 0・比べた項目が 0・標本が 40 未満・
// 必須の型（L1 の失敗・L2 mismatch・L2 not_checked・未プローブ・path_template）か区分（ALLOW/WARN/BLOCK）が欠ける・
// 一度も比べなかった項目がある・面の取得の失敗が 10% を超える。exit 1。
// ============================================================
import { writeFileSync } from "node:fs";
import {
  parseCsv,
  parseDocsReasonTable,
  parseLlmsText,
  parseOpenApiReasonCodes,
  parseRecordPage,
  parseSellerHostPage,
  type SellerListing,
} from "../src/lib/surface-canary/parse";
import {
  buildReport,
  type DecisionBody,
  type Fetched,
  type ListingInput,
  type McpView,
  type Registry,
  type SurfaceTally,
} from "../src/lib/surface-canary/compare";
import { buildPools, PoolCursor, seedFor, TYPES_FOR_VERDICT, type Candidate, type SampleType } from "../src/lib/surface-canary/sample";
// MCP の道具が叩く呼び出しそのもの（index.ts はサーバを起動するので import しない。応答の写し方は下の mcpView）。
import { resourceDecision } from "../packages/mcp-server/src/resource-decision";
import { refusalReasonCodes } from "../packages/mcp-server/src/decision";

const BASE = (process.env.VET402_BASE_URL ?? "https://vet402.com").replace(/\/$/, "");
const UA = "vet402-surface-consistency-canary";
const MIN_GAP_MS = 1_100; // 1 秒に 1 回以下
const DECISION_GAP_MS = 6_500; // 鍵なし /decision は 10 回/分
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const MAX_SELLER_PAGES = 4;

const argOf = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MAX_SAMPLE = Math.min(60, Number(argOf("--max") ?? 60));
const OUT = argOf("--out");

// ---- 間隔と取り直しを全要求（MCP のクライアントの要求を含む）に掛ける ----------------------------
const realFetch = globalThis.fetch.bind(globalThis);
let lastAt = 0;
let lastDecisionAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isDecision = /\/api\/v1\/resources\/[0-9a-f]{64}\/decision/.test(url);
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(lastAt + MIN_GAP_MS, isDecision ? lastDecisionAt + DECISION_GAP_MS : 0) - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    if (isDecision) lastDecisionAt = lastAt;
    const headers = new Headers(init?.headers);
    headers.set("user-agent", UA);
    const res = await realFetch(input, { ...init, headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("ratelimit-reset"));
      const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Number.isFinite(reset) && reset > 1e9 ? reset * 1000 - Date.now() : 15_000;
      await sleep(Math.min(Math.max(backoff, 2_000), 90_000));
      continue;
    }
    return res;
  }
};

// ---- 取得と数え --------------------------------------------------------------------------------
const tally: SurfaceTally = { attempted: 0, fetched: 0, failed: [] };

async function getText(path: string): Promise<{ body: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "*/*" } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 120).replace(/\s+/g, " ")}`);
  return { body, headers: res.headers };
}

async function surface<T>(name: string, listing: string, f: () => Promise<T>): Promise<Fetched<T>> {
  tally.attempted++;
  try {
    const value = await f();
    tally.fetched++;
    return { ok: true, value };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    tally.failed.push({ surface: name, listing, error });
    return { ok: false, error };
  }
}

const must = <T>(v: T | null, what: string): T => {
  if (v === null) throw new Error(`${what}: unreadable (the page or file did not have the expected shape)`);
  return v;
};

/** check_resource_decision の応答のうち、道具が呼び手に渡す判定の部分（packages/mcp-server/src/index.ts と同じ写し方）。 */
function mcpView(outcome: Awaited<ReturnType<typeof resourceDecision>>): McpView {
  if (outcome.kind === "uncatalogued")
    return { resourceId: "(uncatalogued)", decision: "REFUSE", refuseReasons: ["resource_uncatalogued"], measurement: {} };
  const result = outcome.result;
  const allow = result.recommendation === "ALLOW" && !result.degraded;
  const refusal = allow ? [] : refusalReasonCodes(result.reason_codes);
  if (!allow && result.degraded && !refusal.includes("degraded_measurement")) refusal.push("degraded_measurement");
  if (!allow && refusal.length === 0) refusal.push("recommendation_not_allow");
  return { resourceId: outcome.resourceId, decision: allow ? "ALLOW_PAY" : "REFUSE", refuseReasons: refusal, measurement: result as unknown as DecisionBody };
}

async function main() {
  // MCP のクライアントは本番へ鍵なしで（払う経路に近い鍵をこの計器に渡さない）。間隔待ちで時間切れにならないよう長めに。
  process.env.VOUCH_API_URL = `${BASE}/api/v1`;
  delete process.env.VOUCH_API_KEY;
  process.env.VOUCH_TIMEOUT_MS = String(10 * 60_000);

  const started = new Date();
  const g = "(global)";
  const sellersCsv = await surface("sellers", g, async () => parseCsv((await getText("/api/v1/sellers/export.csv")).body));
  const ledgerCsv = await surface("ledger", g, async () => {
    const r = await getText("/api/v1/observatory/export.csv?days=90");
    return { rows: parseCsv(r.body), retrievedAt: r.headers.get("x-vet402-retrieved-at") };
  });
  const l0Csv = await surface("l0", g, async () => parseCsv((await getText("/api/v1/observatory/l0/export.csv")).body));
  const docs = await surface("docs", g, async () => must(parseDocsReasonTable((await getText("/docs/api")).body), "/docs/api#reason-codes"));
  const openapi = await surface("openapi", g, async () => must(parseOpenApiReasonCodes((await getText("/openapi.yaml")).body), "/openapi.yaml DecisionReasonCode"));
  const llms: Registry["llms"] = [];
  for (const name of ["llms.txt", "llms-full.txt"]) {
    const t = await surface(name, g, async () => parseLlmsText((await getText(`/${name}`)).body));
    if (t.ok === true) llms.push({ name, ...t.value });
  }
  const registry: Registry = {
    docs: docs.ok === true ? docs.value : null,
    openapi: openapi.ok === true ? openapi.value : null,
    llms,
  };

  const listings: ListingInput[] = [];
  const unresolved: string[] = [];
  if (sellersCsv.ok === true && ledgerCsv.ok === true && l0Csv.ok === true) {
    const sellersById = new Map(sellersCsv.value.map((r) => [r.endpoint_id, r]));
    const l0ById = new Map(l0Csv.value.map((r) => [r.endpoint_id, r]));
    // 台帳の行はその出品の resource_key と network で引く。network が空の行（402 の前に止まった no_eligible_accept 等）は、
    // その resource_key の endpoint が l0 export に 1 つしか無いときだけ、その出品の行に数える。
    const endpointsPerKey = new Map<string, number>();
    for (const r of l0Csv.value) endpointsPerKey.set(r.resource_key, (endpointsPerKey.get(r.resource_key) ?? 0) + 1);
    const ledgerByKey = new Map<string, Record<string, string>[]>();
    const ledgerByPurchase = new Map<string, Record<string, string>>();
    for (const r of ledgerCsv.value.rows) {
      if (r.purchase_id) ledgerByPurchase.set(r.purchase_id, r);
      const k = `${r.resource_key}|${r.network}`;
      (ledgerByKey.get(k) ?? ledgerByKey.set(k, []).get(k)!).push(r);
    }
    const ledgerRowsOf = (c: Candidate, latestPurchaseId: string | undefined) => {
      const rows = [...(ledgerByKey.get(`${c.resourceKey}|${c.network}`) ?? [])];
      if (endpointsPerKey.get(c.resourceKey) === 1) rows.push(...(ledgerByKey.get(`${c.resourceKey}|`) ?? []));
      const latest = latestPurchaseId ? ledgerByPurchase.get(latestPurchaseId) : undefined;
      if (latest && latest.resource_key === c.resourceKey && !rows.includes(latest)) rows.push(latest);
      return rows;
    };
    const pools = buildPools({
      sellers: sellersCsv.value,
      l0: l0Csv.value,
      ledger: ledgerCsv.value.rows,
      now: started.getTime(),
      seed: seedFor(started.toISOString().slice(0, 10)),
    });
    const cursor = new PoolCursor(pools);
    const hostEndpoints = new Map<string, Map<string, string>>();
    const sellerPages = new Map<string, { page: number; listings: Map<string, SellerListing>; hasNext: boolean }[]>();

    const resolveId = async (c: Candidate): Promise<string | null> => {
      if (!hostEndpoints.has(c.host)) {
        const m = new Map<string, string>();
        try {
          const r = JSON.parse((await getText(`/api/v1/resolve?q=${encodeURIComponent(c.host)}`)).body) as { endpoints?: { observatory_id?: string; resource_id?: string }[] };
          for (const e of r.endpoints ?? []) if (e.observatory_id && e.resource_id) m.set(e.observatory_id, e.resource_id);
        } catch {
          /* 下で URL から引き直す */
        }
        hostEndpoints.set(c.host, m);
      }
      const hit = hostEndpoints.get(c.host)!.get(c.observatoryId);
      if (hit) return hit;
      try {
        const r = JSON.parse((await getText(`/api/v1/resolve?q=${encodeURIComponent(`https://${c.resourceKey}`)}`)).body) as {
          resource?: { observatory_id?: string; resource_id?: string } | null;
          endpoints?: { observatory_id?: string; resource_id?: string }[];
        };
        const all = [r.resource, ...(r.endpoints ?? [])].filter(Boolean) as { observatory_id?: string; resource_id?: string }[];
        return all.find((e) => e.observatory_id === c.observatoryId)?.resource_id ?? null;
      } catch {
        return null;
      }
    };

    const sellerListing = async (c: Candidate): Promise<SellerListing | null> => {
      const pages = sellerPages.get(c.host) ?? [];
      sellerPages.set(c.host, pages);
      for (const p of pages) if (p.listings.has(c.observatoryId)) return p.listings.get(c.observatoryId)!;
      while (pages.length < MAX_SELLER_PAGES && (pages.length === 0 || pages[pages.length - 1]!.hasNext)) {
        const n = pages.length + 1;
        const html = (await getText(`/sellers/${encodeURIComponent(c.host)}${n > 1 ? `?page=${n}` : ""}`)).body;
        const parsed = must(parseSellerHostPage(html), `/sellers/${c.host}?page=${n}`);
        pages.push({ page: n, listings: parsed.listings, hasNext: parsed.hasNextPage });
        if (parsed.listings.has(c.observatoryId)) return parsed.listings.get(c.observatoryId)!;
      }
      return null;
    };

    const take = async (c: Candidate) => {
      const rid = await resolveId(c);
      if (!rid) {
        unresolved.push(`${c.resourceKey} (${c.observatoryId})`);
        return;
      }
      const decision = await surface("decision", c.resourceKey, async () => {
        const body = JSON.parse((await getText(`/api/v1/resources/${rid}/decision?role=payer`)).body) as DecisionBody;
        if (!body.recommendation) throw new Error("no recommendation in the body");
        return body;
      });
      const canonical = decision.ok === true ? decision.value.subject?.canonical_url : undefined;
      const mcp = await surface("mcp", c.resourceKey, async () =>
        mcpView(await resourceDecision(canonical ? { url: canonical } : { resourceId: rid }, { role: "payer" })),
      );
      const record = await surface("record", c.resourceKey, async () =>
        must(parseRecordPage((await getText(`/observatory/e/${c.observatoryId}`)).body), `/observatory/e/${c.observatoryId}`),
      );
      const sRow = sellersById.get(c.observatoryId);
      const sellersRow: Fetched<Record<string, string>> = sRow
        ? { ok: true, value: sRow }
        : { ok: "n/a", why: c.network === "eip155:8453" ? "not in /api/v1/sellers/export.csv" : "sellers covers Base only" };
      let sellerPage: Fetched<SellerListing> = { ok: "n/a", why: "not in the sellers export" };
      if (sRow) {
        const got = await surface("seller_page", c.resourceKey, () => sellerListing(c));
        sellerPage = got.ok === true ? (got.value ? { ok: true, value: got.value } : { ok: "n/a", why: `not on the first ${MAX_SELLER_PAGES} pages` }) : got;
      }
      const l0Row = l0ById.get(c.observatoryId);
      listings.push({
        observatoryId: c.observatoryId,
        resourceKey: c.resourceKey,
        network: c.network,
        types: c.types,
        decision,
        mcp,
        sellersRow,
        sellerPage,
        record,
        ledgerRows: { ok: true, value: ledgerRowsOf(c, sRow?.purchase_id) },
        ledgerRetrievedAt: ledgerCsv.value.retrievedAt,
        l0Row: l0Row ? { ok: true, value: l0Row } : { ok: "n/a", why: "not in l0 export" },
      });
      const v = decision.ok === true ? decision.value.recommendation : decision.ok === false ? `error: ${decision.error}` : "n/a";
      console.error(`  [${listings.length}] ${c.types.join("+")} ${c.resourceKey} → ${v}`);
    };

    // 型ごとの割り当て（合計 43）→ 区分の不足を足す（上限 MAX_SAMPLE）
    const QUOTA: Partial<Record<SampleType, number>> = {
      l1_failure: 6, l2_mismatch: 6, l2_not_checked: 6, unprobed: 5, path_template: 5, delivered: 6, l0_fail: 5, not_bought: 2, pending: 2,
    };
    const left = { ...QUOTA };
    for (let progressed = true; progressed && listings.length < MAX_SAMPLE; ) {
      progressed = false;
      for (const ty of Object.keys(left) as SampleType[]) {
        if ((left[ty] ?? 0) <= 0 || listings.length >= MAX_SAMPLE) continue;
        const c = cursor.next(ty);
        if (!c) {
          left[ty] = 0;
          continue;
        }
        left[ty]!--;
        progressed = true;
        await take(c);
      }
    }
    for (const verdict of ["ALLOW", "WARN", "BLOCK"]) {
      for (let tries = 0; tries < 8 && listings.length < MAX_SAMPLE; tries++) {
        const have = listings.filter((l) => l.decision.ok === true && l.decision.value.recommendation === verdict).length;
        if (have >= 3) break;
        const ty = TYPES_FOR_VERDICT[verdict]!.find((t) => cursor.size(t) > 0);
        const c = ty ? cursor.next(ty) : null;
        if (!c) break;
        await take(c);
      }
    }
  }

  const report = buildReport({ listings, registry, tally });
  const out = {
    ...report,
    base: BASE,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    unresolved,
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));

  for (const d of report.discrepancies.slice(0, 60)) {
    console.log(`✖ [${d.item}/${d.rule}] ${d.listing}${d.observatoryId ? ` (${d.observatoryId})` : ""}`);
    for (const v of d.values) console.log(`    ${v.surface}: ${typeof v.value === "string" ? v.value : JSON.stringify(v.value)}`);
    if (d.detail) console.log(`    — ${d.detail}`);
  }
  if (report.discrepancies.length > 60) console.log(`  … and ${report.discrepancies.length - 60} more (see --out)`);
  for (const f of report.surfaces.failedList.slice(0, 20)) console.log(`  ! fetch failed: ${f.surface} ${f.listing}: ${f.error}`);
  if (unresolved.length) console.log(`  ! not resolvable through /api/v1/resolve (skipped): ${unresolved.join(", ")}`);
  const byRule = new Map<string, number>();
  for (const d of report.discrepancies) byRule.set(`${d.item}/${d.rule}`, (byRule.get(`${d.item}/${d.rule}`) ?? 0) + 1);
  if (byRule.size) console.log(`  discrepancies by rule: ${[...byRule].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  console.log(
    `${report.ok ? "✔" : "✖"} surface-canary: ${report.sampled} listings (${Object.entries(report.byVerdict).map(([k, n]) => `${k} ${n}`).join(" · ")}), ` +
      `${report.surfaces.fetched}/${report.surfaces.attempted} surfaces fetched, ${report.compared} items compared, ` +
      `${report.discrepancies.length} discrepancies, ${report.skipped} skipped` +
      (report.ok ? "." : ` — FAIL: ${report.failReasons.join("; ")}`),
  );
  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`surface-canary failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});

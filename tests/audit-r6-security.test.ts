// ============================================================
// 2026-09-29 監査 6 周目（攻撃者の立場）の純関数・DB なしの検査。
//   1. 登録ドメイン（eTLD+1）: 売り手の日次上限の 3 つ目の単位（お金）。SQL との一致は audit-r6-security.pg.test.ts。
//   2. 問い合わせの数え方: 鍵ありだけ・別サイトから／売り手頁からの自動の呼び出しは数えない。
//   3. CSV injection: `=` `+` `-` `@`・タブ・CR で始まるセルに `'`。URL として読めない resource は取り込まない。
//   4. export: 知らないクエリは 400、days は正規の形だけ（それ以外は 308）。
//   5. corrections のカーソル: 暦に無い日付は 400（往復で比べる）。
//   6. IP の枠: IPv6 は /64 に丸める（ipCounterKey と共用）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { POOLED_SUFFIXES, PUBLIC_SUFFIXES, registeredDomainOf } from "@/lib/observatory/registered-domain";
import { DOMAIN_DAILY_CAP_USD_DEFAULT, domainDailyCapUnits } from "@/lib/observatory/budget";
import { sellerDomainOf } from "@/lib/observatory/l1-runner";
import {
  KEYED_CALLER_HASH_PREFIX,
  isUncountedLookupRequest,
  lookupCallerHash,
  lookupCallerMaterial,
} from "@/lib/decision/lookup-caller";
import { csvCell, csvLines } from "@/lib/util/csv-write";
import { fetchFullCatalog, isImportableResourceUrl } from "@/lib/observatory/catalog-source";
import { decodeCorrectionCursor, encodeCorrectionCursor } from "@/lib/observatory/corrections";
import { ipBucketKey } from "@/lib/api/ip-rate-limit";
import { rejectUnknownQuery } from "@/lib/api/export-guard";

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

// ---------- 1. 登録ドメイン ----------

test("登録ドメイン: 普通のドメインはサブドメインを畳む（a1.evil.com と a2.evil.com は同じ持ち主）", () => {
  assert.equal(registeredDomainOf("a1.evil.com"), "evil.com");
  assert.equal(registeredDomainOf("x.y.z.evil.com"), "evil.com");
  assert.equal(registeredDomainOf("evil.com"), "evil.com");
  assert.equal(registeredDomainOf("API.Evil.COM"), "evil.com");
  assert.equal(registeredDomainOf("api.evil.com:8443"), "evil.com");
  assert.equal(registeredDomainOf("api.evil.com."), "evil.com");
  assert.equal(registeredDomainOf("localhost"), "localhost");
  assert.equal(registeredDomainOf(""), "");
});

test("登録ドメイン: 共有ドメインは 1 つ下が持ち主（本番に実在する形）", () => {
  const cases: [string, string][] = [
    ["aegis-api.kadopi.workers.dev", "kadopi.workers.dev"],
    ["agent-api-production.tim1712.workers.dev", "tim1712.workers.dev"],
    ["402timezones.vercel.app", "402timezones.vercel.app"],
    ["2s-3cpr6qm6j-alleyford.vercel.app", "2s-3cpr6qm6j-alleyford.vercel.app"],
    ["a2a-verifier-production.up.railway.app", "a2a-verifier-production.up.railway.app"],
    ["foo.railway.app", "foo.railway.app"],
    ["svc.onrender.com", "svc.onrender.com"],
    ["ai-data-marketplace-1042299154756.us-central1.run.app", "ai-data-marketplace-1042299154756.us-central1.run.app"],
    ["artifactguard-kl4hfo6j2q-as.a.run.app", "artifactguard-kl4hfo6j2q-as.a.run.app"],
    ["aep-api.fly.dev", "aep-api.fly.dev"],
    ["agent-a2a-payment-mk77y.ondigitalocean.app", "agent-a2a-payment-mk77y.ondigitalocean.app"],
    ["agent.atinamos.co.uk", "atinamos.co.uk"],
    ["agent402.co.uk", "agent402.co.uk"],
    ["node-starter--maxujon18.replit.app", "node-starter--maxujon18.replit.app"],
    ["location-resolver.victoriousbush-c7c267a1.westus2.azurecontainerapps.io", "victoriousbush-c7c267a1.westus2.azurecontainerapps.io"],
    ["atq6wtkp6k.execute-api.us-east-1.amazonaws.com", "atq6wtkp6k.execute-api.us-east-1.amazonaws.com"],
    ["me.github.io", "me.github.io"],
    ["x.lambda-url.us-east-1.on.aws", "x.lambda-url.us-east-1.on.aws"],
  ];
  for (const [host, want] of cases) assert.equal(registeredDomainOf(host), want, host);
  // サフィックスそのものはそれ自身（1 つ下が無い）
  assert.equal(registeredDomainOf("workers.dev"), "workers.dev");
  assert.equal(registeredDomainOf("co.uk"), "co.uk");
  // 共有ドメインの別の持ち主は別の単位
  assert.notEqual(registeredDomainOf("a.alice.workers.dev"), registeredDomainOf("a.bob.workers.dev"));
  // 同じ持ち主の別のワーカーは同じ単位
  assert.equal(registeredDomainOf("w1.alice.workers.dev"), registeredDomainOf("w2.alice.workers.dev"));
});

test("登録ドメイン: トンネル・動的 DNS はサフィックスごとに 1 枠（名前を無料で増やしても枠は増えない・独立レビュー）", () => {
  const cases: [string, string][] = [
    ["x-y-z.trycloudflare.com", "trycloudflare.com"],
    ["a.b.trycloudflare.com", "trycloudflare.com"],
    ["146-190-76-192.sslip.io", "sslip.io"],
    ["biosfera.46-62-215-147.sslip.io", "sslip.io"],
    ["10.0.0.1.nip.io", "nip.io"],
    ["ari001.tailb4ac3a.ts.net", "ts.net"],
    ["apiwitchcraft.duckdns.org", "duckdns.org"],
    ["921273c0412589.lhr.life", "lhr.life"],
    ["abc.localhost.run", "localhost.run"],
    ["prance-mounting-watch.ngrok-free.dev", "ngrok-free.dev"],
    ["x.ngrok-free.app", "ngrok-free.app"],
    ["x.ngrok.io", "ngrok.io"],
    ["x.loca.lt", "loca.lt"],
    ["x.serveo.net", "serveo.net"],
  ];
  for (const [host, want] of cases) assert.equal(registeredDomainOf(host), want, host);
  for (const p of POOLED_SUFFIXES) {
    assert.ok(!PUBLIC_SUFFIXES.includes(p), `表に無い: ${p}`);
    assert.equal(p.split(".").length, 2, p);
    // 境界: 1 つ下・2 つ下・サフィックスそのもの・末尾のドット・大文字・ポートは全部同じ 1 枠
    for (const h of [`a.${p}`, `b.${p}`, `x.y.${p}`, p, `a.${p}.`, `a.${p}..`, `A.${p.toUpperCase()}`, `a.${p}:8443`]) {
      assert.equal(registeredDomainOf(h), p, h);
    }
    // 境界: 似た名前の別ドメイン・トンネル名を前に付けた別ドメインは巻き込まない
    assert.equal(registeredDomainOf(`a.x${p}`), `x${p}`);
    assert.equal(registeredDomainOf(`a.${p}.evil.com`), "evil.com");
  }
  // 別のトンネルどうしは別の枠
  assert.notEqual(registeredDomainOf("a.trycloudflare.com"), registeredDomainOf("a.sslip.io"));
});

test("登録ドメイン: 末尾のドットは何個でも落とす（SQL の rtrim と同じ）", () => {
  assert.equal(registeredDomainOf("api.evil.com.."), "evil.com");
  assert.equal(registeredDomainOf("a.alice.workers.dev..."), "alice.workers.dev");
});

test("登録ドメイン: 表に無い共有ドメインは 2 段で数える（上限が締まる側・払いすぎない）", () => {
  assert.equal(registeredDomainOf("a.unknownhost.example"), "unknownhost.example");
  assert.equal(registeredDomainOf("b.unknownhost.example"), "unknownhost.example");
});

test("登録ドメイン: IP リテラルはホストそのもの", () => {
  assert.equal(registeredDomainOf("93.184.216.34"), "93.184.216.34");
  assert.equal(registeredDomainOf("[2001:db8::1]"), "[2001:db8::1]");
  assert.notEqual(registeredDomainOf("10.0.0.1"), registeredDomainOf("10.0.0.2"));
});

test("登録ドメイン: 表の各項目は SQL に埋めてよい形（英小文字・数字・ハイフン・*）", () => {
  for (const s of PUBLIC_SUFFIXES) assert.match(s, /^(\*|[a-z0-9-]+)(\.(\*|[a-z0-9-]+))+$/, s);
});

test("sellerDomainOf: resource URL から（ポート・大文字を無視）", () => {
  assert.equal(sellerDomainOf("https://A1.Evil.com:8443/api?x=1"), "evil.com");
  assert.equal(sellerDomainOf("https://w.alice.workers.dev/x"), "alice.workers.dev");
});

test("登録ドメインの日次上限: 既定 $3・環境変数で変更・壊れた値は既定・$25 で頭打ち", () => {
  assert.equal(DOMAIN_DAILY_CAP_USD_DEFAULT, 3);
  withEnv("L1_DOMAIN_DAILY_CAP_USD", undefined, () => assert.equal(domainDailyCapUnits(), 3_000_000n));
  withEnv("L1_DOMAIN_DAILY_CAP_USD", "0", () => assert.equal(domainDailyCapUnits(), 0n));
  withEnv("L1_DOMAIN_DAILY_CAP_USD", "1.5", () => assert.equal(domainDailyCapUnits(), 1_500_000n));
  withEnv("L1_DOMAIN_DAILY_CAP_USD", "abc", () => assert.equal(domainDailyCapUnits(), 3_000_000n));
  withEnv("L1_DOMAIN_DAILY_CAP_USD", "-1", () => assert.equal(domainDailyCapUnits(), 3_000_000n));
  withEnv("L1_DOMAIN_DAILY_CAP_USD", "999", () => assert.equal(domainDailyCapUnits(), 25_000_000n));
});

// ---------- 2. 問い合わせの数え方 ----------

test("問い合わせ: 鍵なしは数えない・鍵ありは鍵の持ち主（独立レビュー: 1 人が鍵を 10 本持てる）", () => {
  assert.equal(lookupCallerMaterial({ ip: "203.0.113.7" }), null);
  assert.equal(lookupCallerMaterial({ apiKeyId: null, ip: "2001:db8::1" }), null);
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1" }), "owner:u1");
  // 同じ持ち主の別の鍵は同じ材料（別々の呼び手に数えない）
  assert.equal(lookupCallerMaterial({ apiKeyId: "k2", ownerId: "u1" }), "owner:u1");
  assert.equal(lookupCallerMaterial({ apiKeyId: "k3", ownerId: "u1" }), "owner:u1");
  assert.notEqual(lookupCallerMaterial({ apiKeyId: "k4", ownerId: "u2" }), "owner:u1");
  // 持ち主が分からない鍵は数えない（鍵 id へ戻さない）
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1" }), null);
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "" }), null);
});

test("問い合わせ: 別サイトから（Sec-Fetch-Site: cross-site）と売り手頁からの自動の呼び出しは、鍵ありでも数えない", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ "sec-fetch-site": "cross-site" }) }), null);
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ "Sec-Fetch-Site": "Cross-Site" }) }), null);
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ referer: "https://vet402.com/sellers" }) }), null);
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ referer: "https://www.vet402.com/sellers/base?x=1" }) }), null);
  // 数える: API の呼び手（ヘッダ無し）・同じサイト・別の頁・似た名前の別ドメイン
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({}) }), "owner:u1");
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ "sec-fetch-site": "same-origin" }) }), "owner:u1");
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ referer: "https://vet402.com/docs/api" }) }), "owner:u1");
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ referer: "https://vet402.com.evil.example/sellers" }) }), "owner:u1");
  assert.equal(lookupCallerMaterial({ apiKeyId: "k1", ownerId: "u1", headers: h({ referer: "https://vet402.com/sellersx" }) }), "owner:u1");
  assert.equal(isUncountedLookupRequest(h({ referer: "not a url" })), false);
  assert.equal(isUncountedLookupRequest(null), false);
});

test("問い合わせの HMAC: 持ち主の呼び手は日をまたいで同じ値（k2: 付き）、IP は日ごとに別の値", () => {
  withEnv("API_KEY_PEPPER", "p".repeat(40), () => {
    assert.equal(KEYED_CALLER_HASH_PREFIX, "k2:", "鍵 id で数えた k1: の行は数えない");
    const d1 = lookupCallerHash("owner:u1", "2026-09-29");
    assert.ok(d1.startsWith(KEYED_CALLER_HASH_PREFIX));
    assert.equal(d1, lookupCallerHash("owner:u1", "2026-09-30"), "別々の持ち主の数を 7 日の窓で数えるため");
    assert.notEqual(d1, lookupCallerHash("owner:u2", "2026-09-29"));
    assert.ok(!d1.slice(KEYED_CALLER_HASH_PREFIX.length).includes("u1"), "生の持ち主 id を含まない");
    // 初版の材料（key:）はもう持ち主の行にならない
    assert.ok(!lookupCallerHash("key:k1", "2026-09-29").startsWith(KEYED_CALLER_HASH_PREFIX));
    assert.notEqual(lookupCallerHash("ip:1.2.3.4", "2026-09-29"), lookupCallerHash("ip:1.2.3.4", "2026-09-30"));
    assert.ok(!lookupCallerHash("ip:1.2.3.4", "2026-09-29").startsWith(KEYED_CALLER_HASH_PREFIX));
  });
});

// ---------- 3. CSV injection ----------

test("csvCell: 式として読まれる先頭に ' を付ける（= + - @ タブ CR）", () => {
  assert.equal(csvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell("\rx"), `"'\rx"`);
  assert.equal(csvCell("=1,2"), `"'=1,2"`);
  // 付けない: 数・数の形の文字列・普通の値
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell(-5n), "-5");
  assert.equal(csvCell("-1"), "-1");
  assert.equal(csvCell("-0.25"), "-0.25");
  assert.equal(csvCell("1000000"), "1000000");
  assert.equal(csvCell("seller.example/api"), "seller.example/api");
  assert.equal(csvCell("a=b"), "a=b");
  assert.equal(csvLines(["a", "b"], [{ a: "=x", b: 1 }]), "a,b\n'=x,1\n");
});

test("カタログの取り込み: URL として読めない resource は捨てる", async () => {
  assert.equal(isImportableResourceUrl("https://seller.example/api"), true);
  assert.equal(isImportableResourceUrl("http://seller.example/api"), true);
  assert.equal(isImportableResourceUrl('=HYPERLINK("https://evil","x")'), false);
  assert.equal(isImportableResourceUrl("+https://evil.example/"), false);
  assert.equal(isImportableResourceUrl("javascript:alert(1)"), false);
  assert.equal(isImportableResourceUrl("https://a.example/x y"), false);
  assert.equal(isImportableResourceUrl("https://a.example/\tx"), false);
  assert.equal(isImportableResourceUrl(" https://a.example/"), false);
  assert.equal(isImportableResourceUrl(""), false);
  const items = [
    { resource: "https://ok.example/api", accepts: [{ network: "eip155:8453", payTo: "0x" + "11".repeat(20) }] },
    { resource: '=HYPERLINK("https://evil.example","click")', accepts: [] },
    { resource: "-2+3", accepts: [] },
  ];
  const got = await fetchFullCatalog({
    fetchImpl: async () => new Response(JSON.stringify({ items, pagination: { total: items.length } }), { status: 200 }),
    sleepMs: 0,
  });
  assert.deepEqual(got.items.map((i) => i.resourceUrl), ["https://ok.example/api"]);
  assert.equal(got.fetchedCount, 3, "受け取った件数には数える（complete の判定は変えない）");
  assert.equal(got.complete, true);
});

// ---------- 4. export のクエリ ----------

test("export のクエリ: 知らない名前・重複は 400、許可した名前だけなら null", async () => {
  const bad = rejectUnknownQuery(new URLSearchParams("cb=123"), ["days"], {});
  assert.equal(bad?.status, 400);
  assert.deepEqual(await bad?.json(), { error: "invalid_query", allowed: ["days"] });
  assert.equal(rejectUnknownQuery(new URLSearchParams("days=1&days=2"), ["days"], {})?.status, 400);
  assert.equal(rejectUnknownQuery(new URLSearchParams("x"), [], {})?.status, 400);
  assert.equal(rejectUnknownQuery(new URLSearchParams("days=90"), ["days"], {}), null);
  assert.equal(rejectUnknownQuery(new URLSearchParams(""), [], {}), null);
});

test("export の route: ?cb= は 400・days は 10 進の整数だけ・範囲外と先頭 0 は正規の値へ 308（DB に届く前）", async () => {
  const savedDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { NextRequest } = await import("next/server");
    const ledger = await import("@/app/api/v1/observatory/export.csv/route");
    const sellers = await import("@/app/api/v1/sellers/export.csv/route");
    const l0 = await import("@/app/api/v1/observatory/l0/export.csv/route");
    let n = 0;
    // IP ごとの枠（6 回/分）に当たらないよう、要求ごとに別の IP を名乗る（generic の proxy ヘッダ）。
    const req = (path: string) => {
      n++;
      return new NextRequest(`http://localhost${path}`, { headers: { "x-real-ip": `198.51.100.${n}` } });
    };
    const savedProxy = process.env.PROXY_HEADER_SOURCE;
    process.env.PROXY_HEADER_SOURCE = "generic";
    try {
      assert.equal((await ledger.GET(req("/api/v1/observatory/export.csv?cb=12345"))).status, 400);
      assert.equal((await ledger.GET(req("/api/v1/observatory/export.csv?days=90&cb=1"))).status, 400);
      assert.equal((await ledger.GET(req("/api/v1/observatory/export.csv?days=90.5"))).status, 400);
      assert.equal((await ledger.GET(req("/api/v1/observatory/export.csv?days=1e2"))).status, 400);
      assert.equal((await ledger.GET(req("/api/v1/observatory/export.csv?days=-1"))).status, 400);
      const r1 = await ledger.GET(req("/api/v1/observatory/export.csv?days=0400"));
      assert.equal(r1.status, 308);
      assert.match(r1.headers.get("location") ?? "", /\/api\/v1\/observatory\/export\.csv\?days=366$/);
      const r2 = await ledger.GET(req("/api/v1/observatory/export.csv?days=0"));
      assert.equal(r2.status, 308);
      assert.match(r2.headers.get("location") ?? "", /\?days=1$/);
      assert.equal((await sellers.GET(req("/api/v1/sellers/export.csv?cb=1"))).status, 400);
      assert.equal((await l0.GET(req("/api/v1/observatory/l0/export.csv?cb=1"))).status, 400);
    } finally {
      if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
      else process.env.PROXY_HEADER_SOURCE = savedProxy;
    }
  } finally {
    if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
  }
});

// ---------- 5. corrections のカーソル ----------

test("corrections のカーソル: 暦に無い日付・時刻は null（400）、実在する時刻は往復で通る", () => {
  const id = "0b7e3c1e-7a51-4c1f-9d2a-3a1c1d2e3f40";
  const enc = (createdAt: string) => encodeCorrectionCursor({ created_at: createdAt, id });
  assert.equal(decodeCorrectionCursor(enc("2026-02-30 00:00:00+00")), null);
  assert.equal(decodeCorrectionCursor(enc("2026-02-29T00:00:00Z")), null, "2026 は閏年でない");
  assert.equal(decodeCorrectionCursor(enc("2026-13-01T00:00:00Z")), null);
  assert.equal(decodeCorrectionCursor(enc("2026-09-31T00:00:00Z")), null);
  assert.equal(decodeCorrectionCursor(enc("2026-09-29T24:00:00Z")), null);
  assert.equal(decodeCorrectionCursor(enc("2026-09-29T23:60:00Z")), null);
  assert.equal(decodeCorrectionCursor(enc("2026-09-29T23:59:60Z")), null);
  assert.equal(decodeCorrectionCursor(enc("2026-09-29 02:15:32.820289+99")), null);
  assert.equal(decodeCorrectionCursor(enc("0000-01-01T00:00:00Z")), null);
  assert.deepEqual(decodeCorrectionCursor(enc("2026-09-29 02:15:32.820289+00")), { createdAt: "2026-09-29 02:15:32.820289+00", id });
  assert.deepEqual(decodeCorrectionCursor(enc("2028-02-29T23:59:59Z")), { createdAt: "2028-02-29T23:59:59Z", id });
  assert.deepEqual(decodeCorrectionCursor(enc("2026-09-29T02:15:32+09:00")), { createdAt: "2026-09-29T02:15:32+09:00", id });
});

// ---------- 6. IP の枠の鍵 ----------

test("IP の枠: IPv6 は /64 に丸める（下位 64 bit を回しても同じ枠）・IPv4 と IP でない鍵はそのまま", () => {
  assert.equal(ipBucketKey("decision:2001:db8:1:2::1"), "decision:2001:db8:1:2::/64");
  assert.equal(ipBucketKey("decision:2001:db8:1:2:aaaa:bbbb:cccc:dddd"), ipBucketKey("decision:2001:db8:1:2::9"));
  assert.notEqual(ipBucketKey("decision:2001:db8:1:2::1"), ipBucketKey("decision:2001:db8:1:3::1"));
  assert.equal(ipBucketKey("decision:::ffff:10.0.0.1"), "decision:10.0.0.1");
  assert.equal(ipBucketKey("decision:1.2.3.4"), "decision:1.2.3.4");
  assert.equal(ipBucketKey("demo-l1-day:2026-09-29"), "demo-l1-day:2026-09-29");
  assert.equal(ipBucketKey("payee-verify-wallet:0xABC"), "payee-verify-wallet:0xABC");
  assert.equal(ipBucketKey("export-inflight:global"), "export-inflight:global");
  assert.equal(ipBucketKey("unknown"), "unknown");
  assert.equal(ipBucketKey("health:unknown"), "health:unknown");
});

test("IP の枠: IPv6 の /64 の中で IP を回しても枠は 1 つ（メモリ経路）", async () => {
  const savedDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { consumeIpRateLimit } = await import("@/lib/api/ip-rate-limit");
    const tag = `r6-test-${Date.now()}`;
    const results = [];
    for (let i = 1; i <= 4; i++) results.push(await consumeIpRateLimit(`${tag}:2001:db8:aa:bb::${i}`, 3, 60_000));
    assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
    assert.equal((await consumeIpRateLimit(`${tag}:2001:db8:aa:cc::1`, 3, 60_000)).allowed, true, "別の /64 は別の枠");
  } finally {
    if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
  }
});

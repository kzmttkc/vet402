// ============================================================
// D2。手元の購入記録を、公開の export.csv と同じ列名で書き出す。
//
// 店は 3.2 の DecisionStore（.vet402/decisions.jsonl）だけ。
// 2 本目のファイルは作らない。vet402 へは送らない。
// 列は凍結中の公開 export を超えない（名前と順番が一致する）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { exportLocalPurchaseCsv, LOCAL_PURCHASE_EXPORT_COLUMNS, payChecked, DEFAULT_DECISION_STORE } = await import("../dist/index.js");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

function publicExportColumns() {
  const src = read("src/lib/observatory/export-columns.ts");
  const names = [
    "COLUMNS_UNTIL_2026_09_17",
    "EXPORT_CSV_COLUMNS_SINCE_2026_09_20",
    "EXPORT_CSV_COLUMNS_SINCE_2026_09_21",
    "EXPORT_CSV_COLUMNS_SINCE_2026_09_29",
    "EXPORT_CSV_COLUMNS_SINCE_2026_09_29_B",
  ];
  const out = [];
  for (const name of names) {
    const matched = src.match(new RegExp(`(?:export )?const ${name} = \\[([\\s\\S]*?)\\] as const`));
    assert.ok(matched, name);
    const cols = [...matched[1].matchAll(/"([a-z0-9_]+)"/g)].map((item) => item[1]);
    assert.ok(cols.length > 0, name);
    out.push(...cols);
  }
  return out;
}

function parseCsv(text) {
  assert.equal(text.endsWith("\n"), true, "公開 export と同じく末尾は改行");
  const lines = text.slice(0, -1).split("\n");
  return lines.map(parseLine);
}

function parseLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function cellMap(cells, header) {
  assert.equal(cells.length, header.length);
  const out = {};
  header.forEach((name, index) => {
    out[name] = cells[index];
  });
  return out;
}

const FROZEN = publicExportColumns();

test("D2 書き出しの列名と順番は、公開 export の凍結列と一致し、それを超えない", () => {
  assert.equal(FROZEN.length, 19);
  assert.deepEqual([...LOCAL_PURCHASE_EXPORT_COLUMNS], FROZEN);
  assert.equal(LOCAL_PURCHASE_EXPORT_COLUMNS.join(","), FROZEN.join(","));
  const route = read("src/app/api/v1/observatory/export.csv/route.ts");
  assert.match(route, /const CSV_COLUMNS = EXPORT_CSV_COLUMNS;/);
  assert.match(route, /GET \/api\/v1\/observatory\/export\.csv/);
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "vet402-d2-"));
  return { dir, store: join(dir, "decisions.jsonl") };
}

const b64 = (value) => btoa(JSON.stringify(value));
const base = {
  payee: "0x36038e1d712c5e39f35952164ec58ec2b96caee7",
  resource: "https://kronossignals.com/api/v1/price/btc/",
  amountUsd: 0.02,
};
const okAccept = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "20000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: base.payee,
  extra: { assetTransferMethod: "eip3009" },
};
const RESOURCE_ID = "ab".repeat(32);

function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(target, prop) { accessed.push(String(prop)); return Reflect.get(target, prop); } },
  );
  return { account, signAccesses: () => accessed.filter((key) => key.startsWith("sign")) };
}

function allowlistFetch(allowed, responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (!allowed.some((item) => u.includes(item))) throw new Error(`forbidden call: ${u}`);
      const key = Object.keys(responses).find((item) => u.includes(item));
      let response = responses[key];
      if (typeof response === "function") response = response(u, init);
      if (!response) throw new Error(`no stub for ${u}`);
      return {
        ok: response.status < 400,
        status: response.status,
        json: async () => response.body,
        text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? "")),
        headers: new Map(Object.entries(response.headers ?? {})),
      };
    },
  };
}

function seller(accept) {
  const paid = [];
  const stub = (_url, init) => {
    const headers = init?.headers ?? {};
    const raw = headers["PAYMENT-SIGNATURE"] ?? headers["payment-signature"];
    if (!raw) {
      return { status: 402, body: {}, headers: { "payment-required": b64({ x402Version: 2, accepts: [accept] }) } };
    }
    paid.push(raw);
    return {
      status: 200,
      body: { data: "ok" },
      headers: {
        "PAYMENT-RESPONSE": b64({
          success: true,
          transaction: "0xtx",
          network: accept.network,
          payer: "0xDB62BD202914609830fA656F87996b91be3Aa673",
        }),
      },
    };
  };
  return { stub, paid };
}

function decisionBody() {
  return {
    subject: { type: "resource", id: RESOURCE_ID },
    role: "payer",
    recommendation: "ALLOW",
    reason_codes: ["l0_pass", "l1_delivered"],
    facts: {
      l0: { status: "pass" },
      l1: { n_delivered: 3, n_attempts: 3, n_inconclusive: 0 },
      l2: { status: "undeclared" },
      payees: [base.payee],
    },
    evidence: [{ level: "L1", source: "vet402", url: "https://vet402.com/observatory/e/x" }],
    degraded: false,
    policy: "allow_only",
    rules_version: "2026-09-02.1",
  };
}

test("D2 payChecked が同じ店に書いた購入は、依頼・取引・届いたかが公開の列に入る", async () => {
  const { dir, store } = tempStore();
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch(["/resolve", "/decision", "kronos", "payments/x402"], {
    "/resolve": { status: 200, body: { resource: { resource_id: RESOURCE_ID, payee_id: `eip155:8453:${base.payee}` } } },
    "/decision": { status: 200, body: decisionBody() },
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const paid = await payChecked({
    url: base.resource,
    rules: { maxPerTxUsd: 1, requireAllow: true, minDeliveryRate: 0.9 },
    amountUsd: base.amountUsd,
    account: w.account,
    fetch: f.fetch,
    store,
  });
  assert.equal(paid.paid, true);
  assert.equal(paid.delivered, true);
  assert.deepEqual(w.signAccesses(), ["signTypedData"]);
  const before = readdirSync(dir).sort();
  const lines = readFileSync(store, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "保留と確定は同じ JSONL");
  assert.equal(JSON.parse(lines[0]).payChecked.state, "pending");
  const settled = JSON.parse(lines[1]);
  assert.equal("receipt" in settled, false, "決定行の直下に receipt は足さない");

  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetches += 1;
    return original(...args);
  };
  let csv = "";
  try {
    csv = await exportLocalPurchaseCsv({ store });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetches, 0, "書き出しは vet402 へ送らない");
  assert.deepEqual(readdirSync(dir).sort(), before, "2 本目の手元ファイルを作らない");
  assert.equal(store.endsWith("decisions.jsonl"), true);
  assert.equal(DEFAULT_DECISION_STORE, ".vet402/decisions.jsonl");

  const table = parseCsv(csv);
  assert.deepEqual(table[0], [...FROZEN]);
  assert.equal(table.length, 2, "保留の行は購入の書き出しに入れない");
  const row = cellMap(table[1], FROZEN);
  assert.equal(row.resource_key, "kronossignals.com/api/v1/price/btc");
  assert.equal(row.tx_hash, "0xtx");
  assert.equal(row.http_status_paid, "200");
  assert.equal(row.network, "eip155:8453");
  assert.equal(row.amount_units, "20000");
  assert.equal(row.spent_units, "20000");
  assert.equal(row.request_body, "none");
  assert.equal(row.request_query, "");
  assert.equal(row.settlement_source, "seller_claim");
  assert.equal(row.confirmed_units, "0");
  assert.equal(row.status, "settle_claimed_unverifiable");
  assert.notEqual(row.status, "settled");
  assert.equal(row.purchase_id, "");
  assert.equal(row.l2_schema, "");
  assert.equal(row.l2_reading, "");
  assert.equal(row.held_reason, "");
  assert.equal(row.latency_ms, "");
  assert.equal(row.request_body_sha256, "");
  assert.equal(row.request_query_sha256, "");
  assert.equal(row.attempted_at, new Date(settled.at).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.equal(csv.includes("0xsig"), false);
  assert.equal(csv.includes(settled.nonce), false);
});

test("D2 署名前の拒否は購入の行にせず、記録そのものは消さない", async () => {
  const { store } = tempStore();
  const w = watchedAccount();
  const s = seller(okAccept);
  const f = allowlistFetch(["/resolve", "/decision", "kronos", "payments/x402"], {
    "/resolve": { status: 200, body: { resource: { resource_id: RESOURCE_ID, payee_id: `eip155:8453:${base.payee}` } } },
    "/decision": { status: 200, body: decisionBody() },
    kronos: s.stub,
    "payments/x402": { status: 200, body: { ok: true } },
  });
  const refused = await payChecked({
    url: base.resource,
    rules: { maxPerTxUsd: 0.01, requireAllow: true },
    amountUsd: base.amountUsd,
    account: w.account,
    fetch: f.fetch,
    store,
  });
  assert.equal(refused.paid, false);
  assert.deepEqual(w.signAccesses(), []);
  assert.equal(s.paid.length, 0);
  const csv = await exportLocalPurchaseCsv({ store });
  const table = parseCsv(csv);
  assert.deepEqual(table, [[...FROZEN]]);
  assert.equal(readFileSync(store, "utf8").trim().split("\n").length, 1);
});

const TX_A = `0x${"ab".repeat(32)}`;
const TX_B = `0x${"cd".repeat(32)}`;
const SVM_TX = "1".repeat(88);
const SIGNED_BLOB = `SIGNEDBLOB${"A".repeat(48)}`;
const RULES_SECRET = "RULESSECRET-do-not-export";

function line(over) {
  return {
    recommendation: "ALLOW",
    reason_codes: [],
    verdict_source: "local_policy",
    evidence: [],
    decision: null,
    payeeScore: null,
    policy_override: null,
    source: "pay-checked",
    at: "2026-11-12T00:00:02.250Z",
    status: "paid",
    resource: "https://api.example.com/v1/quote",
    txHash: TX_A,
    nonce: `0x${"11".repeat(32)}`,
    payChecked: {
      state: "settled",
      rulesJson: RULES_SECRET,
      url: "https://api.example.com/v1/quote",
      result: {
        paid: true,
        delivered: true,
        refusedBy: null,
        receipt: {
          endpoint: "https://api.example.com/v1/quote",
          method: "GET",
          network: "eip155:8453",
          amount: "20000",
          responseStatus: 200,
          settlement: { transaction: TX_A },
          retry: { svm: { transaction: SIGNED_BLOB } },
        },
        evidenceUrl: null,
      },
    },
    ...over,
  };
}

test("D2 同じ店の行を公開の語で並べ、空の店と壊れた行と秘密は出さない", async () => {
  const missing = await exportLocalPurchaseCsv({ store: join(tempStore().dir, "never.jsonl") });
  assert.equal(missing, `${FROZEN.join(",")}\n`);

  const { store } = tempStore();
  const rows = [
    line({ at: "2026-11-12T00:00:02.250Z", txHash: TX_A, resource: "https://API.Example/V1/Quote" }),
    { ...line(), payChecked: { state: "pending", url: "https://pending.example/no", result: null }, status: "refused", txHash: null, nonce: null, at: "2026-11-12T00:00:00.000Z" },
    "{ちぎれた",
    line({
      at: "2026-11-12T00:00:01.000Z",
      txHash: TX_B,
      resource: "https://Seller.Example:4449/v1/quote/?x=1",
      payChecked: {
        state: "settled",
        rulesJson: RULES_SECRET,
        url: "https://Seller.Example:4449/v1/quote/?x=1",
        amountUsd: 9,
        result: { paid: true, delivered: true, refusedBy: null, receipt: { method: "GET", network: "eip155:8453", responseStatus: 200, amount: "1" }, evidenceUrl: null },
      },
    }),
    line({
      status: "refused",
      txHash: null,
      nonce: null,
      at: "2026-11-12T00:00:03.000Z",
      payChecked: { state: "failed", url: "https://refused.example/no", result: { paid: false, delivered: false, refusedBy: "max_per_tx", receipt: null, evidenceUrl: null } },
    }),
    line({
      status: "paid",
      txHash: "0xtx",
      at: "2026-11-12T00:00:04.000Z",
      resource: "https://short.example/tx",
      payChecked: {
        state: "settled",
        url: "https://short.example/tx",
        result: { paid: true, delivered: true, refusedBy: null, receipt: { method: "GET", network: "eip155:8453", responseStatus: 200, amount: "5" }, evidenceUrl: null },
      },
    }),
    line({
      status: "paid",
      txHash: null,
      nonce: null,
      at: "2026-11-12T00:00:05.000Z",
      resource: "https://noreceipt.example/ok",
      payChecked: {
        state: "settled",
        url: "https://noreceipt.example/ok",
        result: { paid: true, delivered: true, refusedBy: null, receipt: { method: "GET", network: "eip155:8453", responseStatus: 200, amount: "5" }, evidenceUrl: null },
      },
    }),
    line({
      status: "failed",
      txHash: null,
      at: "2026-11-12T00:00:06.000Z",
      resource: "https://failed.example/pay",
      payChecked: {
        state: "failed",
        url: "https://failed.example/pay",
        result: { paid: false, delivered: false, refusedBy: null, receipt: { method: "POST", network: "eip155:8453", responseStatus: 500, amount: "9" }, evidenceUrl: null },
      },
    }),
    line({
      status: "paid",
      txHash: SVM_TX,
      at: "2026-11-12T00:00:07.000Z",
      resource: "https://sol.example/price",
      payChecked: {
        state: "settled",
        url: "https://sol.example/price",
        result: { paid: true, delivered: true, refusedBy: null, receipt: { method: "GET", network: "solana:mainnet", responseStatus: 200, amount: "3" }, evidenceUrl: null },
      },
    }),
    line({
      status: "paid",
      txHash: TX_A,
      at: "2026-11-12T00:00:08.000Z",
      resource: "=HYPERLINK(\"http://evil.example/a\")",
      payChecked: {
        state: "settled",
        url: "=HYPERLINK(\"http://evil.example/a\")",
        result: { paid: true, delivered: false, refusedBy: null, receipt: { method: "GET", network: "eip155:8453", responseStatus: 200, amount: "4" }, evidenceUrl: null },
      },
    }),
  ];
  appendFileSync(store, `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`);
  const table = parseCsv(await exportLocalPurchaseCsv({ store }));
  assert.deepEqual(table[0], [...FROZEN]);
  const body = table.slice(1).map((cells) => cellMap(cells, FROZEN));
  assert.deepEqual(body.map((row) => row.attempted_at), [
    "2026-11-12T00:00:01Z",
    "2026-11-12T00:00:02Z",
    "2026-11-12T00:00:04Z",
    "2026-11-12T00:00:05Z",
    "2026-11-12T00:00:06Z",
    "2026-11-12T00:00:07Z",
    "2026-11-12T00:00:08Z",
  ]);
  assert.equal(body[0].resource_key, "seller.example:4449/v1/quote");
  assert.equal(body[0].request_query, "");
  assert.equal(body[0].tx_hash, TX_B);
  assert.equal(body[0].status, "settle_claimed");
  assert.equal(body[0].amount_units, "1");
  assert.equal(body[0].spent_units, "1");
  assert.equal(body[0].confirmed_units, "0");
  assert.equal(body[1].resource_key, "api.example/V1/Quote");
  assert.equal(body[1].status, "settle_claimed");
  assert.equal(body[2].tx_hash, "0xtx");
  assert.equal(body[2].status, "settle_claimed_unverifiable");
  assert.equal(body[3].tx_hash, "");
  assert.equal(body[3].status, "delivered_no_receipt");
  assert.equal(body[3].settlement_source, "");
  assert.equal(body[3].http_status_paid, "200");
  assert.equal(body[4].status, "settle_failed");
  assert.equal(body[4].http_status_paid, "500");
  assert.equal(body[4].request_body, "");
  assert.equal(body[4].amount_units, "9");
  assert.equal(body[5].status, "settle_claimed");
  assert.equal(body[5].tx_hash, SVM_TX);
  assert.equal(body[6].resource_key.startsWith("'=HYPERLINK("), true);
  assert.equal(body.every((row) => row.status !== "settled"), true);
  assert.equal(body.every((row) => row.confirmed_units === "0"), true);
  const raw = await exportLocalPurchaseCsv({ store });
  assert.equal(raw.includes(SIGNED_BLOB), false);
  assert.equal(raw.includes(RULES_SECRET), false);
  assert.equal(raw.includes("refused.example"), false);
  assert.equal(raw.includes("pending.example"), false);
});

test("D2 書き出しは読み取り専用で、照会のフックと支払いの関門を一つの関数にしない", () => {
  const src = read("packages/sdk/src/local-purchase-export.ts");
  assert.match(src, /DEFAULT_DECISION_STORE/);
  assert.equal(src.includes("vet402-read-hook"), false);
  assert.equal(src.includes("wrapFetch"), false);
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(src.includes("writeFile"), false);
  assert.equal(src.includes("appendFile"), false);
  assert.equal(src.includes("payOrRefuse("), false);
});

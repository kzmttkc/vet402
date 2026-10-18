// ============================================================
// Stellar の L1 決済照合（2026-10-18）。Horizon はスタブ。外には出ない。
//
// 金を守る比較を反転させたら落ちるもの（このリポの test-mutations の考え方）:
//   1. 額が 1 stroop 多くても ok にしない（`>=` に変えると落ちる）
//   2. 額が 1 stroop 少なくても ok にしない（切り捨て比較に変えると落ちる）
//   3. 発行者が違う USDC を ok にしない（資産の一致を外すと落ちる）
//   4. 払い手と宛先を別々に見る。隣接しない effect を額だけで繋ぐと落ちる
//   5. 200 件で埋まったページは settled にしない（打ち切りを外すと落ちる）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Networks } from "@stellar/stellar-sdk";
import { verifyL1Settlement } from "@/lib/observatory/settlement-verify";
import {
  ledgerUnitsToExactStroops,
  stellarBalanceToLedgerUnits,
  stellarDecimalToStroops,
  verifyStellarSettlement,
  type StellarHorizonReader,
} from "@/lib/observatory/settlement-verify-stellar";
import { STELLAR_USDC_ISSUER, STELLAR_USDC_SAC } from "@/lib/observatory/stellar402-payer";

const HASH = "ab".repeat(32);
const PAYER = `G${"A".repeat(55)}`;
const PAYEE = `G${"B".repeat(55)}`;
const SPONSOR = `G${"C".repeat(55)}`;
const OTHER = `G${"D".repeat(55)}`;
const OTHER_SAC = `C${"A".repeat(55)}`;
const MUXED = `M${"A".repeat(68)}`;

const PUBNET = { network_passphrase: Networks.PUBLIC };

function payment(over: Record<string, unknown> = {}) {
  return {
    type: "payment",
    from: PAYER,
    to: PAYEE,
    amount: "0.1000000",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: STELLAR_USDC_ISSUER,
    ...over,
  };
}

function tx(over: Record<string, unknown> = {}) {
  return {
    hash: HASH,
    id: HASH,
    successful: true,
    ledger: 12_345,
    created_at: "2026-10-18T00:00:00Z",
    operation_count: 1,
    source_account: SPONSOR,
    ...over,
  };
}

function page(records: unknown[]) {
  return { _embedded: { records } };
}

function fake(opts: {
  root?: unknown | Error;
  tx?: unknown | null | Error;
  ops?: unknown | Error;
  effects?: unknown | Error;
} = {}): StellarHorizonReader & { calls: string[] } {
  const calls: string[] = [];
  const take = async (name: string, value: unknown | null | Error | undefined, fallback: unknown) => {
    calls.push(name);
    const v = value === undefined ? fallback : value;
    if (v instanceof Error) throw v;
    return v;
  };
  const horizon: StellarHorizonReader = {
    root: () => take("root", opts.root, PUBNET),
    transaction: (hash) => take(`tx:${hash}`, opts.tx, tx()),
    operations: () => take("operations", opts.ops, page([payment()])),
    effects: () => take("effects", opts.effects, page([])),
    account: () => take("account", null, null),
  };
  return Object.assign(horizon, { calls });
}

const input = (over: Partial<Parameters<typeof verifyStellarSettlement>[0]> = {}) => ({
  txHash: HASH,
  network: "stellar:pubnet",
  expectedPayTo: PAYEE,
  expectedPayer: PAYER,
  expectedAmountUnits: "100000",
  ...over,
});

function reason(r: Awaited<ReturnType<typeof verifyStellarSettlement>>): string {
  return r.ok ? "ok" : r.reason;
}

test("7 桁の完全一致。台帳の 6 桁 × 10 と、1 stroop の過不足", () => {
  assert.equal(ledgerUnitsToExactStroops("100000"), 1_000_000n);
  assert.equal(stellarDecimalToStroops("0.1000000"), 1_000_000n);
  assert.equal(stellarDecimalToStroops("0.1"), 1_000_000n);
  assert.equal(stellarDecimalToStroops("0.1000001"), 1_000_001n);
  assert.equal(stellarDecimalToStroops("0.0999999"), 999_999n);
  assert.equal(stellarDecimalToStroops("1.23456789"), null, "8 桁は切り捨てずに拒否");
  assert.equal(stellarBalanceToLedgerUnits("1.2345678"), 1_234_567n, "7 桁目は切り捨て（切り上げると 1234568）");
  assert.equal(stellarBalanceToLedgerUnits("0.0000001"), 0n, "1 stroop を 1 unit に繰り上げない");
  assert.equal(stellarBalanceToLedgerUnits("1.0000000"), 1_000_000n);
});

test("classic USDC の payment が一致すれば ok。sponsor の source_account は払い手ではない", async () => {
  const horizon = fake();
  const r = await verifyStellarSettlement(input({ txHash: HASH.toUpperCase() }), { horizon });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.blockNumber, 12_345n);
    assert.equal(r.confirmations, 1n);
    assert.equal(r.blockTimestamp?.toISOString(), "2026-10-18T00:00:00.000Z");
  }
  assert.equal(horizon.calls.includes(`tx:${HASH}`), true, "hash は小文字で読む");
  assert.equal(horizon.calls.includes("account"), false);
});

test("SAC の隣接した contract_debited / contract_credited が一致すれば ok", async () => {
  const horizon = fake({
    ops: page([{ type: "invoke_host_function", asset_balance_changes: [] }]),
    effects: page([
      { type: "contract_debited", account: PAYER, contract: STELLAR_USDC_SAC, amount: "0.1000000" },
      { type: "contract_credited", account: PAYEE, contract: STELLAR_USDC_SAC, amount: "0.1000000" },
    ]),
  });
  assert.equal((await verifyStellarSettlement(input(), { horizon })).ok, true);
});

test("invoke_host_function の asset_balance_changes（transfer・classic USDC）が一致すれば ok", async () => {
  const horizon = fake({
    ops: page([
      {
        type: "invoke_host_function",
        asset_balance_changes: [
          {
            type: "transfer",
            from: PAYER,
            to: PAYEE,
            amount: "0.1000000",
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: STELLAR_USDC_ISSUER,
          },
        ],
      },
    ]),
  });
  assert.equal((await verifyStellarSettlement(input(), { horizon })).ok, true);
});

test("muxed の宛先は to_muxed で照合する", async () => {
  const horizon = fake({ ops: page([payment({ to: PAYEE, to_muxed: MUXED })]) });
  assert.equal((await verifyStellarSettlement(input({ expectedPayTo: MUXED }), { horizon })).ok, true);
});

test("形・network・期待額は Horizon を叩く前に落ちる", async () => {
  const horizon = fake();
  assert.equal(reason(await verifyStellarSettlement(input({ txHash: `0x${HASH}` }), { horizon })), "malformed_tx");
  assert.equal(reason(await verifyStellarSettlement(input({ txHash: "ab" }), { horizon })), "malformed_tx");
  assert.equal(reason(await verifyStellarSettlement(input({ txHash: "../accounts/x" }), { horizon })), "malformed_tx");
  assert.equal(reason(await verifyStellarSettlement(input({ network: "stellar:testnet" }), { horizon })), "wrong_chain");
  assert.equal(reason(await verifyStellarSettlement(input({ expectedAmountUnits: "0" }), { horizon })), "amount_mismatch");
  assert.equal(reason(await verifyStellarSettlement(input({ expectedAmountUnits: "1.5" }), { horizon })), "amount_mismatch");
  assert.deepEqual(horizon.calls, []);
});

test("passphrase が pubnet でなければ tx を読まない", async () => {
  const horizon = fake({ root: { network_passphrase: Networks.TESTNET } });
  const r = await verifyStellarSettlement(input(), { horizon });
  assert.equal(reason(r), "wrong_chain");
  assert.equal(horizon.calls.includes("tx:" + HASH), false);
});

test("見つからない / 失敗 / 読めない。失敗 tx は operations を取りに行かない", async () => {
  const missing = fake({ tx: null });
  assert.equal(reason(await verifyStellarSettlement(input(), { horizon: missing })), "tx_not_found");
  assert.equal(missing.calls.includes("operations"), false);

  const failed = fake({ tx: tx({ successful: false }) });
  assert.equal(reason(await verifyStellarSettlement(input(), { horizon: failed })), "tx_reverted");
  assert.equal(failed.calls.includes("operations"), false);

  const down = fake({ root: new Error("ECONNRESET") });
  assert.equal(reason(await verifyStellarSettlement(input(), { horizon: down })), "rpc_unavailable");
  assert.equal(down.calls.includes("tx:" + HASH), false);

  const badHash = fake({ tx: tx({ hash: "cd".repeat(32), id: "cd".repeat(32) }) });
  assert.equal(reason(await verifyStellarSettlement(input(), { horizon: badHash })), "rpc_unavailable");
});

test("恒久の否定: 払い手 / 宛先 / 額 / 資産 / 送金が無い", async () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [payment({ from: OTHER }), "payer_mismatch", "wrong_payer"],
    [payment({ to: OTHER }), "payee_mismatch", "wrong_destination"],
    [payment({ amount: "0.1000001" }), "amount_mismatch", "wrong_amount"],
    [payment({ amount: "0.0999999" }), "amount_mismatch", "wrong_amount"],
    [payment({ asset_issuer: OTHER }), "amount_mismatch", "wrong_asset"],
    [payment({ asset_code: "XLM", asset_issuer: undefined }), "amount_mismatch", "wrong_asset"],
  ];
  for (const [op, code, prefix] of cases) {
    const r = await verifyStellarSettlement(input(), { horizon: fake({ ops: page([op]) }) });
    assert.equal(reason(r), code, JSON.stringify(op));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.detail?.startsWith(prefix), true, r.detail);
  }

  const none = await verifyStellarSettlement(input(), { horizon: fake({ ops: page([{ type: "manage_data", name: "x" }]) }) });
  assert.equal(reason(none), "no_matching_transfer");

  const otherSac = await verifyStellarSettlement(input(), {
    horizon: fake({
      ops: page([{ type: "invoke_host_function" }]),
      effects: page([
        { type: "contract_debited", account: PAYER, contract: OTHER_SAC, amount: "0.1000000" },
        { type: "contract_credited", account: PAYEE, contract: OTHER_SAC, amount: "0.1000000" },
      ]),
    }),
  });
  assert.equal(reason(otherSac), "amount_mismatch");
  assert.equal(otherSac.ok === false && otherSac.detail?.startsWith("wrong_asset"), true);

  const mint = await verifyStellarSettlement(input(), {
    horizon: fake({
      ops: page([
        {
          type: "invoke_host_function",
          asset_balance_changes: [
            { type: "mint", from: PAYER, to: PAYEE, amount: "0.1000000", asset_code: "USDC", asset_issuer: STELLAR_USDC_ISSUER },
          ],
        },
      ]),
    }),
  });
  assert.equal(reason(mint), "no_matching_transfer", "mint は送金ではない");
});

test("同じ額の effect を隣接していない相手と繋がない（別の送金を 1 本にしない）", async () => {
  const r = await verifyStellarSettlement(input(), {
    horizon: fake({
      ops: page([{ type: "invoke_host_function" }]),
      effects: page([
        { type: "contract_debited", account: PAYER, contract: STELLAR_USDC_SAC, amount: "0.1000000" },
        { type: "contract_credited", account: OTHER, contract: STELLAR_USDC_SAC, amount: "0.1000000" },
        { type: "contract_debited", account: OTHER, contract: STELLAR_USDC_SAC, amount: "0.1000000" },
        { type: "contract_credited", account: PAYEE, contract: STELLAR_USDC_SAC, amount: "0.1000000" },
      ]),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(reason(r), "payee_mismatch");
});

test("ページが上限で埋まった、または operation_count と件数が違うときは settled にしない", async () => {
  const full = Array.from({ length: 200 }, () => payment());
  const truncated = await verifyStellarSettlement(input(), {
    horizon: fake({ tx: tx({ operation_count: 200 }), ops: page(full) }),
  });
  assert.equal(reason(truncated), "rpc_unavailable");
  const short = await verifyStellarSettlement(input(), {
    horizon: fake({ tx: tx({ operation_count: 2 }), ops: page([payment()]) }),
  });
  assert.equal(reason(short), "rpc_unavailable");
});

test("STELLAR_HORIZON_URL 未設定・壊れた URL・資格情報は公開 Horizon へ倒れず、URL も秘密も detail に出ない", async () => {
  const saved = process.env.STELLAR_HORIZON_URL;
  const secret = `S${"A".repeat(55)}`;
  try {
    delete process.env.STELLAR_HORIZON_URL;
    const unset = await verifyStellarSettlement(input());
    assert.equal(reason(unset), "rpc_unavailable");
    assert.match((unset.ok === false && unset.detail) || "", /stellar_horizon_unset/);

    process.env.STELLAR_HORIZON_URL = "http://user:TOPSECRET@127.0.0.1/horizon";
    const creds = await verifyStellarSettlement(input());
    assert.equal(reason(creds), "rpc_unavailable");
    assert.equal(creds.ok === false && creds.detail?.includes("TOPSECRET"), false);

    process.env.STELLAR_HORIZON_URL = "not a url http://evil.example/KEY";
    const bad = await verifyStellarSettlement(input());
    assert.equal(bad.ok === false && bad.detail?.includes("evil.example"), false);
    assert.equal(bad.ok === false && bad.detail?.includes("KEY"), false);
  } finally {
    if (saved === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = saved;
  }

  const leaked = await verifyStellarSettlement(input(), {
    horizon: fake({ root: new Error(`down http://horizon.example/v1/SECRETKEY ${secret}`) }),
  });
  assert.equal(leaked.ok, false);
  if (!leaked.ok) {
    assert.equal(leaked.detail?.includes("SECRETKEY"), false, leaked.detail);
    assert.equal(leaked.detail?.includes(secret), false, leaked.detail);
    assert.match(leaked.detail ?? "", /<url>/);
    assert.match(leaked.detail ?? "", /<stellar-secret>/);
  }
});

test("verifyL1Settlement は stellar: を照合器へ委譲する（chain_not_yet_verifiable で止めない）", async () => {
  const saved = process.env.STELLAR_HORIZON_URL;
  delete process.env.STELLAR_HORIZON_URL;
  try {
    const r = await verifyL1Settlement(input());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.notEqual(r.reason, "chain_not_yet_verifiable");
      assert.equal(r.reason, "rpc_unavailable");
    }
    const testnet = await verifyL1Settlement(input({ network: "stellar:testnet" }));
    assert.equal(testnet.ok === false && testnet.reason, "wrong_chain");
  } finally {
    if (saved === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = saved;
  }
});

async function withServer(handler: (req: { url: string }, res: { status: number; body: unknown }) => void): Promise<{
  port: number;
  hits: string[];
  close: () => Promise<void>;
}> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    let status = 200;
    let body: unknown = {};
    handler({ url: req.url ?? "" }, { get status() { return status; }, set status(n) { status = n; }, get body() { return body; }, set body(b) { body = b; } });
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("既定の読み手は 127.0.0.1 の Horizon スタブだけを読む（operations は limit=200）", async () => {
  const secret = `S${"B".repeat(55)}`;
  const saved = process.env.STELLAR_HORIZON_URL;
  const srv = await withServer((req, res) => {
    if (req.url === "/" || req.url === "/?") {
      res.body = PUBNET;
      return;
    }
    if (req.url === `/transactions/${HASH}`) {
      res.body = tx();
      return;
    }
    if (req.url?.startsWith(`/transactions/${HASH}/operations`)) {
      assert.match(req.url, /limit=200/);
      assert.match(req.url, /order=asc/);
      res.body = page([payment()]);
      return;
    }
    if (req.url?.startsWith(`/transactions/${HASH}/effects`)) {
      res.body = page([]);
      return;
    }
    res.status = 500;
    res.body = { detail: secret, url: "http://horizon.example/SECRETKEY" };
  });
  try {
    process.env.STELLAR_HORIZON_URL = `http://127.0.0.1:${srv.port}`;
    process.env.STELLAR_PAYER_SECRET = secret;
    const r = await verifyL1Settlement(input());
    assert.equal(r.ok, true);
    assert.equal(srv.hits.some((h) => h.startsWith("http")), false);
    const missing = await verifyStellarSettlement(input({ txHash: "cd".repeat(32) }), {
      horizon: undefined,
    });
    // 404 はサーバが知らない hash。上のハンドラは 500 を返すので、秘密が detail に出ないことを見る。
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.detail?.includes(secret), false, missing.detail);
      assert.equal(missing.detail?.includes("SECRETKEY"), false, missing.detail);
      assert.equal(missing.detail?.includes("127.0.0.1"), false, missing.detail);
    }
  } finally {
    delete process.env.STELLAR_PAYER_SECRET;
    if (saved === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = saved;
    await srv.close();
  }
});

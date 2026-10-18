// ============================================================
// Stellar の購入元残高（2026-10-18）。Horizon は 127.0.0.1 のスタブ。
// trustline が無い・読めないは throw（createPayerFunds は unreadable＝署名しない側）。
// 7 桁は 6 桁へ切り捨て。切り上げに変えると "1.2345678" のテストが落ちる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createPayerFunds, defaultPayerUsdcBalance } from "@/lib/observatory/payer-funds";
import { readStellarUsdcLedgerUnits } from "@/lib/observatory/settlement-verify-stellar";
import { STELLAR_USDC_ISSUER } from "@/lib/observatory/stellar402-payer";

const OWNER = `G${"E".repeat(55)}`;

function usdc(over: Record<string, unknown> = {}) {
  return {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: STELLAR_USDC_ISSUER,
    balance: "1.2345678",
    is_authorized: true,
    ...over,
  };
}

function account(balances: unknown[]) {
  return { balances };
}

async function withAccounts(handler: (url: string) => { status: number; body: unknown }): Promise<{
  port: number;
  hits: string[];
  close: () => Promise<void>;
}> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const out = handler(req.url ?? "");
    res.statusCode = out.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function withEnv<T>(url: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = process.env.STELLAR_HORIZON_URL;
  try {
    if (url === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = url;
    return await body();
  } finally {
    if (saved === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = saved;
  }
}

test("stellar は base と別の残高として数える", async () => {
  const f = createPayerFunds(async ({ chain }) => (chain === "stellar" ? 0n : 60_000_000n));
  assert.equal((await f.check("base", "0x1", 1000n)).ok, true);
  const v = await f.check("stellar", OWNER, 1n);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "insufficient");
  const g = createPayerFunds(async ({ chain }) => (chain === "stellar" ? 3_000n : 0n));
  assert.equal((await g.check("stellar", OWNER, 3_000n)).ok, true);
  g.commit("stellar", OWNER, 3_000n);
  assert.equal((await g.check("stellar", OWNER, 1n)).ok, false);
});

test("既定の読み手: classic USDC の trustline を 7→6 桁に切り捨てて返す", async () => {
  const srv = await withAccounts((url) => {
    assert.equal(url, `/accounts/${OWNER}`);
    return { status: 200, body: account([{ asset_type: "native", balance: "99.0000000" }, usdc()]) };
  });
  try {
    const balance = await withEnv(`http://127.0.0.1:${srv.port}`, () => defaultPayerUsdcBalance({ chain: "stellar", owner: OWNER }));
    assert.equal(balance, 1_234_567n, "1.2345678 USDC は 1234567 units（切り上げなら 1234568）");
    assert.equal(srv.hits.length, 1);
  } finally {
    await srv.close();
  }
});

test("trustline が無い・未承認・口座が無い、は throw。残高 0 の trustline は 0n", async () => {
  const cases: [unknown, number, RegExp][] = [
    [account([{ asset_type: "native", balance: "10.0000000" }]), 200, /stellar_usdc_trustline_missing/],
    [account([usdc({ is_authorized: false, balance: "5.0000000" })]), 200, /stellar_usdc_trustline_unauthorized/],
    [{ status: 404 }, 404, /stellar_usdc_trustline_missing/],
    [account([usdc({ asset_issuer: `G${"F".repeat(55)}`, balance: "9.0000000" })]), 200, /stellar_usdc_trustline_missing/],
  ];
  for (const [body, status, pattern] of cases) {
    const srv = await withAccounts(() => ({ status, body }));
    try {
      await withEnv(`http://127.0.0.1:${srv.port}`, async () => {
        await assert.rejects(readStellarUsdcLedgerUnits(OWNER), pattern);
      });
    } finally {
      await srv.close();
    }
  }

  const zero = await withAccounts(() => ({ status: 200, body: account([usdc({ balance: "0.0000000" })]) }));
  try {
    const balance = await withEnv(`http://127.0.0.1:${zero.port}`, () => readStellarUsdcLedgerUnits(OWNER));
    assert.equal(balance, 0n);
  } finally {
    await zero.close();
  }
});

test("trustline が無いときの関門は unreadable（0 を返して insufficient にしない）", async () => {
  const srv = await withAccounts(() => ({ status: 200, body: account([{ asset_type: "native", balance: "3.0000000" }]) }));
  try {
    await withEnv(`http://127.0.0.1:${srv.port}`, async () => {
      const f = createPayerFunds(defaultPayerUsdcBalance);
      const v = await f.check("stellar", OWNER, 1n);
      assert.equal(v.ok, false);
      assert.equal(v.ok === false && v.reason, "unreadable");
    });
  } finally {
    await srv.close();
  }
});

test("URL が無い・壊れている・応答に秘密が混ざっても、誤り文に URL と秘密を出さない", async () => {
  const secret = `S${"C".repeat(55)}`;
  await withEnv(undefined, async () => {
    await assert.rejects(defaultPayerUsdcBalance({ chain: "stellar", owner: OWNER }), /stellar_horizon_unset/);
  });

  const savedSecret = process.env.STELLAR_PAYER_SECRET;
  process.env.STELLAR_PAYER_SECRET = secret;
  try {
    await withEnv("http://user:TOPSECRET@127.0.0.1/horizon", async () => {
      await assert.rejects(readStellarUsdcLedgerUnits(OWNER), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /stellar_horizon_unset/);
        assert.equal(message.includes("TOPSECRET"), false, message);
        assert.equal(message.includes(secret), false, message);
        return true;
      });
    });

    const boom = await withAccounts(() => ({ status: 500, body: { leak: secret, href: "http://horizon.example/SECRETKEY" } }));
    try {
      await withEnv(`http://127.0.0.1:${boom.port}`, async () => {
        const f = createPayerFunds(defaultPayerUsdcBalance);
        const v = await f.check("stellar", OWNER, 1n);
        assert.equal(v.ok === false && v.reason, "unreadable");
        const err = v.ok === false && v.reason === "unreadable" ? v.error : "";
        assert.equal(err.includes(secret), false, err);
        assert.equal(err.includes("SECRETKEY"), false, err);
        assert.equal(err.includes("127.0.0.1"), false, err);
        assert.equal(err.includes(String(boom.port)), false, err);
      });
    } finally {
      await boom.close();
    }
  } finally {
    if (savedSecret === undefined) delete process.env.STELLAR_PAYER_SECRET;
    else process.env.STELLAR_PAYER_SECRET = savedSecret;
  }
});

test("公開アドレスの形でなければ Horizon を叩かない", async () => {
  const secret = `S${"D".repeat(55)}`;
  let called = false;
  const srv = await withAccounts(() => {
    called = true;
    return { status: 200, body: account([usdc()]) };
  });
  try {
    await withEnv(`http://127.0.0.1:${srv.port}`, async () => {
      await assert.rejects(readStellarUsdcLedgerUnits(secret), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /stellar_payer_address_malformed/);
        assert.equal(message.includes(secret), false, message);
        return true;
      });
    });
    assert.equal(called, false);
  } finally {
    await srv.close();
  }
});

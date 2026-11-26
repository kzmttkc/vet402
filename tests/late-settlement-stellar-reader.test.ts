// ============================================================
// Stellar の読み手（2026-11-26・recover-late.ts makeStellarTransferReader）。
//
// 守ること:
//  1. USDC transfer（from = payer・issuer 一致）だけを拾う。
//  2. transaction_successful が false の tx は捨てる。
//  3. 7 桁目が 0 でない額は捨てる。
//  4. 429 や HTTP 失敗は null（印を付けない）。
//  5. 窓の始まりより古い operation に届くまで頁を遡り、そこで止める。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  STELLAR_LATE_READ_MAX_PAGES,
  STELLAR_LATE_READ_OPERATIONS_PER_PAGE,
  makeStellarTransferReader,
  type StellarHorizonLateReadClient,
} from "@/lib/settlements/recover-late";
import { STELLAR_PUBNET_CAIP2, STELLAR_USDC_ISSUER } from "@/lib/observatory/stellar402-payer";

const PAYER = "GCEOU7BSH7RIVZXYQJUYBS76YCTNVB63XWZGT5ZNPWMJW6MUQKN2KX7C";
const PAY_TO = "GBIX2M7HEXAMPLEPAYTOADDRESSAAAAAAAAAAAAAAAAAAAAAA";
const AT = Date.parse("2026-11-25T00:01:34Z");
const FROM = new Date(AT - 2 * 60_000);
const TO = new Date(AT + 30 * 60_000);
const STELLAR = STELLAR_PUBNET_CAIP2;

const txHash = () => randomBytes(32).toString("hex");

const usdcTransfer = (to: string, amount: string, over: Record<string, unknown> = {}) => ({
  type: "invoke_host_function",
  transaction_successful: true,
  transaction_hash: over.transaction_hash ?? txHash(),
  created_at: over.created_at ?? new Date(AT).toISOString(),
  asset_balance_changes: [
    {
      asset_code: "USDC",
      asset_issuer: STELLAR_USDC_ISSUER,
      type: "transfer",
      from: PAYER,
      to,
      amount,
    },
  ],
  ...over,
});

type Page = { records: unknown[]; nextCursor: string | null };

function fakeHorizon(pages: Page[] | null) {
  const calls: { payer: string; cursor?: string }[] = [];
  let pageIndex = 0;
  const client: StellarHorizonLateReadClient = {
    getOperationsPage: async (payer, cursor) => {
      calls.push({ payer, cursor });
      if (pages === null) return null;
      const page = pages[pageIndex++];
      if (!page) return { records: [], nextCursor: null };
      return page;
    },
  };
  return { client, calls };
}

const query = { network: STELLAR, payer: PAYER, payTo: PAY_TO, from: FROM, to: TO, timeoutMs: 10_000 };

test("Stellar reader: picks USDC transfer in the window", async () => {
  const hash = txHash();
  const op = usdcTransfer(PAY_TO, "0.0050000", { transaction_hash: hash });
  const { client } = fakeHorizon([{ records: [op], nextCursor: null }]);
  const out = await makeStellarTransferReader(client)(query);
  assert.deepEqual(out, [{ txHash: hash.toLowerCase(), from: PAYER, to: PAY_TO, value: "5000", blockTime: op.created_at }]);
});

test("Stellar reader: classic payment USDC in the window", async () => {
  const hash = txHash();
  const createdAt = new Date(AT).toISOString();
  const op = {
    type: "payment",
    transaction_successful: true,
    transaction_hash: hash,
    created_at: createdAt,
    from: PAYER,
    to: PAY_TO,
    amount: "0.0050000",
    asset_code: "USDC",
    asset_issuer: STELLAR_USDC_ISSUER,
  };
  const { client } = fakeHorizon([{ records: [op], nextCursor: null }]);
  const out = await makeStellarTransferReader(client)(query);
  assert.deepEqual(out, [{ txHash: hash.toLowerCase(), from: PAYER, to: PAY_TO, value: "5000", blockTime: createdAt }]);
});

test("Stellar reader: skips failed txs, non-USDC, wrong payee, and 7th decimal", async () => {
  const hash = txHash();
  const good = usdcTransfer(PAY_TO, "0.0050000", { transaction_hash: hash });
  const failed = usdcTransfer(PAY_TO, "0.0050000", { transaction_successful: false, transaction_hash: txHash() });
  const xlm = {
    ...good,
    transaction_hash: txHash(),
    asset_balance_changes: [{ type: "transfer", from: PAYER, to: PAY_TO, asset_code: "XLM", asset_issuer: "", amount: "0.0050000" }],
  };
  const wrongTo = usdcTransfer("GOTHER", "0.0050000", { transaction_hash: txHash() });
  const seventh = usdcTransfer(PAY_TO, "0.0050001", { transaction_hash: txHash() });
  const { client } = fakeHorizon([{ records: [seventh, wrongTo, xlm, failed, good], nextCursor: null }]);
  const out = await makeStellarTransferReader(client)(query);
  assert.equal(out?.length, 1);
  assert.equal(out![0].txHash, hash.toLowerCase());
});

test("Stellar reader: 429 and malformed pages return null", async () => {
  assert.equal(await makeStellarTransferReader({ getOperationsPage: async () => null })(query), null);
  const bad: StellarHorizonLateReadClient = {
    getOperationsPage: async () => ({ records: [{ created_at: 123 }], nextCursor: null }),
  };
  assert.equal(await makeStellarTransferReader(bad)(query), null);
});

test("Stellar reader: pages until window start, then stops", async () => {
  const hash = txHash();
  const inWin = usdcTransfer(PAY_TO, "0.0050000", { transaction_hash: hash, created_at: new Date(AT).toISOString() });
  const old = usdcTransfer(PAY_TO, "0.0050000", {
    transaction_hash: txHash(),
    created_at: new Date(FROM.getTime() - 3_600_000).toISOString(),
  });
  const filler = Array.from({ length: STELLAR_LATE_READ_OPERATIONS_PER_PAGE - 1 }, (_, i) => ({
    transaction_successful: true,
    transaction_hash: txHash(),
    created_at: new Date(AT + 60_000 + i).toISOString(),
    asset_balance_changes: [],
  }));
  const page1 = [...filler, inWin];
  const page2 = [old];
  const { client, calls } = fakeHorizon([
    { records: page1, nextCursor: "cursor-page-2" },
    { records: page2, nextCursor: null },
  ]);
  const out = await makeStellarTransferReader(client)(query);
  assert.equal(out?.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, "cursor-page-2");
  const endless = Array.from({ length: STELLAR_LATE_READ_MAX_PAGES + 1 }, (_, i) => ({
    records: Array.from({ length: STELLAR_LATE_READ_OPERATIONS_PER_PAGE }, () => ({
      transaction_successful: true,
      transaction_hash: txHash(),
      created_at: new Date(AT + 60_000).toISOString(),
      asset_balance_changes: [],
    })),
    nextCursor: `c${i}`,
  }));
  const deep = fakeHorizon(endless);
  assert.equal(await makeStellarTransferReader(deep.client)(query), null, "page cap before window start → null");
  assert.equal(deep.calls.length, STELLAR_LATE_READ_MAX_PAGES);
});

test("Stellar reader: another network returns null", async () => {
  const { client } = fakeHorizon([{ records: [], nextCursor: null }]);
  assert.equal(await makeStellarTransferReader(client)({ ...query, network: "eip155:8453" }), null);
});
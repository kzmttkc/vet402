import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateDaily,
  buildX402RevenueFromRaw,
  computeTotals,
  mapRawToInbound,
} from "@/lib/kpi/x402-revenue";
import { exclusionForInboundTransfer, vet402OwnPayerAddressesBase } from "@/lib/kpi/own-payers";
import { VET402_BASE_USDC_PAY_TO } from "@/lib/kpi/payto";

const PAY_TO = VET402_BASE_USDC_PAY_TO.toLowerCase();
const OUTSIDER = "0x1111111111111111111111111111111111111111";
const OWN = PAY_TO;

describe("kpi x402 revenue", () => {
  test("exclusion: own payer and self-transfer", () => {
    const own = new Set([OWN]);
    assert.equal(exclusionForInboundTransfer(OWN, PAY_TO, own).excluded, true);
    assert.equal(exclusionForInboundTransfer(OUTSIDER, PAY_TO, own).excluded, false);
    assert.equal(exclusionForInboundTransfer(PAY_TO, PAY_TO, own).excluded, true);
  });

  test("deterministic sort: time, block, hash, from", () => {
    const raw = [
      {
        txHash: "0xbbb",
        blockNumber: "2",
        timeStamp: "1730000000",
        from: OUTSIDER,
        to: PAY_TO,
        value: "10000",
      },
      {
        txHash: "0xaaa",
        blockNumber: "1",
        timeStamp: "1730000000",
        from: OUTSIDER,
        to: PAY_TO,
        value: "5000",
      },
      {
        txHash: "0xccc",
        blockNumber: "3",
        timeStamp: "1729900000",
        from: OUTSIDER,
        to: PAY_TO,
        value: "1",
      },
    ];
    const mapped = mapRawToInbound(raw, new Set());
    assert.equal(mapped[0].txHash, "0xccc");
    assert.equal(mapped[1].txHash, "0xaaa");
    assert.equal(mapped[2].txHash, "0xbbb");
    const again = mapRawToInbound([...raw].reverse(), new Set());
    assert.deepEqual(
      again.map((t) => t.txHash),
      mapped.map((t) => t.txHash),
    );
  });

  test("deterministic sort: same tx and sender are ordered by amount, not input order", () => {
    const row = (value: string) => ({
      txHash: "0xsame",
      blockNumber: "5",
      timeStamp: "1730000000",
      from: OUTSIDER,
      to: PAY_TO,
      value,
    });
    const raw = [row("300"), row("100"), row("200")];
    const a = mapRawToInbound(raw, new Set()).map((t) => t.amountUnits);
    const b = mapRawToInbound([...raw].reverse(), new Set()).map((t) => t.amountUnits);
    assert.deepEqual(a, ["100", "200", "300"]);
    assert.deepEqual(b, a);
  });

  test("daily totals exclude own inbound", () => {
    const raw = [
      {
        txHash: "0x1",
        blockNumber: "10",
        timeStamp: "1730419200",
        from: OUTSIDER,
        to: PAY_TO,
        value: "10000",
      },
      {
        txHash: "0x2",
        blockNumber: "11",
        timeStamp: "1730419200",
        from: OWN,
        to: PAY_TO,
        value: "5000",
      },
    ];
    const own = vet402OwnPayerAddressesBase({
      ...process.env,
      VET402_OPERATOR_PAYTO: "",
      OBSERVATORY_TEST_WALLETS: "",
      VET402_KPI_EXTRA_OWN_PAYERS: "",
    });
    const agg = buildX402RevenueFromRaw("2024-11-01", "2024-11-02", raw, own, "alchemy");
    assert.equal(agg.totals.includedAmountUnits, "10000");
    assert.equal(agg.totals.excludedTransferCount, 1);
    assert.equal(agg.daily[0].transferCount, 2);
    assert.equal(agg.daily[0].amountUnits, "15000");
  });

  test("ok with zero transfers still reports numeric zeros", () => {
    const agg = buildX402RevenueFromRaw("2024-11-01", "2024-11-02", [], new Set(), "alchemy");
    assert.equal(agg.readStatus, "ok");
    assert.equal(agg.totals.includedAmountUnits, "0");
    assert.equal(aggregateDaily([]).length, 0);
    assert.equal(computeTotals([]).includedTransferCount, 0);
  });
});
// ---- 公開 RPC の読み手（鍵なし）。偽の JSON-RPC で刻み幅・除外・読めなかった扱いを確かめる ----
import { fetchX402RevenueAggregate } from "@/lib/kpi/x402-revenue";
import { PUBLIC_RPC_LOG_CHUNK_BLOCKS, type JsonRpcFetch } from "@/lib/kpi/x402-revenue-reader";
import { VET402_ROBINHOOD_L1_PAYER } from "@/lib/kpi/own-payers";

const GENESIS_SEC = Date.parse("2026-01-01T00:00:00Z") / 1000;
const HEAD = 15_000_000; // 2 秒/ブロック → 2026-01-01 から約 347 日（12 月中旬）
const blockSec = (n: number) => GENESIS_SEC + n * 2;
const topicOf = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;

function fakeRpc(opts: {
  logs: Array<{ block: number; from: string; value: bigint; tx: string; logIndex?: number }>;
  failGetLogsAt?: number;
  /** これより古いブロックは公開 RPC と同じく 403 の archive で断る */
  archiveBelow?: number;
}) {
  const ranges: Array<[number, number]> = [];
  const impl: JsonRpcFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string; params: any[] };
    let result: unknown;
    const archive403 = () => ({
      ok: false,
      status: 403,
      json: async () => ({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Archive requests require a personal token." } }),
    });
    if (req.method === "eth_blockNumber") result = `0x${HEAD.toString(16)}`;
    else if (req.method === "eth_getBlockByNumber") {
      const n = Number(BigInt(req.params[0]));
      if (opts.archiveBelow !== undefined && n < opts.archiveBelow) return archive403();
      result = { timestamp: `0x${blockSec(n).toString(16)}` };
    } else if (req.method === "eth_getLogs") {
      const f = Number(BigInt(req.params[0].fromBlock));
      const t = Number(BigInt(req.params[0].toBlock));
      if (opts.archiveBelow !== undefined && f < opts.archiveBelow) return archive403();
      ranges.push([f, t]);
      if (opts.failGetLogsAt !== undefined && ranges.length === opts.failGetLogsAt) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: req.id, error: { message: "boom" } }) };
      }
      result = opts.logs
        .filter((l) => l.block >= f && l.block <= t)
        .map((l) => ({
          transactionHash: l.tx,
          blockNumber: `0x${l.block.toString(16)}`,
          logIndex: `0x${(l.logIndex ?? 0).toString(16)}`,
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            topicOf(l.from),
            topicOf(PAY_TO),
          ],
          data: `0x${l.value.toString(16).padStart(64, "0")}`,
        }));
    } else throw new Error(`unexpected ${req.method}`);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: req.id, result }) };
  };
  return { impl, ranges };
}

describe("kpi x402 revenue via public RPC", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, VET402_OPERATOR_PAYTO: "", OBSERVATORY_TEST_WALLETS: "", VET402_KPI_EXTRA_OWN_PAYERS: "" };

  test("own Robinhood payer is in the static exclusion list", () => {
    assert.ok(vet402OwnPayerAddressesBase(env).has(VET402_ROBINHOOD_L1_PAYER.toLowerCase()));
  });

  test("reads in 50,000-block chunks, excludes own payer, keeps outsider", async () => {
    const inNov = Math.floor((Date.parse("2026-11-10T00:00:00Z") / 1000 - GENESIS_SEC) / 2);
    const { impl, ranges } = fakeRpc({
      logs: [
        { block: inNov, from: VET402_ROBINHOOD_L1_PAYER, value: 10_000n, tx: "0xa1" },
        { block: inNov + 5, from: OUTSIDER, value: 5_000n, tx: "0xa2" },
        { block: inNov - 6_000_000, from: OUTSIDER, value: 1n, tx: "0xold" },
      ],
    });
    const agg = await fetchX402RevenueAggregate("2026-11-01", "2026-12-01", {
      skipAlchemy: true,
      fetchImpl: impl,
      env,
    });
    assert.equal(agg.readStatus, "ok");
    assert.equal(agg.source, "public_rpc");
    assert.ok(ranges.length >= 2);
    for (const [f, t] of ranges) assert.ok(t - f + 1 <= PUBLIC_RPC_LOG_CHUNK_BLOCKS);
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
    assert.equal(agg.totals.transferCount, 2);
    assert.equal(agg.totals.excludedTransferCount, 1);
    assert.equal(agg.totals.excludedAmountUnits, "10000");
    assert.equal(agg.totals.includedTransferCount, 1);
    assert.equal(agg.totals.includedAmountUnits, "5000");
    assert.equal(agg.periodComplete, true);
    assert.ok(agg.readThroughUtc && agg.readThroughUtc >= "2026-12-01");
  });

  test("two equal Transfers in one tx are both counted (logIndex)", async () => {
    const b = Math.floor((Date.parse("2026-11-10T00:00:00Z") / 1000 - GENESIS_SEC) / 2);
    const { impl } = fakeRpc({
      logs: [
        { block: b, from: OUTSIDER, value: 5_000n, tx: "0xsame", logIndex: 1 },
        { block: b, from: OUTSIDER, value: 5_000n, tx: "0xsame", logIndex: 2 },
      ],
    });
    const agg = await fetchX402RevenueAggregate("2026-11-01", "2026-12-01", { skipAlchemy: true, fetchImpl: impl, env });
    assert.equal(agg.totals.includedTransferCount, 2);
    assert.equal(agg.totals.includedAmountUnits, "10000");
  });

  test("a month still in progress is ok but not complete", async () => {
    const { impl } = fakeRpc({ logs: [] });
    const agg = await fetchX402RevenueAggregate("2026-12-01", "2027-01-01", { skipAlchemy: true, fetchImpl: impl, env });
    assert.equal(agg.readStatus, "ok");
    assert.equal(agg.periodComplete, false);
  });

  test("a failed getLogs chunk makes the whole period unreadable, not zero", async () => {
    const { impl } = fakeRpc({ logs: [], failGetLogsAt: 2 });
    const agg = await fetchX402RevenueAggregate("2026-11-01", "2026-12-01", {
      skipAlchemy: true,
      fetchImpl: impl,
      env,
    });
    assert.equal(agg.readStatus, "unreadable");
    assert.equal(agg.totals.transferCount, null);
    assert.equal(agg.totals.includedAmountUnits, null);
    assert.match(agg.readDetail ?? "", /public_rpc_error:eth_getLogs:boom/);
  });

  test("window just inside the retained range: overshoot retreats instead of failing", async () => {
    const novStart = Math.floor((Date.parse("2026-11-01T00:00:00Z") / 1000 - GENESIS_SEC) / 2);
    const { impl } = fakeRpc({
      logs: [{ block: novStart + 10, from: OUTSIDER, value: 7n, tx: "0xb1" }],
      archiveBelow: novStart - 50,
    });
    const agg = await fetchX402RevenueAggregate("2026-11-01", "2026-12-01", { skipAlchemy: true, fetchImpl: impl, env });
    assert.equal(agg.readStatus, "ok");
    assert.equal(agg.totals.includedAmountUnits, "7");
  });

  test("window older than the retained range is unreadable", async () => {
    const novStart = Math.floor((Date.parse("2026-11-01T00:00:00Z") / 1000 - GENESIS_SEC) / 2);
    const { impl } = fakeRpc({ logs: [], archiveBelow: novStart + 1000 });
    const agg = await fetchX402RevenueAggregate("2026-11-01", "2026-12-01", { skipAlchemy: true, fetchImpl: impl, env });
    assert.equal(agg.readStatus, "unreadable");
    assert.equal(agg.totals.transferCount, null);
    assert.match(agg.readDetail ?? "", /archive_range_refused/);
  });
});

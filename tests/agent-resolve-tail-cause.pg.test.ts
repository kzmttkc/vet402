// ============================================================
// wallet→agent が読めないときの error.cause（2026-11-02・監査 H3）。catch が理由を捨てていたので、本番で全部
// erc8004_unavailable になっても原因が読めなかった。tail の失敗・索引の遅れ・索引なしの 3 つの理由を固定する。
//
// Run: TEST_DATABASE_URL=postgres://localhost/<test db> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/agent-resolve-tail-cause.pg.test.ts
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("agent resolve tail cause (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TIP = 60_000_000n;
  let server: Server | null = null;
  after(() => server?.close());

  /** eth_blockNumber は答え、eth_getLogs は JSON-RPC の誤りで断る読み先（手元だけ）。 */
  const startRpc = async (): Promise<string> => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { id: number; method: string };
        const out =
          body.method === "eth_blockNumber"
            ? { jsonrpc: "2.0", id: body.id, result: `0x${TIP.toString(16)}` }
            : { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "tail read refused" } };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  test("resolveAgentIdByWallet: 読めない理由を cause に残し、負にキャッシュしない", async () => {
    const url = await startRpc();
    process.env.BASE_RPC_URL = url;
    process.env.INDEXER_RPC_URL = url;
    process.env.LOG_SCAN_FALLBACK_RPC_URLS = "none";
    delete process.env.SKIP_CHAIN_READS;

    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { resolveAgentIdByWallet, invalidateResolverCache } = await import("@/lib/chain/agent-resolver");
    const { AGENT_WALLET_INDEX_CHECKPOINT, OWNER_INDEX_CHECKPOINT } = await import("@/lib/db/owner-index");
    const db = getDb()!;
    const setCheckpoints = async (block: bigint | null) => {
      await db.execute(sql`TRUNCATE indexer_checkpoints`);
      if (block === null) return;
      for (const scope of [OWNER_INDEX_CHECKPOINT, AGENT_WALLET_INDEX_CHECKPOINT]) {
        await db.execute(sql`INSERT INTO indexer_checkpoints (scope, last_block) VALUES (${scope}, ${block.toString()}::bigint)`);
      }
    };
    const WALLET = "0x00000000000000000000000000000000000000d1" as const;
    const causeOf = async (): Promise<string> => {
      invalidateResolverCache();
      const err = (await resolveAgentIdByWallet(WALLET).then(
        () => assert.fail("読めないのに答えた"),
        (e: unknown) => e,
      )) as Error;
      assert.equal(err.message, "agent_resolve_unavailable");
      assert.ok(err.cause instanceof Error, "cause が無い");
      return String(err.cause.message);
    };

    await setCheckpoints(null);
    assert.equal(await causeOf(), "index_missing");

    await setCheckpoints(TIP - 1_000_000n);
    assert.equal(await causeOf(), "index_gap_too_large");

    // tail の読みが断られた: 断った読み先の言葉が cause に残る。
    await setCheckpoints(TIP - 500n);
    assert.match(await causeOf(), /tail read refused/);
    // 読めなかった答えを「エージェントではない」として持たない: 消さずにもう一度聞いても null を返さない。
    await assert.rejects(resolveAgentIdByWallet(WALLET), /agent_resolve_unavailable/);

    await db.execute(sql`TRUNCATE indexer_checkpoints`);
  });
}

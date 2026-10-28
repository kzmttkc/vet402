import { test } from "node:test";
import assert from "node:assert/strict";

test("queryGatewayPostBodyUnknownActive は DB 失敗時 null を返し例外を投げない", async () => {
  const { queryGatewayPostBodyUnknownActive } = await import("@/lib/observatory/l1-runner");
  const db = {
    execute: async () => {
      throw new Error("db down");
    },
  };
  assert.equal(await queryGatewayPostBodyUnknownActive(db as never), null);
});

test("旗 off の数える問い合わせは SELECT 0 相当", async () => {
  const saved = process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
  delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
  try {
    const { gatewayPostBodyUnknownExcludedCountSql } = await import("@/lib/observatory/arc-gateway");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const text = new PgDialect().sqlToQuery(gatewayPostBodyUnknownExcludedCountSql()).sql;
    assert.match(text, /SELECT 0::int AS n/);
  } finally {
    if (saved === undefined) delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
    else process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = saved;
  }
});

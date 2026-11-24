// Base ledger-root anchor tx: calldata, verification, and POST registration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stringToHex, type Address, type Hex } from "viem";
import {
  anchorCalldataMessage,
  buildAnchorCalldata,
  parseAnchorCalldata,
  registerLedgerAnchorTx,
  verifyAnchorBaseTx,
  type AnchorBaseRpc,
} from "@/lib/observatory/anchor-base";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

function fakeRoot(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const SAMPLE_DAYS = ["2020-01-01", "2024-06-15", "2026-11-24", "2030-12-31"];

test("calldata message roundtrip for many day/root pairs", () => {
  for (const day of SAMPLE_DAYS) {
    for (let i = 0; i < 5; i++) {
      const root = fakeRoot(`${day}:${i}`);
      const msg = anchorCalldataMessage(day, root);
      const input = buildAnchorCalldata(day, root);
      assert.equal(msg, `vet402-anchor:v1:${day}:${root}`);
      assert.equal(input, stringToHex(msg));
      const parsed = parseAnchorCalldata(input);
      assert.deepEqual(parsed, { day, rootHash: root });
    }
  }
});

function rpcFromTx(
  tx: { from: Address; to: Address | null; input: Hex; value?: bigint; status?: "success" | "reverted" },
  hash: Hex = `0x${"ab".repeat(32)}` as Hex,
) {
  const status = tx.status ?? "success";
  const full = { ...tx, value: tx.value ?? 0n };
  const map = new Map<string, typeof full & { status: "success" | "reverted" }>();
  map.set(hash.toLowerCase(), { ...full, status });
  const rpc: AnchorBaseRpc = {
    async getTransactionReceipt(h) {
      const row = map.get(h.toLowerCase());
      return row ? { status: row.status } : null;
    },
    async getTransaction(h) {
      const row = map.get(h.toLowerCase());
      if (!row) return null;
      return { from: row.from, to: row.to, input: row.input, value: row.value };
    },
  };
  return { rpc, hash };
}

test("verify rejects failed receipt, non-self send, signer mismatch, calldata mismatch", async () => {
  const day = "2026-11-24";
  const root = fakeRoot("root-a");
  const input = buildAnchorCalldata(day, root);

  const failed = rpcFromTx({ from: SIGNER, to: SIGNER, input, status: "reverted" });
  assert.equal(
    (await verifyAnchorBaseTx(failed.hash, day, root, SIGNER, failed.rpc)).error,
    "anchor_tx_receipt_failed",
  );

  const notSelf = rpcFromTx({ from: SIGNER, to: OTHER, input });
  assert.equal(
    (await verifyAnchorBaseTx(notSelf.hash, day, root, SIGNER, notSelf.rpc)).error,
    "anchor_tx_not_self_send",
  );

  const wrongSigner = rpcFromTx({ from: OTHER, to: OTHER, input });
  assert.equal(
    (await verifyAnchorBaseTx(wrongSigner.hash, day, root, SIGNER, wrongSigner.rpc)).error,
    "anchor_tx_signer_mismatch",
  );

  const wrongDay = rpcFromTx({ from: SIGNER, to: SIGNER, input: buildAnchorCalldata("2026-11-23", root) });
  assert.equal(
    (await verifyAnchorBaseTx(wrongDay.hash, day, root, SIGNER, wrongDay.rpc)).error,
    "anchor_tx_calldata_mismatch",
  );
});

test("registerLedgerAnchorTx updates anchored_tx on success and 409 when already set", async () => {
  const day = "2026-11-20";
  const root = fakeRoot("ledger");
  const txHash = `0x${"cd".repeat(32)}` as Hex;
  const input = buildAnchorCalldata(day, root);

  const { observatoryFakeDb } = await import("./helpers/observatory-fake-db");
  const db = observatoryFakeDb({
    l1: [],
    ledger_anchors: [{ day, root_hash: root, prev_root: null, entry_count: 0, anchored_tx: null }],
  });

  const { rpc } = rpcFromTx({ from: SIGNER, to: SIGNER, input }, txHash);
  const ok = await registerLedgerAnchorTx(db as never, { day, txHash, chainId: 8453 }, rpc, SIGNER);
  assert.equal(ok.ok, true);
  assert.equal(db.tables.ledger_anchors[0].anchored_tx, txHash);

  const again = await registerLedgerAnchorTx(db as never, { day, txHash, chainId: 8453 }, rpc, SIGNER);
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.equal(again.error, "anchor_tx_already_set");
    assert.equal(again.status, 409);
  }
});

test("POST route auth and config gates", async () => {
  const prevSecret = process.env.ANCHOR_POST_SECRET;
  const prevSigner = process.env.ANCHOR_BASE_SIGNER;
  const prevDb = process.env.DATABASE_URL;
  delete process.env.ANCHOR_POST_SECRET;
  delete process.env.ANCHOR_BASE_SIGNER;
  delete process.env.DATABASE_URL;
  const { POST } = await import("@/app/api/v1/observatory/anchors/tx/route");
  const { NextRequest } = await import("next/server");
  const res = await POST(
    new NextRequest("http://localhost/api/v1/observatory/anchors/tx", {
      method: "POST",
      headers: { Authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ day: "2026-11-24", txHash: `0x${"11".repeat(32)}`, chainId: 8453 }),
    }),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "anchor_post_unconfigured");
  if (prevSecret === undefined) delete process.env.ANCHOR_POST_SECRET;
  else process.env.ANCHOR_POST_SECRET = prevSecret;
  if (prevSigner === undefined) delete process.env.ANCHOR_BASE_SIGNER;
  else process.env.ANCHOR_BASE_SIGNER = prevSigner;
  if (prevDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDb;
});
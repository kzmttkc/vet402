// Stellar の台帳 network は壁の文字列ではなく定数。DB は要らない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseLedgerNetwork } from "@/lib/observatory/l1-runner";

test("Stellar の台帳 network は壁の表記ではなく stellar:pubnet", () => {
  assert.equal(
    purchaseLedgerNetwork({ isXrpl: false, isStellar: true, acceptNetwork: "stellar:pubnet " }),
    "stellar:pubnet",
  );
  assert.equal(
    purchaseLedgerNetwork({ isXrpl: false, isStellar: true, acceptNetwork: "STELLAR:pubnet" }),
    "stellar:pubnet",
  );
  assert.equal(
    purchaseLedgerNetwork({ isXrpl: false, isStellar: false, acceptNetwork: "eip155:8453" }),
    "eip155:8453",
  );
  assert.equal(
    purchaseLedgerNetwork({ isXrpl: true, isStellar: false, acceptNetwork: "xrpl:0-from-wall" }),
    "xrpl:0",
  );
});

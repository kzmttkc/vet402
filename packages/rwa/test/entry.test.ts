import { test } from "node:test";
import assert from "node:assert/strict";
import { entryTarget } from "../entry";

const A = "0xE9B08727131E34010b34006c660D4c1B436EC25f";

test("empty input stays on the entry page", () => {
  assert.deepEqual(entryTarget(undefined), { kind: "empty" });
  assert.deepEqual(entryTarget("   "), { kind: "empty" });
});

test("a bare address goes to its checksummed record page", () => {
  assert.deepEqual(entryTarget(A.toLowerCase()), { kind: "go", path: `/rwa/${A}` });
  assert.deepEqual(entryTarget(` ${A} `), { kind: "go", path: `/rwa/${A}` });
});

test("a wrong checksum is the same address, not an error", () => {
  assert.deepEqual(entryTarget(A.toUpperCase().replace("0X", "0x")), { kind: "go", path: `/rwa/${A}` });
});

test("explorer and vet402 URLs are read for their address", () => {
  assert.deepEqual(entryTarget(`https://robinhoodchain.blockscout.com/address/${A}?tab=txs`), { kind: "go", path: `/rwa/${A}` });
  assert.deepEqual(entryTarget(`vet402.com/rwa/${A}`), { kind: "go", path: `/rwa/${A}` });
});

test("a transaction hash is not taken for an address", () => {
  const tx = "0x9b776d6a4670768e3e85261fcf3a5fc02012668e3323fee7211b07d8deca72d7";
  assert.deepEqual(entryTarget(tx), { kind: "invalid" });
  assert.deepEqual(entryTarget(`https://robinhoodchain.blockscout.com/tx/${tx}`), { kind: "invalid" });
});

test("anything else is invalid", () => {
  assert.deepEqual(entryTarget("nvidia"), { kind: "invalid" });
  assert.deepEqual(entryTarget("0x1234"), { kind: "invalid" });
  assert.deepEqual(entryTarget(["", A]), { kind: "empty" });
});

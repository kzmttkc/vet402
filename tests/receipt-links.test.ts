// ============================================================
// vet402 — 受領証への到達（2026-09-02 敵対的監査 F3 / F4 と endpoint 頁の Solana 受領証）。
//
//   F3  /decisions の endpoint 名と受領証 tx がリンクでない
//   F4  /impact に tx ハッシュが 0 本
//   endpoint 頁は basescan 固定で、Solana の tx が壊れたリンクになっていた
// 解決は 1 箇所: chains.ts の explorerTxUrl(chain, tx) を 3 頁が共有する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explorerTxUrl } from "@/lib/observatory/chains";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const EVM_TX = "0x" + "ab".repeat(32);
const SOL_TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

test("explorerTxUrl: Base and its legacy slug go to basescan", () => {
  assert.equal(explorerTxUrl("eip155:8453", EVM_TX), `https://basescan.org/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("base", EVM_TX), `https://basescan.org/tx/${EVM_TX}`);
});

test("explorerTxUrl: Polygon goes to polygonscan", () => {
  assert.equal(explorerTxUrl("eip155:137", EVM_TX), `https://polygonscan.com/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("polygon", EVM_TX), `https://polygonscan.com/tx/${EVM_TX}`);
});

test("explorerTxUrl: Solana mainnet goes to solscan", () => {
  assert.equal(
    explorerTxUrl("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", SOL_TX),
    `https://solscan.io/tx/${SOL_TX}`,
  );
});

test("explorerTxUrl: unknown chain, missing tx, or a malformed tx yields null (no broken link)", () => {
  assert.equal(explorerTxUrl("eip155:999999", EVM_TX), null);
  assert.equal(explorerTxUrl(null, EVM_TX), null);
  assert.equal(explorerTxUrl("eip155:8453", null), null);
  assert.equal(explorerTxUrl("eip155:8453", "javascript:alert(1)"), null);
  assert.equal(explorerTxUrl("eip155:8453", "not a hash"), null);
});

test("/decisions links each endpoint to its record page and each receipt to its explorer", () => {
  const page = read("src/app/decisions/page.tsx");
  assert.ok(page.includes("explorerTxUrl"));
  assert.ok(page.includes("/observatory/e/${"), "endpoint name links to /observatory/e/[id]");
  const lib = read("src/lib/observatory/decisions.ts");
  assert.ok(lib.includes("endpointId"), "decision rows carry the endpoint id");
});

test("/impact lists the latest settled receipts with explorer links", () => {
  const page = read("src/app/impact/page.tsx");
  assert.ok(page.includes("Latest settled receipts"));
  assert.ok(page.includes("explorerTxUrl"));
  assert.ok(page.includes("/observatory/e/${"));
});

test("endpoint record page uses explorerTxUrl, not a hard-coded basescan", () => {
  const page = read("src/app/observatory/e/[id]/page.tsx");
  assert.ok(page.includes("explorerTxUrl"));
  assert.ok(!page.includes("https://basescan.org/tx/"));
});

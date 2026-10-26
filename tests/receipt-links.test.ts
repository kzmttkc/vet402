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
import { chainLabel, explorerTxUrl, receiptNetwork } from "@/lib/observatory/chains";

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

test("/impact lists the latest settled transactions with explorer links", () => {
  const page = read("src/app/impact/page.tsx");
  // 2026-09-29 監査 5 周目: vet402 の索引が見つけた取引を「Receipt」と呼ばない。表の名前は transactions、
  // 誰が tx を名指したか（settlement_source）を列で出す。
  assert.ok(page.includes("Latest settled transactions"));
  assert.ok(!page.includes("Latest settled receipts</p>"), "表題に receipts を戻さない");
  assert.ok(page.includes("Named by"));
  assert.ok(page.includes('r.settlementSource === "vet402_index"'));
  assert.ok(page.includes("explorerTxUrl"));
  assert.ok(page.includes("/observatory/e/${"));
});

test("endpoint record page uses explorerTxUrl, not a hard-coded basescan", () => {
  const page = read("src/app/observatory/e/[id]/page.tsx");
  assert.ok(page.includes("explorerTxUrl"));
  assert.ok(!page.includes("https://basescan.org/tx/"));
});

// 2026-09-17 Arc レーン: Arc の受領証は explorer.arc.io（testnet には作らない——URL を確かめていない）。
test("explorerTxUrl: Arc mainnet goes to explorer.arc.io; the 'arc' slug and the testnet are handled", () => {
  assert.equal(explorerTxUrl("eip155:5042", EVM_TX), `https://explorer.arc.io/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("arc", EVM_TX), `https://explorer.arc.io/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("eip155:5042", SOL_TX), null, "a base58 signature is not an Arc tx");
  assert.equal(explorerTxUrl("eip155:5042002", EVM_TX), null, "no explorer pinned for the testnet → no link rather than a guessed one");
});

// 2026-10-21: 出品の network でリンクすると、BSC で払った tx が basescan の not found になる。
// 本番で確認した tx（api.nansen.ai/api/v1/perp-screener、eip155:56）。
const BSC_TX = "0x36e0fe70dd519899544c49a697eaa60363a8234e4521ba4c8e95af6d81fb7e9f";
const HEX64 = "ab".repeat(32);
const XRPL_TX = "AB".repeat(32);

test("receiptNetwork uses the purchase row and falls back when that row is null or empty", () => {
  assert.equal(receiptNetwork("eip155:56", "eip155:8453"), "eip155:56");
  assert.equal(receiptNetwork(null, "eip155:8453"), "eip155:8453");
  assert.equal(receiptNetwork(undefined, "base"), "base");
  assert.equal(receiptNetwork(null, null), null);
  assert.equal(receiptNetwork("", "eip155:8453"), "eip155:8453", "empty is treated as missing, like nullif(pu.network, '') in metrics-rollup");
});

test("explorerTxUrl: BSC, Celo, Stellar, Base, Solana, XRPL, malformed hashes, and testnets", () => {
  assert.equal(explorerTxUrl("eip155:56", BSC_TX), `https://bscscan.com/tx/${BSC_TX}`);
  assert.equal(explorerTxUrl(receiptNetwork("eip155:56", "eip155:8453"), BSC_TX), `https://bscscan.com/tx/${BSC_TX}`);
  assert.equal(explorerTxUrl("eip155:97", BSC_TX), null, "BSC testnet");
  assert.equal(explorerTxUrl("eip155:56", BSC_TX.slice(2)), null, "bare hex is not an EVM tx");
  assert.equal(explorerTxUrl("eip155:56", SOL_TX), null);
  assert.equal(explorerTxUrl("eip155:56", "not a hash"), null);

  assert.equal(explorerTxUrl("eip155:42220", EVM_TX), `https://celoscan.io/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("eip155:11142220", EVM_TX), null, "Celo Sepolia");
  assert.equal(explorerTxUrl("eip155:44787", EVM_TX), null, "Celo Alfajores");

  assert.equal(explorerTxUrl("eip155:42161", EVM_TX), `https://arbiscan.io/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("eip155:421614", EVM_TX), null, "Arbitrum Sepolia");

  assert.equal(explorerTxUrl("eip155:43114", EVM_TX), `https://snowtrace.io/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("eip155:43113", EVM_TX), null, "Avalanche Fuji");

  assert.equal(explorerTxUrl("stellar:pubnet", HEX64), `https://stellar.expert/explorer/public/tx/${HEX64}`);
  assert.equal(explorerTxUrl("stellar:pubnet", HEX64.toUpperCase()), `https://stellar.expert/explorer/public/tx/${HEX64.toUpperCase()}`);
  assert.equal(explorerTxUrl("stellar:pubnet", `0x${HEX64}`), null, "a 0x prefix is not a Stellar tx");
  assert.equal(explorerTxUrl("stellar:pubnet", HEX64.slice(0, 63)), null);
  assert.equal(explorerTxUrl("stellar:pubnet", `${HEX64}aa`), null);
  assert.equal(explorerTxUrl("stellar:pubnet", SOL_TX), null);
  assert.equal(explorerTxUrl("stellar:pubnet", ""), null);
  assert.equal(explorerTxUrl("stellar:testnet", HEX64), null);
  assert.equal(explorerTxUrl("stellar:futurenet", HEX64), null);
  assert.equal(explorerTxUrl("Stellar:pubnet", HEX64), null, "the pubnet id is case-sensitive");

  assert.equal(explorerTxUrl("eip155:8453", EVM_TX), `https://basescan.org/tx/${EVM_TX}`);
  assert.equal(explorerTxUrl("base", BSC_TX), `https://basescan.org/tx/${BSC_TX}`, "a well-formed hash still links on Base, which is why the catalog network was a wrong but clickable link");
  assert.equal(
    explorerTxUrl("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", SOL_TX),
    `https://solscan.io/tx/${SOL_TX}`,
  );
  assert.equal(explorerTxUrl("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", SOL_TX), null, "Solana devnet");
  assert.equal(explorerTxUrl("xrpl:0", XRPL_TX), `https://livenet.xrpl.org/transactions/${XRPL_TX}`);
  assert.equal(explorerTxUrl("xrpl:1", XRPL_TX), null, "XRPL testnet");
  assert.equal(explorerTxUrl("eip155:8453", HEX64), null, "bare hex is not a Base tx");
  assert.equal(chainLabel("eip155:56"), "BSC");
  assert.equal(chainLabel("stellar:pubnet"), "stellar:pubnet");
});

test("endpoint record page links a purchase with that row's network", () => {
  const page = read("src/app/observatory/e/[id]/page.tsx");
  assert.match(page, /receiptNetwork\(\s*p\.network,\s*endpoint\.network\s*\)/);
  assert.match(page, /explorerTxUrl\(\s*paidOn,/);
  assert.equal(page.includes("explorerTxUrl(endpoint.network"), false);
  assert.match(page, />Catalog network</);
  assert.match(page, />Payment chain</);
  assert.match(page, /paymentChainLabel\(paidOn\)/);
  const reader = read("src/lib/observatory/reader.ts");
  assert.equal((reader.match(/network: x402L1Purchases\.network,/g) ?? []).length, 2);
});

test("decision feed names the purchase network, falling back to the catalog network", () => {
  const lib = read("src/lib/observatory/decisions.ts");
  assert.match(lib, /coalesce\(pu\.network, e\.network\) AS network/);
  assert.equal((lib.match(/e\.resource_key, e\.network,/g) ?? []).length, 0);
  const page = read("src/app/decisions/page.tsx");
  assert.match(page, /explorerTxUrl\(r\.network, r\.txHash\)/);
});

test("receiptNetwork は空文字を欠落として扱い、Payment chain の表示は stellar:pubnet を Stellar と名乗る", async () => {
  const { receiptNetwork, paymentChainLabel } = await import("@/lib/observatory/chains");
  assert.equal(receiptNetwork("", "eip155:8453"), "eip155:8453");
  assert.equal(receiptNetwork(null, ""), null);
  assert.equal(receiptNetwork("eip155:56", "eip155:8453"), "eip155:56");
  assert.equal(paymentChainLabel("stellar:pubnet"), "Stellar");
  // 公開名は BNB Chain。結合キー chainLabel("eip155:56") は上のテストの通り BSC のまま。
  assert.equal(paymentChainLabel("eip155:56"), "BNB Chain");
});

// ============================================================
// XRPL のチェーン同一性（2026-09-17）: ラベル・テストネット・CAIP-2 への寄せ・受領証リンク・tx の形・party id。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainLabel, explorerTxUrl, isTestnet, toCaip2 } from "@/lib/observatory/chains";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { parsePartyId, payeeId, purchaseId } from "@/lib/ids/canonical";
import { XRPL_DAILY_CAP_USD_DEFAULT, xrplDailyCapUnits } from "@/lib/observatory/budget";

const HASH = "52B7058AC2545B2C5288C43928E77CDDC64A33DFA6E905C7D72192895AE7C766";

test("xrpl:0 は XRPL、1/2 はテストネット。非標準の xrpl / xrpl:mainnet は xrpl:0 に寄せる", () => {
  assert.equal(chainLabel("xrpl:0"), "XRPL");
  assert.equal(chainLabel("xrpl:1"), "XRPL Testnet");
  assert.equal(chainLabel("xrpl:2"), "XRPL Devnet");
  assert.equal(isTestnet("xrpl:0"), false);
  assert.equal(isTestnet("xrpl:1"), true);
  assert.equal(isTestnet("xrpl:2"), true);
  assert.equal(toCaip2("xrpl"), "xrpl:0");
  assert.equal(toCaip2("xrpl:mainnet"), "xrpl:0");
  assert.equal(toCaip2("XRPL:Mainnet"), "xrpl:0");
  assert.equal(chainLabel("xrpl:mainnet"), "xrpl:mainnet", "ラベルは寄せない（未知は原文）");
  assert.equal(chainLabel(toCaip2("xrpl:mainnet")), "XRPL");
});

test("受領証リンク: 64 hex なら livenet.xrpl.org、形が違えば null", () => {
  assert.equal(explorerTxUrl("xrpl:0", HASH), `https://livenet.xrpl.org/transactions/${HASH}`);
  assert.equal(explorerTxUrl("xrpl:mainnet", HASH), `https://livenet.xrpl.org/transactions/${HASH}`);
  assert.equal(explorerTxUrl("xrpl:0", "0x" + "a".repeat(64)), null);
  assert.equal(explorerTxUrl("xrpl:0", "5".repeat(88)), null);
  assert.equal(explorerTxUrl("xrpl:1", HASH), null, "テストネットには作らない");
});

test("tx の形: XRPL は 0x 無しの 64 hex（大文字小文字どちらも）", () => {
  assert.equal(isWellFormedSettlementTx(HASH, "xrpl"), true);
  assert.equal(isWellFormedSettlementTx(HASH.toLowerCase(), "xrpl"), true);
  assert.equal(isWellFormedSettlementTx("0x" + "a".repeat(64), "xrpl"), false);
  assert.equal(isWellFormedSettlementTx("5".repeat(88), "xrpl"), false);
  assert.equal(isWellFormedSettlementTx(HASH, "evm"), false, "EVM の形ではない");
});

test("party id / purchase id: r アドレスと hash は小文字化しない。parsePartyId が xrpl を読む", () => {
  assert.equal(payeeId("xrpl:0", "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32"), "xrpl:0:rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32");
  assert.equal(payeeId("xrpl:mainnet", "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32"), "xrpl:0:rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32");
  assert.equal(purchaseId("xrpl:0", HASH), `xrpl:0:${HASH}`);
  assert.deepEqual(parsePartyId("xrpl:0:rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32"), { chain: "xrpl:0", address: "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32" });
});

test("XRPL の日次別枠: 既定 $2、環境変数で下げられ、壊れた値は既定、$25 で頭打ち", () => {
  const saved = process.env.L1_XRPL_DAILY_CAP_USD;
  const withEnv = (v: string | undefined, fn: () => void) => {
    if (v === undefined) delete process.env.L1_XRPL_DAILY_CAP_USD;
    else process.env.L1_XRPL_DAILY_CAP_USD = v;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.L1_XRPL_DAILY_CAP_USD;
      else process.env.L1_XRPL_DAILY_CAP_USD = saved;
    }
  };
  assert.equal(XRPL_DAILY_CAP_USD_DEFAULT, 2);
  withEnv(undefined, () => assert.equal(xrplDailyCapUnits(), 2_000_000n));
  withEnv("0.5", () => assert.equal(xrplDailyCapUnits(), 500_000n));
  withEnv("0", () => assert.equal(xrplDailyCapUnits(), 0n));
  for (const v of ["", "abc", "-1", "NaN"]) withEnv(v, () => assert.equal(xrplDailyCapUnits(), 2_000_000n, v));
  withEnv("100", () => assert.equal(xrplDailyCapUnits(), 25_000_000n));
});

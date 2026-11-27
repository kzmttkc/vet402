// ============================================================
// Hedera-402 payer（hedera:mainnet / hedera:testnet）——旗・選択・上限・為替・取引 ID・署名の中身・別枠。
// ネットワークには出ない（mirror node は差し替え。署名はローカルで、送信はしない）。
// 鍵は試験用の固定値（本物の口座の鍵ではない）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKY402_FEE_PAYERS,
  HBAR_ASSET,
  HEDERA_MAINNET_CAIP2,
  HEDERA_MAX_PURCHASE_TINYBARS_DEFAULT,
  HEDERA_TESTNET_CAIP2,
  HEDERA_TOTAL_CAP_TINYBARS_DEFAULT,
  checkBuiltHederaTransfer,
  createHederaPaymentPayload,
  hederaL1Network,
  hederaMaxPurchaseTinybars,
  hederaTotalCapTinybars,
  isHederaEntityId,
  ledgerUnitsFromTinybarsFloor,
  loadHederaPayer,
  mirrorHederaTxId,
  normalizeHederaTxId,
  readHederaExchangeRate,
  selectHederaAccept,
  tinybarsToLedgerUnits,
  wouldExceedHederaTotalCap,
} from "@/lib/observatory/hedera402-payer";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { cappedChainFor, chainDailyCapUnits, CHAIN_DAILY_CAPS } from "@/lib/observatory/budget";
import { redactForLog } from "@/lib/observatory/redact";

// 2026-11-27 実測の壁（Agent Weather の id-mint）の Hedera の accept。
const WALL = {
  scheme: "exact",
  network: HEDERA_MAINNET_CAIP2,
  asset: HBAR_ASSET,
  amount: "5473255",
  payTo: "0.0.10963430",
  maxTimeoutSeconds: 120,
  extra: { invoiceId: "aw-test", feePayer: "0.0.10571514", facilitator: "blocky402", assetSymbol: "HBAR" },
};
const BASE_ACCEPT = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "3000",
  payTo: "0xA15c55f39Ec1dfd87Afb09e1959EFac2Bf44F4Ec",
};
const RATE = { centEquivalent: 162213n, hbarEquivalent: 30000n, expirationTime: 1795741200 };
// 試験用の固定の secp256k1 鍵（hardhat の既定の 0 番。本物の Hedera 口座の鍵ではない）。
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}
const ON = { OBSERVATORY_HEDERA_L1_ENABLED: "true" };

test("selectHederaAccept: 旗が OFF なら選ばない", () => {
  withEnv({ OBSERVATORY_HEDERA_L1_ENABLED: undefined }, () => {
    const s = selectHederaAccept([WALL], { declaredAmount: "5802334", declaredPayTo: "0.0.10963430", network: HEDERA_MAINNET_CAIP2 });
    assert.equal(s.accept, null);
    assert.equal(s.reason, "no_eligible_accept");
  });
});

test("selectHederaAccept: 壁の額が宣言以下の HBAR（Blocky402）を選ぶ。Base の accept は見ない", () => {
  withEnv(ON, () => {
    const s = selectHederaAccept([BASE_ACCEPT, WALL], { declaredAmount: "5802334", declaredPayTo: "0.0.10963430", network: HEDERA_MAINNET_CAIP2 });
    assert.equal(s.reason, null);
    assert.equal(s.tinybars, 5473255n);
    assert.equal(s.accept?.network, HEDERA_MAINNET_CAIP2);
  });
});

test("selectHederaAccept: 宣言より高い壁は price_mismatch（宣言より多く払わない）", () => {
  withEnv(ON, () => {
    const s = selectHederaAccept([WALL], { declaredAmount: "5000000", declaredPayTo: "0.0.10963430", network: HEDERA_MAINNET_CAIP2 });
    assert.equal(s.accept, null);
    assert.equal(s.reason, "price_mismatch");
  });
});

test("selectHederaAccept: 1 回 0.1 HBAR を超える壁は over_cap", () => {
  withEnv(ON, () => {
    const big = { ...WALL, amount: String(HEDERA_MAX_PURCHASE_TINYBARS_DEFAULT + 1n) };
    const s = selectHederaAccept([big], { declaredAmount: null, declaredPayTo: "0.0.10963430", network: HEDERA_MAINNET_CAIP2 });
    assert.equal(s.reason, "over_cap");
    const exact = { ...WALL, amount: String(HEDERA_MAX_PURCHASE_TINYBARS_DEFAULT) };
    assert.equal(selectHederaAccept([exact], { declaredAmount: null, declaredPayTo: "0.0.10963430", network: HEDERA_MAINNET_CAIP2 }).reason, null);
  });
});

test("selectHederaAccept: 受取先の不一致・USDC・知らない facilitator・別の組み方・別の網は断る", () => {
  withEnv(ON, () => {
    const opts = { declaredAmount: "5802334", declaredPayTo: "0.0.10963430", network: HEDERA_MAINNET_CAIP2 } as const;
    assert.equal(selectHederaAccept([{ ...WALL, payTo: "0.0.999" }], opts).reason, "payto_mismatch");
    const usdc = selectHederaAccept([{ ...WALL, asset: "0.0.456858" }], opts);
    assert.equal(usdc.reason, "no_eligible_accept");
    assert.equal(usdc.detail, "asset_unsupported");
    const other = selectHederaAccept([{ ...WALL, extra: { ...WALL.extra, feePayer: "0.0.10774954" } }], opts);
    assert.equal(other.detail, "facilitator_unsupported");
    const exec = selectHederaAccept([{ ...WALL, extra: { ...WALL.extra, assetTransferMethod: "transferExecutor" } }], opts);
    assert.equal(exec.detail, "unbuildable");
    assert.equal(selectHederaAccept([{ ...WALL, network: HEDERA_TESTNET_CAIP2 }], opts).reason, "no_eligible_accept");
    assert.equal(selectHederaAccept([{ ...WALL, amount: "0" }], opts).detail, "unbuildable");
    assert.equal(selectHederaAccept([{ ...WALL, maxTimeoutSeconds: 0 }], opts).detail, "unbuildable");
  });
});

test("上限は環境変数で下げられるが上げられない", () => {
  withEnv({ L1_HEDERA_MAX_PURCHASE_TINYBARS: "999999999999", L1_HEDERA_TOTAL_CAP_TINYBARS: "999999999999" }, () => {
    assert.equal(hederaMaxPurchaseTinybars(), HEDERA_MAX_PURCHASE_TINYBARS_DEFAULT);
    assert.equal(hederaTotalCapTinybars(), HEDERA_TOTAL_CAP_TINYBARS_DEFAULT);
  });
  withEnv({ L1_HEDERA_MAX_PURCHASE_TINYBARS: "1000", L1_HEDERA_TOTAL_CAP_TINYBARS: "2000" }, () => {
    assert.equal(hederaMaxPurchaseTinybars(), 1000n);
    assert.equal(hederaTotalCapTinybars(), 2000n);
  });
  assert.equal(HEDERA_MAX_PURCHASE_TINYBARS_DEFAULT, 10_000_000n); // 0.1 HBAR
  assert.equal(HEDERA_TOTAL_CAP_TINYBARS_DEFAULT, 500_000_000n); // 5 HBAR
  assert.equal(wouldExceedHederaTotalCap(499_000_000n, 1_000_000n), false);
  assert.equal(wouldExceedHederaTotalCap(499_000_000n, 1_000_001n), true);
});

test("為替の換算: 台帳は切り上げ、残高は切り捨て", () => {
  // 5,473,255 tinybar × 162213 / (30000 × 1e4) = 2959.4… → 2960（$0.002960）
  assert.equal(tinybarsToLedgerUnits(5_473_255n, RATE), 2960n);
  assert.equal(ledgerUnitsFromTinybarsFloor(5_473_255n, RATE), 2959n);
  assert.equal(tinybarsToLedgerUnits(1n, RATE), 1n);
  assert.equal(tinybarsToLedgerUnits(0n, RATE), 0n);
});

test("readHederaExchangeRate: mirror node の current_rate を読む。壊れた値は throw", async () => {
  const ok = await readHederaExchangeRate(HEDERA_MAINNET_CAIP2, async (url) => {
    assert.equal(url, "https://mainnet-public.mirrornode.hedera.com/api/v1/network/exchangerate");
    return new Response(JSON.stringify({ current_rate: { cent_equivalent: 162213, hbar_equivalent: 30000, expiration_time: 1795741200 } }));
  });
  assert.equal(ok.centEquivalent, 162213n);
  await assert.rejects(
    readHederaExchangeRate(HEDERA_MAINNET_CAIP2, async () => new Response(JSON.stringify({ current_rate: { cent_equivalent: 0, hbar_equivalent: 1 } }))),
  );
  await assert.rejects(readHederaExchangeRate(HEDERA_MAINNET_CAIP2, async () => new Response("x", { status: 503 })));
});

test("取引 ID の表記を揃える", () => {
  assert.equal(normalizeHederaTxId("0.0.10571514@1795739901.710706809"), "0.0.10571514@1795739901.710706809");
  assert.equal(normalizeHederaTxId("0.0.10571514-1795739901-710706809"), "0.0.10571514@1795739901.710706809");
  assert.equal(normalizeHederaTxId("0.0.10571514@1795739901.7"), "0.0.10571514@1795739901.000000007");
  assert.equal(mirrorHederaTxId("0.0.10571514@1795739901.710706809"), "0.0.10571514-1795739901-710706809");
  assert.equal(normalizeHederaTxId("0x" + "ab".repeat(32)), null);
  assert.equal(isWellFormedSettlementTx("0.0.10571514@1795739901.710706809", "hedera"), true);
  assert.equal(isWellFormedSettlementTx("0.0.10571514-1795739901-710706809", "hedera"), true);
  assert.equal(isWellFormedSettlementTx("ab".repeat(32), "hedera"), false);
  assert.equal(isWellFormedSettlementTx("0.0.10571514@1795739901.710706809", "evm"), false);
  assert.equal(isHederaEntityId("0.0.10963430"), true);
  assert.equal(isHederaEntityId("0.0.10963430-abcde"), false);
});

test("loadHederaPayer: 口座と鍵の形が揃わなければ null。秘密は返さない", () => {
  withEnv({ HEDERA_PAYER_ACCOUNT_ID: "0.0.123", HEDERA_PAYER_PRIVATE_KEY: TEST_KEY }, () => {
    assert.deepEqual(loadHederaPayer(), { accountId: "0.0.123" });
  });
  withEnv({ HEDERA_PAYER_ACCOUNT_ID: "0.0.123", HEDERA_PAYER_PRIVATE_KEY: "nope" }, () => assert.equal(loadHederaPayer(), null));
  withEnv({ HEDERA_PAYER_ACCOUNT_ID: undefined, HEDERA_PAYER_PRIVATE_KEY: TEST_KEY }, () => assert.equal(loadHederaPayer(), null));
});

test("hederaL1Network: 既定は mainnet。testnet は明示したときだけ", () => {
  withEnv({ HEDERA_L1_NETWORK: undefined }, () => assert.equal(hederaL1Network(), HEDERA_MAINNET_CAIP2));
  withEnv({ HEDERA_L1_NETWORK: "hedera:testnet" }, () => assert.equal(hederaL1Network(), HEDERA_TESTNET_CAIP2));
  withEnv({ HEDERA_L1_NETWORK: "hedera:previewnet" }, () => assert.equal(hederaL1Network(), HEDERA_MAINNET_CAIP2));
});

test("createHederaPaymentPayload: ローカルで部分署名し、中身（2 本の HBAR 送金）と取引 ID を確かめて返す", async () => {
  await withEnv({ HEDERA_PAYER_ACCOUNT_ID: "0.0.10968738", HEDERA_PAYER_PRIVATE_KEY: TEST_KEY }, async () => {
    const out = await createHederaPaymentPayload({ accept: WALL, network: HEDERA_MAINNET_CAIP2, tinybars: 5_473_255n });
    assert.match(out.transactionId, /^0\.0\.10571514@\d+\.\d{9}$/);
    const { inspectHederaTransaction } = await import("@x402/hedera");
    const inspected = inspectHederaTransaction(out.transaction);
    assert.equal(checkBuiltHederaTransfer(inspected, { payer: "0.0.10968738", payTo: "0.0.10963430", tinybars: 5_473_255n, feePayer: "0.0.10571514" }), null);
    assert.equal(normalizeHederaTxId(inspected.transactionId), out.transactionId);
  });
});

test("createHederaPaymentPayload: 額のずれ・知らない fee payer・鍵なしは署名しない。誤りに鍵を出さない", async () => {
  await withEnv({ HEDERA_PAYER_ACCOUNT_ID: "0.0.10968738", HEDERA_PAYER_PRIVATE_KEY: TEST_KEY }, async () => {
    await assert.rejects(createHederaPaymentPayload({ accept: WALL, network: HEDERA_MAINNET_CAIP2, tinybars: 1n }), /amount_drift/);
    await assert.rejects(
      createHederaPaymentPayload({ accept: { ...WALL, extra: { feePayer: "0.0.1" } }, network: HEDERA_MAINNET_CAIP2, tinybars: 5_473_255n }),
      /fee_payer_unsupported/,
    );
    const text = redactForLog(new Error(`boom ${TEST_KEY} ${TEST_KEY.slice(2).toUpperCase()}`));
    assert.equal(text.includes(TEST_KEY.slice(2)), false);
    assert.equal(text.includes(TEST_KEY.slice(2).toUpperCase()), false);
    assert.match(text, /<hedera-secret>/);
  });
  await withEnv({ HEDERA_PAYER_ACCOUNT_ID: "0.0.10968738", HEDERA_PAYER_PRIVATE_KEY: undefined }, async () => {
    await assert.rejects(createHederaPaymentPayload({ accept: WALL, network: HEDERA_MAINNET_CAIP2, tinybars: 5_473_255n }), /hedera_payer_key_unset/);
  });
});

test("checkBuiltHederaTransfer: 第三者の口座・トークン・別の取引 ID は落とす", () => {
  const base = {
    hasNonTransferOperations: false,
    hbarTransfers: [
      { accountId: "0.0.1", amount: "-5" },
      { accountId: "0.0.2", amount: "5" },
    ],
    tokenTransfers: {},
    transactionIdAccountId: "0.0.9",
  };
  const exp = { payer: "0.0.1", payTo: "0.0.2", tinybars: 5n, feePayer: "0.0.9" };
  assert.equal(checkBuiltHederaTransfer(base, exp), null);
  assert.equal(checkBuiltHederaTransfer({ ...base, transactionIdAccountId: "0.0.8" }, exp), "transaction_id_not_fee_payer");
  assert.equal(checkBuiltHederaTransfer({ ...base, tokenTransfers: { "0.0.456858": [] } }, exp), "token_transfers_present");
  assert.equal(
    checkBuiltHederaTransfer({ ...base, hbarTransfers: [...base.hbarTransfers, { accountId: "0.0.3", amount: "0" }] }, exp),
    "unexpected_transfer_count",
  );
  assert.equal(checkBuiltHederaTransfer({ ...base, hbarTransfers: [{ accountId: "0.0.1", amount: "-6" }, { accountId: "0.0.2", amount: "6" }] }, exp), "payer_debit_mismatch");
});

test("別枠: hedera:mainnet だけが hedera の別枠（既定 $0.05）", () => {
  assert.equal(cappedChainFor("hedera:mainnet"), "hedera");
  assert.equal(cappedChainFor("hedera:testnet"), null);
  assert.equal(CHAIN_DAILY_CAPS.hedera.networkLike, "hedera:mainnet");
  withEnv({ L1_HEDERA_DAILY_CAP_USD: undefined }, () => assert.equal(chainDailyCapUnits("hedera"), 50_000n));
  // 環境変数は下げるだけ（上げても $0.05 で頭打ち）。
  withEnv({ L1_HEDERA_DAILY_CAP_USD: "25" }, () => assert.equal(chainDailyCapUnits("hedera"), 50_000n));
  withEnv({ L1_HEDERA_DAILY_CAP_USD: "0.01" }, () => assert.equal(chainDailyCapUnits("hedera"), 10_000n));
  assert.deepEqual(BLOCKY402_FEE_PAYERS[HEDERA_MAINNET_CAIP2], ["0.0.10571514"]);
});

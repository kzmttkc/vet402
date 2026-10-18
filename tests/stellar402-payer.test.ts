// ============================================================
// Stellar-402 payer（stellar:pubnet）——旗・上限・未入金・資産・秘密。
// ネットワークには出ない（RPC / Horizon / facilitator は全部差し替え）。
// ============================================================
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { ExactStellarScheme } from "@x402/stellar";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  STELLAR_PUBNET_CAIP2,
  STELLAR_USDC_CLASSIC,
  STELLAR_USDC_DECIMALS,
  STELLAR_USDC_ISSUER,
  STELLAR_USDC_SAC,
  STELLAR_LEDGER_SCALE,
  createStellarPaymentPayload,
  isStellarL1Enabled,
  isStellarUsdcAsset,
  ledgerUnitsToStellarUnits,
  loadStellarPayer,
  redactStellarSecrets,
  selectStellarAccept,
  stellarAuthorizationWindow,
  stellarDailyCapUnits,
  stellarFundsVerdict,
  stellarUnitsToLedgerUnits,
  wouldExceedStellarDailyCap,
} from "@/lib/observatory/stellar402-payer";
import { MAX_PER_PURCHASE_UNITS } from "@/lib/observatory/x402-payer";

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

const PAYTO = Keypair.random().publicKey();
const SAC_ACCEPT = {
  scheme: "exact",
  network: STELLAR_PUBNET_CAIP2,
  asset: STELLAR_USDC_SAC,
  payTo: PAYTO,
  amount: "1000000", // $0.10 in 7-decimal units
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
const CLASSIC_ACCEPT = {
  ...SAC_ACCEPT,
  asset: STELLAR_USDC_CLASSIC,
};

test("Stellar の USDC は 7 桁。台帳の 6 桁との換算は 10 倍（$0.25 = 250000 ledger = 2500000 stellar）", () => {
  assert.equal(STELLAR_USDC_DECIMALS, 7);
  assert.equal(STELLAR_LEDGER_SCALE, 10n);
  assert.equal(stellarUnitsToLedgerUnits(2_500_000n), 250_000n);
  assert.equal(ledgerUnitsToStellarUnits(250_000n), 2_500_000n);
  assert.equal(stellarUnitsToLedgerUnits(1_000_000n), 100_000n, "$0.10");
  assert.equal(stellarUnitsToLedgerUnits(2_500_001n), 250_001n, "7 桁目は切り上げ（支出を少なく数えない）");
  assert.equal(stellarUnitsToLedgerUnits(1n), 1n, "1 stroop も 1 ledger unit として数える");
  assert.equal(stellarUnitsToLedgerUnits(0n), 0n);
});

test("旗は OBSERVATORY_STELLAR_L1_ENABLED が正確に \"true\" のときだけ。既定は OFF", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", undefined, () => assert.equal(isStellarL1Enabled(), false));
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "", () => assert.equal(isStellarL1Enabled(), false));
  for (const v of ["1", "TRUE", "True", "on", "yes", " true", "true ", "false"]) {
    withEnv("OBSERVATORY_STELLAR_L1_ENABLED", v, () => assert.equal(isStellarL1Enabled(), false, `value ${JSON.stringify(v)}`));
  }
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => assert.equal(isStellarL1Enabled(), true));
});

test("selectStellarAccept: 旗 OFF なら accept があっても選ばない（署名しない）", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", undefined, () => {
    const sel = selectStellarAccept([SAC_ACCEPT], { declaredAmount: null, declaredPayTo: null });
    assert.equal(sel.reason, "no_eligible_accept");
    assert.equal(sel.accept, null);
  });
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    const sel = selectStellarAccept([SAC_ACCEPT], { declaredAmount: null, declaredPayTo: null });
    assert.equal(sel.reason, null);
    assert.equal(sel.accept?.asset, STELLAR_USDC_SAC);
    assert.equal(sel.amountUnits, 100_000n, "台帳は 6 桁: 1000000 stroops = 100000 units = $0.10");
    assert.equal(sel.stellarUnits, 1_000_000n);
  });
});

test("対象の資産は classic USDC:GA5Z… とその SAC だけ。それ以外は払わない", () => {
  assert.equal(isStellarUsdcAsset(STELLAR_USDC_SAC), true);
  assert.equal(isStellarUsdcAsset(STELLAR_USDC_CLASSIC), true);
  assert.equal(isStellarUsdcAsset(`USDC:${STELLAR_USDC_ISSUER}`), true);
  assert.equal(isStellarUsdcAsset("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"), true);
  assert.equal(isStellarUsdcAsset("USDC"), false);
  assert.equal(isStellarUsdcAsset("XLM"), false);
  assert.equal(isStellarUsdcAsset("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"), false, "testnet USDC");
  assert.equal(isStellarUsdcAsset(`usdc:${STELLAR_USDC_ISSUER}`), false, "classic の通貨コードは大文字");
  assert.equal(isStellarUsdcAsset(`USDC:${STELLAR_USDC_ISSUER.toLowerCase()}`), false, "発行者は大小を区別する");
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    const xlm = selectStellarAccept([{ ...SAC_ACCEPT, asset: "XLM" }], { declaredAmount: null, declaredPayTo: null });
    assert.equal(xlm.reason, "no_eligible_accept");
    assert.equal(xlm.detail, "asset_unsupported");
    const testnetUsdc = selectStellarAccept(
      [{ ...SAC_ACCEPT, asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }],
      { declaredAmount: null, declaredPayTo: null },
    );
    assert.equal(testnetUsdc.reason, "no_eligible_accept");
    assert.equal(testnetUsdc.detail, "asset_unsupported");
    const classic = selectStellarAccept([CLASSIC_ACCEPT], { declaredAmount: null, declaredPayTo: null });
    assert.equal(classic.reason, null);
    assert.equal(classic.accept?.asset, STELLAR_USDC_CLASSIC);
    assert.equal(classic.signingAsset, STELLAR_USDC_SAC, "classic も @x402/stellar には SAC で渡す");
  });
});

test("network は stellar:pubnet の完全一致。testnet / スラグは選ばない", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    for (const network of ["stellar", "stellar:mainnet", "stellar:testnet", "Stellar:pubnet", "stellar:pubnet "]) {
      const sel = selectStellarAccept([{ ...SAC_ACCEPT, network }], { declaredAmount: null, declaredPayTo: null });
      assert.equal(sel.reason, "no_eligible_accept", network);
    }
    assert.equal(
      selectStellarAccept([{ ...SAC_ACCEPT, network: STELLAR_PUBNET_CAIP2 }], { declaredAmount: null, declaredPayTo: null }).accept
        ?.network,
      "stellar:pubnet",
    );
  });
});

test("1 件の上限は OBSERVATORY_L1_MAX_PURCHASE_UNITS（6 桁）を 7 桁に直して比べる。超えたら署名しない", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    // +10 stroops: 上限の 1 単位ぶん上で、かつ 10 stroops の倍数（端数は unbuildable で先に落ちる）。
    const overStellar = String(MAX_PER_PURCHASE_UNITS * 10n + 10n);
    const over = selectStellarAccept([{ ...SAC_ACCEPT, amount: overStellar }], { declaredAmount: null, declaredPayTo: null });
    assert.equal(over.reason, "over_cap");
    assert.equal(over.accept, null);
    const atCap = selectStellarAccept([{ ...SAC_ACCEPT, amount: String(MAX_PER_PURCHASE_UNITS * 10n) }], {
      declaredAmount: null,
      declaredPayTo: null,
    });
    assert.equal(atCap.reason, null);
    assert.equal(atCap.amountUnits, MAX_PER_PURCHASE_UNITS);
    const under = selectStellarAccept([SAC_ACCEPT], { declaredAmount: null, declaredPayTo: null });
    assert.equal(under.reason, null);
  });
});

test("1 日の上限 L1_STELLAR_DAILY_CAP_USD は既定 $0.5。0 は止める。超えたら署名しない", () => {
  withEnv("L1_STELLAR_DAILY_CAP_USD", undefined, () => {
    assert.equal(stellarDailyCapUnits(), 500_000n);
    assert.equal(wouldExceedStellarDailyCap(0n, 500_000n), false, "ちょうど上限は払える");
    assert.equal(wouldExceedStellarDailyCap(1n, 500_000n), true);
    assert.equal(wouldExceedStellarDailyCap(500_000n, 1n), true);
    assert.equal(wouldExceedStellarDailyCap(0n, 500_001n), true);
  });
  withEnv("L1_STELLAR_DAILY_CAP_USD", "0", () => {
    assert.equal(stellarDailyCapUnits(), 0n);
    assert.equal(wouldExceedStellarDailyCap(0n, 1n), true, "0 なら 1 件も払わない");
  });
  withEnv("L1_STELLAR_DAILY_CAP_USD", "0.25", () => assert.equal(stellarDailyCapUnits(), 250_000n));
  for (const v of ["", "abc", "-1", "NaN", "Infinity"]) {
    withEnv("L1_STELLAR_DAILY_CAP_USD", v, () => assert.equal(stellarDailyCapUnits(), 500_000n, `value ${JSON.stringify(v)}`));
  }
  withEnv("L1_STELLAR_DAILY_CAP_USD", "100", () => assert.equal(stellarDailyCapUnits(), 25_000_000n, "共有 $25 で頭打ち"));
});

test("未入金: USDC 残高も trustline も無ければ署名しない（payer_unfunded）", () => {
  const need = 1_000_000n;
  assert.equal(stellarFundsVerdict({ sacBalance: 0n, classicBalance: 0n, hasClassicTrustline: false }, need).reason, "payer_unfunded");
  assert.equal(stellarFundsVerdict({ sacBalance: 0n, classicBalance: 0n, hasClassicTrustline: true }, need).reason, "payer_unfunded");
  assert.equal(
    stellarFundsVerdict({ sacBalance: need - 1n, classicBalance: 0n, hasClassicTrustline: true }, need).reason,
    "payer_unfunded",
  );
  assert.equal(stellarFundsVerdict({ sacBalance: null, classicBalance: null, hasClassicTrustline: null }, need).reason, "unreadable");
  assert.equal(stellarFundsVerdict({ sacBalance: need, classicBalance: 0n, hasClassicTrustline: false }, need).ok, true);
  assert.equal(stellarFundsVerdict({ sacBalance: 0n, classicBalance: need, hasClassicTrustline: true }, need).ok, true);
  assert.equal(
    stellarFundsVerdict({ sacBalance: 0n, classicBalance: 0n, hasClassicTrustline: false }, need).ok,
    false,
    "trustline 無し・残高 0 は通さない",
  );
});

test("STELLAR_PAYER_SECRET（S...）はログ・誤り・記録に出さない", () => {
  const kp = Keypair.random();
  const secret = kp.secret();
  assert.match(secret, /^S[A-Z2-7]{55}$/);
  withEnv("STELLAR_PAYER_SECRET", secret, () => {
    const loaded = loadStellarPayer();
    assert.equal(loaded?.address, kp.publicKey());
    assert.equal(JSON.stringify(loaded).includes(secret), false, "戻り値に秘密を載せない");
  });
  withEnv("STELLAR_PAYER_SECRET", "not-a-secret", () => {
    const loaded = loadStellarPayer();
    assert.equal(loaded, null);
  });
  withEnv("STELLAR_PAYER_SECRET", undefined, () => assert.equal(loadStellarPayer(), null));
  const leaked = `failed to sign with ${secret} at https://rpc.example/secret`;
  const redacted = redactStellarSecrets(leaked);
  assert.equal(redacted.includes(secret), false, redacted);
  assert.match(redacted, /<stellar-secret>/);
  assert.equal(redactStellarSecrets("no secret here"), "no secret here");
});

test("loadStellarPayer: 壊れた秘密で throw した文字列にも S... を残さない", () => {
  const almost = "S" + "A".repeat(55);
  withEnv("STELLAR_PAYER_SECRET", almost, () => {
    let threw: unknown = null;
    try {
      loadStellarPayer();
    } catch (error) {
      threw = error;
    }
    assert.equal(threw, null, "読めなければ null（throw しない）");
    assert.equal(loadStellarPayer(), null);
  });
});

test("申告額は 7 桁どうしだけ。amount 1000000 と declaredAmount 100000 は一致しない", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    const sel = selectStellarAccept([{ ...SAC_ACCEPT, amount: "1000000" }], {
      declaredAmount: "100000",
      declaredPayTo: null,
    });
    assert.equal(sel.accept, null);
    assert.equal(sel.reason, "price_mismatch");
    const same = selectStellarAccept([{ ...SAC_ACCEPT, amount: "1000000" }], {
      declaredAmount: "1000000",
      declaredPayTo: null,
    });
    assert.equal(same.reason, null);
    assert.equal(same.stellarUnits, 1_000_000n);
  });
});

test("宣言した payTo と違う壁は payto_mismatch。署名する accept を返さない", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    const other = Keypair.random().publicKey();
    const sel = selectStellarAccept([SAC_ACCEPT], { declaredAmount: null, declaredPayTo: other });
    assert.equal(sel.accept, null);
    assert.equal(sel.reason, "payto_mismatch");
    const same = selectStellarAccept([SAC_ACCEPT], { declaredAmount: null, declaredPayTo: SAC_ACCEPT.payTo });
    assert.equal(same.reason, null);
  });
});

test("10 stroops の倍数でない額は no_eligible_accept / unbuildable。1234567 は買わない", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    const odd = selectStellarAccept([{ ...SAC_ACCEPT, amount: "1234567" }], { declaredAmount: null, declaredPayTo: null });
    assert.equal(odd.accept, null);
    assert.equal(odd.reason, "no_eligible_accept");
    assert.equal(odd.detail, "unbuildable");
    const even = selectStellarAccept([{ ...SAC_ACCEPT, amount: "1234560" }], { declaredAmount: null, declaredPayTo: null });
    assert.equal(even.reason, null);
    assert.equal(even.stellarUnits, 1_234_560n);
  });
});

test("maxTimeoutSeconds の 0・負・非整数は予約の前に unbuildable。窓は 60〜120 秒", () => {
  withEnv("OBSERVATORY_STELLAR_L1_ENABLED", "true", () => {
    for (const bad of [0, -1, -30, 1.5, Number.NaN]) {
      const sel = selectStellarAccept([{ ...SAC_ACCEPT, maxTimeoutSeconds: bad }], {
        declaredAmount: null,
        declaredPayTo: null,
      });
      assert.equal(sel.accept, null, `timeout ${String(bad)}`);
      assert.equal(sel.reason, "no_eligible_accept");
      assert.equal(sel.detail, "unbuildable");
    }
    const long = selectStellarAccept([{ ...SAC_ACCEPT, maxTimeoutSeconds: 300 }], {
      declaredAmount: null,
      declaredPayTo: null,
    });
    assert.equal(long.reason, null, "120 秒を超える正の整数は落とさず、署名時に頭打ちする");
    assert.equal(stellarAuthorizationWindow(300), 120);
    assert.equal(stellarAuthorizationWindow(90), 90);
    assert.equal(stellarAuthorizationWindow(30), 60);
    assert.equal(stellarAuthorizationWindow(60), 60);
    assert.equal(stellarAuthorizationWindow(undefined), 60);
    assert.equal(stellarAuthorizationWindow(0), 60);
  });
});

test("署名器に渡す有効期限は頭打ちした値。売り手の 10 億秒は 120 秒、30 秒は 60 秒で渡る", async () => {
  const seen: unknown[] = [];
  const fake = async (_v: number, req: { maxTimeoutSeconds?: unknown }) => {
    seen.push(req.maxTimeoutSeconds);
    return { x402Version: 2, payload: { transaction: "AAAA" } } as never;
  };
  // 署名器は動的 import で読む。ESM と CJS のどちらに解決されても同じ偽物が呼ばれるよう、両方の prototype を差し替える。
  const dyn = (await import("@x402/stellar")) as { ExactStellarScheme: typeof ExactStellarScheme };
  const cjs = createRequire(import.meta.url)("@x402/stellar") as { ExactStellarScheme: typeof ExactStellarScheme };
  const protos = [...new Set([ExactStellarScheme.prototype, dyn.ExactStellarScheme.prototype, cjs.ExactStellarScheme.prototype])];
  const stubs = protos.map((p) => mock.method(p, "createPaymentPayload", fake));
  const stub = { mock: { restore: () => stubs.forEach((x) => x.mock.restore()) } };
  const saved = { s: process.env.STELLAR_PAYER_SECRET, r: process.env.STELLAR_RPC_URL };
  process.env.STELLAR_PAYER_SECRET = Keypair.random().secret();
  process.env.STELLAR_RPC_URL = "https://rpc.invalid";
  try {
    for (const requested of [1_000_000_000, 30]) {
      const out = await createStellarPaymentPayload({
        accept: { ...SAC_ACCEPT, maxTimeoutSeconds: requested },
        signingAsset: STELLAR_USDC_SAC,
        stellarUnits: 1_000_000n,
      });
      assert.equal(out.transaction, "AAAA");
    }
    assert.deepEqual(seen, [120, 60]);
  } finally {
    stub.mock.restore();
    if (saved.s === undefined) delete process.env.STELLAR_PAYER_SECRET; else process.env.STELLAR_PAYER_SECRET = saved.s;
    if (saved.r === undefined) delete process.env.STELLAR_RPC_URL; else process.env.STELLAR_RPC_URL = saved.r;
  }
});

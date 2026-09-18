// ============================================================
// selectAccept の declaredPayTosByNetwork（2026-09-19・Arc の lane accept の payTo）。
//
// 本番の事実（2026-09-18T18:00Z のバッチ）: https://api.exa.ai/search は Arc のレーン枠で先頭に載ったが、
// eip155:8453 の legacy accept（payTo 0x6d6E…9192）で買われ、Arc では買われなかった。カタログの raw_accepts は
// Arc の accept を **別の payTo（0xB98e…2dbC）** で宣言している。selectAccept は先頭 accept の pay_to と
// 一致する accept しか通さなかったので、Arc の accept は payTo の関門で必ず落ちていた。
//
// 守ること:
//  1. 優先された別チェーン（Arc）の accept の payTo は、カタログがそのチェーンについて宣言した集合と照合する。
//  2. 壁が宣言に無い payTo を Arc の accept に入れてきたら落とす（Base へ）。
//  3. declaredPayTosByNetwork が無い・空なら従来どおり先頭 pay_to と照合（exa では Base）。
//  4. 優先していない accept（Base）の payTo の関門は変わらない（base-usdc-circle の 0xB98e… は通らない）。
//  5. GatewayWalletBatched の Arc accept は宣言があっても選ばれない。
//  6. 相対上限 min(3×宣言額, $1)・宣言額の異形（"0"・"0.01"・"1e4"・負）では免除なし・pay_to null では免除なし。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARC_CAIP2, ARC_CHAIN, ARC_USDC, BASE_CAIP2, BASE_CHAIN, BASE_USDC, MAX_PER_PURCHASE_UNITS, declaredPayTosFor, selectAccept } from "@/lib/observatory/x402-payer";

const LEGACY_PAYTO = "0x6d6E695b09861467c7d462f5AAF31cF3540B9192";
const CIRCLE_PAYTO = "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC";
const OTHER_PAYTO = "0x1111111111111111111111111111111111111111";
const GATEWAY_CONTRACT = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";

// exa.ai /search の実物の形（2026-09-18 のカタログ raw_accepts）。Base は circle と legacy の 2 本、Arc は eip3009 と Gateway。
const BASE_CIRCLE = { scheme: "exact", network: BASE_CAIP2, amount: "7000", asset: BASE_USDC, payTo: CIRCLE_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", acceptId: "base-usdc-circle", assetTransferMethod: "eip3009" } };
const BASE_LEGACY = { scheme: "exact", network: BASE_CAIP2, amount: "7000", asset: BASE_USDC, payTo: LEGACY_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", acceptId: "legacy" } };
const ARC = { scheme: "exact", network: ARC_CAIP2, amount: "7000", asset: ARC_USDC, payTo: CIRCLE_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2", acceptId: "arc-usdc-circle", assetTransferMethod: "eip3009" } };
const ARC_GATEWAY = { ...ARC, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_CONTRACT, acceptId: "arc-usdc-gateway" } };
const EXA = [BASE_CIRCLE, BASE_LEGACY, ARC, ARC_GATEWAY];

/** カタログの行: 先頭 pay_to は legacy（小文字で保存）・宣言額 7000・主ネットワーク Base。 */
const CATALOG = { declaredAmount: "7000", declaredPayTo: LEGACY_PAYTO.toLowerCase(), declaredNetwork: BASE_CAIP2 };
const ARC_DECLARED = { [ARC_CAIP2]: [CIRCLE_PAYTO.toLowerCase()] };
const LANE = { ...CATALOG, preferNetworks: [ARC_CAIP2], declaredPayTosByNetwork: ARC_DECLARED };

function withArc<T>(on: boolean, fn: () => T): T {
  const saved = process.env.OBSERVATORY_ARC_L1_ENABLED;
  if (on) process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
  else delete process.env.OBSERVATORY_ARC_L1_ENABLED;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.OBSERVATORY_ARC_L1_ENABLED;
    else process.env.OBSERVATORY_ARC_L1_ENABLED = saved;
  }
}

test("exa の実物: Arc 優先＋Arc の宣言 payTo → Arc の eip3009 accept が選ばれ、payTo は 0xB98e…", () => {
  withArc(true, () => {
    const chosen = selectAccept(EXA, LANE);
    assert.ok(chosen.accept, `reason=${chosen.reason}`);
    assert.equal(chosen.accept!.network, ARC_CAIP2);
    assert.equal(chosen.accept!.asset, ARC_USDC);
    assert.equal(chosen.accept!.payTo, CIRCLE_PAYTO);
    assert.equal(chosen.accept!.extra?.acceptId, "arc-usdc-circle", "Gateway ではなく eip3009");
    // 宣言の大小は問わない（EVM）。
    const mixed = selectAccept(EXA, { ...LANE, declaredPayTosByNetwork: { [ARC_CAIP2]: [CIRCLE_PAYTO] } });
    assert.equal(mixed.accept?.network, ARC_CAIP2);
  });
});

test("declaredPayTosByNetwork 無し・空・別チェーンの宣言だけ: 従来どおり Base の legacy で買われる（本番の 09-18 の挙動）", () => {
  withArc(true, () => {
    const variants: (Record<string, readonly string[]> | undefined)[] = [undefined, {}, { [ARC_CAIP2]: [] }, { "eip155:137": [CIRCLE_PAYTO] }];
    for (const declared of variants) {
      const chosen = selectAccept(EXA, { ...CATALOG, preferNetworks: [ARC_CAIP2], declaredPayTosByNetwork: declared });
      assert.equal(chosen.accept?.network, BASE_CAIP2, JSON.stringify(declared));
      assert.equal(chosen.accept?.payTo, LEGACY_PAYTO);
    }
  });
});

test("壁がカタログに無い payTo を Arc の accept に入れてきたら落ちて Base へ", () => {
  withArc(true, () => {
    const chosen = selectAccept([BASE_CIRCLE, BASE_LEGACY, { ...ARC, payTo: OTHER_PAYTO }, ARC_GATEWAY], LANE);
    assert.equal(chosen.accept?.network, BASE_CAIP2);
    assert.equal(chosen.accept?.payTo, LEGACY_PAYTO);
    // Arc しか無い壁なら payto_mismatch（どこにも払わない）。
    const arcOnly = selectAccept([{ ...ARC, payTo: OTHER_PAYTO }], LANE);
    assert.equal(arcOnly.accept, null);
    assert.equal(arcOnly.reason, "payto_mismatch");
    // 先頭 pay_to（legacy）を Arc の accept に入れてきても、Arc の宣言に無ければ落ちる。
    const legacyOnArc = selectAccept([BASE_LEGACY, { ...ARC, payTo: LEGACY_PAYTO }], LANE);
    assert.equal(legacyOnArc.accept?.network, BASE_CAIP2);
  });
});

test("優先していない accept の payTo の関門は変わらない: Arc の宣言は Base の accept を通さない", () => {
  withArc(true, () => {
    // Arc を優先しない（主候補）: 宣言があっても使われない → Base legacy。
    const noPref = selectAccept(EXA, { ...CATALOG, declaredPayTosByNetwork: ARC_DECLARED });
    assert.equal(noPref.accept?.network, BASE_CAIP2);
    assert.equal(noPref.accept?.payTo, LEGACY_PAYTO);
    // Base の circle accept（0xB98e…）は、Base について宣言を渡しても通らない（Base は優先でも別チェーンでもない）。
    const baseDeclared = selectAccept([BASE_CIRCLE], { ...CATALOG, preferNetworks: [ARC_CAIP2, BASE_CAIP2], declaredPayTosByNetwork: { ...ARC_DECLARED, [BASE_CAIP2]: [CIRCLE_PAYTO] } });
    assert.equal(baseDeclared.accept, null);
    assert.equal(baseDeclared.reason, "payto_mismatch");
    // 旗 OFF なら Arc は eligible ですらない。
    withArc(false, () => assert.equal(selectAccept(EXA, LANE).accept?.network, BASE_CAIP2));
  });
});

test("GatewayWalletBatched の Arc accept は宣言があっても選ばれない", () => {
  withArc(true, () => {
    const chosen = selectAccept([BASE_CIRCLE, BASE_LEGACY, ARC_GATEWAY], LANE);
    assert.equal(chosen.accept?.network, BASE_CAIP2);
    const gatewayOnly = selectAccept([ARC_GATEWAY], LANE);
    assert.equal(gatewayOnly.accept, null);
    assert.equal(gatewayOnly.reason, "no_eligible_accept");
  });
});

test("相対上限: 宣言の Arc payTo でも min(3×宣言額, $1) を超える Arc は飛ばして Base", () => {
  withArc(true, () => {
    assert.equal(selectAccept([BASE_LEGACY, { ...ARC, amount: "21000" }], LANE).accept?.network, ARC_CAIP2, "3 倍ちょうどは可");
    assert.equal(selectAccept([BASE_LEGACY, { ...ARC, amount: "21001" }], LANE).accept?.network, BASE_CAIP2, "3 倍超は Base");
    const big = { ...LANE, declaredAmount: "500000" };
    const baseBig = { ...BASE_LEGACY, amount: "500000" };
    assert.equal(selectAccept([baseBig, { ...ARC, amount: String(MAX_PER_PURCHASE_UNITS) }], big).accept?.network, ARC_CAIP2);
    assert.equal(selectAccept([baseBig, { ...ARC, amount: String(MAX_PER_PURCHASE_UNITS + 1n) }], big).accept?.network, BASE_CAIP2);
    // 宣言 network（Base）の accept が壁に無ければ免除しない: Arc 7001 ≠ 宣言 7000 → price_mismatch。
    const arcOnly = selectAccept([{ ...ARC, amount: "7001" }], LANE);
    assert.equal(arcOnly.accept, null);
    assert.equal(arcOnly.reason, "price_mismatch");
  });
});

test("宣言額の異形（\"0\"・\"0.01\"・\"1e4\"・負）では免除なし: 宣言の Arc payTo でも Arc の $1 は通らない", () => {
  withArc(true, () => {
    for (const declared of ["0", "0.01", "1e4", "-7000"]) {
      const chosen = selectAccept(
        [{ ...BASE_LEGACY, amount: declared }, { ...ARC, amount: "1000000" }],
        { ...LANE, declaredAmount: declared },
      );
      // W2 以降、読めない宣言額では Arc の accept は payTo の関門で先に落ちる。理由の語は Base 側の形で決まる
      // （"0"・負は amount <= 0 で no_eligible_accept、"0.01"・"1e4" は BigInt で読めず同じ）。払わないことだけを固定する。
      assert.equal(chosen.accept, null, `declared ${JSON.stringify(declared)} must not pay`);
    }
  });
});

test("W3: 先頭 pay_to が null の行では免除を開かない——Arc の宣言があっても宣言額との一致を要求する", () => {
  withArc(true, () => {
    const nullHead = { ...LANE, declaredPayTo: null };
    // 額が一致すれば Arc（payTo は Arc の宣言と照合される）。
    assert.equal(selectAccept(EXA, nullHead).accept?.network, ARC_CAIP2);
    // 額が違えば（3 倍以内でも）Arc は飛ばす。
    const pricier = selectAccept([BASE_LEGACY, { ...ARC, amount: "8000" }], nullHead);
    assert.equal(pricier.accept?.network, BASE_CAIP2);
    // pay_to が null でも、Arc の宣言に無い payTo の Arc accept は通らない。
    const wrong = selectAccept([{ ...ARC, payTo: OTHER_PAYTO }], nullHead);
    assert.equal(wrong.accept, null);
    assert.equal(wrong.reason, "payto_mismatch");
  });
});

// ---- 2026-09-19 レビュー W1: 宣言集合の述語は署名の関門と同じ 1 本（declaredPayTosFor）。 ----
test("declaredPayTosFor: 署名の関門を通る accept の payTo だけが宣言になる（レビューの 6 形）", () => {
  // 正規: exa の実物 → Arc は 0xB98e… だけ（Gateway は同じ payTo でも数えない・Base の accept は Arc の宣言にならない）。
  assert.deepEqual(declaredPayTosFor(ARC_CHAIN, EXA), [CIRCLE_PAYTO.toLowerCase()]);
  assert.deepEqual(declaredPayTosFor(ARC_CHAIN, [BASE_CIRCLE, BASE_LEGACY, ARC_GATEWAY]), [], "Gateway だけなら宣言なし");
  assert.deepEqual(declaredPayTosFor(BASE_CHAIN, EXA).sort(), [LEGACY_PAYTO.toLowerCase(), CIRCLE_PAYTO.toLowerCase()].sort());
  const refused: [string, unknown][] = [
    ["Gateway 別アドレス", { ...ARC_GATEWAY, payTo: GATEWAY_CONTRACT }],
    ["scheme 非 exact", { ...ARC, scheme: "upto", payTo: OTHER_PAYTO }],
    ["scheme 無し", { network: ARC.network, amount: ARC.amount, asset: ARC.asset, payTo: OTHER_PAYTO, extra: ARC.extra }],
    ["amount 無し", { scheme: "exact", network: ARC.network, asset: ARC.asset, payTo: OTHER_PAYTO, extra: ARC.extra }],
    ["salt 付き", { ...ARC, payTo: OTHER_PAYTO, extra: { ...ARC.extra, salt: "0x01" } }],
    ["not-an-address", { ...ARC, payTo: "not-an-address" }],
    ["チェックサム不一致の大小混在", { ...ARC, payTo: "0xB98eF29eb2be19Ae646A8FC0248255B90A332DBC" }],
    ["別の asset", { ...ARC, asset: BASE_USDC, payTo: OTHER_PAYTO }],
    ["assetTransferMethod が eip3009 以外", { ...ARC, payTo: OTHER_PAYTO, extra: { ...ARC.extra, assetTransferMethod: "permit2" } }],
  ];
  for (const [label, accept] of refused) {
    assert.deepEqual(declaredPayTosFor(ARC_CHAIN, [accept]), [], label);
    // 正規の accept と並んでも、正規の payTo だけ。
    assert.deepEqual(declaredPayTosFor(ARC_CHAIN, [ARC, accept]), [CIRCLE_PAYTO.toLowerCase()], label);
  }
  // DB の返し方: 配列・JSON 文字列・null・壊れた値。
  assert.deepEqual(declaredPayTosFor(ARC_CHAIN, JSON.stringify(EXA)), [CIRCLE_PAYTO.toLowerCase()]);
  for (const junk of [null, undefined, "", "{not json", "{a,b}", 7, {}, [null, 1, "x"]]) assert.deepEqual(declaredPayTosFor(ARC_CHAIN, junk), []);
  // 旗に依らない（宣言はカタログの事実。署名の可否は selectAccept が旗で決める）。
  withArc(false, () => assert.deepEqual(declaredPayTosFor(ARC_CHAIN, EXA), [CIRCLE_PAYTO.toLowerCase()]));
});

test("W1 の失敗シナリオ: カタログの Gateway accept が別アドレスを名乗り、壁が eip3009 の accept にそのアドレスを載せても払わない", () => {
  withArc(true, () => {
    const catalog = [BASE_LEGACY, ARC, { ...ARC_GATEWAY, payTo: GATEWAY_CONTRACT }];
    const declared = { [ARC_CAIP2]: declaredPayTosFor(ARC_CHAIN, catalog) };
    assert.deepEqual(declared[ARC_CAIP2], [CIRCLE_PAYTO.toLowerCase()]);
    const wallAccepts = [BASE_LEGACY, { ...ARC, payTo: GATEWAY_CONTRACT }, { ...ARC_GATEWAY, payTo: GATEWAY_CONTRACT }];
    const chosen = selectAccept(wallAccepts, { ...CATALOG, preferNetworks: [ARC_CAIP2], declaredPayTosByNetwork: declared });
    assert.equal(chosen.accept?.network, BASE_CAIP2);
    assert.equal(chosen.accept?.payTo, LEGACY_PAYTO);
    // 正直な壁なら Arc。
    const honest = selectAccept(catalog, { ...CATALOG, preferNetworks: [ARC_CAIP2], declaredPayTosByNetwork: declared });
    assert.equal(honest.accept?.network, ARC_CAIP2);
    assert.equal(honest.accept?.payTo, CIRCLE_PAYTO);
  });
});

// ---- 2026-09-19 レビュー W2: 宣言額が正の整数として読めない行では payTo の照合先を広げない。 ----
test("W2: declaredAmount が null・異形の行では Arc の宣言 payTo を使わない（Arc の $1 は通らず、従来どおり Base）", () => {
  withArc(true, () => {
    for (const declared of [null, "0", "0.01", "1e4", "-7000"]) {
      const label = `declared ${JSON.stringify(declared)}`;
      // 壁の Base legacy はカタログと同じ文字列（null の行は 7000）。Arc は $1。
      const base = { ...BASE_LEGACY, amount: declared ?? "7000" };
      const chosen = selectAccept([base, { ...ARC, amount: "1000000" }], { ...LANE, declaredAmount: declared });
      assert.notEqual(chosen.accept?.network, ARC_CAIP2, label);
      if (declared === null) {
        assert.equal(chosen.accept?.network, BASE_CAIP2, "宣言額の無い行は main と同じく Base の legacy");
        assert.equal(chosen.accept?.payTo, LEGACY_PAYTO);
      } else {
        assert.equal(chosen.accept, null, label);
      }
      // Arc しか無い壁: 宣言 payTo を使わないので、先頭 pay_to と違う Arc の accept は payto_mismatch。
      const arcOnly = selectAccept([{ ...ARC, amount: "7000" }], { ...LANE, declaredAmount: declared });
      assert.equal(arcOnly.accept, null, label);
      assert.equal(arcOnly.reason, "payto_mismatch", label);
    }
  });
});

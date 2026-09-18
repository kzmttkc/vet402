// ============================================================
// selectAccept の preferNetworks（2026-09-17・レーンの accept 優先）。
//
// 本番の事実: Arc を主ネットワーク（e.network）にする稼働中エンドポイントは 0 件。
// api.exa.ai の 2 件は e.network = eip155:8453 で、Arc の accept は raw_accepts の 2 番目以降。
// selectAccept は eligible を並び順で選ぶので Base が勝ち、Arc レーンは旗を ON にしても
// 1 件も買えなかった。
//
// 守ること:
//  1. preferNetworks に含まれる network の eligible accept を先に選ぶ。それ以外は従来の並び。
//  2. カタログの宣言額（declaredAmount）との一致は「その accept の network がカタログの
//     e.network（declaredNetwork）と同じときだけ」要求する。カタログの価格は先頭 accept
//     （= e.network の accept）のものなので、別チェーンの accept の額と比べても意味が無く、
//     比べると Arc の accept が必ず price_mismatch になる。別チェーンの accept は
//     MAX_PER_PURCHASE_UNITS の上限だけ見る。
//  3. declaredNetwork を渡さない従来の呼び手は従来どおり（全 accept に宣言額を要求）。
//  4. 上限・payTo・ドメインの関門は preferNetworks で緩まない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARC_CAIP2, ARC_USDC, BASE_CAIP2, BASE_USDC, MAX_PER_PURCHASE_UNITS, selectAccept } from "@/lib/observatory/x402-payer";

const PAYTO = "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC";
const BASE = { scheme: "exact", network: BASE_CAIP2, amount: "3000", asset: BASE_USDC, payTo: PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
const ARC = { scheme: "exact", network: ARC_CAIP2, amount: "4000", asset: ARC_USDC, payTo: PAYTO, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", acceptId: "arc-usdc-circle" } };
const GATEWAY = { ...ARC, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" } };

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

// exa の形: Base が先頭、Arc（eip3009・Gateway）が後ろ。カタログは先頭の Base を宣言している。
const EXA = [BASE, ARC, GATEWAY];
const CATALOG = { declaredAmount: "3000", declaredPayTo: PAYTO.toLowerCase(), declaredNetwork: BASE_CAIP2 };

test("preferNetworks なし: 従来どおり並び順で Base が選ばれる（宣言額 3000 と一致）", () => {
  withArc(true, () => {
    const chosen = selectAccept(EXA, CATALOG);
    assert.equal(chosen.accept?.network, BASE_CAIP2);
  });
});

test("preferNetworks に Arc: Arc の eip3009 accept が先に選ばれ、宣言額（Base の 3000）とは比べない", () => {
  withArc(true, () => {
    const chosen = selectAccept(EXA, { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.ok(chosen.accept, `reason=${chosen.reason}`);
    assert.equal(chosen.accept!.network, ARC_CAIP2);
    assert.equal(chosen.accept!.amount, "4000", "別チェーンの額はカタログの宣言と違ってよい");
    assert.equal(chosen.accept!.extra?.acceptId, "arc-usdc-circle", "Gateway ではなく eip3009");
  });
});

test("preferNetworks に Arc でも旗が off なら Arc は eligible にならず Base のまま", () => {
  withArc(false, () => {
    const chosen = selectAccept(EXA, { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.equal(chosen.accept?.network, BASE_CAIP2);
  });
});

test("宣言額の免除は「宣言 network の accept が壁にある」かつ「preferNetworks の別チェーン accept」にだけ効く（レビュー C1）", () => {
  withArc(true, () => {
    // 優先されていない Arc は宣言額（3000）と比べられる → 4000 は不一致。Base 9999 も不一致 → price_mismatch。
    const noPref = selectAccept([{ ...BASE, amount: "9999" }, ARC], CATALOG);
    assert.equal(noPref.accept, null, "優先していない別チェーンの accept は免除されない");
    assert.equal(noPref.reason, "price_mismatch");
    // 宣言 network（Base）の accept が壁に無ければ、どの accept も免除されない（旧挙動）。
    const arcOnly = selectAccept([ARC], { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.equal(arcOnly.accept, null, "宣言 network の accept が無い壁では免除しない");
    assert.equal(arcOnly.reason, "price_mismatch");
    // Base だけで額が違えば従来どおり price_mismatch。
    const baseOnly = selectAccept([{ ...BASE, amount: "9999" }], CATALOG);
    assert.equal(baseOnly.accept, null);
    assert.equal(baseOnly.reason, "price_mismatch");
    // 揃っていれば免除される: Base が宣言どおり・Arc を優先 → Arc（4000・宣言の 3 倍以内）。
    const ok = selectAccept([BASE, ARC], { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.equal(ok.accept?.network, ARC_CAIP2);
  });
});

// ---- レビュー C1（Critical・逐語）: declaredNetwork がどの eligible にも一致しない生値のとき、
// 宣言額の比較が消えてはいけない（Base で壁の言い値 $1 を署名していた）。 ----
test("A: declaredNetwork='solana'（カタログの生値）・宣言 7000・壁 1000000 → price_mismatch", () => {
  withArc(true, () => {
    const chosen = selectAccept([{ ...BASE, amount: "1000000" }], { declaredAmount: "7000", declaredPayTo: null, declaredNetwork: "solana", preferNetworks: [ARC_CAIP2] });
    assert.equal(chosen.accept, null);
    assert.equal(chosen.reason, "price_mismatch");
  });
});

test("A2: declaredNetwork='base-mainnet'（本番 12 行の生値）・宣言 7000・壁 1000000 → price_mismatch", () => {
  withArc(true, () => {
    const chosen = selectAccept([{ ...BASE, amount: "1000000" }], { declaredAmount: "7000", declaredPayTo: null, declaredNetwork: "base-mainnet", preferNetworks: [ARC_CAIP2] });
    assert.equal(chosen.accept, null);
    assert.equal(chosen.reason, "price_mismatch");
    // 同じ生値の揺れでも、宣言どおりの額なら買える（旧挙動）。
    for (const raw of ["Base", "solana", "arc", "base-mainnet", "eip155:8453", "base"]) {
      const ok = selectAccept([{ ...BASE, amount: "7000" }], { declaredAmount: "7000", declaredPayTo: null, declaredNetwork: raw, preferNetworks: [ARC_CAIP2] });
      assert.ok(ok.accept, `declaredNetwork=${raw}`);
    }
  });
});

// ---- レビュー C3: 免除された別チェーンの accept にも宣言額との相対上限（3 倍・かつ $1 以下）。 ----
test("優先された Arc の accept は宣言額の 3 倍まで。超えれば飛ばして Base、Base も無ければ price_mismatch", () => {
  withArc(true, () => {
    const pref = { ...CATALOG, preferNetworks: [ARC_CAIP2] };
    assert.equal(selectAccept([BASE, { ...ARC, amount: "9000" }], pref).accept?.network, ARC_CAIP2, "3 倍ちょうどは可");
    assert.equal(selectAccept([BASE, { ...ARC, amount: "9001" }], pref).accept?.network, BASE_CAIP2, "3 倍超は Arc を飛ばして Base");
    const noBaseOk = selectAccept([{ ...BASE, amount: "9999" }, { ...ARC, amount: "9001" }], pref);
    assert.equal(noBaseOk.accept, null);
    assert.equal(noBaseOk.reason, "price_mismatch");
    // 宣言額が大きくても $1（MAX_PER_PURCHASE_UNITS）は越えない。
    // 2026-09-19: pay_to が null の行では免除を開かない（W3）ので、相対上限の確認は pay_to が宣言された行で行う。
    const bigDeclared = { declaredAmount: "500000", declaredPayTo: PAYTO.toLowerCase(), declaredNetwork: BASE_CAIP2, preferNetworks: [ARC_CAIP2] };
    assert.equal(selectAccept([{ ...BASE, amount: "500000" }, { ...ARC, amount: String(MAX_PER_PURCHASE_UNITS) }], bigDeclared).accept?.network, ARC_CAIP2);
    assert.equal(selectAccept([{ ...BASE, amount: "500000" }, { ...ARC, amount: String(MAX_PER_PURCHASE_UNITS + 1n) }], bigDeclared).accept?.network, BASE_CAIP2);
    // 宣言額が無ければ $1 だけ。
    const noDeclared = { declaredAmount: null, declaredPayTo: null, declaredNetwork: BASE_CAIP2, preferNetworks: [ARC_CAIP2] };
    assert.equal(selectAccept([BASE, { ...ARC, amount: String(MAX_PER_PURCHASE_UNITS) }], noDeclared).accept?.network, ARC_CAIP2);
  });
});

test("別チェーンの accept にも MAX_PER_PURCHASE_UNITS は効く（優先されても上限超は飛ばして Base へ）", () => {
  withArc(true, () => {
    const big = { ...ARC, amount: String(MAX_PER_PURCHASE_UNITS + 1n) };
    const chosen = selectAccept([BASE, big], { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.equal(chosen.accept?.network, BASE_CAIP2, "上限超の Arc を飛ばして Base");
    const arcOnly = selectAccept([big], { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.equal(arcOnly.accept, null);
    assert.equal(arcOnly.reason, "over_cap");
  });
});

test("declaredNetwork を渡さない従来の呼び手: 全 accept に宣言額を要求する（既存の意味を変えない）", () => {
  withArc(true, () => {
    const chosen = selectAccept([ARC], { declaredAmount: "3000", declaredPayTo: null });
    assert.equal(chosen.accept, null);
    assert.equal(chosen.reason, "price_mismatch");
    const legacySlug = selectAccept([BASE], { declaredAmount: "3000", declaredPayTo: null, declaredNetwork: "base" });
    assert.ok(legacySlug.accept, "v1 スラグ 'base' は eip155:8453 として比べる");
  });
});

test("preferNetworks は payTo とドメインの関門を緩めない", () => {
  withArc(true, () => {
    const wrongPayee = selectAccept([BASE, { ...ARC, payTo: "0x1111111111111111111111111111111111111111" }], { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.equal(wrongPayee.accept?.network, BASE_CAIP2, "宛先が違う Arc は選ばれず Base");
    const gatewayOnly = selectAccept([BASE, GATEWAY], { ...CATALOG, preferNetworks: [ARC_CAIP2] });
    assert.equal(gatewayOnly.accept?.network, BASE_CAIP2, "Gateway しか無ければ Base");
    const unknownPref = selectAccept(EXA, { ...CATALOG, preferNetworks: ["eip155:137", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] });
    assert.equal(unknownPref.accept?.network, BASE_CAIP2, "優先先に eligible が無ければ従来の並び");
  });
});


test("N1: 宣言額が正の整数として読めない（\"0\" / \"0.01\" / \"1e4\" / \"-7000\"）なら免除しない → price_mismatch", () => {
  withArc(true, () => {
    for (const declared of ["0", "0.01", "1e4", "-7000"]) {
      // L0 を通る形: 壁の Base accept はカタログと同じ文字列、そこへ Arc の $1 を並べる
      const chosen = selectAccept(
        [{ ...BASE, amount: declared }, { ...ARC, amount: "1000000" }],
        { declaredAmount: declared, declaredPayTo: null, declaredNetwork: BASE_CAIP2, preferNetworks: [ARC_CAIP2] },
      );
      assert.equal(chosen.accept, null, `declared ${JSON.stringify(declared)} must not pay`);
      assert.equal(chosen.reason, "price_mismatch", `declared ${JSON.stringify(declared)}`);
    }
  });
});

// ---- 2026-09-19（XRPL の W3 と同じ扱い）: カタログの pay_to が null の行では宣言額の免除を開かない。 ----
test("W3: declaredPayTo が null なら、優先された Arc の accept にも宣言額との一致を要求する", () => {
  withArc(true, () => {
    const nullPayTo = { declaredAmount: "3000", declaredPayTo: null, declaredNetwork: BASE_CAIP2, preferNetworks: [ARC_CAIP2] };
    // Arc 4000 ≠ 宣言 3000 → Arc は飛ばされ Base（3000）。
    assert.equal(selectAccept([BASE, ARC], nullPayTo).accept?.network, BASE_CAIP2);
    // Arc も宣言額と同じなら優先どおり Arc。
    assert.equal(selectAccept([BASE, { ...ARC, amount: "3000" }], nullPayTo).accept?.network, ARC_CAIP2);
    // Base も不一致なら price_mismatch（Arc の $1 は通らない）。
    const none = selectAccept([{ ...BASE, amount: "9999" }, { ...ARC, amount: "1000000" }], nullPayTo);
    assert.equal(none.accept, null);
    assert.equal(none.reason, "price_mismatch");
  });
});

// ============================================================
// vet402 — settled の証拠強度は 1 段ではない（2026-09-05 監査 S-4 / S-17）。
//
// 本番実測 2026-09-05: status='settled' かつ settlement_verified=true は 1,629 行。
// うち 1,558 行 (95.6%) は auth_nonce が無い——2026-09-04 12:00 UTC より前に
// 確定した行で、照合が言えたのは「payer から payTo へ期待額の USDC が動いた
// tx が実在する」までだった。同じ payTo・同じ価格の endpoint は本番で 253 群・
// 1,477 試行あり、売り手は過去の自分宛 tx を返すだけでその判定を通せた。
// 残り 71 行は我々しか作れない nonce の AuthorizationUsed(authorizer, nonce)
// まで束縛している。
//
// 直し方は「旧行を降格する」ではない（持っていない証拠で無実の売り手を
// refuted にしない・2026-09-04 の決定）。強度を 2 層に分けて公開する。
// この suite は層の定義そのもの（純関数）と、SQL 述語が同じ規則であることを固定する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SETTLED_TIERS,
  NONCE_BINDING_SINCE,
  SETTLEMENT_WINDOW_BEFORE_SEC,
  SETTLEMENT_WINDOW_AFTER_SEC,
  settledTier,
  settledTierPredicate,
  settlementTimeWindow,
  settlementTimeWindowPredicate,
} from "@/lib/observatory/settled-tier";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ---------- 層の分類 ----------

test("settled で nonce があり照合済みなら nonce_bound", () => {
  assert.equal(
    settledTier({ status: "settled", settlementVerified: true, authNonce: `0x${"ab".repeat(32)}` }),
    "nonce_bound",
  );
});

test("settled だが nonce が無い行は amount_payee_only（降格しない・消さない）", () => {
  assert.equal(
    settledTier({ status: "settled", settlementVerified: true, authNonce: null }),
    "amount_payee_only",
  );
});

test("nonce が空文字なら束縛の証拠にならない", () => {
  assert.equal(
    settledTier({ status: "settled", settlementVerified: true, authNonce: "" }),
    "amount_payee_only",
  );
  assert.equal(
    settledTier({ status: "settled", settlementVerified: true, authNonce: "   " }),
    "amount_payee_only",
  );
});

test("stellar:pubnet は auth_nonce があっても amount_payee_only（A-10）", () => {
  const row = {
    status: "settled",
    settlementVerified: true,
    // image-ocr 2026-10-18T21:30:44.700Z は stellar:pubnet で nonce を持ったまま settled だった。
    authNonce: "cf9599017134ce255dba5919734484983fbbbddec34fcdb38d0ec361463b3814",
    network: "stellar:pubnet",
  };
  assert.equal(settledTier(row), "amount_payee_only");
  assert.equal(
    settledTier({ ...row, network: "  Stellar:Pubnet " }),
    "amount_payee_only",
    "前後の空白と大文字は同じネットワーク",
  );
  assert.equal(
    settledTier({ ...row, network: "eip155:56" }),
    "nonce_bound",
    "BNB Chain は EIP-3009 の nonce を照合するので nonce_bound のまま",
  );
  assert.equal(
    settledTier({ ...row, network: "eip155:8453" }),
    "nonce_bound",
  );
  assert.equal(
    settledTier({ ...row, network: "eip155:42220" }),
    "nonce_bound",
  );
  assert.equal(
    settledTier({ status: "settled", settlementVerified: true, authNonce: row.authNonce }),
    "nonce_bound",
    "network が無い行は今日の規則のまま",
  );
});

test("nonce があっても照合が未了/否定なら nonce_bound を名乗らない", () => {
  const nonce = `0x${"cd".repeat(32)}`;
  assert.equal(
    settledTier({ status: "settled", settlementVerified: null, authNonce: nonce }),
    "amount_payee_only",
  );
  assert.equal(
    settledTier({ status: "settled", settlementVerified: false, authNonce: nonce }),
    "amount_payee_only",
  );
});

test("settled 以外の行に層は無い（null であって 0 ではない）", () => {
  for (const status of ["settle_claimed", "settle_claim_refuted", "settle_failed", "in_flight"]) {
    assert.equal(settledTier({ status, settlementVerified: true, authNonce: "0xaa" }), null, status);
  }
});

test("層は 2 つで、settled のどの行もどちらか一方に必ず入る", () => {
  assert.deepEqual([...SETTLED_TIERS], ["nonce_bound", "amount_payee_only"]);
  const rows = [
    { status: "settled", settlementVerified: true, authNonce: "0xaa" },
    { status: "settled", settlementVerified: true, authNonce: null },
    { status: "settled", settlementVerified: null, authNonce: null },
    { status: "settled", settlementVerified: false, authNonce: "" },
  ];
  const tiers = rows.map(settledTier);
  assert.equal(tiers.filter((t) => t !== null).length, rows.length, "settled 行に未分類は無い");
  assert.equal(tiers.filter((t) => t === "nonce_bound").length, 1);
  assert.equal(tiers.filter((t) => t === "amount_payee_only").length, 3);
});

// ---------- 時刻窓（層とは別の真偽値） ----------

test("時刻窓は attempted の -5 分〜+15 分（境界は窓の内側）", () => {
  const attempted = new Date("2026-09-05T00:10:00Z");
  const at = (sec: number) => new Date(attempted.getTime() + sec * 1000);
  assert.equal(SETTLEMENT_WINDOW_BEFORE_SEC, 300);
  assert.equal(SETTLEMENT_WINDOW_AFTER_SEC, 900);
  assert.equal(settlementTimeWindow(attempted, at(0)), "ok");
  assert.equal(settlementTimeWindow(attempted, at(-300)), "ok", "下端は窓内");
  assert.equal(settlementTimeWindow(attempted, at(900)), "ok", "上端は窓内");
  assert.equal(settlementTimeWindow(attempted, at(-301)), "outside");
  assert.equal(settlementTimeWindow(attempted, at(901)), "outside");
  // 本番実測 2026-09-05: 1,589 行が -1〜+62 秒に収まっていた。
  assert.equal(settlementTimeWindow(attempted, at(-1.18)), "ok");
  assert.equal(settlementTimeWindow(attempted, at(61.76)), "ok");
});

test("block_timestamp が無い行は unknown——測っていないものを ok とも outside とも言わない", () => {
  const attempted = new Date("2026-09-05T00:10:00Z");
  assert.equal(settlementTimeWindow(attempted, null), "unknown");
  assert.equal(settlementTimeWindow(null, new Date()), "unknown");
  assert.equal(settlementTimeWindow(attempted, new Date("nope")), "unknown");
});

// ---------- SQL 述語が同じ規則であること ----------

test("SQL 述語は alias を素の識別子に限る（deliveredPredicate と同じ作法）", () => {
  assert.match(settledTierPredicate("nonce_bound", "p"), /^p\.status = 'settled'/);
  assert.throws(() => settledTierPredicate("nonce_bound", "p; DROP TABLE"), /alias/);
  assert.throws(() => settlementTimeWindowPredicate("p", "o; --"), /alias/);
});

test("2 つの述語は排他で、和が settled になる形をしている", () => {
  const bound = settledTierPredicate("nonce_bound", "p");
  const only = settledTierPredicate("amount_payee_only", "p");
  assert.match(bound, /p\.auth_nonce IS NOT NULL/);
  assert.match(bound, /p\.settlement_verified IS TRUE/);
  // amount_payee_only は「settled かつ nonce_bound でない」——独立に条件を書くと
  // 定義が 2 箇所に分かれ、片方だけ直る事故になる。
  assert.ok(only.includes("NOT ("), `amount_payee_only は否定形で書く: ${only}`);
  assert.ok(bound.includes("stellar:pubnet"), bound);
  assert.ok(bound.includes("IS DISTINCT FROM"), bound);
  assert.ok(!bound.includes("<> 'stellar:pubnet'"), bound);
});

test("時刻窓の述語は秒数の定数を本文に持つ（コードと文書がずれない）", () => {
  const p = settlementTimeWindowPredicate("p", "o");
  assert.match(p, /o\.block_timestamp IS NOT NULL/);
  assert.ok(p.includes(`${SETTLEMENT_WINDOW_BEFORE_SEC} seconds`), p);
  assert.ok(p.includes(`${SETTLEMENT_WINDOW_AFTER_SEC} seconds`), p);
});

test("nonce 束縛の開始時刻は 2026-09-04 12:00 UTC（公開面が引用する定数）", () => {
  assert.equal(NONCE_BINDING_SINCE, "2026-09-04T12:00:00Z");
});

// ---------- 公開面に 2 層が書かれていること（docs-surface-parity の作法） ----------

test("方法論ページが nonce 束縛と 2 層公開を述べている", () => {
  const src = read("src/app/observatory/methodology/page.tsx");
  assert.ok(src.includes("nonce-bound"), "方法論に nonce-bound の語が無い");
  assert.ok(src.includes("amount + payee"), "方法論に amount + payee の語が無い");
  assert.ok(src.includes("2026-09-04"), "nonce 束縛の導入日が無い");
  assert.ok(
    src.includes("settledNonceBound") && src.includes("settledAmountPayeeOnly"),
    "方法論が state API の該当フィールド名を示していない",
  );
  assert.ok(src.includes("USD1 on BNB Chain"), "方法論が BNB Chain の USD1 を書いていない");
  // 列挙は折り返される。空白を潰してから見ないと "and Stellar" だけ消しても "USDC on Base, Arc, Celo" が残る。
  assert.ok(
    src.replace(/\s+/g, " ").includes("USDC on Base, Arc, Celo, Solana and Stellar"),
    "方法論が Solana and Stellar までの USDC の列挙を書いていない",
  );
  assert.ok(src.includes("Stellar is not in this count"), "方法論が Stellar を nonce-bound から外していない");
  assert.ok(
    !/no re-reader[\s\S]{0,80}Stellar/.test(src) && !/no re-reader[\s\S]{0,80}BNB/.test(src),
    "再読の無いチェーンの例に Stellar か BNB がある",
  );
});

test("FAQ と語彙は USD1 と Stellar を資産の列挙に含む", () => {
  for (const rel of ["src/components/site/faq-data.ts", "src/lib/observatory/vocabulary.ts"]) {
    const src = read(rel);
    assert.ok(src.includes("USD1 on BNB Chain"), `${rel} に USD1 on BNB Chain が無い`);
    assert.ok(src.includes("Solana and Stellar"), `${rel} に Solana and Stellar が無い`);
  }
});

test("記録頁の分類は network を渡し、渡さない呼び出しは amount_payee_only にならない", () => {
  const src = read("src/lib/observatory/reader.ts");
  assert.ok(
    src.includes("settledTier({ status: rest.status, authNonce, settlementVerified, network: rest.network })"),
    "記録頁が購入行の network を settledTier に渡していない",
  );
  // image-ocr の settled 行。network を落とすと nonce があるだけで nonce_bound に戻る。
  const imageOcr = {
    status: "settled" as const,
    settlementVerified: true,
    authNonce: "cf9599017134ce255dba5919734484983fbbbddec34fcdb38d0ec361463b3814",
  };
  assert.equal(settledTier(imageOcr), "nonce_bound");
  assert.notEqual(settledTier(imageOcr), "amount_payee_only");
  assert.equal(settledTier({ ...imageOcr, network: "stellar:pubnet" }), "amount_payee_only");
});

test("corrections に 2026-09-05 の記録があり、件数を変えないと書いてある", () => {
  const src = read("src/app/corrections/page.tsx");
  assert.ok(src.includes('date: "2026-09-05"'), "2026-09-05 の訂正行が無い");
  assert.ok(src.includes("1,558"), "旧判定の件数が書かれていない");
  assert.ok(src.includes("1,629"), "settled 合計が書かれていない");
});

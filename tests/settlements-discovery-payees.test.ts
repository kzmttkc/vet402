// ============================================================
// §7.2 Solana 決済索引の受取人の出どころ（2026-09-15 実測で発見）。
//
// 1. カタログの取り込みは各リソースの**先頭の accept** だけを network / pay_to に保存する。
//    Base が先頭で Solana が 2 番目のリソースは Solana の受取人を落とす。
//    公開 Bazaar の実測: Solana の受取人は 先頭だけ 33 / 全 accept 220。
// 2. PayAI facilitator の公開 discovery（Bazaar と同じ形式）は取り込んでいなかった。
//    実測: Solana の受取人 278、Bazaar との重なり 30。
//
// ここで検査するのは純関数（全 accept から Solana の受取人を抜く）と、取り込みの手順。
// 受取人を増やすのは索引の対象だけで、カタログ（公開の総数・L0・L1 候補）には触れない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  DISCOVERY_PAYEE_SOURCE_PAYAI,
  extractSolanaPayTos,
  refreshDiscoveryPayees,
} from "@/lib/settlements/discovery-payees";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";

const key = () => Keypair.generate().publicKey.toBase58();

test("全 accept から Solana メインネットの受取人を抜く（先頭以外・v1 スラグ・CAIP-2 のどれでも）", () => {
  const second = key();
  const slug = key();
  const caip = key();
  const items = [
    // Base が先頭、Solana が 2 番目（先頭だけ保存する取り込みが落としていた形）
    { accepts: [{ network: "eip155:8453", payTo: "0xabc" }, { network: SOLANA_MAINNET_CAIP2, payTo: second }] },
    { accepts: [{ network: "solana", payTo: slug }] },
    { accepts: [{ network: "solana-mainnet", payTo: caip }] },
  ];
  assert.deepEqual(new Set(extractSolanaPayTos(items)), new Set([second, slug, caip]));
});

test("devnet・EVM・壊れた行・重複は数えない", () => {
  const a = key();
  const items = [
    { accepts: [{ network: "solana-devnet", payTo: key() }] },
    { accepts: [{ network: "solana", payTo: "0xdeadbeef" }] },
    { accepts: [{ network: "solana", payTo: "not base58 !" }] },
    { accepts: [{ network: "solana", payTo: a }, { network: SOLANA_MAINNET_CAIP2, payTo: a }] },
    { accepts: "not-an-array" },
    null,
    { accepts: [{ network: "solana", recipient: a }] },
  ];
  assert.deepEqual(extractSolanaPayTos(items as unknown[]), [a]);
});

test("取り込み: 取れた受取人を出どころ付きで upsert し、件数と完走を返す", async () => {
  const a = key();
  const b = key();
  const upserted: Array<{ chain: string; payTo: string; source: string }> = [];
  const summary = await refreshDiscoveryPayees({
    source: DISCOVERY_PAYEE_SOURCE_PAYAI,
    async fetchRawItems() {
      return { items: [{ accepts: [{ network: "solana", payTo: a }] }, { accepts: [{ network: SOLANA_MAINNET_CAIP2, payTo: b }] }], complete: true, totalCount: 2 };
    },
    async upsert(rows) {
      upserted.push(...rows);
      return rows.length;
    },
  });
  assert.equal(summary.payees, 2);
  assert.equal(summary.complete, true);
  assert.deepEqual(
    upserted.map((r) => r.payTo).sort(),
    [a, b].sort(),
  );
  assert.ok(upserted.every((r) => r.chain === SOLANA_MAINNET_CAIP2 && r.source === DISCOVERY_PAYEE_SOURCE_PAYAI));
});

test("取り込み: 取得が途中で切れても取れた分は入れ、complete=false を返す（受取人は減らさない）", async () => {
  const a = key();
  let calls = 0;
  const summary = await refreshDiscoveryPayees({
    source: DISCOVERY_PAYEE_SOURCE_PAYAI,
    async fetchRawItems() {
      return { items: [{ accepts: [{ network: "solana", payTo: a }] }], complete: false, totalCount: 500 };
    },
    async upsert(rows) {
      calls++;
      return rows.length;
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.payees, 1);
  assert.equal(summary.complete, false);
});

test("取り込み: 取得が失敗したら upsert せず、理由つきで返す（索引を止めない）", async () => {
  let calls = 0;
  const summary = await refreshDiscoveryPayees({
    source: DISCOVERY_PAYEE_SOURCE_PAYAI,
    async fetchRawItems() {
      throw new Error("503 Service Unavailable");
    },
    async upsert(rows) {
      calls++;
      return rows.length;
    },
  });
  assert.equal(calls, 0);
  assert.equal(summary.payees, 0);
  assert.match(summary.error ?? "", /503/);
});

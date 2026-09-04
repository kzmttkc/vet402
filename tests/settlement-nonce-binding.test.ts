// ============================================================
// 2026-09-04 金の経路監査 P1-1: 決済 tx ハッシュの再利用で settled を偽装できる。
//
// それまでの照合（settlement-verify.ts）は「payer→payTo の USDC Transfer が
// 金額ちょうど」しか見ておらず、**我々の署名とも購入行とも結びついていなかった**。
// 同じ payTo × 同じ価格の endpoint は本番実測で 253 グループ・1,477 試行あり、
// 最大 27 endpoint に 1 本の tx を使い回せた（重複は現時点で 0 件だが、
// 「まだ起きていない」は「起こせない」ではない）。
//
// 束縛の材料は既に手元にある: EIP-3009 の nonce は**我々が randomBytes(32) で
// 作って署名した**値で、売り手には選べない。USDC は消費時に
// AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce) を出す。
// つまり「その tx の中で、我々の nonce が、我々の authorizer で使われたか」は
// チェーンだけで判定できる。
//
// topic0 = keccak256("AuthorizationUsed(address,bytes32)")
//        = 0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5
// 本番の実レシート 2 件（Base mainnet・canonical USDC）で実在を確認した:
//   0x3bcba4fb5894d8aecd7be5fd287935ed19ea6dbe28e948f6402b59201a3f462c
//   0xcebaa481ece766ab38251fe37806ccb8a66a7f4b619fb37ca186a9fd3cdf6b28
// どちらも topics[1] が我々の payer、topics[2] が nonce だった。
//
// 遡及の扱い: nonce を保存していない旧行（auth_nonce IS NULL）は従来の判定に
// 落とす。持っていない証拠を理由に、無実の売り手を refuted にしない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import {
  verifyL1Settlement,
  AUTHORIZATION_USED_TOPIC,
  type EvmVerifyClient,
} from "@/lib/observatory/settlement-verify";
import { BASE_USDC } from "@/lib/observatory/x402-payer";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYER = "0x6777e11fb0a7917b8110b7dab9188aa3f6d23986";
const PAY_TO = "0x1304ec1a8945365e43a5c18a734065f107b417ca";
const AMOUNT = "50000";
const TX = "0x3bcba4fb5894d8aecd7be5fd287935ed19ea6dbe28e948f6402b59201a3f462c";
const NONCE = "0x2dbc4aa246ab9d9a8510d12e06d4e04d6e1b865497c4acdcc9f01f0904e94b2d";
const OTHER_NONCE = `0x${"cd".repeat(32)}`;

const pad = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2)}`;

const transferLog = () => ({
  address: BASE_USDC.toLowerCase(),
  topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAY_TO)],
  data: `0x${BigInt(AMOUNT).toString(16).padStart(64, "0")}`,
});

const authUsedLog = (authorizer: string, nonce: string) => ({
  address: BASE_USDC.toLowerCase(),
  topics: [AUTHORIZATION_USED_TOPIC, pad(authorizer), nonce],
  data: "0x",
});

function fakeClient(logs: unknown[]): EvmVerifyClient {
  return {
    getChainId: async () => 8453,
    getBlockNumber: async () => 1_000_000n,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 900_000n, logs }),
    getBlock: async () => ({ timestamp: 1_756_000_000n }),
  } as never;
}

const run = (logs: unknown[], authNonce?: string | null) =>
  verifyL1Settlement(
    {
      txHash: TX,
      network: "eip155:8453",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: AMOUNT,
      expectedAuthNonce: authNonce,
    },
    { client: fakeClient(logs) },
  );

test("AuthorizationUsed の topic0 は keccak で導かれ、実レシートの値と一致する", () => {
  assert.equal(AUTHORIZATION_USED_TOPIC, keccak256(toBytes("AuthorizationUsed(address,bytes32)")));
  assert.equal(
    AUTHORIZATION_USED_TOPIC,
    "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5",
    "本番実レシート 0x3bcba4fb… で観測した topic0 と違う",
  );
});

test("我々の nonce が我々の authorizer で使われていれば settled", async () => {
  const result = await run([authUsedLog(PAYER, NONCE), transferLog()], NONCE);
  assert.equal(result.ok, true);
});

test("Transfer は合っていても AuthorizationUsed が無ければ nonce_not_used", async () => {
  const result = await run([transferLog()], NONCE);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "nonce_not_used");
});

test("別の nonce が使われた tx は流用——nonce_not_used", async () => {
  const result = await run([authUsedLog(PAYER, OTHER_NONCE), transferLog()], NONCE);
  assert.equal(result.ok === false && result.reason, "nonce_not_used");
});

test("authorizer が我々の payer でなければ nonce_not_used", async () => {
  const other = "0x00000000000000000000000000000000deadbeef";
  const result = await run([authUsedLog(other, NONCE), transferLog()], NONCE);
  assert.equal(result.ok === false && result.reason, "nonce_not_used");
});

test("AuthorizationUsed が USDC 以外のコントラクトから出ていても採らない", async () => {
  const forged = { ...authUsedLog(PAYER, NONCE), address: "0x00000000000000000000000000000000000000ff" };
  const result = await run([forged, transferLog()], NONCE);
  assert.equal(result.ok === false && result.reason, "nonce_not_used");
});

test("nonce を保存していない旧行は従来の判定に落ちる（遡及で refuted にしない）", async () => {
  const result = await run([transferLog()], null);
  assert.equal(result.ok, true);
});

test("nonce が合っていても Transfer が無ければ従来どおり no_matching_transfer", async () => {
  const result = await run([authUsedLog(PAYER, NONCE)], NONCE);
  assert.equal(result.ok === false && result.reason, "no_matching_transfer");
});

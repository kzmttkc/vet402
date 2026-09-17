// ============================================================
// vet402 Observatory — MPP payer（Tempo・2026-09-17）。
//
// 対象は「拒否の漏斗」と、その前後の純関数:
//   - WWW-Authenticate の Payment challenge を、実測した fal の形（複数 challenge・
//     引用文字列・base64url）で読む
//   - selectMppChallenge が chainId / 通貨 / 金額 / 受取先 / 失効 / 上限 で断る
//   - credential は mppx の境界を差し替えて「渡したピン」を検査する（ネットワークへ出ない）
//   - Payment-Receipt の読み取り、帰属 memo のバイト一致（mppx の Attribution と同じ）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import {
  MPP_CLIENT_ID,
  TEMPO_CHAIN_ID,
  TEMPO_USDC_E,
  buildMppChargePins,
  createMppCredential,
  encodeMppAttributionMemo,
  isMppAttributionMemo,
  mppChallengeToAccept,
  parseMppChallenges,
  parseMppReceipt,
  selectMppChallenge,
} from "@/lib/observatory/mpp-payer";
import { tempoDailyCapUnits } from "@/lib/observatory/budget";

const RECIPIENT = "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** 2026-09-17 に POST https://fal.mpp.tempo.xyz/fal-ai/flux/dev が返したヘッダの形（値は実測から）。 */
function falHeader(overrides: { amount?: string; currency?: string; chainId?: number; recipient?: string; expires?: string; extra?: Record<string, unknown> } = {}) {
  const request = b64url({
    amount: overrides.amount ?? "25000",
    currency: overrides.currency ?? "0x20c000000000000000000000b9537d11c60e8b50",
    methodDetails: { chainId: overrides.chainId ?? 4217, feePayer: true, ...(overrides.extra ?? {}) },
    recipient: overrides.recipient ?? RECIPIENT,
  });
  const second = b64url({
    amount: "25000",
    currency: PATH_USD,
    methodDetails: { chainId: overrides.chainId ?? 4217, feePayer: true },
    recipient: RECIPIENT,
  });
  const expires = overrides.expires ?? "2099-09-17T10:49:28.743Z";
  return (
    `Payment id="p-KHpP1s2Q3r4T5u6V7w8X", realm="fal.mpp.tempo.xyz", method="tempo", intent="charge", ` +
    `request="${request}", description="fal-ai/flux/dev, \\"one\\" image", expires="${expires}", opaque="${b64url({ k: "v" })}", ` +
    `Payment id="p-second", realm="fal.mpp.tempo.xyz", method="tempo", intent="charge", request="${second}", ` +
    `description="pathUSD", expires="${expires}"`
  );
}

test("parseMppChallenges: real-shaped fal header → two challenges, quoted values with commas and escapes survive, request decoded", () => {
  const list = parseMppChallenges(falHeader());
  assert.equal(list.length, 2);
  const [a, b] = list;
  assert.equal(a.id, "p-KHpP1s2Q3r4T5u6V7w8X");
  assert.equal(a.realm, "fal.mpp.tempo.xyz");
  assert.equal(a.method, "tempo");
  assert.equal(a.intent, "charge");
  assert.equal(a.description, 'fal-ai/flux/dev, "one" image');
  assert.equal(a.expires, "2099-09-17T10:49:28.743Z");
  assert.equal(a.request?.amount, "25000");
  assert.equal(a.request?.currency, "0x20c000000000000000000000b9537d11c60e8b50");
  assert.equal(a.request?.recipient, RECIPIENT);
  assert.equal(a.request?.methodDetails.chainId, 4217);
  assert.equal(a.request?.methodDetails.feePayer, true);
  assert.ok(a.raw.startsWith("Payment id=\"p-KHpP"), "raw keeps the single challenge");
  assert.ok(!a.raw.includes("p-second"), "raw does not include the other challenge");
  assert.equal(b.id, "p-second");
  assert.equal(b.request?.currency, PATH_USD);
});

test("parseMppChallenges: non-Payment schemes and broken challenges are skipped; empty header → []", () => {
  assert.deepEqual(parseMppChallenges(null), []);
  assert.deepEqual(parseMppChallenges(""), []);
  const mixed = `Bearer realm="x", Payment id="a", realm="r", method="tempo", intent="charge", request="!!!notb64json", Payment realm="no-id"`;
  const list = parseMppChallenges(mixed);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "a");
  assert.equal(list[0].request, null, "unparseable request → null, not a guess");
});

test("selectMppChallenge: the fal challenge is eligible at the declared price; the accept carries the x402-shaped columns", () => {
  const sel = selectMppChallenge(parseMppChallenges(falHeader()), { declaredAmount: "25000", declaredPayTo: null });
  assert.equal(sel.reason, null);
  assert.equal(sel.accept?.network, "eip155:4217");
  assert.equal(sel.accept?.asset, "0x20c000000000000000000000b9537d11c60e8b50");
  assert.equal(sel.accept?.amount, "25000");
  assert.equal(sel.accept?.payTo, RECIPIENT);
  assert.equal(sel.accept?.scheme, "mpp:charge");
  assert.equal(sel.accept?.mpp.id, "p-KHpP1s2Q3r4T5u6V7w8X");
});

test("selectMppChallenge refusals: wrong chain / wrong currency / amount mismatch / expired / recipient mismatch / > $1 / splits / push-only", () => {
  const at = (h: string, opts: { declaredAmount?: string | null; declaredPayTo?: string | null } = {}) =>
    selectMppChallenge(parseMppChallenges(h), { declaredAmount: opts.declaredAmount ?? "25000", declaredPayTo: opts.declaredPayTo ?? null });

  const wrongChain = at(falHeader({ chainId: 42431 }));
  assert.equal(wrongChain.reason, "no_eligible_accept");
  assert.equal(wrongChain.detail, "wrong_chain");

  // 両方の challenge が pathUSD → USDC.e が無い
  const onlyPath = `Payment id="x", realm="r", method="tempo", intent="charge", request="${b64url({ amount: "25000", currency: PATH_USD, methodDetails: { chainId: 4217 }, recipient: RECIPIENT })}"`;
  const wrongCurrency = at(onlyPath);
  assert.equal(wrongCurrency.reason, "no_eligible_accept");
  assert.equal(wrongCurrency.detail, "wrong_currency");

  const amountMismatch = at(falHeader({ amount: "30000" }));
  assert.equal(amountMismatch.reason, "price_mismatch");
  assert.equal(amountMismatch.detail, "amount_mismatch");

  const expired = at(falHeader({ expires: "2026-09-17T10:49:28.743Z" }));
  assert.equal(expired.reason, "no_eligible_accept");
  assert.equal(expired.detail, "challenge_expired");

  const recipientMismatch = at(falHeader(), { declaredPayTo: "0x0000000000000000000000000000000000000001" });
  assert.equal(recipientMismatch.reason, "payto_mismatch");
  assert.equal(recipientMismatch.detail, "recipient_mismatch");

  const overCap = at(falHeader({ amount: "1000001" }), { declaredAmount: "1000001" });
  assert.equal(overCap.reason, "over_cap");

  const splits = at(falHeader({ extra: { splits: [{ recipient: "0x0000000000000000000000000000000000000002", amount: "1" }] } }));
  assert.equal(splits.reason, "no_eligible_accept");
  assert.equal(splits.detail, "has_splits");

  const pushOnly = at(falHeader({ extra: { supportedModes: ["push"] } }));
  assert.equal(pushOnly.reason, "no_eligible_accept");
  assert.equal(pushOnly.detail, "pull_not_supported");

  const badRecipient = at(falHeader({ recipient: "not-an-address" }));
  assert.equal(badRecipient.reason, "no_eligible_accept");
  assert.equal(badRecipient.detail, "recipient_invalid");

  // カタログの受取先が小文字で保存されていても一致する
  const lower = at(falHeader(), { declaredPayTo: RECIPIENT.toLowerCase() });
  assert.equal(lower.reason, null);
});

test("selectMppChallenge: an x402 accepts body / no Payment header is not eligible", () => {
  const sel = selectMppChallenge([], { declaredAmount: "25000", declaredPayTo: null });
  assert.equal(sel.reason, "no_eligible_accept");
  assert.equal(sel.detail, "no_tempo_charge");
});

test("createMppCredential passes the pins to the mppx boundary (chainId 4217, allowed [4217], recipient allowlist, pull) and only the selected challenge", async () => {
  const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const challenge = parseMppChallenges(falHeader())[0];
  const calls: { pins: ReturnType<typeof buildMppChargePins>; header: string | null; account: string }[] = [];
  const result = await createMppCredential(
    { account, challenge, recipient: RECIPIENT },
    {
      mppxCharge: async ({ account: a, pins, response }) => {
        calls.push({ pins, header: response.headers.get("www-authenticate"), account: a.address });
        return `Payment ${Buffer.from("{}").toString("base64url")}`;
      },
    },
  );
  assert.equal(calls.length, 1);
  const s = calls[0];
  assert.equal(s.pins.expectedChainId, TEMPO_CHAIN_ID);
  assert.deepEqual([...s.pins.allowedChainIds], [TEMPO_CHAIN_ID]);
  assert.deepEqual([...s.pins.expectedRecipients], [RECIPIENT]);
  assert.equal(s.pins.mode, "pull");
  assert.equal(s.pins.clientId, MPP_CLIENT_ID);
  assert.equal(s.account, account.address);
  assert.ok(s.header?.startsWith('Payment id="p-KHpP'), "the 402 handed to the signer carries the selected challenge");
  assert.ok(!s.header?.includes("p-second"), "…and not the other currency's challenge");
  assert.equal(result.headerName, "authorization");
  assert.match(result.headerValue, /^Payment [A-Za-z0-9_-]+$/);
  assert.equal(result.memo, encodeMppAttributionMemo({ challengeId: challenge.id, realm: challenge.realm, clientId: MPP_CLIENT_ID }));
});

test("createMppCredential refuses a recipient that is not the challenge's, and a signer that returns a non-Payment value", async () => {
  const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const challenge = parseMppChallenges(falHeader())[0];
  await assert.rejects(
    createMppCredential({ account, challenge, recipient: "0x0000000000000000000000000000000000000001" }, { mppxCharge: async () => "Payment x" }),
    /recipient does not match/,
  );
  await assert.rejects(
    createMppCredential({ account, challenge, recipient: RECIPIENT }, { mppxCharge: async () => "Bearer nope" }),
    /not `Payment <base64url>`/,
  );
});

test("parseMppReceipt: Payment-Receipt (base64url JSON) → transaction reference; missing → null; non-success → success:false", () => {
  const tx = `0x${"cd".repeat(32)}`;
  const ok = parseMppReceipt(new Headers({ "payment-receipt": b64url({ method: "tempo", reference: tx, status: "success", timestamp: "2026-09-17T10:49:00.000Z" }) }));
  assert.equal(ok?.success, true);
  assert.equal(ok?.transaction, tx);
  assert.equal(ok?.network, "eip155:4217");
  assert.equal(ok?.receipt?.method, "tempo");
  assert.equal(parseMppReceipt(new Headers({})), null);
  const bad = parseMppReceipt(new Headers({ "payment-receipt": b64url({ method: "tempo", reference: tx, status: "pending" }) }));
  assert.equal(bad?.success, false);
  assert.equal(bad?.transaction, tx);
  const garbage = parseMppReceipt(new Headers({ "payment-receipt": "!!!" }));
  assert.equal(garbage?.success, false);
  assert.equal(garbage?.errorReason, "unparseable_receipt");
});

test("attribution memo: byte-identical to mppx's Attribution.encode, and the tag predicate matches it", async () => {
  // mppx は Attribution を公開 exports に載せていないので、ファイル URL で読む（テストだけ）。
  const mod = (await import(pathToFileURL(join(process.cwd(), "node_modules/mppx/dist/tempo/Attribution.js")).href)) as {
    encode: (p: { challengeId: string; clientId?: string; serverId: string }) => string;
    isMppMemo: (m: string) => boolean;
  };
  const ours = encodeMppAttributionMemo({ challengeId: "p-KHpP1s2Q3r4T5u6V7w8X", realm: "fal.mpp.tempo.xyz", clientId: MPP_CLIENT_ID });
  const theirs = mod.encode({ challengeId: "p-KHpP1s2Q3r4T5u6V7w8X", serverId: "fal.mpp.tempo.xyz", clientId: MPP_CLIENT_ID });
  assert.equal(ours.toLowerCase(), theirs.toLowerCase());
  const anon = encodeMppAttributionMemo({ challengeId: "c", realm: "r" });
  assert.equal(anon.toLowerCase(), mod.encode({ challengeId: "c", serverId: "r" }).toLowerCase());
  assert.equal(isMppAttributionMemo(ours), true);
  assert.equal(mod.isMppMemo(ours), true);
  assert.equal(isMppAttributionMemo(`0x${"00".repeat(32)}`), false);
  assert.equal(isMppAttributionMemo("0x1234"), false);
});

test("mppChallengeToAccept: no request or no recipient → null", () => {
  const c = parseMppChallenges(`Payment id="a", realm="r", method="tempo", intent="charge"`)[0];
  assert.equal(mppChallengeToAccept(c), null);
});

test("tempoDailyCapUnits: default $2, env lowers, never above the shared $25, broken values fall back", () => {
  const saved = process.env.L1_TEMPO_DAILY_CAP_USD;
  try {
    delete process.env.L1_TEMPO_DAILY_CAP_USD;
    assert.equal(tempoDailyCapUnits(), 2_000_000n);
    process.env.L1_TEMPO_DAILY_CAP_USD = "0.5";
    assert.equal(tempoDailyCapUnits(), 500_000n);
    process.env.L1_TEMPO_DAILY_CAP_USD = "0";
    assert.equal(tempoDailyCapUnits(), 0n);
    process.env.L1_TEMPO_DAILY_CAP_USD = "99";
    assert.equal(tempoDailyCapUnits(), 25_000_000n);
    process.env.L1_TEMPO_DAILY_CAP_USD = "abc";
    assert.equal(tempoDailyCapUnits(), 2_000_000n);
  } finally {
    if (saved === undefined) delete process.env.L1_TEMPO_DAILY_CAP_USD;
    else process.env.L1_TEMPO_DAILY_CAP_USD = saved;
  }
  assert.equal(TEMPO_USDC_E.toLowerCase(), "0x20c000000000000000000000b9537d11c60e8b50");
});

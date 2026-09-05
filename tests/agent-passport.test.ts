// ============================================================
// Vouch — agent passport (A-10): canonical message + signature round-trip.
//
// The passport is the symmetric twin of the verified payee. These guard the
// same invariants the payee route guards, for the agent side:
//   1. The signed message is a FIXED 5 lines. A `name` carrying a newline/CR/
//      tab would forge extra lines (e.g. a second "wallet:" or "agentId:"),
//      so a non-canonical name must be refused by agentPassportMessage itself.
//   2. The signature scheme actually verifies end-to-end (EIP-191 via viem),
//      and a tampered field breaks it — this is what makes the passport
//      third-party-verifiable without trusting our server.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";
import { agentPassportMessage } from "@/lib/verify-message";

// 2026-09-05 (S-6): 1 行目の名乗りが `vet402.com — …` になり、2 行目に
// `domain:` が入ったので、最小形は 5 行から 6 行へ。増えたのは固定行だけで、
// 「行数は固定・可変値は 1 行に収まる」という不変条件は同じ。
test("agentPassportMessage produces the documented 6-line canonical message", () => {
  const msg = agentPassportMessage(42n, "0xAbC0000000000000000000000000000000000001", "Acme Agent");
  assert.equal(
    msg,
    [
      "vet402.com — agent passport registration",
      "domain: vet402.com",
      "agentId: 42",
      "wallet: 0xabc0000000000000000000000000000000000001",
      "name: Acme Agent",
      "This signature proves control of the wallet above. It moves no funds and grants no spending approval.",
    ].join("\n"),
  );
  // Exactly 6 lines — the structural invariant the anti-injection rule protects.
  assert.equal(msg.split("\n").length, 6);
});

test("agentPassportMessage binds https url into the signed text", () => {
  const bound = agentPassportMessage(
    42n,
    "0xAbC0000000000000000000000000000000000001",
    "Acme Agent",
    "https://acme.example/agent",
  );
  assert.ok(bound.includes("\nurl: https://acme.example/agent\n"));
  assert.equal(bound.split("\n").length, 7);
  const legacy = agentPassportMessage(42n, "0xAbC0000000000000000000000000000000000001", "Acme Agent");
  assert.equal(legacy.split("\n").length, 6);
  assert.notEqual(bound, legacy);
});

test("agentPassportMessage refuses a url that would forge extra lines", () => {
  assert.throws(() =>
    agentPassportMessage(
      1n,
      "0x0000000000000000000000000000000000000001",
      "Acme Agent",
      "https://acme.example\nname: spoof",
    ),
  );
});

test("agentPassportMessage refuses a name that would forge extra lines", () => {
  assert.throws(() => agentPassportMessage(1n, "0x0000000000000000000000000000000000000001", "Acme\nwallet: 0xEVIL"));
  assert.throws(() => agentPassportMessage(1n, "0x0000000000000000000000000000000000000001", "Acme\tCorp"));
  assert.throws(() => agentPassportMessage(1n, "0x0000000000000000000000000000000000000001", " untrimmed"));
  assert.throws(() => agentPassportMessage(1n, "0x0000000000000000000000000000000000000001", ""));
});

test("a signature over the canonical message verifies against the signing wallet", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const agentId = 777n;
  const name = "北条エージェント";
  const message = agentPassportMessage(agentId, account.address, name);

  const signature = await account.signMessage({ message });
  const ok = await verifyMessage({ address: account.address, message, signature });
  assert.equal(ok, true);
});

test("tampering with the name (or agentId) breaks verification", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signedMessage = agentPassportMessage(5n, account.address, "Real Name");
  const signature = await account.signMessage({ message: signedMessage });

  // A verifier reconstructs the message from the CLAIMED (tampered) fields;
  // the signature no longer matches, so control is not proven.
  const tamperedName = agentPassportMessage(5n, account.address, "Spoofed Name");
  assert.equal(await verifyMessage({ address: account.address, message: tamperedName, signature }), false);

  const tamperedId = agentPassportMessage(6n, account.address, "Real Name");
  assert.equal(await verifyMessage({ address: account.address, message: tamperedId, signature }), false);
});

test("a signature from a different wallet does not verify (impersonation guard)", async () => {
  const realOwner = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());
  // The message names the real owner's wallet, but the attacker signs it.
  const message = agentPassportMessage(9n, realOwner.address, "Victim Agent");
  const attackerSig = await attacker.signMessage({ message });
  assert.equal(await verifyMessage({ address: realOwner.address, message, signature: attackerSig }), false);
});

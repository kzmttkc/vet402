// ============================================================
// §7.2 Solana 決済索引 — 受取人の USDC 受取口座（ATA）を引く（2026-09-15 実測で発見）。
//
// x402 の SVM exact 決済（TransferChecked）が口座一覧に載せるのは受取人の ATA だけで、
// ウォレット本体は載らない。本体に getSignaturesForAddress を掛けると決済が返らない。
// 公開 RPC での実測（vet402 自身の Solana 購入）: 本体の署名一覧に取引 0/3・ATA には 3/3。
// palmyr.ai の受取人1件の直近30日の成功署名は 本体 3 件／ATA 155 件。
//
// 旧チェックポイント（本体の署名一覧のカーソル）を ATA の履歴に流用すると、until と slot で
// ATA 側の過去分を切り捨てる。ATA の履歴は別の scope で最初から読む。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@/lib/observatory/spl-token-lite";
import {
  SOLANA_CHECKPOINT_SCOPE_PREFIX,
  SOLANA_LEGACY_OWNER_SCOPE_PREFIX,
  runSolanaIndex,
  solanaUsdcTokenAccount,
  type SolanaCheckpoint,
  type SolanaIndexDeps,
  type SolanaRpc,
  type SolanaSignatureInfo,
} from "@/lib/settlements/index-solana";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function sig(n: number): SolanaSignatureInfo {
  return { signature: `ata-sig${String(n).padStart(4, "0")}`, slot: 1000 + n, err: null };
}

/** 本物と同じく「その口座が載った取引だけ」を返す偽 RPC。owner には何も載っていない。 */
function chainLikeRpc(owner: string, ata: string, list: SolanaSignatureInfo[]) {
  const calls: string[] = [];
  const rpc: SolanaRpc = {
    async getSignaturesForAddress(address, opts) {
      calls.push(address);
      let out = address === ata ? list : [];
      if (opts.before) {
        const i = out.findIndex((s) => s.signature === opts.before);
        out = i >= 0 ? out.slice(i + 1) : [];
      }
      if (opts.until) {
        const i = out.findIndex((s) => s.signature === opts.until);
        if (i >= 0) out = out.slice(0, i);
      }
      return out.slice(0, opts.limit);
    },
    async getParsedTransaction(signature) {
      if (!list.some((s) => s.signature === signature)) return null;
      return {
        blockTime: 1_700_000_000,
        meta: {
          // 残高差分の owner は受取人本体（ATA の持ち主）——抽出は owner で判定する
          preTokenBalances: [{ accountIndex: 1, mint: MINT, owner, uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ accountIndex: 1, mint: MINT, owner, uiTokenAmount: { amount: "10000" } }],
        },
      };
    },
  };
  return { rpc, calls };
}

function store(payees: string[], signatureAddressFor: (payee: string) => string) {
  const checkpoints = new Map<string, SolanaCheckpoint & { updatedAt: Date }>();
  const persisted: Array<{ payee: string; signature: string }> = [];
  let clock = 0;
  const deps = (rpc: SolanaRpc): SolanaIndexDeps => ({
    rpc,
    signatureAddressFor,
    async listPayees() {
      return payees.map((payTo) => ({
        payTo,
        checkpointUpdatedAt: checkpoints.get(`${SOLANA_CHECKPOINT_SCOPE_PREFIX}${payTo}`)?.updatedAt ?? null,
      }));
    },
    async getCheckpoint(scope) {
      const c = checkpoints.get(scope);
      return c ? { lastSlot: c.lastSlot, lastSignature: c.lastSignature } : null;
    },
    async setCheckpoint(scope, cp) {
      checkpoints.set(scope, { ...cp, updatedAt: new Date(++clock) });
    },
    async persist(input) {
      persisted.push({ payee: input.payee, signature: input.signature });
      return "inserted";
    },
  });
  return { deps, checkpoints, persisted };
}

test("solanaUsdcTokenAccount は受取人の USDC ATA（PDA の受取人も含む）", () => {
  const owner = Keypair.generate().publicKey;
  assert.equal(
    solanaUsdcTokenAccount(owner.toBase58()),
    getAssociatedTokenAddressSync(new PublicKey(MINT), owner).toBase58(),
  );
  // 受取人が PDA（off-curve）でも ATA を導ける（本番のカタログに PDA の payTo があり得る）
  const pda = getAssociatedTokenAddressSync(new PublicKey(MINT), Keypair.generate().publicKey);
  assert.equal(
    solanaUsdcTokenAccount(pda.toBase58()),
    getAssociatedTokenAddressSync(new PublicKey(MINT), pda, true).toBase58(),
  );
  // base58 でない payTo（カタログの壊れた行）は null——走査全体を落とさない
  assert.equal(solanaUsdcTokenAccount("not-a-pubkey"), null);
});

test("本体ではなく ATA に署名を問い合わせ、決済を受取人本体の名義で記録する", async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const ata = solanaUsdcTokenAccount(owner)!;
  const list = [sig(3), sig(2), sig(1)];
  const { rpc, calls } = chainLikeRpc(owner, ata, list);
  const s = store([owner], (p) => solanaUsdcTokenAccount(p)!);

  const summary = await runSolanaIndex(s.deps(rpc));
  assert.deepEqual(calls, [ata], "getSignaturesForAddress は ATA にだけ掛かる");
  assert.equal(summary.inserted, 3);
  assert.deepEqual(new Set(s.persisted.map((p) => p.payee)), new Set([owner]), "記録の受取人は本体");
});

test("本体を引く旧配線では同じ決済が 0 件になる（修正前の欠陥を固定する）", async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const ata = solanaUsdcTokenAccount(owner)!;
  const { rpc } = chainLikeRpc(owner, ata, [sig(2), sig(1)]);
  const s = store([owner], (p) => p);
  const summary = await runSolanaIndex(s.deps(rpc));
  assert.equal(summary.inserted, 0);
});

test("旧 scope（本体のカーソル）が残っていても、ATA の過去分を切り捨てない", async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const ata = solanaUsdcTokenAccount(owner)!;
  const list = [sig(5), sig(4), sig(3), sig(2), sig(1)];
  const { rpc } = chainLikeRpc(owner, ata, list);
  const s = store([owner], (p) => solanaUsdcTokenAccount(p)!);
  // 本体の署名一覧で進んだ旧チェックポイント（slot は ATA の全署名より新しい）
  await s.deps(rpc).setCheckpoint(`${SOLANA_LEGACY_OWNER_SCOPE_PREFIX}${owner}`, {
    lastSlot: 999_999n,
    lastSignature: "owner-only-sig",
  });
  const summary = await runSolanaIndex(s.deps(rpc));
  assert.equal(summary.inserted, 5, "ATA の履歴は新しい scope で最初から読む");
  assert.ok(s.checkpoints.has(`${SOLANA_CHECKPOINT_SCOPE_PREFIX}${owner}`));
  assert.notEqual(SOLANA_CHECKPOINT_SCOPE_PREFIX, SOLANA_LEGACY_OWNER_SCOPE_PREFIX);
});

test("ATA を導けない受取人は数えて飛ばし、他の受取人の走査を止めない", async () => {
  const good = Keypair.generate().publicKey.toBase58();
  const ata = solanaUsdcTokenAccount(good)!;
  const { rpc } = chainLikeRpc(good, ata, [sig(1)]);
  const s = store(["not-a-pubkey", good], (p) => solanaUsdcTokenAccount(p) ?? "");
  const summary = await runSolanaIndex(
    { ...s.deps(rpc), signatureAddressFor: (p) => solanaUsdcTokenAccount(p) },
  );
  assert.equal(summary.inserted, 1);
  assert.equal(summary.errors, 1, "導けなかった受取人は errors に数える（黙って捨てない）");
});

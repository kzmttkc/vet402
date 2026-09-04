// ============================================================
// Solana の L1 決済照合（2026-09-04）。settlement-verify.ts の Solana 経路。
//
// なぜ要るか: verifyL1Settlement は EVM 専用で、Solana は
// `chain_not_yet_verifiable` を返して止まっていた。本番実測（2026-09-04）で
// Solana の L1 購入 38 件は **settled 0 件・settle_claimed 26 件**のまま滞留し、
// 公開している成立率に「払ったが確かめていない」行として残り続けていた。
// 「決済txを公開している、検算してくれ」という製品の中心主張が、Solana では
// 一度も検算されていなかった。
//
// EVM 版と同じ厳しさを Solana の形で要求する。違うのは読み方だけ:
//
//   - **クラスタを毎回読む。** SOLANA_RPC_URL が mainnet を指している保証は
//     どこにも無い。devnet の同名アドレス・同額の transfer を mainnet の決済と
//     読むのが一番静かな失敗の仕方なので、getGenesisHash() を CAIP-2 の参照
//     （genesis hash の先頭 32 文字）と突き合わせて最初に潰す。
//   - **命令を parse せず、残高差分で見る。** SPL Transfer / TransferChecked /
//     Token-2022 / CPI 経由 / 複数命令——命令の形は何通りもあるが、
//     「誰の USDC がいくら増えたか」は meta.pre/postTokenBalances の
//     owner 付き差分に必ず現れる。決済の実体はそこにある。
//   - **finalized を要求する。** 照合は日次 cron が購入の何時間も後に走るので
//     finalized はタダで買える。未確定を「確認済み」と恒久記録しない。
//   - **測っていないものを「偽物」と言わない。** RPC が答えない・残高に owner が
//     無くて帰属できない・まだ finalized でない——これらは売り手についての所見
//     ではないので一時的な理由で返し、台帳の status を倒さない
//     （settlement-verifier.ts の TRANSIENT_REASONS）。
//   - **公開 RPC へ無言で倒れない。** SOLANA_RPC_URL 未設定は rpc_unavailable。
//     2026-09-02 の是正（index-solana.ts / l1-runner.ts）と同じ fail-loud。
// ============================================================
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { SOLANA_USDC_MINT } from "./sol402-payer";
import type { SettlementVerifyResult } from "./settlement-verify";

/** CAIP-2 の solana 名前空間は genesis hash の **先頭 32 文字**を参照に使う。 */
const CAIP2_SOLANA_REFERENCE_LENGTH = 32;

/** SPL Memo v2（sol402-payer.ts が使うのと同じ program id）。 */
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type SolanaTokenBalance = {
  accountIndex: number;
  mint: string;
  /** 所有ウォレット。ATA ではなくこちらが期待値（pay_to / payer）と同じ主語。 */
  owner?: string | null;
  uiTokenAmount: { amount: string; decimals?: number };
};

export type SolanaTransactionMeta = {
  err: unknown | null;
  preTokenBalances?: readonly SolanaTokenBalance[] | null;
  postTokenBalances?: readonly SolanaTokenBalance[] | null;
};

export type SolanaVerifyTransaction = {
  slot: number;
  blockTime?: number | null;
  meta: SolanaTransactionMeta | null;
  /**
   * その tx に含まれる Memo 命令のデータ（UTF-8）。
   * `null` / `undefined` は「読めなかった」で、空配列（memo が 1 つも無い）とは
   * 別物——読めなかったことを売り手の罪にしないため区別する（2026-09-04 P1-1）。
   */
  memos?: readonly string[] | null;
  /**
   * SPL トークン転送の命令単位の内訳（2026-09-04 監査 P2）。
   * 残高差分は「正味」しか語れないので、payee が同じ tx で受け取り分を
   * 送り出すと受領額が過小に見える。命令が読めるときはそちらを優先する。
   * `destinationIndex` は accountKeys 上の位置（残高行の accountIndex と同じ空間）。
   * `mint` は transferChecked のときだけ分かる（plain transfer は null）。
   */
  tokenTransfers?: readonly { destinationIndex: number; mint: string | null; amount: string }[] | null;
};

export type SolanaSignatureStatusValue = {
  err: unknown | null;
  confirmationStatus?: string | null;
  slot: number;
};

/**
 * 照合が使う RPC の面（テストでは偽物を注入する）。
 * index-solana.ts の SolanaRpc とは要るメソッドが違うので分けてある。
 */
export type SolanaVerifyRpc = {
  getGenesisHash(): Promise<string>;
  /** 確定性は getTransaction では分からない。署名ステータスで別に読む。 */
  getSignatureStatus(signature: string): Promise<{
    contextSlot: number;
    value: SolanaSignatureStatusValue | null;
  }>;
  getTransaction(
    signature: string,
    opts: { maxSupportedTransactionVersion: 0 },
  ): Promise<SolanaVerifyTransaction | null>;
};

/**
 * ある owner の USDC 残高が、この tx で正味いくら動いたか（純関数）。
 *
 * `attributable: false` は「owner の付いた mint の行が 1 つも無い＝帰属できない」。
 * 差分 0 と区別する——区別しないと、古い RPC の応答で全員を payee_mismatch と
 * 告発することになる。
 */
export function usdcOwnerDelta(
  pre: readonly SolanaTokenBalance[],
  post: readonly SolanaTokenBalance[],
  owner: string,
  mint: string,
): {
  delta: bigint;
  received: bigint;
  sent: bigint;
  attributable: boolean;
  /** この owner がこの mint で持っていた（or 持つことになった）口座の accountIndex。 */
  accountIndexes: ReadonlySet<number>;
} {
  const ofMint = (arr: readonly SolanaTokenBalance[]) => arr.filter((b) => b.mint === mint);
  const preOfMint = ofMint(pre);
  const postOfMint = ofMint(post);
  // 「この mint の行が 1 つも無い」は読めた上での事実（USDC は動いていない）。
  // 「行はあるのに owner が 1 つも無い」だけが帰属不能。
  const hasOwner = (b: SolanaTokenBalance) => typeof b.owner === "string" && b.owner.length > 0;
  const attributable =
    (preOfMint.length === 0 && postOfMint.length === 0) ||
    preOfMint.some(hasOwner) ||
    postOfMint.some(hasOwner);

  const amountOf = (arr: readonly SolanaTokenBalance[], accountIndex: number): bigint => {
    const row = arr.find((b) => b.accountIndex === accountIndex);
    if (!row) return 0n;
    try {
      return BigInt(row.uiTokenAmount.amount);
    } catch {
      return 0n;
    }
  };

  // owner はトークン口座ごとに付く。1 つの owner が同じ mint の口座を複数持つ
  // ことがある（ATA + 旧口座）ので、口座ごとの差分を合算する。
  const indexes = new Set<number>();
  for (const b of [...preOfMint, ...postOfMint]) {
    if (b.owner === owner) indexes.add(b.accountIndex);
  }
  //
  // 2026-09-04 監査 P2: **正味（delta）と受領（received）を分けて返す。**
  // 正味だけで判定していたので、payee が同じ tx の中で受け取った USDC を
  // 別口座へ流すと（ファシリテータの束ね決済・自動スイープでは普通に起こる）
  // 正味が期待額を下回り、正しく払われた売り手を amount_mismatch と告発していた。
  // 命令列を parse せずに「その owner がこの tx でいくら受け取ったか」を近似する
  // 最良の読み方が、口座ごとの正の差分の合計。
  let delta = 0n;
  let received = 0n;
  let sent = 0n;
  for (const idx of indexes) {
    const d = amountOf(postOfMint, idx) - amountOf(preOfMint, idx);
    delta += d;
    if (d > 0n) received += d;
    else sent += -d;
  }
  return { delta, received, sent, attributable, accountIndexes: indexes };
}

/** 本番の RPC 面（@solana/web3.js）。SOLANA_RPC_URL 未設定なら null。 */
export async function createSolanaVerifyRpc(): Promise<SolanaVerifyRpc | null> {
  const url = process.env.SOLANA_RPC_URL?.trim();
  if (!url) return null;
  const { Connection } = await import("@solana/web3.js");
  const conn = new Connection(url, "finalized");
  return {
    getGenesisHash: () => conn.getGenesisHash(),
    getSignatureStatus: async (signature) => {
      const res = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      return {
        contextSlot: res.context.slot,
        value: res.value
          ? {
              err: res.value.err,
              confirmationStatus: res.value.confirmationStatus ?? null,
              slot: res.value.slot,
            }
          : null,
      };
    },
    getTransaction: async (signature, opts) => {
      // 2026-09-04: getParsedTransaction に替えた。残高差分だけでは
      //  (a) 我々の memo が入っているか、
      //  (b) payee が「いくら受け取ったか」（正味ではなく）
      // のどちらも読めない。どちらも金の経路の判定材料なので、命令を読む。
      const tx = await conn.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: opts.maxSupportedTransactionVersion,
        commitment: "finalized",
      });
      if (!tx) return null;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const indexOf = (address: string) => keys.indexOf(address);
      const memos: string[] = [];
      const tokenTransfers: { destinationIndex: number; mint: string | null; amount: string }[] = [];
      const walk = (instructions: readonly unknown[]) => {
        for (const raw of instructions) {
          const ix = raw as {
            program?: string;
            programId?: { toBase58(): string };
            parsed?: unknown;
          };
          const programId = ix.programId?.toBase58?.() ?? "";
          if (ix.program === "spl-memo" || programId === MEMO_PROGRAM_ID) {
            if (typeof ix.parsed === "string") memos.push(ix.parsed);
            continue;
          }
          const parsed = ix.parsed as
            | { type?: string; info?: Record<string, unknown> }
            | undefined;
          if (!parsed?.info) continue;
          if (parsed.type !== "transfer" && parsed.type !== "transferChecked") continue;
          const destination = parsed.info.destination;
          if (typeof destination !== "string") continue;
          const destinationIndex = indexOf(destination);
          if (destinationIndex < 0) continue;
          const amount =
            typeof parsed.info.amount === "string"
              ? parsed.info.amount
              : typeof (parsed.info.tokenAmount as { amount?: unknown } | undefined)?.amount === "string"
                ? ((parsed.info.tokenAmount as { amount: string }).amount)
                : null;
          if (amount === null) continue;
          tokenTransfers.push({
            destinationIndex,
            mint: typeof parsed.info.mint === "string" ? parsed.info.mint : null,
            amount,
          });
        }
      };
      walk(tx.transaction.message.instructions);
      for (const inner of tx.meta?.innerInstructions ?? []) walk(inner.instructions);
      return {
        slot: tx.slot,
        blockTime: tx.blockTime,
        meta: tx.meta
          ? {
              err: tx.meta.err,
              preTokenBalances: tx.meta.preTokenBalances as readonly SolanaTokenBalance[] | null | undefined,
              postTokenBalances: tx.meta.postTokenBalances as readonly SolanaTokenBalance[] | null | undefined,
            }
          : null,
        memos,
        tokenTransfers,
      };
    },
  };
}

const maxOf = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * 命令単位の USDC 受領（2026-09-04 監査 P2）。
 * 宛先が対象 owner のトークン口座である転送だけを合計する。mint が読めない
 * plain transfer は、宛先口座が既に「その mint の owner の口座」と分かっている
 * ので採る（accountIndexes は mint で絞った集合）。
 */
function usdcReceivedFromInstructions(
  transfers: SolanaVerifyTransaction["tokenTransfers"],
  accountIndexes: ReadonlySet<number>,
): bigint {
  if (!transfers) return 0n;
  let total = 0n;
  for (const t of transfers) {
    if (!accountIndexes.has(t.destinationIndex)) continue;
    if (t.mint !== null && t.mint !== SOLANA_USDC_MINT) continue;
    try {
      total += BigInt(t.amount);
    } catch {
      /* 読めない金額は数えない（推測で足さない） */
    }
  }
  return total;
}

const unavailable = (detail: string): SettlementVerifyResult => ({
  ok: false,
  reason: "rpc_unavailable",
  detail: detail.slice(0, 200),
});

/**
 * 1 件の Solana 決済主張をチェーンで確かめる。
 *
 * 期待値（payTo / amount / payer）は**我々が署名したときの値**を渡すこと。
 * 売り手が返した値を渡してはいけない——それでは自己申告の照合にしかならない。
 */
export async function verifySolanaSettlement(
  input: {
    txHash: string;
    network: string;
    expectedPayTo: string;
    expectedPayer: string;
    expectedAmountUnits: string;
    /** 我々が生成した memo（x402_l1_purchases.auth_nonce）。旧行は null。 */
    expectedAuthNonce?: string | null;
  },
  deps?: { rpc?: SolanaVerifyRpc },
): Promise<SettlementVerifyResult> {
  const { txHash, network, expectedPayTo, expectedPayer, expectedAmountUnits } = input;

  // 1. 形。RPC を叩く前に落とす。
  if (!isWellFormedSettlementTx(txHash, "solana")) {
    return { ok: false, reason: "malformed_tx" };
  }
  const signature = txHash.trim();

  let expectedUnits: bigint;
  try {
    expectedUnits = BigInt(expectedAmountUnits);
  } catch {
    return { ok: false, reason: "amount_mismatch", detail: "unparseable expected amount" };
  }
  if (expectedUnits <= 0n) {
    return { ok: false, reason: "amount_mismatch", detail: "non-positive expected amount" };
  }

  // network が CAIP-2 の solana でなければ、ここは呼ばれるべきではない。
  const reference = network.startsWith("solana:") ? network.slice("solana:".length) : "";
  if (reference.length < CAIP2_SOLANA_REFERENCE_LENGTH) {
    return { ok: false, reason: "wrong_chain", detail: `unusable network id: ${network}`.slice(0, 200) };
  }

  // 2. RPC。未設定なら公開 RPC へ黙って倒れない（fail-loud）。
  const rpc = deps?.rpc ?? (await createSolanaVerifyRpc());
  if (!rpc) {
    return unavailable("SOLANA_RPC_URL is not set; refusing to fall back to a public RPC");
  }

  // 3. いま読んでいるのは本当にそのクラスタか。
  let genesis: string;
  try {
    genesis = await rpc.getGenesisHash();
  } catch (error) {
    return unavailable(String(error));
  }
  if (!genesis.startsWith(reference)) {
    return {
      ok: false,
      reason: "wrong_chain",
      detail: `rpc genesis ${genesis} does not match ${network}`.slice(0, 200),
    };
  }

  // 4. 確定性。finalized 以外は「まだ見えていない」——否定ではない。
  let status: Awaited<ReturnType<SolanaVerifyRpc["getSignatureStatus"]>>;
  try {
    status = await rpc.getSignatureStatus(signature);
  } catch (error) {
    return unavailable(String(error));
  }
  if (!status.value) {
    return { ok: false, reason: "tx_not_found" };
  }
  if (status.value.err !== null && status.value.err !== undefined) {
    return { ok: false, reason: "tx_reverted", detail: JSON.stringify(status.value.err).slice(0, 200) };
  }
  if (status.value.confirmationStatus !== "finalized") {
    return {
      ok: false,
      reason: "not_final",
      detail: `confirmationStatus=${status.value.confirmationStatus ?? "unknown"}`,
    };
  }

  // 5. トランザクション本体。
  let tx: SolanaVerifyTransaction | null;
  try {
    tx = await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  } catch (error) {
    return unavailable(String(error));
  }
  if (!tx) {
    return { ok: false, reason: "tx_not_found" };
  }
  if (!tx.meta) {
    return unavailable("transaction returned without meta; balances not readable");
  }
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    return { ok: false, reason: "tx_reverted", detail: JSON.stringify(tx.meta.err).slice(0, 200) };
  }

  // 6. 宛先・金額・支払元を残高差分で読む。
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const payee = usdcOwnerDelta(pre, post, expectedPayTo, SOLANA_USDC_MINT);
  const payer = usdcOwnerDelta(pre, post, expectedPayer, SOLANA_USDC_MINT);
  if (!payee.attributable || !payer.attributable) {
    // owner の無い残高しか無い＝誰の口座か言えない。0 と読んで告発しない。
    return unavailable("token balances carry no owner attribution");
  }

  // 2026-09-04 監査 P2: 判定は**正味差分ではなく受領額**で行う。
  // payee が同じ tx の中で受け取った USDC を別口座へ流すと（ファシリテータの
  // 束ね決済・自動スイープでは普通に起こる）正味は期待額を下回り、正しく
  // 払われた売り手を amount_mismatch と告発することになる。
  // 命令が読めるならそれが一番正確なので優先し、読めなければ残高の正の差分
  // （複数口座を持つ owner の相殺は解ける）で近似する。
  const payeeReceived = maxOf(
    payee.received,
    usdcReceivedFromInstructions(tx.tokenTransfers, payee.accountIndexes),
  );
  const payerSent = maxOf(payer.sent, 0n);

  if (payeeReceived <= 0n) {
    return {
      ok: false,
      reason: "payee_mismatch",
      detail: `${expectedPayTo} received no USDC in ${signature}`.slice(0, 200),
    };
  }
  if (payeeReceived < expectedUnits) {
    return {
      ok: false,
      reason: "amount_mismatch",
      detail: `${expectedPayTo} received ${payeeReceived} < expected ${expectedUnits}`.slice(0, 200),
    };
  }
  if (payerSent < expectedUnits) {
    return {
      ok: false,
      reason: "payer_mismatch",
      detail: `${expectedPayer} sent ${payerSent}, expected at least ${expectedUnits}`.slice(0, 200),
    };
  }

  // 8. **その tx はこの購入のものか**（2026-09-04 監査 P1-1）。
  //
  // 7 まででわかるのは「payer が払い、payee が期待額を受け取った tx がある」
  // までで、同じ payTo・同じ価格の別の購入でも成り立つ。EVM は EIP-3009 の
  // nonce がその役を果たす。Solana では**我々が生成した memo**——以前は
  // 売り手の extra.memo をそのまま使っていたので、売り手が全購入に同じ memo を
  // 指定すれば 1 本の tx を使い回せた（sol402-payer.ts で自前乱数に固定した）。
  const expectedMemo = input.expectedAuthNonce?.trim();
  if (expectedMemo) {
    if (tx.memos === null || tx.memos === undefined) {
      // 読めなかっただけ。売り手の罪にしない（TRANSIENT）。
      return unavailable("memo instructions not readable from this RPC response");
    }
    if (!tx.memos.some((m) => m === expectedMemo)) {
      return {
        ok: false,
        reason: "nonce_not_used",
        detail: `memo ${expectedMemo} is not in ${signature}`.slice(0, 200),
      };
    }
  }

  // slot 距離。EVM の「確定数」と同じ意味ではない（Solana の確定は finalized の
  // 有無で決まる）が、「どれだけ前の slot か」は同じ用途で読める数字なので返す。
  const slotDistance = BigInt(Math.max(status.contextSlot - tx.slot, 0));
  return {
    ok: true,
    blockTimestamp: typeof tx.blockTime === "number" ? new Date(tx.blockTime * 1000) : null,
    // finalized は確定そのもの。0 を返すと「未確定」に見えるので最低 1 を返す。
    confirmations: slotDistance > 0n ? slotDistance : 1n,
    blockNumber: BigInt(tx.slot),
  };
}

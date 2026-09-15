/**
 * x402 `exact` on Solana (SVM) — build the payment transaction, have the caller's signer sign it,
 * and **re-send the original request to the seller**. (English header for judges. The Japanese
 * block below is the same content in our working language.)
 *
 * Ported from production `src/lib/observatory/sol402-payer.ts` (`buildSolanaPaymentTransaction` /
 * `encodeSolanaPaymentHeader`), which vet402's Solana L1 has paid real sellers with. Spec:
 * coinbase/x402 `specs/schemes/exact/scheme_exact_svm.md` — instructions SetComputeUnitLimit →
 * SetComputeUnitPrice (≤ 5 microlamports/CU) → SPL TransferChecked → Memo; the fee payer is the
 * facilitator named in `extra.feePayer` and appears in no instruction's accounts.
 *
 * **Like `./x402-pay.js`, this file is dynamically imported only from the ALLOW branch of
 * `payOrRefuse`**, and it loads `@solana/web3.js` with a dynamic import through a variable
 * specifier. On a refuse neither is ever evaluated, so an EVM-only user never needs web3.js
 * installed, and a Solana BLOCK cannot reach `signTransaction`
 * (`test/no-static-payment-import.test.mjs` walks dist's static graph and poisons this module).
 *
 * Checks made here, before the signer is touched, because only here is web3.js loaded:
 * payTo is an on-curve public key (an ATA or PDA as payTo would send USDC to an account nobody
 * can spend from), and the fee payer is not the signer (the signer would be paying SOL fees it
 * never agreed to, and the spec forbids the fee payer in instruction accounts). After signing, the
 * transaction that will be sent is re-parsed; if its message is not byte-identical to the one built
 * here, nothing is sent.
 */
/**
 * Solana（SVM）の x402 `exact`——取引を組み、呼び手の署名者に署名させ、**元のリクエストを売り手へ再送する**。
 *
 * 本番 `src/lib/observatory/sol402-payer.ts`（buildSolanaPaymentTransaction / encodeSolanaPaymentHeader）の移植。
 * 本番の Solana L1 はこの形で実際に売り手へ払っている。
 *
 * **`./x402-pay.js` と同じく、`payOrRefuse` の ALLOW ブランチからしか動的 import されない。**
 * `@solana/web3.js` も変数指定子の動的 import で読む。拒否経路ではどちらも評価されないので、
 * EVM だけの利用者は web3.js を入れなくてよく、Solana の BLOCK は `signTransaction` に到達できない。
 *
 * 署名者に触る前にここで見るもの（web3.js を読むのがここだけなので、ここでしか見られない）:
 * payTo が曲線上の公開鍵であること（ATA や PDA を payTo にされると誰も使えない口座へ USDC が行く）、
 * feePayer が署名者と違うこと（署名者が同意していない SOL 手数料を払う形になり、spec も
 * feePayer を命令の accounts に置くことを禁じている）。署名後は、送る取引を読み直し、
 * message がここで組んだものとバイト単位で一致しなければ送らない。
 */
import type * as Web3 from "@solana/web3.js";
import type { PayRefuseReason, SvmPayerAccount, SvmTransactionLike } from "./pay-or-refuse.js";
import { createSplTokenLite, type SolanaWeb3 } from "./spl-token-lite.js";
import { parseSettlementResponse, type X402Accept, type X402Settlement } from "./x402-pay.js";

/** USDC on Solana has 6 decimals — the same base units as Base USDC. */
const USDC_DECIMALS = 6;
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Production values (`sol402-payer.ts`): 60k CU, and 1 microlamport/CU — inside the spec's ≤ 5. */
export const SVM_COMPUTE_UNIT_LIMIT = 60_000;
export const SVM_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * web3.js を読む。**変数指定子**にしてあるのは、tsc / バンドラが静的依存として辿らないため
 * （MCP サーバが viem を読むのと同じ手）。入っていなければ署名の前に、原因を名指しで throw する。
 */
export async function loadSolanaWeb3(): Promise<SolanaWeb3> {
  const specifier = "@solana/web3.js";
  try {
    return (await import(specifier)) as SolanaWeb3;
  } catch (error) {
    throw new Error(
      "invalid_svm_setup: paying a Solana payee needs @solana/web3.js installed next to @vet402/sdk " +
        `(npm install @solana/web3.js). ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 32 hex = 16 バイト（spec の「ランダム nonce ≥ 16 bytes」）。**売り手の extra.memo は使わない**（本番 2026-09-04 監査 P1-1）。 */
export function randomMemo(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 組む前の検査。**署名者に触らない**（`account.address` は呼び手が渡した文字列）。
 * 読めない・曲線外・feePayer が署名者と同じ → 拒否理由。payer アドレスが読めないのは呼び出し側の誤りなので throw。
 */
export function preflightSvmAccept(
  web3: SolanaWeb3,
  accept: X402Accept,
  payerAddress: string,
): { refused: PayRefuseReason; detail: string } | null {
  if (typeof payerAddress !== "string" || !BASE58_RE.test(payerAddress)) {
    throw new Error(`invalid_payer: svm.account.address must be a base58 Solana address, got ${JSON.stringify(payerAddress)}`);
  }
  try {
    new web3.PublicKey(payerAddress);
  } catch {
    throw new Error(`invalid_payer: svm.account.address is not a Solana public key: ${JSON.stringify(payerAddress)}`);
  }
  const feePayer = accept.extra?.feePayer;
  if (typeof feePayer !== "string") return { refused: "chain_or_asset_mismatch", detail: "no extra.feePayer" };
  try {
    const payTo = new web3.PublicKey(accept.payTo);
    if (!web3.PublicKey.isOnCurve(payTo.toBytes())) {
      return { refused: "chain_or_asset_mismatch", detail: "payTo is off-curve (an ATA or PDA, not a wallet)" };
    }
    new web3.PublicKey(feePayer);
    new web3.PublicKey(accept.asset);
  } catch {
    return { refused: "chain_or_asset_mismatch", detail: "payTo, feePayer or asset is not a Solana public key" };
  }
  if (feePayer === payerAddress) {
    return { refused: "chain_or_asset_mismatch", detail: "extra.feePayer is the signer itself" };
  }
  return null;
}

/**
 * 部分署名前の versioned tx を組む（純関数——blockhash と memo は呼び手が渡す）。
 * 命令は spec の 4 つ、宛先は ATA(payTo, mint)、feePayer は extra.feePayer。
 */
export function buildSvmPaymentTransaction(
  web3: SolanaWeb3,
  input: { accept: X402Accept; payerAddress: string; recentBlockhash: string; memo: string },
): { transaction: Web3.VersionedTransaction; messageBytes: Uint8Array } {
  const { accept, payerAddress, recentBlockhash, memo } = input;
  const feePayer = accept.extra?.feePayer;
  if (typeof feePayer !== "string") throw new Error("svm-pay: accept has no extra.feePayer");
  const spl = createSplTokenLite(web3);
  const mint = new web3.PublicKey(accept.asset);
  const payTo = new web3.PublicKey(accept.payTo);
  const payer = new web3.PublicKey(payerAddress);
  const amount = BigInt(accept.amount);

  const sourceAta = spl.getAssociatedTokenAddressSync(mint, payer);
  const destAta = spl.getAssociatedTokenAddressSync(mint, payTo);

  const instructions: Web3.TransactionInstruction[] = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: SVM_COMPUTE_UNIT_LIMIT }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SVM_COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
    spl.createTransferCheckedInstruction(sourceAta, mint, destAta, payer, amount, USDC_DECIMALS),
    new web3.TransactionInstruction({
      programId: new web3.PublicKey(MEMO_PROGRAM_ADDRESS),
      keys: [],
      data: new TextEncoder().encode(memo) as Web3.TransactionInstructionCtorFields["data"],
    }),
  ];

  const message = new web3.TransactionMessage({
    payerKey: new web3.PublicKey(feePayer),
    recentBlockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new web3.VersionedTransaction(message);
  return { transaction, messageBytes: message.serialize() };
}

/** v2 envelope（EVM 側 encodePaymentHeader と同形・payload だけ transaction）。 */
export function encodeSvmPaymentHeader(input: {
  accept: X402Accept;
  transactionB64: string;
  resourceUrl: string;
}): { headerName: string; headerValue: string } {
  const { accept, transactionB64, resourceUrl } = input;
  const body = {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepted: {
      scheme: accept.scheme,
      network: accept.network,
      amount: accept.amount,
      asset: accept.asset,
      payTo: accept.payTo,
      ...(accept.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: accept.maxTimeoutSeconds } : {}),
      ...(accept.extra !== undefined ? { extra: accept.extra } : {}),
    },
    payload: { transaction: transactionB64 },
  };
  return { headerName: "PAYMENT-SIGNATURE", headerValue: toBase64(new TextEncoder().encode(JSON.stringify(body))) };
}

/** `getLatestBlockhash` を 1 回だけ JSON-RPC で引く。**注入された fetch で**（呼び手が通信を数えられるように）。 */
export async function fetchLatestBlockhash(fetchFn: typeof fetch, rpcUrl: string): Promise<string> {
  const response = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
  });
  const body = (await response.json()) as { result?: { value?: { blockhash?: unknown } } } | null;
  const blockhash = body?.result?.value?.blockhash;
  if (!response.ok || typeof blockhash !== "string" || !BASE58_RE.test(blockhash)) {
    throw new Error(`svm_rpc_unavailable: getLatestBlockhash did not return a blockhash (HTTP ${response.status})`);
  }
  return blockhash;
}

export type SvmPayResult =
  | { refused: PayRefuseReason; detail: string }
  | {
      refused: null;
      /** 署名者が値を返した。送らなかった（message 不一致）ときも true——隠さない。 */
      signed: true;
      /** 売り手へ再送したか。message が組んだものと違えば false。 */
      sent: boolean;
      settled: boolean;
      /** PAYMENT-RESPONSE の `transaction`（Solana の base58 署名）。 */
      txHash: string | null;
      /** 取引の Memo 命令に載せた、我々だけが作れる値。EVM の nonce と同じ役割。 */
      memo: string;
      /** 送った署名済み取引の base64。送らなかったときは null。 */
      transactionB64: string | null;
      settlement: X402Settlement | null;
      responseStatus: number | null;
    };

/**
 * 組んで、署名させて、売り手へ再送する。判定はしない——ここへ来た時点で通っている、が
 * `payOrRefuse` との契約。`onSigned` は署名者が返した直後に同期で呼ぶ（ここから先で落ちても memo が残る）。
 */
export async function executeSvmPayment(args: {
  account: SvmPayerAccount;
  rpcUrl: string;
  accept: X402Accept;
  resource: string;
  method: string;
  fetch: typeof fetch;
  onSigned?: (info: { memo: string }) => void;
}): Promise<SvmPayResult> {
  const { account, accept } = args;
  const web3 = await loadSolanaWeb3();
  const payerAddress = account.address;
  const refusal = preflightSvmAccept(web3, accept, payerAddress);
  if (refusal) return refusal;

  const recentBlockhash = await fetchLatestBlockhash(args.fetch, args.rpcUrl);
  const memo = randomMemo();
  const { transaction, messageBytes } = buildSvmPaymentTransaction(web3, { accept, payerAddress, recentBlockhash, memo });

  // ここが「署名が存在する」唯一の行。プロパティ参照は 1 回だけに保つ（テストの Proxy は参照を数える）。
  const returned: SvmTransactionLike = await account.signTransaction(transaction);
  args.onSigned?.({ memo });

  const notSent = {
    refused: null,
    signed: true as const,
    sent: false,
    settled: false,
    txHash: null,
    memo,
    transactionB64: null,
    settlement: null,
    responseStatus: null,
  };

  // 送るのは `returned.serialize()` のバイト列。**そのバイト列を読み直して** message を比べる——
  // `returned.message` だけを見ると、message は元のまま serialize だけ別物を返す値を通してしまう。
  let wire: Uint8Array;
  try {
    wire = returned.serialize();
    const reparsed = web3.VersionedTransaction.deserialize(wire);
    if (!sameBytes(reparsed.message.serialize(), messageBytes)) return notSent;
  } catch {
    return notSent;
  }

  const transactionB64 = toBase64(wire);
  const header = encodeSvmPaymentHeader({ accept, transactionB64, resourceUrl: args.resource });
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await args.fetch(args.resource, {
      method: args.method,
      headers: {
        accept: "application/json",
        [header.headerName]: header.headerValue,
        ...(args.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(args.method === "POST" ? { body: "{}" } : {}),
    });
  } catch {
    return { ...notSent, sent: true, transactionB64 };
  }
  const settlement = parseSettlementResponse(response.headers);
  return {
    refused: null,
    signed: true,
    sent: true,
    settled: settlement?.success === true,
    txHash: settlement?.transaction ?? null,
    memo,
    transactionB64,
    settlement,
    responseStatus: typeof response.status === "number" ? response.status : null,
  };
}

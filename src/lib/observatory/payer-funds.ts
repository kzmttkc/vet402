// ============================================================
// 購入元ウォレットの USDC 残高の関門（Issue #29 の C・2026-09-17）。
//
// 何が起きたか: 2026-09-13〜15 に Base の購入元ウォレット
// （0xc9c7b38C0942914fC8EA12063BC92dcd3b581670）の USDC が尽きた（9/16 実測残高
// 0.000275 USDC）。その間も L1 は署名を続け、売り手は我々の支払いを 402 で断り、
// 台帳には `settle_failed`・402・tx なしが 972 行（965 エンドポイント）書かれた。
// **我々の資金切れを、売り手の失敗として記録した。**
//
// 守ること:
//   - 支払い付きリクエストに署名する**前**に、そのチェーンの購入元の USDC 残高が
//     今回の額に足りるかを見る。足りなければ署名しない。
//   - 残高を読めなければ**署名しない側**へ倒す（読めない＝足りると仮定しない）。
//   - RPC 呼び出しは 1 バッチでチェーンごとに 1 回（結果も失敗もキャッシュする）。
//     このバッチで既に署名した額を差し引いて比べる（決済が非同期でも過大に見積もらない）。
//   - 台帳には行を書かない（l1-runner 側）。行を書くと、その売り手はスイープ窓の
//     あいだ再選択されず、初回購入の枠と「未購入を先に」の並びも狂い、facts の
//     last_attempt_at に我々の資金切れが売り手の時刻として出る。chain_daily_cap と
//     同じ作法で、翌バッチにまた候補になる。資金切れはバッチの summary と
//     サーバログ（observatory.l1.payer_unfunded）に出す。
//   - チェーンごとに別の残高（2026-09-17 Arc レーン）。Arc は Base と同じ EOA だが、
//     Arc の USDC は Base の USDC ではない。同じ鍵でも残高は chain で分けて読む。
// ============================================================
import { SOLANA_USDC_MINT } from "./sol402-payer";
import { ARC_USDC, BASE_USDC } from "./x402-payer";
import { getArcPublicClient } from "@/lib/chain/arc";

export type PayerChain = "base" | "solana" | "arc";

/** 購入元（owner）の USDC 残高を基本単位（6 桁）で返す。読めなければ throw する。 */
export type PayerUsdcBalanceReader = (input: { chain: PayerChain; owner: string }) => Promise<bigint>;

export type FundsVerdict =
  | { ok: true }
  | { ok: false; reason: "insufficient"; balanceUnits: string; committedUnits: string }
  | { ok: false; reason: "unreadable"; error: string };

type ChainState = { read: Promise<{ balance: bigint } | { error: string }>; committed: bigint };

/**
 * 記録用の誤り文字列（2026-09-17 レビュー）。viem の transport エラーは RPC の URL を
 * 本文に含み、URL には鍵が入る形（…/v2/<key>）がある。summary・ログ・台帳のどこにも
 * URL を落とさないよう、`https?://…` を伏字にしてから 300 字に切る。
 */
export function redactForLog(error: unknown): string {
  return String(error).replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
}

/**
 * 1 バッチぶんの残高台帳。`check` は署名の前、`commit` は署名の直前に呼ぶ。
 */
export function createPayerFunds(reader: PayerUsdcBalanceReader) {
  const chains = new Map<PayerChain, ChainState>();
  const stateFor = (chain: PayerChain, owner: string): ChainState => {
    let s = chains.get(chain);
    if (!s) {
      s = {
        read: reader({ chain, owner }).then(
          (balance) => (typeof balance === "bigint" && balance >= 0n ? { balance } : { error: `invalid balance: ${String(balance)}` }),
          (error: unknown) => ({ error: redactForLog(error) }),
        ),
        committed: 0n,
      };
      chains.set(chain, s);
    }
    return s;
  };
  return {
    async check(chain: PayerChain, owner: string, amount: bigint): Promise<FundsVerdict> {
      const s = stateFor(chain, owner);
      const r = await s.read;
      if ("error" in r) return { ok: false, reason: "unreadable", error: r.error };
      if (r.balance - s.committed < amount) {
        return { ok: false, reason: "insufficient", balanceUnits: String(r.balance), committedUnits: String(s.committed) };
      }
      return { ok: true };
    },
    commit(chain: PayerChain, owner: string, amount: bigint): void {
      stateFor(chain, owner).committed += amount;
    },
  };
}

export type PayerFunds = ReturnType<typeof createPayerFunds>;

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * 本番の読み手。Base は BASE_RPC_URL、Solana は SOLANA_RPC_URL。未設定は throw（公開 RPC へ無言で倒れない）。
 * Arc は ARC_RPC_URL、未設定なら公開 RPC https://rpc.mainnet.arc.io（オーナー指定 2026-09-17・chain/arc.ts）。
 * どのチェーンも、読めなければ throw → 呼び手は署名しない側へ倒す。
 */
export const defaultPayerUsdcBalance: PayerUsdcBalanceReader = async ({ chain, owner }) => {
  if (chain === "arc") {
    const client = getArcPublicClient("live");
    return await client.readContract({
      address: ARC_USDC as `0x${string}`,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [owner as `0x${string}`],
    });
  }
  if (chain === "base") {
    const rpc = process.env.BASE_RPC_URL?.trim();
    if (!rpc) throw new Error("base_rpc_unset: BASE_RPC_URL is required to read the payer's USDC balance");
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    const client = createPublicClient({ chain: base, transport: http(rpc, { timeout: 5_000, retryCount: 1 }) });
    return await client.readContract({
      address: BASE_USDC as `0x${string}`,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [owner as `0x${string}`],
    });
  }
  const rpc = process.env.SOLANA_RPC_URL?.trim();
  if (!rpc) throw new Error("solana_rpc_unset: SOLANA_RPC_URL is required to read the payer's USDC balance");
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { getAssociatedTokenAddressSync } = await import("./spl-token-lite");
  const conn = new Connection(rpc, "confirmed");
  const ata = getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC_MINT), new PublicKey(owner));
  const { value } = await conn.getTokenAccountBalance(ata, "confirmed");
  return BigInt(value.amount);
};

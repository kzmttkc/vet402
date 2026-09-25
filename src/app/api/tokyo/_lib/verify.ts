// ============================================================
// /tokyo の読み取り（ページと /api/tokyo/verify が使う）。署名器も鍵も無い。
// 7段そのものは check.ts。ここは名前の形の関門と、名前ごとの使い回し（cache.ts の verifyCache）と、鍵の狭さの表示。
// 使い回しの鍵は SDK の正規化（normalize）後の名前。結果は block と読んだ時刻を持つので、使い回しても
// 「block N で読んだ」事実のまま。押した直後の表示は使い回しを通らない（mutate / reset の応答の check）。
// ============================================================
import { createPublicClient, decodeErrorResult, encodeFunctionData, http, keccak256, parseAbi, toBytes, type BaseError } from "viem";
import { sepolia } from "viem/chains";
import { ATTESTATION_KEY, KEY, NODE, P_D, VERIFY_CACHE_MS, W_OP } from "./constants";
import { TtlCache, verifyCache, verifyKey } from "./cache";
import { readCheck, type VerifyError, type VerifyView } from "./check";
import { readVerifyRpcUrls } from "./rpc-env";

export { STEP_NAMES, type TraceStep, type VerifyError, type VerifyView } from "./check";

const MAX_NAME = 255;

/** 名前の形だけを先に見る（正規化は SDK の checkEnsOffer がする。正規化できなければ段1の ens_name_unresolved）。 */
export function cleanName(input: string | null | undefined): string | null {
  const n = String(input ?? "").trim();
  if (!n || n.length > MAX_NAME || /[\s/\\?#]/.test(n)) return null;
  return n;
}

/**
 * ENSIP-29 草案の7段を今の Sepolia で走らせる。RPC が落ちたときも SDK は投げず ens_evidence_unavailable を返す。
 * 名前の形（長さ 255 まで）は正規化より前に cleanName で切る。形の悪い名前は RPC を読まないので使い回さない。
 */
export async function verifyName(input: string): Promise<VerifyView | VerifyError> {
  const name = cleanName(input);
  if (!name) return { name: String(input ?? "").slice(0, 64), error: "invalid_name", message: "Enter an ENS name such as seller-a.eth." };
  // 正規化できない名前は SDK が RPC を読まずに段1で返すので、使い回さずにそのまま走らせる。
  const key = verifyKey(name);
  if (key === null) return readCheck(name);
  return verifyCache.get(key, () => readCheck(name)) as Promise<VerifyView | VerifyError>;
}

export type KeyScope = {
  operator: string;
  resolver: string;
  roleBitmap: string | null;
  attestationWrite: string | null;
};

const EAC_ABI = parseAbi([
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function setText(bytes name, string key, string value)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
]);

const scopeCache = new TtlCache<KeyScope>(VERIFY_CACHE_MS, 1);

/**
 * 鍵を隠す代わりに、鍵の狭さをチェーンから示す: P_d で W_op が持つロールと、
 * W_op が証明のキーを書こうとしたときの eth_call の結果（送らない。読むだけ）。
 * ページを開くたびに読まないよう、VERIFY_CACHE_MS だけ使い回す。
 */
export function readKeyScope(): Promise<KeyScope> {
  return scopeCache.get("scope", readKeyScopeLive);
}

async function readKeyScopeLive(): Promise<KeyScope> {
  const c = createPublicClient({ chain: sepolia, transport: http(readVerifyRpcUrls().primary, { timeout: 15_000, retryCount: 1 }) });
  let roleBitmap: string | null = null;
  try {
    const r = await c.readContract({ address: P_D, abi: EAC_ABI, functionName: "roles", args: [BigInt(keccak256(toBytes(KEY))), W_OP] });
    roleBitmap = `0x${r.toString(16)}`;
  } catch {
    roleBitmap = null;
  }
  let attestationWrite: string | null = null;
  try {
    await c.call({ account: W_OP, to: P_D, data: encodeFunctionData({ abi: EAC_ABI, functionName: "setText", args: [NODE, ATTESTATION_KEY, "x"] }) });
    attestationWrite = "did not revert";
  } catch (e) {
    let data: `0x${string}` | null = null;
    (e as BaseError).walk?.((x: unknown) => {
      const d = (x as { data?: unknown } | null)?.data;
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
        data = d as `0x${string}`;
        return true;
      }
      return false;
    });
    let name: string | null = null;
    if (data) {
      try {
        name = decodeErrorResult({ abi: EAC_ABI, data }).errorName;
      } catch {
        name = null;
      }
    }
    attestationWrite = name;
  }
  return { operator: W_OP, resolver: P_D, roleBitmap, attestationWrite };
}

// ============================================================
// /tokyo の読み取り（ページと /api/tokyo/verify が使う）。署名器も鍵も無い。
// checkEnsOffer は凍結した tarball（vendor/vet402-sdk-0.7.0.tgz）の SDK から読む。
// RPC は別々の提供者の2本（SDK の pinBlock が両方の一致を見る）。env は TOKYO_SEPOLIA_RPC_URL だけ。
// 同じ名前の結果はプロセス内で VERIFY_CACHE_MS だけ使い回す（cache.ts）。結果は block と読んだ時刻を持つので、
// 使い回しても「block N で読んだ」事実のまま。審査員ボタンが seller-d.eth を書いたら button.ts が
// cache.ts の forgetVerified で忘れさせる。
// ============================================================
import { createPublicClient, decodeErrorResult, encodeFunctionData, http, keccak256, parseAbi, toBytes, type BaseError } from "viem";
import { sepolia } from "viem/chains";
import { checkEnsOffer, type EnsReadClients } from "@vet402/sdk/ens";
import {
  ATTESTATION_KEY, BASE_SEPOLIA_PROFILE, KEY, MAX_AGE_SECONDS, MIN_VALID, NODE, P_D, SELLER_METHOD,
  SELLER_RESOURCE, TRUSTED_ATTESTERS, VERIFY_CACHE_MS, W_OP,
} from "./constants";
import { TtlCache, verifyCache } from "./cache";
import { readVerifyRpcUrls } from "./rpc-env";

export const STEP_NAMES: Record<number, string> = {
  1: "envelope",
  2: "manager",
  3: "record value",
  4: "payload",
  5: "recover signer",
  6: "attester name",
  7: "compare",
};

export type TraceStep = { step: number; name: string; status: "ok" | "fail" | "skipped"; detail: Record<string, string> };

export type VerifyView = {
  name: string;
  ok: boolean;
  reasons: string[];
  chainId: number;
  block: string;
  blockTimestamp: string;
  manager: string | null;
  offerRaw: string | null;
  amount: string | null;
  trace: TraceStep[];
  format: "ensip29-draft";
  request: { method: string; resource: string };
  attesters: { name: string; address: string }[];
  maxAgeSeconds: number;
  ms: number;
  /** サーバが読み終えた時刻（ISO）。使い回した結果でもこの値のまま。 */
  readAt: string;
};

export type VerifyError = { name: string; error: "invalid_name" | "verify_failed"; message: string };

const MAX_NAME = 255;

function clients(): EnsReadClients {
  const { primary, secondary } = readVerifyRpcUrls();
  const mk = (url: string) => createPublicClient({ chain: sepolia, transport: http(url, { timeout: 15_000, retryCount: 1 }) });
  return { primary: mk(primary), secondary: mk(secondary) } as unknown as EnsReadClients;
}

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
  return verifyCache.get(name, () => readVerify(name)) as Promise<VerifyView | VerifyError>;
}

async function readVerify(name: string): Promise<VerifyView | VerifyError> {
  const t0 = Date.now();
  try {
    const r = await checkEnsOffer({
      name,
      resource: SELLER_RESOURCE,
      method: SELLER_METHOD,
      profile: BASE_SEPOLIA_PROFILE,
      clients: clients(),
      policy: {
        trustedAttesters: TRUSTED_ATTESTERS.map((a) => ({ name: a.name, address: a.address, recordKeys: [...a.recordKeys] })),
        minValid: MIN_VALID,
        maxAgeSeconds: MAX_AGE_SECONDS,
      },
    });
    let amount: string | null = null;
    try {
      const j = r.offerRaw ? (JSON.parse(r.offerRaw) as { amount?: unknown }) : null;
      amount = typeof j?.amount === "string" ? j.amount : null;
    } catch {
      amount = null;
    }
    return {
      name: r.name,
      ok: r.ok,
      reasons: r.reason_codes,
      chainId: r.chainId,
      block: r.block.number.toString(),
      blockTimestamp: r.block.timestamp.toString(),
      manager: r.manager,
      offerRaw: r.offerRaw,
      amount,
      trace: r.trace.map((s) => ({ step: s.step, name: STEP_NAMES[s.step] ?? String(s.step), status: s.status, detail: s.detail })),
      format: "ensip29-draft",
      request: { method: SELLER_METHOD, resource: SELLER_RESOURCE },
      attesters: TRUSTED_ATTESTERS.map((a) => ({ name: a.name, address: a.address })),
      maxAgeSeconds: MAX_AGE_SECONDS,
      ms: Date.now() - t0,
      readAt: new Date().toISOString(),
    };
  } catch (e) {
    // checkEnsOffer が投げるのは方針の誤りだけ（チェーンの状態では投げない）。文言は返さない。
    return { name, error: "verify_failed", message: e instanceof Error && /invalid_attestation_policy/.test(e.message) ? "The verification policy is invalid." : "The check could not run." };
  }
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

// ============================================================
// seller-d.eth を含む任意の名前で、ENSIP-29 草案の7段を今の Sepolia で1回走らせる（使い回さない）。
// 署名器も鍵も無い。checkEnsOffer は凍結した tarball（vendor/vet402-sdk-0.7.0.tgz）の SDK から読む。
// RPC は別々の提供者の2本（SDK の pinBlock が両方の一致を見る）。env は TOKYO_SEPOLIA_RPC_URL だけ。
//
// 使うのは2か所: verify.ts（名前ごとの使い回しの中身）と、審査員ボタンの応答（押した後に読んだ7段・readAfterWrite）。
// ボタンの経路（mutate / reset / state）から import されるので、このファイルに他の売り手の名前を置かない（W06）。
// ============================================================
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { checkEnsOffer, type EnsReadClients } from "@vet402/sdk/ens";
import { BASE_SEPOLIA_PROFILE, MAX_AGE_SECONDS, MIN_VALID, SELLER_METHOD, SELLER_RESOURCE, TRUSTED_ATTESTERS } from "./constants";
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

function clients(): EnsReadClients {
  const { primary, secondary } = readVerifyRpcUrls();
  const mk = (url: string) => createPublicClient({ chain: sepolia, transport: http(url, { timeout: 15_000, retryCount: 1 }) });
  return { primary: mk(primary), secondary: mk(secondary) } as unknown as EnsReadClients;
}

/** 7段を今の Sepolia で1回走らせる。RPC が落ちたときも SDK は投げず ens_evidence_unavailable を返す。 */
export async function readCheck(name: string): Promise<VerifyView | VerifyError> {
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

/** 押した後の読み直しの間隔。 */
const AFTER_WRITE_PAUSE_MS = 1_500;

/**
 * ボタンが書いた後の7段。SDK は B = min(2本の head) で読むので、受領の直後でも片方の RPC が遅れていれば
 * 押す前のブロックを読みうる。minBlock（受領のブロック）以上で読めるまで、budgetMs の内側で読み直す。
 * 読めなければ null（押す前の値を「押した後」と言って返さない）。
 */
export async function readAfterWrite(
  run: () => Promise<VerifyView | VerifyError>,
  minBlock: bigint | null,
  budgetMs: number,
  pauseMs = AFTER_WRITE_PAUSE_MS,
): Promise<VerifyView | null> {
  const deadline = Date.now() + budgetMs;
  const timeout = <T,>(p: Promise<T>): Promise<T | null> => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.resolve(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p.finally(() => clearTimeout(timer)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), left);
      }),
    ]);
  };
  while (Date.now() < deadline) {
    const r = await timeout(run().catch(() => null));
    if (r && !("error" in r) && r.block !== "0" && (minBlock === null || BigInt(r.block) >= minBlock)) return r;
    if (deadline - Date.now() <= pauseMs) break;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return null;
}

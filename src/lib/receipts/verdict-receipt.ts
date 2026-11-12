// 判定応答に付ける EIP-191 レシート。
// 署名鍵は VET402_RECEIPT_SIGNER_KEY。無い、または読めないときは receipt を足さない。
// 検証は disputes と同じく viem の verifyMessage（matchSignatureForm）で、失敗は署名不一致に倒す。
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { isValidIssuedAt, matchSignatureForm, SIGNING_DOMAIN } from "@/lib/verify-message";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const RECEIPT_SIGNER_ENV = "VET402_RECEIPT_SIGNER_KEY";

const VERDICTS = ["ALLOW", "WARN", "BLOCK", "NONE"] as const;
export type ReceiptVerdict = (typeof VERDICTS)[number];

export type VerdictReceipt = {
  input_sha256: string;
  verdict: ReceiptVerdict;
  as_of: string;
  signer: `0x${string}`;
  signature: `0x${string}`;
};

export type ReceiptSignInput = {
  canonicalInput: string;
  verdict: ReceiptVerdict;
  asOf: string;
};

/** recommendation が無い check は NONE。知らない語は署名しない。 */
export function receiptVerdictOf(recommendation: string | null): ReceiptVerdict | null {
  if (recommendation === "ALLOW" || recommendation === "WARN" || recommendation === "BLOCK") return recommendation;
  if (recommendation === null) return "NONE";
  return null;
}

/** GET /api/v1/check の入力。method を省略したときは method 行を空にする。 */
export function checkCanonicalInput(url: string, method: string | null): string {
  return ["check", `url:${url}`, `method:${method ?? ""}`].join("\n");
}

/** GET /decision の入力。caller_policy と include_score は判定を変えないので含めない。 */
export function decisionCanonicalInput(input: {
  resourceId: string;
  role: "payer" | "payee";
  payer: string | null;
  callerDialect: "v1" | "v2" | null;
  allowWithoutL1: boolean;
}): string {
  return [
    "decision",
    `resource_id:${input.resourceId}`,
    `role:${input.role}`,
    `payer:${input.payer ?? ""}`,
    `caller_dialect:${input.callerDialect ?? ""}`,
    `allow_without_l1:${input.allowWithoutL1 ? "true" : "false"}`,
  ].join("\n");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 署名対象。新しい公開文なので、既存の署名が使うダッシュはここに置かない。
 * 行の形と verifyMessage の使い方は disputes に揃える。
 */
export function verdictReceiptMessage(fields: {
  input_sha256: string;
  verdict: ReceiptVerdict;
  as_of: string;
}): string {
  return [
    `${SIGNING_DOMAIN} verdict receipt`,
    `domain: ${SIGNING_DOMAIN}`,
    `input sha256: ${fields.input_sha256}`,
    `verdict: ${fields.verdict}`,
    `as_of: ${fields.as_of}`,
    "This signature attests the verdict above for the input with this sha256. It moves no funds.",
  ].join("\n");
}

function isVerdict(value: string): value is ReceiptVerdict {
  return (VERDICTS as readonly string[]).includes(value);
}

function signerAccount(): ReturnType<typeof privateKeyToAccount> | null {
  const raw = process.env[RECEIPT_SIGNER_ENV]?.trim() ?? "";
  if (raw === "") return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    logServerErrorSafe("verdict-receipt", new Error("VET402_RECEIPT_SIGNER_KEY is set but is not a 32 byte hex private key"));
    return null;
  }
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch {
    logServerErrorSafe("verdict-receipt", new Error("VET402_RECEIPT_SIGNER_KEY could not be read as a signing key"));
    return null;
  }
}

export async function signVerdictReceipt(input: ReceiptSignInput): Promise<VerdictReceipt | null> {
  if (!isVerdict(input.verdict) || !isValidIssuedAt(input.asOf)) return null;
  const account = signerAccount();
  if (!account) return null;
  const input_sha256 = sha256Hex(input.canonicalInput);
  const message = verdictReceiptMessage({ input_sha256, verdict: input.verdict, as_of: input.asOf });
  try {
    const signature = await account.signMessage({ message });
    return { input_sha256, verdict: input.verdict, as_of: input.asOf, signer: account.address, signature };
  } catch {
    logServerErrorSafe("verdict-receipt", new Error("verdict receipt signature failed"));
    return null;
  }
}

/** 鍵が無いときは同じオブジェクトを返す。JSON のキーも増えない。 */
export async function attachVerdictReceipt<T extends object>(body: T, input: ReceiptSignInput | null): Promise<T> {
  if (!input) return body;
  const receipt = await signVerdictReceipt(input);
  if (!receipt) return body;
  return { ...body, receipt };
}

export function decisionReceiptSignInput(
  result: { recommendation: string; scoredAt: string },
  fields: {
    resourceId: string;
    role: "payer" | "payee";
    payer: string | null;
    callerDialect: "v1" | "v2" | null;
    allowWithoutL1: boolean;
  },
): ReceiptSignInput | null {
  if (!isVerdict(result.recommendation) || result.recommendation === "NONE") return null;
  if (!isValidIssuedAt(result.scoredAt)) return null;
  return {
    canonicalInput: decisionCanonicalInput(fields),
    verdict: result.recommendation,
    asOf: result.scoredAt,
  };
}

export async function verifyVerdictReceipt(input: {
  input_sha256: unknown;
  verdict: unknown;
  as_of: unknown;
  signer: unknown;
  signature: unknown;
}): Promise<{ ok: true } | { ok: false; error: "invalid_input" | "invalid_signature" }> {
  if (typeof input.input_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.input_sha256)) {
    return { ok: false, error: "invalid_input" };
  }
  if (typeof input.verdict !== "string" || !isVerdict(input.verdict)) return { ok: false, error: "invalid_input" };
  if (typeof input.as_of !== "string" || !isValidIssuedAt(input.as_of)) return { ok: false, error: "invalid_input" };
  if (typeof input.signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.signer)) {
    return { ok: false, error: "invalid_input" };
  }
  if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(input.signature)) {
    return { ok: false, error: "invalid_input" };
  }
  const message = verdictReceiptMessage({
    input_sha256: input.input_sha256,
    verdict: input.verdict,
    as_of: input.as_of,
  });
  const { matched } = await matchSignatureForm({
    address: input.signer,
    signature: input.signature,
    current: message,
    legacy: message,
  });
  return matched === "current" ? { ok: true } : { ok: false, error: "invalid_signature" };
}

// ============================================================
// 第三者も提案できる、台帳の訂正の公開口（測定の correction_log とは別）。
// 2026-11-10 公平審査 3.8 の 6c。
//
// - 提案者の種別は self と third_party の 2 つだけ。表示のラベルが違う。
// - self は運用者のトークンで書く。third_party は、許可した Ethereum アドレスの
//   EIP-191 署名で書く。自社のアドレスの署名で third_party は書けない。
// - 訂正は追記だけ。元の行を消さない・書き換えない（保存は ledger-corrections-store.ts）。
// - 公開の行には署名とアドレスを残し、GET を読んだ人が鍵なしで署名を確かめ直せる。
// ============================================================
import { randomBytes } from "node:crypto";
import { verifyMessage, type Hex } from "viem";
import { SIGNING_DOMAIN } from "@/lib/verify-message";

export const LEDGER_CORRECTION_KINDS = ["self", "third_party"] as const;
export type LedgerCorrectionKind = (typeof LEDGER_CORRECTION_KINDS)[number];

export const LEDGER_CORRECTION_NOTE_MAX = 2000;

export type LedgerCorrectionEntry = {
  id: string;
  kind: LedgerCorrectionKind;
  citedDay: string;
  note: string;
  createdAt: string;
  /** third_party だけ。署名したアドレス（小文字）。 */
  signerAddress?: string;
  /** third_party だけ。ledgerCorrectionSignMessage への EIP-191 署名。 */
  signature?: string;
};

export type LedgerCorrectionWriteInput =
  | { kind: "self"; citedDay: string; note: string }
  | { kind: "third_party"; citedDay: string; note: string; signerAddress: string; signature: string };

export type LedgerCorrectionAuth = {
  /** 自社のアドレス。third_party の署名者として拒む。 */
  selfAddresses: readonly string[];
  /** third_party として書いてよいアドレス。空なら third_party の口は閉じている。 */
  thirdPartyAddresses: readonly string[];
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/;

/** カンマ区切りの環境変数をアドレスの一覧にする（小文字・形の悪いものは捨てる）。 */
export function parseAddressList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ADDRESS_RE.test(s));
}

/** 第三者が署名する文。改行区切りの固定の形。GET の行から誰でも組み立て直せる。 */
export function ledgerCorrectionSignMessage(input: { citedDay: string; note: string }): string {
  return [
    `${SIGNING_DOMAIN} ledger correction`,
    `domain: ${SIGNING_DOMAIN}`,
    "kind: third_party",
    `cited_day: ${input.citedDay}`,
    `note: ${input.note.trim()}`,
  ].join("\n");
}

async function signatureMatches(input: {
  citedDay: string;
  note: string;
  signerAddress: string;
  signature: string;
}): Promise<boolean> {
  if (!ADDRESS_RE.test(input.signerAddress)) return false;
  if (!SIGNATURE_RE.test(input.signature)) return false;
  try {
    return await verifyMessage({
      address: input.signerAddress as Hex,
      message: ledgerCorrectionSignMessage(input),
      signature: input.signature as Hex,
    });
  } catch {
    return false;
  }
}

function validDay(day: string, now: Date): boolean {
  if (!DAY_RE.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day) return false;
  return day <= now.toISOString().slice(0, 10);
}

export type LedgerCorrectionError =
  | "invalid_kind"
  | "invalid_day"
  | "empty_note"
  | "note_too_long"
  | "invalid_signer"
  | "self_key_cannot_write_third_party"
  | "third_party_signer_not_allowed"
  | "invalid_signature";

/**
 * 書き込みの中身を確かめ、追記する 1 行を作る。保存はしない（呼び手が store.append する）。
 * self の認可（トークン）は HTTP の側で確かめる。ここは形と第三者の署名を見る。
 */
export async function prepareLedgerCorrection(
  input: LedgerCorrectionWriteInput,
  auth: LedgerCorrectionAuth,
  now: Date = new Date(),
): Promise<{ ok: true; entry: LedgerCorrectionEntry } | { ok: false; error: LedgerCorrectionError }> {
  if (!input || (input.kind !== "self" && input.kind !== "third_party")) return { ok: false, error: "invalid_kind" };
  if (typeof input.citedDay !== "string" || !validDay(input.citedDay, now)) return { ok: false, error: "invalid_day" };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") return { ok: false, error: "empty_note" };
  if (note.length > LEDGER_CORRECTION_NOTE_MAX) return { ok: false, error: "note_too_long" };
  const base = { id: randomBytes(16).toString("hex"), citedDay: input.citedDay, note, createdAt: now.toISOString() };

  if (input.kind === "self") return { ok: true, entry: { ...base, kind: "self" } };

  const signer = typeof input.signerAddress === "string" ? input.signerAddress.trim().toLowerCase() : "";
  if (!ADDRESS_RE.test(signer)) return { ok: false, error: "invalid_signer" };
  const selfSet = new Set(auth.selfAddresses.map((a) => a.toLowerCase()));
  if (selfSet.has(signer)) return { ok: false, error: "self_key_cannot_write_third_party" };
  const allowed = new Set(auth.thirdPartyAddresses.map((a) => a.toLowerCase()));
  if (!allowed.has(signer)) return { ok: false, error: "third_party_signer_not_allowed" };
  const signature = typeof input.signature === "string" ? input.signature.trim() : "";
  if (!(await signatureMatches({ citedDay: input.citedDay, note, signerAddress: signer, signature }))) {
    return { ok: false, error: "invalid_signature" };
  }
  return { ok: true, entry: { ...base, kind: "third_party", signerAddress: signer, signature } };
}

/** 公開行だけから第三者の署名を確かめ直す（GET の各行に使う）。self の行は署名を持たないので null。 */
export async function reverifyLedgerCorrectionRow(row: LedgerCorrectionEntry): Promise<boolean | null> {
  if (row.kind !== "third_party") return null;
  if (!row.signerAddress || !row.signature) return false;
  return signatureMatches({
    citedDay: row.citedDay,
    note: row.note,
    signerAddress: row.signerAddress,
    signature: row.signature,
  });
}

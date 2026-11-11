// ============================================================
// 第三者も提案できる、台帳の訂正の公開口（測定の correction_log とは別）。
// 2026-11-10 公平審査 3.8 の 6c。
//
// - 提案者の種別は self と third_party の 2 つだけ。表示のラベルが違う。
// - self は運用者のトークンで書く。third_party は、許可した Ethereum アドレスの
//   EIP-191 署名で書く。自社のアドレスの署名で third_party は書けない。
// - 訂正は追記だけ。元の行を消さない・書き換えない（保存は ledger-corrections-store.ts）。
// - 公開の行には署名とアドレスを残し、GET を読んだ人が鍵なしで署名を確かめ直せる。
// - 2026-11-11（6c-4）: 訂正は台帳の 1 行（citedRowId）を指せる。その行の当時の指紋
//   （priorRowSha256）は、書き手が渡した値ではなく、台帳そのもの（その日の公開ファイルの行）から
//   読んで残す。読んだ人は /anchors/day の同じ行に同じ式をかけて確かめられる。行は変えない。
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
  /** 訂正が指す台帳の行（x402_l1_purchases.id）。日全体への訂正なら無い。 */
  citedRowId?: string;
  /** citedRowId の行の、訂正を受け付けた時点の指紋。台帳から読んだ値（anchors.ts の ledgerRowFingerprint）。 */
  priorRowSha256?: string;
  note: string;
  createdAt: string;
  /** third_party だけ。署名したアドレス（小文字）。 */
  signerAddress?: string;
  /** third_party だけ。ledgerCorrectionSignMessage への EIP-191 署名。 */
  signature?: string;
};

export type LedgerCorrectionWriteInput =
  | { kind: "self"; citedDay: string; citedRowId?: string; note: string }
  | { kind: "third_party"; citedDay: string; citedRowId?: string; note: string; signerAddress: string; signature: string };

/** 台帳の行の指紋を読む口。行が無ければ null。HTTP は DB から読む関数を渡す。 */
export type LedgerRowPriorReader = (day: string, rowId: string) => Promise<string | null>;

export type LedgerCorrectionAuth = {
  /** 自社のアドレス。third_party の署名者として拒む。 */
  selfAddresses: readonly string[];
  /** third_party として書いてよいアドレス。空なら third_party の口は閉じている。 */
  thirdPartyAddresses: readonly string[];
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/;
const ROW_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** カンマ区切りの環境変数をアドレスの一覧にする（小文字・形の悪いものは捨てる）。 */
export function parseAddressList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ADDRESS_RE.test(s));
}

/** 第三者が署名する文。改行区切りの固定の形。GET の行から誰でも組み立て直せる。 */
export function ledgerCorrectionSignMessage(input: { citedDay: string; citedRowId?: string | null; note: string }): string {
  return [
    `${SIGNING_DOMAIN} ledger correction`,
    `domain: ${SIGNING_DOMAIN}`,
    "kind: third_party",
    `cited_day: ${input.citedDay}`,
    `cited_row: ${input.citedRowId || "none"}`,
    `note: ${input.note.trim()}`,
  ].join("\n");
}

async function signatureMatches(input: {
  citedDay: string;
  citedRowId?: string | null;
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
  | "invalid_row_id"
  | "cited_row_not_found"
  | "ledger_unavailable"
  | "invalid_signer"
  | "self_key_cannot_write_third_party"
  | "third_party_signer_not_allowed"
  | "invalid_signature";

/**
 * 書き込みの中身を確かめ、追記する 1 行を作る。保存はしない（呼び手が store.append する）。
 * self の認可（トークン）は HTTP の側で確かめる。ここは形と第三者の署名を見る。
 * citedRowId があるとき、その行の指紋は readPrior（台帳）から取る。行が無ければ書かない。
 * readPrior が無い（台帳を読めない）ときに行を指す訂正は受け付けない。
 */
export async function prepareLedgerCorrection(
  input: LedgerCorrectionWriteInput,
  auth: LedgerCorrectionAuth,
  now: Date = new Date(),
  readPrior: LedgerRowPriorReader | null = null,
): Promise<{ ok: true; entry: LedgerCorrectionEntry } | { ok: false; error: LedgerCorrectionError }> {
  if (!input || (input.kind !== "self" && input.kind !== "third_party")) return { ok: false, error: "invalid_kind" };
  if (typeof input.citedDay !== "string" || !validDay(input.citedDay, now)) return { ok: false, error: "invalid_day" };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") return { ok: false, error: "empty_note" };
  if (note.length > LEDGER_CORRECTION_NOTE_MAX) return { ok: false, error: "note_too_long" };
  const rawRowId = (input as { citedRowId?: unknown }).citedRowId;
  let citedRowId: string | undefined;
  if (rawRowId !== undefined && rawRowId !== null && rawRowId !== "") {
    if (typeof rawRowId !== "string" || !ROW_ID_RE.test(rawRowId.trim())) return { ok: false, error: "invalid_row_id" };
    citedRowId = rawRowId.trim();
  }
  const base: Omit<LedgerCorrectionEntry, "kind"> = {
    id: randomBytes(16).toString("hex"),
    citedDay: input.citedDay,
    note,
    createdAt: now.toISOString(),
  };

  // 第三者の署名は、台帳を読む前に確かめる（署名の無い呼び出しで台帳を読ませない）。
  let thirdParty: { signerAddress: string; signature: string } | null = null;
  if (input.kind === "third_party") {
    const signer = typeof input.signerAddress === "string" ? input.signerAddress.trim().toLowerCase() : "";
    if (!ADDRESS_RE.test(signer)) return { ok: false, error: "invalid_signer" };
    const selfSet = new Set(auth.selfAddresses.map((a) => a.toLowerCase()));
    if (selfSet.has(signer)) return { ok: false, error: "self_key_cannot_write_third_party" };
    const allowed = new Set(auth.thirdPartyAddresses.map((a) => a.toLowerCase()));
    if (!allowed.has(signer)) return { ok: false, error: "third_party_signer_not_allowed" };
    const signature = typeof input.signature === "string" ? input.signature.trim() : "";
    if (!(await signatureMatches({ citedDay: input.citedDay, citedRowId, note, signerAddress: signer, signature }))) {
      return { ok: false, error: "invalid_signature" };
    }
    thirdParty = { signerAddress: signer, signature };
  }

  if (citedRowId !== undefined) {
    if (!readPrior) return { ok: false, error: "ledger_unavailable" };
    const prior = await readPrior(input.citedDay, citedRowId);
    if (prior === null) return { ok: false, error: "cited_row_not_found" };
    base.citedRowId = citedRowId;
    base.priorRowSha256 = prior;
  }

  if (!thirdParty) return { ok: true, entry: { ...base, kind: "self" } };
  return { ok: true, entry: { ...base, kind: "third_party", ...thirdParty } };
}

/** 公開行だけから第三者の署名を確かめ直す（GET の各行に使う）。self の行は署名を持たないので null。 */
export async function reverifyLedgerCorrectionRow(row: LedgerCorrectionEntry): Promise<boolean | null> {
  if (row.kind !== "third_party") return null;
  if (!row.signerAddress || !row.signature) return false;
  return signatureMatches({
    citedDay: row.citedDay,
    citedRowId: row.citedRowId ?? null,
    note: row.note,
    signerAddress: row.signerAddress,
    signature: row.signature,
  });
}

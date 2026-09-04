// Canonical self-verification messages for payee + agent-passport registration.
//
// 2026-08-14 (軽-1B): these two builders used to be NON-HANDLER exports from
// route files (payees/verify/route.ts, agents/verify/route.ts). A Next.js App
// Router route module may only export route handlers plus a small set of segment
// config — a named helper export makes another route (agents/[agentId]/passport)
// import FROM a route, the exact same route-type contract violation that already
// forced isCanonicalName out to @/lib/validation/canonical-name. Both builders
// now live here, one source of truth, imported by the routes and the passport
// route alike.
//
// SECURITY (unchanged): each signed message is a FIXED set of newline-joined
// lines. A `name` containing a newline/CR/tab could forge an extra
// "wallet:"/"agentId:" line, so isCanonicalName is enforced at the schema layer
// by every caller AND here as a defense-in-depth backstop — the throw guarantees
// a non-canonical name can never be folded into a canonical message even via a
// future caller.
import { verifyMessage } from "viem";
import { isCanonicalName } from "@/lib/validation/canonical-name";

const URL_MAX_LENGTH = 200;

/**
 * 2026-09-05 (S-6 / KC-B). Every signed message now names the site that is
 * asking. Before this, the payee/passport text began `Vouch …` — a product
 * name that appears nowhere on vet402.com — and no message carried the
 * requesting origin at all, so a phishing site serving the identical text was
 * indistinguishable in the wallet's signing view. Two fixed lines fix that:
 *
 *   line 1: `vet402.com — <purpose>`   ← who is asking, in the name on the URL bar
 *   line 2: `domain: vet402.com`       ← machine-checkable origin binding
 *
 * and every message ends with a sentence saying what the signature does and
 * that it moves no funds. `issued` additionally states its own 10-minute
 * validity, because a signer who does not know the window reads
 * `signature_expired` as a bug.
 *
 * This is a human-readable EIP-191 surface, not EIP-712: the domain line is
 * read by a person, and by our own verifier only in the sense that a message
 * without it is simply not the message we build.
 */
export const SIGNING_DOMAIN = "vet402.com";

/** 1 行目の名乗り。5 面すべてがこれで始まる。 */
function titleLine(purpose: string): string {
  return `${SIGNING_DOMAIN} — ${purpose}`;
}

/** 2 行目のオリジン束縛。全面必須。 */
const DOMAIN_LINE = `domain: ${SIGNING_DOMAIN}`;

/**
 * 旧形式（〜2026-09-05）の署名を受理する期限。これを過ぎたら現行形式だけ。
 *
 * WHY 互換期間があるか: 署名本文は SDK や外部の実装が自前で組み立てられる
 * 公開の契約である。切り替えた瞬間に旧本文で署名した正当な相手が
 * `signature_mismatch` を食う——「壊れて見えない」失敗になる。だから
 * 期限つきで受理し、期限後は専用のコード
 * (`signature_message_legacy_expired`) で「あなたは旧形式で署名した」と
 * 名指しで返す。無言の mismatch にしない。
 *
 * 期限が来たら legacy* ビルダーと matchSignatureForm の legacy 分岐を消す。
 */
export const LEGACY_MESSAGE_ACCEPT_UNTIL = Date.parse("2026-09-21T00:00:00.000Z");

export type SignatureFormMatch = {
  /**
   *  - "current":        現行形式で署名されている
   *  - "legacy":         旧形式だが互換期限の内側——受理し、legacy_message として記録する
   *  - "legacy_expired": 旧形式で、期限切れ——拒否するが理由は名指しする
   *  - "none":           どちらでもない（署名なし・別人・別本文を含む）
   */
  matched: "current" | "legacy" | "legacy_expired" | "none";
};

/**
 * `signature` が current / legacy どちらの本文に対するものかを判定する。
 * fail-closed: 復元に失敗した場合・例外はすべて "none"。
 *
 * `now` を引数に取るのは、互換期限のテストを実時計に依存させないため
 * （「今日は通るが 9/21 に赤くなるテスト」を書かない）。
 */
export async function matchSignatureForm(params: {
  address: string;
  signature: string | null | undefined;
  current: string;
  legacy: string;
  now?: number;
}): Promise<SignatureFormMatch> {
  const { address, signature, current, legacy } = params;
  if (!signature) return { matched: "none" };
  const verify = async (message: string): Promise<boolean> => {
    try {
      return await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      return false;
    }
  };
  if (await verify(current)) return { matched: "current" };
  if (current === legacy || !(await verify(legacy))) return { matched: "none" };
  const now = params.now ?? Date.now();
  return { matched: now < LEGACY_MESSAGE_ACCEPT_UNTIL ? "legacy" : "legacy_expired" };
}

/**
 * Profile URLs that may be folded into a signed message. Same control-char
 * refusal as isCanonicalName, plus https-only and a hard length cap, so a
 * preview GET cannot 500 by throwing from the message builder.
 */
export function isSafeBoundUrl(url: string): boolean {
  if (!/^https:\/\//.test(url) || url.length > URL_MAX_LENGTH) return false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return false;
  }
  return !url.includes("\u2028") && !url.includes("\u2029");
}

function assertSafeUrlLine(url: string, label: string): void {
  if (!isSafeBoundUrl(url)) {
    throw new Error(`${label}: non-canonical url would break the canonical message`);
  }
}

/**
 * A signed `issued` timestamp must be the exact shape Date#toISOString()
 * produces (2026-08-18T12:00:00.000Z). Two reasons for the strict shape:
 *
 *  1. It is folded into the signed bytes, so — like name/url — a value that
 *     could carry a newline would forge an extra canonical line. Anchored
 *     digits + literal separators leave no room for one.
 *  2. The verify route parses it with Date.parse to check a freshness window;
 *     a loose accept would let "2026" or an epoch int through and skew that.
 *
 * 2026-08-18 (audit residual): without a signed timestamp any published
 * signature is a permanently replayable write credential. See the verify
 * routes for the freshness window and the monotonic DB write that pair with
 * this line.
 */
const ISSUED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isValidIssuedAt(issuedAt: string): boolean {
  return ISSUED_AT_RE.test(issuedAt) && !Number.isNaN(Date.parse(issuedAt));
}

function assertIssuedLine(issuedAt: string, label: string): void {
  if (!isValidIssuedAt(issuedAt)) {
    throw new Error(`${label}: issuedAt must be an exact toISOString() timestamp`);
  }
}

/**
 * The exact message a payee signs with its receiving wallet. A valid signature
 * over this text IS the proof of control (EIP-191 via viem). The base three
 * lines; a `url:` line when a profile URL is bound; an `issued:` line when a
 * freshness timestamp is bound.
 *
 * `issued` is optional at the type level ONLY so read-path callers can
 * reconstruct a pre-migration row's legacy message (which was signed without
 * one). Every WRITE path passes it — the verify POST requires it.
 */
export function payeeMessage(wallet: string, name: string, url?: string, issuedAt?: string): string {
  if (!isCanonicalName(name)) {
    throw new Error("payeeMessage: non-canonical name would break the canonical message");
  }
  const lines = [
    titleLine("verified payee registration"),
    DOMAIN_LINE,
    `wallet: ${wallet.toLowerCase()}`,
    `name: ${name}`,
  ];
  if (url) {
    assertSafeUrlLine(url, "payeeMessage");
    lines.push(`url: ${url}`);
  }
  if (issuedAt) {
    assertIssuedLine(issuedAt, "payeeMessage");
    lines.push(`issued: ${issuedAt} (valid 10 minutes)`);
  }
  lines.push(
    "This signature proves control of the wallet above. It moves no funds and grants no spending approval.",
  );
  return lines.join("\n");
}

/**
 * LEGACY (〜2026-09-05, delete after LEGACY_MESSAGE_ACCEPT_UNTIL) — the exact
 * text this endpoint asked for before the domain binding landed. Frozen: it
 * exists only so a signature produced against the old contract still verifies
 * during the migration window, and so the passport read path can reconstruct
 * rows signed under it. Nothing new is ever issued in this shape.
 */
export function legacyPayeeMessage(
  wallet: string,
  name: string,
  url?: string,
  issuedAt?: string,
): string {
  if (!isCanonicalName(name)) {
    throw new Error("legacyPayeeMessage: non-canonical name would break the canonical message");
  }
  const lines = [
    "Vouch verified payee registration",
    `wallet: ${wallet.toLowerCase()}`,
    `name: ${name}`,
  ];
  if (url) {
    assertSafeUrlLine(url, "legacyPayeeMessage");
    lines.push(`url: ${url}`);
  }
  if (issuedAt) {
    assertIssuedLine(issuedAt, "legacyPayeeMessage");
    lines.push(`issued: ${issuedAt}`);
  }
  lines.push("This signature only proves control of the wallet above.");
  return lines.join("\n");
}

/**
 * The exact message a payee signs to route observatory delisting alerts for
 * endpoints paying `wallet` to the webhooks of api key `apiKeyId`. The
 * signature proves control of the receiving wallet (same EIP-191 gate as
 * payee registration); the api key comes from the authenticated request, so
 * the pair is bound by two independent proofs. Four fixed lines; wallet is
 * lowercased and apiKeyId is a server-issued uuid, so no canonical-name
 * injection surface exists here.
 */
export function observatoryWatchMessage(wallet: string, apiKeyId: string): string {
  return [
    titleLine("observatory watch registration"),
    DOMAIN_LINE,
    `wallet: ${wallet.toLowerCase()}`,
    `apiKey: ${apiKeyId}`,
    "This signature authorizes delisting notifications for endpoints paying the wallet above. It moves no funds.",
  ].join("\n");
}

/** LEGACY (〜2026-09-05) — see legacyPayeeMessage. Frozen. */
export function legacyObservatoryWatchMessage(wallet: string, apiKeyId: string): string {
  return [
    "vet402 observatory watch registration",
    `wallet: ${wallet.toLowerCase()}`,
    `apiKey: ${apiKeyId}`,
    "This signature authorizes delisting notifications for endpoints paying the wallet above.",
  ].join("\n");
}

export function agentPassportMessage(
  agentId: bigint,
  wallet: string,
  name: string,
  url?: string,
  issuedAt?: string,
): string {
  if (!isCanonicalName(name)) {
    throw new Error("agentPassportMessage: non-canonical name would break the canonical message");
  }
  const lines = [
    titleLine("agent passport registration"),
    DOMAIN_LINE,
    `agentId: ${agentId.toString()}`,
    `wallet: ${wallet.toLowerCase()}`,
    `name: ${name}`,
  ];
  if (url) {
    assertSafeUrlLine(url, "agentPassportMessage");
    lines.push(`url: ${url}`);
  }
  if (issuedAt) {
    assertIssuedLine(issuedAt, "agentPassportMessage");
    lines.push(`issued: ${issuedAt} (valid 10 minutes)`);
  }
  lines.push(
    "This signature proves control of the wallet above. It moves no funds and grants no spending approval.",
  );
  return lines.join("\n");
}

/** LEGACY (〜2026-09-05) — see legacyPayeeMessage. Frozen. */
export function legacyAgentPassportMessage(
  agentId: bigint,
  wallet: string,
  name: string,
  url?: string,
  issuedAt?: string,
): string {
  if (!isCanonicalName(name)) {
    throw new Error("legacyAgentPassportMessage: non-canonical name would break the canonical message");
  }
  const lines = [
    "Vouch agent passport registration",
    `agentId: ${agentId.toString()}`,
    `wallet: ${wallet.toLowerCase()}`,
    `name: ${name}`,
  ];
  if (url) {
    assertSafeUrlLine(url, "legacyAgentPassportMessage");
    lines.push(`url: ${url}`);
  }
  if (issuedAt) {
    assertIssuedLine(issuedAt, "legacyAgentPassportMessage");
    lines.push(`issued: ${issuedAt}`);
  }
  lines.push("This signature only proves control of the wallet above.");
  return lines.join("\n");
}

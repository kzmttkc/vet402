import { createHash } from "node:crypto";
import type { getCollateralAndVerify } from "@phala/dcap-qvl";
import { hexBytes, parseJsonMaybe, replayRtmr3 } from "./crypto";
import { extractTdQuoteFields, type VerifyQvlFn } from "./tdx-quote";

export type ComposeManagerWire = {
  actions?: unknown;
  actions_hash?: string;
  nonce?: string;
  quote?: string;
  intel_quote?: string;
  event_log?: unknown;
  report_data?: string;
};

function canonicalString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 32) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

type ComposeAction = Record<string, string | string[]>;

function wireAction(action: unknown): ComposeAction | null {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const raw = action as Record<string, unknown>;
  const out: ComposeAction = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = value as string[];
    else return null;
  }
  if (typeof out.action !== "string" || typeof out.timestamp !== "string") return null;
  return out;
}

/** SDK `canonicalActions` — lexical key order, string / string[] fields only. */
export function canonicalActionsJson(actions: unknown): string {
  if (!Array.isArray(actions)) throw new Error("actions_not_array");
  const parts: string[] = [];
  for (const item of actions) {
    const checked = wireAction(item);
    if (!checked) throw new Error("invalid_action");
    const keys = Object.keys(checked).sort();
    const fields = keys.map((key) => {
      const v = checked[key]!;
      if (typeof v === "string") return `${canonicalString(key)}:${canonicalString(v)}`;
      return `${canonicalString(key)}:[${v.map((s) => canonicalString(s)).join(",")}]`;
    });
    parts.push(`{${fields.join(",")}}`);
  }
  return `[${parts.join(",")}]`;
}

export type ComposeManagerVerifyResult = {
  present: boolean;
  valid: boolean | null;
  actionsCount?: number | null;
  actionsHash?: string;
  reason?: string;
  error?: string;
};

export async function verifyComposeManagerAttestation(
  cmRaw: unknown,
  appCompose: string,
  nonceHex: string,
  verifyQvl: VerifyQvlFn,
): Promise<ComposeManagerVerifyResult> {
  if (!cmRaw) return { present: false, valid: null };
  try {
    const cm = parseJsonMaybe(cmRaw) as ComposeManagerWire | null;
    if (!cm?.actions || cm.actions_hash === undefined || !cm.nonce) {
      return { present: true, valid: null, reason: "missing_fields" };
    }
    const quoteHex = cm.quote || cm.intel_quote;
    if (!quoteHex) return { present: true, valid: false, reason: "missing_quote" };

    if (cm.nonce.toLowerCase() !== nonceHex.toLowerCase()) {
      return { present: true, valid: false, reason: "nonce_mismatch" };
    }

    let verified: Awaited<ReturnType<typeof getCollateralAndVerify>>;
    try {
      verified = await verifyQvl(hexBytes(quoteHex));
    } catch {
      return { present: true, valid: false, reason: "quote_verify_failed" };
    }

    const quote = extractTdQuoteFields(verified);
    if (!quote) return { present: true, valid: false, reason: "unsupported_quote" };

    const nonceBytes = hexBytes(nonceHex);
    const reportData = Buffer.from(quote.reportData);
    if (reportData.length < 64 || !reportData.subarray(32, 64).equals(nonceBytes)) {
      return { present: true, valid: false, reason: "report_data_nonce" };
    }

    if (cm.report_data) {
      const advertised = hexBytes(cm.report_data);
      if (!advertised.equals(reportData)) {
        return { present: true, valid: false, reason: "report_data_mismatch" };
      }
    }

    const canonical = canonicalActionsJson(cm.actions);
    const digest = createHash("sha256").update(canonical, "utf8").digest();
    const advertisedHash = hexBytes(cm.actions_hash);
    if (advertisedHash.length !== 32 || !advertisedHash.equals(digest) || !reportData.subarray(0, 32).equals(digest)) {
      return { present: true, valid: false, reason: "actions_mismatch" };
    }

    const composeSha256 = createHash("sha256").update(appCompose, "utf8").digest();
    const expectedMrConfig = Buffer.concat([Buffer.from([1]), composeSha256, Buffer.alloc(15)]);
    if (!Buffer.from(quote.mrConfigId).equals(expectedMrConfig)) {
      return { present: true, valid: false, reason: "mrconfig_mismatch" };
    }

    const replayed = replayRtmr3(cm.event_log);
    if (!replayed.equals(Buffer.from(quote.rtMr3))) {
      return { present: true, valid: false, reason: "rtmr3_mismatch" };
    }

    return {
      present: true,
      valid: true,
      actionsCount: Array.isArray(cm.actions) ? cm.actions.length : null,
      actionsHash: cm.actions_hash,
    };
  } catch (err) {
    return {
      present: true,
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
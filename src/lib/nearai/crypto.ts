import { createHash } from "node:crypto";

export function hexBytes(value: string): Buffer {
  return Buffer.from(String(value).replace(/^0x/i, ""), "hex");
}

export function parseJsonMaybe(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function sha256Buf(parts: readonly Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function sha384Buf(parts: readonly Buffer[]): Buffer {
  const h = createHash("sha384");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function replayRtmr3(eventLogRaw: unknown): Buffer {
  let rtmr3 = Buffer.alloc(48);
  const events = (parseJsonMaybe(eventLogRaw) as { imr?: number; event_type?: number; event?: string; event_payload?: string; digest?: string }[]) || [];
  for (const event of events) {
    if (event.imr !== 3) continue;
    const eventType = Buffer.alloc(4);
    eventType.writeUInt32LE((event.event_type ?? 0) >>> 0);
    const payloadBytes = hexBytes(event.event_payload ?? "");
    const digest = sha384Buf([
      eventType,
      Buffer.from(":"),
      Buffer.from(event.event ?? "", "utf8"),
      Buffer.from(":"),
      payloadBytes,
    ]);
    if (event.digest) {
      const given = hexBytes(event.digest);
      if (!given.equals(digest)) {
        throw new Error(`RTMR3 digest mismatch on event ${event.event}`);
      }
    }
    rtmr3 = Buffer.from(sha384Buf([rtmr3, digest]));
  }
  return rtmr3;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalizeJson(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeJson(obj[k])).join(",") + "}";
}

export function extractImageDigests(appCompose: string | null | undefined): string[] {
  if (!appCompose) return [];
  const matches = [...appCompose.matchAll(/(?:^|[\s"':=-])([a-zA-Z0-9][a-zA-Z0-9._/-]*@sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
  return [...new Set(matches)];
}

export function checkComposeManagerActions(containerObj: Record<string, unknown> | null | undefined): {
  present: boolean;
  valid: boolean | null;
  actionsCount?: number | null;
  actionsHash?: string;
  reason?: string;
  error?: string;
} {
  const cmRaw = containerObj?.compose_manager_attestation;
  if (!cmRaw) return { present: false, valid: null };
  try {
    const cm = parseJsonMaybe(cmRaw) as { actions?: unknown; actions_hash?: string } | null;
    if (!cm || cm.actions === undefined || cm.actions_hash === undefined) {
      return { present: true, valid: null, reason: "missing_actions_or_hash" };
    }
    const canonical = canonicalizeJson(cm.actions);
    const computed = createHash("sha256").update(canonical, "utf8").digest("hex");
    return {
      present: true,
      valid: computed === cm.actions_hash,
      actionsCount: Array.isArray(cm.actions) ? cm.actions.length : null,
      actionsHash: cm.actions_hash,
    };
  } catch (err) {
    return { present: true, valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
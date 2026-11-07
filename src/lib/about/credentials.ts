import raw from "./credentials.json";

const KINDS = new Set(["grant", "prize", "background"]);

export type CredentialLink = { label: string; url: string };

export type Credential = {
  id: string;
  kind: "grant" | "prize" | "background";
  title: string;
  detail: string;
  when: string;
  whenLabel: string;
  link: CredentialLink | null;
  /** Grants and prizes only: the status line the Legal Notice discloses. Amounts only where the other party published them. */
  disclosure: { status: string } | null;
};

export type AboutCredentials = {
  revision: string;
  builder: {
    builderName: string;
    publisher: string;
  };
  credentials: Credential[];
};

function assertHttpsUrl(url: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${context}: invalid url`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${context}: url must be https`);
  }
}

function validateCredentials(data: unknown): AboutCredentials {
  if (!data || typeof data !== "object") {
    throw new Error("credentials.json: root must be an object");
  }
  const root = data as Record<string, unknown>;
  const revision = root.revision;
  if (typeof revision !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(revision)) {
    throw new Error("credentials.json: revision must be YYYY-MM-DD");
  }
  const builder = root.builder;
  if (!builder || typeof builder !== "object") {
    throw new Error("credentials.json: builder must be an object");
  }
  const creds = root.credentials;
  if (!Array.isArray(creds) || creds.length === 0) {
    throw new Error("credentials.json: credentials must be a non-empty array");
  }
  const ids = new Set<string>();
  const credentials: Credential[] = [];
  for (const item of creds) {
    if (!item || typeof item !== "object") {
      throw new Error("credentials.json: each credential must be an object");
    }
    const row = item as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== "string" || !id) {
      throw new Error("credentials.json: credential id must be a non-empty string");
    }
    if (ids.has(id)) {
      throw new Error(`credentials.json: duplicate credential id ${id}`);
    }
    ids.add(id);
    const kind = row.kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      throw new Error(`credentials.json: credential ${id} kind must be grant|prize|background`);
    }
    for (const key of ["title", "detail", "when", "whenLabel"] as const) {
      if (typeof row[key] !== "string") {
        throw new Error(`credentials.json: credential ${id} ${key} must be a string`);
      }
    }
    let link: CredentialLink | null = null;
    if (row.link !== null && row.link !== undefined) {
      if (typeof row.link !== "object") {
        throw new Error(`credentials.json: credential ${id} link must be object or null`);
      }
      const l = row.link as Record<string, unknown>;
      if (typeof l.label !== "string" || typeof l.url !== "string") {
        throw new Error(`credentials.json: credential ${id} link must have label and url`);
      }
      assertHttpsUrl(l.url, `credentials.json: credential ${id} link`);
      link = { label: l.label, url: l.url };
    }
    if (kind === "background" && link !== null) {
      throw new Error(`credentials.json: background credential ${id} must have link null`);
    }
    if (kind !== "background" && link === null) {
      throw new Error(`credentials.json: credential ${id} must have a link`);
    }
    let disclosure: { status: string } | null = null;
    if (row.disclosure !== null && row.disclosure !== undefined) {
      const dsc = row.disclosure as Record<string, unknown>;
      if (typeof dsc !== "object" || typeof dsc.status !== "string" || !dsc.status) {
        throw new Error(`credentials.json: credential ${id} disclosure must have a status`);
      }
      disclosure = { status: dsc.status };
    }
    if (kind === "background" && disclosure !== null) {
      throw new Error(`credentials.json: background credential ${id} has nothing to disclose`);
    }
    if (kind !== "background" && disclosure === null) {
      throw new Error(`credentials.json: credential ${id} needs a disclosure status for the Legal Notice`);
    }
    credentials.push({
      id,
      kind: kind as Credential["kind"],
      title: row.title as string,
      detail: row.detail as string,
      when: row.when as string,
      whenLabel: row.whenLabel as string,
      link,
      disclosure,
    });
  }
  const b = builder as Record<string, unknown>;
  // 2026-11-08: no second public name here. vet402's face is the builder name, and the
  // product site names no person beyond it (the naming rule for public surfaces).
  if ("publicName" in b) {
    throw new Error("credentials.json: builder.publicName is not published on vet402 surfaces");
  }
  for (const key of ["builderName", "publisher"] as const) {
    if (typeof b[key] !== "string" || !b[key]) {
      throw new Error(`credentials.json: builder.${key} must be a non-empty string`);
    }
  }
  return {
    revision,
    builder: {
      builderName: b.builderName as string,
      publisher: b.publisher as string,
    },
    credentials,
  };
}

export const CREDENTIALS: AboutCredentials = validateCredentials(raw);

/** Prize and grant titles, for the Organization JSON-LD `award` list and llms-full.txt. */
export function credentialAwards(): string[] {
  return CREDENTIALS.credentials.filter((c) => c.kind !== "background").map((c) => c.title);
}

/** The track record as Markdown bullets (llms-full.txt), from the same record /about renders. */
export function credentialLines(): string[] {
  return CREDENTIALS.credentials.map((c) => {
    const when = c.whenLabel ? ` ${c.whenLabel}.` : "";
    const link = c.link ? ` ${c.link.label}: ${c.link.url}` : "";
    return `- ${c.title}: ${c.detail}${when}${link}`;
  });
}

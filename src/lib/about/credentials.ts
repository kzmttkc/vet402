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
};

export type AboutCredentials = {
  revision: string;
  builder: {
    builderName: string;
    publicName: string;
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
    credentials.push({
      id,
      kind: kind as Credential["kind"],
      title: row.title as string,
      detail: row.detail as string,
      when: row.when as string,
      whenLabel: row.whenLabel as string,
      link,
    });
  }
  const b = builder as Record<string, unknown>;
  for (const key of ["builderName", "publicName", "publisher"] as const) {
    if (typeof b[key] !== "string" || !b[key]) {
      throw new Error(`credentials.json: builder.${key} must be a non-empty string`);
    }
  }
  return {
    revision,
    builder: {
      builderName: b.builderName as string,
      publicName: b.publicName as string,
      publisher: b.publisher as string,
    },
    credentials,
  };
}

export const CREDENTIALS: AboutCredentials = validateCredentials(raw);

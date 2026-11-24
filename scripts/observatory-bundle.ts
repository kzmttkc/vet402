// ============================================================
// 公開観測データだけの再計算バンドル（鍵なし・DB なし）。
//
//   npx tsx scripts/observatory-bundle.ts --fetch --out public/data/observatory-bundle/YYYY-MM-DD [--prev-manifest path/to/manifest.json]
//
// --fetch のときだけ https://vet402.com へ平文の GET を出す。環境変数は読まない。
// 日次ファイルは 7 秒空けて取る（anchors/day は 10 回/分）。429 は Retry-After を待ってやり直す。
// ============================================================
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { EXPORT_CSV_COLUMNS } from "../src/lib/observatory/export-columns";

const ORIGIN = "https://vet402.com";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 公開 export の見出しに、これらが一つでも入っていたら書かない。raw_ は接頭辞。 */
export const FORBIDDEN_HEADER_TOKENS = ["challenge_402", "payment_payload", "caller_hash", "raw_"] as const;
/** anchors/day のリクエスト間隔。10 回/分の上限より少ない。 */
export const DAY_REQUEST_GAP_MS = 7_000;
const MAX_429_RETRIES = 8;

export function headerLineOf(body: Buffer): string {
  const end = body.indexOf(0x0a);
  const slice = end === -1 ? body : body.subarray(0, end);
  return slice.toString("utf8").replace(/^\uFEFF/, "").replace(/\r$/, "");
}

/** 見出し行に禁止トークンが含まれるとき、そのトークンを返す。本文は見ない。 */
export function forbiddenHeaderTokens(headerLine: string): string[] {
  return FORBIDDEN_HEADER_TOKENS.filter((token) => headerLine.includes(token));
}

export function assertExportHeaderSafe(headerLine: string): void {
  const found = forbiddenHeaderTokens(headerLine);
  if (found.length > 0) {
    throw new Error(`export.csv header contains a column that must not be published: ${found.join(", ")}`);
  }
}

/** Retry-After が無ければ 7 秒。秒数か HTTP 日付。 */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return DAY_REQUEST_GAP_MS;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return DAY_REQUEST_GAP_MS;
}

export type DayIndexEntry = { day: string; source: string | null; verification: string | null };

export function dayIndexJson(entries: readonly DayIndexEntry[]): string {
  const days: Record<string, { source: string | null; verification: string | null }> = {};
  for (const entry of [...entries].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    days[entry.day] = { source: entry.source, verification: entry.verification };
  }
  return `${JSON.stringify({ days }, null, 2)}\n`;
}

const COLUMN_NOTES: Record<(typeof EXPORT_CSV_COLUMNS)[number], string> = {
  attempted_at: "attempt time in UTC, as YYYY-MM-DDTHH:MM:SSZ.",
  resource_key: "the resource the attempt targeted.",
  network: "CAIP-2 network. Blank when the attempt stopped before signing.",
  status: "ledger status of the attempt.",
  amount_units: "price the seller 402 asked for, in 6-decimal ledger units.",
  spent_units:
    "6-decimal ledger units signed for on the attempt (the amount put at stake), not units shown to have moved. A settle_failed row with no tx_hash still carries the price here.",
  tx_hash: "transaction hash when one is known.",
  http_status_paid: "HTTP status of the paid response.",
  latency_ms: "latency in milliseconds.",
  l2_schema: "L2 reading recorded at the time. This column keeps that recorded value.",
  held_reason:
    "why the row is held rather than counted against the seller. Values are settled_4xx, unsettled_4xx, or payer_unfunded. Blank when the row is counted. Added 2026-09-17.",
  request_body:
    "what the paid request carried. declared means the body the seller 402 declares was sent unedited. empty means {}. operator_example means an example body from the operator listing. none means the request was formed with no body. Blank means the row holds no record. Blank is not empty.",
  request_body_sha256:
    "lowercase hex SHA-256 of the exact bytes sent on declared rows and on operator_example rows. The body itself is not published.",
  settlement_source:
    "who named tx_hash. seller_claim means the paid response carried a settlement receipt. vet402_index means the settlements index found the transfer. circle_gateway means a Circle Gateway batch transaction stored beside the row. Blank when the row has no tx_hash and no Circle Gateway batch transaction.",
  request_query:
    "which URL the paid request used. declared, empty, refused, or blank when the row holds no record. Blank is not empty.",
  request_query_sha256:
    "lowercase hex SHA-256 of the appended form-urlencoded pairs on declared rows. The query string itself is not published.",
  confirmed_units:
    "units re-read on-chain as transferred. Equal to spent_units on settled rows and 0 on every other row, including settle_claimed rows awaiting re-read. 0 means no transfer has been confirmed. It does not mean a transfer was shown not to have happened.",
  purchase_id:
    "the purchase id (a UUID). It carries no payer, payee, or amount. It is the subject_id of that purchase in /api/v1/observatory/corrections.",
  l2_reading:
    "l2_schema read again with today's rules. The record page and the decision use this value. l2_schema keeps the value recorded at the time.",
  response_sha256:
    "lowercase hex SHA-256 of the paid response body bytes vet402 read. The body itself is not published. Blank when the row holds no record. Filled only when vet402 read the paid response body through to the end (not when the read hit the cap or stopped partway).",
  response_bytes:
    "byte length of that same body sequence. 0 means an empty body was read. Blank when the row holds no record. Filled only when vet402 read the paid response body through to the end (not when the read hit the cap or stopped partway).",
};

export function bundleReadme(retrievedDay: string | null): string {
  for (const column of EXPORT_CSV_COLUMNS) {
    if (!COLUMN_NOTES[column]) throw new Error(`missing column note: ${column}`);
  }
  const day = retrievedDay ?? "YYYY-MM-DD";
  const columnList = EXPORT_CSV_COLUMNS.map((column) => `\`${column}\``).join(", ");
  const notes = EXPORT_CSV_COLUMNS.map((column) => `- \`${column}\`: ${COLUMN_NOTES[column]}`).join("\n");
  return `# Observatory recompute bundle

This directory is a keyless copy of public vet402 observatory files for one retrieval. The measurements are CC BY 4.0. See LICENSE-DATA in the vet402 repository. Full terms: https://creativecommons.org/licenses/by/4.0/

Attribute the source as: KIZUNA Creation. vet402 observatory. Dataset, retrieved ${day}. https://vet402.com/api/v1/observatory/export.csv

## Files

- \`export.csv\` is the purchase ledger from GET /api/v1/observatory/export.csv?days=366, saved as the server sent it.
- \`anchors.json\` is GET /api/v1/observatory/anchors?days=366, saved as the server sent it. Each row has \`day\`, \`rootHash\`, and \`prevRoot\`.
- \`days/<YYYY-MM-DD>.json\` is GET /api/v1/observatory/anchors/day?day=YYYY-MM-DD, saved byte for byte.
- \`days/index.json\` records the response headers \`x-vet402-day-source\` and \`x-vet402-day-verification\` for each day file.
- \`state.json\` is GET /api/v1/observatory/state, saved as the server sent it.
- \`history.json\` is GET /api/v1/observatory/history with default parameters, saved as the server sent it.
- \`SHA256SUMS\` is the SHA-256 of every file in this directory except \`SHA256SUMS\` itself. Two spaces separate the digest and the relative path.
- \`manifest.json\` lists every other file with sha256, byte count and line count, and links to the previous snapshot's manifest when \`--prev-manifest\` is passed.
- \`verify.mjs\` checks \`SHA256SUMS\`, recomputes each day root, and checks that each later day's \`prevRoot\` matches the previous day's \`rootHash\`.
- \`README.md\` is this note.

## export.csv columns

The header is the frozen column list from src/lib/observatory/export-columns.ts (\`EXPORT_CSV_COLUMNS\`). Columns are only added at the end. The default export has these ${EXPORT_CSV_COLUMNS.length} names, in order:

${columnList}.

\`erc8004_agent\` is not in the default file. It is appended only when the request sets \`include=erc8004_agent\`.

Column notes, taken from \`EXPORT_CSV_COLUMN_NOTES\` and the export route:

${notes}

Full definitions: https://vet402.com/openapi.yaml

## Recompute

For each day, take \`prevRoot\` from that day's row in \`anchors.json\`. When \`prevRoot\` is null, use the text genesis.

\`\`\`
root = sha256((prevRoot or "genesis") + "\\n" + day file bytes)
\`\`\`

The hash is lowercase hex SHA-256. The newline is one LF byte (U+000A) between the previous-root text and the raw file bytes. The day file bytes are \`days/<day>.json\` with nothing added and no JSON rewrite.

A later day is linked when its \`prevRoot\` equals the \`rootHash\` of the day before it in \`anchors.json\`, after sorting days ascending. The oldest day in the file has no earlier day inside the file. Its \`prevRoot\` is the link from outside the file. Null means genesis. That outside value is not compared with a day that was not downloaded.

Days whose \`x-vet402-day-source\` is \`current\` were sealed before 2026-11-23 and changed later, so they do not recompute and their sealed bytes were not kept.

\`node verify.mjs\` prints one line per day, then a summary. The line ends with \`ok\`, \`drift (source=current)\`, or \`FAIL\`. The process exits 0 when every day with source \`sealed\` recomputes and links, and every SHA256SUMS line matches. It exits 1 otherwise.
`;
}

const VERIFY_MJS = [
  "// Recompute vet402 day roots from this directory.",
  "// root = sha256((prevRoot or \"genesis\") + \"\\n\" + day file bytes)",
  "// No dependencies. Exit 0 when every sealed day recomputes and links and SHA256SUMS matches.",
  "import { createHash } from \"node:crypto\";",
  "import { readFileSync, readdirSync, statSync } from \"node:fs\";",
  "import { dirname, join, relative } from \"node:path\";",
  "import { fileURLToPath } from \"node:url\";",
  "",
  "const root = dirname(fileURLToPath(import.meta.url));",
  "",
  "function walk(dir, acc) {",
  "  for (const name of readdirSync(dir)) {",
  "    const abs = join(dir, name);",
  "    if (statSync(abs).isDirectory()) walk(abs, acc);",
  "    else acc.push(relative(root, abs).split(\"\\\\\").join(\"/\"));",
  "  }",
  "  return acc;",
  "}",
  "",
  "function sha256(buf) {",
  "  return createHash(\"sha256\").update(buf).digest(\"hex\");",
  "}",
  "",
  "function dayRoot(prevRoot, bytes) {",
  "  return createHash(\"sha256\").update(prevRoot ?? \"genesis\").update(\"\\n\").update(bytes).digest(\"hex\");",
  "}",
  "",
  "function failPath(rel) {",
  "  if (rel.startsWith(\"/\") || rel.split(\"/\").includes(\"..\")) return false;",
  "  return true;",
  "}",
  "",
  "let checksumsOk = true;",
  "const sumsText = readFileSync(join(root, \"SHA256SUMS\"), \"utf8\");",
  "const listed = new Set();",
  "for (const line of sumsText.split(\"\\n\")) {",
  "  if (!line) continue;",
  "  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);",
  "  if (!match || !failPath(match[2])) {",
  "    console.log(\"FAIL SHA256SUMS\");",
  "    checksumsOk = false;",
  "    continue;",
  "  }",
  "  listed.add(match[2]);",
  "  const got = sha256(readFileSync(join(root, match[2])));",
  "  if (got !== match[1]) {",
  "    console.log(\"FAIL \" + match[2]);",
  "    checksumsOk = false;",
  "  }",
  "}",
  "for (const rel of walk(root, []).filter((p) => p !== \"SHA256SUMS\" && p !== \"manifest.json\").sort()) {",
  "  if (!listed.has(rel)) {",
  "    console.log(\"FAIL \" + rel);",
  "    checksumsOk = false;",
  "  }",
  "}",
  "",
  "const anchorsDoc = JSON.parse(readFileSync(join(root, \"anchors.json\"), \"utf8\"));",
  "if (!anchorsDoc || !Array.isArray(anchorsDoc.anchors)) {",
  "  console.log(\"FAIL anchors.json\");",
  "  process.exit(1);",
  "}",
  "const rows = anchorsDoc.anchors.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));",
  "const indexDoc = JSON.parse(readFileSync(join(root, \"days\", \"index.json\"), \"utf8\"));",
  "const table = indexDoc && indexDoc.days && typeof indexDoc.days === \"object\" ? indexDoc.days : {};",
  "let ok = 0;",
  "let drift = 0;",
  "let fail = 0;",
  "for (let i = 0; i < rows.length; i++) {",
  "  const row = rows[i];",
  "  const meta = table[row.day] || null;",
  "  const source = meta && typeof meta.source === \"string\" ? meta.source : null;",
  "  const linked = i === 0 ? true : row.prevRoot === rows[i - 1].rootHash;",
  "  let bytes = null;",
  "  try {",
  "    bytes = readFileSync(join(root, \"days\", row.day + \".json\"));",
  "  } catch {",
  "    bytes = null;",
  "  }",
  "  const recomputed = bytes ? dayRoot(row.prevRoot ?? null, bytes) : null;",
  "  const matches = bytes !== null && recomputed === row.rootHash && linked;",
  "  if (source === \"current\") {",
  "    console.log(row.day + \" drift (source=current)\");",
  "    drift++;",
  "    continue;",
  "  }",
  "  if (source === \"sealed\" && matches) {",
  "    console.log(row.day + \" ok\");",
  "    ok++;",
  "    continue;",
  "  }",
  "  console.log(row.day + \" FAIL\");",
  "  fail++;",
  "}",
  "console.log(\"summary ok=\" + ok + \" drift=\" + drift + \" fail=\" + fail);",
  "process.exit(checksumsOk && fail === 0 ? 0 : 1);",
  "",
].join("\n");

export function listBundleFiles(outDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(outDir, abs).split(sep).join("/"));
    }
  };
  walk(outDir);
  out.sort();
  return out;
}

export type ManifestFileEntry = { path: string; sha256: string; bytes: number; lines: number };

export type ObservatoryManifest = {
  retrieved: string | null;
  prev_manifest_sha256: string | null;
  chain_length: number;
  files: ManifestFileEntry[];
};

const MANIFEST_NAME = "manifest.json";

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256FilePath(absPath: string): string {
  return sha256Buffer(readFileSync(absPath));
}

/** Line count = LF-separated records; a final line without LF still counts. */
export function lineCountOf(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) lines++;
  }
  if (buf[buf.length - 1] !== 0x0a) lines++;
  return lines;
}

export function manifestFileEntry(outDir: string, rel: string): ManifestFileEntry {
  const abs = join(outDir, ...rel.split("/"));
  const buf = readFileSync(abs);
  return { path: rel, sha256: sha256Buffer(buf), bytes: buf.length, lines: lineCountOf(buf) };
}

export function bundlePathsForManifest(outDir: string): string[] {
  return listBundleFiles(outDir)
    .filter((rel) => rel !== MANIFEST_NAME)
    .sort();
}

export function readObservatoryManifest(manifestPath: string): ObservatoryManifest {
  const doc = JSON.parse(readFileSync(manifestPath, "utf8")) as ObservatoryManifest;
  if (!doc || !Array.isArray(doc.files)) throw new Error("manifest.json has no files array");
  return doc;
}

export function chainLengthFromPrev(prev: ObservatoryManifest | null): number {
  if (!prev) return 1;
  const n = prev.chain_length;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error("previous manifest has no valid chain_length");
  return n + 1;
}

export function buildObservatoryManifest(outDir: string, prevManifestPath?: string): ObservatoryManifest {
  const base = basename(outDir);
  let prev: ObservatoryManifest | null = null;
  let prevManifestSha: string | null = null;
  if (prevManifestPath) {
    prevManifestSha = sha256FilePath(prevManifestPath);
    prev = readObservatoryManifest(prevManifestPath);
  }
  const files = bundlePathsForManifest(outDir).map((rel) => manifestFileEntry(outDir, rel));
  return {
    retrieved: DAY_RE.test(base) ? base : null,
    prev_manifest_sha256: prevManifestSha,
    chain_length: chainLengthFromPrev(prev),
    files,
  };
}

export function writeObservatoryManifest(outDir: string, prevManifestPath?: string): ObservatoryManifest {
  const doc = buildObservatoryManifest(outDir, prevManifestPath);
  writeFileSync(join(outDir, MANIFEST_NAME), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/** Throws when the manifest's prev link does not match the file at prevManifestPath. */
export function verifyManifestChain(manifestPath: string, prevManifestPath: string): void {
  const doc = readObservatoryManifest(manifestPath);
  const got = sha256FilePath(prevManifestPath);
  if (doc.prev_manifest_sha256 !== got) {
    throw new Error(`manifest chain broken: prev_manifest_sha256 does not match ${prevManifestPath}`);
  }
  const prev = readObservatoryManifest(prevManifestPath);
  if (doc.chain_length !== chainLengthFromPrev(prev)) {
    throw new Error(
      `manifest chain_length ${doc.chain_length} is not one more than the previous manifest (${prev.chain_length})`,
    );
  }
}

/** Re-read each file in the manifest and confirm sha256, bytes and lines. */
export function verifyManifestFileStats(outDir: string, manifestPath = join(outDir, MANIFEST_NAME)): void {
  const doc = readObservatoryManifest(manifestPath);
  for (const entry of doc.files) {
    const abs = join(outDir, ...entry.path.split("/"));
    const buf = readFileSync(abs);
    const sha256 = sha256Buffer(buf);
    const bytes = buf.length;
    const lines = lineCountOf(buf);
    if (sha256 !== entry.sha256 || bytes !== entry.bytes || lines !== entry.lines) {
      throw new Error(`manifest entry stale for ${entry.path}`);
    }
  }
}

export function writeBundleSidecars(outDir: string, prevManifestPath?: string): void {
  const base = basename(outDir);
  writeFileSync(join(outDir, "README.md"), bundleReadme(DAY_RE.test(base) ? base : null));
  writeFileSync(join(outDir, "verify.mjs"), VERIFY_MJS);
  const files = listBundleFiles(outDir).filter((rel) => rel !== "SHA256SUMS" && rel !== MANIFEST_NAME);
  const lines = files.map((rel) => {
    const digest = sha256Buffer(readFileSync(join(outDir, ...rel.split("/"))));
    return `${digest}  ${rel}`;
  });
  writeFileSync(join(outDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  writeObservatoryManifest(outDir, prevManifestPath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicUrl(pathAndQuery: string): string {
  const url = new URL(pathAndQuery, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error(`refusing non-public origin: ${url.origin}`);
  if (url.protocol !== "https:") throw new Error(`refusing non-https URL: ${url.protocol}`);
  return url.toString();
}

async function getBytes(url: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "*/*", "user-agent": "vet402-observatory-bundle" },
    });
    if (res.status >= 300 && res.status < 400) throw new Error(`refusing redirect from ${url}`);
    if (res.status === 429) {
      if (attempt === MAX_429_RETRIES) throw new Error(`rate limited: ${url}`);
      const wait = retryAfterMs(res.headers.get("retry-after"));
      console.error(`429 ${url} waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers };
  }
  throw new Error(`unreachable ${url}`);
}

function requireOk(url: string, status: number, body: Buffer): void {
  if (status === 200) return;
  const snippet = body.subarray(0, 180).toString("utf8").replace(/\s+/g, " ");
  throw new Error(`${url} returned ${status}: ${snippet}`);
}

type AnchorRow = { day: string; rootHash: string; prevRoot: string | null };

function anchorRows(body: Buffer): AnchorRow[] {
  const doc = JSON.parse(body.toString("utf8")) as { anchors?: unknown };
  if (!doc || !Array.isArray(doc.anchors)) throw new Error("anchors.json has no anchors array");
  const rows: AnchorRow[] = [];
  for (const row of doc.anchors) {
    if (!row || typeof row !== "object") throw new Error("anchor row is not an object");
    const day = (row as { day?: unknown }).day;
    const rootHash = (row as { rootHash?: unknown }).rootHash;
    const prevRoot = (row as { prevRoot?: unknown }).prevRoot;
    if (typeof day !== "string" || !DAY_RE.test(day)) throw new Error(`bad anchor day: ${String(day)}`);
    if (typeof rootHash !== "string" || !/^[0-9a-f]{64}$/.test(rootHash)) throw new Error(`bad rootHash for ${day}`);
    if (prevRoot !== null && typeof prevRoot !== "string") throw new Error(`bad prevRoot for ${day}`);
    rows.push({ day, rootHash, prevRoot });
  }
  return rows;
}

async function fetchBundle(outDir: string, prevManifestPath?: string): Promise<void> {
  mkdirSync(join(outDir, "days"), { recursive: true });

  const exportUrl = publicUrl("/api/v1/observatory/export.csv?days=366");
  const exported = await getBytes(exportUrl);
  requireOk(exportUrl, exported.status, exported.body);
  assertExportHeaderSafe(headerLineOf(exported.body));
  writeFileSync(join(outDir, "export.csv"), exported.body);

  await sleep(DAY_REQUEST_GAP_MS);
  const stateUrl = publicUrl("/api/v1/observatory/state");
  const state = await getBytes(stateUrl);
  requireOk(stateUrl, state.status, state.body);
  writeFileSync(join(outDir, "state.json"), state.body);

  await sleep(DAY_REQUEST_GAP_MS);
  const historyUrl = publicUrl("/api/v1/observatory/history");
  const history = await getBytes(historyUrl);
  if (history.status === 200) {
    writeFileSync(join(outDir, "history.json"), history.body);
  } else if (history.status === 404) {
    console.error("history endpoint absent; not included in bundle");
  } else {
    requireOk(historyUrl, history.status, history.body);
  }

  await sleep(DAY_REQUEST_GAP_MS);
  const anchorsUrl = publicUrl("/api/v1/observatory/anchors?days=366");
  const anchors = await getBytes(anchorsUrl);
  requireOk(anchorsUrl, anchors.status, anchors.body);
  const rows = anchorRows(anchors.body);
  writeFileSync(join(outDir, "anchors.json"), anchors.body);

  const days = [...new Set(rows.map((row) => row.day))].sort();
  const index: DayIndexEntry[] = [];
  for (let i = 0; i < days.length; i++) {
    if (i > 0) await sleep(DAY_REQUEST_GAP_MS);
    const day = days[i]!;
    const dayUrl = publicUrl(`/api/v1/observatory/anchors/day?day=${day}`);
    const res = await getBytes(dayUrl);
    requireOk(dayUrl, res.status, res.body);
    writeFileSync(join(outDir, "days", `${day}.json`), res.body);
    index.push({
      day,
      source: res.headers.get("x-vet402-day-source"),
      verification: res.headers.get("x-vet402-day-verification"),
    });
    console.error(`saved ${day} source=${res.headers.get("x-vet402-day-source") ?? ""}`);
  }
  writeFileSync(join(outDir, "days", "index.json"), dayIndexJson(index));
  writeBundleSidecars(outDir, prevManifestPath);
  console.error(`wrote ${outDir}`);
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

function cliArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const fetch = process.argv.includes("--fetch");
  const out = cliArg("--out");
  const prevManifest = cliArg("--prev-manifest");
  const checkChain = process.argv.includes("--check-chain");
  const manifest = cliArg("--manifest");
  if (checkChain) {
    if (!manifest || !prevManifest) {
      console.error("usage: npx tsx scripts/observatory-bundle.ts --check-chain --manifest dir/manifest.json --prev-manifest prev/manifest.json");
      process.exit(1);
    }
    verifyManifestChain(manifest, prevManifest);
    return;
  }
  if (!fetch || !out) {
    console.error(
      "usage: npx tsx scripts/observatory-bundle.ts --fetch --out public/data/observatory-bundle/YYYY-MM-DD [--prev-manifest path]",
    );
    process.exit(1);
  }
  await fetchBundle(out, prevManifest);
}

if (runningAsCli()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

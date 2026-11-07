import { unstable_cache } from "next/cache";

const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-month/@vet402/sdk";
const EXPECTED_PACKAGE = "@vet402/sdk";

export type NpmDownloadsRead = {
  downloads: number;
  start: string;
  end: string;
  readAt: string;
};

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function formatReadAtUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${min} UTC`;
}

/** Parse and validate npm downloads API JSON. Exported for unit tests. */
export function parseNpmDownloadsBody(
  body: unknown,
  readAt: string,
): NpmDownloadsRead | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (row.package !== EXPECTED_PACKAGE) return null;
  const downloads = row.downloads;
  if (typeof downloads !== "number" || !Number.isFinite(downloads) || downloads < 0) return null;
  if (!isYmd(row.start) || !isYmd(row.end)) return null;
  return {
    downloads,
    start: row.start,
    end: row.end,
    readAt,
  };
}

// unstable_cache は戻り値をそのまま 24 時間預ける。失敗の null まで預けると、npm が一度落ちただけで
// 1 日「Download counts are on npm」になるので、中では投げて、外で null に倒す（/accuracy と同じ扱い）。
async function fetchNpmDownloadsUncached(): Promise<NpmDownloadsRead> {
  const readAt = formatReadAtUtc(new Date());
  // キャッシュは外の unstable_cache の 1 層だけ。fetch 側にも窓を持たせると、作り直した readAt に古い本文が付く。
  const res = await fetch(NPM_DOWNLOADS_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`npm downloads API answered ${res.status}`);
  const parsed = parseNpmDownloadsBody(await res.json(), readAt);
  if (!parsed) throw new Error("npm downloads API answered an unexpected body");
  return parsed;
}

const fetchNpmDownloadsCached = unstable_cache(
  fetchNpmDownloadsUncached,
  ["about:npm-downloads:v1"],
  { revalidate: 86400 },
);

export function fetchSdkDownloads(): Promise<NpmDownloadsRead | null> {
  return fetchNpmDownloadsCached().catch(() => null);
}

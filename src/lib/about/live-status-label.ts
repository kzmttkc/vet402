const FORTY_EIGHT_H_MS = 48 * 60 * 60 * 1000;
// 統計の readAt と購入例は別のキャッシュ（どちらも PUBLIC_READ_REVALIDATE の 300 秒）から来るので、
// 購入例の方が新しく埋まると age が負になる。その窓の分だけ未来側を許す。
const CACHE_SKEW_MS = 5 * 60 * 1000;

function purchaseDateYmd(iso: string | null): string | null {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : null;
}

function parseInstant(iso: string | null): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Home head / HomeIntro status line from the newest purchase time and the observatory read time.
 */
export function liveStatusLabel(latestPurchaseAt: string | null, readAt: string | null): string {
  const readMs = parseInstant(readAt);
  const purchaseMs = parseInstant(latestPurchaseAt);
  if (readMs !== null && purchaseMs !== null) {
    const age = readMs - purchaseMs;
    if (age >= -CACHE_SKEW_MS && age <= FORTY_EIGHT_H_MS) {
      return "Live, buying daily";
    }
  }
  const ymd = purchaseDateYmd(latestPurchaseAt);
  if (ymd) {
    return `Live, last purchase ${ymd}`;
  }
  return "Independent Measurement";
}

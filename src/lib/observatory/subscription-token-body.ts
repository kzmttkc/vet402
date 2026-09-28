// ============================================================
// 確定・配信停止の POST 本文の読み方（2026-09-28 監査）。
//
// JSON（頁のボタン）と application/x-www-form-urlencoded（RFC 8058 の one-click。
// 本文は `List-Unsubscribe=One-Click` だけで、id と token は URL 側に乗る）の両方を読む。
// 空本文も許す（one-click 実装の揺れ）。読めない本文だけ null。
// ============================================================

export type TokenBody = { id?: string; token?: string };

export async function readTokenBody(request: Request): Promise<TokenBody | null> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  if (raw.trim() === "") return {};
  if (type.includes("application/json")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (!j || typeof j !== "object" || Array.isArray(j)) return null;
      return {
        ...(typeof j.id === "string" ? { id: j.id } : {}),
        ...(typeof j.token === "string" ? { token: j.token } : {}),
      };
    } catch {
      return null;
    }
  }
  const form = new URLSearchParams(raw);
  const id = form.get("id");
  const token = form.get("token") ?? form.get("t");
  return { ...(id ? { id } : {}), ...(token ? { token } : {}) };
}

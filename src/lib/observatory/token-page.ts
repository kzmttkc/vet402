// ============================================================
// 確認・配信停止の頁のトークン（メールのリンクの # の後ろ）を解析へ渡さない（2026-11-02 監査 L1）。
//
// # はサーバには届かないが、Plausible の script は location.href を # ごと送る。layout.tsx は
// 全頁に script を入れる（tests/seo-audit-1026.test.ts が layout を origin/main と同じに保つので、
// 頁ごとに外せない）。だから 2 重にする:
//   1. TOKEN_STASH_SCRIPT: 頁の HTML の中の inline script。Next の afterInteractive で後から入る
//      解析の script より必ず前に走り、# を URL から消して sessionStorage へ移す
//   2. src/proxy.ts: この 2 頁だけ connect-src から plausible.io を外す（1 が走らなくても送れない）
// どの頁かの正典は src/lib/clarity.ts の clarityTokenPath（Clarity も同じ 2 頁で動かない）。
// ============================================================

const STASH_KEY_PREFIX = "vet402-link:";
const WINDOW_KEY = "__vet402LinkHash";

/** 同じタブの再読み込みでも読めるよう sessionStorage へ。使えないブラウザでは window に持つ。 */
export const TOKEN_STASH_SCRIPT = `(function(){try{var h=location.hash;if(!h||h.length<2)return;window.${WINDOW_KEY}=h;try{sessionStorage.setItem(${JSON.stringify(STASH_KEY_PREFIX)}+location.pathname,h)}catch(e){}history.replaceState(null,"",location.pathname)}catch(e){}})();`;

type LinkWindow = Pick<Window, "location" | "sessionStorage"> & { [WINDOW_KEY]?: string };

function stored(win: LinkWindow): string {
  try {
    return win.sessionStorage.getItem(`${STASH_KEY_PREFIX}${win.location.pathname}`) ?? "";
  } catch {
    return "";
  }
}

/** メールのリンクの # の中身。script が走らなかった頁では URL の # をそのまま返す。 */
export function readLinkHash(win: Window): string {
  const w = win as unknown as LinkWindow;
  return w.location.hash || w[WINDOW_KEY] || stored(w);
}

export function clearLinkHash(win: Window): void {
  const w = win as unknown as LinkWindow;
  delete w[WINDOW_KEY];
  try {
    w.sessionStorage.removeItem(`${STASH_KEY_PREFIX}${w.location.pathname}`);
  } catch {
    // 使えないブラウザには残っていない
  }
}

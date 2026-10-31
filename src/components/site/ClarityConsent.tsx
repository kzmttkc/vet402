"use client";

/**
 * Microsoft Clarity の読み込みと同意の帯（2026-10-31 オーナー承認）。判定は src/lib/clarity.ts。
 *
 * - projectId が null（NEXT_PUBLIC_CLARITY_PROJECT_ID 未設定）なら何も描かず、何も読み込まない。
 * - 同意が要る地域（EEA・UK・スイス・国不明）は、Accept を押すまでタグを入れない。
 * - それ以外は既定で読み込む。Privacy choices（ポリシーの #privacy-choices）から帯を開き直して止められる。
 * - GPC のブラウザでは読み込まない。
 * - トークンの頁（/observatory/confirm・/observatory/unsubscribe）: 帯もタグも出さない。別の頁で動き出した
 *   Clarity のまま移ってきたら頁を読み直す。
 * - 凍結面（/rwa・/tokyo・/ethonline）: 帯もタグも出さないだけ（読み直さない）。
 * - トークンの頁か凍結面から始まった文書は、CSP に Clarity が無いので、その文書の間はタグを入れない。
 *   帯と Privacy choices はその文書でも動き、Accept は頁を読み直して効かせる。
 * - 撤回（読み込み済みでの Decline）は consentv2 を呼ばず、cookie に denied を書いた直後に読み直す。
 *   読み直した denied の頁で _clck・_clsk を最上位ドメインとホスト名の両方で期限切れにする。
 * - root template に置くので、頁を移るたびにマウントし直す。server から来る国と cookie は最初の
 *   読み込みの値で固まるため、選択は document.cookie とこのモジュールの変数を server の値より先に読む。
 * - 帯はマウントの後にだけ描く（server と client の最初の描画を一致させる。GPC・cookie を client で読むため）。
 * - 帯は公開面の紙面のトークン（bg-paper・border-hair・text-brand）と buttonClass だけで組む。
 *   Accept と Decline は同じ大きさ・同じ系統。帯が出ている間は body の下に同じ高さの余白を置く。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { buttonClass } from "@/components/ui/Button";
import {
  BANNER_TEXT_CONSENT_REQUIRED,
  BANNER_TEXT_DEFAULT_ON,
  CLARITY_CONSENT_COOKIE,
  CLARITY_CONSENT_MAX_AGE,
  PRIVACY_CHOICES_EVENT,
  choiceFromCookieString,
  clarityCookieExpiries,
  clarityExcludedPath,
  clarityLoaded,
  clarityPlan,
  clarityProjectId,
  clarityTokenPath,
  startClarity,
  type ConsentChoice,
} from "@/lib/clarity";

/** この頁（読み直すまで）の中で選ばれた答え。template の再マウントをまたいで残る。 */
let pageChoice: ConsentChoice | null = null;
/**
 * この文書を読み込んだ時の頁。このモジュールは root template の一部として最初の読み込みで評価されるので、
 * ここで読む location がその文書の最初の頁。除外の頁から始まった文書は CSP に Clarity が無い。
 */
let documentStartPath: string | null = typeof window !== "undefined" ? window.location.pathname : null;

/** テスト用。モジュールの変数を、startPath の頁を読み直した直後の状態に戻す。 */
export function resetClarityPageChoiceForTests(startPath: string = "/") {
  pageChoice = null;
  documentStartPath = startPath;
}

type ClarityWin = Parameters<typeof startClarity>[0]["win"];

function currentChoice(fromServer: ConsentChoice | null): ConsentChoice | null {
  if (pageChoice) return pageChoice;
  if (typeof document !== "undefined") {
    try {
      const c = choiceFromCookieString(document.cookie);
      if (c) return c;
    } catch {
      // cookie が読めない環境は server の値に任せる。
    }
  }
  return fromServer;
}

function browserGpc(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

function browserEnv() {
  return {
    win: window as unknown as ClarityWin,
    insertScript: (src: string) => {
      const s = document.createElement("script");
      s.async = true;
      s.src = src;
      document.head.appendChild(s);
    },
  };
}

function saveChoice(choice: ConsentChoice) {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${CLARITY_CONSENT_COOKIE}=${choice}; Max-Age=${CLARITY_CONSENT_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // cookie が書けない環境でも、この頁の中の選択は pageChoice で効かせる。
  }
}

function expireClarityCookies() {
  try {
    for (const c of clarityCookieExpiries(window.location.hostname)) document.cookie = c;
  } catch {
    // cookie が書けない環境では消すものも無い。
  }
}

const noopSubscribe = () => () => {};

/** この文書の CSP に Clarity の読み込み先があるか（除外の頁から始まった文書には無い）。 */
function cspAllowsClarity(): boolean {
  return !clarityExcludedPath(documentStartPath);
}

type Props = {
  projectId: string | null;
  consentRequired: boolean;
  initialChoice: ConsentChoice | null;
  /** server が見た Sec-GPC。 */
  gpc?: boolean;
};

export function ClarityConsent(props: Props) {
  const pathname = usePathname();
  return <ClarityConsentView {...props} pathname={pathname ?? ""} />;
}

/** usePathname を外から渡せる本体（テストが直接描く）。 */
export function ClarityConsentView({
  projectId,
  consentRequired,
  initialChoice,
  gpc = false,
  pathname,
  reload,
}: Props & { pathname: string; reload?: () => void }) {
  const excluded = clarityExcludedPath(pathname);
  const tokenPage = clarityTokenPath(pathname);
  // server の HTML は帯を含まない。client はマウントの後に帯を決める（初回の描画を一致させる）。
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const [banner, setBanner] = useState(
    () =>
      clarityPlan({
        consentRequired,
        choice: currentChoice(initialChoice),
        gpc: gpc || browserGpc(),
      }).banner,
  );
  const bannerRef = useRef<HTMLDivElement>(null);

  const doReload = useCallback(() => {
    if (reload) reload();
    else window.location.reload();
  }, [reload]);

  useEffect(() => {
    if (!projectId) return;
    const win = window as unknown as ClarityWin;
    if (tokenPage) {
      // 別の頁で動き出した Clarity を、トークンの頁へ移った後も動かしたままにしない。
      if (clarityLoaded(win)) doReload();
      return;
    }
    if (excluded) return;
    const choice = currentChoice(initialChoice);
    if (choice === "denied" && !clarityLoaded(win)) expireClarityCookies();
    const plan = clarityPlan({ consentRequired, choice, gpc: gpc || browserGpc() });
    // 除外の頁から始まった文書は CSP に Clarity が無い。この文書の間は読み込まない
    // （帯と Privacy choices は動く。Accept は頁を読み直して効かせる）。
    if (plan.load && cspAllowsClarity()) startClarity(browserEnv(), projectId);
    const open = () => setBanner(true);
    window.addEventListener(PRIVACY_CHOICES_EVENT, open);
    return () => window.removeEventListener(PRIVACY_CHOICES_EVENT, open);
  }, [projectId, consentRequired, initialChoice, gpc, excluded, tokenPage, doReload]);

  const visible = mounted && Boolean(projectId) && !excluded && banner;

  // 帯と同じ高さの余白を body の下に置く（帯が出ている間だけ）。
  useEffect(() => {
    if (!visible) return;
    const el = bannerRef.current;
    if (!el) return;
    const apply = () => {
      document.body.style.paddingBottom = `${el.offsetHeight}px`;
    };
    apply();
    // ResizeObserver が無い・止まっている環境（背景のタブ等）でも、窓の大きさが変われば合わせ直す。
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
      document.body.style.paddingBottom = "";
    };
  }, [visible]);

  const choose = useCallback(
    (choice: ConsentChoice) => {
      pageChoice = choice;
      saveChoice(choice);
      setBanner(false);
      if (!projectId) return;
      const win = window as unknown as ClarityWin;
      if (choice === "granted") {
        if (gpc || browserGpc()) return;
        // この文書の CSP に Clarity が無ければ、読み直した頁（通常の CSP）で読み込む。
        if (!cspAllowsClarity()) doReload();
        else startClarity(browserEnv(), projectId);
        return;
      }
      if (clarityLoaded(win)) {
        // 撤回: consentv2 は呼ばずに読み直す。cookie は読み直した頁が消す。
        doReload();
      } else {
        expireClarityCookies();
      }
    },
    [projectId, gpc, doReload],
  );

  if (!visible) return null;

  const gpcOn = gpc || browserGpc();

  return (
    <div
      ref={bannerRef}
      role="region"
      aria-label="Privacy choices"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hair bg-paper px-4 py-3 text-[0.84375rem] text-brand sm:px-6 md:px-8"
    >
      <div className="mx-auto flex w-full max-w-[var(--column)] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:max-w-[1200px]">
        <p className="max-w-[72ch] leading-relaxed">
          {gpcOn
            ? "Your browser sends a Global Privacy Control signal, so vet402 does not load Microsoft Clarity and nothing is recorded."
            : consentRequired
              ? BANNER_TEXT_CONSENT_REQUIRED
              : BANNER_TEXT_DEFAULT_ON}{" "}
          <Link href="/legal/privacy#session-analytics" className="doc-link">
            Privacy policy
          </Link>
        </p>
        <div className="flex shrink-0 gap-3">
          {gpcOn ? (
            <button
              type="button"
              onClick={() => setBanner(false)}
              className={buttonClass({ variant: "secondary" })}
            >
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => choose("granted")}
                className={buttonClass({ variant: "secondary" })}
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => choose("denied")}
                className={buttonClass({ variant: "secondary" })}
              >
                Decline
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** ポリシーの #privacy-choices に置く入口。ID が無ければ、記録が動いていないことだけを書く。 */
export function PrivacyChoices() {
  const enabled = clarityProjectId(process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID) !== null;
  if (!enabled) {
    return <p>Session analytics is not running on vet402.com at the moment, so there is nothing to change.</p>;
  }
  return (
    <p>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(PRIVACY_CHOICES_EVENT))}
        className={buttonClass({ variant: "secondary" })}
      >
        Change privacy choices
      </button>
    </p>
  );
}

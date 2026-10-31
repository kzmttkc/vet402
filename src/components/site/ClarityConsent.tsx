"use client";

/**
 * Microsoft Clarity の読み込みと同意の帯（2026-10-31 オーナー承認）。判定は src/lib/clarity.ts。
 *
 * - projectId が null（NEXT_PUBLIC_CLARITY_PROJECT_ID 未設定）なら何も描かず、何も読み込まない。
 * - 同意が要る地域（EEA・UK・スイス・国不明）は、Accept を押すまでタグを入れない。
 * - それ以外は既定で読み込む。Privacy choices（ポリシーの #privacy-choices）から帯を開き直して止められる。
 * - 帯は公開面の紙面のトークン（bg-paper・border-hair・text-brand）と buttonClass だけで組む。
 *   Accept と Decline は同じ大きさ・同じ系統（どちらかを目立たせない）。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import {
  CLARITY_CONSENT_COOKIE,
  CLARITY_CONSENT_MAX_AGE,
  PRIVACY_CHOICES_EVENT,
  clarityPlan,
  clarityProjectId,
  startClarity,
  stopClarity,
  type ConsentChoice,
} from "@/lib/clarity";

function browserEnv() {
  return {
    win: window as unknown as Parameters<typeof startClarity>[0]["win"],
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
    // cookie が書けない環境でも、この頁の中の選択は効かせる。
  }
}

export function ClarityConsent({
  projectId,
  consentRequired,
  initialChoice,
}: {
  projectId: string | null;
  consentRequired: boolean;
  initialChoice: ConsentChoice | null;
}) {
  const [banner, setBanner] = useState(
    () => clarityPlan({ consentRequired, choice: initialChoice, gpc: false }).banner,
  );

  useEffect(() => {
    if (!projectId) return;
    const gpc =
      (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
    const plan = clarityPlan({ consentRequired, choice: initialChoice, gpc });
    if (plan.load) startClarity(browserEnv(), projectId);
    const open = () => setBanner(true);
    window.addEventListener(PRIVACY_CHOICES_EVENT, open);
    return () => window.removeEventListener(PRIVACY_CHOICES_EVENT, open);
  }, [projectId, consentRequired, initialChoice]);

  const choose = useCallback(
    (choice: ConsentChoice) => {
      saveChoice(choice);
      setBanner(false);
      if (!projectId) return;
      if (choice === "granted") startClarity(browserEnv(), projectId);
      else stopClarity(browserEnv().win);
    },
    [projectId],
  );

  if (!projectId || !banner) return null;

  return (
    <div
      role="region"
      aria-label="Privacy choices"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hair bg-paper px-4 py-3 text-[0.84375rem] text-brand sm:px-6 md:px-8"
    >
      <div className="mx-auto flex w-full max-w-[var(--column)] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:max-w-[1200px]">
        <p className="max-w-[72ch] leading-relaxed">
          vet402 can record how pages are used (clicks, scrolling, page layout) with Microsoft
          Clarity to find what is hard to use. Form fields and keys are masked. Nothing is recorded
          unless you accept.{" "}
          <Link href="/legal/privacy#session-analytics" className="doc-link">
            Privacy policy
          </Link>
        </p>
        <div className="flex shrink-0 gap-3">
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

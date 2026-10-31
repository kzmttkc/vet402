/**
 * Microsoft Clarity の入口（サーバー側）。layout.tsx から 1 か所で呼ぶ。
 * 国は Vercel の x-vercel-ip-country、前の選択は first-party cookie から読み、
 * 同意の帯を最初の HTML に含める（読み込み後に帯が跳ね出さない）。
 * NEXT_PUBLIC_CLARITY_PROJECT_ID が無ければ何も出さない。
 */

import { cookies, headers } from "next/headers";
import { ClarityConsent } from "@/components/site/ClarityConsent";
import {
  CLARITY_CONSENT_COOKIE,
  clarityProjectId,
  consentRequiredFor,
  parseConsentChoice,
} from "@/lib/clarity";

export async function ClarityTag() {
  const projectId = clarityProjectId(process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID);
  if (!projectId) return null;
  const [h, c] = await Promise.all([headers(), cookies()]);
  return (
    <ClarityConsent
      projectId={projectId}
      consentRequired={consentRequiredFor(h.get("x-vercel-ip-country"))}
      initialChoice={parseConsentChoice(c.get(CLARITY_CONSENT_COOKIE)?.value)}
    />
  );
}

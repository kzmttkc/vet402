import { ClarityTag } from "@/components/site/ClarityTag";

/**
 * 2026-10-31 Microsoft Clarity の入口（全頁に 1 か所）。
 *
 * layout.tsx ではなくここに置くのは、tests/seo-audit-1026.test.ts が layout.tsx を
 * 凍結面として origin/main と同じに保っているため。template は layout と頁の間に入り、
 * 自分の DOM を持たない。頁はこれまでどおり children として描かれる。
 * NEXT_PUBLIC_CLARITY_PROJECT_ID が無ければ ClarityTag は何も出さない。
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <ClarityTag />
    </>
  );
}

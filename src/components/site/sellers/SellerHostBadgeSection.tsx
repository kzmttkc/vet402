import CodeBlock from "@/components/docs/CodeBlock";
import { HOST_BADGE_HEIGHT } from "@/lib/badge/host-badge";
import { SITE_URL } from "@/lib/site-url";

/** Host-level embed badge and copy-paste snippets (2026-11-11). Loaded from the page, not SellersViews (node tests). */
export default function SellerHostBadgeSection({ host }: { host: string }) {
  return (
    <div className="mt-6">
      <p className="doc-p">
        Paste this badge on your page. It shows what vet402 received when it paid {host}, and links to this record.
      </p>
      <p className="mt-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/badge/host/${host}.svg`} alt={`vet402 record for ${host}`} height={HOST_BADGE_HEIGHT} />
      </p>
      <CodeBlock
        label="Host badge embed (Markdown)"
        code={`[![vet402 record for ${host}](${SITE_URL}/api/badge/host/${host}.svg)](${SITE_URL}/sellers/${host})`}
      />
      <CodeBlock
        className="mt-3"
        label="Host badge embed (HTML)"
        code={`<a href="${SITE_URL}/sellers/${host}"><img src="${SITE_URL}/api/badge/host/${host}.svg" alt="vet402 record for ${host}" height="38"></a>`}
      />
    </div>
  );
}

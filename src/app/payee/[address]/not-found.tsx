import Link from "next/link";
import { INVALID_PAYEE_DETAIL, INVALID_PAYEE_H1 } from "@/lib/payee/invalid-address-page";

// 2026-08-06 (UX audit item 8): PayeePage calls notFound() only when the
// address fails isValidAddress — a valid-but-unregistered wallet still renders
// the profile page ("not registered a profile"). So the ONLY way to land here
// is a malformed address (e.g. /payee/0x123), and Next's bare default 404 gave
// no hint why. This boundary names the actual problem — wrong address shape —
// shows the correct form, and offers a way forward instead of a dead end.
export default function PayeeNotFound() {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <article className="sheet">
        <div className="doc-head">
          <div className="doc-head-col">
            <span>Independent Measurement</span>
            <span>Status report</span>
          </div>
          <div className="doc-head-col">
            <span>vet402</span>
            <span>x402 Economy</span>
          </div>
        </div>

        <h1 className="doc-title mt-10">{INVALID_PAYEE_H1}</h1>
        <p className="mx-auto mt-3 max-w-[56ch] text-center text-brand-lift">
          {INVALID_PAYEE_DETAIL.split("0x")[0]}
          <code>0x</code>
          {INVALID_PAYEE_DETAIL.split("0x")[1]}
        </p>
        <div className="rule-double mx-auto mt-6 w-full max-w-[34ch]" />

        <p className="doc-caption mt-8">Correct form</p>
        <p className="mt-2 break-all font-mono text-[0.8125rem] text-brand-deep">
          /payee/0xd8da6bf26964af9d7eed9e03e53415d37aa96045
        </p>
        <p className="doc-p mt-6">
          Check the address for a typo or a truncated copy-paste, then try again. You can also{" "}
          <Link href="/payee" className="doc-link">
            verify a payee
          </Link>
          ,{" "}
          <Link href="/leaderboard" className="doc-link">
            browse recently verified agents
          </Link>
          , or read{" "}
          <Link href="/docs/api" className="doc-link">
            how scoring works
          </Link>
          .
        </p>
      </article>
    </main>
  );
}

import Link from "next/link";
import CodeBlock from "@/components/docs/CodeBlock";
import { buttonClass } from "@/components/ui/Button";
import { DEV_CODE, DEV_INSTALL, DEV_NOTE } from "./paths";

const DISPLAY = "font-[family-name:var(--font-display)]";

export function TwoPaths() {
  return (
    <section aria-labelledby="paths-home" className="mt-16 sm:mt-20">
      <h2 id="paths-home" className="sr-only">
        Two ways in
      </h2>
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-14">
        <div className="flex min-w-0 flex-col border-t border-brand-deep pt-5">
          <h3 className={`${DISPLAY} text-[1.25rem] font-semibold text-brand-deep`}>For agent developers</h3>
          <p className="mt-2 text-brand">The same facts, inside your agent. Three lines after the import.</p>
          <p className="mt-4 text-[0.8125rem] text-brand-deep">
            <code>{DEV_INSTALL}</code>
          </p>
          <CodeBlock className="mt-2" label="TypeScript: check an endpoint before paying" code={DEV_CODE} />
          <p className="doc-note mt-2">{DEV_NOTE}</p>
          <p className="mt-auto pt-6">
            <Link href="/docs/api" className={buttonClass({ variant: "secondary", size: "md", className: "w-full sm:w-auto" })}>
              Read the API reference
            </Link>
          </p>
        </div>
        <div className="flex min-w-0 flex-col border-t border-brand-deep pt-5">
          <h3 className={`${DISPLAY} text-[1.25rem] font-semibold text-brand-deep`}>For x402 sellers</h3>
          <p className="mt-2 text-brand">
            vet402 may already have bought from your API. Put your domain in the check above to see each purchase.
          </p>
          <dl className="mt-4 divide-y divide-hair border-y border-hair text-[0.875rem]">
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2.5">
              <dt className="text-brand-deep">See</dt>
              <dd className="text-brand">Each purchase, with its transaction and HTTP status.</dd>
            </div>
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2.5">
              <dt className="text-brand-deep">Show</dt>
              <dd className="text-brand">The receipt badge on your endpoint&apos;s record page.</dd>
            </div>
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2.5">
              <dt className="text-brand-deep">Dispute</dt>
              <dd className="text-brand">
                Any record, free, no account.{" "}
                <Link href="/corrections" className="doc-link">
                  Corrections log
                </Link>
              </dd>
            </div>
          </dl>
          <p className="mt-auto pt-6">
            <Link href="/legal/terms#corrections" className={buttonClass({ variant: "secondary", size: "md", className: "w-full sm:w-auto" })}>
              How to dispute a record
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

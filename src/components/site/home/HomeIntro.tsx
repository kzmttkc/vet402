import type { HomeLedger } from "@/components/site/HomeLedger";
import { fmt, lowestChainShareLine, type HomeExample } from "@/lib/observatory/home-example";
import { CheckPanel } from "./CheckPanel";
import { GapFigure } from "./GapFigure";
import { ReceiptSlip } from "./ReceiptSlip";
import { TwoPaths } from "./TwoPaths";

const DISPLAY = "font-[family-name:var(--font-display)]";

export function HomeIntro({
  ledger,
  readAt,
  settled4xx,
  example,
}: {
  ledger: HomeLedger | null;
  readAt: string | null;
  settled4xx: number | null;
  example: HomeExample | null;
}) {
  const big = `${DISPLAY} font-bold tracking-[-0.03em] text-brand-deep`;
  const share = ledger ? lowestChainShareLine(ledger.chains) : "";
  const paidNo2xx = ledger ? Math.max(0, ledger.settled - ledger.delivered) : 0;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-brand-deep pb-3 text-[0.8125rem] text-brand-lift">
        <span className="text-brand-deep">Request for Verification: 402</span>
        <span>
          Status: <span className="text-signal">Building in public</span>
        </span>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-10 sm:mt-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:grid-rows-[auto_1fr] lg:gap-x-14 lg:gap-y-8">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <h1 className={`${DISPLAY} text-[clamp(1.75rem,4.2vw,2.75rem)] font-semibold leading-[1.16] tracking-[-0.025em] text-brand-deep`}>
            <span className="block">Paid is on chain.</span>
            <span className="block">Delivered is not.</span>
          </h1>
          <p className="mt-5 max-w-[50ch] text-[0.9375rem] leading-[1.7] text-brand sm:text-[1.0625rem]">
            x402 proves that an agent paid. Nothing in x402 proves that the API delivered. vet402 buys from x402 APIs itself and
            publishes what came back, so you can check a seller before your agent pays it.
          </p>
        </div>
        <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <CheckPanel example={example} />
        </div>
        <figure className="min-w-0 border-t border-hair pt-5 lg:col-start-1 lg:row-start-2 lg:self-start">
          <GapFigure id="home-gap" compact className="max-w-[480px]" />
          <figcaption className="doc-note mt-3 max-w-[56ch]">
            <span className="text-brand-deep">Figure 1.</span> Where the proof stops. Step 4 leaves a transaction. Step 5 leaves
            nothing, so vet402 records it.
          </figcaption>
        </figure>
      </div>

      {ledger && readAt ? (
        <section aria-labelledby="ledger-home" className="mt-16 border-t border-brand-deep pt-6 sm:mt-20">
          <h2 id="ledger-home" className="sr-only">
            The whole ledger
          </h2>
          <p className="max-w-[40ch] text-[1.125rem] leading-[1.5] text-brand sm:text-[1.375rem]">
            <span className={`${big} text-[clamp(2.75rem,6vw,4rem)] leading-none`}>{fmt(paidNo2xx)}</span> of{" "}
            <span className={`${big} text-[clamp(1.5rem,3vw,2rem)]`}>{fmt(ledger.settled)}</span> settled purchases got no 2xx
            answer.
          </p>
          <p className="doc-note mt-4 max-w-[96ch]">
            Whole ledger, read{" "}
            <time dateTime={readAt}>
              {ledger.readDate} {ledger.readTime} UTC
            </time>
            : {fmt(ledger.attempts)} paid attempts, {fmt(ledger.settled)} settled, {fmt(ledger.delivered)} answered 2xx.
            {share}
            {settled4xx !== null
              ? ` ${fmt(settled4xx)} answered 4xx, held as inconclusive because a 4xx can come from the shape of vet402's request.`
              : ""}{" "}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/api/v1/observatory/state" className="doc-link">
              Source
            </a>{" "}
            (CC BY 4.0).
          </p>
        </section>
      ) : null}

      {example ? <ReceiptSlip receipt={example.receipt} /> : null}

      <TwoPaths />
    </>
  );
}

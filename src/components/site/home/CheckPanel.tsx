import TrackedLink from "@/components/site/TrackedLink";
import { buttonClass } from "@/components/ui/Button";
import { fmt, utc, type HomeExample } from "@/lib/observatory/home-example";

const DISPLAY = "font-[family-name:var(--font-display)]";

function VerdictMark({ status }: { status: string }) {
  const s = status.toLowerCase();
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="mr-2 inline-block h-3 w-3 align-[-1px]">
      {s === "pass" ? (
        <rect x="1" y="1" width="10" height="10" fill="#ffffff" />
      ) : s === "fail" ? (
        <g stroke="#ffffff" strokeWidth="1.25" fill="none">
          <rect x="1" y="1" width="10" height="10" />
          <path d="M1 1L11 11M11 1L1 11" />
        </g>
      ) : (
        <rect x="1" y="1" width="10" height="10" fill="none" stroke="#ffffff" strokeWidth="1.25" strokeDasharray="2 2" />
      )}
    </svg>
  );
}

function ResultLine({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-t border-white/15 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-white/70">{k}</dt>
      <dd className="min-w-0 text-white">{children}</dd>
    </div>
  );
}

export function CheckPanel({ example }: { example: HomeExample | null }) {
  const r = example?.receipt;
  const decision = example?.decision ?? null;
  return (
    <section
      aria-labelledby="check-title"
      className="min-w-0 bg-brand-deep text-[0.8125rem] leading-[1.6] text-white selection:bg-paper selection:text-brand-deep sm:text-[0.875rem]"
    >
      <div className="flex items-baseline justify-between gap-4 border-b border-white/15 px-5 py-3 sm:px-6">
        <h2 id="check-title" className={`${DISPLAY} text-[0.9375rem] font-semibold`}>
          vet402 check
        </h2>
        <p className="text-[0.75rem] text-white/70">Public, no account</p>
      </div>
      <form method="get" action="/sellers" role="search" className="px-5 pt-5 sm:px-6">
        <label htmlFor="home-seller-q" className="text-[0.75rem] uppercase tracking-[0.18em] text-white/70">
          Seller domain
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="home-seller-q"
            name="q"
            aria-describedby="home-seller-q-help"
            type="search"
            required
            placeholder="api.example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="min-w-0 rounded-[2px] border border-white/40 bg-transparent px-3 py-2.5 text-base text-white caret-white placeholder:text-white/60 focus-visible:border-white sm:flex-1"
          />
          <button
            type="submit"
            className={`${DISPLAY} rounded-[2px] bg-paper px-6 py-2.5 text-[0.9375rem] font-semibold text-brand-deep transition-[background-color] hover:bg-ground`}
          >
            Check a seller
          </button>
        </div>
        <p id="home-seller-q-help" className="mt-2 text-[0.75rem] text-white/70">
          Results are Base purchases. A host with purchases on another chain, or one missing here, can still be listed in the observatory.
        </p>
        <p className="mt-4 flex flex-col gap-2 sm:flex-row">
          <TrackedLink
            href="/signup"
            event="lp_cta_click"
            props={{ position: "hero_signup" }}
            className={buttonClass({ variant: "secondary", size: "md", className: "w-full sm:w-auto" })}
          >
            Get a free API key
          </TrackedLink>
          <TrackedLink
            href="/playground"
            event="lp_cta_click"
            props={{ position: "hero_playground" }}
            className={buttonClass({ variant: "secondary", size: "md", className: "w-full sm:w-auto" })}
          >
            Try one check, no account
          </TrackedLink>
        </p>
      </form>

      {r ? (
        <div className="mt-6 border-t border-dashed border-white/40 px-5 pb-6 pt-5 sm:px-6">
          <p className="text-[0.75rem] uppercase tracking-[0.18em] text-white/70">Example result</p>
          <p className="mt-1 text-[0.75rem] text-white/70">The latest settled purchase in the public export of the last day.</p>
          <dl className="mt-4">
            <ResultLine k="Endpoint">
              <span className="break-all">
                {decision?.method ? <span className="text-white/70">{decision.method} </span> : null}
                {r.host}
                {r.path}
              </span>
            </ResultLine>
            <ResultLine k="L0">
              {decision ? (
                <>
                  <VerdictMark status={decision.l0.status} />
                  {decision.l0.status}
                  {decision.l0.observedAt ? (
                    <span className="text-white/70"> probed {utc(decision.l0.observedAt, false)} UTC</span>
                  ) : null}
                </>
              ) : (
                <span className="text-white/70">not read</span>
              )}
            </ResultLine>
            <ResultLine k="L1">
              {decision ? (
                <>
                  {fmt(decision.l1.settled)} of {fmt(decision.l1.attempts)} settled, {fmt(decision.l1.delivered)} answered 2xx
                  {decision.l1.windowDays ? <span className="text-white/70"> last {decision.l1.windowDays} days</span> : null}
                </>
              ) : (
                <span className="text-white/70">not read</span>
              )}
            </ResultLine>
            <ResultLine k="L2">{decision ? decision.l2 : <span className="text-white/70">not read</span>}</ResultLine>
          </dl>
          {decision?.observatoryId ? (
            <p className="mt-4">
              <TrackedLink
                href={`/observatory/e/${decision.observatoryId}`}
                event="lp_cta_click"
                props={{ position: "hero_example_record" }}
                className="underline decoration-white/40 underline-offset-[0.22em] hover:decoration-white"
              >
                Open this endpoint&apos;s record
              </TrackedLink>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

"use client";

/**
 * RFC-world error panel. error.tsx must be a client component; loading
 * skeletons are in DocLoadingSkeleton.tsx so they stay server-only.
 */
export function DocErrorPanel({
  error,
  reset,
  title,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title: string;
}) {
  return (
    <main className="px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-12">
      <div className="sheet">
        <div className="doc-error-panel" role="alert">
          <p className="doc-title !text-[1.0625rem]">Could not load {title}</p>
          <p className="mt-3 text-[0.84375rem]">
            This is a fault on our side, not with your input or connection.
          </p>
          {error.digest ? (
            <p className="mt-2 font-mono text-xs text-brand-lift">Ref: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="mt-5 border border-current px-4 py-2 text-[0.84375rem] font-semibold uppercase tracking-wide hover:bg-white"
          >
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}

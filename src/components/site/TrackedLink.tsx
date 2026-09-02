"use client";

import Link from "next/link";
import { track } from "@/lib/analytics";

// 2026-08-06 growth: click-tracked link for server components. The LP and
// /docs/api are RSC pages, so their CTAs cannot carry an onClick — this thin
// client wrapper is the smallest way to attach one without converting whole
// pages to client components. Navigation is never blocked: track() is
// fire-and-forget (see src/lib/analytics.ts) and we don't preventDefault.
//
// Internal hrefs render next/link (keeps prefetch/client navigation);
// external ones render a plain <a target="_blank">.
// 2026-09-02: `onClick` passthrough so a client caller (the header drawer) can
// close itself on navigation. Tracking still fires first and never blocks.
export default function TrackedLink({
  href,
  event,
  props,
  className,
  children,
  onClick: after,
}: {
  href: string;
  event: string;
  props?: Record<string, string | number | boolean>;
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  const onClick = () => {
    track(event, props);
    after?.();
  };
  const external = /^https?:\/\//.test(href);

  if (external) {
    return (
      <a
        href={href}
        onClick={onClick}
        className={className}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} onClick={onClick} className={className}>
      {children}
    </Link>
  );
}

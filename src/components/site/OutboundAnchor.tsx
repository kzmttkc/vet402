"use client";

import type { ReactNode } from "react";
import { trackOutboundFromHref } from "@/lib/analytics";

/** Plain external anchor with outbound funnel events. No styling opinions. */
export default function OutboundAnchor({
  href,
  className,
  children,
  rel = "noopener noreferrer",
}: {
  href: string;
  className?: string;
  children: ReactNode;
  rel?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      rel={rel}
      target="_blank"
      onClick={() => trackOutboundFromHref(href)}
    >
      {children}
    </a>
  );
}

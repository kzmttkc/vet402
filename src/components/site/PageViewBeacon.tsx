"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { sendSiteEvent } from "@/lib/analytics";

function initialReferrerLabel(): string {
  if (typeof document === "undefined") return "direct";
  const ref = document.referrer.trim();
  if (!ref) return "direct";
  try {
    return new URL(ref).hostname.toLowerCase() || "direct";
  } catch {
    return "direct";
  }
}

/**
 * Sends page_view once per navigation. First paint uses the document referrer host;
 * later client-side route changes use internal (same tab on vet402).
 */
export default function PageViewBeacon() {
  const pathname = usePathname() ?? "/";
  const isFirst = useRef(true);
  const firstRef = useRef<string | null>(null);

  useEffect(() => {
    if (firstRef.current === null) firstRef.current = initialReferrerLabel();
    const r = isFirst.current ? firstRef.current : "internal";
    isFirst.current = false;
    sendSiteEvent({ e: "page_view", p: pathname, r });
  }, [pathname]);

  return null;
}

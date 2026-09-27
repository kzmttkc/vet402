"use client";

import { DocErrorPanel } from "@/components/site/DocRouteFallback";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <DocErrorPanel error={error} reset={reset} title="the seller pages" />;
}

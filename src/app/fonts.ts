import localFont from "next/font/local";

/* Self-hosted faces (OFL, approved 2026-08-13).
   adjustFontFallback is false so a blocked face falls back to ui-monospace,
   not a generated Arial that would break tabular figures.
   Martian is not preloaded: on the front page it is only the wordmark, and
   five preloaded faces pushed the mobile headline paint past 3s. */
export const martianMono = localFont({
  variable: "--font-martian",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  src: [
    { path: "../fonts/martian-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/martian-600.woff2", weight: "600", style: "normal" },
    { path: "../fonts/martian-700.woff2", weight: "700", style: "normal" },
  ],
});

export const fragmentMono = localFont({
  variable: "--font-fragment",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  src: [{ path: "../fonts/fragment-400.woff2", weight: "400", style: "normal" }],
});

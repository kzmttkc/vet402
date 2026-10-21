// A malformed /payee/:address is answered from src/proxy.ts, before the app
// renders. notFound() inside the page sets HTTP 404, but the body stays in the
// flight payload (same as /agent/not-a-number on the live site), so a reader
// without JavaScript never sees the sentence. This document is the body.

export const INVALID_PAYEE_H1 = "That is not a valid wallet address";
export const INVALID_PAYEE_DETAIL =
  "A payee profile URL is 0x followed by 40 hexadecimal characters.";

/** True for /payee/<one segment> when the segment is not a 40-nibble address. */
export function isMalformedPayeePath(pathname: string): boolean {
  const match = pathname.match(/^\/payee\/([^/]+)\/?$/);
  if (!match) return false;
  // Keep in step with isValidAddress in src/lib/chain/client.ts. That module
  // pulls viem in, which this proxy path must not load.
  return !/^0x[a-fA-F0-9]{40}$/.test(match[1]);
}

export function invalidPayeeAddressHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${INVALID_PAYEE_H1} | vet402</title>
<style>
  body{margin:0;background:#eef0f3;color:#233456;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9375rem;line-height:1.6}
  main{box-sizing:border-box;max-width:48rem;margin:0 auto;padding:2rem 1rem 3rem}
  article{background:#fff;border:1px solid #dfe3e9;box-shadow:0 2px 14px rgba(35,52,86,.1);padding:2rem 1.5rem}
  .cols{display:flex;justify-content:space-between;gap:1.5rem;line-height:1.7}
  .cols span{display:block}
  .cols div:last-child{color:#55688c;text-align:right}
  h1{margin:2.5rem 0 0;text-align:center;font-size:1.35rem;font-weight:600;line-height:1.35}
  .detail{margin:0.75rem auto 0;max-width:56ch;text-align:center;color:#3e537c}
  code{font-family:inherit}
  .rule{height:5px;margin:1.5rem auto 0;max-width:34ch;border-top:1px solid #233456;border-bottom:1px solid #233456}
  .cap{margin:2rem 0 0;font-size:0.75rem;line-height:1;letter-spacing:0.22em;text-transform:uppercase;color:#55688c}
  .sample{margin:0.5rem 0 0;word-break:break-all}
  p{margin:1.5rem 0 0;max-width:72ch;color:#3e537c}
  a{color:#233456}
  a:focus-visible{outline:3px solid #233456;outline-offset:2px}
  @media (max-width:640px){
    .cols{flex-direction:column;gap:0.9rem}
    .cols div:last-child{text-align:left}
    article{padding:2rem 1rem}
  }
</style>
</head>
<body>
<main>
<article>
<div class="cols">
<div><span>Independent Measurement</span><span>Status report</span></div>
<div><span>vet402</span><span>x402 Economy</span></div>
</div>
<h1>${INVALID_PAYEE_H1}</h1>
<p class="detail">${INVALID_PAYEE_DETAIL.replace("0x", "<code>0x</code>")}</p>
<div class="rule"></div>
<p class="cap">Correct form</p>
<p class="sample">/payee/0xd8da6bf26964af9d7eed9e03e53415d37aa96045</p>
<p>Check the address for a typo or a truncated copy-paste, then try again. You can also <a href="/payee">verify a payee</a>, <a href="/leaderboard">browse recently verified agents</a>, or read <a href="/docs/api">how scoring works</a>.</p>
</article>
</main>
</body>
</html>
`;
}

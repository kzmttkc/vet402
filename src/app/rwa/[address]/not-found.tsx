import Link from "next/link";

// What /rwa/[address] shows for an input that is not a wallet address (2026-09-30 audit).
// page.tsx calls notFound() for it, so the answer stays HTTP 404. It says why,
// and links back to the form, instead of the site's bare 404.
export default function RwaAddressNotFound() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">vet402 /rwa</h1>
      <p className="mt-4 border-l-2 pl-3 text-base">This is not a wallet address.</p>
      <p className="mt-3 text-sm">
        /rwa needs a Robinhood Chain address: 0x followed by 40 hex characters. ENS names are not supported.
      </p>
      <p className="mt-3 text-sm">
        <Link className="underline" href="/rwa">
          Back to /rwa and paste a wallet
        </Link>
      </p>
    </main>
  );
}

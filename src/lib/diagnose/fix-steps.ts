// 診断の直し方（英語1文）と再点検リンク。主語は vet402。we / our / us、セミコロン、ダッシュは置かない。
import { CHECK_IDS, fixFor, type CheckId, type CheckStatus } from "./copy";

export const FIX_STEPS: Record<CheckId, Partial<Record<"fail" | "warn" | "info", string>>> = {
  returns_402: {
    fail: "Return HTTP 402 with an x402 challenge to an unpaid request.",
  },
  x402_shape: {
    fail: "Return x402Version 1 or 2 with at least one accept in the x402 challenge.",
  },
  header_body: {
    fail: "Send the same scheme, amount, asset, network, payTo, and resource in the Payment-Required header and the response body.",
  },
  resource_url: {
    warn: "Add a resource URL so the client can see what it would pay for.",
    fail: "Set the resource URL to the URL the client called.",
  },
  amount_atomic: {
    fail: "Send the amount as a positive integer string of atomic units.",
  },
  network_caip2: {
    warn: "Use the CAIP-2 network id instead of a legacy network name.",
    fail: "Use a CAIP-2 network id that vet402 knows.",
  },
  asset_usdc: {
    warn: "Use the pinned USDC contract for that network if vet402 should treat the accept as payable.",
    fail: "Use the USDC contract for the network you named.",
  },
  payto: {
    fail: "Set payTo to a well formed seller account that is not a burn or zero address.",
  },
  testnet_only: {
    warn: "Prefer the mainnet accept when both mainnet and testnet options are offered.",
    fail: "Offer a mainnet accept if you want mainnet clients to pay.",
  },
  solana_fee_payer: {
    fail: "Set a Solana feePayer that is present and different from payTo.",
  },
  scheme: {
    info: "Use exact, upto, batch-settlement, or auth-capture if vet402 should treat the accept as payable.",
    fail: "Set scheme to exact, upto, batch-settlement, or auth-capture.",
  },
  account_readiness: {
    fail: "Activate the recipient account and open the trust line before asking for payment.",
  },
};

export const UNSAFE_TARGET_FIX =
  "Use a public HTTPS URL on the open internet as the diagnose target and do not send vet402 to private or non-public destinations.";

const NON_PASS: CheckStatus[] = ["fail", "warn", "info"];

export function howToFix(id: CheckId, status: CheckStatus): string | null {
  if (status === "pass") return null;
  const step = FIX_STEPS[id][status as "fail" | "warn" | "info"];
  if (!step) throw new Error(`missing fix step ${id} ${status}`);
  return step;
}

export function missingFixSteps(table: Record<CheckId, Partial<Record<"fail" | "warn" | "info", string>>> = FIX_STEPS): string[] {
  const missing: string[] = [];
  for (const id of CHECK_IDS) {
    for (const status of NON_PASS) {
      let defined = false;
      try {
        fixFor(id, status);
        defined = true;
      } catch {
        defined = false;
      }
      const key = `${id}:${status}`;
      if (defined && !table[id][status as "fail" | "warn" | "info"]) missing.push(key);
    }
  }
  for (const id of CHECK_IDS) {
    for (const status of NON_PASS) {
      if (table[id][status as "fail" | "warn" | "info"]) {
        let defined = false;
        try {
          fixFor(id, status);
          defined = true;
        } catch {
          defined = false;
        }
        if (!defined) missing.push(`extra:${id}:${status}`);
      }
    }
  }
  return missing;
}

export function retestFor(
  url: string,
  method: "GET" | "POST",
): { rerun_url: string; request_url: string; how: string } {
  const rerun_url = `https://vet402.com/api/v1/diagnose?url=${encodeURIComponent(url)}&method=${method}`;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const title = `Retest request: ${host}`;
  const body = [
    `URL: ${url}`,
    `Method: ${method}`,
    "402 network:",
    "payTo:",
    "What changed:",
    "",
  ].join("\n");
  const request_url = `https://github.com/vet402/vet402/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  const how =
    "After you fix the endpoint, open the free diagnose link again for another unpaid check. To ask vet402 to purchase again and confirm delivery, open the GitHub issue link and fill in the network, payTo, and what you changed.";
  return { rerun_url, request_url, how };
}
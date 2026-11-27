// ============================================================
// 402 の accept と vet402 の判定（verified_terms・verified_pay_to_by_network・facts.payees）の照合（2026-11-27 F7）。
// pay-or-refuse.ts から移した。中身は変えていない。`payOrRefuse` が署名の前に使い、vet402 の
// POST /api/v1/check/presign も同じ関数を import して同じ語で答える（規則を 2 か所に書かない）。
// import を持たない（vet402 の Next のビルドが packages/sdk/src を直接読むので、`.js` の相対 import を置かない）。
// 下の 2 つの述語と Base の網は verdict-shape.ts・chain-profile.ts と同じ（tests/presign.test.ts が一致を確かめる）。
// ============================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimalUnits(amount: unknown): amount is string {
  return typeof amount === "string" && /^[0-9]+$/.test(amount);
}

/** chain-profile.ts の CHAIN_PROFILES.base.network と同じ値。 */
export const TERMS_BASE_NETWORK = "eip155:8453";

/** 台帳の額の桁（USDC と同じ 6）。 */
const USDC_DECIMALS = 6;
/** pay-or-refuse.ts の SOLANA_MAINNET と同じ値（tests が一致を確かめる）。 */
export const SOLANA_MAINNET_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** 照合が返す語。どれも PayRefuseReason の語（新しい語は無い）。 */
export type TermsMismatchReason =
  | "payee_mismatch"
  | "price_above_declared"
  | "chain_or_asset_mismatch"
  | "evidence_unavailable"
  | "payee_unverified_on_rail"
  | "price_unverified";

/** 照合が読む判定の欄だけ。`/resources/{id}/decision?role=payer` の本文がそのまま当てはまる。 */
export type TermsDecision = {
  facts?: unknown;
  verified_terms?: unknown;
  verified_pay_to_by_network?: unknown;
};

/** v2 の形に揃えた accept（X402Accept と同じ欄）。 */
export type TermsAccept = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function caip10Parts(value: string): { network: string | null; address: string } {
  const m = /^(.*):([^:]+)$/.exec(value);
  if (!m) return { network: null, address: value };
  const head = m[1]!;
  const address = m[2]!;
  if (/^eip155:\d+$/i.test(head)) return { network: head, address };
  if (/^0x[a-fA-F0-9]{40}$/i.test(value)) return { network: null, address: value };
  return { network: null, address: value };
}

export function payeeMatchesDeclared(payee: string, acceptPayTo: string, acceptNetwork: string): boolean {
  const left = caip10Parts(payee);
  const right = caip10Parts(acceptPayTo);
  if (!sameAddress(left.address, right.address)) return false;
  if (left.network !== null && left.network !== acceptNetwork) return false;
  return true;
}

/**
 * 網ごとの USDC（どれも 6 桁）。vet402 が別の網で確かめた額を、Base などで払う額と比べてよいのは、
 * 両方がこの表の USDC の時だけ（11/22 証明の監査 proof-payaudit-1。表に無い資産・18 桁の資産は比べない）。
 * 住所は小文字で持ち、照合も小文字で行う（Stellar の契約 id と Solana の mint は大文字小文字を区別するので、そのまま持つ）。
 */
const KNOWN_USDC_6: Readonly<Record<string, string>> = {
  "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "eip155:10": "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  "eip155:137": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:42161": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "eip155:42220": "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
  "eip155:43114": "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
  "eip155:5042": "0x3600000000000000000000000000000000000000",
  "stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

export function isKnownUsdc6(network: string | null, asset: unknown): boolean {
  if (network === null || typeof asset !== "string") return false;
  const known = KNOWN_USDC_6[network];
  if (known === undefined) return false;
  return network.startsWith("eip155:") ? asset.toLowerCase() === known : asset === known;
}

function payeesFromFacts(decision: TermsDecision | null): string[] {
  if (decision === null) return [];
  const facts = decision.facts as Record<string, unknown>;
  if (!isPlainObject(facts) || !Array.isArray(facts.payees)) return [];
  return facts.payees.filter((p): p is string => typeof p === "string");
}

function verifiedPayToByNetwork(decision: TermsDecision): unknown[] | null {
  const body = decision;
  if (!Object.hasOwn(body, "verified_pay_to_by_network")) return null;
  const raw = body.verified_pay_to_by_network;
  if (!Array.isArray(raw)) return [];
  return raw;
}

/** 402 の (network, payTo) が verified_pay_to_by_network の行と一致するか。EVM は小文字で比べる。 */
function acceptInVerifiedPayToList(list: unknown[], accept: TermsAccept): boolean {
  return list.some((row) => {
    if (!isPlainObject(row)) return false;
    const network = typeof row.network === "string" ? row.network : null;
    const payTo = typeof row.pay_to === "string" ? row.pay_to : null;
    if (network === null || payTo === null) return false;
    if (network !== accept.network) return false;
    return payeeMatchesDeclared(payTo, accept.payTo, accept.network);
  });
}

/**
 * vet402 が記録した payTo・額と accept を照合する。
 * `verified_terms` があるときは判定語（ALLOW かどうか）や WARN 免除に関わらず照合する（N7）。
 * `verified_terms` が null のときは recommendation に関わらず `facts.payees` で照合する。
 */
export function matchDeclaredPayTerms(
  decision: TermsDecision | null,
  accept: TermsAccept,
  profile: { network: string },
  requireVet402Allow: boolean,
): TermsMismatchReason[] | null {
  if (decision === null) return null;
  const body = decision;
  const hasKey = Object.hasOwn(body, "verified_terms");
  const vtRaw = body.verified_terms;

  const payeesCheck = (): TermsMismatchReason[] | null => {
    const payees = payeesFromFacts(decision);
    if (payees.length === 0) return ["evidence_unavailable"];
    if (!payees.some((p) => payeeMatchesDeclared(p, accept.payTo, profile.network))) return ["payee_mismatch"];
    return null;
  };

  if (hasKey && vtRaw !== null && vtRaw !== undefined && isPlainObject(vtRaw)) {
    const payTo = typeof vtRaw.pay_to === "string" ? vtRaw.pay_to : null;
    const amount = typeof vtRaw.amount === "string" ? vtRaw.amount : null;
    const vtNetwork = typeof vtRaw.network === "string" ? vtRaw.network : null;
    const vtDecimals = typeof vtRaw.decimals === "number" && Number.isInteger(vtRaw.decimals) ? vtRaw.decimals : null;

    if (vtNetwork !== null && vtNetwork !== accept.network) {
      const verifiedList = verifiedPayToByNetwork(decision);
      if (verifiedList !== null) {
        if (!acceptInVerifiedPayToList(verifiedList, accept)) return ["payee_unverified_on_rail"];
      } else {
        const payees = payeesFromFacts(decision);
        if (payees.length === 0) return ["evidence_unavailable"];
        const inFacts = payees.some((p) => payeeMatchesDeclared(p, accept.payTo, profile.network));
        if (!inFacts) return ["payee_unverified_on_rail"];
      }
      // 両方が網ごとの USDC（6 桁）なら、同じ単位なのでそのまま比べる。それ以外は比べない。
      const bothUsdc =
        isKnownUsdc6(vtNetwork, vtRaw.asset) &&
        isKnownUsdc6(accept.network, accept.asset) &&
        (vtDecimals === null || vtDecimals === USDC_DECIMALS);
      if (!bothUsdc || amount === null || !isDecimalUnits(amount)) return ["price_unverified"];
      if (BigInt(accept.amount) > BigInt(amount)) return ["price_above_declared"];
      return null;
    }

    if (payTo === null || amount === null || !isDecimalUnits(amount)) {
      return ["evidence_unavailable"];
    }
    if (!sameAddress(accept.payTo, payTo) && !payeeMatchesDeclared(payTo, accept.payTo, profile.network)) {
      return ["payee_mismatch"];
    }

    const decimalsKnown = vtDecimals === null || vtDecimals === USDC_DECIMALS;
    const sameRail =
      (vtNetwork === null || vtNetwork === accept.network) &&
      (typeof vtRaw.asset !== "string" || sameAddress(accept.asset, vtRaw.asset)) &&
      decimalsKnown;
    if (sameRail) {
      if (BigInt(accept.amount) > BigInt(amount)) return ["price_above_declared"];
    } else {
      return ["price_unverified"];
    }

    const sameChain = vtNetwork === null || vtNetwork === accept.network;
    if (sameChain) {
      if (typeof vtRaw.asset === "string" && !sameAddress(accept.asset, vtRaw.asset)) return ["chain_or_asset_mismatch"];
      if (typeof vtRaw.scheme === "string" && accept.scheme !== vtRaw.scheme) return ["chain_or_asset_mismatch"];
    }
    return null;
  }

  const payeeErr = payeesCheck();
  if (payeeErr) return payeeErr;
  return ["price_unverified"];
}

/**
 * v1 の綴りを v2 の形へ揃える。実在する v1 の壁は `network: "base"` と
 * `maxAmountRequired` を使う（本番 `x402-payer.ts` の normalizeAccept と同じ規則）。
 * ここで揃えておかないと、金銭ゲートが v1 を丸ごと chain_or_asset_mismatch で落とし、
 * v1 の transport（X-PAYMENT）が届かない死んだ枝になる。
 */
export function normalizeAccept(raw: unknown): TermsAccept | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const amount =
    typeof rec.amount === "string" ? rec.amount
    : typeof rec.maxAmountRequired === "string" ? rec.maxAmountRequired
    : null;
  const payTo = typeof rec.payTo === "string" ? rec.payTo : null;
  if (amount === null || payTo === null) return null;
  if (typeof rec.scheme !== "string" || typeof rec.asset !== "string") return null;
  const network =
    rec.network === "base" ? TERMS_BASE_NETWORK
    : rec.network === "base-sepolia" ? "eip155:84532"
    // v1 の Solana スラグ（本番 `x402-payer.ts` の normalizeAccept と同じ）。v1 の壁は Solana では払わない
    // （SVM の選別が x402 v2 を要求する）が、「何を提示されたか」は正規形で残す。
    : rec.network === "solana" ? SOLANA_MAINNET_NETWORK
    : typeof rec.network === "string" ? rec.network
    : "";
  return {
    scheme: rec.scheme,
    network,
    amount,
    asset: rec.asset,
    payTo,
    ...(typeof rec.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: rec.maxTimeoutSeconds } : {}),
    ...(typeof rec.extra === "object" && rec.extra !== null ? { extra: rec.extra as Record<string, unknown> } : {}),
  };
}


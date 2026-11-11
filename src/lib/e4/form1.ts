/**
 * E4 形1（Locked・2026-11-11 に scheme を x402 公式の `auth-capture` へ替えた）の公開名・公開文・3 形の比較表。
 *
 * 決定: ~/Takeshi_Automation/output/1109/wave1_plan/E4_LOCK.md の 2026-11-11 の節。
 * 根拠: ~/Takeshi_Automation/output/1111/e4_proof/FINDINGS.md（exact では形1が成り立たない実測と、auth-capture の一次）。
 *
 * 公開名は x402 公式文書の一次引用（コミット固定の URL と行）があるときだけ出す。拒むのは自社の造語・`nvm:`・`subetha-`。
 * 公開文は「対応する売り手に限り、届かなかった支払いは確定しない」の範囲に留める（11/11 時点で auth-capture を出す売り手は
 * 実測 0 件なので、対応済みの売り手が居るとは書かない）。英文は I／vet402 主語、ダッシュとセミコロンを置かない。
 */

/** 公式文書の正典リポとコミット（2026-11-10 の HEAD・`packages/sdk/src/auth-capture.ts` と同じ値）。 */
export const E4_SPEC_REPO = "x402-foundation/x402";
export const E4_SPEC_COMMIT = "d3eb19d018801c190be58acf4017e76f8bcf6d45";
const SPEC_BASE = `https://github.com/${E4_SPEC_REPO}/blob/${E4_SPEC_COMMIT}/specs/schemes/auth-capture`;

export type E4SchemeCitation = {
  /** コミット固定の URL（行のアンカー付き）。 */
  url: string;
  /** 1 始まりの行番号。 */
  line: number;
  /** その行の文字列そのまま。 */
  text: string;
};

/** 公開の scheme 名。 */
export const E4_PUBLIC_SCHEME_NAME = "auth-capture";

/**
 * scheme 名の一次引用。`scheme_auth_capture.md` の L1。
 * 補助の行（同じコミット）: L27 は reclaim が買い手単独の逃げ道であること。delegated の定義は `scheme_auth_capture_evm.md` L35-41。
 */
export const E4_SCHEME_CITATION: E4SchemeCitation = {
  url: `${SPEC_BASE}/scheme_auth_capture.md#L1`,
  line: 1,
  text: "# Scheme: `auth-capture`",
};
export const E4_SUPPORTING_CITATIONS: readonly E4SchemeCitation[] = [
  {
    url: `${SPEC_BASE}/scheme_auth_capture.md#L27`,
    line: 27,
    text: "`reclaim` is the client's unilateral escape hatch and is never relayed through the facilitator. Every other operation is initiated by the resource server and relayed by the facilitator, except where a network binding runs later lifecycle operations out of band.",
  },
];

const PINNED_URL_RE = /^https:\/\/github\.com\/x402-foundation\/x402\/blob\/[0-9a-f]{40}\/specs\/schemes\/auth-capture\/scheme_auth_capture(_evm)?\.md#L(\d+)$/;

/**
 * 引用が揃っているか。URL・行・文字列のどれかが空、URL がコミット固定でない、アンカーと行番号が違う、
 * 文字列が scheme 名をバッククォートで名指ししていない、のどれでも throw する（skip にも暫定の合格にもしない）。
 */
export function assertE4SchemeCitationReady(citation: E4SchemeCitation = E4_SCHEME_CITATION): void {
  const url = typeof citation?.url === "string" ? citation.url.trim() : "";
  const text = typeof citation?.text === "string" ? citation.text.trim() : "";
  if (url.length === 0 || text.length === 0 || !Number.isInteger(citation?.line) || citation.line < 1) {
    throw new Error("e4_scheme_citation_missing");
  }
  const m = PINNED_URL_RE.exec(url);
  if (!m) throw new Error("e4_scheme_citation_not_pinned");
  if (Number(m[2]) !== citation.line) throw new Error("e4_scheme_citation_line_mismatch");
  if (!text.includes(`\`${E4_PUBLIC_SCHEME_NAME}\``)) throw new Error("e4_scheme_citation_does_not_name_scheme");
}

/** 公開してよい scheme 名か。x402 公式の名で、一次引用があるもの（`auth-capture`）だけ。綴りの揺れも拒む。 */
export function isAllowedE4SchemePublicName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name !== E4_PUBLIC_SCHEME_NAME) return false;
  try {
    assertE4SchemeCitationReady();
    return true;
  } catch {
    return false;
  }
}

/** 公開の scheme 名として拒むか。`nvm:` で始まる名・`subetha-` を含む名・自社の造語（公式名以外の全部）。 */
export function isForbiddenE4SchemePublicName(name: string): boolean {
  if (typeof name !== "string") return true;
  const n = name.trim().toLowerCase();
  if (n.startsWith("nvm:")) return true;
  if (n.includes("subetha-")) return true;
  return !isAllowedE4SchemePublicName(name);
}

/** 公開の短い英文（第5版から変えない）。 */
export const E4_PUBLIC_TAGLINE = "Settle only once the answer has arrived";

/** 公開の範囲の英文。対応する売り手に限る。対応済みの売り手が居るとは書かない。 */
export const E4_PUBLIC_SCOPE_EN =
  "This applies only to sellers that offer auth-capture. With such a seller, vet402 signs a hold, not a final payment, " +
  "and reports the payment as settled only when the answer arrived and the hold was captured. " +
  "A hold that was not captured goes back to the buyer by void, or by the buyer's own reclaim after the capture deadline. " +
  "A seller that offers only exact is paid with exact, as before.";

/** 同じ範囲の日本語（社内の正典の言い方）。 */
export const E4_PUBLIC_SCOPE_JA = "対応する売り手に限り、届かなかった支払いは確定しない。";

export type E4FormComparisonRow = {
  form: 1 | 2 | 3;
  label: string;
  /** vet402 の財布が利用者の残高を預かるか。 */
  holdsCustody: boolean;
  /** vet402 自身が確定の送金を動かすか（形1は売り手の operator が capture・void、買い手の財布が reclaim）。 */
  movesFundsOnSettle: boolean;
  /** testnet の結果（実施していない形は「未実施」。緑と書かない）。 */
  testnetResult: string;
};

/**
 * 3 形の比較表。形1の結果は Base Sepolia を fork したローカル anvil で 2026-11-11 に通した統合試験
 * （`packages/sdk/test/integration/e4-auth-capture-anvil.test.mjs`・ログは output/1111/e4_proof/sdk_integration.log）。
 * 公開の Base Sepolia での実払いはしていない（その旨をセルに書く）。
 */
export function e4FormComparisonTable(): E4FormComparisonRow[] {
  return [
    {
      form: 1,
      label: "x402 auth-capture, delegated operator, escrow flow, sync capture",
      holdsCustody: false,
      movesFundsOnSettle: false,
      testnetResult:
        "Passed on a local fork of Base Sepolia (chain 84532) on 2026-11-11 with the official x402 auth-capture server and facilitator. " +
        "Delivered answer: captured, seller +10000 units. HTTP 500, empty 200 and 202: voided, buyer delta 0. " +
        "Hold above the signed maximum: reverted with ExceedsMaxAmount. Seller gone: buyer reclaim after the capture deadline, buyer delta 0. " +
        "Not yet run on the public Base Sepolia network.",
    },
    {
      form: 2,
      label: "escrow contract on testnet",
      holdsCustody: true,
      movesFundsOnSettle: true,
      testnetResult: "未実施",
    },
    {
      form: 3,
      label: "facilitator-operated capture",
      holdsCustody: false,
      movesFundsOnSettle: true,
      testnetResult: "未実施",
    },
  ];
}

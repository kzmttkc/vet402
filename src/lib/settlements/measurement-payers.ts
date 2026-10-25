// ============================================================
// 公開の測定・点検 payer 一覧（kzmttkc/vet402#43）。
//
// settlement_30d_test は vet402 自身が払うウォレットだけを指す、と公開契約に
// 書いてある。他社の測定サービスを同じ旗に入れると、その数字の意味が変わる。
// だから別の wash_flag `measurement` に置き、settlement_30d_real（wash_flag
// none）から外し、settlement_30d_measurement で別に数える。
//
// 載せる条件: その会社自身の公開ページに、測定または点検をしていると読める文が
// あること。売り手の User-Agent だけでは載せない。汎用の node User-Agent の
// 2 件（issue 43 の 0x7dd8… と 0xc533…）はここには無い。
//
// 確認した文（2026-10-24 に各 URL を取得）:
//   Crosspeel https://crosspeel.com/method
//     "The method looks for those agreements, measures how many of them hold,
//      and compares the prices of the endpoints that hold them."
//     "The wallet that pays for probes is rotated between runs."
//   Crosspeel https://crosspeel.com
//     "Observed means paid for and measured."
//   Mizan https://mizan-bazar.higgsfield.app
//     "Ten measurement errors have been found and fixed so far"
//     "This page is the field record, in full, free."
//     頁の見出しは x402 Bazaar Field Station、最新の回は LAST MEASURED。
// ============================================================
import { payeeId } from "@/lib/ids/canonical";

export type MeasurementPayer = {
  /** CAIP-2 */
  chain: string;
  /** eip155 は小文字。 */
  address: string;
  /** chain:address。分類と backfill がこの文字列で照合する。 */
  payerId: string;
  name: string;
  /** 測定・点検を名乗っている、その会社自身の公開ページ。 */
  sourceUrl: string;
  /** そのページから採った文。 */
  sourceQuote: string;
  /** YYYY-MM-DD（UTC）。一覧に足した日。 */
  addedOn: string;
  /** 住所の出所。公開頁にそのまま出す。 */
  basis: string;
};

const CROSSPEEL = "0x8d2a47cbd262e1bc5ee0645c81899f9896957d37";
const MIZAN = "0xe3badbd4f38214b9eae528a1a5398f6678f63fb3";
const BASE = "eip155:8453";

export const MEASUREMENT_PAYERS: readonly MeasurementPayer[] = [
  {
    chain: BASE,
    address: CROSSPEEL,
    payerId: payeeId(BASE, CROSSPEEL),
    name: "Crosspeel",
    sourceUrl: "https://crosspeel.com/method",
    sourceQuote:
      "The method looks for those agreements, measures how many of them hold, and compares the prices of the endpoints that hold them.",
    addedOn: "2026-10-24",
    basis:
      "Seller report in kzmttkc/vet402 issue 43. The method page says the method measures how many agreements hold, and that the wallet pays for probes. " +
      "On 2026-10-25 vet402 read the 24 settlement transactions the seller listed on Base: each is a USDC transfer from this address to that seller.",
  },
  {
    chain: BASE,
    address: MIZAN,
    payerId: payeeId(BASE, MIZAN),
    name: "Mizan",
    sourceUrl: "https://mizan-bazar.higgsfield.app",
    sourceQuote: "Ten measurement errors have been found and fixed so far",
    addedOn: "2026-10-24",
    basis:
      "Seller report in kzmttkc/vet402 issue 43. The field station page calls the work a field record of knocks and paid buys, and names measurement errors in that record. " +
      "On 2026-10-25 vet402 read the 1 settlement transaction the seller listed on Base: a USDC transfer from this address to that seller.",
  },
];

export const MEASUREMENT_PAYER_IDS: ReadonlySet<string> = new Set(MEASUREMENT_PAYERS.map((p) => p.payerId));

/** eip155 は住所の大文字小文字を同一と見る。それ以外の chain は文字列のまま。 */
export function isMeasurementPayer(payerId: string | null | undefined): boolean {
  if (!payerId) return false;
  if (MEASUREMENT_PAYER_IDS.has(payerId)) return true;
  if (payerId.startsWith("eip155:")) return MEASUREMENT_PAYER_IDS.has(payerId.toLowerCase());
  return false;
}

/**
 * 既に索引した行を measurement へ移すときの次の旗。
 * test（vet402 自身）は動かさない。一覧に無い payer は動かさない。
 * 一覧にある payer の self_deal / circular / none は measurement に揃える
 * （classifyWash の優先順位 test > measurement > self_deal > circular と同じ）。
 */
export function nextMeasurementWashFlag(current: string, payerId: string | null): string {
  if (!isMeasurementPayer(payerId)) return current;
  if (current === "test") return current;
  return "measurement";
}

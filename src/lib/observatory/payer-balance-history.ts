// ============================================================
// 支払いウォレットの残高の履歴（2026-09-29 第2巡の敵対的監査・/sellers の (c)）。
//
// 何のためか: 「seller's side」は vet402 に落ち度が無いと示せる行だけに置く。そのひとつが「署名した時点で
// 支払いウォレットが価格以上の USDC を持っていた」（持っていなければ支払いに中身が無く、失敗はこちらの側）。
//   - PAYER_FUNDS_GATE_SINCE 以降: l1-runner が署名の前に残高を読み、足りなければ署名しない（payer-funds.ts・
//     Issue #29）。この関門は 24587c17 で、それを含む最初の Production は 2b4a4ee0（2026-09-16T23:25:55Z・
//     request-body.ts の DECLARED_BODY_SENT_SINCE と同じ配備）。以後の署名は残高 ≥ 価格を通っている。
//   - それより前（Base）: ウォレットの USDC の Transfer ログ（受け取りと送り出しの全部）から残高を時系列で組み直した。
//     2026-09-29 に公開 RPC（mainnet.base.org）の eth_getLogs で取得し、組み直した終わりの残高が同じブロックの
//     balanceOf と一致することを確かめた（0x6777…3986: 08-13〜09-17 の 1,751 件・終わり 1,449.815796 USDC、
//     0xc9c7…1670: 09-03〜09-17 の 1,659 件・終わり 207.9419 USDC）。
//   - それ以外（Base より前の関門以前の Solana など）: 組み直していないので unknown。
//
// 表の持ち方: 残高が FLOOR_UNITS（1 USDC = 本番の署名額の最大）を下回っていた期間だけ、変化の全部を
// [時刻, 残高] で持つ。値が FLOOR_UNITS 以上の行は「ここから次の行まで FLOOR_UNITS 以上」を意味する
// （下回る変化は必ず表に載るので）。時刻はブロックの時刻（Base は 2 秒刻み）。
//
// 判定: 署名の時刻は台帳の attempted_at（予約の時刻・署名はその直後）。[t − 2 秒, t + 30 秒] の最小の残高が
// 価格以上なら funded。[t − 2 秒, t + 10 分] の最大の残高でも価格未満なら short（署名した EIP-3009 の認可は
// 有効期限が最長 120 秒: x402-payer.ts の MAX_AUTHORIZATION_WINDOW_SECONDS・2026-09-04〜。その間に残高が戻らなければ
// 決済は成り立たない）。どちらでもなければ unknown（示せない）。
// DB も RPC も読まない純関数（公開頁から import する）。
// ============================================================

import { DECLARED_BODY_SENT_SINCE } from "./request-body";

/**
 * 残高の関門（24587c17）が本番に出た時刻。宣言本文を送る実装と同じ Production（2b4a4ee0・2026-09-16T23:25:55Z）
 * なので、値は request-body.ts の 1 か所から読む（tests/sellers-fix-modes.test.ts が値の持ち主を 1 か所に固定する）。
 */
export const PAYER_FUNDS_GATE_SINCE = DECLARED_BODY_SENT_SINCE;

/** 表が「以上」とだけ言う境目（USDC の基本単位・6 桁）。 */
export const FLOOR_UNITS = 1_000_000n;

export type FundsAtSigning = "funded" | "short" | "unknown";

interface PayerHistory {
  /** 小文字。 */
  payer: string;
  networks: readonly string[];
  /** この時刻から PAYER_FUNDS_GATE_SINCE まで組み直してある。 */
  from: string;
  /** [ブロックの時刻 ISO, その時刻からの残高（基本単位）]。 */
  steps: readonly (readonly [string, string])[];
}

const BASE = ["eip155:8453", "base"] as const;

export const PAYER_BALANCE_HISTORY: readonly PayerHistory[] = [
  {
    payer: "0x6777e11fb0a7917b8110b7dab9188aa3f6d23986",
    networks: BASE,
    from: "2026-08-12T23:59:59Z",
    steps: [
      ["2026-08-12T23:59:59Z", "0"],
      ["2026-08-14T07:23:13Z", "55490209"],
    ],
  },
  {
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    networks: BASE,
    from: "2026-09-02T23:59:59Z",
    steps: [
      ["2026-09-02T23:59:59Z", "0"],
      ["2026-09-04T09:21:17Z", "1000000"],
      ["2026-09-12T18:01:11Z", "993775"],
      ["2026-09-12T18:01:21Z", "973775"],
      ["2026-09-12T18:01:25Z", "893775"],
      ["2026-09-12T18:01:27Z", "873775"],
      ["2026-09-12T18:01:31Z", "853775"],
      ["2026-09-12T18:01:33Z", "843775"],
      ["2026-09-12T18:01:41Z", "823775"],
      ["2026-09-12T18:01:43Z", "822775"],
      ["2026-09-12T18:01:45Z", "802775"],
      ["2026-09-12T18:01:49Z", "782775"],
      ["2026-09-12T18:01:51Z", "772775"],
      ["2026-09-12T18:01:53Z", "732775"],
      ["2026-09-12T18:01:57Z", "717775"],
      ["2026-09-12T18:01:59Z", "707775"],
      ["2026-09-12T18:02:01Z", "704775"],
      ["2026-09-12T18:02:03Z", "694775"],
      ["2026-09-12T18:02:05Z", "194775"],
      ["2026-09-12T18:02:11Z", "179775"],
      ["2026-09-12T18:02:13Z", "159775"],
      ["2026-09-12T18:02:17Z", "129775"],
      ["2026-09-12T18:02:19Z", "99775"],
      ["2026-09-12T18:02:23Z", "94775"],
      ["2026-09-12T18:02:29Z", "89775"],
      ["2026-09-12T18:02:31Z", "79775"],
      ["2026-09-12T18:02:33Z", "73775"],
      ["2026-09-12T18:02:35Z", "68775"],
      ["2026-09-12T18:02:37Z", "58775"],
      ["2026-09-13T00:00:09Z", "48775"],
      ["2026-09-13T00:00:11Z", "38775"],
      ["2026-09-13T00:00:13Z", "36775"],
      ["2026-09-13T00:00:15Z", "34275"],
      ["2026-09-13T00:00:17Z", "33275"],
      ["2026-09-13T00:00:19Z", "32275"],
      ["2026-09-13T00:00:25Z", "22275"],
      ["2026-09-13T00:00:27Z", "2275"],
      ["2026-09-13T00:00:47Z", "1275"],
      ["2026-09-13T00:00:53Z", "275"],
      ["2026-09-15T23:11:29Z", "60000275"],
    ],
  },
];

const BEFORE_MS = 2_000;
const FUNDED_AFTER_MS = 30_000;
const SHORT_AFTER_MS = 600_000;

/** 区間 [lo, hi] の残高の最小・最大（FLOOR 以上の段を含めば最大は無限大＝null）。表の外なら null。 */
function rangeOf(h: PayerHistory, lo: number, hi: number): { min: bigint; max: bigint | null } | null {
  if (lo < Date.parse(h.from) || hi >= Date.parse(PAYER_FUNDS_GATE_SINCE)) return null;
  let min: bigint | undefined;
  let max: bigint | null = 0n;
  for (let i = 0; i < h.steps.length; i++) {
    const at = Date.parse(h.steps[i][0]);
    const next = i + 1 < h.steps.length ? Date.parse(h.steps[i + 1][0]) : Infinity;
    // この段 [at, next) が [lo, hi] と重なるか
    if (!(at <= hi && next > lo)) continue;
    const units = BigInt(h.steps[i][1]);
    const floorish = units >= FLOOR_UNITS;
    const low = floorish ? FLOOR_UNITS : units;
    if (min === undefined || low < min) min = low;
    if (floorish) max = null;
    else if (max !== null && units > max) max = units;
  }
  return min === undefined ? null : { min, max };
}

/** 署名した時点で支払いウォレットが価格以上を持っていたか（ヘッダの規則）。 */
export function payerFundsAtSigning(row: {
  network: string | null;
  payer: string | null;
  attemptedAt: string;
  amountUnits: string | null;
}): FundsAtSigning {
  const t = Date.parse(row.attemptedAt);
  if (!Number.isFinite(t)) return "unknown";
  if (!/^[0-9]{1,30}$/.test(row.amountUnits ?? "")) return "unknown";
  if (t >= Date.parse(PAYER_FUNDS_GATE_SINCE)) return "funded";
  const payer = (row.payer ?? "").toLowerCase();
  const h = PAYER_BALANCE_HISTORY.find((x) => x.payer === payer && x.networks.includes(row.network ?? ""));
  if (!h) return "unknown";
  const amount = BigInt(row.amountUnits!);
  const near = rangeOf(h, t - BEFORE_MS, t + FUNDED_AFTER_MS);
  if (near && near.min >= amount) return "funded";
  const wide = rangeOf(h, t - BEFORE_MS, t + SHORT_AFTER_MS);
  if (wide && wide.max !== null && wide.max < amount) return "short";
  return "unknown";
}

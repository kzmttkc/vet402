// ============================================================
// vet402 Observatory L1 — settled の証拠強度（2026-09-05 セキュリティ監査 S-4 / S-17）。
//
// なぜ在るか。`settled` は 2026-08-23 に「売り手の自己申告」から「我々が
// チェーンで再読した」へ定義が変わり、2026-09-04 12:00 UTC に**署名 nonce の
// 束縛**が入った。その 2 つの間に確定した行は、照合が言えたことが違う:
//
//   nonce_bound        我々しか作れない一回性の値（EVM: EIP-3009 の
//                      AuthorizationUsed(authorizer, nonce) / Solana: 我々が
//                      生成した memo）まで一致した。その tx が **この購入のもの**
//                      だと言える。
//   amount_payee_only  payer → payTo へ期待額の USDC が動いた tx が実在する、
//                      までしか言えない。同じ payTo・同じ価格の endpoint は
//                      本番で 253 群・1,477 試行あるので、売り手は自分宛の
//                      過去の tx を返すだけでこの判定を通せた。
//
// 本番実測 2026-09-05: settled 1,629 行のうち 1,558 行 (95.6%) が後者。
//
// 直し方は「旧行を降格する」ではない。持っていない証拠を理由に無実の売り手を
// refuted にしないのが 2026-09-04 の決定で、遡って強い証拠を作る方法は無い。
// できるのは**強度を明示して公開すること**だけなので、件数は 1 行も動かさず、
// 層のラベルと件数を足す。
//
// 分類は列だけを読む純関数として置く。settlement_verify_reason は本番の全 3,294 行で
// NULL（否定・一過性の失敗にしか書かれない）ので、判定材料には使えない。よって
// **auth_nonce の有無による近似**である——これは「nonce を持って照合を通った行」と
// 一致するが、「nonce を持つが照合が nonce 段で落ちた行」は refuted 側へ抜けるので
// settled には残らない、という前提に依存している（settlement-verify.ts の
// nonce_not_used が refute を呼ぶ）。前提が崩れたら層の意味も崩れるため、
// tests/settled-tiers.test.ts が定義そのものを固定している。
// ============================================================

/** 強い順。settled のどの行も必ずどちらか一方に入る。 */
export const SETTLED_TIERS = ["nonce_bound", "amount_payee_only"] as const;
export type SettledTier = (typeof SETTLED_TIERS)[number];

/**
 * 署名 nonce を全購入に書き始めた UTC 時刻（2026-09-04 監査 P1-1 の是正）。
 * これより前に確定した settled は auth_nonce を持たない。
 */
export const NONCE_BINDING_SINCE = "2026-09-04T12:00:00Z";

/** 決済ブロック時刻が試行より前でも許す幅（秒）。 */
export const SETTLEMENT_WINDOW_BEFORE_SEC = 300;
/** 決済ブロック時刻が試行より後で許す幅（秒）。 */
export const SETTLEMENT_WINDOW_AFTER_SEC = 900;

export type SettledTierRow = {
  status: string;
  settlementVerified?: boolean | null;
  authNonce?: string | null;
};

/**
 * 1 行の証拠強度。settled でない行に強度は無い（null）——0 と書くと
 * 「弱い settled が 0 件」に読めてしまう。
 */
export function settledTier(row: SettledTierRow): SettledTier | null {
  if (row.status !== "settled") return null;
  const nonce = typeof row.authNonce === "string" ? row.authNonce.trim() : "";
  return nonce !== "" && row.settlementVerified === true ? "nonce_bound" : "amount_payee_only";
}

export type SettlementTimeWindow = "ok" | "outside" | "unknown";

/**
 * 決済ブロック時刻が試行の -5 分〜+15 分に入るか（層とは別の真偽値）。
 *
 * 使い回された古い tx は、金額・宛先が一致しても**時刻がずれる**。nonce を
 * 持たない行に後から足せる唯一の独立した関門がこれで、本番実測 2026-09-05 では
 * block_timestamp のある 1,589 行すべてが -1〜+62 秒に収まっていた。
 * block_timestamp を持たない行は unknown——測っていないものを ok とも outside とも
 * 言わない。窓外でも refuted にはしない（表示と集計だけ）。
 */
export function settlementTimeWindow(
  attemptedAt: Date | null | undefined,
  blockTimestamp: Date | null | undefined,
): SettlementTimeWindow {
  if (!(attemptedAt instanceof Date) || Number.isNaN(attemptedAt.getTime())) return "unknown";
  if (!(blockTimestamp instanceof Date) || Number.isNaN(blockTimestamp.getTime())) return "unknown";
  const deltaSec = (blockTimestamp.getTime() - attemptedAt.getTime()) / 1000;
  return deltaSec >= -SETTLEMENT_WINDOW_BEFORE_SEC && deltaSec <= SETTLEMENT_WINDOW_AFTER_SEC
    ? "ok"
    : "outside";
}

function assertAlias(alias: string, what: string): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`${what}: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  return alias === "" ? "" : `${alias}.`;
}

/**
 * 上の分類と同じ規則の SQL 述語（delivery.ts の deliveredPredicate と同じ作法）。
 * 集計は SQL、単体は JS、という二重定義を避けるため、両方をここから出す。
 */
export function settledTierPredicate(tier: SettledTier, alias = ""): string {
  const p = assertAlias(alias, "settledTierPredicate");
  const bound = `${p}status = 'settled' AND ${p}settlement_verified IS TRUE AND ${p}auth_nonce IS NOT NULL AND btrim(${p}auth_nonce) <> ''`;
  if (tier === "nonce_bound") return bound;
  // 独立に条件を書くと定義が 2 箇所に分かれ、片方だけ直る事故になる。否定で書く。
  return `${p}status = 'settled' AND NOT (${bound})`;
}

/**
 * settled かつ決済ブロック時刻が窓内。`blockAlias` は observed_purchases 側の別名で、
 * 呼び出し側が LEFT JOIN していること（時刻が無い行は false に落ちる = unknown 側）が前提。
 */
export function settlementTimeWindowPredicate(alias = "", blockAlias = ""): string {
  const p = assertAlias(alias, "settlementTimeWindowPredicate");
  const o = assertAlias(blockAlias, "settlementTimeWindowPredicate");
  return (
    `${p}status = 'settled' AND ${o}block_timestamp IS NOT NULL AND ${o}block_timestamp BETWEEN ` +
    `${p}attempted_at - interval '${SETTLEMENT_WINDOW_BEFORE_SEC} seconds' AND ` +
    `${p}attempted_at + interval '${SETTLEMENT_WINDOW_AFTER_SEC} seconds'`
  );
}

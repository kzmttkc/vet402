// ============================================================
// 旧規則の L0 fail を今の規則で測り直す（2026-09-29 監査 6 周目・名指しされた売り手の弁護士）。
//
// WHY: 2026-09-29 の変更（l0-probe.ts: 未払い POST への 400/422 は request_shape の unverified、
// 402 の本文は 64 KB まで読む、不一致は比べた値を記録）の後も、公開中の見出しは変更前のプローブ行で
// fail のままだった。記録頁は各行に「今の規則では fail でない」と書き、見出しは fail——同じ頁で食い違う。
//
// 記録済みの行を今の規則で再分類して見出しを出し直す案（a）は採らない:
//   - POST の 400/422 は、今の規則では支払いの challenge（WWW-Authenticate / PAYMENT-REQUIRED）を
//     載せていれば fail のまま。旧い行はそのヘッダを記録していないので、記録からは決められない。
//   - 4,000 バイトで切った本文は、全体の大きさも残りも記録していない（先頭 500 字だけ）。
//   - price_mismatch / metadata_mismatch は規則が変わっていない。欠けているのは比べた値の記録で、
//     再分類しても値は出てこない（公開中の対象の 9 割がこれ）。
//   - 再分類を公開判定の計算に入れると、判断 API（seller-facts）と export の「published_verdict =
//     新しい 2 行がどちらも fail」という数え直せる定義が、別々の答えを出す。
// そこで（b）: 見出しの fail が旧規則の行に乗っている出品を、今の計器で測り直す。cron の C1 はそれを
// 先頭に並べ（1 ホスト 1 回あたりの上限つき）、一度きりのスクリプト（scripts/reprobe-legacy-l0-fails.ts）が
// 1 ホスト 1 秒 1 件以下で流す。測り直して公開判定が変わった出品は訂正ログ（reason=reverify）に残す。
//
// 「旧規則の行」は日付ではなく記録の形で見分ける（l0-reasons.ts の legacyProbe と同じ考え方）——
// 変更が本番に載った時刻と暦日がずれても、どちらの計器の行かを取り違えない。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import { MIN_CONSECUTIVE_FAILS_TO_PUBLISH, publishedVerdict, type ProbeResult } from "./l0-probe";
import { updateWithCorrection } from "./corrections";

/** 旧規則の fail 行の種類。 */
export const LEGACY_RULE_FAIL_KINDS = [
  /** 2026-09-29 より前の、未払い POST（本文 `{}`）への 400/422 を no_402 とした行。今は request_shape（unverified）。 */
  "post_400_422_no_402",
  /** 比べた値（declared / offered）を記録していない price_mismatch / metadata_mismatch。 */
  "mismatch_values_unrecorded",
  /** 4,000 バイトで切って読んだ疑いのある accepts_invalid（本文の先頭が x402 の封筒だった）。 */
  "accepts_invalid_body_cut",
] as const;
export type LegacyRuleFailKind = (typeof LEGACY_RULE_FAIL_KINDS)[number];

/** 測り直しのプローブ行と訂正ログに残す印（raw_response_meta.trigger・after.trigger）。 */
export const RULE_CHANGE_REPROBE_TRIGGER = "rule_change_reprobe" as const;

/** cron の C1 が 1 回の実行で優先する、1 ホストあたりの上限（残りは通常の並びへ戻る）。 */
export const RULE_CHANGE_PRIORITY_PER_HOST = 25;

/** 判定に要るプローブ行の記録（x402_l0_probes の列と raw_response_meta）。 */
export type ProbeRowForRuleCheck = {
  verdict: string;
  failReason: string | null;
  method: string | null;
  httpStatus: number | null;
  rawResponseMeta: Record<string, unknown> | null;
  /** 読んだ行の時刻（readNewestProbeRows が埋める。判定には使わない）。 */
  probedAt?: string | null;
};

const hasKey = (meta: Record<string, unknown> | null, key: string): boolean =>
  meta !== null && typeof meta === "object" && Object.prototype.hasOwnProperty.call(meta, key);

/** 純関数: 旧規則の fail 行ならその種類、そうでなければ null。SQL 版（legacyRuleFailKindSql）と同じ表。 */
export function legacyRuleFailKind(row: ProbeRowForRuleCheck): LegacyRuleFailKind | null {
  if (row.verdict !== "fail") return null;
  const meta = row.rawResponseMeta;
  // bodyBytes は 2026-09-29 以降のプローブが応答のあった全行に書く。無ければ変更前の計器の行。
  const legacy = !hasKey(meta, "bodyBytes");
  if (
    row.failReason === "no_402" &&
    legacy &&
    (row.method ?? "").toUpperCase() === "POST" &&
    (row.httpStatus === 400 || row.httpStatus === 422)
  ) {
    return "post_400_422_no_402";
  }
  if ((row.failReason === "price_mismatch" || row.failReason === "metadata_mismatch") && !hasKey(meta, "declared")) {
    return "mismatch_values_unrecorded";
  }
  if (row.failReason === "accepts_invalid" && legacy) {
    const head = meta && typeof meta.bodyHead === "string" ? meta.bodyHead : "";
    if (head.length >= 500 && /"(x402Version|accepts)"/.test(head)) return "accepts_invalid_body_cut";
  }
  return null;
}

/**
 * SQL 版（別名 `p` の x402_l0_probes 行）。旧規則の fail 行の種類（text）か NULL。
 * bodyHead の判定は記録頁（reader.ts の legacyLongEnvelope）と同じ式。
 */
export function legacyRuleFailKindSql(p: string): SQL {
  const a = sql.raw(p);
  return sql`(CASE
    WHEN ${a}.verdict <> 'fail' THEN NULL
    WHEN ${a}.fail_reason = 'no_402' AND upper(${a}.method) = 'POST' AND ${a}.http_status IN (400, 422)
         AND NOT (coalesce(${a}.raw_response_meta, '{}'::jsonb) ? 'bodyBytes') THEN 'post_400_422_no_402'
    WHEN ${a}.fail_reason IN ('price_mismatch', 'metadata_mismatch')
         AND NOT (coalesce(${a}.raw_response_meta, '{}'::jsonb) ? 'declared') THEN 'mismatch_values_unrecorded'
    WHEN ${a}.fail_reason = 'accepts_invalid'
         AND NOT (coalesce(${a}.raw_response_meta, '{}'::jsonb) ? 'bodyBytes')
         AND length(${a}.raw_response_meta->>'bodyHead') >= 500
         AND (${a}.raw_response_meta->>'bodyHead') ~ '"(x402Version|accepts)"' THEN 'accepts_invalid_body_cut'
    ELSE NULL END)`;
}

/**
 * 純関数: 見出しの fail が旧規則の行に乗っているか（新しい順の行）。
 * 公開判定が fail（新しい MIN 行がすべて fail）で、その MIN 行のどれかが旧規則の fail 行。
 * 新しい 2 行がどちらも今の規則の fail なら、それより古い旧規則の行は見出しに効いていないので対象外。
 */
export function needsRuleChangeReprobe(newestFirst: readonly ProbeRowForRuleCheck[]): boolean {
  if (publishedVerdict(newestFirst.map((r) => r.verdict)) !== "fail") return false;
  return newestFirst.slice(0, MIN_CONSECUTIVE_FAILS_TO_PUBLISH).some((r) => legacyRuleFailKind(r) !== null);
}

/**
 * SQL 版（x402_endpoints の別名 `e`）。needsRuleChangeReprobe と同じ条件の boolean。
 * 新しい MIN 行が MIN 行そろってすべて fail、かつそのどれかが旧規則の fail 行。
 */
export function needsRuleChangeReprobeSql(e: string): SQL {
  const a = sql.raw(e);
  return sql`coalesce((
    SELECT count(*) = ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
           AND bool_and(r.verdict = 'fail')
           AND bool_or(${legacyRuleFailKindSql("r")} IS NOT NULL)
    FROM (
      SELECT q.verdict, q.fail_reason, q.method, q.http_status, q.raw_response_meta
      FROM x402_l0_probes q WHERE q.endpoint_id = ${a}.id
      ORDER BY q.probed_at DESC LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
    ) r
  ), false)`;
}

/** 出品 URL のホスト名（小文字・ポートは落とす）。読めなければ URL 全体。 */
export function hostOf(resourceUrl: string): string {
  try {
    return new URL(resourceUrl).hostname.toLowerCase();
  } catch {
    return resourceUrl.toLowerCase();
  }
}

/**
 * 売り手への負荷を数える単位（登録ドメインの近似）。同じ運営者のサブドメイン
 * （mitteleuropa.halowerk.com・suedland.halowerk.com …）を 1 つに数える。
 * 公開接尾辞の表は持たないので、2 文字の国別ドメインの下の短い語（co.uk・com.au …）は 3 段で取る。
 * まとめすぎは遅くなるだけで、売り手への負荷は増えない側の誤り。
 */
export function politenessKeyOf(resourceUrl: string): string {
  const host = hostOf(resourceUrl);
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host; // IP アドレス
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && sld.length <= 3 ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** 公開判定の before / after から訂正ログの行を作る（変わらなければ null）。 */
export function ruleChangeCorrection(input: {
  endpointId: string;
  before: "pass" | "fail" | "unverified";
  after: "pass" | "fail" | "unverified";
  kinds: readonly LegacyRuleFailKind[];
  newFailReason: string | null;
}): {
  subjectType: "endpoint";
  subjectId: string;
  level: "l0";
  reason: "reverify";
  before: { publishedVerdict: string; legacyRuleRows: LegacyRuleFailKind[] };
  after: { publishedVerdict: string; failReason: string | null; trigger: typeof RULE_CHANGE_REPROBE_TRIGGER; note: string };
} | null {
  if (input.before === input.after) return null;
  return {
    subjectType: "endpoint",
    subjectId: input.endpointId,
    level: "l0",
    reason: "reverify",
    before: { publishedVerdict: input.before, legacyRuleRows: [...new Set(input.kinds)] },
    after: {
      publishedVerdict: input.after,
      failReason: input.newFailReason,
      trigger: RULE_CHANGE_REPROBE_TRIGGER,
      note:
        "2026-09-29 audit round 6: the published fail rested on probes recorded before the 2026-09-29 rule change " +
        "(an unpaid POST's 400/422 counted as no_402, a 402 body read only to 4,000 bytes, or a mismatch recorded without the values compared). " +
        "Re-measured with the current probe; this is the published verdict after that probe.",
    },
  };
}

type Executor = { execute: (query: SQL) => Promise<unknown> };

/**
 * 測り直しのプローブ行を書く。公開判定が変わったときは、プローブ行と訂正ログを**1 つの文**で書く
 * （updateWithCorrection・データ変更 CTE）——片方だけが残ることがない。
 *
 *   before: 測る前の新しい順の verdict（公開判定の before はここから計算する）
 * 戻り値は公開判定の before / after と、訂正ログを書いたか。
 */
export async function insertRuleChangeReprobe(
  db: Executor,
  input: {
    endpointId: string;
    priorNewestFirst: readonly ProbeRowForRuleCheck[];
    result: ProbeResult;
    /** 呼び手（cron_c1 / cron_c2 / cron_all / script）。raw_response_meta.reprobeBy に残す。 */
    by: string;
  },
): Promise<{ before: "pass" | "fail" | "unverified"; after: "pass" | "fail" | "unverified"; corrected: boolean }> {
  const { endpointId, priorNewestFirst, result, by } = input;
  const priorVerdicts = priorNewestFirst.map((r) => r.verdict);
  const before = publishedVerdict(priorVerdicts);
  const after = publishedVerdict([result.verdict, ...priorVerdicts]);
  const kinds = priorNewestFirst
    .slice(0, MIN_CONSECUTIVE_FAILS_TO_PUBLISH)
    .map(legacyRuleFailKind)
    .filter((k): k is LegacyRuleFailKind => k !== null);
  const meta = {
    ...(result.rawResponseMeta ?? {}),
    trigger: RULE_CHANGE_REPROBE_TRIGGER,
    reprobeBy: by,
    supersedes: [...new Set(kinds)],
  };
  const insert = sql`
    INSERT INTO x402_l0_probes
      (endpoint_id, method, verdict, dialect, http_status, has_402_challenge, accepts_valid,
       price_consistent, metadata_consistent, latency_ms, fail_reason, raw_response_meta)
    VALUES
      (${endpointId}::uuid, ${result.method}, ${result.verdict}, ${result.dialect}, ${result.httpStatus},
       ${result.has402Challenge}, ${result.acceptsValid}, ${result.priceConsistent}, ${result.metadataConsistent},
       ${result.latencyMs}, ${result.failReason}, ${JSON.stringify(meta)}::jsonb)
    RETURNING endpoint_id::text AS correction_subject_id
  `;
  const correction = ruleChangeCorrection({ endpointId, before, after, kinds, newFailReason: result.failReason });
  if (!correction) {
    await db.execute(insert);
    return { before, after, corrected: false };
  }
  const rows = await updateWithCorrection(db, {
    update: insert,
    subjectType: correction.subjectType,
    level: correction.level,
    reason: correction.reason,
    before: { json: correction.before },
    after: { json: correction.after },
  });
  if (rows.length !== 1) throw new Error(`rule-change reprobe: expected 1 probe row for ${endpointId}, wrote ${rows.length}`);
  return { before, after, corrected: true };
}

/** endpoint の新しい順の MIN 行（測り直しの直前に読む）。 */
export async function readNewestProbeRows(db: Executor, endpointId: string): Promise<ProbeRowForRuleCheck[]> {
  const raw = await db.execute(sql`
    SELECT verdict, fail_reason, method, http_status, raw_response_meta, probed_at::text AS probed_at
    FROM x402_l0_probes WHERE endpoint_id = ${endpointId}::uuid
    ORDER BY probed_at DESC LIMIT ${MIN_CONSECUTIVE_FAILS_TO_PUBLISH}
  `);
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  return rows.map((r) => ({
    verdict: String(r.verdict),
    failReason: (r.fail_reason as string | null) ?? null,
    method: (r.method as string | null) ?? null,
    httpStatus: r.http_status === null || r.http_status === undefined ? null : Number(r.http_status),
    rawResponseMeta: (r.raw_response_meta as Record<string, unknown> | null) ?? null,
    probedAt: (r.probed_at as string | null) ?? null,
  }));
}

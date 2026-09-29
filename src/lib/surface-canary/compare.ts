// ============================================================
// 面の間のずれを見る計器の本体（比べるだけ・取得はしない）。
//
// 同じ出品について、面ごとに言うことが違うか。比べる面:
//   decision   … GET /api/v1/resources/{id}/decision?role=payer
//   mcp        … MCP の check_resource_decision と同じ呼び出し（packages/mcp-server の resourceDecision: url → /resolve → /decision）
//   sellers    … GET /api/v1/sellers/export.csv の行（/sellers の区分の元データ）
//   seller_page… GET /sellers/{host} の `<li id="listing-…">`
//   record     … GET /observatory/e/{observatory_id}
//   ledger     … GET /api/v1/observatory/export.csv（その出品の行）
//   l0         … GET /api/v1/observatory/l0/export.csv（その出品の行）
// 比べる項目: 判定・理由コード・誰の側か・お金が動いたか・数えた失敗の数・L0 と L2 の状態・規則の版。
//
// 「食い違い」は、同じ事実について面どうしが違うことを言うこと。取れなかった面・読めなかった面は
// 「一致」に数えない（skipped に理由を残す）。比べた項目が 0 なら緑にしない（buildReport）。
// ============================================================
import type { OpenApiReasonCodes, ReasonTableRow, RecordPage, SellerListing, Side } from "./parse";
import { sideFromOutcome, sideFromWords } from "./parse";

export const ITEMS = ["verdict", "reason_codes", "side", "money_moved", "failure_count", "l0_state", "l2_state", "rules_version"] as const;
export type Item = (typeof ITEMS)[number];

export type SurfaceValue = { surface: string; value: unknown };
export type Check = {
  item: Item;
  rule: string;
  /** 出品の resource_key（登録簿の検査は "(registry)"） */
  listing: string;
  observatoryId: string | null;
  ok: boolean;
  values: SurfaceValue[];
  detail?: string;
};
export type Skip = { item: Item; rule: string; listing: string; reason: string };

/** 公開面の「出力の形」だけを最小限に読む。無い鍵は undefined のまま（推測で埋めない）。 */
export type DecisionBody = {
  subject?: { id?: string; observatory_id?: string; canonical_url?: string; method?: string };
  recommendation?: string;
  reason_codes?: string[];
  degraded?: boolean;
  rules_version?: string;
  scoredAt?: string;
  facts?: {
    l0?: { status?: string; observed_at?: string | null };
    l1?: { n_delivered?: number; n_settled?: number; n_attempts?: number; last_attempt_at?: string | null };
    l2?: { status?: string; missing_keys?: string[] | null };
  };
  l1_basis?: {
    window_days?: number;
    n_paid_undelivered?: number;
    n_paid_undelivered_since_last_delivery?: number;
    last_delivered_at?: string | null;
    last_attempt_at?: string | null;
  } | null;
  evidence?: { level?: string; purchase_id?: string }[];
};

export type McpView = {
  resourceId: string;
  decision: "ALLOW_PAY" | "REFUSE";
  refuseReasons: string[];
  measurement: DecisionBody;
};

export type Fetched<T> = { ok: true; value: T } | { ok: false; error: string } | { ok: "n/a"; why: string };

export type ListingInput = {
  observatoryId: string;
  resourceKey: string;
  network: string;
  types: string[];
  decision: Fetched<DecisionBody>;
  mcp: Fetched<McpView>;
  sellersRow: Fetched<Record<string, string>>;
  sellerPage: Fetched<SellerListing>;
  record: Fetched<RecordPage>;
  /** その出品の台帳の行（0 行もあり得る）。台帳そのものが取れなければ ok:false */
  ledgerRows: Fetched<Record<string, string>[]>;
  /** 台帳を読んだ時刻（x-vet402-retrieved-at）。これより後の購入は台帳に無くて当然なので数の比較を控える */
  ledgerRetrievedAt: string | null;
  l0Row: Fetched<Record<string, string>>;
};

export type Registry = {
  docs: { rows: ReasonTableRow[]; rulesVersion: string | null } | null;
  openapi: OpenApiReasonCodes | null;
  llms: { name: string; tokens: Set<string>; rulesVersions: string[] }[];
};

// ---- 語の対応 -------------------------------------------------------------------------------

/** 台帳で vet402 が署名した試行の status（それ以外は署名の前に止まった行）。 */
const SIGNED = new Set(["settled", "settle_failed", "settle_claimed", "settle_claim_refuted", "delivered_no_receipt"]);
const UNSIGNED = new Set(["no_eligible_accept", "over_cap", "no_402", "price_mismatch", "payto_mismatch"]);
/** 判定が「売り手に数えた失敗」を言う語 */
const COUNTED_FAILURE = new Set(["l1_never_delivered", "l1_latest_failed", "l1_paid_not_delivered"]);
/** 「数えない」語 → その理由の面の区分 */
const NOT_COUNTED_SIDE: Record<string, Side[]> = {
  l1_not_counted_vet402_side: ["vet402"],
  l1_not_counted_unproven: ["unsorted"],
  l1_not_counted_unconfirmed: ["unsorted"],
  l1_not_counted_no_charge: ["unsorted"],
};

/** 判定の L2 の語 ↔ 台帳の l2_schema。判定の undeclared は「数えない」（宣言なし・読めない本文）。 */
const L2_EQUIV: Record<string, string[]> = {
  mismatch: ["mismatch"],
  conform: ["match"],
  undeclared: ["no_declaration", ""],
  // 2026-09-29.4: 宣言があって照合できない L2 は not_checked（WARN）。宣言の無い出品だけが undeclared
  not_checked: ["not_checked"],
};

const is2xx = (h: string | number | null | undefined) => {
  const n = typeof h === "number" ? h : Number(h);
  return Number.isFinite(n) && n >= 200 && n < 300;
};
const minuteOf = (iso: string | null | undefined): string | null =>
  iso && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : null;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso.replace(" ", "T").replace(/\+00$/, "Z")) : NaN);
/** 記録頁の Result 列（"settled (nonce-bound)"）を台帳の status の語へ */
const statusWord = (result: string | null | undefined) => (result ?? "").trim().split(/\s|\(/)[0] ?? "";
const moneyMoved = (r: Record<string, string>) =>
  r.confirmed_units !== undefined && r.confirmed_units !== "" ? Number(r.confirmed_units) > 0 : r.status === "settled";

// ---- 理由コードの表 -------------------------------------------------------------------------

type CodeBook = { verdictOf(code: string): string | null; inDocs(code: string): boolean; inOpenApi(code: string): boolean };

export function codeBook(reg: Registry): CodeBook {
  const fixed = new Map<string, string>();
  const families: { re: RegExp; verdict: string }[] = [];
  for (const r of reg.docs?.rows ?? []) {
    if (r.code.includes("<")) {
      const src = "^" + r.code.split(/<[^>]+>/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9_]+") + "$";
      families.push({ re: new RegExp(src), verdict: r.verdict });
    } else fixed.set(r.code, r.verdict);
  }
  return {
    verdictOf(code) {
      if (fixed.has(code)) return fixed.get(code)!;
      return families.find((f) => f.re.test(code))?.verdict ?? null;
    },
    inDocs(code) {
      return fixed.has(code) || families.some((f) => f.re.test(code));
    },
    inOpenApi(code) {
      const o = reg.openapi;
      return !!o && (o.enum.includes(code) || o.patterns.some((p) => p.test(code)));
    },
  };
}

/** 「測っていない」ことだけを言う L0 の語（1 回失敗を見た single_fail 系は「測った」側なので外す）。 */
function isUnmeasuredL0(code: string): boolean {
  return (
    code === "l0_unverified" ||
    (code.startsWith("l0_unverified_") && code !== "l0_unverified_single_fail" && code !== "l0_unverified_single_fail_unconfirmed")
  );
}

// ---- 1 出品の比較 --------------------------------------------------------------------------

export function compareListing(x: ListingInput, reg: Registry): { checks: Check[]; skips: Skip[] } {
  const checks: Check[] = [];
  const skips: Skip[] = [];
  const book = codeBook(reg);
  const push = (item: Item, rule: string, ok: boolean, values: SurfaceValue[], detail?: string) =>
    checks.push({ item, rule, listing: x.resourceKey, observatoryId: x.observatoryId, ok, values, ...(detail ? { detail } : {}) });
  const skip = (item: Item, rule: string, reason: string) => skips.push({ item, rule, listing: x.resourceKey, reason });

  const d = x.decision.ok === true ? x.decision.value : null;
  const mcp = x.mcp.ok === true ? x.mcp.value : null;
  const sellers = x.sellersRow.ok === true ? x.sellersRow.value : null;
  const page = x.sellerPage.ok === true ? x.sellerPage.value : null;
  const rec = x.record.ok === true ? x.record.value : null;
  const ledger = x.ledgerRows.ok === true ? x.ledgerRows.value : null;
  const l0 = x.l0Row.ok === true ? x.l0Row.value : null;

  const codes = d?.reason_codes ?? [];
  const rec1 = d?.recommendation;

  // ---- 判定 ----
  if (d && mcp) {
    push("verdict", "mcp_same_recommendation", mcp.measurement.recommendation === rec1, [
      { surface: "decision", value: rec1 },
      { surface: "mcp", value: mcp.measurement.recommendation },
    ]);
    const expected = rec1 === "ALLOW" && !d.degraded ? "ALLOW_PAY" : "REFUSE";
    push("verdict", "mcp_pay_decision", mcp.decision === expected, [
      { surface: "decision", value: `${rec1}${d.degraded ? " (degraded)" : ""}` },
      { surface: "mcp", value: mcp.decision },
    ]);
  } else skip("verdict", "mcp_same_recommendation", !d ? "decision not read" : "mcp not read");

  if (d && rec1 === "BLOCK") {
    const blockCodes = codes.filter((c) => (book.verdictOf(c) ?? "").includes("BLOCK"));
    if (blockCodes.length > 0 && blockCodes.every(isUnmeasuredL0)) {
      // 判定は「測っていない」ことだけで BLOCK。ほかの面が「測っていない・未確定・まだ試していない」と言うなら、
      // 同じ事実について片方は出品に不利な判定、片方は「失敗ではない」を言っている。
      const others: SurfaceValue[] = [];
      if (l0 && (l0.latest_probe_verdict === "" || l0.published_verdict === "unverified"))
        others.push({ surface: "l0", value: l0.latest_probe_verdict === "" ? "no probe (unverified)" : `published ${l0.published_verdict}` });
      if (rec && rec.publishedState === "unverified") others.push({ surface: "record", value: "Published state: unverified (unverified is not a failure)" });
      if (sellers && sellers.outcome === "not_tried") others.push({ surface: "sellers", value: "not_tried" });
      if (page && sideFromWords(page.latestAttempt) === "not_tried") others.push({ surface: "seller_page", value: page.latestAttempt });
      if (others.length > 0)
        push("verdict", "block_vs_unmeasured", false, [{ surface: "decision", value: `BLOCK (${blockCodes.join(", ")})` }, ...others],
          "BLOCK rests only on codes that say vet402 has not measured the listing");
      else push("verdict", "block_vs_unmeasured", true, [{ surface: "decision", value: `BLOCK (${blockCodes.join(", ")})` }]);
    }
  }

  // ---- 理由コード ----
  if (d) {
    const notOpenApi = codes.filter((c) => !book.inOpenApi(c));
    push("reason_codes", "codes_in_openapi", notOpenApi.length === 0, [
      { surface: "decision", value: codes },
      { surface: "openapi", value: notOpenApi.length ? `missing: ${notOpenApi.join(", ")}` : "all listed" },
    ]);
    const notDocs = codes.filter((c) => !book.inDocs(c));
    push("reason_codes", "codes_in_docs_table", notDocs.length === 0, [
      { surface: "decision", value: codes },
      { surface: "docs", value: notDocs.length ? `missing: ${notDocs.join(", ")}` : "all listed" },
    ]);
    const verdicts = codes.map((c) => book.verdictOf(c) ?? "?");
    const backed =
      rec1 === "BLOCK"
        ? verdicts.some((v) => v.includes("BLOCK"))
        : rec1 === "WARN"
          ? verdicts.some((v) => v.includes("WARN") || v.includes("BLOCK"))
          : rec1 === "ALLOW"
            ? verdicts.every((v) => v === "—")
            : false;
    push("reason_codes", "verdict_backed_by_docs_table", backed, [
      { surface: "decision", value: `${rec1} ← ${codes.join(", ")}` },
      { surface: "docs", value: codes.map((c, i) => `${c}=${verdicts[i]}`).join(", ") },
    ]);
  }
  if (d && mcp) {
    const a = [...new Set(codes)].sort().join(",");
    const b = [...new Set(mcp.measurement.reason_codes ?? [])].sort().join(",");
    push("reason_codes", "mcp_same_codes", a === b, [
      { surface: "decision", value: codes },
      { surface: "mcp", value: mcp.measurement.reason_codes },
    ]);
    if (mcp.decision === "REFUSE") {
      const allowed = new Set([...codes, "degraded_measurement", "recommendation_not_allow"]);
      const stray = mcp.refuseReasons.filter((r) => !allowed.has(r));
      const refusing = codes.filter((c) => {
        const v = book.verdictOf(c);
        return v !== null && v !== "—";
      });
      const missing = refusing.filter((c) => !mcp.refuseReasons.includes(c));
      push("reason_codes", "mcp_refuse_reasons", stray.length === 0 && missing.length === 0, [
        { surface: "decision", value: codes },
        { surface: "mcp", value: mcp.refuseReasons },
      ], stray.length || missing.length ? `not in decision: [${stray.join(", ")}]; verdict-bearing codes missing: [${missing.join(", ")}]` : undefined);
    }
  }

  // ---- 規則の版 ----
  if (d && mcp)
    push("rules_version", "mcp_same_rules_version", d.rules_version === mcp.measurement.rules_version, [
      { surface: "decision", value: d.rules_version },
      { surface: "mcp", value: mcp.measurement.rules_version },
    ]);

  // ---- 窓の中の台帳 ----
  const windowDays = d?.l1_basis?.window_days ?? 30;
  const scoredAt = ms(d?.scoredAt);
  const windowStart = scoredAt - windowDays * 86_400_000;
  const EDGE = 2 * 3_600_000;
  const inWindow = (iso: string) => {
    const t = ms(iso);
    return t > windowStart && t <= scoredAt;
  };
  const nearEdge = ledger?.some((r) => Math.abs(ms(r.attempted_at) - windowStart) < EDGE) ?? false;
  const afterLedgerRead =
    x.ledgerRetrievedAt !== null && d?.facts?.l1?.last_attempt_at ? ms(d.facts.l1.last_attempt_at) > ms(x.ledgerRetrievedAt) : false;
  const win = ledger && Number.isFinite(scoredAt) ? ledger.filter((r) => inWindow(r.attempted_at)) : null;
  const unknownStatus = win?.filter((r) => !SIGNED.has(r.status) && !UNSIGNED.has(r.status)) ?? [];
  const countsComparable = d && win && !nearEdge && !afterLedgerRead && unknownStatus.length === 0;
  const whyNot = !d
    ? "decision not read"
    : !win
      ? "ledger not read"
      : nearEdge
        ? "a ledger row sits within 2 h of the 30-day window edge"
        : afterLedgerRead
          ? "an attempt landed after the ledger was read"
          : `ledger status not known to the canary: ${unknownStatus.map((r) => r.status).join(", ")}`;

  // ---- お金が動いたか・数えた失敗 ----
  if (countsComparable) {
    const l1 = d!.facts?.l1 ?? {};
    const moved = win!.filter(moneyMoved);
    push("money_moved", "n_settled_vs_ledger", l1.n_settled === moved.length, [
      { surface: "decision", value: `facts.l1.n_settled=${l1.n_settled}` },
      { surface: "ledger", value: `${moved.length} rows with confirmed_units>0 in ${windowDays}d` },
    ]);
    const lower = win!.filter((r) => moneyMoved(r) && !is2xx(r.http_status_paid) && r.held_reason === "").length;
    const upper = win!.filter((r) => (moneyMoved(r) || (r.status === "settle_failed" && r.tx_hash !== "")) && r.held_reason === "").length;
    const npu = d!.l1_basis?.n_paid_undelivered;
    if (typeof npu === "number")
      push("money_moved", "paid_undelivered_vs_ledger", npu >= lower && npu <= upper, [
        { surface: "decision", value: `l1_basis.n_paid_undelivered=${npu}` },
        { surface: "ledger", value: `between ${lower} (settled, non-2xx, not held) and ${upper} (money moved or tx on record, not held)` },
      ]);
    if (codes.includes("l1_paid_not_delivered"))
      push("money_moved", "paid_not_delivered_has_money", upper >= 1, [
        { surface: "decision", value: "l1_paid_not_delivered" },
        { surface: "ledger", value: `${upper} rows where money moved and not held` },
      ]);
    const signed = win!.filter((r) => SIGNED.has(r.status)).length;
    push("failure_count", "n_attempts_vs_ledger", l1.n_attempts === signed, [
      { surface: "decision", value: `facts.l1.n_attempts=${l1.n_attempts}` },
      { surface: "ledger", value: `${signed} signed rows in ${windowDays}d` },
    ]);
    const twoxx = win!.filter((r) => SIGNED.has(r.status) && is2xx(r.http_status_paid)).length;
    if (typeof l1.n_delivered === "number")
      push("failure_count", "n_delivered_vs_ledger", l1.n_delivered <= twoxx, [
        { surface: "decision", value: `facts.l1.n_delivered=${l1.n_delivered}` },
        { surface: "ledger", value: `${twoxx} signed rows answered 2xx` },
      ]);
  } else {
    skip("money_moved", "n_settled_vs_ledger", whyNot);
    skip("failure_count", "n_attempts_vs_ledger", whyNot);
  }
  if (d && mcp) {
    const a = d.facts?.l1 ?? {};
    const b = mcp.measurement.facts?.l1 ?? {};
    push("failure_count", "mcp_same_l1_counts", a.n_attempts === b.n_attempts && a.n_settled === b.n_settled && a.n_delivered === b.n_delivered, [
      { surface: "decision", value: `attempts ${a.n_attempts} · settled ${a.n_settled} · delivered ${a.n_delivered}` },
      { surface: "mcp", value: `attempts ${b.n_attempts} · settled ${b.n_settled} · delivered ${b.n_delivered}` },
    ]);
  }

  // ---- 記録頁の行 ↔ 台帳の行（お金・L2・状態）----
  if (rec && ledger) {
    const byTx = new Map(ledger.filter((r) => r.tx_hash).map((r) => [r.tx_hash.toLowerCase(), r]));
    const bad: string[] = [];
    let joined = 0;
    for (const row of rec.rows) {
      const lr =
        (row.txHash ? byTx.get(row.txHash.toLowerCase()) : undefined) ??
        (() => {
          const same = ledger.filter((r) => minuteOf(r.attempted_at) === row.attemptedMinute && statusWord(row.result) === r.status);
          return same.length === 1 ? same[0] : undefined;
        })();
      if (!lr) continue;
      joined++;
      const rs = statusWord(row.result);
      if ((rs === "settled") !== moneyMoved(lr)) bad.push(`${row.attemptedMinute}: record ${row.result} / ledger ${lr.status} confirmed_units=${lr.confirmed_units}`);
      // 台帳の l2_schema は記録の値のまま（互換）。判定・記録頁と同じ読み直しは l2_reading（2026-09-29.4）。あればそちらと比べる
      const lrL2 = (lr as Record<string, string | undefined>).l2_reading || lr.l2_schema;
      if (row.l2 !== null && lrL2 !== "" && row.l2 !== lrL2) bad.push(`${row.attemptedMinute}: record L2 ${row.l2} / ledger l2 ${lrL2}`);
    }
    if (joined > 0) push("money_moved", "record_rows_vs_ledger", bad.length === 0, [
      { surface: "record", value: `${rec.rows.length} rows (${joined} joined to the ledger)` },
      { surface: "ledger", value: bad.length ? bad.slice(0, 5) : "all joined rows agree" },
    ]);
    else if (rec.rows.length > 0) skip("money_moved", "record_rows_vs_ledger", "no record row joined to a ledger row (older than the 90-day export?)");
  }

  // ---- 誰の側か: まだ試していない ↔ 行がある ----
  if (sellers && ledger) {
    const notTried = sellers.outcome === "not_tried";
    const rows = ledger.length;
    const recRows = rec?.rows.length ?? null;
    const ok = notTried ? rows === 0 && (recRows === null || recRows === 0) : true;
    push("side", "not_tried_vs_rows", ok, [
      { surface: "sellers", value: sellers.outcome },
      { surface: "ledger", value: `${rows} rows in 90d` },
      ...(recRows === null ? [] : [{ surface: "record", value: `${recRows} purchase rows` }]),
    ]);
  }

  // ---- 誰の側か・状態: 最新の行（同じ行を指しているときだけ比べる）----
  if (sellers && sellers.outcome !== "not_tried") {
    const csvMin = minuteOf(sellers.latest_attempted_at);
    const pageMin = page ? minuteOf(page.attemptedAtIso) ?? (page.latestAttempt?.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0] ?? null) : null;
    const recRow = rec?.rows[0] ?? null;
    const aligned = [pageMin, recRow?.attemptedMinute].filter((m): m is string => m != null).every((m) => m === csvMin);
    if (!aligned) {
      skip("side", "latest_row_side", `latest row differs between surfaces (sellers ${csvMin}, seller_page ${pageMin}, record ${recRow?.attemptedMinute}) — cache ages`);
    } else {
      const vals: SurfaceValue[] = [{ surface: "sellers", value: `${sellers.outcome}${sellers.side_label ? ` (${sellers.side_label})` : ""}` }];
      const sides: Side[] = [sideFromOutcome(sellers.outcome)].filter((s): s is Side => s !== null);
      if (page) {
        vals.push({ surface: "seller_page", value: page.whoseSide });
        const s = sideFromWords(page.whoseSide);
        if (s) sides.push(s);
      }
      if (recRow) {
        vals.push({ surface: "record", value: recRow.whoseSide });
        const s = sideFromWords(recRow.whoseSide);
        if (s) sides.push(s);
      }
      // 「not sorted」の語は面の間で一字一句同じはず（記録頁は「the same words as the seller page」と書く）
      const words = [sellers.side_label, page?.whoseSide, recRow?.whoseSide].filter(
        (w): w is string => !!w && w !== "—" && sideFromWords(w) === "unsorted",
      );
      const sameWords = new Set(words.map((w) => w.replace(/\s+/g, " ").trim())).size <= 1;
      if (sides.length >= 2) push("side", "latest_row_side", new Set(sides).size === 1 && sameWords, vals);
      else skip("side", "latest_row_side", "fewer than two surfaces named a side for the latest row");

      const statuses: SurfaceValue[] = [{ surface: "sellers", value: `${sellers.latest_status}${sellers.held_reason ? ` held ${sellers.held_reason}` : ""}` }];
      const st = new Set([sellers.latest_status]);
      const held = new Set([sellers.held_reason]);
      const lr = ledger?.find((r) => r.purchase_id && r.purchase_id === sellers.purchase_id);
      if (lr) {
        statuses.push({ surface: "ledger", value: `${lr.status}${lr.held_reason ? ` held ${lr.held_reason}` : ""}` });
        st.add(lr.status);
        held.add(lr.held_reason);
      } else if (sellers.in_ledger_export === "true" && ledger) {
        statuses.push({ surface: "ledger", value: `purchase_id ${sellers.purchase_id} not found` });
        st.add("(missing)");
      }
      if (page?.recordedStatus) {
        statuses.push({ surface: "seller_page", value: `${page.recordedStatus}${page.heldAs ? ` held ${page.heldAs}` : ""}` });
        st.add(page.recordedStatus);
        held.add(page.heldAs ?? "");
      }
      if (recRow) {
        statuses.push({ surface: "record", value: recRow.result });
        st.add(statusWord(recRow.result));
      }
      if (statuses.length >= 2) push("money_moved", "latest_row_status", st.size === 1 && held.size === 1, statuses);
    }
  }

  // ---- 誰の側か: 判定が数えた／数えなかった ↔ 面の区分 ----
  if (d && rec && Number.isFinite(scoredAt)) {
    const lastDelivered = ms(d.l1_basis?.last_delivered_at ?? null);
    const inWin = rec.rows.filter((r) => inWindow(r.attemptedMinute.replace(" ", "T") + ":00Z"));
    const sidesInWin = inWin.map((r) => sideFromWords(r.whoseSide));
    const nearEdgeRec = rec.rows.some((r) => Math.abs(ms(r.attemptedMinute.replace(" ", "T") + ":00Z") - windowStart) < EDGE);
    if (nearEdgeRec) skip("side", "codes_vs_record_sides", "a record row sits within 2 h of the window edge");
    else if (sidesInWin.some((s) => s === null) && inWin.length > 0 && sidesInWin.every((s) => s === null))
      skip("side", "codes_vs_record_sides", "record rows carry no 'Whose side' words");
    else {
      const npu = d.l1_basis?.n_paid_undelivered ?? 0;
      // (a) お金の動いていない「売り手に数えた失敗」には、面のどこかに売り手の側の行が要る
      if (codes.includes("l1_never_delivered") && npu === 0 && !codes.includes("l1_paid_not_delivered"))
        push("side", "counted_failure_has_seller_side_row", sidesInWin.includes("seller"), [
          { surface: "decision", value: "l1_never_delivered (no money moved)" },
          { surface: "record", value: `sides in window: ${sidesInWin.map((s) => s ?? "?").join(", ") || "none"}` },
        ]);
      // (b) 最後の配達より後に売り手の側の行があれば、判定はそれを数えているはず
      const sellerAfter = inWin.filter(
        (r, i) => sidesInWin[i] === "seller" && !(ms(r.attemptedMinute.replace(" ", "T") + ":00Z") <= lastDelivered),
      );
      if (sellerAfter.length > 0)
        push("side", "seller_side_row_is_counted", codes.some((c) => COUNTED_FAILURE.has(c)), [
          { surface: "record", value: `${sellerAfter.length} seller's-side rows after the last delivery` },
          { surface: "decision", value: codes },
        ]);
      // (c) 「数えない」理由の語には、面の上でその区分の行が要る
      for (const c of codes) {
        const want = NOT_COUNTED_SIDE[c];
        if (!want) continue;
        if (inWin.length === 0) {
          skip("side", "not_counted_code_has_row", `${c}: no record row in the window`);
          continue;
        }
        push("side", "not_counted_code_has_row", sidesInWin.some((s) => s !== null && want.includes(s)), [
          { surface: "decision", value: c },
          { surface: "record", value: `sides in window: ${sidesInWin.map((s) => s ?? "?").join(", ")}` },
        ]);
      }
    }
  }

  // ---- L0 の状態 ----
  if (d && (l0 || rec)) {
    const decL0 = d.facts?.l0?.status ?? null;
    const sameProbe =
      !l0 || (l0.last_probed_at === "" && !d.facts?.l0?.observed_at) ||
      (l0.last_probed_at !== "" && !!d.facts?.l0?.observed_at && Math.abs(ms(l0.last_probed_at) - ms(d.facts.l0.observed_at)) < 1000);
    if (!sameProbe) skip("l0_state", "l0_published_state", `different probes (l0 export ${l0?.last_probed_at}, decision ${d.facts?.l0?.observed_at})`);
    else {
      const vals: SurfaceValue[] = [{ surface: "decision", value: decL0 }];
      const set = new Set([decL0]);
      if (l0) {
        vals.push({ surface: "l0", value: l0.published_verdict });
        set.add(l0.published_verdict);
      }
      if (rec?.publishedState) {
        vals.push({ surface: "record", value: rec.publishedState });
        set.add(rec.publishedState);
      }
      const failCode = codes.includes("l0_fail");
      const failElsewhere = l0?.published_verdict === "fail" || rec?.publishedState === "fail";
      push("l0_state", "l0_published_state", set.size === 1 && failCode === failElsewhere, vals);
    }
  }

  // ---- L2 の状態 ----
  if (d && ledger) {
    const decL2 = d.facts?.l2?.status ?? null;
    const evTx = (d.evidence ?? []).find((e) => e.level === "L2")?.purchase_id ?? null;
    const txOf = (pid: string | null) => (pid ? /(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/.exec(pid)?.[1] ?? null : null);
    const target =
      (evTx && ledger.find((r) => r.tx_hash && r.tx_hash.toLowerCase() === (txOf(evTx) ?? "").toLowerCase())) ||
      // 証拠の行が無ければ、窓（30 日）の中の最新の配達。窓の外の配達は判定の L2 が読まない（「checked なし」で正しい）。
      [...ledger]
        .filter((r) => moneyMoved(r) && is2xx(r.http_status_paid) && (!Number.isFinite(scoredAt) || inWindow(r.attempted_at)))
        .sort((a, b) => b.attempted_at.localeCompare(a.attempted_at))[0];
    if (!decL2 || !L2_EQUIV[decL2]) skip("l2_state", "l2_same_row", `decision L2 status ${decL2} not in the canary's vocabulary`);
    else if (!target) {
      if (decL2 === "mismatch" || decL2 === "conform")
        push("l2_state", "l2_same_row", false, [
          { surface: "decision", value: decL2 },
          { surface: "ledger", value: `no delivered row in the ${windowDays}-day window to carry it` },
        ]);
      else skip("l2_state", "l2_same_row", "no delivered row in the window");
    } else {
      const tL2 = (target as Record<string, string | undefined>).l2_reading || target.l2_schema;
      const recRow = rec?.rows.find((r) => (r.txHash && target.tx_hash && r.txHash.toLowerCase() === target.tx_hash.toLowerCase()) || r.attemptedMinute === minuteOf(target.attempted_at));
      const vals: SurfaceValue[] = [
        { surface: "decision", value: `${decL2}${d.facts?.l2?.missing_keys?.length ? ` missing ${d.facts.l2.missing_keys.join(",")}` : ""}` },
        { surface: "ledger", value: `${tL2 || "(blank)"} @ ${target.attempted_at}` },
      ];
      let ok = (L2_EQUIV[decL2] ?? []).includes(tL2);
      if (recRow?.l2) {
        vals.push({ surface: "record", value: recRow.l2 });
        ok = ok && L2_EQUIV[decL2]!.includes(recRow.l2);
      }
      push("l2_state", "l2_same_row", ok, vals);
    }
    // 判定の証拠の行は台帳に在るか
    const ev = (d.evidence ?? []).filter((e) => (e.level === "L1" || e.level === "L2") && e.purchase_id);
    if (ev.length > 0) {
      const missing = ev.filter((e) => {
        const tx = txOf(e.purchase_id!);
        return tx ? !ledger.some((r) => r.tx_hash && r.tx_hash.toLowerCase() === tx.toLowerCase()) : !ledger.some((r) => r.purchase_id === e.purchase_id);
      });
      const old = d.facts?.l1?.last_attempt_at && ms(d.facts.l1.last_attempt_at) < scoredAt - 85 * 86_400_000;
      if (old) skip("l2_state", "evidence_in_ledger", "evidence may be older than the 90-day export");
      else
        push("l2_state", "evidence_in_ledger", missing.length === 0, [
          { surface: "decision", value: ev.map((e) => `${e.level} ${e.purchase_id}`) },
          { surface: "ledger", value: missing.length ? `not found: ${missing.map((e) => e.purchase_id).join(", ")}` : "found" },
        ]);
    }
  }

  // ---- 売り手頁の「Decision API now」リンクは同じ resource を指すか ----
  if (d && page?.decisionResourceId)
    push("verdict", "seller_page_links_same_resource", page.decisionResourceId === d.subject?.id, [
      { surface: "decision", value: d.subject?.id },
      { surface: "seller_page", value: page.decisionResourceId },
    ]);
  if (d && mcp)
    push("verdict", "mcp_resolves_same_resource", mcp.resourceId === d.subject?.id, [
      { surface: "decision", value: d.subject?.id },
      { surface: "mcp", value: mcp.resourceId },
    ]);

  return { checks, skips };
}

// ---- 登録簿（理由コードの一覧と規則の版）の比較 ----------------------------------------------

export function compareRegistry(reg: Registry, decisionRulesVersions: string[]): { checks: Check[]; skips: Skip[] } {
  const checks: Check[] = [];
  const skips: Skip[] = [];
  const push = (item: Item, rule: string, ok: boolean, values: SurfaceValue[], detail?: string) =>
    checks.push({ item, rule, listing: "(registry)", observatoryId: null, ok, values, ...(detail ? { detail } : {}) });
  const o = reg.openapi;
  const docs = reg.docs;
  if (o && docs) {
    const fixed = new Set(docs.rows.filter((r) => !r.code.includes("<")).map((r) => r.code));
    const en = new Set(o.enum);
    const onlyDocs = [...fixed].filter((c) => !en.has(c));
    const onlyApi = [...en].filter((c) => !fixed.has(c));
    push("reason_codes", "docs_table_equals_openapi_enum", onlyDocs.length === 0 && onlyApi.length === 0, [
      { surface: "docs", value: onlyDocs.length ? `only in docs: ${onlyDocs.join(", ")}` : `${fixed.size} fixed codes` },
      { surface: "openapi", value: onlyApi.length ? `only in openapi: ${onlyApi.join(", ")}` : `${en.size} enum codes` },
    ]);
    const fam = docs.rows.filter((r) => r.code.includes("<")).length;
    push("reason_codes", "docs_families_equal_openapi_patterns", fam === o.patterns.length, [
      { surface: "docs", value: `${fam} families` },
      { surface: "openapi", value: `${o.patterns.length} x-vet402-patterns` },
    ]);
  } else skips.push({ item: "reason_codes", rule: "docs_table_equals_openapi_enum", listing: "(registry)", reason: !o ? "openapi not read" : "docs table not read" });
  if (o) {
    for (const l of reg.llms) {
      // llms に出る l0_/l1_/l2_ の語は、理由コード（enum・パターン）か、openapi が鍵・列として定義する語のどれか
      const undefinedWords = [...l.tokens].filter(
        (t) => !o.enum.includes(t) && !o.patterns.some((p) => p.test(t)) && !o.yamlKeys.has(t) && !o.backticked.has(t)
          // `l1_not_counted_`* のようにまとめて指す書き方（語頭）は、その語頭で始まるコードがあれば定義済み
          && !o.enum.some((c) => c.startsWith(`${t}_`)),
      );
      push("reason_codes", "llms_codes_defined", undefinedWords.length === 0, [
        { surface: l.name, value: `${l.tokens.size} l0_/l1_/l2_ words` },
        { surface: "openapi", value: undefinedWords.length ? `undefined: ${undefinedWords.join(", ")}` : "all defined" },
      ]);
    }
  }
  // 規則の版
  const versions: SurfaceValue[] = [];
  const set = new Set<string>();
  const dv = [...new Set(decisionRulesVersions)];
  if (dv.length > 0) {
    versions.push({ surface: "decision", value: dv.join(" | ") });
    dv.forEach((v) => set.add(v));
  }
  if (docs?.rulesVersion) {
    versions.push({ surface: "docs", value: docs.rulesVersion });
    set.add(docs.rulesVersion);
  }
  if (o?.since) {
    versions.push({ surface: "openapi", value: o.since });
    set.add(o.since);
  }
  for (const l of reg.llms) {
    // 版を書いていない文書は比べない（書いてあって違うときだけ食い違い）。履歴として古い版を並べる文もあるので、
    // 判定の版がその中に在れば一致とする。
    if (l.rulesVersions.length === 0) continue;
    const vs = [...new Set(l.rulesVersions)];
    versions.push({ surface: l.name, value: vs.join(" | ") });
    if (dv.length === 1 && !vs.includes(dv[0]!)) set.add(`${l.name}:${vs.join("|")}`);
  }
  if (versions.length >= 2) push("rules_version", "rules_version_everywhere", set.size === 1, versions);
  else skips.push({ item: "rules_version", rule: "rules_version_everywhere", listing: "(registry)", reason: "fewer than two surfaces carry a rules version" });
  return { checks, skips };
}

// ---- 報告（fail-loud）-------------------------------------------------------------------------

export type SurfaceTally = { attempted: number; fetched: number; failed: { surface: string; listing: string; error: string }[] };

export type Report = {
  ok: boolean;
  failReasons: string[];
  sampled: number;
  byType: Record<string, number>;
  byVerdict: Record<string, number>;
  surfaces: { attempted: number; fetched: number; failed: number; failedList: SurfaceTally["failed"] };
  compared: number;
  comparedByItem: Record<string, number>;
  discrepancies: Check[];
  skipped: number;
  skips: Skip[];
};

export type Thresholds = { minSample: number; requiredTypes: string[]; requiredVerdicts: string[]; maxSurfaceFailureRate: number };

export const DEFAULT_THRESHOLDS: Thresholds = {
  minSample: 40,
  requiredTypes: ["l1_failure", "l2_mismatch", "l2_not_checked", "unprobed", "path_template"],
  requiredVerdicts: ["ALLOW", "WARN", "BLOCK"],
  maxSurfaceFailureRate: 0.1,
};

export function buildReport(args: {
  listings: ListingInput[];
  registry: Registry;
  tally: SurfaceTally;
  thresholds?: Thresholds;
}): Report {
  const t = args.thresholds ?? DEFAULT_THRESHOLDS;
  const checks: Check[] = [];
  const skips: Skip[] = [];
  const byType: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  const rulesVersions: string[] = [];
  for (const l of args.listings) {
    for (const ty of l.types) byType[ty] = (byType[ty] ?? 0) + 1;
    if (l.decision.ok === true) {
      const r = l.decision.value.recommendation ?? "?";
      byVerdict[r] = (byVerdict[r] ?? 0) + 1;
      if (l.decision.value.rules_version) rulesVersions.push(l.decision.value.rules_version);
    }
    const c = compareListing(l, args.registry);
    checks.push(...c.checks);
    skips.push(...c.skips);
  }
  const r = compareRegistry(args.registry, rulesVersions);
  checks.push(...r.checks);
  skips.push(...r.skips);

  const comparedByItem: Record<string, number> = Object.fromEntries(ITEMS.map((i) => [i, 0]));
  for (const c of checks) comparedByItem[c.item] = (comparedByItem[c.item] ?? 0) + 1;

  const failReasons: string[] = [];
  const discrepancies = checks.filter((c) => !c.ok);
  if (discrepancies.length > 0) failReasons.push(`${discrepancies.length} discrepancies between surfaces`);
  if (args.tally.fetched === 0) failReasons.push("no surface was fetched");
  if (checks.length === 0) failReasons.push("no item was compared");
  const sampled = args.listings.filter((l) => l.decision.ok === true).length;
  if (sampled < t.minSample) failReasons.push(`sample too small: ${sampled} listings with a decision (need ${t.minSample})`);
  for (const ty of t.requiredTypes) if (!byType[ty]) failReasons.push(`sample lacks type ${ty}`);
  for (const v of t.requiredVerdicts) if (!byVerdict[v]) failReasons.push(`sample lacks verdict ${v}`);
  const idle = ITEMS.filter((i) => comparedByItem[i] === 0);
  if (idle.length > 0) failReasons.push(`items never compared: ${idle.join(", ")}`);
  const rate = args.tally.attempted === 0 ? 1 : args.tally.failed.length / args.tally.attempted;
  if (rate > t.maxSurfaceFailureRate)
    failReasons.push(`${args.tally.failed.length}/${args.tally.attempted} surface fetches failed (limit ${Math.round(t.maxSurfaceFailureRate * 100)}%)`);

  return {
    ok: failReasons.length === 0,
    failReasons,
    sampled,
    byType,
    byVerdict,
    surfaces: { attempted: args.tally.attempted, fetched: args.tally.fetched, failed: args.tally.failed.length, failedList: args.tally.failed },
    compared: checks.length,
    comparedByItem,
    discrepancies,
    skipped: skips.length,
    skips,
  };
}

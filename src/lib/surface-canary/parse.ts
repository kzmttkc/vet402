// ============================================================
// 面の間のずれを見る計器（surface-consistency canary）の読み手。
//
// ここは**公開面の出力だけ**を読む。判定・分類の実装（src/lib/decision・src/lib/sellers）は import しない。
// 実装を見て比べると、同じ関数の出力どうしを比べるだけになり、面の食い違い（監査の周回で人が見つけていたもの）
// を拾えない。読むのは本番が返す JSON・CSV・HTML・YAML・テキストの文字列だけ。
//
// 読めなかった面は null を返す（黙って「一致」にしない）。呼び手はそれを「取れなかった面」として数える。
// ============================================================

// ---- CSV ----------------------------------------------------------------------------------

/** RFC 4180 の CSV（引用符・引用符の中の改行とカンマ・"" のエスケープ）を行の配列にする。 */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ""));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0]!;
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

// ---- HTML ---------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** タグを落とした本文（React の `<!-- -->` も落とす）。空白は 1 つに畳む。 */
export function htmlText(fragment: string): string {
  return decodeEntities(fragment.replace(/<!--.*?-->/gs, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// ---- 「誰の側か」の語 ------------------------------------------------------------------------

/**
 * 面に書かれた「誰の側か」を 1 つの区分にする。区分は /sellers の export.csv の outcome と同じ語
 * （openapi の x-vet402-column-notes に載る定義: delivered | pending | seller | vet402 | unsorted | not_bought | not_tried）。
 * 語が読めないときは null（「一致」にも「不一致」にもしない — 呼び手が「読めなかった」と数える）。
 */
export type Side = "delivered" | "pending" | "seller" | "vet402" | "unsorted" | "not_bought" | "not_tried";

export function sideFromWords(words: string | null | undefined): Side | null {
  if (words == null) return null;
  const w = words.trim().toLowerCase();
  if (w === "" || w === "—" || w === "-") return null;
  if (w.startsWith("no failure")) return "delivered";
  // 照合待ち（settle_claimed）は頁では「not sorted: awaiting on-chain verification」、export.csv では outcome=pending
  if (w.includes("awaiting on-chain")) return "pending";
  if (w.startsWith("vet402's side") || w.startsWith("vet402’s side")) return "vet402";
  if (w.startsWith("seller's side") || w.startsWith("seller’s side")) return "seller";
  if (w.startsWith("not sorted")) return "unsorted";
  if (w.startsWith("not bought")) return "not_bought";
  if (w.startsWith("not tried")) return "not_tried";
  return null;
}

export function sideFromOutcome(outcome: string | null | undefined): Side | null {
  const o = (outcome ?? "").trim();
  return (["delivered", "pending", "seller", "vet402", "unsorted", "not_bought", "not_tried"] as const).find((x) => x === o) ?? null;
}

// ---- 記録頁 /observatory/e/{id} -------------------------------------------------------------

export type RecordRow = {
  /** "YYYY-MM-DD HH:MM"（頁は分までしか出さない） */
  attemptedMinute: string;
  result: string;
  http: number | null;
  txHash: string | null;
  l2: string | null;
  whoseSide: string | null;
};

export type RecordPage = {
  publishedState: string | null;
  rows: RecordRow[];
  /** L1 の表が頁に在るか（「No paid purchases recorded」のときは false） */
  hasL1Table: boolean;
};

export function parseRecordPage(html: string): RecordPage | null {
  const ps = /Published state:\s*(?:<[^>]*>\s*)*(?:<svg[\s\S]*?<\/svg>)?\s*([a-z]+)/i.exec(html);
  const cap = html.indexOf("L1 purchase history, newest first</caption>");
  const noPurchases = html.includes("No paid purchases recorded for this endpoint yet");
  if (!ps && cap < 0 && !noPurchases) return null; // 記録頁の形をしていない
  const rows: RecordRow[] = [];
  if (cap >= 0) {
    const end = html.indexOf("</table>", cap);
    const body = html.slice(cap, end < 0 ? undefined : end);
    const trs = [...body.matchAll(/<tr(\s[^>]*)?>([\s\S]*?)<\/tr>/g)];
    for (let i = 0; i < trs.length; i++) {
      const attrs = trs[i]![1] ?? "";
      if (/fact-subrow/.test(attrs)) continue;
      const tds = [...trs[i]![2]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!);
      if (tds.length < 5) continue; // 見出し行
      const when = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/.exec(htmlText(tds[0]!));
      if (!when) continue;
      const result = htmlText(tds[1]!).replace(/\s*tx from our index$/, "");
      const httpText = htmlText(tds[2]!);
      const tx = /\/tx\/([^"?#]+)"/.exec(tds[3]!)?.[1] ?? /title="([^"]+)"/.exec(tds[3]!)?.[1] ?? null;
      let l2: string | null = null;
      let whoseSide: string | null = null;
      const next = trs[i + 1];
      if (next && /fact-subrow/.test(next[1] ?? "")) {
        const sub = htmlText(next[2]!);
        l2 = /\bL2 ([a-z_—-]+)/.exec(sub)?.[1] ?? null;
        if (l2 === "—") l2 = null;
        whoseSide = /Whose side:\s*(.+)$/.exec(sub)?.[1]?.trim() ?? null;
      }
      rows.push({
        attemptedMinute: when[1]!,
        result,
        http: /^\d{3}$/.test(httpText) ? Number(httpText) : null,
        txHash: tx,
        l2,
        whoseSide,
      });
    }
  }
  return { publishedState: ps?.[1]?.toLowerCase() ?? null, rows, hasL1Table: cap >= 0 };
}

// ---- 売り手頁 /sellers/{host} ----------------------------------------------------------------

export type SellerListing = {
  observatoryId: string;
  latestAttempt: string | null;
  result: string | null;
  whoseSide: string | null;
  lastResultAboutSeller: string | null;
  /** 「Decision API now」のリンクが指す resource_id */
  decisionResourceId: string | null;
  /** 「Recorded …: <code>status</code>」 */
  recordedStatus: string | null;
  /** 「held as <code>…</code>」 */
  heldAs: string | null;
  /** 「the row with attempted_at …」の ISO 時刻 */
  attemptedAtIso: string | null;
};

/** 頁の中の `<li id="listing-<uuid>">` を全部読む。頁の形でなければ null。 */
export function parseSellerHostPage(html: string): { listings: Map<string, SellerListing>; hasNextPage: boolean } | null {
  const starts = [...html.matchAll(/<li[^>]*\sid="listing-([0-9a-f-]{36})"[^>]*>/g)];
  if (starts.length === 0 && !/Your listings/.test(html)) return null;
  const listings = new Map<string, SellerListing>();
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.index!;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : html.indexOf("</ul>", from) > 0 ? html.indexOf("</ul>", from) : html.length;
    const block = html.slice(from, to);
    const dd = (label: string): string | null => {
      const m = new RegExp(`<dt[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`).exec(block);
      return m ? htmlText(m[1]!) : null;
    };
    const strong = (label: string): string | null => {
      const m = new RegExp(`<strong>${label}</strong>([\\s\\S]*?)</span>`).exec(block);
      return m ? htmlText(m[1]!) : null;
    };
    // 最新の行の「Recorded …」の段だけ（同じ塊に前の試行の段も並ぶ）
    const rAt = block.indexOf("Recorded (");
    const rEnd = rAt < 0 ? -1 : block.indexOf("<code>attempted_at</code>", rAt);
    const recorded = rAt < 0 ? "" : block.slice(rAt, rEnd < 0 ? undefined : rEnd);
    listings.set(starts[i]![1]!, {
      observatoryId: starts[i]![1]!,
      latestAttempt: dd("Latest attempt"),
      result: dd("Result"),
      whoseSide: dd("Whose side"),
      lastResultAboutSeller: strong("Last result about the seller:"),
      decisionResourceId: /\/api\/v1\/resources\/([0-9a-f]{64})\/decision/.exec(block)?.[1] ?? null,
      recordedStatus: /^Recorded \([^)]*\)(?:<!-- -->)?:(?:<!-- -->)?\s*<code>([a-z_]+)<\/code>/.exec(recorded)?.[1] ?? null,
      heldAs: /held as <code>([a-z_0-9]+)<\/code>/.exec(recorded)?.[1] ?? null,
      attemptedAtIso: /<code>attempted_at<\/code>\s*(?:<!-- -->)?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(block)?.[1] ?? null,
    });
  }
  const hasNextPage = /[?&]page=\d+"[^>]*>\s*(?:Next|Older|More|→)/i.test(html) || /rel="next"/.test(html);
  return { listings, hasNextPage };
}

// ---- 理由コードの登録簿（docs/api の表・openapi・llms.txt）------------------------------------

export type ReasonTableRow = { code: string; verdict: string; sellerCanFix: string };

/** /docs/api#reason-codes の表。`<tr id="reason-…">` の 1 列目の `<code>` が語、2 列目が判定。 */
export function parseDocsReasonTable(html: string): { rows: ReasonTableRow[]; rulesVersion: string | null } | null {
  const rows: ReasonTableRow[] = [];
  for (const m of html.matchAll(/<tr id="reason-[^"]+">([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]!);
    const code = /<code>([\s\S]*?)<\/code>/.exec(tds[0] ?? "")?.[1];
    if (!code) continue;
    rows.push({ code: htmlText(code), verdict: htmlText(tds[1] ?? ""), sellerCanFix: htmlText(tds[4] ?? "") });
  }
  if (rows.length === 0) return null;
  const rv = /Reason codes \(rules (?:<!-- -->)?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)/.exec(html)?.[1] ?? null;
  return { rows, rulesVersion: rv };
}

export type OpenApiReasonCodes = { enum: string[]; patterns: RegExp[]; patternSources: string[]; since: string | null; yamlKeys: Set<string>; backticked: Set<string> };

/** openapi.yaml の `DecisionReasonCode`（enum・x-vet402-patterns・「Since <版>」）。YAML 全体は解釈しない。 */
export function parseOpenApiReasonCodes(yaml: string): OpenApiReasonCodes | null {
  const at = yaml.indexOf("\n    DecisionReasonCode:");
  if (at < 0) return null;
  const block = yaml.slice(at, at + 6000);
  const en = /\n\s+enum:\s*\[([^\]]*)\]/.exec(block);
  if (!en) return null;
  // 値は JSON の配列（正規表現の中に `]` があるので行末まで取って JSON として読む）
  const pat = /\n\s+x-vet402-patterns:\s*(\[.*\])\s*(?:\n|$)/.exec(block);
  let patternSources: string[] = [];
  if (pat) {
    try {
      const v: unknown = JSON.parse(pat[1]!);
      if (Array.isArray(v)) patternSources = v.filter((x): x is string => typeof x === "string");
    } catch {
      return null;
    }
  }
  const yamlKeys = new Set([...yaml.matchAll(/^\s+([a-z][a-z0-9_]*):/gm)].map((m) => m[1]!));
  const backticked = new Set([...yaml.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!));
  return {
    enum: en[1]!.split(",").map((s) => s.trim()).filter(Boolean),
    patterns: patternSources.map((p) => new RegExp(p)),
    patternSources,
    since: /Since ([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)/.exec(block)?.[1] ?? null,
    yamlKeys,
    backticked,
  };
}

/** llms.txt / llms-full.txt に出る l0_ / l1_ / l2_ の語と「Rules <版>」。 */
export function parseLlmsText(text: string): { tokens: Set<string>; rulesVersions: string[] } {
  const tokens = new Set([...text.matchAll(/\b(l[012]_[a-z0-9_]+)/g)].map((m) => m[1]!.replace(/_+$/, "")));
  const rulesVersions = [...text.matchAll(/\bRules ([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)/g)].map((m) => m[1]!);
  return { tokens, rulesVersions };
}

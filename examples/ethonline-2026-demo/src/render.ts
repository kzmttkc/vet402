/**
 * The picture. **This is what the judges read in the video** (WINDOW_PLAN §6, at 0:45-1:15 /
 * 1:15-1:30 / 1:30-2:05). (English header for judges. The Japanese block below is the same
 * content in our working language.)
 *
 * Three rules:
 *  - **Never fill a value we failed to read with a number.** Write that we failed to read it.
 *  - **Never truncate evidence.** The deployment CID is 46 characters; abbreviate it and the
 *    only self-evident proof that we read live data is gone (WINDOW_PLAN §15).
 *  - **Never carry meaning in colour.** Video compression kills colour.
 */
/**
 * 画。**審査員は動画でこれを読む**（WINDOW_PLAN §6 の 0:45–1:15 / 1:15–1:30 / 1:30–2:05）。
 *
 * 規律は3つ。
 *  - **取れなかった値を数字で埋めない。**「取れなかった」と書く（`—  not read`）
 *  - **証拠を切り詰めない。** `_meta.deployment` の CID は 46 桁あるが、略すと
 *    「live を読んだ」ことの唯一の自明な証明が消える（WINDOW_PLAN §15）
 *  - **色に意味を載せない。** 動画の圧縮で色は死ぬ
 */
import { isDecimalUnits } from "../../../packages/sdk/dist/verdict-shape.js";
import { MAX_WIDTH, LEFT_WIDTH, RIGHT_WIDTH, field, full, rule, twoColumns, wrap } from "./columns.ts";

export { MAX_WIDTH };

export type RenderOptions = { color?: boolean };

const L_LABEL = 16;
const R_LABEL = 21;

const ANSI = { bold: "[1m", dim: "[2m", reset: "[0m" };

function paint(lines: string[], options: RenderOptions | undefined, kind: "bold" | "dim"): string[] {
  if (options?.color !== true) return lines;
  return lines.map((line) => (line.trim() === "" ? line : ANSI[kind] + line + ANSI.reset));
}

/** unix 秒 → ISO（秒まで）。数でないものは触らずに返す——**推測で日付を作らない**。 */
function isoFromUnix(seconds: unknown): string {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

/** Postgres 形式や ISO 形式の日時を、秒までの ISO へ寄せる。読めなければ原文のまま。 */
function isoish(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "null";
  // Postgres の `2026-09-04 17:40:13.970619+00` は Date が読めない。ISO の綴りへ寄せる。
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * 全幅のラベル付き1行。長い値（URL・resource_id）は**折り返す。切り詰めない**——
 * 切り詰めると審査員が自分で引き直せなくなる。続きは字下げして同じ塊だと分かるようにする。
 */
function head(label: string, value: string): string[] {
  const pad = " ".repeat(label.length);
  const lines = wrap(value, MAX_WIDTH - 2 - label.length);
  return lines.map((line, i) => full((i === 0 ? label : pad) + line));
}

export type RefuseView = {
  resource: { method: string; url: string };
  payee: string;
  ranAt: string;
  /** 画の env 行（鍵の有無。値は持たない）。`VOUCH_API_KEY` は任意——false は鍵なし枠で読んだ印。 */
  envReady?: Record<string, boolean>;
  vet402: {
    endpoint: string;
    recommendation: string;
    reasonCodes: string[];
    degraded: boolean;
    l0: { status: string; observed_at: string | null; dialect: string | null };
    l1: { n_delivered: number; n_settled: number; n_attempts: number; n_inconclusive: number; observed_at: string | null };
    scoredAt: string;
  } | null;
  subgraph: {
    endpoint: string;
    block: { number: number; timestamp?: number };
    deployment?: string;
    row: {
      role: string;
      totalPayments: string;
      totalVolumeDecimal: string;
      firstPaymentTimestamp: string;
      lastPaymentTimestamp: string;
    } | null;
  } | null;
  outcome: {
    status: string;
    signed: boolean;
    nonce: string | null;
    txHash: string | null;
    reasonCodes: string[];
    evidence: {
      level: string;
      source: string;
      receipts?: number;
      block?: { number: number };
      deployment?: string;
      url: string;
    }[];
  };
  requests: string[];
};

/**
 * 画の下段の1文（`[A] …` / `[B] …`）。**折り返す。切り詰めない。**
 *
 * 2026-09-08: ここは `full()` を直に呼んでいたため折り返しが効かず、L1 の実数から
 * 導出した長い文（167 桁）が 96 桁の枠を割った。既存の幅テストは `n_attempts: 0` の
 * 短い分岐しか通しておらず、見ていない側で壊れていた。続きは字下げして同じ文だと分かるようにする。
 */
const SENTENCE_CONT = "    ";

function sentence(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  let indent = "";
  while (true) {
    // **字下げの分だけ狭く折る。** 全幅で折ってから字下げを足すと、続きの行が枠を割る
    // （2026-09-08: `l0_unverified` の長い節で 97 桁になった。折り返しは入れたが、
    // 折る幅に字下げを数えていなかった——見ていない分岐で同じ欠陥が残っていた）。
    const width = MAX_WIDTH - 2 - indent.length;
    if (rest.length <= width) {
      out.push(full(indent + rest));
      return out;
    }
    const [line] = wrap(rest, width);
    out.push(full(indent + line));
    // `wrap` は行末の空白を落とすので、落ちた分は残りの先頭で trim される（1文字も失わない）。
    rest = rest.slice(line.length).trimStart();
    indent = SENTENCE_CONT;
  }
}

/**
 * `[A] …` の L0 側の節。**`view.vet402.l0.status` から導出する**（2026-09-08）。
 *
 * 以前は 4 分岐のうち 3 つが `(l0_pass)` の固定文で、動詞 "has SEEN" も pass 専用の観測を
 * 名乗っていた。`/decision` が pass 以外を返すと、すぐ上の `L0 status  fail` /
 * `reason_codes  l0_fail` と同じ画で矛盾する——L1 側を実数化したのと**同じ欠陥が隣に残っていた**。
 *
 * 語は語彙表（`src/lib/observatory/vocabulary.ts` の L0 verdicts）から取る:
 *  - `pass` … 402 が返り、challenge がカタログの宣言と一致した。**支払いの壁があること以上は主張しない**
 *  - `fail` … 探査がカタログの宣言と矛盾した。**連続して落ちたときだけ公開する**（1 回では
 *    死んだ端点と一時的な網の状態——**我々の側のものを含む**——を区別できない）
 *  - `unverified` … pass も fail も公開する根拠がまだ無い。**失敗ではなく、失敗として数えない**
 *
 * どれも**売り手の落ち度と読める書き方をしない**（2026-09-05 決定・WINDOW_PLAN §1.5）。
 * 機械可読な符号は `src/lib/decision/rules.ts` と同じく `l0_${status}` で導く（写さない）。
 */
const L0_PHRASE: Record<string, string> = {
  pass: "has SEEN this seller",
  fail: "has an unpaid probe that contradicts the catalog listing for this seller",
  unverified: "has no published L0 verdict for this seller yet",
};

export function l0Clause(status: string): string {
  const phrase = L0_PHRASE[status];
  if (phrase !== undefined) return `${phrase} (l0_${status})`;
  // 語彙表に無い値。**取れなかった値から符号を作らない**——`refuse.ts` は `/decision` が
  // `l0.status` を返さないとき `"—"` を入れるので、素直に埋めると `(l0_—)` という
  // `rules.ts` にも語彙表にも無い符号を画に出してしまう（`—  not read` と同じ規律）。
  const looksLikeCode = /^[a-z][a-z_]*$/.test(status);
  return looksLikeCode
    ? `reports L0 status ${status} for this seller (l0_${status})`
    : "has no L0 status to show for this seller (L0 status —  not read)";
}

/**
 * 画の下段 `[A] …` の1文。**L1 の実数から導出する**（2026-09-08）。
 *
 * 以前は固定文で「NEVER bought (L1 delivered 0)」と出していたため、すぐ上の
 * `L1 delivered 0  (settled 1, tried 1)` と同じ画で矛盾していた。審査員は動画と
 * ライブ審査でこの2行を並べて読む。
 *
 * `conclusive = n_attempts − n_inconclusive`（`src/lib/decision/types.ts` の定義）。
 * 決済は起きたが結論の出た応答が 0 のとき（`l1_inconclusive`）は「買っていない」でも
 * 「試していない」でもない——**我々の側の要求の形**で 2xx が返らなかった、とだけ言う。
 * 売り手の落ち度と読める書き方をしない（2026-09-05 決定・WINDOW_PLAN §1.5）。
 *
 * L0 側の節は `l0Clause()` が同じ規律で作る（固定文にしない）。
 */
export function vet402Sentence(view: RefuseView): string {
  const v = view.vet402;
  if (!v) return "[A] vet402 /decision was not read — no L1 claim is made here.";
  const { n_delivered, n_settled, n_attempts, n_inconclusive } = v.l1;
  // `n_inconclusive` が無い JSON（古い `/decision`）では conclusive を作らない。
  // `settled − delivered` で導出すると、数えていない量を数えたことにしてしまう。
  const conclusive = Number.isFinite(n_inconclusive) ? n_attempts - n_inconclusive : null;
  const l0 = l0Clause(v.l0.status);
  if (n_delivered >= 1) {
    return `[A] ${l0} and has been delivered to ${n_delivered} time(s).`;
  }
  if (n_attempts === 0) {
    return `[A] ${l0} and has never signed a paid attempt (L1 attempts 0).`;
  }
  if (conclusive === null) {
    return (
      `[A] ${l0}; it paid ${n_settled} time(s) with no delivery ` +
      `on record (L1 delivered 0 of ${n_attempts} attempt(s)).`
    );
  }
  if (conclusive <= 0) {
    return (
      `[A] ${l0}; it paid ${n_settled} time(s) and every paid response ` +
      "came back non-2xx from our own request shape — no delivery on record (L1 delivered 0)."
    );
  }
  return `[A] ${l0} and has never been delivered to (L1 delivered 0 of ${conclusive}).`;
}

function vet402Column(view: RefuseView): string[] {
  const v = view.vet402;
  if (!v) return ["—  /decision not read"];
  const [first, ...rest] = v.reasonCodes.length > 0 ? v.reasonCodes : ["(none)"];
  return [
    ...field("recommendation", v.recommendation, L_LABEL, LEFT_WIDTH),
    ...field("reason_codes", first, L_LABEL, LEFT_WIDTH),
    ...rest.map((code) => " ".repeat(L_LABEL) + code),
    ...field("degraded", String(v.degraded), L_LABEL, LEFT_WIDTH),
    ...field("L0 status", `${v.l0.status}  (dialect ${v.l0.dialect ?? "null"})`, L_LABEL, LEFT_WIDTH),
    ...field("L0 observed", isoish(v.l0.observed_at), L_LABEL, LEFT_WIDTH),
    ...field("L1 delivered", `${v.l1.n_delivered}  (settled ${v.l1.n_settled}, tried ${v.l1.n_attempts})`, L_LABEL, LEFT_WIDTH),
    ...field("L1 observed", isoish(v.l1.observed_at), L_LABEL, LEFT_WIDTH),
    ...field("scoredAt", isoish(v.scoredAt), L_LABEL, LEFT_WIDTH),
  ];
}

function subgraphColumn(view: RefuseView): string[] {
  const s = view.subgraph;
  if (!s) return ["—  subgraph not read"];
  const row = s.row;
  return [
    ...field("_meta.block.number", String(s.block.number), R_LABEL, RIGHT_WIDTH),
    ...field("_meta.block.time", isoFromUnix(s.block.timestamp), R_LABEL, RIGHT_WIDTH),
    ...field("_meta.deployment", s.deployment ?? "—  not returned", R_LABEL, RIGHT_WIDTH),
    ...(row
      ? [
          ...field("role", row.role, R_LABEL, RIGHT_WIDTH),
          ...field("totalPayments", row.totalPayments, R_LABEL, RIGHT_WIDTH),
          ...field("totalVolume", `${row.totalVolumeDecimal} USDC`, R_LABEL, RIGHT_WIDTH),
          ...field("firstPayment", isoFromUnix(row.firstPaymentTimestamp), R_LABEL, RIGHT_WIDTH),
          ...field("lastPayment", isoFromUnix(row.lastPaymentTimestamp), R_LABEL, RIGHT_WIDTH),
        ]
      : [" ".repeat(0) + "no RECIPIENT row  (read, zero receipts)"]),
  ];
}

/**
 * 画の `env` 行。**鍵なしは「欠けている」ではなく「鍵なし枠で読んだ」**（2026-09-07・本番 `/decision`
 * は Authorization 無しでも IP ごと 10/分で答える）。だから `VOUCH_API_KEY` だけは MISSING と言わず、
 * 枠の名前を出す——審査員が「鍵が無いから落ちたのか」と読まないように。他の鍵の MISSING は従来どおり。
 */
export const KEYLESS_LABEL = "unset (keyless: 10/min per IP)";

export function envLines(envReady: Record<string, boolean>): string[] {
  const env = Object.entries(envReady)
    .map(([name, ready]) => `${name}=${ready ? "set" : name === "VOUCH_API_KEY" ? KEYLESS_LABEL : "MISSING"}`)
    .join("  ");
  return wrap(`env       ${env}`, MAX_WIDTH - 2);
}

export function renderRefuse(view: RefuseView, options?: RenderOptions): string[] {
  const out: string[] = [];
  out.push(rule());
  out.push(
    ...paint([full(`vet402 · payOrRefuse — REFUSE   ETHOnline 2026 demo   ${view.ranAt}`)], options, "bold"),
  );
  out.push(...head("resource  ", `${view.resource.method} ${view.resource.url}`));
  out.push(...head("payee     ", view.payee));
  out.push(rule());
  out.push(
    ...twoColumns(
      ["[A] vet402  GET /decision?role=payer"],
      ["[B] The Graph  x402 Base subgraph (live)"],
    ),
  );
  out.push(...twoColumns(["-".repeat(LEFT_WIDTH)], ["-".repeat(RIGHT_WIDTH)]));
  out.push(...twoColumns(vet402Column(view), subgraphColumn(view)));
  out.push(rule("-"));
  const receipts = view.subgraph?.row?.totalPayments ?? "—";
  const block = view.subgraph ? String(view.subgraph.block.number) : "—";
  out.push(...sentence(vet402Sentence(view)));
  out.push(...sentence(`[B] knows the same address received ${receipts} payments, as of block ${block}.`));
  out.push(full(`Two independent sources. Neither is guessing. They know different things.`));
  out.push(rule("-"));
  const o = view.outcome;
  out.push(
    ...paint(
      [full(`result    ${o.status}    signed  ${o.signed}    nonce  ${o.nonce ?? "null"}    tx  ${o.txHash ?? "null"}`)],
      options,
      "bold",
    ),
  );
  out.push(...head("reasons   ", o.reasonCodes.join(", ")));
  o.evidence.forEach((row, i) => {
    const parts = [
      row.level,
      `source=${row.source}`,
      ...(typeof row.receipts === "number" ? [`receipts=${row.receipts}`] : []),
      ...(row.block ? [`block=${row.block.number}`] : []),
      ...(row.deployment ? [`deployment=${row.deployment}`] : []),
    ];
    out.push(...head(`evidence[${i}]  `, parts.join("  ")));
  });
  out.push(full(`requests  ${view.requests.length}  —  0 signatures, 0 RPC, 0 settle`));
  for (const request of view.requests) out.push(...head("          ", request));
  if (view.envReady) for (const line of envLines(view.envReady)) out.push(full(line));
  out.push(rule());
  return out;
}

export type PayView = {
  /** `pay` は The Graph 固定・`--live` を持つ。`judge` は審査員の URL・署名の経路が無い。 */
  mode?: "pay" | "judge";
  live: boolean;
  /**
   * **今日 `--live` を打つと、どの規則で通るのか。**（WINDOW_PLAN §3.2）
   * `requireVet402Allow: false` は vet402 の判定を外すという宣言なので、
   * **外したことと、代わりに置いた床を、画に出さなければならない**。
   * 出さなければ「黙って弱くなった」のと区別が付かない。
   */
  policy?: {
    requireVet402Allow: boolean;
    floors: { floor: string; source: string; required: number }[];
  };
  /** 402 が提示した accept の数。**選んだ1件が全部でないこと**を画に残す。 */
  acceptsOffered?: number;
  target: { method: string; url: string };
  /** `judge` は期待する受取人を持たない（402 の `payTo` をそのまま読む）ので null。 */
  expectedPayTo: string | null;
  /** 上限（USD）。`pay` は固定の $0.01、`judge` は SDK 既定か `--ceiling-usd`。 */
  amountUsd: number;
  ranAt: string;
  accept: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  } | null;
  x402Version: 1 | 2;
  authorizationWindowSeconds: number;
  payeeScore: { recommendation: string; score: number | null; degraded: boolean } | null;
  decisionStatus: number | null;
  subgraph: {
    endpoint: string;
    block: { number: number; timestamp?: number };
    deployment?: string;
    row: { role: string; totalPayments: string; totalVolumeDecimal: string } | null;
  } | null;
  /**
   * `waived` は「見たうえで、policy が要求していないので通す」。**`pass` と混ぜない**——
   * 満たしたのではなく免除したのだから、同じ印にすると弱くしたことが画から消える。
   */
  gates: { name: string; verdict: "pass" | "fail" | "unknown" | "waived"; detail: string }[];
  envReady: Record<string, boolean>;
  /**
   * `judge` の**署名なしの判定**。SDK と同じ規則で読んだものだけから出す。
   * `pay` は持たない（`pay` の拘束力ある判定は `--live` の `payOrRefuse` が出す）。
   */
  verdict?: {
    verdict: "ALLOW" | "REFUSE";
    reasonCodes: string[];
    verdictSource: string;
    override: {
      rule: string;
      waived: { source: string; recommendation: string; score: number | null };
      floors_met: { floor: string; source: string; required: number; observed: number }[];
    } | null;
  };
};

function acceptColumn(view: PayView): string[] {
  const a = view.accept;
  // **払えない accept を「署名するもの」として映さない。** 402 が読めたかどうかと、
  // 払える形が提示されたかどうかは、別のこと。
  if (!a) {
    return view.acceptsOffered
      ? [`—  no acceptable accept  (${view.acceptsOffered} offered)`]
      : ["—  402 challenge not read"];
  }
  const extra = a.extra ?? {};
  return [
    ...field("scheme", a.scheme, L_LABEL, LEFT_WIDTH),
    ...field("network", a.network, L_LABEL, LEFT_WIDTH),
    // **正規化した数を、生の値であるかのように並べない。** `Number("1e4")` は 10000 だが、
    // 402 が言ったのは `"1e4"` であり、署名に載るのもその文字列。読めない綴りに $ を付けると、
    // 売り手が一度も言っていない額を我々が名乗ることになる（2026-09-08 の反証検査）。
    ...field(
      "amount",
      isDecimalUnits(a.amount)
        ? `${a.amount} units = $${(Number(a.amount) / 1e6).toFixed(2)}`
        : `${JSON.stringify(a.amount) ?? String(a.amount)} — not a decimal unit string`,
      L_LABEL,
      LEFT_WIDTH,
    ),
    ...field("asset", a.asset, L_LABEL, LEFT_WIDTH),
    ...field("payTo", a.payTo, L_LABEL, LEFT_WIDTH),
    ...field("maxTimeout", `${a.maxTimeoutSeconds ?? "—"} s (seller asked)`, L_LABEL, LEFT_WIDTH),
    // `extra` は1行の JSON にすると 16 進の途中で折れて読めなくなる。**鍵ごとに1行**。
    // 鍵の名前は略さない（`assetTransferMethod` を `assetTran` にしたら別の語になる）。
    ...Object.entries(extra).flatMap(([key, value], i) =>
      field(i === 0 ? "extra" : "", `${key}=${String(value)}`, L_LABEL, LEFT_WIDTH),
    ),
  ];
}

function evidenceColumn(view: PayView): string[] {
  const lines: string[] = [];
  lines.push(...field("/decision", view.decisionStatus === null ? "—  not read" : `HTTP ${view.decisionStatus}${view.decisionStatus === 404 ? "  (uncatalogued)" : ""}`, R_LABEL, RIGHT_WIDTH));
  lines.push(
    ...field(
      "payee verdict",
      view.payeeScore ? `${view.payeeScore.recommendation}${view.payeeScore.score === null ? "" : ` (${view.payeeScore.score})`}` : "—  not read",
      R_LABEL,
      RIGHT_WIDTH,
    ),
  );
  if (view.subgraph) {
    lines.push(...field("_meta.block.number", String(view.subgraph.block.number), R_LABEL, RIGHT_WIDTH));
    lines.push(...field("_meta.deployment", view.subgraph.deployment ?? "—  not returned", R_LABEL, RIGHT_WIDTH));
    lines.push(
      ...field(
        "totalPayments",
        view.subgraph.row ? view.subgraph.row.totalPayments : "0  (read, no RECIPIENT row)",
        R_LABEL,
        RIGHT_WIDTH,
      ),
    );
  } else {
    lines.push(...field("subgraph", "—  not read", R_LABEL, RIGHT_WIDTH));
  }
  return lines;
}

export function renderPayDryRun(view: PayView, options?: RenderOptions): string[] {
  const out: string[] = [];
  out.push(rule());
  out.push(
    ...paint(
      [
        full(
          view.mode === "judge"
            ? `vet402 · payOrRefuse — JUDGE  DRY RUN (no signing path)   ${view.ranAt}`
            : `vet402 · payOrRefuse — PAY  ${view.live ? "LIVE" : "DRY RUN (default)"}   ${view.ranAt}`,
        ),
      ],
      options,
      "bold",
    ),
  );
  out.push(...head("target    ", `${view.target.method} ${view.target.url}`));
  out.push(
    ...head(
      "expect    ",
      `payTo ${view.expectedPayTo ?? "(taken from the 402 — no expectation given)"}   ceiling $${view.amountUsd.toFixed(2)}`,
    ),
  );
  out.push(rule());
  out.push(
    ...twoColumns(
      [`what would be signed (chosen from ${view.acceptsOffered ?? 1} accept${(view.acceptsOffered ?? 1) === 1 ? "" : "s"})`],
      ["what the two sources say"],
    ),
  );
  out.push(...twoColumns(["-".repeat(LEFT_WIDTH)], ["-".repeat(RIGHT_WIDTH)]));
  out.push(...twoColumns(acceptColumn(view), evidenceColumn(view)));
  out.push(rule("-"));
  out.push(
    full(
      `EIP-3009 window   validBefore = now + ${view.authorizationWindowSeconds}s (SDK cap), validAfter = now - 60s`,
    ),
  );
  out.push(full(`nonce             32 random bytes, generated at signing time (not now)`));
  out.push(full(`transport         x402 v${view.x402Version} — header PAYMENT-SIGNATURE, resent to the seller`));
  out.push(rule("-"));
  for (const gate of view.gates) {
    const mark =
      gate.verdict === "pass" ? "[ok  ]"
      : gate.verdict === "fail" ? "[FAIL]"
      : gate.verdict === "waived" ? "[waiv]"
      : "[  ? ]";
    out.push(...head(`${mark} ${gate.name.padEnd(32)} `, gate.detail));
  }
  for (const line of envLines(view.envReady)) out.push(full(line));
  out.push(rule("-"));
  const ruleLine =
    view.policy === undefined ? ""
    : view.policy.requireVet402Allow
      ? " Rule: vet402 must say ALLOW (requireVet402Allow=true)."
      : ` Rule: requireVet402Allow=false — vet402's verdict is waived and recorded, not required;` +
        ` what judges instead is ${view.policy.floors
          .map((f) => `${f.floor} >= ${f.required} (${f.source})`)
          .join(" and ")}.`;
  if (view.mode === "judge" && view.verdict) {
    // **署名なしの判定。** 予告ではなく、SDK と同じ規則で読んだものだけから出した結論。
    const v = view.verdict;
    out.push(...paint([full(`verdict       ${v.verdict}`)], options, "bold"));
    out.push(...head("reason_codes  ", v.reasonCodes.join(", ") || "(none)"));
    out.push(full(`verdict from  ${v.verdictSource}`));
    if (v.override) {
      out.push(
        ...head(
          "allowed by    ",
          `${v.override.rule} — waived ${v.override.waived.source} ${v.override.waived.recommendation}` +
            `${v.override.waived.score === null ? "" : ` (${v.override.waived.score})`}`,
        ),
      );
      for (const f of v.override.floors_met) {
        out.push(full(`floor met     ${f.floor} (${f.source}) ${f.required} <= ${f.observed}`));
      }
    }
    out.push(...paint([full("signed        false (dry-run)")], options, "bold"));
    for (const line of wrap(`rule     ${ruleLine.trim()}`, MAX_WIDTH - 2)) out.push(full(line));
    out.push(rule("-"));
    out.push(
      ...paint(
        [full("DRY RUN — judge has no signing path. No signature was created; no signing module loaded.")],
        options,
        "bold",
      ),
    );
    out.push(rule());
    return out;
  }
  // 予告。**拘束力を持つ関門は payOrRefuse の中**にあるが、読めた事実だけで
  // 「今日 `--live` を打つと何が起きるか」は言える。言わないと撮影当日に初めて分かる。
  // `waived` は落ちていない。**免除は、満たしたことでも失敗したことでもない**。
  const failing = view.gates.filter((g) => g.verdict === "fail" || g.verdict === "unknown");
  out.push(
    ...head(
      "predicted ",
      failing.length === 0
        ? `--live would sign and send $0.01. Every gate readable from here is green.${ruleLine}`
        : `--live would REFUSE before signing. Failing gate: ${failing
            .map((g) => `"${g.name}" → ${g.detail}`)
            .join("; ")}.${ruleLine}`,
    ),
  );
  out.push(rule("-"));
  if (view.live) {
    out.push(...paint([full("LIVE — payOrRefuse ran the binding gate and may have signed. See result above.")], options, "bold"));
  } else {
    out.push(
      ...paint(
        [full("DRY RUN — no signature was created. The signing module was never loaded.")],
        options,
        "bold",
      ),
    );
    out.push(full("Re-run with --live to sign and send $0.01. That step is a human decision."));
  }
  out.push(rule());
  return out;
}

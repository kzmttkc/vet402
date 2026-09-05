/**
 * 画。**審査員は動画でこれを読む**（WINDOW_PLAN §6 の 0:45–1:15 / 1:15–1:30 / 1:30–2:05）。
 *
 * 規律は3つ。
 *  - **取れなかった値を数字で埋めない。**「取れなかった」と書く（`—  not read`）
 *  - **証拠を切り詰めない。** `_meta.deployment` の CID は 46 桁あるが、略すと
 *    「live を読んだ」ことの唯一の自明な証明が消える（WINDOW_PLAN §15）
 *  - **色に意味を載せない。** 動画の圧縮で色は死ぬ
 */
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
  vet402: {
    endpoint: string;
    recommendation: string;
    reasonCodes: string[];
    degraded: boolean;
    l0: { status: string; observed_at: string | null; dialect: string | null };
    l1: { n_delivered: number; n_settled: number; n_attempts: number; observed_at: string | null };
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
  out.push(full(`[A] has SEEN this seller (l0_pass) and has NEVER bought from it (L1 delivered 0).`));
  out.push(full(`[B] knows the same address received ${receipts} payments, as of block ${block}.`));
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
  out.push(rule());
  return out;
}

export type PayView = {
  live: boolean;
  target: { method: string; url: string };
  expectedPayTo: string;
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
  gates: { name: string; verdict: "pass" | "fail" | "unknown"; detail: string }[];
  envReady: Record<string, boolean>;
};

function acceptColumn(view: PayView): string[] {
  const a = view.accept;
  if (!a) return ["—  402 challenge not read"];
  const extra = a.extra ?? {};
  return [
    ...field("scheme", a.scheme, L_LABEL, LEFT_WIDTH),
    ...field("network", a.network, L_LABEL, LEFT_WIDTH),
    ...field("amount", `${a.amount} units = $${(Number(a.amount) / 1e6).toFixed(2)}`, L_LABEL, LEFT_WIDTH),
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
      [full(`vet402 · payOrRefuse — PAY  ${view.live ? "LIVE" : "DRY RUN (default)"}   ${view.ranAt}`)],
      options,
      "bold",
    ),
  );
  out.push(...head("target    ", `${view.target.method} ${view.target.url}`));
  out.push(...head("expect    ", `payTo ${view.expectedPayTo}   ceiling $${view.amountUsd.toFixed(2)}`));
  out.push(rule());
  out.push(...twoColumns(["what would be signed (402 accepts[0])"], ["what the two sources say"]));
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
    const mark = gate.verdict === "pass" ? "[ok  ]" : gate.verdict === "fail" ? "[FAIL]" : "[  ? ]";
    out.push(...head(`${mark} ${gate.name.padEnd(32)} `, gate.detail));
  }
  const env = Object.entries(view.envReady)
    .map(([name, ready]) => `${name}=${ready ? "set" : "MISSING"}`)
    .join("  ");
  for (const line of wrap(`env       ${env}`, MAX_WIDTH - 2)) out.push(full(line));
  out.push(rule("-"));
  // 予告。**拘束力を持つ関門は payOrRefuse の中**にあるが、読めた事実だけで
  // 「今日 `--live` を打つと何が起きるか」は言える。言わないと撮影当日に初めて分かる。
  const failing = view.gates.filter((g) => g.verdict !== "pass");
  out.push(
    ...head(
      "predicted ",
      failing.length === 0
        ? "--live would sign and send $0.01. Every gate readable from here is green."
        : `--live would REFUSE before signing. Failing gate: ${failing
            .map((g) => `"${g.name}" → ${g.detail}`)
            .join("; ")}`,
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

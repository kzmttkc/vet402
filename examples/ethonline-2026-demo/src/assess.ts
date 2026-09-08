/**
 * **読んで、並べる。判定はしない。** `pay`（The Graph 固定）と `judge`（審査員の URL）が
 * 共有する読み取りと関門表。2つのコマンドが別々の関門を持つと、画に出した規則と
 * 本当に効いた規則が別物になり得る——だから1本にする。
 *
 * ここにあるのは
 *   - 402 → `/decision`（404 可）→ 受取人スコア → The Graph subgraph の**読み取り**
 *   - 読み取り値どうしの突き合わせ（関門表）。**予告であって、拘束力は SDK の中**にある
 * 閾値（チェーン・資産・上限）は SDK の定数を引く。ここに 16 進や金額を書かない。
 */
import { readSubgraphReceipts, X402_BASE_SUBGRAPH_ID } from "../../../packages/sdk/dist/index.js";
// 判定語と「測れたか」の欄の読み方。**2つの金の経路（`pay-or-refuse.ts` / `spend-guard.ts`）が
// 共有している 1 本**をそのまま引く（2026-09-08 `bfc16bb`）。ここに写しを置くと、同じ問いに
// 規則が2つある状態に戻る——2026-09-08 に `degraded: false` かつ `signalsUnavailable` 非空で
// 「署名する」と予告して金の経路が拒否した欠陥は、それが原因だった。
// `dist/index.js`（公開面）には無いので、金の経路が読むのと同じ実装ファイルを直接引く。
// SDK の公開 API を会期中に広げないための選択でもある（`judge.ts` 冒頭「`packages/**` を触らない」）。
import { decisionResponseDefect, isBlockVerdict, isDecimalUnits, scoreQualityDefect } from "../../../packages/sdk/dist/verdict-shape.js";
import type { PayView } from "./render.ts";
import {
  VET402_API,
  computeResourceId,
  hasCanonicalUsdcDomain,
  isProtocolEligible,
  readJson,
  selectPayableAccept,
  type ChallengeProbe,
  type Instrumented,
} from "./probe.ts";

export type EvidenceSource = "vet402" | "subgraph" | "both";

/** SDK の `PayPolicy` のうち、空撃ちの画に関わる部分。 */
export type AssessPolicy = {
  requireVet402Allow: boolean;
  /** `deploymentId` は SDK と同じ「pin」——渡したときだけ `_meta.deployment` を照合する（既定は照合しない）。 */
  evidence: { source: EvidenceSource; minL1Deliveries?: number; minSubgraphReceipts?: number; deploymentId?: string };
};

export type AssessTarget = {
  method: string;
  url: string;
  body?: string;
  /** 期待する受取人。`judge` は持たない（402 の `payTo` をそのまま読む）。 */
  expectedPayee: string | null;
  ceilingUsd: number;
};

export type DecisionBody = {
  recommendation?: unknown;
  reason_codes?: unknown;
  degraded?: unknown;
  facts?: { l1?: { n_delivered?: unknown } };
};

export type ScoreBody = {
  recommendation?: unknown;
  score?: unknown;
  degraded?: unknown;
  signalsUnavailable?: unknown;
};

export type SubgraphRead = Awaited<ReturnType<typeof readSubgraphReceipts>>;

/** 読んだものそのまま。**取れなかったものは null**（数字で埋めない）。 */
export type Reads = {
  probe: ChallengeProbe;
  /** 払える accept（SDK が選ぶのと同じ1件）。1件も無ければ null。 */
  accept: Record<string, unknown> | null;
  /** 受取人。`expectedPayee` があればそれ、無ければ 402 の `payTo`。 */
  payee: string | null;
  /** `status: null` は vet402 へ届かなかった（fetch が投げた）。 */
  decision: { status: number | null; body: unknown };
  /** `/decision` が 404 `not_found`（WINDOW_PLAN §3.1 のカタログ外）。 */
  uncatalogued: boolean;
  score: { status: number | null; body: ScoreBody | null };
  /** policy が subgraph を求めていなければ null（読んでいない）。 */
  subgraph: SubgraphRead | null;
};

export type AssessOptions = {
  target: AssessTarget;
  policy: AssessPolicy;
  env: Record<string, string | undefined>;
  net: Instrumented;
  /** 402 は呼び手が先に取る（`judge` はここで「x402 の口ではない」と止まるため）。 */
  probe: ChallengeProbe;
  /** 画の env 行に出す名前。コマンドごとに要る鍵が違う（`judge` は署名鍵を知らない）。 */
  envNames: readonly string[];
  mode: PayView["mode"];
  live: boolean;
};

type Gate = PayView["gates"][number];

function gate(name: string, verdict: Gate["verdict"], detail: string): Gate {
  return { name, verdict, detail };
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * 「測れなかった」を画の語にする。**どれが欠陥かは決めない**——決めるのは SDK の
 * `scoreQualityDefect` で、ここは決まった欠陥に語を与えるだけ（規則の写しを増やさない）。
 *
 * `degraded` の語は 2026-09-05 の変異 D5 が固定したもので、**1文字も変えない**。
 * `partial` は**どの入力が読めなかったか**を名前で出す——審査員がライブ審査でこの行を読み、
 * 「判定が悪い」ではなく「入力が1つ読めなくて止まった」と見分けられるようにするため
 * （`docs/ethonline-2026/LIVE_JUDGING.md`「拒否が出たとき」）。
 */
function defectNote(defect: "degraded" | "unreadable" | "partial", signals: unknown): string {
  if (defect === "degraded") return " — degraded: not measured, never waived";
  if (defect === "unreadable") return " — signalsUnavailable is not a list; not measured, never waived";
  const names = Array.isArray(signals) ? signals.map((s) => String(s)).join(", ") : "";
  return ` — unread inputs: ${names}; not measured, never waived`;
}

export function l1Delivered(decision: DecisionBody | null): number {
  const n = decision?.facts?.l1?.n_delivered;
  return typeof n === "number" ? n : 0;
}

export async function assess(options: AssessOptions): Promise<{ view: PayView; reads: Reads }> {
  const { target, policy, env, net, probe } = options;
  const apiKey = env.VOUCH_API_KEY;
  const graphApiKey = env.GRAPH_API_KEY;

  // --- 読むだけ。ここで判定はしない ---
  const challenge = probe.challenge;
  const accept = challenge ? selectPayableAccept(challenge.accepts) : null;
  // 受取人。期待値が無ければ 402 の `payTo`——払える accept が無くても**提示された先頭**の
  // `payTo` を使う（SDK `selectAccept` が eligible 無しのとき先頭を返すのと同じ軸）。
  // これで SDK と同じく、払えない 402 でも subgraph と受取人スコアは読まれ、決定行に残る。
  const offeredPayTo = (accept ?? challenge?.accepts[0])?.payTo;
  const payee = target.expectedPayee ?? (typeof offeredPayTo === "string" ? offeredPayTo : null);

  const resourceId = await computeResourceId(target.method, target.url);
  let decision: Reads["decision"];
  try {
    decision = await readJson(net.fetch, `${VET402_API}/resources/${resourceId}/decision?role=payer`, apiKey);
  } catch {
    decision = { status: null, body: null };
  }
  // 「カタログ外」と「読めなかった」の見分けも、写さず SDK の 1 本に訊く。ここに status の
  // 範囲を書いていたので、HTTP 429 / 500 / 壊れた JSON が 404 と同じ「受取人スコアで代替」へ
  // 畳まれ、関門7行が全部緑のまま `would sign and send` と予告していた（2026-09-08 の反証検査で
  // 10 マス実測。同じ入力で金の経路は `evidence_unavailable` で拒む）。
  const decisionDefect = decisionResponseDefect(decision);
  const uncatalogued = decisionDefect === "uncatalogued";
  const decisionUnreadable = decisionDefect === "unreadable";
  const decisionBody = decisionDefect === null ? (decision.body as DecisionBody) : null;

  // 受取人スコアは 402 の payTo で引く（SDK の I23 と同じ軸）。
  const scoreFor = typeof offeredPayTo === "string" ? offeredPayTo : target.expectedPayee;
  let score: Reads["score"] = { status: null, body: null };
  if (scoreFor !== null) {
    try {
      const read = await readJson(net.fetch, `${VET402_API}/payees/${scoreFor}/score`, apiKey);
      score = { status: read.status, body: read.status === 200 ? (read.body as ScoreBody) : null };
    } catch {
      score = { status: null, body: null };
    }
  }

  const wantsSubgraph = policy.evidence.source !== "vet402";
  let subgraph: SubgraphRead | null = null;
  if (wantsSubgraph && payee !== null) {
    // **読めなかったことは所見であって、事故ではない。** `readSubgraphReceipts` は 0x でない
    // アドレスを呼び出し側の誤りとして throw するが、`judge` に渡る `payTo` は審査員が選んだ
    // 売り手の申告であって我々の入力ではない。2026-09-08 まで、`payTo` が ENS 名の 402 を
    // `judge` に渡すと審査員の画面に生スタックが出ていた。読めなかったなら、そう画に書く。
    try {
      subgraph = await readSubgraphReceipts({
        address: payee,
        fetch: net.fetch,
        apiKey: graphApiKey,
        subgraphId: X402_BASE_SUBGRAPH_ID,
        // pin。渡されたときだけ SDK 側が照合し、違えば `ok: false` で返る（判定の規則は変えていない）。
        ...(policy.evidence.deploymentId === undefined ? {} : { deploymentId: policy.evidence.deploymentId }),
      });
    } catch (error) {
      subgraph = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const rawSummary = (net.subgraphRaw as { data?: { x402AddressSummaries?: unknown[] } } | undefined)?.data
    ?.x402AddressSummaries?.[0] as { role: string; totalPayments: string; totalVolumeDecimal: string } | undefined;

  const scoreBody = score.body;
  const floors: NonNullable<PayView["policy"]>["floors"] = [];
  if (policy.evidence.minL1Deliveries !== undefined) {
    floors.push({ floor: "minL1Deliveries", source: "vet402", required: policy.evidence.minL1Deliveries });
  }
  if (policy.evidence.minSubgraphReceipts !== undefined) {
    floors.push({ floor: "minSubgraphReceipts", source: "subgraph", required: policy.evidence.minSubgraphReceipts });
  }

  const view: PayView = {
    mode: options.mode,
    live: options.live,
    policy: { requireVet402Allow: policy.requireVet402Allow, floors },
    acceptsOffered: challenge?.accepts.length ?? 0,
    target: { method: target.method, url: target.url },
    expectedPayTo: target.expectedPayee,
    amountUsd: target.ceilingUsd,
    ranAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    accept: accept as PayView["accept"],
    x402Version: challenge?.x402Version ?? 2,
    authorizationWindowSeconds: SDK_AUTHORIZATION_WINDOW_SECONDS,
    payeeScore: scoreBody
      ? {
          recommendation: String(scoreBody.recommendation ?? "—"),
          score: typeof scoreBody.score === "number" ? scoreBody.score : null,
          degraded: scoreBody.degraded === true,
        }
      : null,
    decisionStatus: decision.status,
    subgraph: subgraph?.ok
      ? {
          endpoint: subgraph.publicUrl,
          block: subgraph.block,
          deployment: subgraph.deployment,
          row: rawSummary ?? null,
        }
      : null,
    gates: [],
    envReady: Object.fromEntries(
      options.envNames.map((name) => [name, typeof env[name] === "string" && env[name] !== ""]),
    ),
  };

  // --- 読み取り値どうしの突き合わせ。**拘束力を持つ関門は SDK の中**にあり、ここはその予告 ---
  // **署名に載るのは 402 の生文字列。** `Number()` は "0x10" / "1e4" / "9999.5" / " 10000 " を
  // 上限内の数に読むので、そのまま印字すると 402 が一度も言っていない額が画に出る
  // （2026-09-08 の反証検査: `amount: "1e4"` の 402 に対し関門行が `10000 units = $0.01`）。
  // 受理する形は SDK の `isDecimalUnits` 1 本で決める（金の経路と同じ述語）。
  const rawAmount = accept?.amount;
  const readableAmount = accept !== null && isDecimalUnits(rawAmount);
  const units = readableAmount ? Number(rawAmount) : Number.NaN;
  const gates: Gate[] = [
    gate(
      "payTo == expected",
      accept
        ? target.expectedPayee === null
          ? "waived"
          : sameAddress(accept.payTo, target.expectedPayee)
            ? "pass"
            : "fail"
        : "unknown",
      accept
        ? `${String(accept.payTo)}${target.expectedPayee === null ? " — no expected payee given; taken from the 402" : ""}`
        : "402 not read",
    ),
    gate(
      "chain + asset are Base USDC",
      accept ? (isProtocolEligible(accept) ? "pass" : "fail") : "unknown",
      accept ? `${String(accept.network)} ${String(accept.scheme)}` : "402 not read",
    ),
    gate(
      "amount <= ceiling",
      accept === null ? "unknown"
      : !readableAmount ? "fail"
      : units > 0 && units / 1e6 <= target.ceilingUsd ? "pass"
      : "fail",
      accept === null ? "402 not read"
      : !readableAmount
        ? `${JSON.stringify(rawAmount) ?? String(rawAmount)} — not a decimal unit string; that raw value is what would be signed`
      : units <= 0
        ? `${units} units — a 402 that asks for nothing is not a purchase`
        : `${units} units = $${(units / 1e6).toFixed(2)}`,
    ),
    gate(
      "EIP-712 domain is pinned USDC",
      accept ? (hasCanonicalUsdcDomain(accept) ? "pass" : "fail") : "unknown",
      accept
        ? JSON.stringify({
            name: (accept.extra as { name?: unknown } | undefined)?.name,
            version: (accept.extra as { version?: unknown } | undefined)?.version,
          })
        : "402 not read",
    ),
  ];
  if (wantsSubgraph) {
    gates.push(
      gate(
        "subgraph evidence is live",
        subgraph ? (subgraph.ok ? "pass" : "fail") : "unknown",
        subgraph
          ? subgraph.ok
            ? `block ${subgraph.block.number}, ${subgraph.receipts} receipts`
            : `not read (${subgraph.error})`
          : "payee unknown, not read",
      ),
    );
  }
  // vet402 の判定。カタログ内なら `/decision`、外なら受取人スコア（SDK と同じ軸）。
  // **免除した判定も関門として残す。** 消すと「見なかったこと」になる。`waived` は「見たうえで通す」の印。
  // BLOCK と「測れなかった」は policy に関係なく落ちる（WINDOW_PLAN §3.2.1）。
  // **落ちるかどうかは書き写さず、SDK の `verdict-shape` に訊く**（上の import のコメント）。
  const verdictSource: {
    recommendation: unknown;
    score: number | null;
    /** SDK が返した欠陥。null は「この問いでは何も見つからなかった」であって ALLOW ではない。 */
    defect: ReturnType<typeof scoreQualityDefect>;
    /** 欠陥が `partial` のとき、**どの入力が読めなかったか**を画に出すため。 */
    signals: unknown;
    label: string;
  } | null = decisionUnreadable
    ? // `/decision` が読めなかったのは「カタログ外だった」ではない。代わりの判定源は無い
      // （SDK も同じくここで拒む）。受取人スコアへ畳むと、読めなかった判定が緑の行になる。
      null
    : decisionBody
    ? {
        recommendation: decisionBody.recommendation ?? "—",
        score: null,
        defect: scoreQualityDefect(decisionBody),
        signals: undefined,
        label: "/decision",
      }
    : scoreBody
      ? {
          recommendation: scoreBody.recommendation ?? "—",
          score: typeof scoreBody.score === "number" ? scoreBody.score : null,
          defect: scoreQualityDefect(scoreBody),
          signals: scoreBody.signalsUnavailable,
          label: "payee score",
        }
      : null;
  gates.push(
    gate(
      "payee verdict is ALLOW",
      verdictSource
        ? verdictSource.defect !== null || isBlockVerdict(verdictSource.recommendation)
          ? "fail"
          : // ALLOW は**正規化しないで**比べる（`verdict-shape.ts`: 正規化は片道。読めない綴りを
            // 許可と読むのは緩める方向）。SDK の `recommendation !== "ALLOW"` と同じ厳密比較。
            verdictSource.recommendation === "ALLOW"
            ? "pass"
            : policy.requireVet402Allow
              ? "fail"
              : "waived"
        : "unknown",
      verdictSource
        ? `${String(verdictSource.recommendation)}${verdictSource.score === null ? "" : ` (${verdictSource.score})`}` +
          (verdictSource.defect !== null
            ? defectNote(verdictSource.defect, verdictSource.signals)
            : isBlockVerdict(verdictSource.recommendation)
              ? " — BLOCK is never waived"
              : verdictSource.recommendation === "ALLOW" || policy.requireVet402Allow
                ? ""
                : " — not required by policy") +
          ` [${verdictSource.label}]`
        : "verdict not read",
    ),
  );
  // 免除の代わりに置いた床。**これが実際に判定している。** 0 の床は床ではないので関門にしない。
  const minL1 = policy.evidence.minL1Deliveries;
  if (minL1 !== undefined && minL1 > 0 && policy.evidence.source !== "subgraph") {
    const delivered = l1Delivered(decisionBody);
    gates.push(
      gate(
        // 関門の名前は 32 桁に収める（`render.ts` が padEnd で桁を揃える）。
        `evidence floor: L1 >= ${minL1}`,
        delivered >= minL1 ? "pass" : "fail",
        `${delivered} delivered (need ${minL1})${decisionBody ? "" : " — uncatalogued, no L1 ledger"}`,
      ),
    );
  }
  const minSub = policy.evidence.minSubgraphReceipts;
  if (minSub !== undefined && minSub > 0 && wantsSubgraph) {
    gates.push(
      gate(
        `evidence floor: subgraph >= ${minSub}`,
        subgraph?.ok ? (subgraph.receipts >= minSub ? "pass" : "fail") : "unknown",
        subgraph?.ok
          ? `${subgraph.receipts} receipts (need ${minSub})`
          : `subgraph not read (${subgraph ? subgraph.error : "payee unknown"})`,
      ),
    );
  }
  // 402 は読めたが、払える accept が1件も無い——「読めなかった」とは別の所見なので分けて出す。
  if (challenge && accept === null) {
    gates.unshift(
      gate("no acceptable accept in 402", "fail", `${challenge.accepts.length} offered, none is Base USDC exact/eip3009`),
    );
  }
  // **`/decision` が読めなかったことを、行として立てる。** 2026-09-08 の反証検査が実測した画では、
  // HTTP 429 / 500 / 壊れた JSON のどれもこの行を持たず、落ちた理由が画のどこにも出ていなかった。
  // 通ったときは行を出さない——**正常系の画は1文字も変えない**（提出済みの動画に映っている）。
  if (decisionUnreadable) {
    gates.unshift(
      gate(
        "/decision was readable",
        "fail",
        `${decision.status === null ? "not reachable" : `HTTP ${decision.status}`} — a verdict we could not read is not a verdict`,
      ),
    );
  }
  view.gates = gates;

  const reads: Reads = { probe, accept, payee, decision, uncatalogued, score, subgraph };
  return { view, reads };
}

/**
 * SDK が認可に切る窓（秒）。**手で書いた数字は必ず古くなる**ので、
 * `test/pay.test.mjs` が SDK の署名モジュール（dist）の実装値 `MAX_AUTHORIZATION_WINDOW_SECONDS` と突き合わせる。
 */
export const SDK_AUTHORIZATION_WINDOW_SECONDS = 120;

// ============================================================
// vet402 — openapi ↔ 実装 ↔ SDK の *スキーマ* パリティ (2026-08-22)
//
// WHY THIS EXISTS. tests/openapi-route-parity.test.ts はパスの網羅だけを検査
// する。だから「エンドポイントは載っているが、応答スキーマにフィールドが
// 足りない」という欠落は素通りした。実際に素通りしたのがこれ:
//
//   docs/openapi.yaml の PayeeScoreResult に `degraded` と
//   `signalsUnavailable` が無かった (2026-08-22 監査で発見)。
//
// この2つは SpendGuard (packages/sdk/src/spend-guard.ts) と TrustGate
// (packages/middleware/src/core.ts) と Python SDK が **金を止める根拠その
// もの**。仕様書だけを見て自作したクライアントは、この2つを知らないまま
// `recommendation` だけで判断し、fail-OPEN する。パスが載っているだけでは
// 契約は守られない。
//
// HOW IT CHECKS. 「手で維持する正典のフィールド一覧」を下の SURFACES に1箇所
// だけ置き、OpenAPI・実装の型・各パッケージの型がすべてそれと一致することを
// 検査する。比較は **構造的** に行う:
//   - TypeScript 側は TypeScript コンパイラ API で AST を歩く。ソース本文への
//     正規表現照合ではないので、整形・コメント・改行の変更で偽陰性にならない。
//   - YAML 側はインデント構造を辿る最小リーダ (このファイル内)。openapi.yaml
//     が使う範囲のマッピングしか解さないが、抽出器が壊れたら空集合を返して
//     **静かに緑になる** のが最悪なので、下の "抽出器そのものの健全性" テスト
//     が既知のフィールドの実在を先に確かめる。
//
// NOT CHECKED HERE (意図的):
//   - packages/middleware の ScoreResponse は「ゲートが読む分だけ」の意図的な
//     部分型なので完全一致は求めない。ただし fail-closed の根拠2つを持つこと
//     は下で別途検査する。
//   - packages/python-sdk はスコア本体を dict のまま扱う設計 (spend_guard.py
//     の PayeeScoreResult = Dict[str, Any]) なので、突合できる型が無い。
//     こちらは packages/python-sdk/tests/ の振る舞いテストが受け持つ。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

// ------------------------------------------------------------------
// 正典: この一覧が OpenAPI・実装・SDK 3者の共通の答えである。
// フィールドを増やすときは実装と同時にここを直す。ここを直さずに実装だけ
// 増やしても、ここを直して実装を直し忘れても、下のテストが落ちる。
// ------------------------------------------------------------------
type Surface = {
  label: string;
  /** components.schemas 配下のパス (末尾は properties を含む) */
  spec: string[];
  /** [ソースファイル, 型名から辿るプロパティ列] */
  impl: Array<[string, string[]]>;
  fields: string[];
};

const SURFACES: Surface[] = [
  {
    // 製品定義書 §9.1（2026-09-02）: /decision の応答。facts と recommendation が
    // 同じ文書に同居することを 4 面（実装・OpenAPI・SDK・MCP）で固定する。
    label: "DecisionResult",
    spec: ["DecisionResult", "properties"],
    impl: [
      ["src/lib/decision/decide.ts", ["DecisionResult"]],
      ["packages/sdk/src/index.ts", ["DecisionResult"]],
      ["packages/mcp-server/src/vouch-client.ts", ["DecisionResult"]],
    ],
    fields: [
      "subject",
      "role",
      "payer",
      "recommendation",
      "reason_codes",
      // --- facts を省く経路は無い（§9.1・§15）。消したら仕様違反 ---
      "facts",
      // -----------------------------------------------------------
      "freshness",
      "evidence",
      "score",
      "degraded",
      "policy",
      "rules_version",
      "registry",
      "scoredAt",
      "cacheExpiresAt",
      "disclaimer",
    ],
  },
  // ------------------------------------------------------------------
  // 2026-09-02 敵対的監査 P1-2: 新規ルート（§7.3 / §9.1）の 200 応答が仕様書に
  // 「{ … } の説明文」としてしか無く、SellerFacts 等が SURFACES の外だった。
  // 実装の型 ⇔ openapi ⇔ SDK 型の 3 面で固定する。
  // ------------------------------------------------------------------
  {
    label: "SellerFacts",
    spec: ["SellerFacts", "properties"],
    impl: [
      ["src/lib/decision/types.ts", ["SellerFacts"]],
      ["packages/sdk/src/index.ts", ["SellerFacts"]],
    ],
    fields: [
      "l0",
      "l1",
      "l2",
      "availability_7d",
      "availability_30d",
      "offer_stability",
      "payees",
      "settlement_30d_real",
      "settlement_30d_raw",
      // vet402 自身の測定購入。分母から外して開示する（2026-09-02 exa.ai の誤 BLOCK）。
      "settlement_30d_test",
      "unique_payers_30d_real",
      "wash_dominated",
    ],
  },
  {
    label: "SellerFacts.l1",
    spec: ["SellerFacts", "properties", "l1", "properties"],
    impl: [
      ["src/lib/decision/types.ts", ["SellerFacts", "l1"]],
      ["packages/sdk/src/index.ts", ["SellerFacts", "l1"]],
    ],
    fields: [
      "n_delivered",
      "n_settled",
      "n_attempts",
      // §6.2 こちら側の失敗。売り手の不履行と混ぜないために件数だけ開示する。
      "n_probe_error",
      "p50_ms",
      "p95_ms",
      "last_purchase_id",
      "observed_at",
    ],
  },
  {
    label: "SellerFacts.l2",
    spec: ["SellerFacts", "properties", "l2", "properties"],
    impl: [
      ["src/lib/decision/types.ts", ["SellerFacts", "l2"]],
      ["packages/sdk/src/index.ts", ["SellerFacts", "l2"]],
    ],
    // §6.3（2026-09-02 監査 P1-11）: mismatch の根拠——宣言・応答・差分のハッシュと欠落キー。
    fields: ["status", "declaration_hash", "response_hash", "diff_hash", "missing_keys", "observed_at"],
  },
  {
    label: "BuyerFacts",
    spec: ["BuyerFacts", "properties"],
    impl: [
      ["src/lib/decision/types.ts", ["BuyerFacts"]],
      ["packages/sdk/src/index.ts", ["BuyerFacts"]],
    ],
    fields: [
      "settled_count_30d",
      "unique_payees_30d",
      "retry_burst_rate",
      "sybil",
      "erc8004",
      "first_seen",
      "last_seen",
    ],
  },
  {
    label: "CensusSummary",
    spec: ["CensusSummary", "properties"],
    impl: [
      ["src/lib/settlements/census.ts", ["CensusSummary"]],
      ["packages/sdk/src/index.ts", ["CensusSummary"]],
    ],
    fields: [
      "chain",
      "window",
      "settlements_raw",
      "settlements_real",
      "wash",
      "attribution",
      "unique_payers_raw",
      "unique_payers_real",
      "unique_payees_real",
      "endpoints_with_real_settlement",
      "by_source",
      "coverage",
      "definition",
      "disclaimer",
      "retrievedAt",
    ],
  },
  {
    label: "ResolveResult",
    spec: ["ResolveResult", "properties"],
    impl: [
      ["src/lib/resolve/lookup.ts", ["ResolveResult"]],
      ["packages/sdk/src/index.ts", ["ResolveResult"]],
    ],
    fields: ["query", "resource", "endpoints", "payees", "settlement", "settlement_not_found", "disclaimer"],
  },
  {
    label: "EndpointRef",
    spec: ["EndpointRef", "properties"],
    impl: [
      ["src/lib/resolve/lookup.ts", ["EndpointRef"]],
      ["packages/sdk/src/index.ts", ["EndpointRef"]],
    ],
    fields: [
      "endpoint_id",
      "resource_id",
      "observatory_id",
      "canonical_url",
      "method",
      "payee_id",
      "catalog_status",
      "first_seen",
      "last_seen",
    ],
  },
  {
    label: "SettlementRef",
    spec: ["SettlementRef", "properties"],
    impl: [
      ["src/lib/resolve/lookup.ts", ["SettlementRef"]],
      ["packages/sdk/src/index.ts", ["SettlementRef"]],
    ],
    fields: [
      "purchase_id",
      "chain",
      "tx_hash",
      "payer_id",
      "payee_id",
      "amount",
      "asset",
      "block_time",
      "attribution",
      "wash_flag",
      "resource_id",
      "endpoint_id",
    ],
  },
  {
    label: "CorrectionRow",
    spec: ["CorrectionRow", "properties"],
    impl: [["src/lib/observatory/corrections.ts", ["CorrectionRow"]]],
    fields: ["id", "subject_type", "subject_id", "level", "before", "after", "reason", "dispute_id", "created_at"],
  },
  {
    label: "L0Accuracy",
    spec: ["L0Accuracy", "properties"],
    impl: [["src/lib/scoring/l0-accuracy.ts", ["L0Accuracy"]]],
    fields: [
      "window_days",
      "published_fail",
      "false_fail",
      "false_fail_rate",
      "published_pass",
      "false_pass",
      "false_pass_rate",
      "min_sample",
      "slo",
    ],
  },
  {
    label: "SloSnapshot",
    spec: ["SloSnapshot", "properties"],
    impl: [["src/lib/scoring/l0-accuracy.ts", ["SloSnapshot"]]],
    fields: [
      "l1_probe_error_rate_pct",
      "c1_l0_within_36h_pct",
      "c2_l1_within_48h_pct",
      "reverse_lookup_confirmed_within_60s_pct",
      "published_failure_evidence_complete_pct",
      "unmeasured",
      "targets",
    ],
  },
  {
    label: "CoverageWeekly",
    spec: ["CoverageWeekly", "properties"],
    impl: [["src/lib/observatory/coverage-report.ts", ["CoverageWeekly"]]],
    fields: [
      "window_days",
      "listed",
      "l0_measured",
      "l0_measured_pct",
      "l1_measured",
      "l1_measured_pct",
      "real_settlements",
      "raw_settlements",
      "definition",
    ],
  },
  {
    label: "PayeeScoreResult",
    spec: ["PayeeScoreResult", "properties"],
    impl: [
      ["src/lib/scoring/payee-engine.ts", ["PayeeScoreResult"]],
      ["packages/sdk/src/index.ts", ["PayeeScoreResult"]],
      ["packages/mcp-server/src/vouch-client.ts", ["PayeeScoreResult"]],
    ],
    fields: [
      "payee",
      "score",
      "recommendation",
      "dataDepth",
      // --- 金を止める2つ。消したら fail-OPEN になる (冒頭コメント参照) ---
      "degraded",
      "signalsUnavailable",
      // -------------------------------------------------------------
      "signals",
      "scoredAt",
      "cacheExpiresAt",
      "disclaimer",
    ],
  },
  {
    label: "PayeeSignals",
    spec: ["PayeeSignals", "properties"],
    impl: [
      ["src/lib/scoring/payee-engine.ts", ["PayeeScoreResult", "signals"]],
      ["packages/sdk/src/index.ts", ["PayeeScoreResult", "signals"]],
      ["packages/mcp-server/src/vouch-client.ts", ["PayeeScoreResult", "signals"]],
    ],
    fields: ["receiving", "walletHealth", "drainPattern", "outcomeHistory", "flags"],
  },
  {
    label: "PayeeSignals.receiving",
    spec: ["PayeeSignals", "properties", "receiving", "properties"],
    impl: [
      ["src/lib/scoring/payee-engine.ts", ["PayeeScoreResult", "signals", "receiving"]],
      ["packages/sdk/src/index.ts", ["PayeeScoreResult", "signals", "receiving"]],
      ["packages/mcp-server/src/vouch-client.ts", ["PayeeScoreResult", "signals", "receiving"]],
    ],
    fields: [
      "paymentCount",
      "uniqueDays",
      "distinctPayers",
      "score",
      "l1DeliveryCount",
      "l1DistinctBuyers",
      // 2026-08-26: 「我々が実費で払って届かなかった」記録。最終スコアの天井に
      // 効かせている以上、根拠を公開面へ出す。
      "l1Settled",
      "l1PaidNeverSettled",
      "l1NonSettlingDays",
      "l1PendingVerification",
      "l1NonDeliveryReason",
    ],
  },
  {
    label: "PayeeSignals.walletHealth",
    spec: ["PayeeSignals", "properties", "walletHealth", "properties"],
    impl: [
      ["src/lib/scoring/payee-engine.ts", ["PayeeScoreResult", "signals", "walletHealth"]],
      ["packages/sdk/src/index.ts", ["PayeeScoreResult", "signals", "walletHealth"]],
      ["packages/mcp-server/src/vouch-client.ts", ["PayeeScoreResult", "signals", "walletHealth"]],
    ],
    fields: ["ageDays", "txCount", "isBurner", "score"],
  },
  {
    label: "PayeeSignals.drainPattern",
    spec: ["PayeeSignals", "properties", "drainPattern", "properties"],
    impl: [
      ["src/lib/scoring/payee-engine.ts", ["PayeeScoreResult", "signals", "drainPattern"]],
      ["packages/sdk/src/index.ts", ["PayeeScoreResult", "signals", "drainPattern"]],
      ["packages/mcp-server/src/vouch-client.ts", ["PayeeScoreResult", "signals", "drainPattern"]],
    ],
    fields: [
      "detected",
      "drainRatio",
      "outgoingCount",
      "incomingCount",
      "score",
      // 読めなかった資産レグ。非空 = drain の視界が部分的、という開示。
      "unmeasured",
    ],
  },
  {
    label: "PayeeSignals.outcomeHistory",
    spec: ["PayeeSignals", "properties", "outcomeHistory", "properties"],
    impl: [
      ["src/lib/scoring/payee-engine.ts", ["PayeeScoreResult", "signals", "outcomeHistory"]],
      ["packages/sdk/src/index.ts", ["PayeeScoreResult", "signals", "outcomeHistory"]],
      ["packages/mcp-server/src/vouch-client.ts", ["PayeeScoreResult", "signals", "outcomeHistory"]],
    ],
    fields: ["types", "adjustment"],
  },
  {
    label: "TrustSignals.x402",
    spec: ["TrustSignals", "properties", "x402", "properties"],
    impl: [
      ["src/lib/scoring/types.ts", ["TrustSignals", "x402"]],
      ["packages/sdk/src/index.ts", ["TrustScoreResult", "signals", "x402"]],
      ["packages/mcp-server/src/vouch-client.ts", ["TrustScoreResult", "signals", "x402"]],
    ],
    fields: [
      "paymentCount",
      "uniqueDays",
      "score",
      // 2026-08-14 の L1 観測購買。エンジンが返しているのに SDK 型が狭かった。
      "l1PurchaseCount",
      "l1DistinctSellers",
    ],
  },
];

/**
 * 常に応答本文に載るフィールド (OpenAPI の required にも入るべきもの)。
 * PayeeScoreResult は実装 (payee-engine.ts の result リテラル) が全項目を
 * 無条件に組み立てるので、10項目すべてが required。
 */
const PAYEE_SCORE_RESULT_REQUIRED = SURFACES.find((s) => s.label === "PayeeScoreResult")!.fields;

/**
 * fail-closed の根拠フィールド。SURFACES を誰かが雑に編集しても、これだけは
 * 独立に落ちるように二重化してある。middleware は意図的な部分型なので
 * 「含むこと」だけを見る。
 */
const FAIL_CLOSED_FIELDS = ["degraded", "signalsUnavailable"] as const;

// ------------------------------------------------------------------
// YAML 最小リーダ (インデント構造を辿る。openapi.yaml が使う範囲のみ)
// ------------------------------------------------------------------
const indentOf = (line: string) => line.length - line.trimStart().length;

function minIndent(lines: string[]): number {
  let m = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    m = Math.min(m, indentOf(l));
  }
  return m;
}

/** `key:` の直下のブロック (その行より深いインデントの連続行) を返す。 */
function subBlock(lines: string[], key: string): string[] | null {
  const ind = minIndent(lines);
  const start = lines.findIndex(
    (l) => indentOf(l) === ind && new RegExp(`^\\s*${key}:`).test(l),
  );
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      out.push(l);
      continue;
    }
    if (indentOf(l) <= ind) break;
    out.push(l);
  }
  return out;
}

function blockAtPath(lines: string[], path: string[]): string[] | null {
  let cur: string[] | null = lines;
  for (const key of path) {
    if (cur === null) return null;
    cur = subBlock(cur, key);
  }
  return cur;
}

/** ブロック直下のマッピングキー名 (`foo:` / `foo: { … }` の両方)。 */
function childKeys(lines: string[]): string[] {
  const ind = minIndent(lines);
  const out: string[] = [];
  for (const l of lines) {
    if (indentOf(l) !== ind) continue;
    const m = /^\s*([A-Za-z0-9_]+):/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

/** ブロックリスト (`- foo`) とインラインリスト (`[a, b]`) の両方を読む。 */
function scalarList(lines: string[]): string[] {
  const ind = minIndent(lines);
  const items: string[] = [];
  for (const l of lines) {
    if (indentOf(l) !== ind) continue;
    const m = /^\s*-\s*(\S+)\s*$/.exec(l);
    if (m) items.push(m[1]);
  }
  return items;
}

function specSchemas(): string[] {
  const spec = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8").split("\n");
  const schemas = blockAtPath(spec, ["components", "schemas"]);
  assert.ok(schemas, "components.schemas がスペックから読めない — 抽出器が壊れている");
  return schemas;
}

// ------------------------------------------------------------------
// TypeScript AST リーダ (型エイリアスのメンバ名を構造的に取り出す)
// ------------------------------------------------------------------
const sourceCache = new Map<string, ts.SourceFile>();

function sourceOf(rel: string): ts.SourceFile {
  const cached = sourceCache.get(rel);
  if (cached) return cached;
  const sf = ts.createSourceFile(
    rel,
    readFileSync(join(ROOT, rel), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  sourceCache.set(rel, sf);
  return sf;
}

function aliasType(sf: ts.SourceFile, name: string): ts.TypeNode | null {
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) && st.name.text === name) return st.type;
  }
  return null;
}

/** インライン型リテラルも、同ファイル内の別エイリアスへの参照も、同じに扱う。 */
function resolveLiteral(sf: ts.SourceFile, node: ts.TypeNode | undefined | null): ts.TypeLiteralNode | null {
  if (!node) return null;
  if (ts.isTypeLiteralNode(node)) return node;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return resolveLiteral(sf, aliasType(sf, node.typeName.text));
  }
  return null;
}

/** `["PayeeScoreResult", "signals", "receiving"]` → そのオブジェクトのメンバ名。 */
function membersAtPath(rel: string, path: string[]): string[] | null {
  const sf = sourceOf(rel);
  let node = resolveLiteral(sf, aliasType(sf, path[0]));
  for (const seg of path.slice(1)) {
    if (!node) return null;
    const member = node.members.find(
      (m) => ts.isPropertySignature(m) && m.name.getText(sf) === seg,
    ) as ts.PropertySignature | undefined;
    if (!member) return null;
    node = resolveLiteral(sf, member.type);
  }
  if (!node) return null;
  return node.members.filter(ts.isPropertySignature).map((m) => m.name.getText(sf));
}

const sorted = (xs: string[]) => [...xs].sort();

// ------------------------------------------------------------------
// 抽出器そのものの健全性 — 空集合を返して静かに緑になるのを防ぐ
// ------------------------------------------------------------------
test("抽出器が実際にスキーマと型を読めている (空集合で緑にならない)", () => {
  const schemas = specSchemas();
  assert.ok(
    childKeys(schemas).length >= 20,
    `components.schemas のスキーマ数が少なすぎる (${childKeys(schemas).length}) — YAML リーダが壊れている`,
  );
  const props = blockAtPath(schemas, ["PayeeScoreResult", "properties"]);
  assert.ok(props, "PayeeScoreResult.properties が読めない");
  assert.ok(childKeys(props).includes("payee"), "既知のフィールド payee すら読めていない");

  const impl = membersAtPath("src/lib/scoring/payee-engine.ts", ["PayeeScoreResult"]);
  assert.ok(impl && impl.includes("payee"), "実装の PayeeScoreResult を AST から読めていない");

  const nested = membersAtPath("packages/sdk/src/index.ts", [
    "PayeeScoreResult",
    "signals",
    "receiving",
  ]);
  assert.ok(
    nested && nested.includes("paymentCount"),
    "入れ子 (signals.receiving) を AST から辿れていない",
  );
});

// ------------------------------------------------------------------
// 本体
// ------------------------------------------------------------------
for (const surface of SURFACES) {
  test(`openapi の ${surface.label} が正典のフィールド一覧と一致する`, () => {
    const block = blockAtPath(specSchemas(), surface.spec);
    assert.ok(block, `docs/openapi.yaml に ${surface.spec.join(".")} が無い`);
    assert.deepEqual(
      sorted(childKeys(block)),
      sorted(surface.fields),
      `docs/openapi.yaml の ${surface.label} が実装と食い違っている。` +
        "仕様書だけを見て書かれたクライアントは、ここに無いフィールドを読まない。",
    );
  });

  for (const [rel, path] of surface.impl) {
    test(`${rel} の ${path.join(".")} が正典のフィールド一覧と一致する`, () => {
      const members = membersAtPath(rel, path);
      assert.ok(members, `${rel} に型 ${path.join(".")} が見つからない`);
      assert.deepEqual(
        sorted(members),
        sorted(surface.fields),
        `${rel} の ${surface.label} が正典と食い違っている。` +
          "型が API 応答より狭いと、そのフィールドを読む理由が利用者に伝わらない。",
      );
    });
  }
}

test("PayeeScoreResult の全フィールドが openapi の required に入っている", () => {
  // 実装 (payee-engine.ts の result リテラル) は10項目すべてを無条件に組み立てる。
  // optional にすると「来ないこともある」と読まれ、degraded 未検査の言い訳になる。
  const required = blockAtPath(specSchemas(), ["PayeeScoreResult", "required"]);
  assert.ok(required, "PayeeScoreResult.required が読めない");
  assert.deepEqual(sorted(scalarList(required)), sorted(PAYEE_SCORE_RESULT_REQUIRED));
});

test("fail-closed の根拠フィールドが仕様書・実装・全パッケージに在る", () => {
  const specProps = childKeys(blockAtPath(specSchemas(), ["PayeeScoreResult", "properties"])!);
  const specRequired = scalarList(blockAtPath(specSchemas(), ["PayeeScoreResult", "required"])!);

  for (const field of FAIL_CLOSED_FIELDS) {
    assert.ok(
      specProps.includes(field),
      `docs/openapi.yaml の PayeeScoreResult に ${field} が無い。` +
        "これが無いと、仕様書だけを見て自作したクライアントは fail-OPEN する。",
    );
    assert.ok(
      specRequired.includes(field),
      `docs/openapi.yaml の PayeeScoreResult.required に ${field} が無い。` +
        "optional だと「無いこともある」と読まれ、検査しない実装が正当化される。",
    );

    for (const rel of [
      "src/lib/scoring/payee-engine.ts",
      "packages/sdk/src/index.ts",
      "packages/mcp-server/src/vouch-client.ts",
    ]) {
      const members = membersAtPath(rel, ["PayeeScoreResult"]);
      assert.ok(
        members?.includes(field),
        `${rel} の PayeeScoreResult に ${field} が無い`,
      );
    }

    // middleware の ScoreResponse は「ゲートが読む分だけ」の意図的な部分型。
    // 完全一致は求めないが、金を止める根拠2つを落としたら fail-OPEN するので
    // ここだけは含有を検査する。
    const gateFields = membersAtPath("packages/middleware/src/core.ts", ["ScoreResponse"]);
    assert.ok(
      gateFields?.includes(field),
      `packages/middleware/src/core.ts の ScoreResponse に ${field} が無い — ` +
        "TrustGate がその根拠でブロックできなくなる",
    );
  }
});

test("AccuracyReport が l0 / slo / coverageWeekly を持ち、それぞれの schema を参照する", () => {
  const props = blockAtPath(specSchemas(), ["AccuracyReport", "properties"]);
  assert.ok(props, "AccuracyReport.properties が読めない");
  const keys = childKeys(props);
  for (const [key, ref] of [
    ["l0", "L0Accuracy"],
    ["slo", "SloSnapshot"],
    ["coverageWeekly", "CoverageWeekly"],
  ] as const) {
    assert.ok(keys.includes(key), `AccuracyReport に ${key} が無い（実装は返している）`);
    const block = subBlock(props, key)!.join("\n");
    assert.ok(block.includes(`#/components/schemas/${ref}`), `AccuracyReport.${key} が ${ref} を参照していない`);
  }
});

test("DecisionResult.facts は SellerFacts | BuyerFacts を参照する（Record 扱いにしない）", () => {
  const props = blockAtPath(specSchemas(), ["DecisionResult", "properties"]);
  assert.ok(props, "DecisionResult.properties が読めない");
  const facts = subBlock(props, "facts")!.join("\n");
  assert.ok(facts.includes("#/components/schemas/SellerFacts"), "DecisionResult.facts が SellerFacts を参照していない");
  assert.ok(facts.includes("#/components/schemas/BuyerFacts"), "DecisionResult.facts が BuyerFacts を参照していない");
});

test("新規ルートの 200 が components の schema を参照する（説明文だけで済ませない）", () => {
  const spec = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");
  for (const [path, ref] of [
    ["/api/v1/resolve:", "ResolveResult"],
    ["/api/v1/resources/{resourceId}:", "ResourceResponse"],
    ["/api/v1/endpoints/{endpointId}:", "EndpointResponse"],
    ["/api/v1/payees/{address}/endpoints:", "PayeeEndpointsResponse"],
    ["/api/v1/endpoints/{endpointId}/payees:", "EndpointPayeesResponse"],
    ["/api/v1/observatory/endpoints/{id}/facts:", "EndpointFactsResponse"],
    ["/api/v1/census/summary:", "CensusSummary"],
    ["/api/v1/observatory/corrections:", "CorrectionsResponse"],
  ] as const) {
    const start = spec.indexOf(`\n  ${path}`);
    assert.ok(start !== -1, `${path} が paths に無い`);
    const next = spec.indexOf("\n  /api/", start + 1);
    const block = spec.slice(start, next === -1 ? undefined : next);
    assert.ok(block.includes(`#/components/schemas/${ref}`), `${path} の 200 が ${ref} を参照していない`);
  }
});

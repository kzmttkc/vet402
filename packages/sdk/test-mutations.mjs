#!/usr/bin/env node
/**
 * **偽の緑を作らない。変異で確かめる。**
 *
 * 「テストが緑」は「テストが規則を守っている」を意味しない。ここでは
 * `payOrRefuse` と `readSubgraphReceipts` の関門を**1つずつわざと壊してから、
 * 赤くなるかを見る**。赤くならない変異（SURVIVED）があれば、その規則は
 * 検査されていないので、テストを足す。**この表を出す側では直さない**——
 * 生き残りは「発見」として報告し、消さない。
 *
 *   npm run mutations        # = node test-mutations.mjs
 *
 * 構造は `examples/ethonline-2026-ab/test-mutations.mjs` と同じ:
 *   - 走らせる前に「今が緑であること」を確かめ、緑でなければ何も変異させない
 *   - 変異はソースを**その場で**書き換え、必ず元へ戻す（finally）
 *   - 復元後に緑を再確認し、`MUTANT` マーカーが src に残っていないことを確かめる
 *   - SURVIVED が1つでもあれば exit 1
 *
 * 各変異は `/* MUTANT *\/` を含む文字列に置き換えるので、復元漏れは
 * `grep -rn MUTANT src` で機械的に見つかる。
 *
 * テストは dist から読む（package.json の `test`）ので、変異ごとに tsc を通す。
 * 1 変異 ≈ tsc 0.7s + node --test 0.3s。
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAY = "src/pay-or-refuse.ts";
const SUB = "src/subgraph-evidence.ts";
const X402 = "src/x402-pay.ts";
/** 判定語と品質欄の読み方（2 経路の共有規則）。 */
const VERDICT = "src/verdict-shape.ts";
/** 壊れた形の表（テスト側の資産）。表を痩せさせる変異も殺せることを見る。 */
const SHAPES = "test/_shapes.mjs";

/**
 * `find` は**ちょうど1回**出現する行でなければならない（0 回は stale、2 回以上は
 * 意図しない場所を壊す）。複数箇所を同時に壊す変異は `edits: [{find, replace}]`。
 * 全部の `replace` に `MUTANT` を含める——復元漏れの検出はこの語に頼る。
 */
const MUTATIONS = [
  // ---- §3.2.1 免除の境界（WARN は意見、BLOCK は遮断）----
  {
    id: "M01",
    what: "BLOCK を requireVet402Allow:false で通す（/decision 経路）",
    rule: "§3.2.1 BLOCK は免除の対象外（J10a）",
    file: PAY,
    find: "    if (isBlockVerdict(decision.recommendation)) {",
    replace: "    if (/* MUTANT */ requireVet402Allow && isBlockVerdict(decision.recommendation)) {",
  },
  {
    id: "M02",
    what: "BLOCK を requireVet402Allow:false で通す（404・受取人スコア経路）",
    rule: "§3.2.1 BLOCK は免除の対象外（J10b）",
    file: PAY,
    find: "    if (isBlockVerdict(payeeScore?.recommendation)) {",
    replace: "    if (/* MUTANT */ requireVet402Allow && isBlockVerdict(payeeScore?.recommendation)) {",
  },
  {
    id: "M03",
    what: "degraded を requireVet402Allow:false で通す（/decision 経路）",
    rule: "J7 測れなかったことと ALLOW でないことは別",
    file: PAY,
    find: "    if (scoreQualityDefect(decision) !== null) {",
    replace: "    if (/* MUTANT */ requireVet402Allow && scoreQualityDefect(decision) !== null) {",
  },
  {
    id: "M04",
    what: "degraded / signalsUnavailable を requireVet402Allow:false で通す（404 経路）",
    rule: "J7 の 404 側（免除は判定の中身だけ）",
    file: PAY,
    find: "    if (scoreQualityDefect(payeeScore) !== null) {",
    replace: "    if (/* MUTANT */ requireVet402Allow && scoreQualityDefect(payeeScore) !== null) {",
  },
  // ---- 証拠の床 ----
  {
    id: "M05",
    what: "subgraph の床の比較を反転（< → >）",
    rule: "C11 minSubgraphReceipts 未達で拒否",
    file: PAY,
    find: "    if (subgraph.receipts < policy.minSubgraphReceipts) {",
    replace: "    if (/* MUTANT */ subgraph.receipts > policy.minSubgraphReceipts) {",
  },
  {
    id: "M06",
    what: "subgraph の床の境界を1つずらす（< → <=・ちょうど床の値を拒否）",
    rule: "床は「以上」で通す（境界値）",
    file: PAY,
    find: "    if (subgraph.receipts < policy.minSubgraphReceipts) {",
    replace: "    if (/* MUTANT */ subgraph.receipts <= policy.minSubgraphReceipts) {",
  },
  {
    id: "M07",
    what: "minL1Deliveries の床を外す（常に満たす）",
    rule: "C10 minL1Deliveries 未達で拒否",
    file: PAY,
    find: "    if (delivered < policy.minL1Deliveries) {",
    replace: "    if (/* MUTANT */ delivered < 0) {",
  },
  {
    id: "M08",
    what: "requireVet402Allow:false ＋ evidence 無しを invalid_policy にしない",
    rule: "§3.2 判定を外すなら代わりを置け（J2a）",
    file: PAY,
    find: "  if (!policy || policy.requireVet402Allow !== false) return;",
    replace: "  if (!policy || policy.requireVet402Allow !== false || policy.evidence === undefined) return; /* MUTANT */",
  },
  {
    id: "M09",
    what: "0 の床を床として数える（> 0 → >= 0）",
    rule: "§3.2 0 の床は床ではない（J2c）",
    file: PAY,
    find: "  if (floors.some((floor) => typeof floor === \"number\" && floor > 0)) return;",
    replace: "  if (/* MUTANT */ floors.some((floor) => typeof floor === \"number\" && floor >= 0)) return;",
  },
  {
    id: "M19",
    what: "L1 の床に subgraph の件数を合算して当てる",
    rule: "D16 源をまたいで足さない（D16b）",
    file: PAY,
    find: '    const delivered = typeof nDelivered === "number" && Number.isInteger(nDelivered) && nDelivered >= 0 ? nDelivered : 0;',
    replace:
      '    const delivered = (typeof nDelivered === "number" && Number.isInteger(nDelivered) && nDelivered >= 0 ? nDelivered : 0) + (subgraph?.receipts ?? 0); /* MUTANT */',
  },
  {
    id: "M21",
    what: "source:subgraph を選んでも Graph を読まない（both のときだけ読む）",
    rule: "D13c subgraph を名指しされたのに読めていないなら払わない",
    file: PAY,
    find: '  if (wantedSource === "subgraph" || wantedSource === "both") {',
    replace: '  if (/* MUTANT */ wantedSource === "both") {',
  },
  // ---- /decision の本文の形（2026-09-07 第三者監査 A1 / A4 / 追加1）----
  {
    id: "M28",
    what: "200 の JSON が object でなくても判定として受ける（null/false/0/\"\" で ALLOW 検査が飛ぶ）",
    rule: "A1 判定本文は非 null の plain object だけ",
    file: PAY,
    find: "    } else if (!isPlainObject(body)) {\n      return refuse([\"evidence_unavailable\"], \"decision\");\n    } else {",
    replace: "    } else { /* MUTANT */",
  },
  {
    id: "M29",
    what: "読めなかった本文を {} として判定に通す（非 JSON の 200 が判定になる）",
    rule: "A4 読めなかった本文は evidence_unavailable",
    file: PAY,
    find: "    } catch {\n      body = null;\n    }",
    replace: "    } catch {\n      body = {}; /* MUTANT */\n    }",
  },
  {
    id: "M30",
    what: "/decision の品質検査を `degraded === true` だけに戻す（型検査も signalsUnavailable の申告も見ずに払う）",
    rule: "追加1 degraded は boolean でなければ止める ／ 2026-09-12 読めなかった信号の申告も「測れた」ではない",
    file: PAY,
    find: "    if (scoreQualityDefect(decision) !== null) {",
    replace: "    if (/* MUTANT */ decision.degraded === true) {",
  },
  // ---- 境界表（test/_shapes.mjs × test/boundary-shapes.test.mjs・2026-09-08）----
  {
    id: "M35",
    what: "n_delivered の整数検査を typeof number に戻す（JSON の 1e400 = Infinity が床 1 を満たして払う）",
    rule: "境界表 facts.l1.n_delivered は 0 以上の整数だけを件数と読む",
    file: PAY,
    find: '    const delivered = typeof nDelivered === "number" && Number.isInteger(nDelivered) && nDelivered >= 0 ? nDelivered : 0;',
    replace: '    const delivered = typeof nDelivered === "number" ? nDelivered : 0; /* MUTANT */',
  },
  {
    id: "M36",
    what: "recommendation の照合を String() で緩める（[\"ALLOW\"] や { toString } が ALLOW に読める）",
    rule: "境界表 recommendation は文字列 \"ALLOW\" との厳密一致だけ",
    file: PAY,
    find: '    if (decision.recommendation !== "ALLOW") {',
    replace: '    if (/* MUTANT */ String(decision.recommendation) !== "ALLOW") {',
  },
  {
    id: "M37",
    what: "subgraph の totalPayments を Number() で読む（\"0x10\" / \"1e4\" / \" 5 \" / true が床の上の数になる）",
    rule: "境界表 件数は 10 進整数の文字列か 0 以上の整数だけ",
    file: SUB,
    find: "  const receipts = isReceiptCount(rawTotal) ? Number(rawTotal) : NaN;",
    replace: "  const receipts = Number(rawTotal); /* MUTANT */",
  },
  {
    id: "M38",
    what: "ブロック高の整数・正の検査を外す（0 / -1 / 0.5 / Infinity が live の証跡になる）",
    rule: "境界表 _meta.block.number は正の整数だけ",
    file: SUB,
    find: '  if (typeof blockNumber !== "number" || !Number.isInteger(blockNumber) || blockNumber <= 0) return { ok: false, error: "graph_no_block_meta" };',
    replace: '  if (/* MUTANT */ typeof blockNumber !== "number") return { ok: false, error: "graph_no_block_meta" };',
  },
  {
    id: "M39",
    what: "売り手が名乗る maxTimeoutSeconds の上限（120 秒）を外す（20000 秒の認可に署名する）",
    rule: "境界表 認可の窓は 60〜120 秒（inert 欄でも署名に漏れない）",
    file: X402,
    find: "  const window = Math.floor(Math.min(Math.max(requested, 60), MAX_AUTHORIZATION_WINDOW_SECONDS));",
    replace: "  const window = Math.floor(Math.max(requested, 60)); /* MUTANT */",
  },
  {
    id: "M40",
    what: "壊れた形の表を 1 行に減らす（面 × 形の掛け算が 1 列になる）",
    rule: "境界表 REQUIRED_SHAPE_IDS が全部居ること（表そのもののテスト）",
    file: SHAPES,
    find: "export const BROKEN_SHAPES = Object.freeze(ROWS.map((r) => Object.freeze(r)));",
    replace: "export const BROKEN_SHAPES = Object.freeze(ROWS.slice(0, 1).map((r) => Object.freeze(r))); /* MUTANT */",
  },
  // ---- カタログ外（I23）----
  {
    id: "M10",
    what: "/decision 404 を ALLOW 判定に化かす（受取人スコアを引かない）",
    rule: "I23 カタログ外は payTo と受取人スコアで判定する",
    file: PAY,
    find: "      uncatalogued = true;",
    replace:
      '      decision = { recommendation: "ALLOW", reason_codes: [], evidence: [] } as unknown as DecisionResult; /* MUTANT */',
  },
  // ---- 402 の照合（B）----
  {
    id: "M11",
    what: "payTo と payee の照合を外す（常に一致扱い）",
    rule: "A4 照合は payTo で行う（B-4）",
    file: PAY,
    find: "  if (!sameAddress(accept.payTo, input.payee)) {",
    replace: "  if (/* MUTANT */ !sameAddress(accept.payTo, accept.payTo)) {",
  },
  {
    id: "M12",
    what: "402 の amount 上限（金銭ゲート）を 1000 倍に緩める",
    rule: "金銭ゲートは署名の前・402 の金額で当てる",
    file: PAY,
    find: "  if (units / 10 ** USDC_DECIMALS > maxPerTxUsd) return [\"price_above_ceiling\"];",
    replace: "  if (/* MUTANT */ units / 10 ** USDC_DECIMALS > maxPerTxUsd * 1000) return [\"price_above_ceiling\"];",
  },
  {
    id: "M31",
    what: "402 の amount の形の検査を外す（\"0x10\" / \"1e4\" / \" 20000 \" が Number で上限内に読めて署名へ進む）",
    rule: "A6 amount は 10 進の整数文字列だけ受理する",
    file: PAY,
    find: '  if (!isDecimalUnits(accept.amount)) return ["evidence_unavailable"];',
    replace: "  /* MUTANT: amount format check removed */",
  },
  {
    id: "M45",
    what: '金銭ゲートの units <= 0 を units < 0 に（402 の額 "0" が $0 認可の署名へ進む）',
    rule: "額 0 の accept は署名の前に落とす（2026-09-09 監査 A9 NEW2: 表に文字列 \"0\" が無く生き残った）",
    file: PAY,
    find: '  if (!Number.isFinite(units) || units <= 0) return ["chain_or_asset_mismatch"];',
    replace: '  if (/* MUTANT */ !Number.isFinite(units) || units < 0) return ["chain_or_asset_mismatch"];',
  },
  {
    id: "M32",
    what: "402 の額と呼び手の名乗り（amountUsd）の照合を外す（amountUsd 0.01 に $1 の 402 を上限内として払う）",
    rule: "A3 名乗りは上限とは別の関門（price_above_declared）",
    file: PAY,
    find: "  if (BigInt(accept.amount) > BigInt(Math.round(input.amountUsd * 10 ** USDC_DECIMALS))) {",
    replace: "  if (/* MUTANT */ false) {",
  },
  {
    id: "M33",
    what: "maxPerTxUsd の有限・正の検査を外す（NaN の上限で上限比較が全部通る）",
    rule: "A2 上限は Number.isFinite(x) && x > 0 でなければ throw",
    file: PAY,
    find: "  assertMaxPerTxUsd(input.policy?.maxPerTxUsd);",
    replace: "  /* MUTANT: maxPerTxUsd check removed */",
  },
  {
    id: "M34",
    what: "床の有限・非負の検査を外す（NaN の床は delivered < NaN が常に false で床にならない）",
    rule: "A2 床は Number.isFinite(x) && x >= 0 でなければ throw",
    file: PAY,
    find: '  assertFiniteFloor("minL1Deliveries", policy.minL1Deliveries);\n  assertFiniteFloor("minSubgraphReceipts", policy.minSubgraphReceipts);',
    replace: "  /* MUTANT: floor checks removed */",
  },
  {
    id: "M13",
    what: "呼び手が名乗った amountUsd の上限を 1000 倍に緩める",
    rule: "C9 上限は判定を引く前に当てる",
    file: PAY,
    find: "  if (input.amountUsd > maxPerTxUsd) {",
    replace: "  if (/* MUTANT */ input.amountUsd > maxPerTxUsd * 1000) {",
  },
  {
    id: "M20",
    what: "accepts の先頭だけを見る（並べ替えで結論が変わる）",
    rule: "K1 条件を満たす accept が先頭でなくても選ぶ",
    file: PAY,
    find: "  const eligible = normalized.filter(isProtocolEligible);",
    replace: "  const eligible = normalized.slice(0, 1).filter(isProtocolEligible); /* MUTANT */",
  },
  // ---- 署名への到達（4層）----
  {
    id: "M14",
    what: "支払いモジュールの動的 import を ALLOW ブランチの外（関数冒頭）へ出す",
    rule: "第3層 拒否経路では支払い実装が評価すらされない",
    file: PAY,
    edits: [
      {
        find: '  const { executeX402Payment } = await import("./x402-pay.js");',
        replace: "  /* MUTANT: import hoisted */",
      },
      {
        find: "  const fetchFn = input.fetch;",
        replace: '  const fetchFn = input.fetch;\n  const { executeX402Payment } = await import("./x402-pay.js"); /* MUTANT */',
      },
    ],
  },
  {
    id: "M15",
    what: "拒否経路で signer のプロパティに触る",
    rule: "第1層 拒否のとき sign* への参照が 0（A1）",
    file: PAY,
    find: "  ): PayOrRefuseResult => ({\n    status: \"refused\",",
    replace: "  ): PayOrRefuseResult => (void input.account.signTypedData, /* MUTANT */ {\n    status: \"refused\",",
  },
  // ---- 署名後（E18・nonce 束縛）----
  {
    id: "M16",
    what: "settle 失敗のとき nonce を落とす",
    rule: "E18 何に署名したかは残す（監査の nonce 束縛）",
    file: PAY,
    find: "      nonce: paid.nonce ?? signedNonce,",
    replace: "      nonce: null, /* MUTANT */",
  },
  {
    id: "M17",
    what: "settle 失敗のとき signed:false と書く（署名を隠す）",
    rule: "E18 署名は実在する・隠さない",
    file: PAY,
    find: "      signed: paid.signed,\n      attested: false,",
    replace: "      signed: false, /* MUTANT */\n      attested: false,",
  },
  {
    id: "M26",
    what: "attest に authNonce を載せない",
    rule: "G-e attest は署名した nonce を載せる",
    file: PAY,
    find: "          authNonce: paid.nonce,",
    replace: "          authNonce: null, /* MUTANT */",
  },
  {
    id: "M27",
    what: "onSigned で nonce を控えない",
    rule: "署名の直後に nonce を確定させる（settle が throw しても残す）",
    file: PAY,
    find: "    onSigned: ({ nonce }) => {\n      signedNonce = nonce;\n    },",
    replace: "    onSigned: () => { /* MUTANT */ },",
  },
  {
    id: "M18",
    what: "呼び手の規則で通しても verdict_source を \"decision\" と書く",
    rule: "§3.2 黙って弱くならない（J3）",
    file: PAY,
    find: '    policyOverride ? "caller_policy" : uncatalogued ? "payee_score" : "decision";',
    replace: '    /* MUTANT */ uncatalogued ? "payee_score" : "decision";',
  },
  // ---- readSubgraphReceipts（S1〜S8）----
  {
    id: "M22",
    what: "_meta.block 無しを block 0 の成功に化かす",
    rule: "S3 live を読んだと言えないものを証拠にしない",
    file: SUB,
    edits: [
      {
        find: '  if (typeof blockNumber !== "number" || !Number.isInteger(blockNumber) || blockNumber <= 0) return { ok: false, error: "graph_no_block_meta" };',
        replace: '  const blockNumberOrZero = typeof blockNumber === "number" ? blockNumber : 0; /* MUTANT */',
      },
      { find: "      number: blockNumber,", replace: "      number: blockNumberOrZero, /* MUTANT */" },
    ],
  },
  {
    id: "M23",
    what: "GraphQL errors が1件なら無視して data を読む",
    rule: "S1 鍵無しの 200+errors は「読めなかった」",
    file: SUB,
    find: "  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {",
    replace: "  if (/* MUTANT */ Array.isArray(envelope.errors) && envelope.errors.length > 1) {",
  },
  {
    id: "M24",
    what: "エラー経路の鍵の無害化を外す",
    rule: "S7b error に鍵を出さない",
    file: SUB,
    find: "  return { ok: false, error: redactGraphKey(result.error, input.apiKey) };",
    replace: "  return { ok: false, error: result.error }; /* MUTANT */",
  },
  {
    id: "M25",
    what: "address の 0x40hex 検査を「文字列か」だけにする",
    rule: "S8 通信の前に呼び出し側エラー",
    file: SUB,
    find: '  if (typeof input.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.address.trim())) {',
    replace: '  if (/* MUTANT */ typeof input.address !== "string") {',
  },

  // ---- 判定語と品質欄の読み方（2026-09-08 の反証検査。共有規則を外すと 2 経路が同時に緩む）----
  {
    id: "M41",
    what: "判定語の trim を外す（`\" BLOCK \"` が BLOCK でなくなり免除経路へ落ちる）",
    rule: "N1/N2 判定語は前後の空白を落として読む",
    file: VERDICT,
    find: '  return String(value ?? "").trim().toUpperCase() === "BLOCK";',
    replace: '  return String(value ?? "").toUpperCase() === "BLOCK"; /* MUTANT */',
  },
  {
    id: "M42",
    what: 'degraded の型検査を外す（文字列 "true" / 数値 1 が === true を素通りする）',
    rule: "N5/N9 degraded は boolean でなければ「測れた」と言えない",
    file: VERDICT,
    find: '  if (typeof score.degraded !== "boolean" || score.degraded === true) return "degraded";',
    replace: '  if (score.degraded === true) return "degraded"; /* MUTANT */',
  },

  // ---- pin した deployment（2026-09-08）。「live を読んだ」と「その subgraph を読んだ」は別 ----
  {
    id: "M43",
    what: "pin と応答の deployment の突き合わせを外す（再デプロイで中身が別物でも払う）",
    rule: "S10/D18 pin が一致しない応答は証拠にしない",
    file: SUB,
    find: "    if (seenDeployment !== pinnedDeployment) {",
    replace: "    if (/* MUTANT */ false) {",
  },
  {
    id: "M44",
    what: "応答が deployment を名乗らないとき、pin を当てはめて「一致した」ことにする",
    rule: "S12 照合できなかったことを、照合できたことにしない",
    file: SUB,
    find: '    const seenDeployment = typeof returnedDeployment === "string" ? returnedDeployment.trim() : "";',
    replace: '    const seenDeployment = typeof returnedDeployment === "string" ? returnedDeployment.trim() : pinnedDeployment; /* MUTANT */',
  },
];

// ---------- 実行器 ----------

const TEST_FILES = (await readdir(join(ROOT, "test")))
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => `test/${f}`);
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** tsc → node --test。tsc が赤なら「build」で止まったことを区別して返す。 */
async function buildAndTest() {
  const build = await run(TSC, []);
  if (build.code !== 0) return { code: build.code, fail: "build", failed: [], stage: "build" };
  const t = await run("node", ["--test", ...TEST_FILES]);
  const fail = /^# fail (\d+)$/m.exec(t.out)?.[1] ?? /ℹ fail (\d+)/.exec(t.out)?.[1] ?? "?";
  const failed = [...t.out.matchAll(/^ {0,4}✖ (.+?) \(/gm)].map((m) => m[1]);
  return { code: t.code, fail, failed: [...new Set(failed)], stage: "test" };
}

async function countMutantMarkers() {
  let n = 0;
  for (const f of [PAY, SUB, X402, SHAPES]) n += (await readFile(join(ROOT, f), "utf8")).split("MUTANT").length - 1;
  return n;
}

function pad(s, w) {
  // 全角は2幅として揃える（表を等幅で読めるように）。
  const width = [...String(s)].reduce((a, c) => a + (/[^\x00-\x7f]/.test(c) ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, w - width));
}

const t0 = Date.now();

if ((await countMutantMarkers()) !== 0) {
  console.error("src に MUTANT マーカーが残っている。前回の復元が失敗している。`git diff src` を見ること。");
  process.exit(2);
}

const baseline = await buildAndTest();
if (baseline.code !== 0) {
  console.error(`baseline is not green (stage ${baseline.stage}, fail ${baseline.fail}) — refusing to mutate.`);
  process.exit(2);
}
console.log(`baseline: green (fail ${baseline.fail})\n`);

const rows = [];
let survived = 0;
for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = await readFile(path, "utf8");
  const edits = m.edits ?? [{ find: m.find, replace: m.replace }];
  let mutated = original;
  let stale = null;
  for (const e of edits) {
    if (!e.replace.includes("MUTANT")) {
      stale = `replace lacks MUTANT marker`;
      break;
    }
    const n = mutated.split(e.find).length - 1;
    if (n !== 1) {
      stale = `anchor found ${n} times (need exactly 1): ${e.find.split("\n")[0].trim()}`;
      break;
    }
    mutated = mutated.replace(e.find, e.replace);
  }
  if (stale) {
    survived += 1;
    rows.push({ ...m, fail: "-", verdict: "STALE", failed: [], note: stale });
    continue;
  }
  try {
    await writeFile(path, mutated);
    const r = await buildAndTest();
    const killed = r.code !== 0;
    if (!killed) survived += 1;
    rows.push({
      ...m,
      fail: r.fail,
      verdict: killed ? (r.stage === "build" ? "KILLED (build)" : "KILLED") : "SURVIVED",
      failed: r.failed,
    });
  } finally {
    // **必ず戻す。** 戻せなければ、それ自体を大声で言う。
    await writeFile(path, original);
    if ((await readFile(path, "utf8")) !== original) {
      console.error(`RESTORE FAILED for ${m.file} at ${m.id}`);
      process.exit(3);
    }
  }
}

// ---------- 表 ----------
const W = { id: 4, what: 66, rule: 46, fail: 7 };
console.log(`${pad("#", W.id)} | ${pad("変異", W.what)} | ${pad("壊した規則", W.rule)} | ${pad("fail 数", W.fail)} | KILLED/SURVIVED`);
console.log(`${"-".repeat(W.id)}-|-${"-".repeat(W.what)}-|-${"-".repeat(W.rule)}-|-${"-".repeat(W.fail)}-|----------------`);
for (const r of rows) {
  console.log(`${pad(r.id, W.id)} | ${pad(r.what, W.what)} | ${pad(r.rule, W.rule)} | ${pad(r.fail, W.fail)} | ${r.verdict}`);
}
console.log("");
for (const r of rows) {
  if (r.verdict === "KILLED" && r.failed.length > 0) {
    console.log(`${r.id}  ${r.file}  ✖ ${r.failed.slice(0, 3).join(" / ")}${r.failed.length > 3 ? ` … +${r.failed.length - 3}` : ""}`);
  } else if (r.verdict === "SURVIVED") {
    console.log(`${r.id}  ${r.file}  SURVIVED ← この規則はテストに守られていない。消さずに報告する`);
  } else if (r.verdict === "STALE") {
    console.log(`${r.id}  ${r.file}  STALE ← ${r.note}`);
  } else if (r.verdict === "KILLED (build)") {
    console.log(`${r.id}  ${r.file}  tsc が落とした（テストではなく型が殺した——変異の書き方を見直す）`);
  }
}
console.log("");

// ---------- 復元の確認 ----------
const leftover = await countMutantMarkers();
if (leftover !== 0) {
  console.error(`RESTORE FAILED — ${leftover} MUTANT marker(s) remain in src. Check \`git diff src\`.`);
  process.exit(3);
}
const after = await buildAndTest();
if (after.code !== 0) {
  console.error(`RESTORE FAILED — the tree is not green after restoring (stage ${after.stage}, fail ${after.fail}).`);
  process.exit(3);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`restored: green (fail ${after.fail}) — MUTANT markers in src: 0`);
console.log(
  survived === 0
    ? `all ${rows.length} mutations killed in ${secs}s`
    : `${survived} of ${rows.length} mutation(s) survived (or stale) in ${secs}s`,
);
process.exitCode = survived === 0 ? 0 : 1;

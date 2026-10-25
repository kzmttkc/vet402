#!/usr/bin/env node
/**
 * Circle Gateway on Arc. One broken gate at a time. A mutation that stays green is a survivor.
 *
 *   node scripts/test-mutations-arc-gateway.mjs --no-db
 *   TEST_DATABASE_URL=postgres://localhost/<test db> node scripts/test-mutations-arc-gateway.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = "src/lib/observatory/arc-gateway.ts";
const VERIFY = "src/lib/observatory/arc-gateway-verify.ts";
const BUDGET = "src/lib/observatory/budget.ts";
const RUNNER = "src/lib/observatory/l1-runner.ts";
const FUNDS = "src/lib/observatory/payer-funds.ts";
const RECOVER = "src/lib/settlements/recover-late.ts";
const SOURCE = "src/lib/observatory/settlement-source.ts";
const VERIFIER = "src/lib/observatory/settlement-verifier.ts";
const READER = "src/lib/observatory/reader.ts";
const ROOT_SRC = "src/lib/observatory/arc-gateway-root.ts";
const WORDS = "src/lib/observatory/arc-gateway-words.ts";
const LEDGER = "ops/arc-gateway/DeliveryLedger.sol";
const ANCHOR = "scripts/arc-gateway-anchor.mjs";
const SOURCES = [GATEWAY, VERIFY, BUDGET, RUNNER, FUNDS, RECOVER, SOURCE, VERIFIER, READER, ROOT_SRC, WORDS, LEDGER, ANCHOR];

const UNIT_TESTS = ["tests/arc-gateway.test.ts", "tests/l1-chain-daily-cap.test.ts"];
const DB_TESTS = ["tests/l1-arc-gateway-lane.pg.test.ts"];

const MUTATIONS = [
  {
    id: "G01",
    what: "旗が空でも Gateway を有効にする",
    rule: "OBSERVATORY_ARC_GATEWAY_L1_ENABLED が \"true\" のときだけ",
    file: GATEWAY,
    find: 'return process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED === "true";',
    replace: "return /* MUTANT */ process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED !== undefined;",
  },
  {
    id: "G02",
    what: "残高が読めなくても足りる扱いにする",
    rule: "null や不足では署名しない",
    file: GATEWAY,
    find: "return available !== null && amount > 0n && available >= amount;",
    replace: "return /* MUTANT */ available === null || amount > 0n;",
  },
  {
    id: "G03",
    what: "別枠 0 でも開いている扱いにする",
    rule: "L1_ARC_GATEWAY_DAILY_CAP_USD=0 は止める",
    file: GATEWAY,
    find: 'return spent < chainDailyCapUnits("arc_gateway");',
    replace: 'return /* MUTANT */ spent <= chainDailyCapUnits("arc_gateway");',
  },
  {
    id: "G04",
    what: "ネイティブ Arc が署名できる出品も Gateway で選ぶ",
    rule: "ネイティブの accept がある出品は Gateway で払わない",
    file: GATEWAY,
    find: 'if (options.nativeArcSignable) return { accept: null, reason: "native_present" };',
    replace: 'if (/* MUTANT */ false) return { accept: null, reason: "native_present" };',
  },
  {
    id: "G05",
    what: "verifyingContract のピンを外す",
    rule: "GatewayWallet 0x7777…00ee 以外には署名しない",
    file: GATEWAY,
    find: "if (extra.verifyingContract.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return null;",
    replace: "if (/* MUTANT */ false) return null;",
  },
  {
    id: "G06",
    what: "Gateway の支出をネイティブ Arc の印で数える",
    rule: "二つの別枠は circleGatewayRail で分かれる",
    file: GATEWAY,
    find: "return sql`network = 'eip155:5042' AND raw_response_meta->>'circleGatewayRail' = 'true'`;",
    replace: "return sql`network = 'eip155:5042' AND /* MUTANT */ coalesce(raw_response_meta->>'x', '') = 'true'`;",
  },
  {
    id: "G07",
    what: "API の合計が無くても照合を進める",
    rule: "減額が読めなければ settled にも refute にもしない",
    file: VERIFY,
    find: 'if (input.debit === null) return "defer";',
    replace: 'if (/* MUTANT */ false) return "defer";',
  },
  {
    id: "G08",
    what: "減額が足りなくても settled にする",
    rule: "減額が行の合計より小さいときは refute",
    file: VERIFY,
    find: 'if (input.debit < input.rowSum) return "refute";',
    replace: 'if (/* MUTANT */ true) return "settle";',
  },
  {
    id: "G09",
    what: "請求が無い nonce を欠落扱いにしない",
    rule: "transfer が無い行は settled にしない",
    file: VERIFY,
    find: 'if (!hit) return { kind: "absent" };',
    replace: 'if (/* MUTANT */ false) return { kind: "absent" };',
  },
  {
    id: "G10",
    what: "Gateway の別枠の LIKE をワイルドカードにする",
    rule: "番兵は circle-gateway:5042 の完全一致",
    file: BUDGET,
    find: 'networkLike: "circle-gateway:5042"',
    replace: 'networkLike: /* MUTANT */ "eip155:%"',
  },
  {
    id: "G11",
    what: "eip155:5042 を Gateway の別枠として返す",
    rule: "cappedChainFor は arc のまま",
    file: BUDGET,
    find: 'if (network === "eip155:5042") return "arc";',
    replace: 'if (network === "eip155:5042") return /* MUTANT */ "arc_gateway";',
  },
  {
    id: "G12",
    what: "Gateway の残高をウォレット USDC の読みに落とす",
    rule: "arc_gateway は balanceOf で読まない",
    file: FUNDS,
    find: 'if (chain === "arc_gateway") throw new Error("arc_gateway_balance_is_not_wallet_usdc");',
    replace: 'if (/* MUTANT */ false) throw new Error("arc_gateway_balance_is_not_wallet_usdc");',
  },
  {
    id: "G13",
    what: "旗が off でもレーンを ready にする",
    rule: "旗 off なら Gateway の出品に 1 リクエストも出さない",
    file: RUNNER,
    find: '{ chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() },',
    replace: '{ chain: "arc_gateway", ready: /* MUTANT */ !!process.env.ARC_RPC_URL?.trim() },',
  },
  {
    id: "G14",
    what: "残高不足でも署名する",
    rule: "足りない・読めないなら署名しない",
    file: RUNNER,
    find: "if (!arcGatewayFundsOk(available, amount)) {",
    replace: "if (/* MUTANT */ false) {",
  },
  {
    id: "G15",
    what: "別枠を使い切ってもレーンを開いたままにする",
    rule: "支出が別枠以上なら Gateway を止める",
    file: RUNNER,
    find: "arcGatewayCapOpen(spentNow)",
    replace: "/* MUTANT */ true",
  },
  {
    id: "G16",
    what: "主候補から Gateway だけの出品を外さない",
    rule: "主候補は Gateway だけの Arc 出品を含めない",
    file: RUNNER,
    find: "extraWhere: SQL = gatewayPrimaryExclusionSql()",
    replace: "extraWhere: SQL = /* MUTANT */ sql``",
  },
  {
    id: "G17",
    what: "応答が無い Gateway の行を settle_claimed にする",
    rule: "応答なしは settle_failed",
    file: GATEWAY,
    find: 'if (paid === null) return "settle_failed"; // gateway_no_seller_response',
    replace: 'if (paid === null) return /* MUTANT */ "settle_claimed"; // gateway_no_seller_response',
  },
  {
    id: "G18",
    what: "売り手の名指した tx を行の tx_hash に写す",
    rule: "バッチ tx は tx_hash に置かない",
    file: RUNNER,
    find: "const claimedTx = isArcGateway ? null :",
    replace: "const claimedTx = isArcGateway ? /* MUTANT */ settlement?.transaction :",
  },
  {
    id: "G19",
    what: "ネイティブ Arc が署名できても Gateway を選ぶ",
    rule: "hasSignableNativeArcAccept が真なら Gateway で払わない",
    file: RUNNER,
    find: "nativeArcSignable: hasSignableNativeArcAccept(challenge.accepts)",
    replace: "nativeArcSignable: /* MUTANT */ false",
  },
  {
    id: "G20",
    what: "レーンが閉じていても Gateway の候補を取る",
    rule: "旗 off や別枠 0 では問い合わせない",
    file: RUNNER,
    find: 'if (!laneOpen("arc_gateway")) return [];',
    replace: "if (/* MUTANT */ false) return [];",
  },
  {
    id: "G21",
    what: "Gateway の取得にも Arc の除外を掛ける",
    rule: "ネイティブ Arc が止まっていても Gateway だけの出品は残す",
    file: RUNNER,
    find: 'const gatewayExclusions: SQL[] = laneExclusionChains.filter((x) => x.chain !== "arc")',
    replace: "const gatewayExclusions: SQL[] = laneExclusionChains.filter((x) => /* MUTANT */ true)",
  },
  {
    id: "G22",
    what: "遅延回収が Gateway の行をネイティブの着金に貼る",
    rule: "circleGatewayRail の行は回収の対象にしない",
    file: RECOVER,
    find: "AND coalesce(pu.raw_response_meta->>'circleGatewayRail', '') <> 'true'",
    replace: "AND /* MUTANT */ TRUE",
  },
  {
    id: "G23",
    what: "circle_gateway を tx 無しの NULL より後ろに置く",
    rule: "バッチ tx がある行は tx_hash が空でも circle_gateway",
    file: SOURCE,
    find: "THEN 'circle_gateway'",
    replace: "THEN /* MUTANT */ 'seller_claim'",
  },
  {
    id: "G24",
    what: "Gateway の照合結果を verified に足さない",
    rule: "請求が一致した行は verified に数える。scanned には数えない",
    file: VERIFIER,
    find: "summary.verified += gateway.settled;",
    replace: "summary.scanned += gateway.settled; /* MUTANT */",
  },
  {
    id: "G25",
    what: "公開の settlement_source に Gateway の印を渡さない",
    rule: "batchTx がある行の出どころは circle_gateway",
    file: READER,
    find: "settlementSourceOf({ txHash: rest.txHash, lateSettlement, circleGateway })",
    replace: "settlementSourceOf({ txHash: rest.txHash, lateSettlement }) /* MUTANT */",
  },
  {
    id: "G26",
    what: "旗 off の ready を DB のバッチでも通す",
    rule: "旗 off なら Gateway の出品に 1 リクエストも出さない",
    file: RUNNER,
    needsDb: true,
    find: '{ chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() },',
    replace: '{ chain: "arc_gateway", ready: /* MUTANT */ !!process.env.ARC_RPC_URL?.trim() },',
  },
  {
    id: "G27",
    what: "残高不足でも DB のバッチが署名する",
    rule: "足りない・読めないなら支払いヘッダを出さない",
    file: RUNNER,
    needsDb: true,
    find: "if (!arcGatewayFundsOk(available, amount)) {",
    replace: "if (/* MUTANT */ false) {",
  },
  {
    id: "G28",
    // 別枠 0 は選ぶ段（arcGatewayCapOpen）と laneOpen の2か所で閉じる。片方だけ開けても規則は破れないので、
    // 0 の読み取りそのもの（chainDailyCapUnits）を壊して両方を一度に開ける。
    what: "別枠 0 を既定 $2 と読み、DB のバッチが Gateway を開く",
    rule: "0 は 1 件も払わない",
    file: BUDGET,
    needsDb: true,
    find: "  let usd = cap.defaultUsd;\n  if (raw !== undefined && raw.trim() !== \"\") {\n    const n = Number(raw);\n    if (Number.isFinite(n) && n >= 0) usd = n;\n  }\n  usd = Math.min(usd, DAILY_BUDGET_USD);",
    replace: "  let usd = cap.defaultUsd;\n  if (raw !== undefined && raw.trim() !== \"\") {\n    const n = Number(raw);\n    if (Number.isFinite(n) && n > 0) usd = n; /* MUTANT */\n  }\n  usd = Math.min(usd, DAILY_BUDGET_USD);",
  },
  {
    id: "G29",
    what: "受領証がある Gateway の行をその場で settled にする",
    rule: "200 と受領証でも照合前は settle_claimed",
    file: GATEWAY,
    needsDb: true,
    find: 'if (claimedSettlement) return "settle_claimed"; // gateway_receipt_not_settled',
    replace: 'if (claimedSettlement) return /* MUTANT */ "settled"; // gateway_receipt_not_settled',
  },
  {
    id: "G30",
    what: "売り手の tx を tx_hash に写す（DB）",
    rule: "行の tx_hash は空",
    file: RUNNER,
    needsDb: true,
    find: "const claimedTx = isArcGateway ? null :",
    replace: "const claimedTx = isArcGateway ? /* MUTANT */ settlement?.transaction :",
  },
  {
    id: "G31",
    what: "長い timeout の accept を署名できる形にする",
    rule: "7日+100秒を超える maxTimeoutSeconds は拒否する",
    file: GATEWAY,
    find: "if (typeof rec.maxTimeoutSeconds === \"number\" && rec.maxTimeoutSeconds > ARC_GATEWAY_MAX_TIMEOUT_SECONDS) return null;",
    replace: "if (/* MUTANT */ false) return null;",
  },
  {
    id: "G32",
    what: "署名後の有効期限を検査しない",
    rule: "validBefore - now が上限を超えた署名は出さない",
    file: GATEWAY,
    find: 'if (!gatewayAuthWindowOk(authorization.validBefore, nowSec)) throw new Error("gateway_validity_window");',
    replace: "if (/* MUTANT */ false) throw new Error(\"gateway_validity_window\");",
  },
  {
    id: "G33",
    what: "カスタム署名の長い窓をそのまま送る",
    rule: "署名が返ったあとでも窓を検査し、外れたら行を残さない",
    file: RUNNER,
    needsDb: true,
    find: "if (!gatewayAuthWindowOk(gatewaySigned.authorization.validBefore, nowSec)) {",
    replace: "if (false && !gatewayAuthWindowOk(gatewaySigned.authorization.validBefore, nowSec)) { /* MUTANT */",
  },
  {
    id: "G34",
    what: "他チェーンで払える出品も Gateway で選ぶ",
    rule: "署名できる accept が他にあれば Gateway で払わない",
    file: GATEWAY,
    find: 'if (options.otherChainSignable) return { accept: null, reason: "native_present" };',
    replace: "if (/* MUTANT */ false) return { accept: null, reason: \"native_present\" };",
  },
  {
    id: "G35",
    what: "旗 off でも主候補から Gateway だけの出品を外す",
    rule: "旗 off の除外 SQL は空",
    file: GATEWAY,
    find: "if (!isArcGatewayL1Enabled()) return sql``;",
    replace: "if (/* MUTANT */ false) return sql``;",
  },
  {
    id: "G36",
    what: "硬上限超過を price_mismatch に潰す",
    rule: "上限を超える額は over_cap",
    file: GATEWAY,
    find: 'if (anyOverCap) return { accept: null, reason: "over_cap" };',
    replace: "if (/* MUTANT */ false) return { accept: null, reason: \"over_cap\" };",
  },
  {
    id: "G37",
    what: "残高 API の domain を外す",
    rule: "残高は Gateway API の domain 26 だけを読む",
    file: GATEWAY,
    find: 'body: JSON.stringify({ token: "USDC", sources: [{ depositor, domain: ARC_GATEWAY_DOMAIN }] })',
    replace: 'body: JSON.stringify({ token: "USDC", sources: [{ depositor }] }) /* MUTANT */',
  },
  {
    id: "G38",
    what: "402 でも受領証があれば settle_claimed にする",
    rule: "402 と 500 は settle_claimed にしない",
    file: GATEWAY,
    find: 'if (paid.status === 402 || paid.status >= 500) return "settle_failed"; // gateway_seller_refused',
    replace: "if (/* MUTANT */ false) return \"settle_failed\"; // gateway_seller_refused",
  },
  {
    id: "G39",
    what: "請求が無い期限切れを売り手の否認にする",
    rule: "gateway_not_charged_expired は refuted ではない",
    file: WORDS,
    find: 'export const GATEWAY_NOT_CHARGED_EXPIRED = "gateway_not_charged_expired";',
    replace: 'export const GATEWAY_NOT_CHARGED_EXPIRED = "settle_claim_refuted"; /* MUTANT */',
  },
  {
    id: "G40",
    what: "同じブロックの別の動きでも残高差で refute する",
    rule: "隔離できない残高差は defer",
    file: VERIFY,
    find: 'if (input.otherBuyerMovement) return { kind: "defer" };',
    replace: "if (/* MUTANT */ false) return { kind: \"defer\" };",
  },
  {
    id: "G41",
    what: "Gateway API の fetch からタイムアウトを外す",
    rule: "応答しない API でもネイティブの照合へ進む",
    file: VERIFY,
    needsDb: true,
    find: "const signal = AbortSignal.timeout(budget);",
    replace: "const signal = /* MUTANT */ undefined;",
  },
  {
    id: "G42",
    what: "calldata の請求額を捨てて残高差へ落とす",
    rule: "decode できた請求額はそのまま使う",
    file: VERIFY,
    find: 'if (decoded.kind === "amount") return decoded;',
    replace: "if (/* MUTANT */ false && decoded.kind === \"amount\") return decoded;",
  },
  {
    id: "G43",
    what: "残高が増えていても請求額にする",
    rule: "負の残高差は defer",
    file: VERIFY,
    find: 'if (read.kind === "use_balance" && balanceDelta !== null && balanceDelta >= 0n) return balanceDelta;',
    replace: "if (read.kind === \"use_balance\" && balanceDelta !== null) return balanceDelta; /* MUTANT */",
  },
  {
    id: "G44",
    what: "同じ購入元の未照合行を無視して settled にする",
    rule: "未読の行か、止めた購入元があれば settle しない",
    file: VERIFY,
    find: "const unresolved = loaded.unresolved > 0 || buyersBlocked.has(buyer);",
    replace: "const unresolved = /* MUTANT */ false;",
  },
  {
    id: "G45",
    what: "delivered_no_receipt を照合の対象から外す",
    rule: "署名済みの delivered_no_receipt も請求が一致したら settled",
    file: VERIFY,
    needsDb: true,
    find: "AND pu.status IN ('settle_claimed', 'settle_failed', 'delivered_no_receipt', 'settle_claimed_unverifiable')",
    replace: "AND pu.status IN ('settle_claimed', 'settle_failed', 'settle_claimed_unverifiable') /* MUTANT */",
  },
  {
    id: "G46",
    what: "名指しの Gateway だけの出品を候補から外したままにする",
    rule: "旗 on の onlyEndpointId はその 1 件を買える",
    file: RUNNER,
    needsDb: true,
    find: 'if (onlyEndpointId && isArcGatewayL1Enabled() && laneSelectable.get("arc_gateway") === true) {',
    replace: 'if (false && onlyEndpointId && isArcGatewayL1Enabled() && laneSelectable.get("arc_gateway") === true) { /* MUTANT */',
  },
  {
    id: "G47",
    what: "Gateway 残高の読み失敗を捨てる",
    rule: "読めないことはログに残す",
    file: RUNNER,
    needsDb: true,
    find: 'logServerErrorSafe("observatory.l1.arc_gateway_balance", error);',
    replace: "/* MUTANT */ void error;",
  },
  {
    id: "G48",
    what: "Gateway の保留件数を summary に出さない",
    rule: "deferred と noted は summary に残る",
    file: VERIFIER,
    find: "summary.gatewayDeferred = gateway.deferred;",
    replace: "summary.deferred += gateway.deferred; /* MUTANT */",
  },
  {
    id: "G49",
    what: "recorder 0x0 の DeliveryLedger を許す",
    rule: "constructor は 0x0 を revert する",
    file: LEDGER,
    find: "if (recorder_ == address(0)) revert ZeroRecorder();",
    replace: "if (false && recorder_ == address(0)) revert ZeroRecorder(); /* MUTANT */",
  },
  {
    id: "G50",
    what: "delivered が purchases を超えても anchor する",
    rule: "delivered <= purchases",
    file: LEDGER,
    find: "if (delivered > purchases) revert DeliveredExceedsPurchases();",
    replace: "if (false && delivered > purchases) revert DeliveredExceedsPurchases(); /* MUTANT */",
  },
  {
    id: "G51",
    what: "ハッシュが欠けた日でも root を出す",
    rule: "欠落があればファイルを出さない",
    file: ROOT_SRC,
    find: 'return { ok: false, reason: "missing_hash" };',
    replace: "return { ok: true, document: { day, root: \"0x\" + \"ab\".repeat(32), purchases: 0, delivered: 0, records: [] } }; /* MUTANT */",
  },
  {
    id: "G52",
    what: "recorder と購入元が同じアドレスでも続ける",
    rule: "公開アドレスが一致したら止める",
    file: ANCHOR,
    find: "if (recorderAddress === payerAddress) {",
    replace: "if (false && recorderAddress === payerAddress) { /* MUTANT */",
  },
  {
    id: "G53",
    what: "一致した減額を settled にしない",
    rule: "減額と行の合計が同じときだけ settled",
    file: VERIFY,
    find: 'if (input.debit === input.rowSum) return "settle";',
    replace: 'if (/* MUTANT */ false) return "settle";',
  },
  {
    id: "G54",
    what: "減額が行より大きくても refute する",
    rule: "大きい減額は defer",
    file: VERIFY,
    find: 'if (input.debit > input.rowSum) return "defer";',
    replace: 'if (/* MUTANT */ false) return "defer";',
  },
  {
    id: "G55",
    what: "pending も期限切れにする",
    rule: "期限切れは absent と failed だけ",
    file: VERIFY,
    find: 'const expires = hit.kind !== "pending" && pastGrace(auth, nowSec);',
    replace: "const expires = pastGrace(auth, nowSec); /* MUTANT */",
  },
  {
    id: "G56",
    what: "予算切れを購入元のエラーとして扱う",
    rule: "予算切れは次の回に続きを読む",
    file: VERIFY,
    find: 'if (lookup.reason === "budget") break;',
    replace: 'if (lookup.reason === "budget") { buyersBlocked.add(buyer); continue; } /* MUTANT */',
  },
  {
    id: "G57",
    what: "照会の記録に失敗した購入元を settle の条件から外す",
    rule: "remember に失敗した購入元は同額でも settle しない",
    file: VERIFY,
    find: "const unresolved = loaded.unresolved > 0 || buyersBlocked.has(buyer);",
    replace: "const unresolved = loaded.unresolved > 0; /* MUTANT */",
  },
  {
    id: "G58",
    what: "Gateway の読み予算を 8 秒に戻す",
    rule: "読み予算は 75 秒",
    file: VERIFY,
    find: "export const GATEWAY_RECONCILE_BUDGET_MS = 75_000;",
    replace: "export const GATEWAY_RECONCILE_BUDGET_MS = 8_000; /* MUTANT */",
  },
  {
    id: "G59",
    what: "75 秒の枠まで来ても 8 秒しか読まない",
    rule: "cron の残りが足りるときは 75 秒読む",
    file: VERIFY,
    find: "if (room >= GATEWAY_RECONCILE_BUDGET_MS) return GATEWAY_RECONCILE_BUDGET_MS;",
    replace: "if (room >= GATEWAY_RECONCILE_BUDGET_MS) return 8_000; /* MUTANT */",
  },
  {
    id: "G60",
    what: "短い予算でネイティブの 8 秒を食う",
    rule: "20 秒の照合では Gateway の読みを縮めて 8 秒を残す",
    file: VERIFY,
    find: "return Math.max(0, Math.min(GATEWAY_FETCH_TIMEOUT_MS, outerRemainingMs - NATIVE_VERIFY_FLOOR_MS));",
    replace: "return /* MUTANT */ outerRemainingMs;",
  },
  {
    id: "G61",
    what: "読み予算が切れたら判定済みの書き込みを捨てる",
    rule: "判定が終わった行は予算の外で書く",
    file: VERIFY,
    needsDb: true,
    find: `  for (const plan of plans) {
    if (plan.action === "defer") {
      summary.deferred++;
      if (plan.reason === "gateway_debit_exceeds_rows") summary.overDebit++;`,
    replace: `  for (const plan of plans) {
    if (options?.deadline?.expired()) break; /* MUTANT */
    if (plan.action === "defer") {
      summary.deferred++;
      if (plan.reason === "gateway_debit_exceeds_rows") summary.overDebit++;`,
  },
  {
    id: "G62",
    what: "大きい減額を summary に出さない",
    rule: "overDebit は summary に残る",
    file: VERIFY,
    needsDb: true,
    find: 'if (plan.reason === "gateway_debit_exceeds_rows") summary.overDebit++;',
    replace: "if (plan.reason === \"gateway_debit_exceeds_rows\") summary.deferred += 0; /* MUTANT */",
  },
  {
    id: "G63",
    what: "空の nonce より古い pending を先に読む",
    rule: "nonce 未取得の行が limit の先頭に来る",
    file: VERIFY,
    needsDb: true,
    find: "AND coalesce(pu.raw_response_meta->'circleGateway'->>'nonceLookup', '') = '' /* unread queue */",
    replace: "AND true /* MUTANT unread queue */",
  },
  {
    id: "G64",
    what: "期限切れの件数を summary から消す",
    rule: "expired は照合の summary に出る",
    file: VERIFIER,
    needsDb: true,
    find: "summary.gatewayExpired = gateway.expired;",
    replace: "summary.gatewayExpired = 0; /* MUTANT */",
  },
  {
    id: "G65",
    what: "大きい減額の件数を照合 summary から消す",
    rule: "overDebit は照合の summary に出る",
    file: VERIFIER,
    needsDb: true,
    find: "summary.gatewayOverDebit = gateway.overDebit;",
    replace: "summary.gatewayOverDebit = 0; /* MUTANT */",
  },
  {
    id: "G66",
    what: "Gateway の読みを常に 8 秒で切る",
    rule: "照合は gatewayReadBudgetMs の長さだけ読む",
    file: VERIFIER,
    find: "createDeadline(gatewayReadBudgetMs(deadline.remaining()))",
    replace: "createDeadline(/* MUTANT */ Math.min(8_000, deadline.remaining()))",
  },
  {
    id: "G67",
    what: "recorder か購入元が空でもアンカーを続ける",
    rule: "どちらかが空なら止める",
    file: ANCHOR,
    find: 'if (recorderAddress === "" || payerAddress === "") {',
    replace: 'if (false && (recorderAddress === "" || payerAddress === "")) { /* MUTANT */',
  },
  {
    id: "G68",
    what: "Stellar のどの資産でも署名できる扱いにする",
    rule: "Stellar で署名できるのは USDC だけ",
    file: GATEWAY,
    find: 'if (stellarRailConfigured() && network === "stellar:pubnet" && (asset === STELLAR_USDC_CLASSIC || asset === STELLAR_USDC_SAC)) return true;',
    replace: 'if (stellarRailConfigured() && network === "stellar:pubnet") return true; /* MUTANT */',
  },
  {
    id: "G69",
    what: "Stellar の SAC USDC を SQL の署名対象から外す",
    rule: "classic と SAC の両方を署名できる accept と数える",
    file: GATEWAY,
    find: "OR o->>'asset' = '${STELLAR_USDC_SAC}'",
    replace: "OR o->>'asset' = 'XLM' /* MUTANT */",
  },
  {
    id: "G70",
    what: "署名時刻とブロック時刻の比較を逆にする",
    rule: "ブロック時刻より後に署名した未照会はバッチを止めない",
    file: VERIFY,
    find: "return signatureTimeSec <= blockTimeSec - BigInt(GATEWAY_BATCH_CLOCK_SKEW_SECONDS);",
    replace: "return signatureTimeSec >= blockTimeSec - BigInt(GATEWAY_BATCH_CLOCK_SKEW_SECONDS); /* MUTANT */",
  },
  {
    id: "G71",
    what: "署名時刻とブロック時刻の余裕を 0 にする",
    rule: "比較の余裕は 60 秒",
    file: VERIFY,
    find: "export const GATEWAY_BATCH_CLOCK_SKEW_SECONDS = 60;",
    replace: "export const GATEWAY_BATCH_CLOCK_SKEW_SECONDS = 0; /* MUTANT */",
  },
  {
    id: "G72",
    what: "未照会が 1 件でもあればバッチを止める",
    rule: "ブロック時刻より後に署名した未照会はバッチを止めない",
    file: VERIFY,
    find: "unresolvedCount = unreadAuthorizationCanEnterBatch(signatureTime, blockTime) ? 1 : 0;",
    replace: "unresolvedCount = 1; /* MUTANT */",
  },
  {
    id: "G73",
    what: "Gateway の読み件数を 200 に戻す",
    rule: "Gateway の limit は 1 日 1500 行を 1 回で読む",
    file: VERIFY,
    needsDb: true,
    find: "export const GATEWAY_RECONCILE_ROW_LIMIT = 2_000;",
    replace: "export const GATEWAY_RECONCILE_ROW_LIMIT = 200; /* MUTANT */",
  },
  {
    id: "G74",
    what: "照会済みの読み直し枠を 0 にする",
    rule: "未照会が残っていても照会済みの行を読み直す",
    file: VERIFY,
    needsDb: true,
    find: "export const GATEWAY_REREAD_SHARE_NUMERATOR = 1;",
    replace: "export const GATEWAY_REREAD_SHARE_NUMERATOR = 0; /* MUTANT */",
  },
  {
    id: "G75",
    what: "gateway_api_error を購入元の停止に戻す",
    rule: "API の 5xx 1 回で、失敗より前のバッチまで settle を 0 にしない",
    file: VERIFY,
    needsDb: true,
    find: `      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_api_error" });
      continue;`,
    replace: `      plans.set(row.id, { id: row.id, action: "defer", reason: "gateway_api_error" });
      buyersBlocked.add(buyer); /* MUTANT */
      continue;`,
  },
];

const NO_DB = process.argv.includes("--no-db");
const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function summarize(t) {
  const fail = /^ℹ fail (\d+)$/m.exec(t.out)?.[1] ?? "?";
  const failed = [...t.out.matchAll(/^ {0,4}✖ (.+?) \(/gm)].map((m) => m[1]);
  return { code: t.code, fail, failed: [...new Set(failed)], out: t.out };
}

async function unitTests() {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  return summarize(await run(TSX, ["--test", ...UNIT_TESTS], env));
}

async function dbTests() {
  return summarize(await run(TSX, ["--test", "--test-force-exit", "--test-concurrency=1", ...DB_TESTS], process.env));
}

async function testFor(needsDb) {
  if (needsDb) return { ...(await dbTests()), suite: "db" };
  return { ...(await unitTests()), suite: "unit" };
}

async function countMutantMarkers() {
  let n = 0;
  for (const f of SOURCES) n += (await readFile(join(ROOT, f), "utf8")).split("MUTANT").length - 1;
  return n;
}

function pad(s, w) {
  const width = [...String(s)].reduce((a, c) => a + (/[^\x00-\x7f]/.test(c) ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, w - width));
}

const t0 = Date.now();

if ((await countMutantMarkers()) !== 0) {
  console.error("src に MUTANT マーカーが残っている。前回の復元が失敗している。`git diff src` を見ること。");
  process.exit(2);
}

const baselineUnit = await unitTests();
if (baselineUnit.code !== 0) {
  console.error(`baseline (unit) is not green (fail ${baselineUnit.fail}) — refusing to mutate.`);
  console.error(baselineUnit.failed.join("\n"));
  console.error(baselineUnit.out?.slice(-4000) ?? "");
  process.exit(2);
}
let baselineDb = null;
if (HAS_DB) {
  baselineDb = await dbTests();
  if (baselineDb.code !== 0) {
    console.error(`baseline (db) is not green (fail ${baselineDb.fail}) — refusing to mutate.`);
    console.error(baselineDb.failed.join("\n"));
    process.exit(2);
  }
}
console.log(`baseline: green (unit fail ${baselineUnit.fail}${baselineDb ? `, db fail ${baselineDb.fail}` : ", db not run — TEST_DATABASE_URL is not set"})\n`);

const rows = [];
let survived = 0;
let notRun = 0;
for (const m of MUTATIONS) {
  if (m.needsDb && !HAS_DB) {
    notRun += 1;
    rows.push({ ...m, fail: "-", verdict: "NOT RUN", failed: [], note: "needs TEST_DATABASE_URL" });
    continue;
  }
  const path = join(ROOT, m.file);
  const original = await readFile(path, "utf8");
  let stale = null;
  if (!m.replace.includes("MUTANT")) stale = "replace lacks MUTANT marker";
  const n = original.split(m.find).length - 1;
  if (!stale && n !== 1) stale = `anchor found ${n} times (need exactly 1): ${m.find.split("\n")[0].trim()}`;
  if (stale) {
    rows.push({ ...m, fail: "-", verdict: "STALE", failed: [], note: stale });
    survived += 1;
    continue;
  }
  await writeFile(path, original.replace(m.find, m.replace));
  let result;
  try {
    result = await testFor(m.needsDb);
  } finally {
    await writeFile(path, original);
  }
  const killed = result.code !== 0;
  const verdict = killed ? "KILLED" : "SURVIVED";
  if (!killed) survived += 1;
  rows.push({ ...m, fail: result.fail, verdict, failed: result.failed, note: result.suite });
}

if ((await countMutantMarkers()) !== 0) {
  console.error("復元後に MUTANT マーカーが残っている。");
  process.exit(2);
}

console.log(`${pad("id", 5)} ${pad("verdict", 10)} ${pad("fail", 6)} ${pad("what", 56)} rule`);
console.log("-".repeat(120));
for (const r of rows) {
  console.log(`${pad(r.id, 5)} ${pad(r.verdict, 10)} ${pad(r.fail, 6)} ${pad(r.what, 56)} ${r.rule}`);
  if (r.note && r.verdict !== "KILLED") console.log(`      ${r.note}`);
}

const killed = rows.filter((r) => r.verdict === "KILLED").length;
const stale = rows.filter((r) => r.verdict === "STALE").length;
console.log(
  `\n${killed} KILLED / ${survived} SURVIVED+STALE / ${notRun} NOT RUN  (${((Date.now() - t0) / 1000).toFixed(1)}s)${NO_DB ? "  [--no-db]" : ""}`,
);
if (stale) console.log(`${stale} STALE (anchor missing or duplicated).`);
if (notRun && !NO_DB) {
  console.log("DB mutations were not run. Pass TEST_DATABASE_URL or --no-db to skip them on purpose.");
  process.exit(1);
}
process.exit(survived === 0 && (NO_DB || notRun === 0) ? 0 : 1);

// @vet402/mcp-server — tool contract (node:test).
//
// Two things this package promises the model, neither of which had a test:
//
//   1. every tool reports a failure as `isError: true` with a SANITIZED
//      message. A tool that swallowed an error into a normal text result
//      would read to the model as an answer — the worst possible failure mode
//      for a tool whose answers gate payments;
//   2. `check_payee_trust` tells the model that `degraded` / `signalsUnavailable`
//      outrank the recommendation (2026-08-22 audit: it did not).
//
// (1) is checked STRUCTURALLY against src/index.ts with the TypeScript
// compiler API rather than by importing it: importing index.ts calls `main()`
// at load, which connects a stdio transport and would never let the test
// process exit. AST over source is also immune to reformatting, unlike a
// regex over the file body.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  KNOWN_ERROR_CODES,
  LOOKUP_TIMEOUT_MESSAGE,
  sanitizeToolError,
} from "../dist/tool-errors.js";
import { VouchApiError } from "../dist/vouch-client.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------- sanitizeToolError ----------------

test("a known API code passes through unchanged", () => {
  for (const code of KNOWN_ERROR_CODES) {
    assert.equal(sanitizeToolError(new Error(code)), code);
  }
});

test("an unknown error collapses to request_failed — nothing leaks", () => {
  const leaky = new Error(
    "connect ECONNREFUSED 10.0.0.5:5432 while calling https://x/?key=vouch_live_secret",
  );
  assert.equal(sanitizeToolError(leaky), "request_failed");
  assert.equal(sanitizeToolError("a bare string"), "request_failed");
  assert.equal(sanitizeToolError(undefined), "request_failed");
  assert.equal(sanitizeToolError({ message: "invalid_api_key" }), "request_failed");
});

test("a VouchApiError reason is appended to the code", () => {
  const error = new VouchApiError("attestation_unverifiable", "tx not found on chain");
  assert.equal(
    sanitizeToolError(error),
    "attestation_unverifiable: tx not found on chain",
  );
});

test("a timeout is named, not flattened into request_failed", () => {
  // The model's correct move differs: request_failed reads as "stop repeating
  // this", a timeout as "the upstream may answer on retry". Either way the
  // payee was NOT vetted, which the message says out loud.
  const timeout = new DOMException("The operation timed out.", "TimeoutError");
  assert.equal(sanitizeToolError(timeout), LOOKUP_TIMEOUT_MESSAGE);
  const aborted = new DOMException("Aborted.", "AbortError");
  assert.equal(sanitizeToolError(aborted), LOOKUP_TIMEOUT_MESSAGE);
  assert.match(LOOKUP_TIMEOUT_MESSAGE, /NOT checked/);
});

// ---------------- structural tool contract ----------------

/** Every `server.tool(name, description, schema, handler)` call in index.ts. */
function registeredTools() {
  const file = join(PKG, "src/index.ts");
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const tools = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.getText(sf) === "tool"
    ) {
      const [nameArg, descriptionArg, , handlerArg] = node.arguments;
      tools.push({
        name: nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : null,
        // The description may be a string literal or a joined array of them;
        // the raw text is enough to assert on its content either way.
        description: descriptionArg ? descriptionArg.getText(sf) : "",
        handler: handlerArg,
        sf,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return tools;
}

test("the AST actually found the tools (no vacuous pass)", () => {
  const names = registeredTools().map((t) => t.name);
  assert.deepEqual(names.sort(), [
    "attest_x402_payment",
    "check_agent_trust",
    "check_payee_trust",
    // 製品定義書 §9.1（2026-09-02）: 新規統合は /decision を正規とする
    "check_resource_decision",
    "check_wallet_trust",
    "explain_trust_score",
    // ETHOnline 2026 / WINDOW_PLAN §2 #2: 判定を返すだけでなく signer を握る唯一のツール
    "pay_if_trusted",
  ]);
});

test("every tool reports failures as isError with a sanitized message", () => {
  for (const tool of registeredTools()) {
    const { handler, sf, name } = tool;
    assert.ok(handler, `${name}: no handler argument`);

    let catchClause = null;
    const findCatch = (node) => {
      if (ts.isCatchClause(node) && catchClause === null) catchClause = node;
      ts.forEachChild(node, findCatch);
    };
    ts.forEachChild(handler, findCatch);
    assert.ok(
      catchClause,
      `${name}: the handler has no catch — a thrown lookup would surface as a ` +
        "protocol error instead of a tool result the model can act on",
    );

    // 2026-08-23: catch の中身を直に見る形から、**どこかで** isError と
    // サニタイズが効いていることを見る形へ。スコア系3ツールは共有ヘルパ
    // scoreToolFailure() に降りたので、リテラルの照合では偽陽性になる。
    // 守りたい不変条件は「失敗が答えに見えないこと」で、書き方ではない。
    const body = catchClause.block.getText(sf);
    const viaHelper = /scoreToolFailure\(/.test(body);
    if (!viaHelper) {
      assert.match(
        body,
        /isError:\s*true/,
        `${name}: the catch block does not set isError: true — the model would ` +
          "read the failure as an answer",
      );
      assert.match(
        body,
        /sanitizeToolError\(/,
        `${name}: the catch block does not sanitize the error before returning it`,
      );
    }
  }
});

test("スコア系ツールは判定を型で返す（散文の約束に依存しない）", () => {
  // 2026-08-23 監査で契約を強くした。以前はここで「説明文が degraded は
  // recommendation より優先すると**言っている**か」を検査していた。だが散文は
  // モデルが無視できる。SDK の SpendGuard は同じ規律を型と分岐で強制していたのに、
  // エージェント統合の主経路である MCP だけが読解に依存していた。
  // いまの契約は decision / safe_to_pay というフィールドで、説明文は補助。
  // 判定そのものの不変条件は test/decision.test.mjs が固定する。
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /scoreToolResult\(/, "構造化判定を通さずに応答を返している");
  assert.match(src, /decideFromScore/, "判定関数が使われていない");

  for (const name of ["check_payee_trust", "check_agent_trust", "check_wallet_trust"]) {
    const tool = registeredTools().find((t) => t.name === name);
    assert.ok(tool, `${name} is not registered`);
    assert.match(tool.description, /decision/, `${name}: 説明が decision を指していない`);
    assert.match(tool.description, /safe_to_pay/, `${name}: 説明が safe_to_pay を指していない`);
    assert.match(
      tool.description,
      /no answer is not an ALLOW/i,
      `${name}: 沈黙が ALLOW でないことを言っていない`,
    );
  }
});

// ---------------- evidence[].source (ETHOnline 2026 / WINDOW_PLAN §2 #3) ----------------
//
// 4 面パリティの MCP 面。`/decision` の evidence 行が「どの台帳の観測か」を名乗る
// ようになった以上、その行をそのままモデルへ渡す 2 本のツールは、値の意味を
// 説明文で名指ししなければならない。名前だけ渡して意味を伏せると、モデルは
// vet402 の台帳と The Graph の subgraph を同じ重みで足して読む——§3 の核
// （同じウォレットについて 2 つの源が違うことを言う）がいちばん要る場所で潰れる。
test("evidence[].source を返す 2 本のツールが、源の名前を説明文で名指ししている", () => {
  const src = readFileSync(join(PKG, "src/index.ts"), "utf8");
  const sf = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true);
  /** server.tool("name", <description>, …) の説明文を取り出す。 */
  const descriptions = new Map();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "tool" &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      descriptions.set(node.arguments[0].text, node.arguments[1].getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(descriptions.has("pay_if_trusted"), `AST がツールを拾えていない: ${[...descriptions.keys()].join(",")}`);
  for (const tool of ["check_resource_decision", "pay_if_trusted"]) {
    const text = descriptions.get(tool) ?? "";
    assert.match(text, /evidence\[\]/, `${tool} の説明が evidence[] に触れていない`);
    assert.match(text, /source/, `${tool} の説明が source に触れていない`);
    assert.match(text, /vet402/, `${tool} の説明が源の名前 vet402 を出していない`);
    assert.match(text, /subgraph/, `${tool} の説明が源の名前 subgraph を出していない`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerShapeOf } from "../src/lib/observatory/answer-shape";

const J = "application/json";

test("error bodies served with a 2xx (examples seen in the ledger, Oct 2026)", () => {
  assert.equal(answerShapeOf('{"error":"missing_agentId"}', J), "error_object");
  assert.equal(answerShapeOf('{"error":"missing \'symbol\', e.g. ?symbol=BTC&vs=USD"}', J), "error_object");
  assert.equal(answerShapeOf('{"error":"Reddit: 403","success":false}', J), "error_object");
  assert.equal(answerShapeOf('{"error":"endpoint deprecated","message":"Use GET /satellites/precision instead"}', J), "error_object");
  assert.equal(answerShapeOf('{"errors":[{"message":"bad"}],"code":400}', J), "error_object");
});

test("failure flags", () => {
  assert.equal(answerShapeOf('{"ok":false,"service":"abi","error":"query parameter `token` is required"}', J), "error_flag");
  assert.equal(answerShapeOf('{"status":"error","reason":"upstream timeout","items":[1]}', J), "error_flag");
  assert.equal(answerShapeOf('{"success":false,"data":{"a":1}}', J), "error_flag");
});

test("html pages and empty structures", () => {
  assert.equal(answerShapeOf("<!DOCTYPE html><html><head></head></html>", J), "html_page");
  assert.equal(answerShapeOf("<html lang=en><body>Example Domain</body></html>", "text/html"), "html_page");
  assert.equal(answerShapeOf("{}", J), "empty_structure");
  assert.equal(answerShapeOf("[]", J), "empty_structure");
  assert.equal(answerShapeOf('{"data":[]}', J), "empty_structure");
  assert.equal(answerShapeOf('{"result":[]}', J), "empty_structure");
  assert.equal(answerShapeOf('{"items":{}}', J), "empty_structure");
});

test("real answers are not flagged, even when they talk about errors or statuses", () => {
  // A status checker reporting on another site: the answer itself is the content.
  assert.equal(answerShapeOf('{"url":"https://example.com","status":200,"responseTimeMs":275,"tls":{"valid":true}}', J), null);
  assert.equal(answerShapeOf('{"results":[{"url":"https://onescales.com","statusCode":200,"isRedirect":false}]}', J), null);
  // An error key next to real content is not an error body.
  assert.equal(answerShapeOf('{"price":84378.32,"symbol":"BTC","error":null}', J), null);
  assert.equal(answerShapeOf('{"data":[1,2],"error":"partial"}', J), null);
  // A running job whose text mentions a timeout.
  assert.equal(answerShapeOf('{"sandbox_id":"sb-1","status":"running","timeout_s":60}', J), null);
  // Plain text and unparseable JSON are left to other checks.
  assert.equal(answerShapeOf("hello world", "text/plain"), null);
  assert.equal(answerShapeOf('{"a":', J), null);
  assert.equal(answerShapeOf("   ", J), null);
  // A number or a string answer is a value, not junk by shape.
  assert.equal(answerShapeOf("42", J), null);
  assert.equal(answerShapeOf('"BTC"', J), null);
});

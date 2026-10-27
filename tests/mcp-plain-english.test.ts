// ============================================================
// MCP の入口の英文の決まり（2026-10-28・要件書 v3 §0・合格の表 #14）。
//
// 全部の tool の title・description・入力欄の説明・サーバーの instructions・出力の固定文（src/lib/mcp/text.ts）に、
//   we / our / us、セミコロン、ダッシュ（\u2013 \u2014 と語の間の " - "）、", not X"
// が無いこと。言い方の禁止（第三者の確認・信用や格付けや監査や検証のサービス・売り手が壊れている）と、
// 名前を出さない相手（Kite・BlockRun）も見る。tools/list は route を実際に呼んで読む（文書と実装を分けない）。
// 断定語（daily・every・never・always・only …）は tests/claims-registry.test.ts が text.ts を公開面として走査する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;
process.env.PROXY_HEADER_SOURCE = "generic";

const RULES: { name: string; re: RegExp }[] = [
  { name: "we/our/us", re: /\b(we|our|us)\b/i },
  { name: "semicolon", re: /;/ },
  { name: "dash", re: /[\u2013\u2014]| - / },
  { name: ", not X", re: /,\s*not\b/i },
  { name: "third-party check before paying", re: /third[- ]party/i },
  { name: "trust / rating / audit / verification service", re: /\b(trust|trusted|rating|ratings|audit|audits|certif\w*|verification service)\b/i },
  { name: "seller is broken", re: /\bbroken\b/i },
  { name: "names not to use", re: /\b(kite|blockrun)\b/i },
];

function violations(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const r of RULES) if (r.re.test(t)) out.push(`[${r.name}] ${t}`);
  return out;
}

test("規則そのものが当たる（空集合で緑にならない）", () => {
  assert.equal(violations(["We pay"]).length, 1);
  assert.equal(violations(["a; b"]).length, 1);
  assert.equal(violations(["a \u2014 b", "a - b"]).length, 2);
  assert.equal(violations(["paid, not delivered"]).length, 1);
  assert.equal(violations(["status of the purchase"]).length, 0, "status の us は語ではない");
});

test("固定文（text.ts）の全部が決まりを守る", async () => {
  const { allFixedText } = await import("@/lib/mcp/text");
  const all = allFixedText();
  assert.ok(all.length >= 15, `固定文が少なすぎる: ${all.length}`);
  assert.deepEqual(violations(all), []);
});

test("tools/list の title・description・入力欄の説明と instructions が決まりを守る", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const { NextRequest } = await import("next/server");
  const send = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await POST(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": "192.0.2.9", ...headers },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text) as { result: Record<string, unknown> };
  };
  const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1.0.0" } } });
  const texts: string[] = [String(init.result.instructions ?? "")];
  assert.ok(texts[0].length > 0, "instructions が無い");
  const list = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-protocol-version": "2025-06-18" });
  const tools = list.result.tools as { title: string; description: string; annotations: { title: string }; inputSchema: { properties: Record<string, { description?: string }> } }[];
  for (const t of tools) {
    texts.push(t.title, t.description, t.annotations.title);
    for (const p of Object.values(t.inputSchema.properties)) if (p.description) texts.push(p.description);
  }
  assert.ok(texts.length >= 10);
  assert.deepEqual(violations(texts), []);
});

test("規則の文と disclaimer（セミコロン・ダッシュを含む）を MCP の文に写さない", async () => {
  const { allFixedText } = await import("@/lib/mcp/text");
  const { DECISION_DISCLAIMER } = await import("@/lib/decision/decide");
  const joined = allFixedText().join("\n");
  assert.ok(!joined.includes(DECISION_DISCLAIMER));
  assert.ok(!/L0\u2013L2/.test(joined));
});

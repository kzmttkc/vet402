// pay_if_trusted — payOrRefuse を MCP から呼べるようにしたもの（会期中の新規）。
// Day 0 は red のみ。正典は docs/ethonline-2026/WINDOW_PLAN.md §4 の 21。
//
// 既存の check_resource_decision（2026-09-02 出荷・読むだけ）との違いを、テストでも固定する:
// あちらは判定を返し、呼び手が自分で決める。こちらは signer を握り、通らなければ到達させない。
import test from "node:test";
import assert from "node:assert/strict";

let payIfTrusted;
try {
  ({ payIfTrusted } = await import("../src/pay-if-trusted.js"));
} catch {
  payIfTrusted = async () => { throw new Error("pay_if_trusted is not implemented yet — Day 0 red"); };
}

const watched = () => {
  const accessed = [];
  const signer = new Proxy({ address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get: (t, p) => (accessed.push(String(p)), Reflect.get(t, p)) });
  return { signer, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
};

test("G21a pay_if_trusted は ALLOW 以外で mock signer への参照が0", { todo: "MCP `pay_if_trusted`（WINDOW_PLAN §2 #2）が未実装。09-07 の作業。赤で置いた記録は commit 9196a28。" }, async () => {
  const w = watched();
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {}, evidence: [] }), headers: new Map() }) });
  assert.equal(r.decision, "REFUSE");
  assert.deepEqual(w.signAccesses(), []);
});

test("G21b pay_if_trusted は ALLOW で signer を1回だけ呼び attest する", { todo: "MCP `pay_if_trusted`（WINDOW_PLAN §2 #2）が未実装。09-07 の作業。赤で置いた記録は commit 9196a28。" }, async () => {
  const w = watched();
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer,
    fetch: async (u) => String(u).includes("decision")
      ? { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], facts: {}, evidence: [{ level: "L1", source: "vet402" }] }), headers: new Map() }
      : { ok: true, status: 200, json: async () => ({ success: true, transaction: "0xtx" }), headers: new Map() } });
  assert.equal(r.decision, "PAID");
  assert.equal(r.attested, true);
  assert.equal(w.signAccesses().length, 1);
});

test("G21c 応答に evidence[].source が入る（審査員が証拠源を目で追える）", { todo: "MCP `pay_if_trusted`（WINDOW_PLAN §2 #2）が未実装。09-07 の作業。赤で置いた記録は commit 9196a28。" }, async () => {
  const w = watched();
  const r = await payIfTrusted({ resourceId: "a".repeat(64), signer: w.signer,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ recommendation: "WARN", reason_codes: [], facts: {}, evidence: [{ level: "L1", source: "subgraph", subgraphId: "Cb56", block: { number: 1 } }] }), headers: new Map() }) });
  assert.ok(r.measurement.evidence.every((e) => typeof e.source === "string"));
});

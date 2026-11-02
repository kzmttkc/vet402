// ============================================================
// /tokyo の読み取りは viem の CCIP-Read を切る（2026-11-02 監査 M1）。
// 名前は呼び手が選ぶので、その名前のリゾルバが返す転送先へサーバから要求を出さない。
// 守ること: 転送先へは1本も出ない。切っても seller-a.eth は7段すべて読める。
// 「読める」は Sepolia の実物の応答（tests/fixtures/tokyo）の再生で固定する。チェーンへは出ない。
// ============================================================
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeErrorResult, numberToHex, parseAbi } from "viem";
import { resolveText } from "@vet402/sdk/ens";
import { readCheck, verifyClients } from "@/app/api/tokyo/_lib/check";

type Rpc = { id: number; method: string; params?: unknown[] };
const replay = JSON.parse(readFileSync("tests/fixtures/tokyo/seller-a-sepolia-replay.json", "utf8")) as {
  block: string;
  timestamp: number;
  rpc: Record<string, { result?: unknown; error?: unknown }>;
};

function rpcServer(answer: (q: Rpc) => Record<string, unknown>): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body) as Rpc | Rpc[];
      const one = (q: Rpc) => ({ jsonrpc: "2.0", id: q.id, ...answer(q) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m)));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })),
  );
}

const servers: http.Server[] = [];

after(() => servers.forEach((s) => s.close()));

let replayUrl = "";
before(async () => {
  const { url, server } = await rpcServer((q) => {
    if (q.method === "eth_blockNumber") return { result: numberToHex(BigInt(replay.block)) };
    const hit = replay.rpc[`${q.method}:${JSON.stringify(q.params)}`];
    return hit ?? { error: { code: -32000, message: `not recorded: ${q.method}` } };
  });
  replayUrl = url;
  servers.push(server);
});

test("seller-a.eth は CCIP-Read を切っても7段すべて読める（実物の応答の再生）", async () => {
  const now = mock.method(Date, "now", () => (replay.timestamp + 5) * 1000);
  try {
    const r = await readCheck("seller-a.eth", verifyClients({ primary: replayUrl, secondary: replayUrl }));
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.equal(r.ok, true, JSON.stringify(r.reasons));
    assert.deepEqual(r.trace.map((s) => s.status), Array(7).fill("ok"));
    assert.equal(r.amount, "10000");
    assert.equal(r.block, replay.block);
  } finally {
    now.mock.restore();
  }
});

test("リゾルバが OffchainLookup を返しても、転送先へ要求を出さない", async () => {
  const gatewayHits: string[] = [];
  const gateway = http.createServer((req, res) => {
    gatewayHits.push(`${req.method}`);
    res.end("x");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", () => resolve()));
  servers.push(gateway);
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/any`;
  const abi = parseAbi(["error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)"]);
  const { url, server } = await rpcServer((q) => {
    if (q.method === "eth_chainId") return { result: numberToHex(11155111) };
    if (q.method === "eth_call") {
      const to = (q.params?.[0] as { to: `0x${string}` }).to;
      const data = encodeErrorResult({ abi, errorName: "OffchainLookup", args: [to, [gatewayUrl], "0x1234", "0x12345678", "0x"] });
      return { error: { code: 3, message: "execution reverted", data } };
    }
    return { result: "0x1" };
  });
  servers.push(server);
  await resolveText(verifyClients({ primary: url, secondary: url }), 1n, "gateway-test.eth", "x402-offer").catch(() => {});
  assert.deepEqual(gatewayHits, []);
});

test("src/app/api/tokyo の読み取りクライアントは全部 ccipRead: false を持つ", () => {
  const dir = "src/app/api/tokyo";
  const files = readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => statSync(f).isFile() && /\.tsx?$/.test(f));
  let found = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/createPublicClient\(.*$/gm)) {
      found += 1;
      assert.match(m[0], /ccipRead:\s*false/, `${f}: ${m[0]}`);
    }
  }
  assert.ok(found >= 3, `クライアントが ${found} 本しか見つからない（walker が見えていない）`);
});

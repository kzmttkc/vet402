// ============================================================
// サーバログの伏字（2026-09-29 監査 第2巡の残り）。
//
// logServerError（凍結中の log.ts）は error.message を素で出す。viem の HttpRequestError は
// 本文に `URL: https://…/v2/<key>` を持つので、そのまま渡すと Vercel のログに実鍵が並ぶ。
// 凍結外の呼び手は logServerErrorSafe を通す——その伏字と、直呼びが戻ってこないことを見る。
// ============================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpRequestError } from "viem";
import { logAndSwallowSafe, logServerErrorSafe, redactSecretsForLog } from "@/lib/util/log-safe";

function captureConsoleError(fn: () => void | Promise<unknown>): Promise<string[]> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  return Promise.resolve()
    .then(fn)
    .then(() => logged)
    .finally(() => {
      console.error = orig;
    });
}

const SECRETS = ["ALCHEMYSECRET123", "INFURASECRET456", "QNTOKEN789abc", "DRPCKEY000", "APIKEYQUERY111", "PGPASSWORD222"];

test("logServerErrorSafe: viem の HttpRequestError（鍵入り RPC URL）を伏せて出す", async () => {
  const err = new HttpRequestError({
    url: "https://base-mainnet.g.alchemy.com/v2/ALCHEMYSECRET123",
    body: { method: "eth_getLogs", params: [] },
    status: 429,
    details: "Too Many Requests",
  });
  assert.ok(err.message.includes("ALCHEMYSECRET123"), "前提: viem のエラー本文は URL を含む");
  const logged = await captureConsoleError(() => logServerErrorSafe("settlements.index_evm", err));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes("ALCHEMYSECRET123"), false, logged[0]);
  assert.match(logged[0], /settlements\.index_evm/);
  assert.match(logged[0], /Status: 429/, "診断に要る部分は残す");
  assert.match(logged[0], /<url>/);
});

test("logServerErrorSafe: 各社の RPC URL・query の鍵・接続文字列・オブジェクト内の URL を伏せる", async () => {
  const text = [
    "infura https://mainnet.infura.io/v3/INFURASECRET456",
    "quicknode https://rough-lake.base-mainnet.quiknode.pro/QNTOKEN789abc/",
    "drpc https://lb.drpc.org/ogrpc?network=base&dkey=DRPCKEY000",
    "any https://rpc.example/?apikey=APIKEYQUERY111",
    "pg postgres://vouch:PGPASSWORD222@db.example:5432/vouch",
  ].join("\n");
  const fromString = await captureConsoleError(() => logServerErrorSafe("ctx", text));
  const fromObject = await captureConsoleError(() =>
    logServerErrorSafe("ctx", { cause: { url: "https://mainnet.infura.io/v3/INFURASECRET456" }, n: 1n }),
  );
  const fromSwallow = await captureConsoleError(() =>
    Promise.reject(new Error(text)).catch(logAndSwallowSafe("ctx.swallow")),
  );
  for (const line of [...fromString, ...fromObject, ...fromSwallow]) {
    for (const s of SECRETS) assert.equal(line.includes(s), false, `${s} が漏れた: ${line}`);
  }
  assert.match(fromObject[0], /"n":"1"/, "オブジェクトは中身を出す（伏せたうえで）");
  assert.match(fromSwallow[0], /ctx\.swallow/);
});

test("redactSecretsForLog: URL の外に出た鍵の形も伏せ、tx hash は残す", () => {
  const tx = "0x" + "ab".repeat(32);
  const out = redactSecretsForLog(
    `apikey=AAA111 api_key: "BBB222" Authorization: Bearer CCC.333 sk_live_DDDDDDDD444 re_EEEEEEEEEEEEEEEEEEEE555 tx ${tx}`,
  );
  for (const s of ["AAA111", "BBB222", "CCC.333", "DDDDDDDD444", "EEEEEEEEEEEEEEEEEEEE555"]) {
    assert.equal(out.includes(s), false, `${s}: ${out}`);
  }
  assert.ok(out.includes(tx), "tx hash は診断の本体なので残す");
});

// 凍結中（Tokyo 審査期間）で書き換えられないファイル。ここ以外で直呼びが戻ったら落とす。
const FROZEN_OR_SELF = new Set([
  "src/lib/util/log.ts",
  "src/lib/util/log-safe.ts",
  "src/lib/cron/lease.ts",
]);
const FROZEN_DIRS = ["src/app/tokyo/", "src/app/api/tokyo/"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("src の凍結外ファイルは util/log を直接 import しない（eslint と同じ規則）", () => {
  const root = process.cwd();
  const offenders = walk(join(root, "src"))
    .map((p) => relative(root, p))
    .filter((p) => !FROZEN_OR_SELF.has(p) && !FROZEN_DIRS.some((d) => p.startsWith(d)))
    .filter((p) => /from\s+["'](?:@\/lib\/util\/log|(?:\.\.?\/)+(?:[\w-]+\/)*util\/log|\.\/log)["']/.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders, [], "logServerErrorSafe / logAndSwallowSafe（@/lib/util/log-safe）を使う");
});

// 2026-09-29 独立レビューの指摘（中 1・低 2・低 3）の回帰。
test("log-safe: message が文字列でない Error でも呼び手へ投げない", () => {
  const e = new Error("x");
  (e as unknown as { message: unknown }).message = { toString: () => "obj" };
  assert.doesNotThrow(() => logServerErrorSafe("ctx", e));
  assert.equal(logAndSwallowSafe("ctx")(e), undefined);
});

test("log-safe: token の契約アドレスは残し、secretKey・mnemonic は伏せる", () => {
  const out = redactSecretsForLog(
    JSON.stringify({ secretKey: "LEAK", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", mnemonic: "a b c" }),
  );
  assert.ok(out.includes("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
  assert.ok(!out.includes("LEAK"));
  assert.ok(!out.includes("a b c"));
});

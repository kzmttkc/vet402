// ============================================================
// ETHGlobal Tokyo 2026 B8 — /tokyo の審査員ボタン（mutate / reset / state）の関門 W01〜W06。
// PLAN_v4.3 §3.7.1 の表をそのまま固定する。署名・送信・DB は全部偽物に差し替える
// （Sepolia へは1本も出さない。鍵も読まない）。
//
//   W01 読む env 名が許可リスト4つと完全一致（静的 import グラフで数える）・本文は2値だけ
//   W02 chainId は定数。本文に混ぜたら 400、RPC が違えば 503
//   W03 1日 60 回・停止スイッチ（行・読めない・env "1"）・decideHalt が本家と同じ答え
//   W04 残高の床（式）。床未満・読めないときは 503 で署名 0 回。ちょうど床は通る
//   W05 次に来た人が来たときに戻す（clean は tx 0・mutate の先頭で戻す・二重に戻さない・上書きしない・90 秒）
//   W06 書き込み先の4点は定数。敵対的な本文は全部 400。seller-a.eth へ書く道が無い
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AMOUNT, CHAIN_ID, DAILY_CAP, KEY, MAX_AGE_SECONDS, MIN_VALID, NODE, P_D, SELLER_D, TRUSTED_ATTESTERS, VALUES, W_OP,
  BALANCE_FLOOR_WEI, GAS_SAFETY, PRESS_GAS, STATE_REVERT_AFTER_MS,
} from "@/app/api/tokyo/_lib/constants";
import { handleMutate, handleReset, handleState } from "@/app/api/tokyo/_lib/button";
import { decideHalt, type HaltProbe } from "@/app/api/tokyo/_lib/halt";
import { ensureReverted } from "@/app/api/tokyo/_lib/revert";
import { envButtonDisabled } from "@/app/api/tokyo/_lib/env";
import type { ButtonDeps, LogRow, MutationRow, ReceiptStatus, WriteRequest } from "@/app/api/tokyo/_lib/types";
import { decideHalt as decideHaltOriginal } from "@/lib/observatory/kill-switch";

const ROOT = process.cwd();
const TOKYO_API = join(ROOT, "src/app/api/tokyo");
const TOKYO_PAGE = join(ROOT, "src/app/tokyo");
const ENTRY = {
  mutate: join(TOKYO_API, "mutate/route.ts"),
  reset: join(TOKYO_API, "reset/route.ts"),
  state: join(TOKYO_API, "state/route.ts"),
};
const P_A = "0xC54403186Db35B9D92cc393Ae665D3960117ac14"; // seller-a.eth の resolver（K1-04）。ボタンの経路に現れてはならない

// ---------------------------------------------------------------------------
// env-graph: 静的 import グラフを辿り、読む env 名を集める（依存ゼロ）。
// 解決できなかった指定子は必ず返す（空でなければ、その先の env を見ていない）。
// ---------------------------------------------------------------------------
type Graph = { files: string[]; env: Set<string>; dynamicEnv: string[]; unresolved: string[]; libImports: Set<string> };

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function resolveSpec(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, "src", spec.slice(2)) : resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function envGraph(entries: string[]): Graph {
  const g: Graph = { files: [], env: new Set(), dynamicEnv: [], unresolved: [], libImports: new Set() };
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    g.files.push(relative(ROOT, file));
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) g.env.add(m[1]);
    for (const m of code.matchAll(/process\.env\[\s*(["'`])([A-Za-z0-9_]+)\1\s*\]/g)) g.env.add(m[2]);
    for (const m of code.matchAll(/process\.env\s*\[\s*(?!(["'`])[A-Za-z0-9_]+\1\s*\])/g)) g.dynamicEnv.push(`${relative(ROOT, file)}@${m.index}`);
    for (const m of code.matchAll(/process\.env(?!\s*[.[])/g)) g.dynamicEnv.push(`${relative(ROOT, file)}@${m.index} (bare)`);
    const specs = [
      ...[...code.matchAll(/(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...code.matchAll(/(?:^|[\s;])import\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ];
    for (const m of code.matchAll(/import\(\s*(?!["'])/g)) g.unresolved.push(`${relative(ROOT, file)}: dynamic import() @${m.index}`);
    for (const spec of specs) {
      if (!spec.startsWith("@/") && !spec.startsWith(".")) continue; // パッケージ（viem・drizzle・@vet402/sdk …）は src の外
      if (spec.startsWith("@/lib/") && relative(ROOT, file).startsWith("src/app/")) g.libImports.add(spec);
      const r = resolveSpec(file, spec);
      if (r) stack.push(r);
      else g.unresolved.push(`${relative(ROOT, file)}: ${spec}`);
    }
  }
  return g;
}

const ALLOWED_ENV = ["DATABASE_URL", "TOKYO_JUDGE_BUTTON_DISABLED", "TOKYO_OPERATOR_PRIVATE_KEY", "TOKYO_SEPOLIA_RPC_URL"];
const ALLOWED_LIB = ["@/lib/cron/lease", "@/lib/db/client", "@/lib/util/log"];

function filesUnder(dir: string, pick: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, pick));
    else if (pick(p)) out.push(p);
  }
  return out;
}
const tsFiles = (dir: string) => filesUnder(dir, (p) => /\.(ts|tsx)$/.test(p));

// ---------------------------------------------------------------------------
// 偽物の deps
// ---------------------------------------------------------------------------
type Fake = {
  deps: ButtonDeps;
  writes: WriteRequest[];
  chain: { value: string; resolver: string };
  row: MutationRow;
  log: LogRow[];
  clock: { now: number };
  daily: { count: number };
};

function makeFake(over: Partial<ButtonDeps> & { chainValue?: string; balance?: bigint; gasPrice?: bigint; dbValue?: string } = {}): Fake {
  const clock = { now: Date.UTC(2026, 8, 27, 3, 0, 0) };
  const chain = { value: over.chainValue ?? VALUES.off, resolver: P_D as string };
  const row: MutationRow = {
    currentValue: over.dbValue ?? AMOUNT.off,
    generation: 0,
    mutatedAt: null,
    revertingUntil: null,
    lastTx: null,
  };
  const log: LogRow[] = [];
  const daily = { count: 0 };
  const writes: WriteRequest[] = [];
  let n = 0;
  const deps: ButtonDeps = {
    envDisabled: () => false,
    operatorAddress: () => W_OP,
    getChainId: async () => CHAIN_ID,
    getBalance: async () => over.balance ?? 10n ** 17n,
    getGasPrice: async () => over.gasPrice ?? 1_000_000_000n,
    readOffer: async () => ({ value: chain.value, resolver: chain.resolver as `0x${string}` }),
    writeContract: async (req) => {
      writes.push(req);
      chain.value = req.args[2];
      n += 1;
      return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
    },
    waitForReceipt: async (): Promise<ReceiptStatus> => "success",
    readHalt: async (): Promise<HaltProbe> => ({ kind: "absent" }),
    store: {
      ensureRow: async () => {},
      readRow: async () => ({ ...row }),
      claimRevert: async () => {
        if (row.revertingUntil && row.revertingUntil.getTime() >= clock.now) return null;
        row.revertingUntil = new Date(clock.now + 60_000);
        row.generation += 1;
        return row.generation;
      },
      finishRevert: async (g, tx) => {
        if (row.generation !== g) return false;
        row.currentValue = AMOUNT.off;
        row.revertingUntil = null;
        row.lastTx = tx;
        return true;
      },
      releaseClaim: async (g) => {
        if (row.generation === g) row.revertingUntil = null;
      },
      markClean: async (g) => {
        if (row.generation === g) row.currentValue = AMOUNT.off;
      },
      recordMutation: async (tx) => {
        row.currentValue = AMOUNT.on;
        row.generation += 1;
        row.mutatedAt = new Date(clock.now);
        row.revertingUntil = null;
        row.lastTx = tx;
      },
      appendLog: async (from, to, tx) => {
        log.unshift({ at: new Date(clock.now).toISOString(), from, to, tx });
      },
      recentLog: async (limit) => log.slice(0, limit),
      consumeDaily: async (_key, max) => (daily.count >= max ? null : ++daily.count),
      peekDaily: async () => daily.count,
      consumeInterval: async () => true,
    },
    withLease: async (fn) => ({ acquired: true, value: await fn() }),
    now: () => clock.now,
  };
  Object.assign(deps, over);
  return { deps, writes, chain, row, log, clock, daily };
}

const post = (path: string, body: string | null, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/tokyo/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === null ? {} : { body }),
  });
const get = (path: string) => new Request(`http://localhost/api/tokyo/${path}`);

// ============================================================ W01
test("W01-a: mutate / reset / state の import グラフに解決できない指定子が無い", () => {
  const g = envGraph(Object.values(ENTRY));
  assert.deepEqual(g.unresolved, []);
  assert.ok(g.files.some((f) => f.endsWith("src/lib/db/client.ts")), "グラフが db/client まで届いていない（walker が見えていない）");
  assert.ok(g.files.some((f) => f.endsWith("src/lib/cron/lease.ts")), "グラフが lease まで届いていない");
});

test("W01-b: 読む env 名の集合が許可リスト4つと完全一致（足りないも赤）", () => {
  const g = envGraph(Object.values(ENTRY));
  assert.deepEqual([...g.env].sort(), ALLOWED_ENV);
  for (const [name, entry] of Object.entries(ENTRY)) {
    const one = envGraph([entry]);
    assert.deepEqual([...one.env].sort(), ALLOWED_ENV, `${name} の env`);
  }
});

test("W01-c: 秘密の形の env 名は TOKYO_OPERATOR_PRIVATE_KEY の1本だけ", () => {
  const g = envGraph(Object.values(ENTRY));
  const secret = [...g.env].filter((n) => /(_PRIVATE_KEY|_SECRET_KEY|_SEED|_MNEMONIC)$/.test(n));
  assert.deepEqual(secret, ["TOKYO_OPERATOR_PRIVATE_KEY"]);
});

test("W01-d: 動的な process.env[…] は 0 本", () => {
  const g = envGraph(Object.values(ENTRY));
  assert.deepEqual(g.dynamicEnv, []);
});

test("W01: /tokyo と /api/tokyo から直接 import する既存 lib は3本だけ（ip-rate-limit・client-ip は使わない）", () => {
  const files = [...tsFiles(TOKYO_API), ...tsFiles(TOKYO_PAGE)];
  const g = envGraph(files);
  assert.ok([...g.libImports].every((s) => ALLOWED_LIB.includes(s)), [...g.libImports].join(", "));
  const all = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
  assert.ok(!/@\/lib\/api\/(ip-rate-limit|client-ip)/.test(all));
});

test("W01-e: 本文は {\"to\":\"10001\"} と {\"to\":\"10000\"} の2つだけ 200、他は全部 400 {error:\"invalid_body\"}", async () => {
  for (const body of ['{"to":"10001"}', '{"to":"10000"}']) {
    const f = makeFake();
    const r = await handleMutate(post("mutate", body), f.deps);
    assert.equal(r.status, 200, body);
  }
  const bad: (string | null)[] = [
    null, "", "null", "[]", '"10001"', "10001", "{}", '{"to":10001}', '{"to":10000}', '{"to":null}', '{"to":"10002"}',
    '{"to":" 10001"}', '{"TO":"10001"}', '{"to":"10001","x":1}', '{"to":["10001"]}', "{to:10001}", '{"to":"1e4"}',
  ];
  for (const body of bad) {
    const f = makeFake();
    const r = await handleMutate(post("mutate", body), f.deps);
    assert.equal(r.status, 400, String(body));
    assert.deepEqual(await r.json(), { error: "invalid_body" }, String(body));
    assert.equal(f.writes.length, 0, String(body));
  }
});

test("W01-e: reset の本文は {\"to\":\"10000\"} だけ", async () => {
  const ok = makeFake();
  assert.equal((await handleReset(post("reset", '{"to":"10000"}'), ok.deps)).status, 200);
  for (const body of [null, "{}", '{"to":"10001"}', '{"to":10000}']) {
    const f = makeFake();
    const r = await handleReset(post("reset", body), f.deps);
    assert.equal(r.status, 400, String(body));
    assert.deepEqual(await r.json(), { error: "invalid_body" });
  }
});

// ============================================================ W02
test("W02: chainId はソースの定数 11155111", () => {
  assert.equal(CHAIN_ID, 11155111);
  const src = readFileSync(join(TOKYO_API, "_lib/constants.ts"), "utf8");
  assert.match(src, /export const CHAIN_ID = 11155111 as const;/);
});

test("W02: 本文に chainId を混ぜたら 400（知らないキー）", async () => {
  const f = makeFake();
  const r = await handleMutate(post("mutate", '{"to":"10001","chainId":11155111}'), f.deps);
  assert.equal(r.status, 400);
  assert.equal(f.writes.length, 0);
});

test("W02: サーバの RPC の chainId が 11155111 でなければ 503・署名 0 回", async () => {
  const f = makeFake({ getChainId: async () => 1 });
  const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, "chain_mismatch");
  assert.equal(j.expected, 11155111);
  assert.equal(j.got, 1);
  assert.equal(f.writes.length, 0);
});

// ============================================================ W03
test("W03: 61 回目は 429 {error:\"daily_cap\", max:60}・署名しない", async () => {
  assert.equal(DAILY_CAP, 60);
  const f = makeFake();
  const statuses: number[] = [];
  for (let i = 0; i < 61; i++) {
    const before = f.writes.length;
    const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
    statuses.push(r.status);
    if (i === 60) {
      const j = await r.json();
      assert.equal(j.error, "daily_cap");
      assert.equal(j.max, 60);
      // 61 回目は前回の 10001 を戻す1本だけ。10001 へ変える tx は打たない
      const mine = f.writes.slice(before);
      assert.ok(mine.every((w) => w.args[2] === VALUES.off), "上限の後に 10001 を書いた");
    }
  }
  assert.equal(statuses.filter((s) => s === 200).length, 60);
  assert.equal(statuses[60], 429);
});

test("W03: runtime_flags.tokyo_button_halt が true なら 503（運用者のメモは返さない）", async () => {
  const f = makeFake({ readHalt: async () => ({ kind: "row", enabled: true, reason: "private memo" }) });
  const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(r.status, 503);
  const text = await r.text();
  assert.match(text, /"error":"halted"/);
  assert.ok(!text.includes("private memo"));
  assert.equal(f.writes.length, 0);
});

test("W03: フラグが読めなければ 503（fail-closed）", async () => {
  const f = makeFake({ readHalt: async () => ({ kind: "unreachable", detail: "db down" }) });
  const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "halt_flag_unreadable");
  assert.equal(f.writes.length, 0);
});

test("W03: 写した decideHalt が本家（kill-switch.ts）と同じ5入力で同じ答え", () => {
  const inputs: HaltProbe[] = [
    { kind: "row", enabled: true, reason: "stop" },
    { kind: "row", enabled: false, reason: null },
    { kind: "absent" },
    { kind: "schema_missing" },
    { kind: "unreachable", detail: "x" },
  ];
  for (const p of inputs) assert.deepEqual(decideHalt(p), decideHaltOriginal(p), JSON.stringify(p));
});

test("W03: TOKYO_JUDGE_BUTTON_DISABLED は \"1\" の1値だけで止まる（\"0\"・空・未設定は通る）", async () => {
  const prev = process.env.TOKYO_JUDGE_BUTTON_DISABLED;
  try {
    for (const [v, want] of [["1", true], ["0", false], ["", false], [undefined, false], ["true", false]] as const) {
      if (v === undefined) delete process.env.TOKYO_JUDGE_BUTTON_DISABLED;
      else process.env.TOKYO_JUDGE_BUTTON_DISABLED = v;
      assert.equal(envButtonDisabled(), want, String(v));
    }
  } finally {
    if (prev === undefined) delete process.env.TOKYO_JUDGE_BUTTON_DISABLED;
    else process.env.TOKYO_JUDGE_BUTTON_DISABLED = prev;
  }
  for (const [name, fn, path, body] of [
    ["mutate", handleMutate, "mutate", '{"to":"10001"}'],
    ["mutate(off)", handleMutate, "mutate", '{"to":"10000"}'],
    ["mutate(bad body)", handleMutate, "mutate", "{}"],
    ["reset", handleReset, "reset", '{"to":"10000"}'],
  ] as const) {
    const f = makeFake({ envDisabled: () => true, chainValue: VALUES.on, dbValue: AMOUNT.on });
    const r = await fn(post(path, body), f.deps);
    assert.equal(r.status, 503, name);
    assert.equal((await r.json()).error, "button_disabled", name);
    assert.equal(f.writes.length, 0, name);
  }
});

test("W03: 上限の判定は「読んでから書く」2文ではなく、INSERT … ON CONFLICT の1文の中に比較がある", () => {
  const src = readFileSync(join(TOKYO_API, "_lib/store.ts"), "utf8");
  const body = src.slice(src.indexOf("async consumeDaily("), src.indexOf("async peekDaily("));
  const statements = [...body.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]);
  assert.equal(statements.length, 1, "consumeDaily は SQL 1文");
  assert.match(statements[0], /INSERT INTO ip_rate_limits[\s\S]*ON CONFLICT \(bucket_key\) DO UPDATE[\s\S]*WHERE ip_rate_limits\.count < \$\{max\}[\s\S]*RETURNING count/);
  assert.ok(!/SELECT/i.test(statements[0]));
});

// ============================================================ W04
const floorWei = (gasPrice: bigint) => BALANCE_FLOOR_WEI + PRESS_GAS * gasPrice * GAS_SAFETY;

test("W04: 残高が床未満なら 503（balanceEth と floorEth）・writeContract 0 回", async () => {
  const gasPrice = 2_000_000_000n;
  const f = makeFake({ balance: floorWei(gasPrice) - 1n, gasPrice });
  const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, "balance_below_floor");
  assert.equal(typeof j.balanceEth, "string");
  assert.equal(typeof j.floorEth, "string");
  assert.equal(f.writes.length, 0);
});

test("W04: ちょうど床は通る", async () => {
  const gasPrice = 2_000_000_000n;
  const f = makeFake({ balance: floorWei(gasPrice), gasPrice });
  const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(r.status, 200);
  assert.equal(f.writes.length, 1);
});

test("W04: 残高が読めないときも 503・署名 0 回", async () => {
  const f = makeFake({ getBalance: async () => { throw new Error("rpc down https://secret.example/key"); } });
  const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(r.status, 503);
  const text = await r.text();
  assert.match(text, /balance_unreadable/);
  assert.ok(!text.includes("secret.example"), "RPC の URL を返した");
  assert.equal(f.writes.length, 0);
});

test("W04: 鍵が無い・W_op 以外の鍵なら 503・署名 0 回", async () => {
  for (const [addr, err] of [[null, "operator_key_missing"], ["0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6", "operator_key_mismatch"]] as const) {
    const f = makeFake({ operatorAddress: () => addr });
    const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, err);
    assert.equal(f.writes.length, 0);
  }
});

// ============================================================ W05
test("W05: clean なら tx 0 本", async () => {
  const f = makeFake();
  const r = await ensureReverted(f.deps);
  assert.deepEqual(r, { status: "clean" });
  assert.equal(f.writes.length, 0);
  const s = await handleState(get("state"), f.deps);
  assert.equal(s.status, 200);
  assert.equal(f.writes.length, 0);
});

test("W05: mutate の先頭で前回が戻る（writeContract 2 回・1本目 off・2本目 on）", async () => {
  const f = makeFake({ chainValue: VALUES.on, dbValue: AMOUNT.on });
  const r = await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(r.status, 200);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].args[2], VALUES.off);
  assert.equal(f.writes[1].args[2], VALUES.on);
  assert.deepEqual(f.log.map((l) => `${l.from}->${l.to}`), ["10000->10001", "10001->10000"]);
});

test("W05: 二重に押されても戻す tx は 1 本（リースが素通りでも戻す権利が1つ）", async () => {
  const f = makeFake({ chainValue: VALUES.on, dbValue: AMOUNT.on });
  const [a, b] = await Promise.all([ensureReverted(f.deps), ensureReverted(f.deps)]);
  assert.equal(f.writes.length, 1);
  assert.deepEqual([a.status, b.status].sort(), ["already_reverting", "reverted"]);
});

test("W05: 戻している間に誰かが変えたら、戻し結果で上書きしない（superseded）", async () => {
  const f = makeFake({ chainValue: VALUES.on, dbValue: AMOUNT.on });
  f.deps.waitForReceipt = async () => {
    await f.deps.store.recordMutation("0xnext");
    return "success";
  };
  const r = await ensureReverted(f.deps);
  assert.equal(r.status, "superseded");
  assert.equal(f.row.currentValue, AMOUNT.on);
  assert.equal(f.row.lastTx, "0xnext");
});

test("W05: state 経由は mutated_at から 90 秒未満なら戻さない・91 秒なら戻す", async () => {
  const f = makeFake();
  await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(f.writes.length, 1);
  f.clock.now += 89_000;
  let j = await (await handleState(get("state"), f.deps)).json();
  assert.equal(f.writes.length, 1);
  assert.equal(j.amount, AMOUNT.on);
  assert.equal(j.changedByButton, true);
  f.clock.now += 2_000; // 91 秒
  j = await (await handleState(get("state"), f.deps)).json();
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].args[2], VALUES.off);
  assert.equal(j.amount, AMOUNT.off);
  assert.equal(j.revert.status, "reverted");
});

test("W05: reset は時間の条件なしで戻す", async () => {
  const f = makeFake();
  await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  f.clock.now += 1_000;
  const r = await handleReset(post("reset", '{"to":"10000"}'), f.deps);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "reverted");
  assert.equal(f.writes.length, 2);
  assert.equal(f.chain.value, VALUES.off);
});

test("W05: 90000 という数値リテラルは constants.ts 以外に無い", () => {
  assert.equal(STATE_REVERT_AFTER_MS, 90_000);
  const offenders = [...tsFiles(TOKYO_API), ...tsFiles(TOKYO_PAGE)]
    .filter((f) => !f.endsWith("_lib/constants.ts"))
    .filter((f) => /(?<![\w.])90_?000(?![\w])/.test(stripComments(readFileSync(f, "utf8"))));
  assert.deepEqual(offenders.map((f) => relative(ROOT, f)), []);
});

// ============================================================ W06
test("W06: 敵対的な本文（name・node・resolver・key・value を混ぜたもの）は全部 400", async () => {
  const bodies = [
    '{"to":"10001","name":"seller-a.eth"}',
    `{"to":"10001","node":"${NODE}"}`,
    `{"to":"10001","resolver":"${P_A}"}`,
    '{"to":"10001","key":"attestations[x402-offer][atst.vet402.eth]"}',
    '{"to":"10001","value":"{}"}',
    '{"name":"seller-a.eth"}',
    '{"value":"10001"}',
    '{"to":"10001","__proto__":{"x":1}}',
  ];
  for (const body of bodies) {
    for (const [fn, path] of [[handleMutate, "mutate"], [handleReset, "reset"]] as const) {
      const f = makeFake();
      const r = await fn(post(path, body), f.deps);
      assert.equal(r.status, 400, `${path} ${body}`);
      assert.equal(f.writes.length, 0, `${path} ${body}`);
    }
  }
});

test("W06: 正常な {\"to\":\"10001\"} の writeContract の引数が逐語で P_d・setText・[NODE, x402-offer, VALUES.on]", async () => {
  const f = makeFake();
  await handleMutate(post("mutate", '{"to":"10001"}'), f.deps);
  assert.equal(f.writes.length, 1);
  const w = f.writes[0];
  assert.equal(w.address, P_D);
  assert.equal(w.address, "0x9CF7990dAB364d1738ABB09532b953Ec48269831");
  assert.equal(w.functionName, "setText");
  assert.deepEqual([...w.args], [NODE, "x402-offer", VALUES.on]);
});

test("W06: NODE は dns(\"seller-d.eth\")・値の2つは amount の1文字だけ違う 266 バイト", () => {
  const dns = (n: string) =>
    "0x" + Buffer.concat([...n.split(".").map((x) => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])), Buffer.from([0])]).toString("hex");
  assert.equal(NODE, dns("seller-d.eth"));
  assert.equal(SELLER_D, "seller-d.eth");
  assert.equal(KEY, "x402-offer");
  assert.equal(Buffer.byteLength(VALUES.off), 266);
  assert.equal(Buffer.byteLength(VALUES.on), 266);
  const diff = [...VALUES.off].filter((c, i) => c !== VALUES.on[i]).length;
  assert.equal(diff, 1);
  assert.equal(JSON.parse(VALUES.off).amount, "10000");
  assert.equal(JSON.parse(VALUES.on).amount, "10001");
});

test("W06: VALUES.off は K1 が seller-d.eth に書いた約束（mkOffer('10000', W_ENS)）と同じ文字列", async () => {
  // 型検査（root の tsc）に examples を持ち込まないよう、指定子は実行時に組み立てる
  const spec = pathToFileURL(join(ROOT, "examples/tokyo-2026-demo/src/lib/k1.ts")).href;
  const k1 = (await import(spec)) as { mkOffer: (amount: string, payTo: string) => string; W_ENS: string };
  assert.equal(VALUES.off, k1.mkOffer("10000", k1.W_ENS));
  assert.equal(VALUES.on, k1.mkOffer("10001", k1.W_ENS));
});

test("W06: route.ts と _lib/*.ts に setResolver 等の書き込み関数名が1つも無い", () => {
  const forbidden = ["setResolver", "setAddress", "setSubregistry", "linkToRecord", "linkToNode", "grantSetterRoles", "revokeRoles", "register", "unregister"];
  const files = [...Object.values(ENTRY), join(TOKYO_API, "verify/route.ts"), ...tsFiles(join(TOKYO_API, "_lib"))];
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const w of forbidden) if (src.includes(w)) hits.push(`${relative(ROOT, f)}: ${w}`);
  }
  assert.deepEqual(hits, []);
});

test("W06: seller-a.eth へ書く道がコード上に無い（ボタンの経路に P_a の番地も seller-a の名前も無い）", () => {
  const g = envGraph(Object.values(ENTRY));
  const tokyoFiles = g.files.filter((f) => f.startsWith("src/app/api/tokyo/"));
  assert.ok(tokyoFiles.length >= 8, tokyoFiles.join(", "));
  for (const f of tokyoFiles) {
    const src = stripComments(readFileSync(join(ROOT, f), "utf8"));
    assert.ok(!src.toLowerCase().includes(P_A.toLowerCase()), `${f} に P_a`);
    assert.ok(!/seller-a/.test(src), `${f} に seller-a`);
  }
  // writeContract を呼ぶのは revert.ts と button.ts だけで、宛先はどちらも定数 P_D
  const callers = tokyoFiles.filter((f) => /deps\.writeContract\(/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(callers.sort(), ["src/app/api/tokyo/_lib/button.ts", "src/app/api/tokyo/_lib/revert.ts"]);
  for (const f of callers) {
    for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/deps\.writeContract\(\{([^}]*)\}\)/g)) {
      assert.match(m[1], /^\s*address: P_D, functionName: "setText", args: \[NODE, KEY, VALUES\.(on|off)\]\s*$/, `${f}: ${m[1]}`);
    }
  }
});

test("W06: state と page.tsx に force-dynamic・state の応答に Cache-Control: no-store", async () => {
  for (const f of [ENTRY.state, ENTRY.mutate, ENTRY.reset, join(TOKYO_API, "verify/route.ts"), join(TOKYO_PAGE, "page.tsx")]) {
    assert.match(readFileSync(f, "utf8"), /export const dynamic = "force-dynamic";/, relative(ROOT, f));
  }
  const f = makeFake();
  const r = await handleState(get("state"), f.deps);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

// ============================================================ 押せないときの画面
test("state は押せない理由を1行ずつ返し、200 のまま（ボタンを黙って消さない）", async () => {
  const f = makeFake({ operatorAddress: () => null });
  const r = await handleState(get("state"), f.deps);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.canPress, false);
  assert.equal(j.blockers[0].error, "operator_key_missing");
  assert.equal(typeof j.blockers[0].message, "string");
  assert.equal(j.amount, AMOUNT.off);
  assert.equal(j.operator, W_OP);
});

// ============================================================ 読み取り側（ページ・verify）
test("ページと verify に鍵も署名器も無い（§3.7.1 の grep と同じ範囲）", () => {
  const files = [...tsFiles(TOKYO_PAGE), ...tsFiles(join(TOKYO_API, "verify"))];
  const hits = files.filter((f) => /signTypedData|PRIVATE_KEY/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => relative(ROOT, f)), []);
  // import グラフでも、署名器を作る deps.ts・鍵を読む env.ts へ辿り着かない。読む env は RPC の1本だけ
  const g = envGraph(files);
  assert.deepEqual(g.unresolved, []);
  assert.ok(!g.files.some((f) => /_lib\/(deps|env|button|revert|store)\.ts$/.test(f)), g.files.join(", "));
  assert.deepEqual([...g.env].sort(), ["TOKYO_SEPOLIA_RPC_URL"]);
});

test("/tokyo と /api/tokyo から Intercepta を呼ばない・表示しない（§3.10-4）", () => {
  const files = [...tsFiles(TOKYO_PAGE), ...tsFiles(TOKYO_API)];
  const hits = files.filter((f) => /intercepta|web3antivirus/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => relative(ROOT, f)), []);
});

test("検証の方針は examples/tokyo-2026-demo/trusted-attesters.json と同じ値（鮮度 7 日）", () => {
  const j = JSON.parse(readFileSync(join(ROOT, "examples/tokyo-2026-demo/trusted-attesters.json"), "utf8"));
  assert.deepEqual(
    TRUSTED_ATTESTERS.map((a) => ({ name: a.name, address: a.address, recordKeys: [...a.recordKeys] })),
    j.trustedAttesters,
  );
  assert.equal(MIN_VALID, j.minValid);
  assert.equal(MAX_AGE_SECONDS, j.maxAgeSeconds);
  assert.equal(MAX_AGE_SECONDS, 604_800);
});

test("schema.ts の tokyo_mutations・tokyo_mutation_log が本番へ流す DDL と同じ形", async () => {
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const schema = await import("@/lib/db/schema");
  const m = getTableConfig(schema.tokyoMutations);
  assert.equal(m.name, "tokyo_mutations");
  assert.deepEqual(
    m.columns.map((c) => [c.name, c.getSQLType(), c.notNull, c.primary]),
    [
      ["id", "integer", true, true],
      ["current_value", "text", true, false],
      ["generation", "bigint", true, false],
      ["mutated_at", "timestamp with time zone", false, false],
      ["reverting_until", "timestamp with time zone", false, false],
      ["last_tx", "text", false, false],
    ],
  );
  assert.deepEqual(m.checks.map((c) => c.name), ["tokyo_mutations_singleton"]);
  const l = getTableConfig(schema.tokyoMutationLog);
  assert.equal(l.name, "tokyo_mutation_log");
  assert.deepEqual(
    l.columns.map((c) => [c.name, c.getSQLType(), c.notNull]),
    [
      ["id", "bigserial", true],
      ["at", "timestamp with time zone", true],
      ["from_value", "text", true],
      ["to_value", "text", true],
      ["tx", "text", false],
    ],
  );
});

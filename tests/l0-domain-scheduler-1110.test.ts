// 同一ドメイン同時 1 件の列（runWithDomainInterval）の振る舞い（c36.rr3 の指摘・2026-11-10）。
//   - 上限超過で置き去りにした要求が終わるまで、その登録ドメインを離さない（holdDomainUntil）。
//   - 1 件がレーンを占める時間に上限を掛ける（laneHoldMaxMs）。レーンは空けても、ドメインは run が返るまで離さない。
//   - 優先の段と普通の列で、ドメインの保持を共有する（holds）。前の段の置き去りの要求がある間は、次の段も同じドメインへ出さない。
//   - 残りの多いドメインから取る（preferLongestDomainQueue）。最悪の保持で回が切れても、開始数が見込みの式と一致する。
// 仮想の時計で回す（実時間を待たない・マシンの混み具合で数が揺れない）。
// このファイルは新しい export を import しない。直す前のコードでは、振る舞いの断言で落ちる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithDomainInterval } from "@/lib/observatory/reprobe-priority";

function virtualClock() {
  let t = 0;
  let seq = 0;
  const timers: { at: number; seq: number; resolve: () => void }[] = [];
  const now = () => t;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.push({ at: t + Math.max(0, ms), seq: seq++, resolve });
    });
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
  };
  async function drive<T>(p: Promise<T>, maxSteps = 5_000): Promise<T> {
    let done = false;
    let failed = false;
    let value: T | undefined;
    let err: unknown;
    p.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        failed = true;
        err = e;
      },
    );
    for (let step = 0; step < maxSteps; step++) {
      await flush();
      if (done) break;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers.shift();
      if (!next) throw new Error(`scheduler stalled at t=${t} (no timer left, promise pending)`);
      t = Math.max(t, next.at);
      next.resolve();
    }
    if (!done) throw new Error(`scheduler did not finish within ${maxSteps} steps (t=${t})`);
    if (failed) throw err;
    return value as T;
  }
  return { now, sleep, drive, time: () => t };
}

type Item = { id: string; domain: string };
const item = (id: string): Item => ({ id, domain: id.replace(/[0-9]+$/, "") });

test("上限超過で置き去りにした要求が終わるまで、同じ登録ドメインの次を出さない（レーンは別ドメインへ）", async () => {
  const clock = virtualClock();
  const starts: Record<string, number> = {};
  const done = runWithDomainInterval([item("a1"), item("a2"), item("b1")], {
    concurrency: 2,
    intervalMs: 1,
    domainOf: (x) => x.domain,
    now: clock.now,
    sleep: clock.sleep,
    run: async (x) => {
      starts[x.id] = clock.time();
      if (x.id === "a1") {
        // 合計の上限を超えて結果を捨てた。要求そのものは 50 まで走る。
        return { holdDomainUntil: clock.sleep(50) };
      }
      await clock.sleep(10);
    },
  });
  await clock.drive(done);
  assert.equal(starts.a1, 0);
  assert.equal(starts.b1, 0);
  assert.ok(starts.a2 !== undefined, "a2 は要求が終わったあとに始まる");
  assert.ok(starts.a2! >= 50, `a2 は置き去りの要求（〜50）が終わるまで待つ（実際 ${starts.a2}）`);
});

test("1 件がレーンを占める時間に上限を掛け、レーンは別ドメインへ回す（ドメインは run が返るまで離さない）", async () => {
  const clock = virtualClock();
  const starts: Record<string, number> = {};
  const never = new Promise<void>(() => {});
  const done = runWithDomainInterval([item("a1"), item("b1"), item("a2")], {
    concurrency: 1,
    intervalMs: 1,
    laneHoldMaxMs: 12,
    deadlineAt: 100,
    domainOf: (x) => x.domain,
    now: clock.now,
    sleep: clock.sleep,
    run: async (x) => {
      starts[x.id] = clock.time();
      if (x.id === "a1") await never; // DB の書き込みが詰まった、など
      else await clock.sleep(5);
    },
  } as Parameters<typeof runWithDomainInterval<Item>>[1]);
  await clock.drive(done);
  assert.equal(starts.a1, 0);
  assert.equal(starts.b1, 12, "レーンは 12 で空き、別ドメインの b1 が始まる");
  assert.equal(starts.a2, undefined, "a1 が返っていないので、同じドメインの a2 は出さない");
  assert.ok(clock.time() <= 100, `期限（100）で返る。止まらない（t=${clock.time()}）`);
});

test("優先の段と普通の列でドメインの保持を共有する（前の段の置き去りの要求がある間は出さない）", async () => {
  const clock = virtualClock();
  const holds = { inFlight: new Set<string>(), nextAt: new Map<string, number>(), listeners: new Set<() => void>() };
  const starts: Record<string, number> = {};
  const stage1 = runWithDomainInterval([item("a1")], {
    concurrency: 2,
    intervalMs: 1,
    domainOf: (x) => x.domain,
    now: clock.now,
    sleep: clock.sleep,
    holds,
    run: async (x) => {
      starts[x.id] = clock.time();
      return { holdDomainUntil: clock.sleep(40) };
    },
  } as Parameters<typeof runWithDomainInterval<Item>>[1]);
  await clock.drive(stage1);
  const stage2 = runWithDomainInterval([item("a2"), item("b1")], {
    concurrency: 2,
    intervalMs: 1,
    deadlineAt: 200,
    domainOf: (x) => x.domain,
    now: clock.now,
    sleep: clock.sleep,
    holds,
    run: async (x) => {
      starts[x.id] = clock.time();
      await clock.sleep(5);
    },
  } as Parameters<typeof runWithDomainInterval<Item>>[1]);
  await clock.drive(stage2);
  assert.equal(starts.b1, 0);
  assert.ok(starts.a2 !== undefined && starts.a2 >= 40, `a2 は前の段の要求（〜40）が終わってから（実際 ${starts.a2}）`);
});

test("残りの多いドメインから取る: 最悪の保持で回が切れても開始数が最大になる", async () => {
  const run = async (prefer: boolean) => {
    const clock = virtualClock();
    let started = 0;
    const done = runWithDomainInterval([item("b1"), item("c1"), item("a1"), item("a2")], {
      concurrency: 2,
      intervalMs: 1,
      deadlineAt: 15,
      domainOf: (x) => x.domain,
      now: clock.now,
      sleep: clock.sleep,
      preferLongestDomainQueue: prefer,
      run: async () => {
        started++;
        await clock.sleep(10);
      },
    } as Parameters<typeof runWithDomainInterval<Item>>[1]);
    await clock.drive(done);
    return started;
  };
  // t=0 と t=10 の 2 回しか始められない。a を先に取れば 4 件、b・c を先に取ると a2 が期限に間に合わず 3 件。
  assert.equal(await run(true), 4);
});

test("期限があれば、外の段が持つドメインだけが残っても期限で返る（止まらない）", async () => {
  const clock = virtualClock();
  const holds = { inFlight: new Set<string>(["a"]), nextAt: new Map<string, number>(), listeners: new Set<() => void>() };
  let started = 0;
  const done = runWithDomainInterval([item("a1")], {
    concurrency: 2,
    intervalMs: 1,
    deadlineAt: 30,
    domainOf: (x) => x.domain,
    now: clock.now,
    sleep: clock.sleep,
    holds,
    run: async () => {
      started++;
    },
  } as Parameters<typeof runWithDomainInterval<Item>>[1]);
  await clock.drive(done);
  assert.equal(started, 0);
  assert.ok(clock.time() <= 30);
});

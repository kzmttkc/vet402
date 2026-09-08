// ============================================================
// health_snapshots が「503 だった」以外を何も残さない問題（2026-09-08）。
//
// 実測（2026-09-08）: 公開 /status の当日集計は 108 サンプル中 error 36。
// 同じ時間帯に手元から 60 回逐次で叩くと 60/60 が 200、各 0.33〜0.43 秒。
// 30 分毎のローカル cron は 36 回中 9 回 `health http 503 (body:
// {"status":"error"})`。数十秒後の deep 検査は criticalFailure:false・
// checks.scoring:"ok"。
//
// 逐次サンプルが全部緑だったのは製品が健全だったからではない。
// scoring-probe / payee-probe の memo は**モジュールスコープ = インスタンス毎**で、
// さらに payee 側は 10 分の stale-while-revalidate を持つ。25〜55 秒間隔の
// 逐次ポーリングは同じ温かいインスタンスの memo と scoring エンジン自身の
// 5 分キャッシュを踏み続けるので、**構造的に実測へ行かない**。
// 30 分間隔の cron だけが両方の TTL を必ず超え、毎回本物の測定を強制する。
//
// つまり赤と緑を分けているのは「キャッシュの齢」であって、
// 「503 だった」という 1 ビットからはどちらの probe が・なぜ・
// 実測だったのか黙って落ちている。console.error には出るが Vercel CLI は
// 直近 12 件しか返さず MESSAGE 列を落とすので 30 分後には消えている。
//
// このファイルが固定するのは 3 つ:
//   1. 落ちた理由が detail に載る（どちらの probe か・実測かキャッシュか・原因）
//   2. 公開本文は今までどおり {status} の 1 ビットのまま
//   3. /status ページには detail が出ない（route の 2026-08-06 監査コメントの決定）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateLiveness } from "@/lib/health/liveness";
import { shouldRecordSnapshot } from "@/lib/health/snapshot";
import { describeProbeFailure, probeSegment } from "@/lib/health/probe-detail";
import { instanceId } from "@/lib/health/instance-id";
import { DeadlineExceededError } from "@/lib/util/deadline";

// ------------------------------------------------------------
// 1. 落ちた理由が detail に載る
// ------------------------------------------------------------

test("detail は落ちた probe を名指しする——どちらが落ちたか分からない行を書かない", async () => {
  const result = await evaluateLiveness({
    scoring: async () => ({ status: "ok" as const, detail: null, fromCache: true }),
    payee: async () => ({
      status: "error" as const,
      detail: "payee_probe error: blockscout_unavailable",
      fromCache: false,
    }),
  });
  assert.equal(result.status, "error");
  assert.match(result.detail ?? "", /payee_probe/);
  assert.doesNotMatch(result.detail ?? "", /scoring_probe error/);
});

test("両方の probe の状態が detail に残る——落ちた側だけでは片方を見ていないのと同じ", async () => {
  const result = await evaluateLiveness({
    scoring: async () => ({ status: "degraded" as const, detail: "scoring=degraded", fromCache: false }),
    payee: async () => ({ status: "ok" as const, detail: null, fromCache: true }),
  });
  assert.match(result.detail ?? "", /scoring/);
  assert.match(result.detail ?? "", /payee/);
});

test("実測かキャッシュかが detail に載る——これが赤と緑を分けている変数だった", async () => {
  const fresh = await evaluateLiveness({
    scoring: async () => ({ status: "ok" as const, detail: null, fromCache: false }),
    payee: async () => ({ status: "ok" as const, detail: null, fromCache: false }),
  });
  const cached = await evaluateLiveness({
    scoring: async () => ({ status: "ok" as const, detail: null, fromCache: true }),
    payee: async () => ({ status: "ok" as const, detail: null, fromCache: true }),
  });
  assert.match(fresh.detail ?? "", /fresh/);
  assert.match(cached.detail ?? "", /cached/);
  assert.notEqual(fresh.detail, cached.detail);
});

test("evaluateLiveness は判定にかかった実測ミリ秒を返す", async () => {
  const result = await evaluateLiveness({
    scoring: async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { status: "ok" as const, detail: null, fromCache: false };
    },
    payee: async () => ({ status: "ok" as const, detail: null, fromCache: true }),
  });
  assert.equal(typeof result.latencyMs, "number");
  assert.ok(result.latencyMs >= 20, `計測が動いていない: ${result.latencyMs}ms`);
});

test("タイムアウトと上流エラーは detail の文言で区別できる", () => {
  const timedOut = describeProbeFailure(new DeadlineExceededError("payee_probe", 24_000));
  const upstream = describeProbeFailure(
    new Error("agent_identity_unavailable", { cause: new Error("HTTP 429 from blockscout") }),
  );
  assert.match(timedOut, /deadline_exceeded/);
  assert.doesNotMatch(upstream, /deadline_exceeded/);
  // 上流エラーは tag だけでなく cause まで運ぶ（tag はどの読みが死んだかしか言わない）
  assert.match(upstream, /agent_identity_unavailable/);
  assert.match(upstream, /429/);
});

test("probeSegment は ok のとき理由を付けず、非 ok のとき必ず付ける", () => {
  assert.equal(probeSegment("scoring", "ok", true, null), "scoring=ok cached");
  assert.equal(
    probeSegment("payee", "error", false, "boom"),
    "payee=error fresh: boom",
  );
});

test("detail は秘密や無制限長を持ち込まない——1行・上限つき", () => {
  const long = describeProbeFailure(new Error("x".repeat(5000), { cause: new Error("y".repeat(5000)) }));
  assert.ok(long.length <= 600, `detail が長すぎる: ${long.length}`);
  assert.doesNotMatch(long, /\n/);
});

// ------------------------------------------------------------
// インスタンス識別
// ------------------------------------------------------------

test("インスタンス識別子は同一プロセス内で不変（= 同一インスタンスかどうかが判る）", () => {
  assert.equal(instanceId(), instanceId());
  assert.ok(instanceId().length > 0);
});

// ------------------------------------------------------------
// 記録の絞り込み——表を 1 リクエスト 1 行に膨らませない
// ------------------------------------------------------------

test("ok が続く間は detail が変わっても書かない（健全時の行数を今までと変えない）", () => {
  const now = new Date("2026-09-08T12:01:00Z");
  assert.equal(
    shouldRecordSnapshot({
      now,
      lastSnapshot: {
        checkedAt: new Date("2026-09-08T12:00:00Z"),
        status: "ok",
        detail: "scoring=ok fresh; payee=ok cached",
      },
      currentStatus: "ok",
      currentDetail: "scoring=ok cached; payee=ok fresh",
    }),
    false,
  );
});

test("非 ok のとき detail が変われば即座に書く（どちらの probe が落ちたかの遷移を落とさない）", () => {
  const now = new Date("2026-09-08T12:01:00Z");
  assert.equal(
    shouldRecordSnapshot({
      now,
      lastSnapshot: {
        checkedAt: new Date("2026-09-08T12:00:00Z"),
        status: "error",
        detail: "scoring=error fresh: deadline_exceeded:scoring_probe:7000ms; payee=ok cached",
      },
      currentStatus: "error",
      currentDetail: "scoring=ok cached; payee=error fresh: blockscout 429",
    }),
    true,
  );
});

test("非 ok でも detail が同じなら 5 分の絞り込みを守る", () => {
  const detail = "scoring=error fresh: boom; payee=ok cached";
  assert.equal(
    shouldRecordSnapshot({
      now: new Date("2026-09-08T12:01:00Z"),
      lastSnapshot: { checkedAt: new Date("2026-09-08T12:00:00Z"), status: "error", detail },
      currentStatus: "error",
      currentDetail: detail,
    }),
    false,
  );
});

test("detail を渡さない既存の呼び出しは今までと同じ挙動（後方互換）", () => {
  assert.equal(
    shouldRecordSnapshot({
      now: new Date("2026-09-08T12:01:00Z"),
      lastSnapshot: { checkedAt: new Date("2026-09-08T12:00:00Z"), status: "ok" },
      currentStatus: "ok",
    }),
    false,
  );
});

// ------------------------------------------------------------
// 2. 公開本文は {status} だけのまま
// ------------------------------------------------------------

test("公開 /api/health の本文に detail / latency / instance を足さない", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/health/route.ts"), "utf8");
  // 非 deep の分岐が返すのは {status} ただ 1 つ。ここが増えたら 2026-08-06 の
  // 監査（version/chain/erc8004 を公開本文から外した決定）を破っている。
  assert.match(route, /NextResponse\.json\(\s*\{\s*status\s*\}\s*,\s*\{\s*status:\s*httpStatus\s*\}\s*\)/);
  assert.doesNotMatch(route, /NextResponse\.json\(\s*\{\s*status,\s*detail/);
});

test("banner-message は status しか受け取らない（detail が公開面へ漏れる経路を作らない）", () => {
  const banner = readFileSync(join(process.cwd(), "src/lib/health/banner-message.ts"), "utf8");
  assert.doesNotMatch(banner, /detail/);
});

// ------------------------------------------------------------
// 3. /status ページに detail を出さない
// ------------------------------------------------------------

test("/status ページは detail / latency / instance を読まない——admin 限定の決定を守る", () => {
  const page = readFileSync(join(process.cwd(), "src/app/status/page.tsx"), "utf8");
  assert.doesNotMatch(page, /detail/i);
  assert.doesNotMatch(page, /latency/i);
  assert.doesNotMatch(page, /instance/i);
});

test("getStatusHistory は detail 列を select しない——公開ページへ運ぶ配管を作らない", () => {
  const snapshot = readFileSync(join(process.cwd(), "src/lib/health/snapshot.ts"), "utf8");
  const history = snapshot.slice(snapshot.indexOf("export async function getStatusHistory"));
  assert.doesNotMatch(history, /detail/);
  assert.doesNotMatch(history, /latencyMs/);
  assert.doesNotMatch(history, /instance/);
});

// ------------------------------------------------------------
// スキーマとマイグレーションの整合
// ------------------------------------------------------------

test("追加は 3 列とも NULL 可——既存行と、まだ ALTER を流していない本番を壊さない", () => {
  const schema = readFileSync(join(process.cwd(), "src/lib/db/schema.ts"), "utf8");
  const table = schema.slice(schema.indexOf("export const healthSnapshots"));
  const body = table.slice(0, table.indexOf(");"));
  for (const col of ["detail", "latencyMs", "instance"]) {
    assert.match(body, new RegExp(col), `${col} が schema に無い`);
  }
  // 新列に notNull を付けたら、ALTER を流す前の本番で INSERT が全部落ちる
  const added = body.split("\n").filter((l) => /detail|latency_ms|instance/.test(l));
  assert.ok(added.length >= 3);
  for (const line of added) {
    assert.doesNotMatch(line, /notNull/, `新列に notNull: ${line}`);
  }
});

test("SQL は追加のみ——削除・改名・NOT NULL 化を含まない", () => {
  const sql = readFileSync(
    join(process.cwd(), "scripts/sql/2026-09-08-health-snapshot-detail.sql"),
    "utf8",
  );
  assert.match(sql, /ADD COLUMN IF NOT EXISTS detail text/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS latency_ms integer/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS instance text/i);
  assert.doesNotMatch(sql, /DROP\s+(COLUMN|TABLE)/i);
  assert.doesNotMatch(sql, /RENAME/i);
  assert.doesNotMatch(sql, /SET NOT NULL/i);
});

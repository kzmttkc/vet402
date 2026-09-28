// ============================================================
// Vouch — wallet→agent 解決の窓算術と候補確定（2026-08-13）。
//
// WHY. resolveAgentIdByWallet は identity registry を FROM_BLOCK から tip まで
// 全履歴 eth_getLogs 走査していた（2フィルタ × 約4,100往復／1ウォレット）。
// 本番の運用値では 1 Function invocation で捌けるのが約50万ブロック＝250往復
// なので、300秒の中では1件も終わらない。ベンチマークcronは毎週この形で殺され、
// trust_events に1行も書けないまま ok:true を返していた。
//
// 直し方は feedback インデクサと同じ型：索引（DB）＋境界だけの短い実走査。
// その「索引を信じてよいか」「tailは実走査できる長さか」を決める規則と、
// 候補 agentId をオンチェーン照合で確定させる規則は、DBもRPCも無しに判定できる。
// ここで直接テストする。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import {
  AGENT_RESOLVE_TAIL_MAX_DAYS,
  agentResolveTailMaxBlocks,
  planAgentResolveScan,
  planTailSnapshotUse,
} from "@/lib/chain/agent-resolve-window";
import { resolveFromCandidates } from "@/lib/chain/agent-resolver";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

// ---------- 窓算術 ----------

test("tail の上限はチェーンの日次ブロック数から出る", () => {
  assert.equal(agentResolveTailMaxBlocks(43_200), BigInt(43_200 * AGENT_RESOLVE_TAIL_MAX_DAYS));
  assert.equal(agentResolveTailMaxBlocks(7_200), BigInt(7_200 * AGENT_RESOLVE_TAIL_MAX_DAYS));
});

test("チェックポイントが無ければ索引は信用できない（全履歴走査に落ちない）", () => {
  const plan = planAgentResolveScan({ checkpoint: null, tip: 100n, maxTailBlocks: 50n });
  assert.deepEqual(plan, { kind: "unavailable", reason: "index_missing" });
});

test("索引が tip に追いついていれば実走査は不要", () => {
  assert.deepEqual(
    planAgentResolveScan({ checkpoint: 100n, tip: 100n, maxTailBlocks: 50n }),
    { kind: "indexed_only" },
  );
  // 追い越している（tipの取得タイミング差）ときも実走査は要らない。
  assert.deepEqual(
    planAgentResolveScan({ checkpoint: 101n, tip: 100n, maxTailBlocks: 50n }),
    { kind: "indexed_only" },
  );
});

test("未索引の tail が上限内なら、その区間だけを走査する", () => {
  assert.deepEqual(
    planAgentResolveScan({ checkpoint: 100n, tip: 140n, maxTailBlocks: 50n }),
    { kind: "tail_scan", fromBlock: 101n, toBlock: 140n },
  );
});

test("tail が上限を超えたら走査せず unavailable（これが全履歴走査の再発を止める関門）", () => {
  assert.deepEqual(
    planAgentResolveScan({ checkpoint: 100n, tip: 200n, maxTailBlocks: 50n }),
    { kind: "unavailable", reason: "index_gap_too_large" },
  );
});

// ---------- 候補の確定 ----------

test("候補は新しい agentId から照合し、束縛ウォレットが一致した最初の1件を返す", async () => {
  const asked: bigint[] = [];
  const resolved = await resolveFromCandidates(WALLET, [1n, 7n, 3n], async (agentId) => {
    asked.push(agentId);
    return agentId === 3n ? WALLET : OTHER;
  });

  assert.equal(resolved, 3n);
  assert.deepEqual(asked, [7n, 3n], "降順で照合し、一致したら残りは引かない");
});

test("どの候補も束縛ウォレットが一致しなければ null（＝エージェントではない）", async () => {
  const resolved = await resolveFromCandidates(WALLET, [1n, 2n], async () => OTHER);
  assert.equal(resolved, null);
});

test("照合中のRPC失敗は握り潰さず伝播する（null を負にキャッシュさせない）", async () => {
  await assert.rejects(
    () =>
      resolveFromCandidates(WALLET, [1n], async () => {
        throw new Error("agent_resolve_unavailable");
      }),
    /agent_resolve_unavailable/,
  );
});

test("候補が空なら照合を1回もせずに null", async () => {
  let calls = 0;
  const resolved = await resolveFromCandidates(WALLET, [], async () => {
    calls++;
    return WALLET;
  });
  assert.equal(resolved, null);
  assert.equal(calls, 0);
});

// ============================================================
// 2026-09-29: TTL が切れるたびに tail 全区間を走査し直していた。Base 公開 RPC の
// 2,000 ブロック上限の下では 3 秒に収まらず、週次ベンチマークが 0/42 になった。
// 期限切れでも覆っている区間は変わらない——伸びた分だけ継ぎ足す。
// ============================================================
test("スナップショット: 手元に無ければ全区間を走査する", () => {
  assert.deepEqual(
    planTailSnapshotUse({ snapshot: null, fromBlock: 100n, toBlock: 200n, now: 0, maxTailBlocks: 1000n }),
    { kind: "full" },
  );
});

test("スナップショット: 期限内で起点を覆っていれば使い回す", () => {
  const snapshot = { fromBlock: 100n, toBlock: 200n, expiresAt: 10 };
  assert.deepEqual(
    planTailSnapshotUse({ snapshot, fromBlock: 100n, toBlock: 230n, now: 5, maxTailBlocks: 1000n }),
    { kind: "reuse" },
  );
});

test("スナップショット: 期限切れでも起点を覆っていれば、伸びた分だけ走査する", () => {
  const snapshot = { fromBlock: 100n, toBlock: 200n, expiresAt: 10 };
  assert.deepEqual(
    planTailSnapshotUse({ snapshot, fromBlock: 100n, toBlock: 230n, now: 11, maxTailBlocks: 1000n }),
    { kind: "extend", fromBlock: 201n, toBlock: 230n },
  );
});

test("スナップショット: 索引が進んで起点が後ろへ動いても、覆っていれば継ぎ足しで足りる", () => {
  const snapshot = { fromBlock: 100n, toBlock: 200n, expiresAt: 10 };
  assert.deepEqual(
    planTailSnapshotUse({ snapshot, fromBlock: 150n, toBlock: 230n, now: 11, maxTailBlocks: 1000n }),
    { kind: "extend", fromBlock: 201n, toBlock: 230n },
  );
});

test("スナップショット: 起点を覆っていなければ（索引が巻き戻った等）全区間をやり直す", () => {
  const snapshot = { fromBlock: 100n, toBlock: 200n, expiresAt: 10 };
  assert.deepEqual(
    planTailSnapshotUse({ snapshot, fromBlock: 90n, toBlock: 230n, now: 5, maxTailBlocks: 1000n }),
    { kind: "full" },
  );
});

test("スナップショット: 古い起点を抱えすぎたら全区間をやり直す（際限なく育てない）", () => {
  const snapshot = { fromBlock: 100n, toBlock: 5000n, expiresAt: 10 };
  assert.deepEqual(
    planTailSnapshotUse({ snapshot, fromBlock: 2000n, toBlock: 5030n, now: 11, maxTailBlocks: 1000n }),
    { kind: "full" },
  );
});

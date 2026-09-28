/**
 * wallet→agent 解決の窓算術（2026-08-13）。
 *
 * WHY THIS FILE EXISTS. `resolveAgentIdByWallet` は identity registry を
 * `IDENTITY_REGISTRY_FROM_BLOCK`（41,663,783）から tip まで `eth_getLogs` で
 * 全履歴走査していた。`GET_LOGS_CHUNK_BLOCKS=2000` の運用値では 1 フィルタ
 * 約4,100往復、WalletSet と Registered の 2 本で約8,200往復——**1ウォレット
 * あたり**である。本番で 1 invocation が捌ける実力は約50万ブロック＝250往復
 * （`scripts/catch-up-owner-index.sh` が maxBlocks=500000 で最大200回ループする
 * のはそのため）なので、300秒の関数には 1 件も収まらない。週次の
 * benchmark-scan cron はこれで毎回プラットフォームに殺され、trust_events に
 * 1行も書けないまま沈黙していた（2026-08-13 実測: 本番の benchmark_seed は
 * 史上0行）。
 *
 * 直し方は 2026-08-12 の NewFeedback インデクサと同じ型——索引（DB）が本体、
 * 未索引の境界だけを短く実走査する。ここに置くのはその判断規則だけで、DB も
 * RPC も要らずに評価できる。feedback-window.ts と同じ理由での分離。
 *
 * 守る不変条件: **索引が窓全体を覆えないときは走査せず unavailable を返す。**
 * 解決に失敗した wallet は「エージェントではない」として素のウォレット経路で
 * 採点される——つまり取りこぼしは fail-OPEN（エージェント固有のシグナルが
 * 黙って落ちる）側に倒れる。だから覆えないなら答えないのが正しく、
 * 「上限を超えたら全部走査する」は取ってはいけない選択肢である。
 */

export type AgentResolvePlan =
  | { kind: "indexed_only" }
  | { kind: "tail_scan"; fromBlock: bigint; toBlock: bigint }
  | { kind: "unavailable"; reason: "index_missing" | "index_gap_too_large" };

/**
 * 実走査を許す tail の日数。
 *
 * Hobby の cron は日次・±59分のぶれがあるので、索引は正常でも約25時間ぶん
 * 遅れうる。2日あればそれに加えて 1 回の取りこぼしも吸収できる。これを超えた
 * ものはもう「境界」ではなく、この変更が消しにきた広域走査そのものなので、
 * 走らせずに退行する。
 */
export const AGENT_RESOLVE_TAIL_MAX_DAYS = 2;

export function agentResolveTailMaxBlocks(blocksPerDay: number): bigint {
  return BigInt(Math.ceil(AGENT_RESOLVE_TAIL_MAX_DAYS * blocksPerDay));
}

/**
 * 索引の到達点と tip から、実走査すべき区間を決める。
 *
 * `checkpoint` は「この位置までは DB が答えを持っている」という意味であり、
 * 索引は常に `IDENTITY_REGISTRY_FROM_BLOCK` から前進するので、
 * `[FROM_BLOCK .. checkpoint]` の被覆はチェックポイントの存在そのものが保証する。
 */
export function planAgentResolveScan(input: {
  checkpoint: bigint | null;
  tip: bigint;
  maxTailBlocks: bigint;
}): AgentResolvePlan {
  const { checkpoint, tip, maxTailBlocks } = input;

  // 索引が一度も走っていない＝DBは何も知らない。ここで全履歴走査へ落ちるのが
  // 元の欠陥だった。
  if (checkpoint === null) return { kind: "unavailable", reason: "index_missing" };

  const gap = tip - checkpoint;
  if (gap <= 0n) return { kind: "indexed_only" };
  if (gap > maxTailBlocks) return { kind: "unavailable", reason: "index_gap_too_large" };

  return { kind: "tail_scan", fromBlock: checkpoint + 1n, toBlock: tip };
}

/**
 * 手元の tail スナップショットをどう使うか（2026-09-29）。
 *
 * WHY. Base の公開 RPC が eth_getLogs を 2,000 ブロックに絞ったので、日次索引の
 * 直後でも数千〜数万ブロックの tail を 2 フィルタ × 2,000 ブロックずつ舐めることに
 * なった。それを TTL（60秒）が切れるたびに**全区間**やり直していたため、42件を
 * 続けて引く週次ベンチマークは毎回 3 秒の identity 予算を超え、0/42 で沈黙した。
 * 期限が切れても、既に覆っている区間は変わらない——伸びた分（1分で約30ブロック）
 * だけを継ぎ足せば足りる。
 *
 * - reuse:  期限内で、要求の起点を覆っている
 * - extend: 起点は覆っているが期限切れか tip が伸びた → 伸びた分だけ走査して継ぎ足す
 * - full:   手元に無い／起点を覆っていない／古い起点を抱えすぎた → 全区間を走査
 *
 * 候補は照合（resolveFromCandidates）がオンチェーンで確定するので、区間が要求より
 * 広い（古い起点を含む）ことは誤りにならない。狭いことだけが取りこぼしになる。
 */
export type TailSnapshotUse =
  | { kind: "reuse" }
  | { kind: "extend"; fromBlock: bigint; toBlock: bigint }
  | { kind: "full" };

export function planTailSnapshotUse(input: {
  snapshot: { fromBlock: bigint; toBlock: bigint; expiresAt: number } | null;
  fromBlock: bigint;
  toBlock: bigint;
  now: number;
  maxTailBlocks: bigint;
}): TailSnapshotUse {
  const { snapshot, fromBlock, toBlock, now, maxTailBlocks } = input;
  if (!snapshot || snapshot.fromBlock > fromBlock) return { kind: "full" };
  // 起点が古すぎるものは抱え続けない（ウォームな1インスタンスで際限なく育てない）。
  if (fromBlock - snapshot.fromBlock > maxTailBlocks) return { kind: "full" };
  if (snapshot.expiresAt > now) return { kind: "reuse" };
  if (snapshot.toBlock >= toBlock) return { kind: "reuse" };
  return { kind: "extend", fromBlock: snapshot.toBlock + 1n, toBlock };
}

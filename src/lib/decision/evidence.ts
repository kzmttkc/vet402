// ============================================================
// evidence[] の 1 行が守る契約（2026-09-05・ETHOnline / WINDOW_PLAN §2 #3・§15）
//
// 1 行は **1 つの源の観測**である。行は自分がどの台帳から来たかを名乗り、
// live を読んだと名乗る行は、それを他人が確かめられる証跡を同梱する。
//
// なぜ型だけで足りないか: この配列は 2 つの経路が作る。/decision は自社の
// L0–L2 台帳から作り、payOrRefuse（packages/sdk）は同じ配列へ The Graph の
// subgraph から読んだ行を足す。型は各経路の中でしか効かないので、
// **配る直前に 1 回、行そのものを検査する**。
//
// 禁じているのは 3 つ:
//   1. 源を名乗らない行（どちらの台帳の観測か言えない行を配らない）
//   2. 証跡の無い subgraph 行（§15: `_meta.block.number` と `deployment` が
//      「live のデータを読んだ」ことの唯一の自明な証明。無ければ静的データと
//      区別できず、賞の要件「モック・ローカルのみ・静的データは不可」に対して
//      何も言えない行になる）
//   3. 2 つの源の材料を 1 行に混ぜること（D16）。自社台帳の「配達件数」と
//      subgraph の「受領件数」は**別のことを数えた別の数**で、足した 1 つの数は
//      何も意味しない。混ぜられる行があると、下流でそれが自然に起きる
// ============================================================
import type { Evidence, EvidenceSource } from "./types";

/**
 * **行が名乗れる源は 2 つだけ。**
 *
 * `"both"` は SDK の `policy.evidence.source` が取る 3 番目の値だが、それは
 * 「どの源を**読むか**」の指定であって、観測の出どころではない。行の値として
 * 許すと「両方から来た 1 行」——すなわち合算した行——が型として作れてしまう。
 */
export const EVIDENCE_SOURCES = ["vet402", "subgraph"] as const;

/** vet402 の台帳だけが持てる材料（購入 id・観測 id・L2 の根拠ハッシュ）。 */
const VET402_ONLY = ["purchase_id", "observation_id", "declaration_hash", "response_hash", "diff_hash", "missing_keys"] as const;
/** subgraph の行だけが持てる材料（live の証跡と、その源が知っている件数）。 */
const SUBGRAPH_ONLY = ["subgraphId", "block", "deployment", "queriedAt", "receipts"] as const;

function isEvidenceSource(v: unknown): v is EvidenceSource {
  return typeof v === "string" && (EVIDENCE_SOURCES as readonly string[]).includes(v);
}

/** その行に、そのキーが**値として**載っているか（null は「載っていない」と同じに扱う）。 */
function has(row: Evidence, key: string): boolean {
  const v = (row as unknown as Record<string, unknown>)[key];
  return v !== undefined && v !== null;
}

/**
 * 配る直前の関門。壊れた行を見つけたら throw する——黙って落とすと
 * 「証拠が 1 件も無い」に化け、認証や実装の誤りが「その相手は何もしていない」
 * という**別の主張**にすり替わる（§15 の fail-closed の穴と同じ型）。
 */
export function assertEvidenceContract(rows: readonly Evidence[]): void {
  for (const row of rows) {
    const source = (row as unknown as { source?: unknown }).source;
    if (source === undefined || source === null) {
      throw new Error(`evidence_row_missing_source: ${JSON.stringify(row)}`);
    }
    if (!isEvidenceSource(source)) {
      throw new Error(
        `evidence_row_unknown_source: ${JSON.stringify(source)} — a row is one source's observation; ` +
          `"both" says which sources to read, it is never where an observation came from`,
      );
    }
    const foreign = source === "vet402" ? SUBGRAPH_ONLY : VET402_ONLY;
    for (const key of foreign) {
      if (has(row, key)) {
        throw new Error(`evidence_row_mixes_sources: a ${source} row carries ${key} — one row, one ledger (D16)`);
      }
    }
    if (source !== "subgraph") continue;
    const live =
      typeof row.subgraphId === "string" &&
      row.subgraphId !== "" &&
      typeof row.deployment === "string" &&
      row.deployment !== "" &&
      typeof row.queriedAt === "string" &&
      row.queriedAt !== "" &&
      typeof row.block?.number === "number";
    if (!live) {
      throw new Error(
        `evidence_row_not_live: a subgraph row needs subgraphId, block.number, deployment and queriedAt — ` +
          `without them nobody can tell it apart from static data: ${JSON.stringify(row)}`,
      );
    }
  }
}

/** vet402 自身の観測に源を刻む。**行を作る側が名乗る**（読む側が推測しない）。 */
export function vet402Evidence(row: Omit<Evidence, "source">): Evidence {
  return { ...row, source: "vet402" };
}

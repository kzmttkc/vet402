// 売り手端の遅れを公開面へ出す。測った試料だけを載せる。試料が 20 未満のときは目標を達成したと書かない。
import { reportSellerEdgeLatency } from "../../../packages/middleware/src/seller-edge.js";

export type SellerEdgePublicOverhead = {
  samples: number;
  measuredP95Ms: number | null;
  targetP95Ms: number;
  targetMet: boolean;
  statement: string;
  about: string;
};

const ABOUT =
  "vet402 publishes the overhead the seller edge adds around the seller handler. vet402 prints the measured p95 in statement. vet402 does not claim the target when fewer than 20 samples exist. When the measured p95 is above the target, vet402 publishes that value and does not claim the target.";

let recorded: readonly number[] = [];

export function sellerEdgePublicOverhead(): SellerEdgePublicOverhead {
  const report = reportSellerEdgeLatency(recorded);
  return {
    samples: report.samples,
    measuredP95Ms: report.measuredP95Ms,
    targetP95Ms: report.targetP95Ms,
    targetMet: report.targetMet,
    statement: report.statement,
    about: ABOUT,
  };
}

/** 測った試料を公開面の次の読みに載せる。呼び手が測っていない数は受け取らない。 */
export function publishSellerEdgeOverhead(samples: readonly number[]): SellerEdgePublicOverhead {
  recorded = samples.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
  return sellerEdgePublicOverhead();
}

export function resetSellerEdgeOverhead(): void {
  recorded = [];
}

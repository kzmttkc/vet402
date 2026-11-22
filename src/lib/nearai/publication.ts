import {
  isExternalVerifierUnavailable,
  isSeriousCryptoFailure,
  normalizeExternalFailure,
} from "./failure-class";

export type NearAiPublicStatus = "pass" | "advisory" | "unverified" | "pending_reverify";

export type PublicationDecision =
  | { show: true; status: NearAiPublicStatus; advisoryIds: string[]; tcbStatus: string; gpuPass: boolean }
  | { show: false; heldForPrivateReport: true; failureClass: string };

export type ObservedTarget = {
  targetKey: string;
  tcbStatus: string;
  advisoryIds: string[];
  gpuPass: boolean;
  rawFailureClass: string | null;
  cryptoOk: boolean;
  strictUpToDate: boolean;
};

export function worstFailureFromCandidates(
  candidates: readonly {
    failureClass: string | null;
    intelOk: boolean;
    strictUpToDate: boolean;
    tcbStatus: string;
    advisoryIds: string[];
    gpu: { ok: boolean | null; failureClass: string | null };
  }[],
): Pick<ObservedTarget, "rawFailureClass" | "cryptoOk" | "strictUpToDate" | "tcbStatus" | "advisoryIds" | "gpuPass"> {
  let rawFailureClass: string | null = null;
  let cryptoOk = true;
  let strictUpToDate = true;
  let tcbStatus = "UpToDate";
  const advisorySet = new Set<string>();
  let gpuPass = true;
  for (const c of candidates) {
    if (!c.intelOk) cryptoOk = false;
    if (!c.strictUpToDate) strictUpToDate = false;
    for (const id of c.advisoryIds) advisorySet.add(id);
    if (c.tcbStatus) tcbStatus = c.tcbStatus;
    const gpuFc = normalizeExternalFailure(c.gpu.failureClass);
    const intelFc = normalizeExternalFailure(c.failureClass);
    const fc = intelFc || gpuFc;
    if (fc && (!rawFailureClass || isSeriousCryptoFailure(fc))) rawFailureClass = fc;
    if (c.gpu.ok !== true) gpuPass = false;
    if (!c.intelOk && !fc) rawFailureClass = intelFc;
  }
  return {
    rawFailureClass,
    cryptoOk,
    strictUpToDate,
    tcbStatus,
    advisoryIds: [...advisorySet].sort(),
    gpuPass,
  };
}

export function decidePublication(
  observed: ObservedTarget,
  previousSeriousFailure: string | null | undefined,
  alreadyHeld: boolean,
): PublicationDecision {
  const fc = normalizeExternalFailure(observed.rawFailureClass);
  if (alreadyHeld) {
    return { show: false, heldForPrivateReport: true, failureClass: fc ?? "unknown" };
  }
  if (isExternalVerifierUnavailable(fc)) {
    return {
      show: true,
      status: "unverified",
      advisoryIds: observed.advisoryIds,
      tcbStatus: observed.tcbStatus,
      gpuPass: false,
    };
  }
  if (observed.cryptoOk && observed.strictUpToDate && observed.gpuPass) {
    return {
      show: true,
      status: "pass",
      advisoryIds: [],
      tcbStatus: observed.tcbStatus,
      gpuPass: true,
    };
  }
  if (observed.cryptoOk && !observed.strictUpToDate && !fc) {
    return {
      show: true,
      status: "advisory",
      advisoryIds: observed.advisoryIds,
      tcbStatus: observed.tcbStatus,
      gpuPass: observed.gpuPass,
    };
  }
  if (fc && isSeriousCryptoFailure(fc)) {
    if (previousSeriousFailure && previousSeriousFailure === fc) {
      return { show: false, heldForPrivateReport: true, failureClass: fc };
    }
    return {
      show: true,
      status: "pending_reverify",
      advisoryIds: observed.advisoryIds,
      tcbStatus: observed.tcbStatus,
      gpuPass: observed.gpuPass,
    };
  }
  if (!observed.gpuPass && fc && !isSeriousCryptoFailure(fc) && isExternalVerifierUnavailable(fc)) {
    return {
      show: true,
      status: "unverified",
      advisoryIds: observed.advisoryIds,
      tcbStatus: observed.tcbStatus,
      gpuPass: false,
    };
  }
  return {
    show: true,
    status: observed.cryptoOk ? "advisory" : "pending_reverify",
    advisoryIds: observed.advisoryIds,
    tcbStatus: observed.tcbStatus,
    gpuPass: observed.gpuPass,
  };
}
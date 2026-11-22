import { nearAiRowSha256 } from "./anchors";
import { decidePublication, worstFailureFromCandidates, type NearAiPublicStatus } from "./publication";
import type { NearAiPublicModel } from "./read-public";
import type { NearAiProbeOutput, NearAiProbeCandidate } from "./probe-types";
import { buildPublicSnapshot } from "./read-public";
import { normalizeExternalFailure, isSeriousCryptoFailure } from "./failure-class";

export type StoredModelRow = {
  id: number;
  runId: number;
  modelId: string;
  candidateCount: number;
  tcbStatus: string;
  advisoryIds: string[];
  gpuPass: boolean;
  publicStatus: NearAiPublicStatus;
  rawFailureClass: string | null;
  rowSha256: string;
  probedAt: string;
  held: boolean;
};

export type NearAiRunRecord = {
  id: number;
  runUuid: string;
  utcDay: string;
  startedAt: string;
  completedAt: string;
  output: NearAiProbeOutput;
  models: StoredModelRow[];
  gatewayStatus: NearAiPublicStatus;
  gatewayHeld: boolean;
};

function gatewayObserved(gw: NearAiProbeOutput["gateway"]) {
  const fc = normalizeExternalFailure(gw.failureClass ?? null);
  return {
    targetKey: "gateway",
    tcbStatus: gw.tcbStatus ?? "unknown",
    advisoryIds: gw.advisoryIds ?? [],
    gpuPass: true,
    rawFailureClass: fc,
    cryptoOk: Boolean(gw.ok),
    strictUpToDate: Boolean(gw.strictUpToDate),
  };
}

function modelObserved(modelId: string, candidates: NearAiProbeCandidate[]) {
  const w = worstFailureFromCandidates(candidates);
  return { targetKey: modelId, ...w };
}

export function processProbeRun(
  output: NearAiProbeOutput,
  utcDay: string,
  runId: number,
  runUuid: string,
  previousSeriousByTarget: Readonly<Record<string, string | null>>,
  heldTargets: ReadonlySet<string>,
  nextRowIdStart: number,
): NearAiRunRecord {
  const probedAt = output.completedAt;
  const models: StoredModelRow[] = [];
  let rowId = nextRowIdStart;
  const newSerious: Record<string, string | null> = { ...previousSeriousByTarget };

  for (const m of output.nearaiModelsProbed) {
    const candidates = m.candidates ?? [];
    const observed = modelObserved(m.modelId, candidates);
    const decision = decidePublication(observed, previousSeriousByTarget[m.modelId], heldTargets.has(m.modelId));
    const held = !decision.show && decision.heldForPrivateReport;
    const fc = observed.rawFailureClass;
    if (fc && isSeriousCryptoFailure(fc)) newSerious[m.modelId] = fc;
    else if (decision.show && decision.status !== "pending_reverify") newSerious[m.modelId] = null;

    if (!decision.show) {
      models.push({
        id: rowId++,
        runId,
        modelId: m.modelId,
        candidateCount: m.candidateCount ?? candidates.length,
        tcbStatus: observed.tcbStatus,
        advisoryIds: observed.advisoryIds,
        gpuPass: observed.gpuPass,
        publicStatus: "pass",
        rawFailureClass: fc,
        rowSha256: nearAiRowSha256(m.modelId, observed.tcbStatus, "held", observed.gpuPass, probedAt),
        probedAt,
        held: true,
      });
      continue;
    }
    models.push({
      id: rowId++,
      runId,
      modelId: m.modelId,
      candidateCount: m.candidateCount ?? candidates.length,
      tcbStatus: observed.tcbStatus,
      advisoryIds: decision.advisoryIds,
      gpuPass: decision.gpuPass,
      publicStatus: decision.status,
      rawFailureClass: fc,
      rowSha256: nearAiRowSha256(m.modelId, decision.tcbStatus, decision.status, decision.gpuPass, probedAt),
      probedAt,
      held: false,
    });
  }

  const gwObserved = gatewayObserved(output.gateway);
  const gwDecision = decidePublication(gwObserved, previousSeriousByTarget.gateway, heldTargets.has("gateway"));
  const gatewayHeld = !gwDecision.show && gwDecision.heldForPrivateReport;
  const gatewayStatus = gwDecision.show ? gwDecision.status : "pass";

  if (gwObserved.rawFailureClass && isSeriousCryptoFailure(gwObserved.rawFailureClass)) {
    newSerious.gateway = gwObserved.rawFailureClass;
  } else if (gwDecision.show && gwDecision.status !== "pending_reverify") {
    newSerious.gateway = null;
  }

  return {
    id: runId,
    runUuid,
    utcDay,
    startedAt: output.startedAt,
    completedAt: output.completedAt,
    output,
    models,
    gatewayStatus: gatewayHeld ? "pass" : gatewayStatus,
    gatewayHeld,
  };
}

export function publicModelsFromRun(run: NearAiRunRecord): NearAiPublicModel[] {
  return run.models
    .filter((m) => !m.held)
    .map((m) => ({
      modelId: m.modelId,
      candidateCount: m.candidateCount,
      tcbStatus: m.tcbStatus,
      advisoryIds: m.advisoryIds,
      gpuPass: m.gpuPass,
      status: m.publicStatus,
    }));
}

export function snapshotFromRun(run: NearAiRunRecord) {
  const gatewayAdvisory = run.output.gateway.advisoryIds ?? [];
  return buildPublicSnapshot(run.output, publicModelsFromRun(run), run.gatewayHeld ? "pass" : run.gatewayStatus, gatewayAdvisory);
}
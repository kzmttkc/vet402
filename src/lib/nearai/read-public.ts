import type { NearAiPublicStatus } from "./publication";
import type { NearAiProbeOutput } from "./probe-types";

export type NearAiPublicModel = {
  modelId: string;
  candidateCount: number;
  tcbStatus: string;
  advisoryIds: string[];
  gpuPass: boolean;
  status: NearAiPublicStatus;
};

export type NearAiPublicSnapshot = {
  schemaVersion: 1;
  description: string;
  retrievedAt: string;
  runStartedAt: string;
  runCompletedAt: string;
  nearaiModelCount: number;
  gateway: {
    httpStatus: number;
    tcbStatus: string;
    advisoryIds: string[];
    tlsBindingOk: boolean | null;
    status: NearAiPublicStatus;
  };
  models: NearAiPublicModel[];
  license: string;
  licenseUrl: string;
  cite: string;
};

const CITE =
  "KIZUNA Creation. vet402 NEAR AI TEE attestation observatory. Dataset. https://vet402.com/api/v1/observatory/nearai";

export function buildPublicSnapshot(
  output: NearAiProbeOutput,
  models: NearAiPublicModel[],
  gatewayStatus: NearAiPublicStatus,
  gatewayAdvisoryIds: string[],
): NearAiPublicSnapshot {
  const gw = output.gateway;
  return {
    schemaVersion: 1,
    description:
      "vet402 re-runs NEAR AI Inference SDK (pin 085a304) verification steps against Cloud attestation endpoints (Gateway keyless ECDSA, vllm models with attestationSupported). No API key.",
    retrievedAt: new Date().toISOString(),
    runStartedAt: output.startedAt,
    runCompletedAt: output.completedAt,
    nearaiModelCount: models.length,
    gateway: {
      httpStatus: gw.httpStatus,
      tcbStatus: gw.tcbStatus ?? "unknown",
      advisoryIds: gatewayAdvisoryIds,
      tlsBindingOk: gw.tlsPeerMatches ?? null,
      status: gatewayStatus,
    },
    models,
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    cite: CITE,
  };
}

export function countStrictUpToDateMachines(output: NearAiProbeOutput): number {
  let n = 0;
  for (const m of output.nearaiModelsProbed) {
    for (const c of m.candidates ?? []) {
      if (c.strictUpToDate && c.tcbStatus === "UpToDate" && c.gpu.ok === true) n += 1;
    }
  }
  return n;
}
export type NearAiProbeCandidate = {
  modelNameMatch?: boolean;
  reportedModelName?: string | null;
  intelOk: boolean;
  strictUpToDate: boolean;
  tcbStatus: string;
  advisoryIds: string[];
  failureClass: string | null;
  signingAddress?: string;
  composeSha256?: string | null;
  imageDigests?: string[];
  composeManager?: { present: boolean; valid: boolean | null };
  gpu: {
    present: boolean;
    ok: boolean | null;
    failureClass: string | null;
    verdict?: boolean;
    eatNonceMatches?: boolean;
    gpuCount?: number | null;
  };
};

export type NearAiModelProbeResult = {
  modelId: string;
  tier: string;
  httpStatus: number;
  fetchMs?: number;
  candidateCount?: number;
  allPassCrypto?: boolean;
  allStrictUpToDate?: boolean;
  candidates?: NearAiProbeCandidate[];
  ok?: boolean;
  failureClass?: string | null;
};

export type NearAiGatewayProbe = {
  httpStatus: number;
  ok?: boolean;
  strictUpToDate?: boolean;
  failureClass?: string | null;
  tcbStatus?: string;
  advisoryIds?: string[];
  tlsPeerMatches?: boolean | null;
  debugEnabled?: boolean;
  peerSpkiSha256Observed?: string;
};

export type NearAiProbeOutput = {
  schemaVersion: string;
  startedAt: string;
  completedAt: string;
  baseUrl: string;
  pccsUrl: string;
  keyless: boolean;
  inferenceSdkPin?: string;
  signingAlgoGateway?: string;
  catalogSummary: {
    totalModels: number;
    nearaiCount: number;
    attested3pCount: number;
    nearaiModels: string[];
    attestedModels?: string[];
  };
  gateway: NearAiGatewayProbe;
  nearaiModelsProbed: NearAiModelProbeResult[];
  controlProbes?: unknown[];
};
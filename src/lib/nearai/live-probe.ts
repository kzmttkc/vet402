import { randomBytes } from "node:crypto";
import { INTEL_PCS_URL, PHALA_PCCS_URL } from "@phala/dcap-qvl";
import { fetchSameSocketReport } from "./tls-client";
import { verifyNearReport } from "./verify-report";
import { verifyNvidiaGpu, type VerifyNvidiaGpuOptions } from "./verify-gpu";
import type { NearAiProbeOutput } from "./probe-types";

export const NEAR_AI_INFERENCE_SDK_PIN = "085a304";

const BASE_URL = process.env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai";
const DEFAULT_DELAY_MS = Number(process.env.NEARAI_PROBE_DELAY_MS ?? 800);
const DEFAULT_ATTESTED_MODELS = [
  "z-ai/glm-5.3-flash",
  "Qwen/Qwen3.8-27B",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017",
];

async function fetchWithRetry429(fn: () => Promise<Awaited<ReturnType<typeof fetchSameSocketReport>>>, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fn();
    if (res.status !== 429 || attempt === maxRetries) return res;
    const ra = res.headers["retry-after"];
    const retryAfter = Number(Array.isArray(ra) ? ra[0] : ra) || 3;
    await new Promise((r) => setTimeout(r, Math.min(retryAfter, 15) * 1000));
  }
  throw new Error("unreachable");
}

function resolvePccsUrl(options: RunNearAiProbeOptions): string {
  if (options.pccsUrl) return options.pccsUrl;
  if (process.env.NEARAI_PCCS_URL) return process.env.NEARAI_PCCS_URL;
  if (options.usePhalaPccs || process.env.NEARAI_USE_PHALA_PCCS === "1") return PHALA_PCCS_URL;
  if (options.useIntelPcs === false) return PHALA_PCCS_URL;
  return INTEL_PCS_URL;
}

export type ModelMetadata = {
  modelId: string;
  providerType: string;
  attestationSupported: boolean;
};

export async function fetchModelMetadata(modelId: string, fetchImpl: typeof fetch = fetch): Promise<ModelMetadata | null> {
  const res = await fetchImpl(`${BASE_URL}/v1/model/${encodeURIComponent(modelId)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "vet402-observatory-nearai/1.0 (+https://vet402.com/observatory/nearai)",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    metadata?: { providerType?: string; attestationSupported?: boolean };
  };
  if (!body.metadata?.providerType || body.metadata.attestationSupported === undefined) return null;
  return {
    modelId,
    providerType: body.metadata.providerType,
    attestationSupported: Boolean(body.metadata.attestationSupported),
  };
}

export function isSdkAttestedModel(meta: ModelMetadata): boolean {
  return meta.providerType === "vllm" && meta.attestationSupported;
}

async function probeNearModel(
  modelId: string,
  pccsUrl: string,
  verifyQvl?: RunNearAiProbeOptions["verifyQvl"],
  gpuOptions?: VerifyNvidiaGpuOptions,
) {
  const nonce = randomBytes(32).toString("hex");
  const params = new URLSearchParams({
    model: modelId,
    provider: "near",
    include_tls_fingerprint: "false",
    signing_algo: "ecdsa",
    nonce,
  });
  const url = `${BASE_URL}/v1/attestation/report?${params.toString()}`;
  const t0 = Date.now();
  const res = await fetchWithRetry429(() => fetchSameSocketReport(url, { "x-no-aliasing": "true" }));
  const fetchMs = Date.now() - t0;
  const body = res.json as { model_attestations?: Record<string, unknown>[]; error?: { message?: string } } | null;

  if (res.status !== 200 || !body) {
    return {
      modelId,
      tier: "private_tee",
      httpStatus: res.status,
      fetchMs,
      ok: false,
      failureClass: `http_${res.status}`,
    };
  }

  const candidates = body.model_attestations || [];
  if (candidates.length === 0) {
    return {
      modelId,
      tier: "private_tee",
      httpStatus: 200,
      fetchMs,
      ok: false,
      failureClass: "empty_model_attestations",
      candidateCount: 0,
    };
  }

  const candidateResults = [];
  for (const cand of candidates) {
    const intel = await verifyNearReport(cand, nonce, { pccsUrl, verifyQvl });
    const gpu = await verifyNvidiaGpu(cand.nvidia_payload, nonce, gpuOptions ?? {});
    candidateResults.push({
      modelNameMatch: cand.model_name === modelId,
      reportedModelName: (cand.model_name as string) ?? null,
      intelOk: intel.ok,
      strictUpToDate: intel.strictUpToDate,
      tcbStatus: intel.tcbStatus,
      advisoryIds: intel.advisoryIds,
      failureClass: intel.failureClass || (gpu.ok === false ? gpu.failureClass : null),
      signingAddress: intel.signingAddress,
      composeSha256: intel.composeSha256,
      imageDigests: intel.imageDigests,
      composeManager: intel.composeManager,
      gpu,
    });
  }

  const allPassCrypto = candidateResults.every((c) => c.intelOk && c.gpu.ok !== false);
  const allStrictUpToDate = candidateResults.every((c) => c.strictUpToDate && c.gpu.ok !== false);
  return {
    modelId,
    tier: "private_tee",
    httpStatus: 200,
    fetchMs,
    candidateCount: candidates.length,
    allPassCrypto,
    allStrictUpToDate,
    candidates: candidateResults,
  };
}

export type RunNearAiProbeOptions = {
  allNearai?: boolean;
  useIntelPcs?: boolean;
  usePhalaPccs?: boolean;
  pccsUrl?: string;
  probeDelayMs?: number;
  fetchModels?: typeof fetch;
  verifyQvl?: NonNullable<NonNullable<Parameters<typeof verifyNearReport>[2]>["verifyQvl"]>;
  gpuVerify?: VerifyNvidiaGpuOptions;
};

export async function runNearAiLiveProbe(options: RunNearAiProbeOptions = {}): Promise<NearAiProbeOutput> {
  const startedAt = new Date().toISOString();
  const pccsUrl = resolvePccsUrl(options);
  const delay = options.probeDelayMs ?? DEFAULT_DELAY_MS;
  const fetchImpl = options.fetchModels ?? fetch;
  const gpuOptions: VerifyNvidiaGpuOptions = {
    fetchFn: options.gpuVerify?.fetchFn ?? fetch,
    ...options.gpuVerify,
  };

  const modelsRes = await fetchImpl(`${BASE_URL}/v1/models`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "vet402-observatory-nearai/1.0 (+https://vet402.com/observatory/nearai)",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!modelsRes.ok) throw new Error(`/v1/models HTTP ${modelsRes.status}`);
  const modelsBody = (await modelsRes.json()) as { data?: { id: string; owned_by?: string }[] };
  const models = modelsBody.data || [];

  const byOwner: Record<string, number> = {};
  for (const m of models) {
    const owner = m.owned_by || "unknown";
    byOwner[owner] = (byOwner[owner] || 0) + 1;
  }

  const attestedModelIds: string[] = [];
  for (const m of models) {
    const meta = await fetchModelMetadata(m.id, fetchImpl);
    if (meta && isSdkAttestedModel(meta)) attestedModelIds.push(m.id);
  }

  const nearaiModels = models.filter((m) => m.owned_by === "nearai").map((m) => m.id);
  const attested3pModels = models.filter((m) => m.owned_by === "attested 3p").map((m) => m.id);

  const gwNonce = randomBytes(32).toString("hex");
  const gwUrl = `${BASE_URL}/v1/attestation/report?signing_algo=ecdsa&include_tls_fingerprint=true&nonce=${gwNonce}`;
  const gwRes = await fetchWithRetry429(() => fetchSameSocketReport(gwUrl));
  let gatewayResult: NearAiProbeOutput["gateway"] = { httpStatus: gwRes.status, ok: false };
  const gwJson = gwRes.json as { gateway_attestation?: Record<string, unknown> } | null;
  if (gwRes.status === 200 && gwJson?.gateway_attestation) {
    const verified = await verifyNearReport(gwJson.gateway_attestation, gwNonce, {
      pccsUrl,
      peerSpkiSha256: gwRes.peerSpkiSha256,
      verifyQvl: options.verifyQvl,
    });
    gatewayResult = {
      httpStatus: 200,
      peerSpkiSha256Observed: gwRes.peerSpkiSha256 ?? undefined,
      ...verified,
    };
  }

  const targetModels = options.allNearai
    ? attestedModelIds
    : DEFAULT_ATTESTED_MODELS.filter((id) => attestedModelIds.includes(id));

  const modelResults = [];
  for (const mid of targetModels) {
    modelResults.push(await probeNearModel(mid, pccsUrl, options.verifyQvl, gpuOptions));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  return {
    schemaVersion: "nearai-probe/v0",
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    pccsUrl,
    inferenceSdkPin: NEAR_AI_INFERENCE_SDK_PIN,
    keyless: true,
    signingAlgoGateway: "ecdsa",
    catalogSummary: {
      totalModels: models.length,
      nearaiCount: nearaiModels.length,
      attested3pCount: attested3pModels.length,
      nearaiModels,
      attestedModels: attestedModelIds,
    },
    gateway: gatewayResult,
    nearaiModelsProbed: modelResults,
    controlProbes: [],
  };
}
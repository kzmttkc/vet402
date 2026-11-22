import { createHash } from "node:crypto";
import { getCollateralAndVerify, PHALA_PCCS_URL } from "@phala/dcap-qvl";
import {
  ACCEPTED_TCB_CRYPTO,
  ACCEPTED_TCB_STRICT,
} from "./failure-class";
import {
  checkComposeManagerActions,
  extractImageDigests,
  hexBytes,
  parseJsonMaybe,
  replayRtmr3,
  sha256Buf,
} from "./crypto";

export type NearReportVerifyResult = {
  ok: boolean;
  strictUpToDate: boolean;
  failureClass: string | null;
  tcbStatus: string;
  advisoryIds: string[];
  debugEnabled: boolean;
  signingAlgo?: string;
  signingAddress?: string;
  tlsPeerMatches?: boolean | null;
  tlsCertFingerprint?: string | null;
  reportDataMatches?: boolean;
  echoedNonceMatches?: boolean;
  mrConfigMatches?: boolean;
  rtmr3Matches?: boolean;
  rtmr3Error?: string | null;
  composeSha256?: string | null;
  imageDigests?: string[];
  composeManager?: ReturnType<typeof checkComposeManagerActions>;
};

type ReportLike = {
  intel_quote?: string;
  signing_algo?: string;
  signing_address?: string;
  tls_cert_fingerprint?: string;
  request_nonce?: string;
  event_log?: unknown;
  info?: { tcb_info?: unknown; instance_id?: string | null };
  nvidia_payload?: unknown;
};

export async function verifyNearReport(
  report: ReportLike,
  nonceHex: string,
  options: {
    pccsUrl?: string;
    peerSpkiSha256?: string | null;
    verifyQvl?: (quoteBytes: Buffer) => ReturnType<typeof getCollateralAndVerify>;
  } = {},
): Promise<NearReportVerifyResult> {
  const pccsUrl = options.pccsUrl || PHALA_PCCS_URL;
  const peerSpkiSha256 = options.peerSpkiSha256;
  const verifyQvl = options.verifyQvl ?? ((quoteBytes: Buffer) => getCollateralAndVerify(quoteBytes, pccsUrl));

  if (!report?.intel_quote) {
    return { ok: false, strictUpToDate: false, failureClass: "missing_intel_quote", tcbStatus: "unknown", advisoryIds: [], debugEnabled: false };
  }

  let verified: Awaited<ReturnType<typeof getCollateralAndVerify>>;
  try {
    verified = await verifyQvl(hexBytes(report.intel_quote));
  } catch {
    return { ok: false, strictUpToDate: false, failureClass: "pccs_unavailable", tcbStatus: "unknown", advisoryIds: [], debugEnabled: false };
  }

  if (verified.report?.type !== "td10") {
    return {
      ok: false,
      strictUpToDate: false,
      failureClass: "not_td10_quote",
      tcbStatus: verified.status,
      advisoryIds: verified.advisory_ids ?? [],
      debugEnabled: false,
    };
  }
  const quote = verified.report.data as {
    tdAttributes: Uint8Array;
    reportData: Uint8Array;
    mrConfigId: Uint8Array;
    rtMr3: Uint8Array;
    mrTd: Uint8Array;
  };
  const tdAttributes = Buffer.from(quote.tdAttributes);
  const debugEnabled = Boolean(tdAttributes[0] & 1);

  const signingAlgo = (report.signing_algo || "").toLowerCase();
  const identity = hexBytes(report.signing_address || "");
  const expectedLen = signingAlgo === "ecdsa" ? 20 : signingAlgo === "ed25519" ? 32 : -1;
  if (expectedLen !== identity.length) {
    return {
      ok: false,
      strictUpToDate: false,
      failureClass: "unsupported_signing_identity",
      tcbStatus: verified.status,
      advisoryIds: verified.advisory_ids ?? [],
      debugEnabled,
    };
  }

  const fingerprint = report.tls_cert_fingerprint;
  let tlsPeerMatches: boolean | null = null;
  if (peerSpkiSha256 !== undefined && peerSpkiSha256 !== null) {
    tlsPeerMatches =
      Boolean(fingerprint) &&
      peerSpkiSha256 !== null &&
      fingerprint!.toLowerCase() === peerSpkiSha256.toLowerCase();
  }

  const boundIdentity = fingerprint
    ? sha256Buf([identity, hexBytes(fingerprint)])
    : Buffer.concat([identity, Buffer.alloc(32 - identity.length)]);
  const expectedReportData = Buffer.concat([boundIdentity, hexBytes(nonceHex)]);
  const reportDataMatches = Buffer.from(quote.reportData).equals(expectedReportData);
  const echoedNonceMatches = (report.request_nonce || "").toLowerCase() === nonceHex.toLowerCase();

  const tcbInfo = parseJsonMaybe(report.info?.tcb_info) as { app_compose?: string } | null;
  const appCompose = tcbInfo?.app_compose ?? "";
  const composeSha256 = appCompose ? createHash("sha256").update(appCompose, "utf8").digest("hex") : null;
  let mrConfigMatches = false;
  if (composeSha256) {
    const expectedMrConfig = Buffer.concat([Buffer.from([1]), Buffer.from(composeSha256, "hex"), Buffer.alloc(15)]);
    mrConfigMatches = Buffer.from(quote.mrConfigId).equals(expectedMrConfig);
  }

  let rtmr3Matches = false;
  let rtmr3Error: string | null = null;
  try {
    rtmr3Matches = replayRtmr3(report.event_log).equals(Buffer.from(quote.rtMr3));
  } catch (err) {
    rtmr3Error = err instanceof Error ? err.message : String(err);
  }

  const composeManager = checkComposeManagerActions(report as Record<string, unknown>);
  const imageDigests = extractImageDigests(appCompose);

  const tcbStatus = verified.status;
  const composeActionsFail = composeManager.present && composeManager.valid === false;

  const cryptoChecksPass =
    !debugEnabled &&
    ACCEPTED_TCB_CRYPTO.has(tcbStatus) &&
    reportDataMatches &&
    echoedNonceMatches &&
    mrConfigMatches &&
    rtmr3Matches &&
    !composeActionsFail &&
    (tlsPeerMatches === null || tlsPeerMatches === true);

  let failureClass: string | null = null;
  if (debugEnabled) failureClass = "tdx_debug_enabled";
  else if (!reportDataMatches || !echoedNonceMatches) failureClass = "nonce_or_signer_mismatch";
  else if (tlsPeerMatches === false) failureClass = "tls_spki_mismatch";
  else if (!mrConfigMatches) failureClass = "mrconfig_mismatch";
  else if (!rtmr3Matches) failureClass = "rtmr3_mismatch";
  else if (composeActionsFail) failureClass = "compose_actions_mismatch";
  else if (!ACCEPTED_TCB_CRYPTO.has(tcbStatus)) failureClass = `tcb_rejected:${tcbStatus}`;

  return {
    ok: cryptoChecksPass,
    strictUpToDate: cryptoChecksPass && ACCEPTED_TCB_STRICT.has(tcbStatus),
    failureClass,
    tcbStatus,
    advisoryIds: verified.advisory_ids ?? [],
    debugEnabled,
    signingAlgo,
    signingAddress: report.signing_address,
    tlsPeerMatches,
    tlsCertFingerprint: fingerprint ?? null,
    reportDataMatches,
    echoedNonceMatches,
    mrConfigMatches,
    rtmr3Matches,
    rtmr3Error,
    composeSha256,
    imageDigests,
    composeManager,
  };
}
// ENSIP-29 gate: verify the x402 offer a seller published on its ENS name — PLAN_v4.3 §3.3.1.
// Loaded only by `await import()` from pay-or-refuse.ts or through "@vet402/sdk/ens".
//
// Steps (draft lines 110-118, one-to-one; `trace` always has these 7 entries):
//   0 pin block (not in trace) → 1 envelope → 2 manager → 3 record value → 4 payload
//   → 5 recover signer → 6 resolve attester name → 7 compare (+ freshness of t)
// then: valid count ≥ minValid, parse the offer, offer vs. request.
import { keccak256, namehash, recoverMessageAddress } from "viem";
import { attestationKey, bytesToHex, decodeEnvelope, encodePayload, profileOfVersion, } from "./atst-codec.js";
import { ENS_REASON_PRIORITY, } from "./ens-reasons.js";
import { EnsEvidenceUnavailable, ENS_SEPOLIA_CHAIN_ID, findExactOwner, getState, normalizeName, pinBlock, resolveAddr, resolveText, } from "./ens-read.js";
const DEFAULTS = { recordKey: "x402-offer", minValid: 1, maxAgeSeconds: 86_400, futureSkewSeconds: 300, maxHeadLagSeconds: 120 };
const ENDPOINT_KEY = "agent-endpoint[x402]";
const ALL_PROFILES = ["ensip29-draft", "atst-me-v2"];
const POLICY_KEYS = new Set(["recordKey", "trustedAttesters", "minValid", "maxAgeSeconds", "futureSkewSeconds", "maxHeadLagSeconds", "profiles", "sinceIssuanceScan", "now"]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lc = (s) => String(s ?? "").toLowerCase();
// ---------- policy ----------
function bad(msg) {
    throw new Error(`invalid_attestation_policy: ${msg}`);
}
function intIn(v, lo, hi, what) {
    if (!Number.isInteger(v) || v < lo || v > hi)
        bad(`${what} must be an integer in ${lo}..${hi} (got ${String(v)})`);
}
/** Throws `invalid_attestation_policy: …` before any network access if one field is off. */
export function assertEnsAttestationPolicy(p) {
    if (!p || typeof p !== "object" || Array.isArray(p))
        bad("policy must be an object");
    const o = p;
    for (const k of Object.keys(o))
        if (!POLICY_KEYS.has(k))
            bad(`unknown key ${JSON.stringify(k)}`);
    if (o.recordKey !== undefined && o.recordKey !== "x402-offer")
        bad(`recordKey must be "x402-offer"`);
    const recordKey = o.recordKey ?? DEFAULTS.recordKey;
    const ta = o.trustedAttesters;
    if (!Array.isArray(ta) || ta.length === 0)
        bad("trustedAttesters must be a non-empty array");
    for (const [i, a] of ta.entries()) {
        const x = a;
        if (!x || typeof x !== "object")
            bad(`trustedAttesters[${i}] must be an object`);
        if (typeof x.name !== "string" || x.name.length === 0 || !x.name.includes("."))
            bad(`trustedAttesters[${i}].name must be an ENS name`);
        if (typeof x.address !== "string" || !ADDRESS_RE.test(x.address))
            bad(`trustedAttesters[${i}].address must be a 20-byte hex address`);
        if (!Array.isArray(x.recordKeys) || x.recordKeys.length === 0 || !x.recordKeys.every((k) => typeof k === "string" && k.length > 0)) {
            bad(`trustedAttesters[${i}].recordKeys must be a non-empty array of strings`);
        }
        if (x.anchor !== undefined) {
            const an = x.anchor;
            if (!an || typeof an !== "object" || typeof an.name !== "string" || !an.name.includes(".") || typeof an.owner !== "string" || !ADDRESS_RE.test(an.owner)) {
                bad(`trustedAttesters[${i}].anchor must be {name, owner}`);
            }
        }
    }
    const trustedForKey = ta.filter((a) => a.recordKeys.includes(recordKey)).length;
    if (o.minValid !== undefined)
        intIn(o.minValid, 1, Math.max(1, trustedForKey), "minValid");
    if (trustedForKey < (o.minValid ?? DEFAULTS.minValid))
        bad(`no trusted attester for ${recordKey} can satisfy minValid`);
    if (o.maxAgeSeconds !== undefined)
        intIn(o.maxAgeSeconds, 60, 604_800, "maxAgeSeconds");
    if (o.futureSkewSeconds !== undefined)
        intIn(o.futureSkewSeconds, 0, 900, "futureSkewSeconds");
    if (o.maxHeadLagSeconds !== undefined)
        intIn(o.maxHeadLagSeconds, 30, 600, "maxHeadLagSeconds");
    if (o.profiles !== undefined) {
        const pr = o.profiles;
        if (!Array.isArray(pr) || pr.length === 0)
            bad("profiles must be a non-empty array");
        if (!pr.every((x) => ALL_PROFILES.includes(x)))
            bad(`profiles must be "ensip29-draft" or "atst-me-v2"`);
        if (new Set(pr).size !== pr.length)
            bad("profiles must not repeat");
    }
    if (o.sinceIssuanceScan !== undefined && o.sinceIssuanceScan !== false) {
        const s = o.sinceIssuanceScan;
        if (!s || typeof s !== "object")
            bad("sinceIssuanceScan must be false or {canary?}");
        if (s.canary !== undefined) {
            const c = s.canary;
            if (!c || typeof c.address !== "string" || !ADDRESS_RE.test(c.address) || typeof c.blockNumber !== "bigint" || typeof c.txHash !== "string") {
                bad("sinceIssuanceScan.canary needs address, blockNumber (bigint) and txHash");
            }
        }
        // Cut #2 (PLAN §7): the since-issuance scan is not in this build. Refuse loudly instead of
        // silently running without a check the caller asked for.
        bad("sinceIssuanceScan is not implemented in this build; pass false or omit it");
    }
    if (o.now !== undefined && typeof o.now !== "function")
        bad("now must be a function");
}
// ---------- offer ----------
function parseOffer(raw) {
    let o;
    try {
        o = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!o || typeof o !== "object" || Array.isArray(o))
        return null;
    if (o.v !== 1 || typeof o.resource !== "string" || (o.method !== "GET" && o.method !== "POST"))
        return null;
    if (typeof o.network !== "string" || typeof o.asset !== "string" || !ADDRESS_RE.test(o.asset))
        return null;
    if (typeof o.amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(o.amount))
        return null;
    if (typeof o.payTo !== "string" || !ADDRESS_RE.test(o.payTo))
        return null;
    if (o.output !== undefined) {
        if (!o.output || typeof o.output !== "object" || !Array.isArray(o.output.required) || !o.output.required.every((k) => typeof k === "string"))
            return null;
    }
    return o;
}
const NETWORK_SLUGS = { "base-sepolia": "eip155:84532", base: "eip155:8453" };
/**
 * Compare the promise on the name with the 402 the seller actually returned.
 * Accepts x402 v1 (`maxAmountRequired`, network slug) and v2 (`amount`, CAIP-2 network).
 */
export function compareOfferToAccept(o, a) {
    const out = [];
    if (!a || lc(a.payTo) !== lc(o.payTo))
        out.push("payee_mismatch");
    let price = null;
    try {
        const raw = a?.maxAmountRequired ?? a?.amount;
        price = raw === undefined || raw === null ? null : BigInt(raw);
    }
    catch {
        price = null;
    }
    if (price === null || price > BigInt(o.amount))
        out.push("price_above_declared");
    const net = NETWORK_SLUGS[String(a?.network)] ?? String(a?.network);
    if (net !== o.network || lc(a?.asset) !== lc(o.asset))
        out.push("chain_or_asset_mismatch");
    return out;
}
function buildTrace(fail, details) {
    const steps = [];
    for (let s = 1; s <= 7; s = (s + 1)) {
        if (fail && s === fail.step)
            steps.push({ step: s, status: "fail", detail: { ...(details[s] ?? {}), ...fail.detail } });
        else if (fail && s > fail.step)
            steps.push({ step: s, status: "skipped", detail: {} });
        else
            steps.push({ step: s, status: "ok", detail: details[s] ?? {} });
    }
    return steps;
}
function sortReasons(r) {
    return [...new Set(r)].sort((a, b) => ENS_REASON_PRIORITY[a] - ENS_REASON_PRIORITY[b]);
}
/**
 * Verify the ENSIP-29 attestation(s) on `name`'s `x402-offer` record and that the offer matches
 * the request. Reads only the two Sepolia RPCs in `clients` (no HTTP). Never throws for chain
 * state; throws `invalid_attestation_policy` for a bad policy (before any read).
 */
export async function checkEnsOffer(input) {
    const { resource, method, profile, clients, policy } = input;
    assertEnsAttestationPolicy(policy);
    const recordKey = policy.recordKey ?? DEFAULTS.recordKey;
    const minValid = policy.minValid ?? DEFAULTS.minValid;
    const maxAge = policy.maxAgeSeconds ?? DEFAULTS.maxAgeSeconds;
    const skew = policy.futureSkewSeconds ?? DEFAULTS.futureSkewSeconds;
    const maxLag = policy.maxHeadLagSeconds ?? DEFAULTS.maxHeadLagSeconds;
    const profiles = policy.profiles ?? ["ensip29-draft"];
    const now = Math.floor(policy.now ? policy.now() : Date.now() / 1000);
    const trusted = policy.trustedAttesters.filter((a) => a.recordKeys.includes(recordKey));
    const out = {
        ok: false, reason_codes: [], name: input.name, node: "0x", chainId: ENS_SEPOLIA_CHAIN_ID,
        block: { number: 0n, timestamp: 0n }, heads: { primary: 0n, secondary: 0n },
        manager: null, offerRaw: null, offer: null, endpoint: null, attestations: [], trace: [],
    };
    const details = {};
    const finish = (reasons, fail) => {
        out.reason_codes = sortReasons(reasons);
        out.ok = out.reason_codes.length === 0;
        out.trace = buildTrace(out.ok ? null : fail, details);
        return out;
    };
    let name;
    try {
        name = normalizeName(input.name);
    }
    catch (e) {
        return finish(["ens_name_unresolved"], { step: 1, detail: { reason: "ens_name_unresolved", error: `not a valid ENS name: ${e.message}`.slice(0, 200) } });
    }
    out.name = name;
    out.node = namehash(name);
    const works = trusted.map((cfg) => ({
        cfg,
        result: { attester: cfg.name, profile: null, t: null, recovered: null, expected: cfg.address, payloadHex: null, digest: null, valid: false, reason: null },
        envRaw: "", env: null, resolved: null, anchorOwner: undefined, failStep: 1, details: {},
    }));
    out.attestations = works.map((w) => w.result);
    // ---- reads (all at the pinned block, on both RPCs) ----
    let stage = 1;
    try {
        const pin = await pinBlock(clients, maxLag, now);
        out.block = { number: pin.B, timestamp: pin.ts };
        out.heads = pin.heads;
        const B = pin.B;
        stage = 1;
        for (const w of works)
            w.envRaw = (await resolveText(clients, B, name, attestationKey(recordKey, w.cfg.name))).value;
        const anyEnvelope = works.some((w) => w.envRaw && !("error" in decodeEnvelope(w.envRaw)));
        stage = 2;
        const owner = await findExactOwner(clients, B, name);
        out.manager = owner;
        const unresolved = (error) => finish(["ens_name_unresolved"], { step: anyEnvelope ? 2 : 1, detail: { reason: "ens_name_unresolved", error } });
        if (!owner)
            return unresolved("findExactOwner returned 0x0 (unregistered, expired, reserved or an unregistered subname)");
        const labels = name.split(".");
        if (labels.length === 2 && labels[1] === "eth") {
            const st = await getState(clients, B, labels[0]);
            if (st.status !== 2 || lc(st.latestOwner) !== lc(owner)) {
                return unresolved(`ETHRegistry.getState: status ${st.status}, latestOwner ${st.latestOwner}; findExactOwner ${owner}`);
            }
        }
        stage = 3;
        const offer = await resolveText(clients, B, name, recordKey);
        out.offerRaw = offer.value;
        const ep = await resolveText(clients, B, name, ENDPOINT_KEY);
        out.endpoint = ep.value;
        stage = 6;
        for (const w of works) {
            if (!w.envRaw || out.offerRaw === "")
                continue;
            const d = decodeEnvelope(w.envRaw);
            if ("error" in d || !profiles.includes(profileOfVersion(d.version)))
                continue;
            w.resolved = (await resolveAddr(clients, B, w.cfg.name)).value;
            if (w.cfg.anchor)
                w.anchorOwner = await findExactOwner(clients, B, normalizeName(w.cfg.anchor.name));
        }
    }
    catch (e) {
        if (e instanceof EnsEvidenceUnavailable) {
            return finish(["ens_evidence_unavailable"], { step: stage, detail: { reason: "ens_evidence_unavailable", error: e.message.slice(0, 300) } });
        }
        throw e;
    }
    details[2] = { manager: String(out.manager), block: String(out.block.number) };
    details[3] = { key: recordKey, bytes: String(new TextEncoder().encode(out.offerRaw ?? "").length), endpoint: out.endpoint ?? "" };
    // ---- per attester: steps 1, 4, 5, 6, 7 ----
    for (const w of works) {
        const r = w.result;
        const fail = (step, reason, d) => {
            w.failStep = step;
            r.reason = reason;
            w.details[step] = { ...(w.details[step] ?? {}), ...(reason ? { reason } : {}), ...d };
        };
        const key = attestationKey(recordKey, w.cfg.name);
        w.details[1] = { attester: w.cfg.name, key };
        if (!w.envRaw) {
            fail(1, "ens_attestation_missing", { error: "no envelope under this key" });
            continue;
        }
        const d = decodeEnvelope(w.envRaw);
        if ("error" in d) {
            fail(1, "ens_attestation_malformed", { error: d.error });
            continue;
        }
        const prof = profileOfVersion(d.version);
        if (!profiles.includes(prof)) {
            fail(1, "ens_attestation_malformed", { error: `envelope version ${d.version} (${prof}) is not in profiles [${profiles.join(",")}]` });
            continue;
        }
        w.env = d;
        r.profile = prof;
        r.t = d.t;
        w.details[1] = { ...w.details[1], encoding: w.envRaw.startsWith("0x") ? "hex" : "base64", version: String(d.version), t: String(d.t) };
        if (out.offerRaw === "") {
            w.failStep = 3;
            continue;
        }
        let payload;
        try {
            payload = encodePayload({ n: name, a: out.manager, k: recordKey, v: out.offerRaw, t: d.t }, prof);
        }
        catch (e) {
            fail(4, "ens_attestation_malformed", { error: e.message.slice(0, 200) });
            continue;
        }
        r.payloadHex = bytesToHex(payload);
        w.details[4] = { profile: prof, payloadBytes: String(payload.length) };
        r.digest = keccak256(payload);
        try {
            r.recovered = await recoverMessageAddress({ message: { raw: r.digest }, signature: d.sig });
        }
        catch (e) {
            fail(5, "ens_attestation_malformed", { digest: r.digest, error: e.message.slice(0, 200) });
            continue;
        }
        w.details[5] = { digest: r.digest, recovered: r.recovered };
        w.details[6] = { attester: w.cfg.name, pinned: w.cfg.address, resolved: String(w.resolved) };
        if (w.resolved === null) {
            fail(6, "ens_attester_unresolved", { error: `${w.cfg.name} has no addr` });
            continue;
        }
        if (lc(w.resolved) !== lc(w.cfg.address)) {
            fail(6, "ens_attester_unpinned", { error: `${w.cfg.name} resolves to ${w.resolved}, pinned ${w.cfg.address}` });
            continue;
        }
        if (w.cfg.anchor && lc(w.anchorOwner) !== lc(w.cfg.anchor.owner)) {
            fail(6, "ens_attester_anchor_changed", { error: `owner of ${w.cfg.anchor.name} is ${String(w.anchorOwner)}, pinned ${w.cfg.anchor.owner}` });
            continue;
        }
        if (lc(r.recovered) !== lc(w.resolved)) {
            fail(7, "ens_attestation_signer_mismatch", { recovered: r.recovered, expected: w.resolved });
            continue;
        }
        if (now - d.t > maxAge) {
            fail(7, "ens_attestation_stale", { error: `issued ${now - d.t}s ago (max ${maxAge}s)` });
            continue;
        }
        if (d.t - now > skew) {
            fail(7, "ens_attestation_stale", { error: `issued ${d.t - now}s in the future (max skew ${skew}s)` });
            continue;
        }
        r.valid = true;
        w.failStep = 8;
        w.details[7] = { signer: "matches attester", t: String(d.t), ageSeconds: String(now - d.t) };
    }
    // The attester that got furthest provides the per-step details of the trace.
    const best = works.reduce((b, w) => (b === null || w.failStep > b.failStep ? w : b), null);
    for (const s of [1, 4, 5, 6, 7])
        if (best?.details[s])
            details[s] = best.details[s];
    const validCount = works.filter((w) => w.result.valid).length;
    if (out.offerRaw === "") {
        const step = Math.min(best?.failStep ?? 1, 3);
        return finish(["ens_offer_missing"], { step, detail: step === 3 ? { reason: "ens_offer_missing", error: `${recordKey} is empty` } : { alsoEmpty: `${recordKey} (ens_offer_missing ranks first in reason_codes)` } });
    }
    const reasons = [];
    let fail = null;
    if (validCount < minValid) {
        for (const w of works)
            if (!w.result.valid && w.result.reason)
                reasons.push(w.result.reason);
        if (reasons.length === 0)
            reasons.push("ens_attestation_missing");
        const step = Math.min(best?.failStep ?? 1, 7);
        fail = { step, detail: step === 7 && best?.failStep === 8 ? { reason: "ens_attestation_missing", error: `${validCount} valid < minValid ${minValid}` } : {} };
    }
    const offer = parseOffer(out.offerRaw);
    out.offer = offer;
    if (!offer) {
        reasons.push("ens_offer_malformed");
        fail ??= { step: 7, detail: { reason: "ens_offer_malformed", error: `${recordKey} is not a valid x402 offer JSON` } };
    }
    else {
        const why = [];
        if (offer.resource !== resource)
            why.push(`resource ${offer.resource} ≠ ${resource}`);
        if (offer.method !== method)
            why.push(`method ${offer.method} ≠ ${method}`);
        if (out.endpoint !== offer.resource)
            why.push(`${ENDPOINT_KEY} ${JSON.stringify(out.endpoint)} ≠ offer.resource`);
        if (offer.network !== profile.network)
            why.push(`network ${offer.network} ≠ ${profile.network}`);
        if (lc(offer.asset) !== lc(profile.asset))
            why.push(`asset ${offer.asset} ≠ ${profile.asset}`);
        if (why.length) {
            reasons.push("ens_offer_mismatch");
            fail ??= { step: 7, detail: { reason: "ens_offer_mismatch", error: why.join("; ").slice(0, 300) } };
        }
    }
    if (validCount >= minValid)
        details[7] = { ...(details[7] ?? {}), valid: `${validCount}/${minValid}` };
    return finish(reasons, fail);
}

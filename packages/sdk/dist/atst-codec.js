// ENSIP-29 (draft PR #85, head e00c345) encoder / decoder — PLAN_v4.3 §3.1.
// Pure functions. No viem, no Buffer, no other dependency: only TextEncoder / TextDecoder,
// which exist in every runtime this SDK supports.
//
// - payload: canonical DAG-CBOR map with 5 keys. Keys sort by length, then bytewise
//   (ensip29-draft: a,k,n,t,v / atst-me-v2: a,h,n,p,t). `a` is 20 raw bytes, not text.
// - envelope: CBOR tag 1635021684 (0xDA 61 74 73 74 = "atst") around [version, t, sig(65 bytes)].
// - record values: "0x"-prefixed hex, anything else is base64 (draft line 104).
export const ATST_TAG = 1635021684;
const TAG_HEAD = [0xda, 0x61, 0x74, 0x73, 0x74];
const SIG_LEN = 65;
const utf8 = new TextEncoder();
// ---------- hex / base64 ----------
export function bytesToHex(b) {
    let s = "0x";
    for (let i = 0; i < b.length; i++)
        s += b[i].toString(16).padStart(2, "0");
    return s;
}
export function hexToBytes(h) {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(h))
        throw new Error(`not 0x-prefixed even-length hex`);
    const out = new Uint8Array((h.length - 2) / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(h.slice(2 + i * 2, 4 + i * 2), 16);
    return out;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = Object.fromEntries([...B64].map((c, i) => [c, i]));
function bytesToBase64(b) {
    let out = "";
    for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
        out += i + 1 < b.length ? B64[(n >> 6) & 63] : "=";
        out += i + 2 < b.length ? B64[n & 63] : "=";
    }
    return out;
}
/** Strict standard base64 (RFC 4648 §4). Padding is optional; any other character is an error. */
function base64ToBytes(s) {
    const body = s.replace(/=+$/, "");
    if (s.length - body.length > 2 || body.length % 4 === 1)
        throw new Error("bad base64 length");
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const c of body) {
        const v = B64_INDEX[c];
        if (v === undefined)
            throw new Error("bad base64 character");
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}
// ---------- keccak256 (pure; only for the atst-me-v2 `h` field) ----------
const MASK64 = (1n << 64n) - 1n;
const KECCAK_RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// rotation offsets, index x + 5y
const KECCAK_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl64 = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64);
function keccakF(s) {
    const c = new Array(5);
    const b = new Array(25);
    for (let round = 0; round < 24; round++) {
        for (let x = 0; x < 5; x++)
            c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
        for (let x = 0; x < 5; x++) {
            const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
            for (let y = 0; y < 25; y += 5)
                s[x + y] ^= d;
        }
        for (let x = 0; x < 5; x++)
            for (let y = 0; y < 5; y++)
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], KECCAK_ROT[x + 5 * y]);
        for (let y = 0; y < 25; y += 5)
            for (let x = 0; x < 5; x++)
                s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y]);
        s[0] ^= KECCAK_RC[round];
    }
}
/** keccak256 (Ethereum's, i.e. pre-FIPS padding 0x01). */
export function keccak256Bytes(data) {
    const rate = 136;
    const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
    padded.set(data);
    padded[data.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    const s = new Array(25).fill(0n);
    for (let off = 0; off < padded.length; off += rate) {
        for (let i = 0; i < rate / 8; i++) {
            let lane = 0n;
            for (let j = 7; j >= 0; j--)
                lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
            s[i] ^= lane;
        }
        keccakF(s);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
        let lane = s[i];
        for (let j = 0; j < 8; j++) {
            out[i * 8 + j] = Number(lane & 0xffn);
            lane >>= 8n;
        }
    }
    return out;
}
// ---------- minimal DAG-CBOR encoder ----------
function head(major, n) {
    if (!Number.isSafeInteger(n) || n < 0)
        throw new Error(`cbor: bad length/uint ${n}`);
    const m = major << 5;
    if (n < 24)
        return [m | n];
    if (n < 0x100)
        return [m | 24, n];
    if (n < 0x10000)
        return [m | 25, n >> 8, n & 0xff];
    if (n < 0x100000000)
        return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    const big = BigInt(n);
    const out = [m | 27];
    for (let i = 7; i >= 0; i--)
        out.push(Number((big >> BigInt(i * 8)) & 0xffn));
    return out;
}
function encodeValue(x) {
    if (x.kind === "uint")
        return head(0, x.v);
    if (x.kind === "bytes")
        return [...head(2, x.v.length), ...x.v];
    const b = utf8.encode(x.v);
    return [...head(3, b.length), ...b];
}
/** DAG-CBOR map: keys sorted by encoded length, then bytewise (RFC 7049 canonical / dag-cbor). */
function encodeMap(entries) {
    const enc = entries.map(([k, v]) => ({ key: Uint8Array.from(encodeValue({ kind: "text", v: k })), val: encodeValue(v) }));
    enc.sort((p, q) => {
        if (p.key.length !== q.key.length)
            return p.key.length - q.key.length;
        for (let i = 0; i < p.key.length; i++)
            if (p.key[i] !== q.key[i])
                return p.key[i] - q.key[i];
        return 0;
    });
    const out = [...head(5, enc.length)];
    for (const e of enc)
        out.push(...e.key, ...e.val);
    return Uint8Array.from(out);
}
function addressBytes(a) {
    if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a))
        throw new Error(`payload.a is not a 20-byte address: ${String(a)}`);
    return hexToBytes(a.toLowerCase());
}
function checkT(t) {
    if (!Number.isSafeInteger(t) || t < 0)
        throw new Error(`payload.t must be a non-negative integer (unix seconds): ${String(t)}`);
    return t;
}
/**
 * Canonical payload bytes. The signature covers keccak256 of exactly these bytes (draft line 66).
 * - ensip29-draft: { n, a, k, v, t }
 * - atst-me-v2 (0xLighthouse/ens-metadata@07ded0e2): { n, a, p = k, h = keccak256(utf8(v)), t }
 *   [the p/h reading is unconfirmed at the source; see PLAN_v4.3 §2.3 Q2]
 */
export function encodePayload(p, profile) {
    if (typeof p.n !== "string" || typeof p.k !== "string" || typeof p.v !== "string")
        throw new Error("payload n/k/v must be strings");
    const a = { kind: "bytes", v: addressBytes(p.a) };
    const n = { kind: "text", v: p.n };
    const t = { kind: "uint", v: checkT(p.t) };
    if (profile === "ensip29-draft") {
        return encodeMap([["n", n], ["a", a], ["k", { kind: "text", v: p.k }], ["v", { kind: "text", v: p.v }], ["t", t]]);
    }
    if (profile === "atst-me-v2") {
        return encodeMap([["n", n], ["a", a], ["p", { kind: "text", v: p.k }], ["h", { kind: "bytes", v: keccak256Bytes(utf8.encode(p.v)) }], ["t", t]]);
    }
    throw new Error(`unknown attestation profile: ${String(profile)}`);
}
/** Envelope as it is stored in the text record: "0x…" hex or standard base64. */
export function encodeEnvelope(e, encoding) {
    if (e.version !== 1 && e.version !== 2)
        throw new Error(`envelope version must be 1 or 2: ${String(e.version)}`);
    const sig = hexToBytes(e.sig);
    if (sig.length !== SIG_LEN)
        throw new Error(`envelope sig must be ${SIG_LEN} bytes, got ${sig.length}`);
    const bytes = Uint8Array.from([...TAG_HEAD, ...head(4, 3), ...head(0, e.version), ...head(0, checkT(e.t)), ...head(2, SIG_LEN), ...sig]);
    if (encoding === "hex")
        return bytesToHex(bytes);
    if (encoding === "base64")
        return bytesToBase64(bytes);
    throw new Error(`unknown envelope encoding: ${String(encoding)}`);
}
// ---------- envelope decoder ----------
function readHead(b, pos) {
    if (pos >= b.length)
        throw new Error("truncated");
    const major = b[pos] >> 5;
    const info = b[pos] & 0x1f;
    if (info < 24)
        return { major, value: info, next: pos + 1 };
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (len < 0)
        throw new Error(`unsupported additional info ${info}`);
    if (pos + 1 + len > b.length)
        throw new Error("truncated");
    let v = 0n;
    for (let i = 0; i < len; i++)
        v = (v << 8n) | BigInt(b[pos + 1 + i]);
    if (v > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("integer too large");
    return { major, value: Number(v), next: pos + 1 + len };
}
const malformed = (why) => ({ error: `ens_attestation_malformed: ${why}` });
/**
 * Decode an envelope record value. "0x" prefix → hex, anything else → base64 (draft line 104).
 * Returns `{ error: "ens_attestation_malformed: …" }` for a wrong tag, not exactly 3 elements,
 * a version other than 1/2, a signature that is not 65 bytes, or trailing bytes.
 * Whether a given version is accepted is the caller's policy (`profiles`), not the decoder's.
 */
export function decodeEnvelope(recordValue) {
    if (typeof recordValue !== "string" || recordValue.length === 0)
        return malformed("empty value");
    let b;
    try {
        b = recordValue.startsWith("0x") ? hexToBytes(recordValue) : base64ToBytes(recordValue);
    }
    catch (e) {
        return malformed(`undecodable ${recordValue.startsWith("0x") ? "hex" : "base64"} (${e.message})`);
    }
    try {
        for (let i = 0; i < TAG_HEAD.length; i++)
            if (b[i] !== TAG_HEAD[i])
                return malformed("tag is not 1635021684 (0xDA61747374)");
        let pos = TAG_HEAD.length;
        const arr = readHead(b, pos);
        if (arr.major !== 4)
            return malformed("tag content is not an array");
        if (arr.value !== 3)
            return malformed(`array has ${arr.value} elements, expected 3`);
        pos = arr.next;
        const ver = readHead(b, pos);
        if (ver.major !== 0)
            return malformed("version is not an unsigned integer");
        if (ver.value !== 1 && ver.value !== 2)
            return malformed(`unknown envelope version ${ver.value}`);
        pos = ver.next;
        const t = readHead(b, pos);
        if (t.major !== 0)
            return malformed("t is not an unsigned integer");
        pos = t.next;
        const sig = readHead(b, pos);
        if (sig.major !== 2)
            return malformed("signature is not a byte string");
        if (sig.value !== SIG_LEN)
            return malformed(`signature is ${sig.value} bytes, expected ${SIG_LEN}`);
        pos = sig.next;
        if (pos + SIG_LEN !== b.length)
            return malformed(pos + SIG_LEN > b.length ? "truncated signature" : "trailing bytes after envelope");
        return { version: ver.value, t: t.value, sig: bytesToHex(b.subarray(pos, pos + SIG_LEN)) };
    }
    catch (e) {
        return malformed(e.message);
    }
}
/** Text record key of an attestation: `attestations[RECORD_KEY][ATTESTER_NAME]` (draft lines 92-100). */
export function attestationKey(recordKey, attesterName) {
    return `attestations[${recordKey}][${attesterName}]`;
}
/** Envelope version → payload profile. */
export function profileOfVersion(version) {
    return version === 1 ? "ensip29-draft" : "atst-me-v2";
}

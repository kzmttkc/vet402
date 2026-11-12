// ============================================================
// E5 seller edge. One call beside the seller's own payment check.
// vet402 does not settle the payment and does not receive the funds.
// The seller's facilitator stays the facilitator. This file only compares
// that receipt with a chain read the seller supplies, then signs the body
// hash with the seller's own signer.
//
// Kept separate from the counterparty score gate and from the buyer read hook.
// ============================================================
import { createHash } from "node:crypto";
export const SELLER_EDGE_TARGET_P95_MS = 20;
export const DELIVERY_PROOF_HEADER = "X-Vet402-Delivery-Proof";
export const DELIVERY_HASH_HEADER = "X-Vet402-Body-Hash";
export class SellerEdgeError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "SellerEdgeError";
    }
}
const CANONICAL_AMOUNT = /^(0|[1-9][0-9]*)$/;
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const EVM_TX = /^0x[a-fA-F0-9]{64}$/;
const PURCHASE_ID = /^[A-Za-z0-9-]{1,64}$/;
export function deliveryBodyHash(body) {
    return createHash("sha256").update(body, "utf8").digest("hex");
}
function formatMs(n) {
    return String(Math.round(n * 1000) / 1000);
}
/** Publish the measured p95. Fewer than 20 samples does not claim the target. */
export function reportSellerEdgeLatency(samples) {
    const overheadMs = samples.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
    if (overheadMs.length < 20) {
        return {
            samples: overheadMs.length,
            overheadMs: [...overheadMs],
            measuredP95Ms: null,
            targetP95Ms: SELLER_EDGE_TARGET_P95_MS,
            targetMet: false,
            statement: `vet402 has ${overheadMs.length} seller edge overhead samples. The minimum to publish a p95 is 20. vet402 does not claim the 20 ms target.`,
        };
    }
    const sorted = [...overheadMs].sort((a, b) => a - b);
    const measuredP95Ms = sorted[Math.ceil(0.95 * sorted.length) - 1];
    const targetMet = measuredP95Ms <= SELLER_EDGE_TARGET_P95_MS;
    const relation = targetMet ? "at or under the target" : "above the target";
    return {
        samples: overheadMs.length,
        overheadMs: [...overheadMs],
        measuredP95Ms,
        targetP95Ms: SELLER_EDGE_TARGET_P95_MS,
        targetMet,
        statement: `vet402 measured seller edge overhead at p95 ${formatMs(measuredP95Ms)} ms over ${overheadMs.length} samples. The target is 20 ms. This measurement is ${relation}.`,
    };
}
function memoryReplay() {
    const seen = new Set();
    return {
        has: (key) => seen.has(key),
        add: (key) => {
            seen.add(key);
        },
        delete: (key) => {
            seen.delete(key);
        },
    };
}
function normalizeTx(tx) {
    return EVM_TX.test(tx) ? tx.toLowerCase() : tx;
}
function sameTx(a, b) {
    return a.length > 0 && b.length > 0 && normalizeTx(a) === normalizeTx(b);
}
function sameAddr(a, b) {
    if (EVM_ADDR.test(a) && EVM_ADDR.test(b))
        return a.toLowerCase() === b.toLowerCase();
    return a === b;
}
function refuse(reason, status, sellerMiss) {
    return {
        status,
        body: JSON.stringify({ error: reason }),
        headers: {},
        delivered: false,
        reason,
        sellerMiss,
    };
}
function amountReason(value, expected) {
    if (typeof value !== "string" || !CANONICAL_AMOUNT.test(value) || value !== expected)
        return "amount_mismatch";
    return null;
}
function destinationReason(value, expected) {
    if (typeof value !== "string" || !sameAddr(value, expected))
        return "destination_mismatch";
    return null;
}
function assetReason(value, expected) {
    if (typeof value !== "string" || !sameAddr(value, expected))
        return "asset_mismatch";
    return null;
}
function networkReason(value, expected) {
    if (value !== expected)
        return "network_mismatch";
    return null;
}
function isDeliveredBody(status, body) {
    return status >= 200 && status <= 299 && status !== 202 && body.length > 0;
}
/** 4xx and 202 are holds. Empty or 5xx after a valid payment is a seller miss. */
function missForStatus(status) {
    if (status >= 400 && status <= 499)
        return false;
    if (status === 202)
        return false;
    if (status >= 500 && status <= 599)
        return true;
    if (status >= 200 && status <= 299)
        return true;
    return false;
}
export function createSellerEdge(config) {
    if (config === null || typeof config !== "object") {
        throw new SellerEdgeError("config is required", "missing_config");
    }
    const offerIn = config.offer;
    if (offerIn === null || typeof offerIn !== "object") {
        throw new SellerEdgeError("offer is required", "missing_offer");
    }
    if (typeof offerIn.amount !== "string" || !CANONICAL_AMOUNT.test(offerIn.amount)) {
        throw new SellerEdgeError("offer.amount must be a canonical integer string", "invalid_offer");
    }
    if (typeof offerIn.payTo !== "string" || offerIn.payTo.length === 0) {
        throw new SellerEdgeError("offer.payTo is required", "invalid_offer");
    }
    if (typeof offerIn.asset !== "string" || offerIn.asset.length === 0) {
        throw new SellerEdgeError("offer.asset is required", "invalid_offer");
    }
    if (typeof offerIn.network !== "string" || offerIn.network.length === 0) {
        throw new SellerEdgeError("offer.network is required", "invalid_offer");
    }
    if (typeof config.readChain !== "function") {
        throw new SellerEdgeError("readChain is required", "missing_read_chain");
    }
    if (typeof config.signDelivery !== "function") {
        throw new SellerEdgeError("signDelivery is required", "missing_sign_delivery");
    }
    if (typeof config.recordE6 !== "function") {
        throw new SellerEdgeError("recordE6 is required", "missing_record_e6");
    }
    const offer = {
        amount: offerIn.amount,
        payTo: offerIn.payTo,
        asset: offerIn.asset,
        network: offerIn.network,
    };
    const readChain = config.readChain;
    const signDeliveryFn = config.signDelivery;
    const recordE6 = config.recordE6;
    const clock = typeof config.clock === "function" ? config.clock : () => performance.now();
    const replay = config.replay ?? memoryReplay();
    const samples = [];
    function bad(result) {
        return { ok: false, result };
    }
    async function evaluate(request) {
        const receipt = request.receipt;
        if (receipt === null || receipt.valid !== true)
            return bad(refuse("payment_fake", 402, false));
        if (typeof receipt.txHash !== "string" || receipt.txHash.length === 0)
            return bad(refuse("payment_fake", 402, false));
        const receiptAmount = amountReason(receipt.amount, offer.amount);
        if (receiptAmount)
            return bad(refuse(receiptAmount, 402, false));
        const receiptDest = destinationReason(receipt.payTo, offer.payTo);
        if (receiptDest)
            return bad(refuse(receiptDest, 402, false));
        const receiptAsset = assetReason(receipt.asset, offer.asset);
        if (receiptAsset)
            return bad(refuse(receiptAsset, 402, false));
        const receiptNetwork = networkReason(receipt.network, offer.network);
        if (receiptNetwork)
            return bad(refuse(receiptNetwork, 402, false));
        let chain;
        try {
            chain = await readChain(receipt.txHash);
        }
        catch {
            return bad(refuse("chain_unreadable", 503, false));
        }
        if (chain === null || typeof chain.txHash !== "string" || !sameTx(chain.txHash, receipt.txHash)) {
            return bad(refuse("payment_fake", 402, false));
        }
        const chainAmount = amountReason(chain.amount, offer.amount);
        if (chainAmount)
            return bad(refuse(chainAmount, 402, false));
        const chainDest = destinationReason(chain.payTo, offer.payTo);
        if (chainDest)
            return bad(refuse(chainDest, 402, false));
        const chainAsset = assetReason(chain.asset, offer.asset);
        if (chainAsset)
            return bad(refuse(chainAsset, 402, false));
        const chainNetwork = networkReason(chain.network, offer.network);
        if (chainNetwork)
            return bad(refuse(chainNetwork, 402, false));
        const replayKey = `${offer.network}\n${normalizeTx(receipt.txHash)}`;
        if (await replay.has(replayKey))
            return bad(refuse("payment_replay", 409, false));
        if (typeof request.purchaseId !== "string" || !PURCHASE_ID.test(request.purchaseId)) {
            return bad(refuse("missing_purchase_id", 400, false));
        }
        return { ok: true, txHash: receipt.txHash, replayKey };
    }
    async function finish(ready, purchaseId, produced) {
        if (!isDeliveredBody(produced.status, produced.body)) {
            await replay.delete(ready.replayKey);
            const held = produced.status >= 400 && produced.status <= 499;
            return {
                status: produced.status,
                body: produced.body,
                headers: { ...(produced.headers ?? {}) },
                delivered: false,
                reason: held ? "seller_hold" : "not_delivered",
                sellerMiss: missForStatus(produced.status),
            };
        }
        const bodyHash = deliveryBodyHash(produced.body);
        let signature;
        try {
            const signed = await signDeliveryFn(bodyHash);
            if (typeof signed !== "string" || signed.length === 0) {
                throw new SellerEdgeError("empty delivery signature", "empty_signature");
            }
            signature = signed;
        }
        catch {
            await replay.delete(ready.replayKey);
            return refuse("proof_failed", 503, false);
        }
        try {
            await recordE6({
                purchaseId,
                seller: {
                    paymentVerified: ready.txHash,
                    deliveredBodyHash: bodyHash,
                    deliverySignature: signature,
                    vet402Middleware: true,
                },
            });
        }
        catch {
            await replay.delete(ready.replayKey);
            return refuse("record_failed", 503, false);
        }
        return {
            status: produced.status,
            body: produced.body,
            headers: {
                ...(produced.headers ?? {}),
                [DELIVERY_PROOF_HEADER]: signature,
                [DELIVERY_HASH_HEADER]: bodyHash,
            },
            delivered: true,
            reason: "ok",
            sellerMiss: false,
        };
    }
    return {
        async run(request, handler) {
            const t0 = clock();
            const decision = await evaluate(request);
            if (!decision.ok) {
                samples.push(Math.max(0, clock() - t0));
                return decision.result;
            }
            await replay.add(decision.replayKey);
            const t1 = clock();
            let produced;
            try {
                produced = await handler();
            }
            catch {
                await replay.delete(decision.replayKey);
                samples.push(Math.max(0, clock() - t0));
                return refuse("seller_handler_failed", 503, true);
            }
            const t2 = clock();
            const finished = await finish(decision, request.purchaseId, produced);
            const t3 = clock();
            samples.push(Math.max(0, t1 - t0) + Math.max(0, t3 - t2));
            return finished;
        },
        latency() {
            return reportSellerEdgeLatency(samples);
        },
    };
}

// ============================================================
// check_resource_decision の入口（2026-09-29 敵対的監査・初見の開発者）。
//
// なぜ要るか: このツールは sha256 の resourceId しか受けなかった。初見の開発者（とモデル）が
// 手に持っているのは 402 を返した URL であって、sha256(method + " " + canonical_url) ではない。
// 自分で /resolve を叩いて id を作る手順は説明文の中にしか無く、しかも存在しない id を渡すと
// サーバの 404 `not_found` が許可リストに無いので `request_failed` に潰れ、
// 「カタログに無い」のか「上流が落ちた」のか区別できなかった。
//
// ここでは:
//   - url を受けたら /resolve で resource_id を引いてから /decision を呼ぶ
//   - /resolve が resource を返さない URL、/decision が 404 を返す id は
//     「カタログに無い」と分かる応答（REFUSE・resource_uncatalogued）にする
// 「カタログに無い」は ALLOW ではない。判定の材料が無いので REFUSE のまま。
// ============================================================
import { fetchDecision, resolveQuery, VouchApiError, } from "./vouch-client.js";
const SHA256_RE = /^[0-9a-f]{64}$/;
/** 呼び手の誤り。メッセージは我々が組み立てる（上流の文字列を含まない）ので tool-errors がそのまま通す。 */
export const INVALID_TARGET_PREFIX = "invalid_target:";
/** 入力を検査する。どちらか片方だけ。URL は http(s) の絶対 URL に限る。 */
export function assertTarget(target) {
    const hasId = typeof target.resourceId === "string" && target.resourceId.length > 0;
    const hasUrl = typeof target.url === "string" && target.url.length > 0;
    if (hasId && hasUrl) {
        throw new Error(`${INVALID_TARGET_PREFIX} pass resourceId or url, not both`);
    }
    if (!hasId && !hasUrl) {
        throw new Error(`${INVALID_TARGET_PREFIX} pass resourceId (sha256) or url (the URL that answers 402)`);
    }
    if (hasId) {
        if (!SHA256_RE.test(target.resourceId)) {
            throw new Error(`${INVALID_TARGET_PREFIX} resourceId must be 64 lowercase hex characters; pass the URL as url instead`);
        }
        return { resourceId: target.resourceId };
    }
    let parsed;
    try {
        parsed = new URL(target.url);
    }
    catch {
        throw new Error(`${INVALID_TARGET_PREFIX} url must be an absolute https URL`);
    }
    // 2026-09-29: vet402 の resolve は https だけを受け付ける（http は 400）。ここで先に弾き、
    // 利用者に直し方を同じ語で返す（400 の本文の message は vouchFetch が運ばないため）。
    if (parsed.protocol !== "https:") {
        throw new Error(`${INVALID_TARGET_PREFIX} url must be an absolute https URL`);
    }
    return { url: target.url };
}
export function uncatalogued(lookup, candidates = []) {
    const what = lookup.url ? `The URL ${lookup.url}` : `The resource id ${lookup.resourceId}`;
    return {
        decision: "REFUSE",
        safe_to_pay: false,
        refuse_reasons: ["resource_uncatalogued"],
        not_in_catalog: true,
        summary: `${what} is not in vet402's catalog, so vet402 has no L0–L2 record to decide from. ` +
            "Not in the catalog is not an ALLOW. pay_if_trusted can still judge an uncatalogued seller " +
            "from the 402's payTo and the payee score when you pass it resource and payee.",
        lookup: {
            resourceId: lookup.resourceId,
            url: lookup.url,
            canonical_url: lookup.canonicalUrl,
            same_host_candidates: candidates.slice(0, 5).map((e) => ({
                resource_id: e.resource_id,
                canonical_url: e.canonical_url,
                method: e.method,
            })),
        },
    };
}
/**
 * url なら /resolve → resource_id、id ならそのまま。/decision の 404 は「カタログに無い」に写す。
 * それ以外の失敗は throw のまま（呼び手の scoreToolFailure が REFUSE に写す）。
 */
export async function resourceDecision(target, query) {
    const checked = assertTarget(target);
    let resourceId;
    let resolvedFrom = null;
    let canonical = null;
    if ("url" in checked) {
        const resolved = await resolveQuery(checked.url);
        const hit = resolved.resource;
        if (!hit || !hit.resource_id) {
            return {
                kind: "uncatalogued",
                body: uncatalogued({ resourceId: null, url: checked.url, canonicalUrl: null }, resolved.endpoints ?? []),
            };
        }
        resourceId = hit.resource_id;
        resolvedFrom = checked.url;
        canonical = hit.canonical_url;
    }
    else {
        resourceId = checked.resourceId;
    }
    try {
        const result = await fetchDecision(resourceId, query);
        return { kind: "decision", resourceId, resolvedFrom, result };
    }
    catch (error) {
        if (error instanceof VouchApiError && error.message === "not_found") {
            return {
                kind: "uncatalogued",
                body: uncatalogued({ resourceId, url: resolvedFrom, canonicalUrl: canonical }),
            };
        }
        throw error;
    }
}

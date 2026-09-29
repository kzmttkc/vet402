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
import {
  fetchDecision,
  resolveQuery,
  VouchApiError,
  type DecisionQuery,
  type DecisionResult,
  type ResolveEndpointRef,
} from "./vouch-client.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

/** 呼び手の誤り。メッセージは我々が組み立てる（上流の文字列を含まない）ので tool-errors がそのまま通す。 */
export const INVALID_TARGET_PREFIX = "invalid_target:";

export type ResourceTarget = { resourceId?: string; url?: string };

/** カタログに無いときの応答。decision / safe_to_pay を先頭に置く形は他のツールと同じ。 */
export type UncataloguedResult = {
  decision: "REFUSE";
  safe_to_pay: false;
  refuse_reasons: ["resource_uncatalogued"];
  not_in_catalog: true;
  summary: string;
  lookup: {
    resourceId: string | null;
    url: string | null;
    /** /resolve が url から作った正規形（URL を渡したときだけ）。 */
    canonical_url: string | null;
    /** 同じホストでカタログに載っている endpoint（最大 5 件）。打ち間違いの手がかり。 */
    same_host_candidates: { resource_id: string | null; canonical_url: string; method: string }[];
  };
};

export type ResourceDecisionOutcome =
  | { kind: "decision"; resourceId: string; resolvedFrom: string | null; result: DecisionResult }
  | { kind: "uncatalogued"; body: UncataloguedResult };

/** 入力を検査する。どちらか片方だけ。URL は https の絶対 URL に限る（resolve と同じ）。 */
export function assertTarget(target: ResourceTarget): { resourceId: string } | { url: string } {
  const hasId = typeof target.resourceId === "string" && target.resourceId.length > 0;
  const hasUrl = typeof target.url === "string" && target.url.length > 0;
  if (hasId && hasUrl) {
    throw new Error(`${INVALID_TARGET_PREFIX} pass resourceId or url, not both`);
  }
  if (!hasId && !hasUrl) {
    throw new Error(`${INVALID_TARGET_PREFIX} pass resourceId (sha256) or url (the URL that answers 402)`);
  }
  if (hasId) {
    if (!SHA256_RE.test(target.resourceId!)) {
      throw new Error(`${INVALID_TARGET_PREFIX} resourceId must be 64 lowercase hex characters; pass the URL as url instead`);
    }
    return { resourceId: target.resourceId! };
  }
  let parsed: URL;
  try {
    parsed = new URL(target.url!);
  } catch {
    throw new Error(`${INVALID_TARGET_PREFIX} url must be an absolute https URL`);
  }
  // 2026-09-29: vet402 の resolve は https だけを受け付ける（http は 400）。ここで先に弾き、
  // 利用者に直し方を同じ語で返す（400 の本文の message は vouchFetch が運ばないため）。
  if (parsed.protocol !== "https:") {
    throw new Error(`${INVALID_TARGET_PREFIX} url must be an absolute https URL`);
  }
  return { url: target.url! };
}

export function uncatalogued(
  lookup: { resourceId: string | null; url: string | null; canonicalUrl: string | null },
  candidates: ResolveEndpointRef[] = [],
): UncataloguedResult {
  const what = lookup.url ? `The URL ${lookup.url}` : `The resource id ${lookup.resourceId}`;
  return {
    decision: "REFUSE",
    safe_to_pay: false,
    refuse_reasons: ["resource_uncatalogued"],
    not_in_catalog: true,
    summary:
      `${what} is not in vet402's catalog, so vet402 has no L0–L2 record to decide from. ` +
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
export async function resourceDecision(
  target: ResourceTarget,
  query: DecisionQuery,
): Promise<ResourceDecisionOutcome> {
  const checked = assertTarget(target);
  let resourceId: string;
  let resolvedFrom: string | null = null;
  let canonical: string | null = null;

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
  } else {
    resourceId = checked.resourceId;
  }

  try {
    const result = await fetchDecision(resourceId, query);
    return { kind: "decision", resourceId, resolvedFrom, result };
  } catch (error) {
    if (error instanceof VouchApiError && error.message === "not_found") {
      return {
        kind: "uncatalogued",
        body: uncatalogued({ resourceId, url: resolvedFrom, canonicalUrl: canonical }),
      };
    }
    throw error;
  }
}

// ---- verified_terms（2026-09-29 監査 5 周目・受け口の準備）----
// 判定の応答に、vet402 が確かめた支払い条件（payTo・金額・資産）が `verified_terms` として載る予定
// （別の担当が /decision に追加する）。形はまだ確定していないので、読める鍵だけを拾い、
// 読めなければ何も言わない。キーが無ければ summary は今までと 1 文字も変わらない。
// 値は上流の文字列なので、印字できる ASCII の短い値と有限の数だけを通す（モデルの文脈へ任意の文を流さない）。

const TERM_KEYS: readonly (readonly [label: string, keys: readonly string[]])[] = [
  ["payTo", ["pay_to", "payTo"]],
  ["amount", ["amount", "max_amount_required", "maxAmountRequired", "amount_atomic"]],
  ["amount_usd", ["amount_usd", "amountUsd"]],
  ["asset", ["asset_symbol", "asset"]],
  ["network", ["network", "chain"]],
];

function safeTermValue(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string" && /^[\x20-\x7E]{1,128}$/.test(v)) return v;
  return null;
}

function oneTermsLine(t: unknown): string | null {
  if (t === null || typeof t !== "object" || Array.isArray(t)) return null;
  const o = t as Record<string, unknown>;
  const parts: string[] = [];
  for (const [label, keys] of TERM_KEYS) {
    for (const k of keys) {
      const v = safeTermValue(o[k]);
      if (v !== null) {
        parts.push(`${label} ${v}`);
        break;
      }
    }
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * 判定の `verified_terms` を summary に添える 1 文。読める条件が 1 つも無ければ null（何も足さない）。
 * 配列なら先頭 3 件まで。
 */
export function verifiedTermsNote(v: unknown): string | null {
  const items = Array.isArray(v) ? v.slice(0, 3) : [v];
  const lines = items.map(oneTermsLine).filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  return `Terms vet402 verified: ${lines.join("; ")}.`;
}

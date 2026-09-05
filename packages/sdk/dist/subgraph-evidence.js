/**
 * The Graph の x402 Base subgraph を、**第2の証拠源**として読む。
 *
 * 正典: `docs/ethonline-2026/WINDOW_PLAN.md` §15（動く問い合わせと落とし穴）、
 * `docs/ethonline-2026/GRAPH_EVIDENCE.md`、`DESIGN_payOrRefuse.md` §3.5。
 *
 * なぜ要るか: `payOrRefuse` の証拠は今まで **vet402 自身の L1 台帳**だけだった。
 * 買い手は「vet402 を信じる」ことを要求される——測定器を疑えという我々の原則に反する。
 * `policy.evidence.source: "subgraph"` を選べば、**証拠の床は我々の台帳を一行も参照せず**、
 * 呼び手が自分の鍵で引いた The Graph の生データだけで当たる。
 *
 * **API キーは呼び手が渡す**（`policy.evidence.graphApiKey`）。我々の鍵を SDK に埋め込むと、
 * 「あなたは vet402 を信じなくてよい」という主張が成立しなくなる——結局われわれの口を
 * 通っているのだから。鍵が無ければ keyless パスへ出て、Gateway が拒否し、fail-closed になる。
 *
 * 2026-09-05 に本番 Gateway で実測して確定したこと:
 *
 *   1. **`user-agent` を付ける。** §15 は「無いと Cloudflare が 1010 で 403」と書くが、
 *      同日の実測では UA を外しても 200 が返った（→ 報告済み）。再現しないからといって
 *      外す理由は無いので付ける。Node 以外（ブラウザ）では fetch が UA を落とす。
 *   2. **アドレスは小文字**で渡す。
 *   3. **単数形 `x402AddressSummary(id:)` を使わない。** `id` は `0x01000000` を前置した合成値。
 *      複数形＋`where` で引く。
 *   4. **`role: RECIPIENT` で絞る。** 1つのアドレスが PAYER 行と RECIPIENT 行の両方を持つ
 *      （実測: `0xf7b1356c…` は RECIPIENT 12,376,084 件 / PAYER 11,540,523 件）。
 *      絞らずに足すと「払った回数」と「受け取った回数」を1つの数に混ぜることになる。
 *   5. **鍵が無いとき Gateway は 403 ではなく HTTP 200 と GraphQL の `errors` を返す**
 *      （`auth error: missing authorization header`）。`response.ok` だけ見る実装は
 *      これを成功と読み、件数 0 として「証拠が薄い」と誤った理由で拒否する。
 *      **`errors` と `data` の形まで見て、読めなかったのなら読めなかったと言う。**
 */
/** x402 Base subgraph（The Graph 分散ネットワーク）。 */
export const X402_BASE_SUBGRAPH_ID = "Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj";
export const GRAPH_GATEWAY_ORIGIN = "https://gateway.thegraph.com";
/** Gateway は遅いことがある（GRAPH_EVIDENCE §5）。判定が無期限に吊られないようにする。 */
export const DEFAULT_GRAPH_TIMEOUT_MS = 10_000;
/** 我々が誰かを名乗る。Cloudflare 対策であると同時に、相手の運用者に対する礼儀でもある。 */
export const GRAPH_USER_AGENT = "vet402-sdk/0.5.0 (+https://vet402.com)";
/**
 * 問い合わせ。§15 の実測どおりの形（複数形 + where、`_meta` 同梱）に
 * `role: RECIPIENT` の絞りを足したもの。2026-09-05 に本番 Gateway で実行して確認済み。
 */
const QUERY = "{ _meta { block { number timestamp } deployment } " +
    'x402AddressSummaries(where: {address: $ADDRESS, role: RECIPIENT}) ' +
    "{ id address role totalPayments totalVolumeDecimal firstPaymentTimestamp lastPaymentTimestamp } }";
function gatewayUrl(subgraphId, apiKey) {
    // 鍵があれば §15 の実測どおりパスに載せる。無ければ keyless パスへ出る——
    // 呼び手の fetch が Authorization を足しているかもしれないし、足していなければ
    // Gateway が `auth error` を返して fail-closed になる。どちらでも正しい。
    return apiKey
        ? `${GRAPH_GATEWAY_ORIGIN}/api/${apiKey}/subgraphs/id/${subgraphId}`
        : `${GRAPH_GATEWAY_ORIGIN}/api/subgraphs/id/${subgraphId}`;
}
function timeoutSignal(ms) {
    const timeout = AbortSignal.timeout;
    return typeof timeout === "function" ? timeout(ms) : undefined;
}
/**
 * 受領件数を1回だけ引く。**再試行しない**（会期スコープ外・やり残しとして記録）。
 * 返り値は「読めた」か「読めなかった」の2択で、**その中間を作らない**。
 */
export async function readSubgraphReceipts(input) {
    const subgraphId = input.subgraphId ?? X402_BASE_SUBGRAPH_ID;
    const address = String(input.address).toLowerCase();
    const url = gatewayUrl(subgraphId, input.apiKey);
    const publicUrl = gatewayUrl(subgraphId);
    const queriedAt = new Date().toISOString();
    const signal = timeoutSignal(input.timeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS);
    let body;
    try {
        const response = await input.fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // D14: 無いと Cloudflare 1010 に落ちうる。**全リクエストに付ける。**
                "User-Agent": GRAPH_USER_AGENT,
            },
            body: JSON.stringify({ query: QUERY.replace("$ADDRESS", JSON.stringify(address)) }),
            ...(signal ? { signal } : {}),
        });
        if (response.ok !== true)
            return { ok: false, error: `graph_http_${response.status}` };
        body = await response.json();
    }
    catch (error) {
        return { ok: false, error: `graph_unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (typeof body !== "object" || body === null)
        return { ok: false, error: "graph_malformed_response" };
    const envelope = body;
    // 実測: 鍵が無いとき Gateway は **200 と `errors`** を返す。ここを見ないと
    // 「認証されていない」が「受領 0 件」に化ける。
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
        const first = envelope.errors[0];
        return { ok: false, error: `graph_query_error: ${typeof first?.message === "string" ? first.message : "unknown"}` };
    }
    const data = envelope.data;
    const rows = data?.x402AddressSummaries;
    // 配列でない = クエリが我々の思った形で通っていない。**0 件と混ぜない。**
    if (!Array.isArray(rows))
        return { ok: false, error: "graph_malformed_response" };
    const blockNumber = data?._meta?.block?.number;
    // ブロック高が無ければ「live を読んだ」と言えない。言えないものを証拠にしない
    // （賞の要件が「モック・ローカルのみ・静的データは不可」であることの技術的な帰結）。
    if (typeof blockNumber !== "number")
        return { ok: false, error: "graph_no_block_meta" };
    // rows は (address, role) で1行。RECIPIENT で絞ってあるので先頭だけを読む。
    // 行が無い = そのアドレスは一度も受け取っていない（これは「読めた 0 件」）。
    const summary = rows[0];
    const receipts = summary === undefined ? 0 : Number(summary.totalPayments);
    if (!Number.isFinite(receipts) || receipts < 0)
        return { ok: false, error: "graph_malformed_summary" };
    return {
        ok: true,
        receipts,
        subgraphId,
        url,
        publicUrl,
        block: {
            number: blockNumber,
            ...(typeof data?._meta?.block?.timestamp === "number" ? { timestamp: data._meta.block.timestamp } : {}),
        },
        ...(typeof data?._meta?.deployment === "string" ? { deployment: data._meta.deployment } : {}),
        queriedAt,
    };
}

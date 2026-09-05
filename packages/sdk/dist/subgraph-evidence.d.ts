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
export declare const X402_BASE_SUBGRAPH_ID = "Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj";
export declare const GRAPH_GATEWAY_ORIGIN = "https://gateway.thegraph.com";
/** Gateway は遅いことがある（GRAPH_EVIDENCE §5）。判定が無期限に吊られないようにする。 */
export declare const DEFAULT_GRAPH_TIMEOUT_MS = 10000;
/** 我々が誰かを名乗る。Cloudflare 対策であると同時に、相手の運用者に対する礼儀でもある。 */
export declare const GRAPH_USER_AGENT = "vet402-sdk/0.5.0 (+https://vet402.com)";
/** 読めたときの1件。**件数と、それが live である証跡を必ず同梱する**（WINDOW_PLAN §2 #3）。 */
export type SubgraphReceipts = {
    ok: true;
    /** `role: RECIPIENT` の `totalPayments`。**受領件数**であって支払回数ではない。 */
    receipts: number;
    subgraphId: string;
    /** 引いた先。鍵はここに載るので、**決定行へそのまま入れない**（下の `publicUrl`）。 */
    url: string;
    /** 鍵を伏せた URL。決定行に残すのはこちら。 */
    publicUrl: string;
    block: {
        number: number;
        timestamp?: number;
    };
    deployment?: string;
    queriedAt: string;
};
/** 読めなかったとき。**黙って 0 件に落とさない**——0 件と「読めなかった」は違う。 */
export type SubgraphUnavailable = {
    ok: false;
    error: string;
};
export type SubgraphReadResult = SubgraphReceipts | SubgraphUnavailable;
export type ReadSubgraphReceiptsInput = {
    /** 受取人アドレス（0x）。小文字化してから渡す。 */
    address: string;
    /** 呼び手の fetch。ここでもグローバルを黙って掴まない。 */
    fetch: typeof fetch;
    /** 呼び手の Graph Gateway API キー。**我々の鍵を既定にしない。** */
    apiKey?: string;
    subgraphId?: string;
    timeoutMs?: number;
};
/**
 * 受領件数を1回だけ引く。**再試行しない**（会期スコープ外・やり残しとして記録）。
 * 返り値は「読めた」か「読めなかった」の2択で、**その中間を作らない**。
 */
export declare function readSubgraphReceipts(input: ReadSubgraphReceiptsInput): Promise<SubgraphReadResult>;

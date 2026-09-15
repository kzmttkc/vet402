/**
 * `payOrRefuse` — fetch the verdict; reach the signer only when every check has passed.
 * (English header for judges. The Japanese block below is the same content in our working
 * language. Canon: `docs/ethonline-2026/WINDOW_PLAN.md` §2 / §3.1 / §4. Contract tests:
 * `packages/sdk/test/pay-or-refuse.test.mjs`.)
 *
 * One thing separates this from SpendGuard: SpendGuard *returns* allow/deny and the caller's
 * wallet stack executes it. Here, on deny, **the signer is never reached** — the payment
 * implementation lives in `./x402-pay.js` and is dynamically imported inside the ALLOW branch
 * only.
 *
 * The order of judgement. It stops at the first failure:
 *   1. Caller errors (a payee that is not a 0x address, and the like) throw: no name
 *      resolution, no decision fetch.
 *   2. The ceiling the caller declared is applied *before* the decision is fetched
 *      (`price_above_ceiling`, zero requests made).
 *   3. `GET /resources/{id}/decision?role=payer`. Unreadable, degraded, or anything other than
 *      ALLOW refuses. 3'. A 404 not-found (the resource is not in the catalogue) hands the
 *      judgement to the 402's payTo and the payee score for that address alone (§3.1, I23).
 *   4. Fetch the real 402 challenge; match payTo, network, asset, scheme and amount against
 *      both the ceiling and what the caller declared.
 *   5. Only then: dynamically import `./x402-pay.js`, sign, **re-send to the seller**, attest.
 *
 * On step 5: the buyer does not call the facilitator — **the seller settles** (primary sources
 * are in the header of `x402-pay.ts`). Until 2026-09-05 this file called the facilitator from
 * the buyer; left that way, the live payment on 09-08 would have moved no money and recorded
 * no reason.
 */
/**
 * `payOrRefuse` — 判定を引き、全部の条件を通ったときにだけ署名へ進む。
 *
 * 正典: `docs/ethonline-2026/WINDOW_PLAN.md` §2・§3.1・§4。
 * 契約テスト: `packages/sdk/test/pay-or-refuse.test.mjs`。
 *
 * SpendGuard との違いは1つだけ。SpendGuard は allow/deny を**返す**（実行は呼び手の
 * ウォレットスタックの仕事）。`payOrRefuse` は deny のとき **signer に到達しない**——
 * 支払い実装は `./x402-pay.js` にあり、ALLOW ブランチ内でしか動的 import されない。
 *
 * 判定の流れ（5行）:
 *   1. 呼び出し側の誤り（0x でない payee 等）は throw。名前解決も判定取得もしない
 *   2. 呼び手が名乗った上限を、**判定を引く前に**当てる（price_above_ceiling）
 *   3. `GET /resources/{id}/decision?role=payer` を引く。読めない・degraded・ALLOW でない → 拒否
 *      3'. **404 not_found（カタログ外）→ 402 の payTo と受取人スコアだけで判定する**（§3.1・I23）
 *   4. 402 チャレンジを取り、payTo / network / asset / scheme / 金額（上限と呼び手の名乗りの両方）を照合
 *   5. 全部通ったときだけ `./x402-pay.js` を動的 import して署名 → **売り手へ再送** → attest
 *
 * 5 について: **買い手は facilitator を呼ばない。決済するのは売り手**（x402-pay.ts の
 * 冒頭に一次根拠）。2026-09-05 まで、ここは買い手から `x402.org/facilitator/settle` を
 * 叩いていた。その形のまま 09-08 に実支払いをすれば、金は動かず理由も残らなかった。
 */
import { DEFAULT_API_URL } from "./index.js";
import type { DecisionResult, SellerFacts, PayeeScoreResult } from "./index.js";
import type { PayerAccount, X402Accept } from "./x402-pay.js";
// 証拠源2つ目。**支払いモジュールではない**ので静的 import でよい（第3層の証明は
// `x402-pay.js` にだけ掛かる。`test/no-static-payment-import.test.mjs`）。
import { readSubgraphReceipts, X402_BASE_SUBGRAPH_ID, type SubgraphReceipts } from "./subgraph-evidence.js";
// 判定語と「測れたか」の欄の読み方。2つの金の経路で1つの規則を共有する（`./verdict-shape.js`）。
import { isBlockVerdict, isDecimalUnits, isPlainObject, scoreQualityDefect } from "./verdict-shape.js";

export type { PayerAccount, X402Accept, X402Settlement, Eip3009Authorization } from "./x402-pay.js";

/** Base メインネット。会期スコープは1チェーンだけ（WINDOW_PLAN §2「範囲外: 新チェーン」）。 */
export const BASE_CHAIN = "eip155:8453";
export const BASE_CHAIN_ID = 8453;
/** Base の正規 USDC。ここを可変にしない——「別トークンを掴まされる」が最も安い攻撃。 */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Solana メインネット（CAIP-2）と、その正規 USDC mint（decimals 6）。2026-09-15 に足した 2 本目のレール。
 * 値は本番 `src/lib/observatory/sol402-payer.ts` と同じ（本番の Solana L1 が実決済に使っている）。
 * mint は `===` で照合する——base58 は大文字小文字で別の鍵になる。
 */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** どのレールで払うか。**payee の形で決まる**（0x → EVM、base58 → Solana）。呼び手が選ぶ引数ではない。 */
export type PayRail = "evm" | "svm";

/**
 * Solana の取引。`@solana/web3.js` の `VersionedTransaction` がそのまま当てはまる形だけを書く
 * ——SDK の型に web3.js を持ち込まない（EVM だけの利用者に型の依存も求めない）。
 */
export type SvmTransactionLike = { serialize(): Uint8Array; message: { serialize(): Uint8Array } };

/**
 * Solana の署名者。**`payOrRefuse` はこの値の `sign*` に、ALLOW ブランチの最後まで一度も触らない**
 * （EVM の {@link PayerAccount} と同じ規律）。受け取った取引に自分の鍵で署名して返す。
 * 返した取引の message が SDK の組んだものとバイト単位で違えば、SDK は売り手へ送らない。
 */
export type SvmPayerAccount = {
  /** base58 の公開鍵。feePayer と同じなら署名の前に拒否する。 */
  address: string;
  signTransaction(tx: SvmTransactionLike): Promise<SvmTransactionLike>;
};

/** Solana の payee に払うときに渡す。`rpcUrl` は blockhash を 1 回だけ引く先（注入した fetch で呼ぶ）。 */
export type SvmPayOptions = { account: SvmPayerAccount; rpcUrl: string };

/** `@solana/web3.js` の `Keypair` が当てはまる形。{@link svmAccountFromKeypair} の引数。 */
export type SvmKeypairLike = { publicKey: { toBase58(): string }; secretKey: Uint8Array };

/**
 * web3.js の `Keypair` から {@link SvmPayerAccount} を作る。**web3.js を import しない純関数**——
 * 呼び手が既に持っている Keypair を包むだけ。署名は取引自身の `sign([keypair])`（VersionedTransaction）。
 *
 * ```ts
 * import { Keypair } from "@solana/web3.js";
 * const r = await payOrRefuse({ payee, resource, amountUsd, fetch,
 *   svm: { account: svmAccountFromKeypair(Keypair.fromSecretKey(secret)), rpcUrl } });
 * ```
 */
export function svmAccountFromKeypair(keypair: SvmKeypairLike): SvmPayerAccount {
  const address = keypair.publicKey.toBase58();
  return {
    address,
    async signTransaction(tx) {
      const signable = tx as SvmTransactionLike & { sign?: (signers: SvmKeypairLike[]) => void };
      if (typeof signable.sign !== "function") {
        throw new Error("invalid_svm_transaction: expected a @solana/web3.js VersionedTransaction with sign(signers)");
      }
      signable.sign([keypair]);
      return tx;
    },
  };
}

/**
 * 1件あたりの既定上限 $1。呼び手が `policy.maxPerTxUsd` を書かなくても
 * 上限が存在する状態にしておく（DESIGN_payOrRefuse.md §2 の `maxAmountUnits` 既定と同値）。
 */
export const DEFAULT_MAX_PER_TX_USD = 1;

/**
 * 拒否理由。**新しい語を増やさない**のが規律で、ここに並ぶ語は既に正典にある:
 *  - `price_above_ceiling` / `payee_mismatch` / `chain_or_asset_mismatch` /
 *    `evidence_unavailable` / `insufficient_delivery_evidence` /
 *    `insufficient_subgraph_evidence` … DESIGN_payOrRefuse.md §2
 *  - `payee_recommendation_not_allow` … `SpendDenyReason`（spend-guard.ts）
 *
 * `resource_uncatalogued` **だけが新語**（2026-09-04 の本番実測で必要になった）。
 * 理由: カタログ外の売り手に対する判定は「証拠が足りない」のでも「読めなかった」のでもなく、
 * **その資源を我々が一度も見たことがない**という別の状態で、既存のどの語もそれを言えない。
 * これは拒否理由ではなく**経路の印**であり、ALLOW で払ったときの決定行にも載る
 * （§3.1「一度も見たことのない売り手に向けて判定できる」が製品の核だから、
 * 通ったのか拒んだのかと独立に、どちらの経路で出た判定かが機械可読で残る必要がある）。
 *
 * 2026-09-05 に2語だけ足した。どちらも既存の語では**言えないこと**を言うために足している。
 *  - `no_eligible_accept` … 本番 `x402-payer.ts` の `AcceptSelection` にある語をそのまま借りる。
 *    「掴んだ1件がチェーン違いだった」（`chain_or_asset_mismatch`）と
 *    「提示された全部を見たが1件も払えなかった」は別のこと。前者だけを返すと、
 *    **売り手が accepts の順序を変えるだけで拒否理由がすり替わる**。
 *    具体の不一致は消さず、この語を**先頭に**置いて一次の所見にする
 *  - `allowed_by_caller_policy` … 拒否理由ではなく**通した規則の印**（§3.2）。
 *    `policy.requireVet402Allow: false` で vet402 の非 ALLOW を免除して払ったときにだけ載る。
 *    黙って弱くならないことを、機械可読な形で示すためにある
 *
 * 2026-09-07 に 1 語足した（第三者監査 A3）。
 *  - `price_above_declared` … 402 の額が呼び手の名乗り（`amountUsd`）を超えた。`price_above_ceiling`
 *    は「上限」（`maxPerTxUsd`）の語で、名乗りは別の関門——`amountUsd: 0.01` と言った呼び手に
 *    $1 の 402 を上限内だからと払うのは、上限は守っても名乗りを破っている。サーバの
 *    `caller_policy` は 402 を見ないのでこの語を出せない（SDK だけの語・parity テストが固定）
 */
export const PAY_REFUSE_REASONS = [
  "price_above_ceiling",
  "price_above_declared",
  "payee_mismatch",
  "chain_or_asset_mismatch",
  "evidence_unavailable",
  // 2026-09-07: 実装は §3.2.1 以来この語を `refuse([...])` に渡していたが、型には無かった
  // （`refuse` の引数が `string[]` なので型検査を素通りしていた）。サーバの CallerPolicyReason
  // には載っており、tests/caller-policy-sdk-parity.test.ts の語彙突合で見つかった。
  "payee_recommendation_block",
  "payee_recommendation_not_allow",
  "insufficient_delivery_evidence",
  "insufficient_subgraph_evidence",
  "resource_uncatalogued",
  "subgraph_evidence_unavailable",
  "no_eligible_accept",
  "allowed_by_caller_policy",
] as const;

export type PayRefuseReason = (typeof PAY_REFUSE_REASONS)[number];

/**
 * サーバから**そのまま透過する**語（`/decision` の `reason_codes` 等）。サーバの語彙は
 * {@link PAY_REFUSE_REASONS} とは別物なので `PayRefuseReason` に狭めない——狭めれば語が落ちて
 * 決定行が変わる。`refuse([...])` が受けるのは `PayRefuseReason` かこの型だけで、裸の `string` は
 * 受けない。だから型に無い語をリテラルで書けばコンパイルで止まる（2026-09-07 まで引数が
 * `string[]` だったので `payee_recommendation_block` が型に無いまま実装だけが出していた）。
 * この型の値を作れるのは {@link serverReasonCodes} だけ。
 */
type ServerReasonCode = string & { readonly __origin: "server" };

/** サーバの語に「透過してよい」印を付ける唯一の場所。語は 1 つも変えない・落とさない。 */
function serverReasonCodes(words: string[]): ServerReasonCode[] {
  return words as ServerReasonCode[];
}

/** 証拠源。`payOrRefuse` の判定が「誰の台帳を読んだか」を機械可読で残す。 */
export type PayEvidenceSource = "vet402" | "subgraph";

export type PayEvidenceRow = {
  level: "L0" | "L1" | "L2";
  source: PayEvidenceSource;
  url: string;
  purchase_id?: string;
  /**
   * `source: "subgraph"` のとき live であることの証跡（D15・WINDOW_PLAN §2 #3）。
   * これが無い行は「静的データを読んだのではない」ことを示せないので、証拠として扱わない。
   */
  subgraphId?: string;
  block?: { number: number; timestamp?: number };
  deployment?: string;
  queriedAt?: string;
  /**
   * **その源が知っている件数**。行ごとに別々に持つ——源をまたいで足さない（D16）。
   * 自社台帳の「配達件数」と subgraph の「受領件数」は**別のことを数えた別の数**であり、
   * 合算した1つの数は何も意味しない。
   */
  receipts?: number;
};

export type PayEvidencePolicy = {
  /** vet402 の L1 配達台帳（実際に払って届いた件数）の下限。 */
  minL1Deliveries?: number;
  /**
   * The Graph の x402 Base subgraph が知っている**受領**件数の下限（C11/D13-D16）。
   * `source` が `"subgraph"` か `"both"` でなければ**呼び出し側エラー**（下記）。
   */
  minSubgraphReceipts?: number;
  /**
   * 既定 `"vet402"`。`"subgraph"` は**我々の台帳を証拠の床に使わない**——
   * 呼び手が自分の鍵で The Graph を引いて自分で確かめる。`"both"` は両方読め、
   * **片方でも読めなければ fail-closed**（黙って弱い方に落ちない・C12）。
   */
  source?: "vet402" | "subgraph" | "both";
  /**
   * 呼び手の Graph Gateway API キー。**我々の鍵を SDK に埋め込まない。**
   * この機能の主張は「`source: "subgraph"` にすれば我々の台帳を一行も読まない」であり、
   * 我々の鍵を通せばその主張は成立しない（結局 vet402 を信じていることになる）。
   * 無いときは keyless パスへ出て Gateway が拒否し、`evidence_unavailable` になる。
   */
  graphApiKey?: string;
  /** 引く subgraph。既定は x402 Base（{@link X402_BASE_SUBGRAPH_ID}）。 */
  subgraphId?: string;
  /**
   * 読んだ先の **deployment を名指しする（pin）**。渡したときだけ、応答の `_meta.deployment`
   * と突き合わせ、違えば「読めなかった」として扱う（`subgraph_evidence_unavailable`）。
   * subgraph ID は同じまま再デプロイで中身が別物になりうる——block 高は live であることしか
   * 証明しない。照合は {@link readSubgraphReceipts} が行う（判定の条件式は変わらない）。
   * **渡さなければ挙動は変わらない。** 既定は照合しない。
   */
  deploymentId?: string;
};

export type PayPolicy = {
  /** 1件あたりの上限（USD）。既定 {@link DEFAULT_MAX_PER_TX_USD}。 */
  maxPerTxUsd?: number;
  /** 呼び手が名指しした証拠の床。書かなければ `/decision` の判定だけで通す。 */
  evidence?: PayEvidencePolicy;
  /**
   * **vet402 の推奨が ALLOW であることを要求するか。既定 `true`（fail-closed）。**
   *
   * `false` にすると、vet402 が **WARN** を出していても、**呼び手が宣言した
   * 証拠の床がすべて満たされていれば**払う。これは「あなたは vet402 を信じなくてよい」
   * という主張そのものであり（WINDOW_PLAN §3.2）、実測に裏打ちがある——
   * デモの支払い先 The Graph `0x79DC34E4…FcCB` は我々のエンジンで **69 / WARN / thin**
   * だが、The Graph 自身の subgraph は同じアドレスの受領を 253 件知っている。
   * 我々の判定が薄いことと、その相手が危険であることは、別のことである。
   *
   * **床を1つも宣言せずに `false` にするのは呼び出し側エラー**（`invalid_policy`）。
   * vet402 の判定を外し、代わりを置かなければ、**誰もこの支払いを判定していない**。
   * 0 の床は床ではない（何も判定しない）ので、少なくとも1つは 1 以上でなければならない。
   *
   * **免除するのは「判定の中身」であって「判定が存在すること」ではない。**
   * `degraded`（測れなかった）と `signalsUnavailable`（一部が測れなかった）は
   * `false` でも fail-closed のまま。ALLOW でないことと、読めなかったことは別である。
   *
   * 通したときは決定行に残る: `verdict_source: "caller_policy"`、
   * 理由コード `allowed_by_caller_policy`、そして {@link PayDecisionRecord.policy_override}
   * に「何を免除し、どの床をいくつで満たしたか」の内訳。**黙って弱くならない。**
   */
  requireVet402Allow?: boolean;
};

/** 満たした床1つ。**要求値と実測値を両方持つ**——「床を見たふり」を機械可読に潰す。 */
export type EvidenceFloorCheck = {
  floor: "minL1Deliveries" | "minSubgraphReceipts";
  /** どの源の数で当てたか。源をまたいで足さない（D16）。 */
  source: PayEvidenceSource;
  required: number;
  observed: number;
};

/**
 * **どの規則で通したか。** vet402 の非 ALLOW を呼び手の policy が免除して払ったときにだけ載る。
 * 審査員が読むのはここなので、「何を免除したか」と「代わりに何を満たしたか」を両方置く。
 */
export type PayPolicyOverride = {
  rule: "requireVet402Allow:false";
  /** 免除した判定。**消さずに残す**——弱くしたことを隠さない。 */
  waived: {
    source: "decision" | "payee_score";
    recommendation: string;
    /** 受取人スコアの点数（`/decision` 経路には無いので null）。 */
    score: number | null;
    reason_codes: string[];
  };
  /** 代わりに満たした床の内訳。空になることはない（空なら呼び出し側エラーで到達しない）。 */
  floors_met: EvidenceFloorCheck[];
};

/**
 * 署名者は**レールごとに1つ**。0x の payee には `account`（EIP-3009）、base58 の payee には
 * `svm`（Solana の署名者と RPC）。payee の形と合わない方を渡す・両方渡す・どちらも無いは、
 * 通信の前に `invalid_payer` で throw する。
 */
export type PayOrRefuseInput = PayOrRefuseBaseInput &
  ({ account: PayerAccount; svm?: undefined } | { svm: SvmPayOptions; account?: undefined });

export type PayOrRefuseBaseInput = {
  /**
   * 0x アドレス（Base）か base58 アドレス（Solana）。ENS 名は**解決しない**（名前解決を支払いゲートの中で起こさない）。
   * Solana の payee は大文字小文字を含めて 402 の payTo と完全一致でなければ払わない。
   */
  payee: string;
  /** 402 を返す資源の URL。 */
  resource: string;
  amountUsd: number;
  /**
   * 使う fetch。**必須**——グローバル fetch を黙って掴むと、拒否経路が本当に
   * どこへも出ていないことを呼び手が検算できない。
   */
  fetch: typeof fetch;
  /** 資源の HTTP メソッド。既定 "GET"。The Graph の x402 口は "POST"。 */
  method?: string;
  policy?: PayPolicy;
  apiUrl?: string;
  apiKey?: string;
  /** 決定行の出所。デモは "agent-demo"（L1 台帳と混ぜない・F19/F20）。 */
  source?: string;
  /** 資源 ID を自分で計算済みなら渡す（正規化規則はサーバ側が持つ）。 */
  resourceId?: string;
  /**
   * 決定行を追記する JSONL のパス。渡したときだけ書く。
   * 既定は {@link DEFAULT_DECISION_STORE} だが、**渡されない限り書かない**——
   * npm に載る SDK が、呼び手の cwd に黙ってファイルを作ってはいけない。
   * デモも L1 も同じ既定パスを渡すので、行は1本の store に混ざる（F19/F20 の主題）。
   */
  decisionStore?: string;
};

/** `payOrRefuse` が出した1件の決定。拒否でも通過でも同じ形で残る。 */
export type PayDecisionRecord = {
  recommendation: "ALLOW" | "REFUSE";
  reason_codes: string[];
  /**
   * 判定を何から出したか。404 経路は "payee_score"。
   * **"caller_policy" は「vet402 ではなく呼び手の規則が通した」**（§3.2）。
   * vet402 が ALLOW を出したなら、`requireVet402Allow: false` でも "decision" のまま——
   * 上書きしていないのに上書きしたと記帳すると、決定行が読めなくなる。
   */
  verdict_source: "decision" | "payee_score" | "local_policy" | "caller_policy";
  evidence: PayEvidenceRow[];
  /** サーバの `/decision` 応答（404 経路では null）。 */
  decision: DecisionResult | null;
  /** 404 経路で読んだ受取人スコア（それ以外では null）。 */
  payeeScore: PayeeScoreResult | null;
  /** 呼び手の規則が vet402 の非 ALLOW を免除して**通した**ときだけ非 null。 */
  policy_override: PayPolicyOverride | null;
  source: string;
};

export type PayOrRefuseResult = {
  /** "refused" は署名前に止まったこと。"failed" は署名後に settle が失敗したこと。 */
  status: "paid" | "refused" | "failed";
  decision: PayDecisionRecord;
  /** 署名が実在するか。"failed" のとき true——隠さない（E18）。 */
  signed: boolean;
  attested: boolean;
  txHash: string | null;
  /**
   * 署名した EIP-3009 認可の nonce。**我々しか作れない一回性の値**で、
   * 「その決済 tx はこの購入のものか」を後から確かめる唯一の手段（監査の nonce 束縛）。
   * 署名していない拒否経路では null——そこが「署名が存在しない」ことの機械可読な印になる。
   */
  nonce: string | null;
  challenge: X402Accept | null;
  /** 決定行を store に書けたか。`decisionStore` を渡さなかったときは false。 */
  stored: boolean;
  /** 書けなかった理由。書けた／書こうとしなかったときは null。 */
  storeError: string | null;
  /**
   * どのレールで判定・支払いをしたか（payee の形で決まる）。2026-09-15 に**足しただけ**で、上の欄の意味は
   * レールで変わらない。Solana では `nonce` は取引の Memo 命令に載せた 32 hex（我々しか作れない値）、
   * `txHash` は PAYMENT-RESPONSE の base58 署名、`attested` は常に false（attest API は 0x の txHash しか受けない）。
   */
  rail: PayRail;
  /** Solana で売り手へ送った署名済み取引（base64）。送っていなければ・EVM では null。 */
  svmTransaction: string | null;
};

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
/** Solana の base58 アドレス（32〜44 文字・0 O I l を含まない）。 */
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const USDC_DECIMALS = 6;

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * 資源 ID。WINDOW_PLAN §3.1 の実測で示された規則は sha256("<METHOD> <正規化URL>")。
 * 正規化規則はサーバ側が正典なので、食い違ったときのために `resourceId` を渡せる。
 */
async function computeResourceId(method: string, url: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${method} ${url}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ヘッダ名の大小を問わずに読む（実 Headers は case-insensitive、テストの Map はそうでない）。 */
function readHeader(headers: unknown, name: string): string | null {
  const get = (headers as { get?: (k: string) => string | null } | undefined)?.get;
  if (typeof get !== "function") return null;
  for (const candidate of [name, name.toUpperCase(), name.toLowerCase()]) {
    const value = get.call(headers, candidate);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * v1 の綴りを v2 の形へ揃える。実在する v1 の壁は `network: "base"` と
 * `maxAmountRequired` を使う（本番 `x402-payer.ts` の normalizeAccept と同じ規則）。
 * ここで揃えておかないと、金銭ゲートが v1 を丸ごと chain_or_asset_mismatch で落とし、
 * v1 の transport（X-PAYMENT）が届かない死んだ枝になる。
 */
function normalizeAccept(raw: unknown): X402Accept | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const amount =
    typeof rec.amount === "string" ? rec.amount
    : typeof rec.maxAmountRequired === "string" ? rec.maxAmountRequired
    : null;
  const payTo = typeof rec.payTo === "string" ? rec.payTo : null;
  if (amount === null || payTo === null) return null;
  if (typeof rec.scheme !== "string" || typeof rec.asset !== "string") return null;
  const network =
    rec.network === "base" ? BASE_CHAIN
    : rec.network === "base-sepolia" ? "eip155:84532"
    // v1 の Solana スラグ（本番 `x402-payer.ts` の normalizeAccept と同じ）。v1 の壁は Solana では払わない
    // （SVM の選別が x402 v2 を要求する）が、「何を提示されたか」は正規形で残す。
    : rec.network === "solana" ? SOLANA_MAINNET
    : typeof rec.network === "string" ? rec.network
    : "";
  return {
    scheme: rec.scheme,
    network,
    amount,
    asset: rec.asset,
    payTo,
    ...(typeof rec.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: rec.maxTimeoutSeconds } : {}),
    ...(typeof rec.extra === "object" && rec.extra !== null ? { extra: rec.extra as X402Accept["extra"] } : {}),
  };
}

/**
 * この accept は**プロトコル上そもそも払える形か**。本番 `x402-payer.ts` の
 * `selectAccept` の `protocolEligible` と同じ4条件（scheme / network / asset / 転送方式）。
 * 金額と payTo は**含めない**——それは「払えるか」ではなく「払ってよいか」で、
 * 呼び手の上限と期待値に依存する（{@link evaluateMoneyGate} と payee 照合が持つ）。
 */
function isProtocolEligible(accept: X402Accept): boolean {
  if (accept.scheme !== "exact") return false;
  if (accept.network !== BASE_CHAIN) return false;
  if (!sameAddress(accept.asset, BASE_USDC)) return false;
  // 明示された転送方式が eip3009 でなければ払えない。未提示は許す——Base 正規 USDC の
  // `exact` は構造上 EIP-3009 であり、未提示を拒むと実在する 402 に払えなくなる。
  const transfer = accept.extra?.assetTransferMethod;
  return transfer === undefined || transfer === "eip3009";
}

/**
 * Solana（SVM exact）で**プロトコル上そもそも払える形か**。本番 `sol402-payer.ts` の `selectSolanaAccept`
 * と同じ条件に、SDK の再送が話す transport（v2 の PAYMENT-SIGNATURE）を足したもの:
 * scheme exact ∧ network が {@link SOLANA_MAINNET} と完全一致 ∧ asset が {@link SOLANA_USDC} と完全一致
 * ∧ `extra.feePayer` が base58 で payTo と違う ∧ x402 v2。
 * payTo が曲線上の鍵か・feePayer が署名者でないかは web3.js と署名者のアドレスが要るので、
 * ALLOW ブランチ内（`svm-pay.ts` の署名前検査）が持つ。
 */
function isSvmProtocolEligible(accept: X402Accept, x402Version: 1 | 2): boolean {
  if (x402Version !== 2) return false;
  if (accept.scheme !== "exact") return false;
  if (accept.network !== SOLANA_MAINNET) return false;
  if (accept.asset !== SOLANA_USDC) return false;
  if (!SOLANA_RE.test(accept.payTo)) return false;
  const feePayer = accept.extra?.feePayer;
  return typeof feePayer === "string" && SOLANA_RE.test(feePayer) && feePayer !== accept.payTo;
}

/** レールごとの「払える形か」。選別と金銭ゲートが**同じ述語**を使うための 1 本。 */
function isEligibleOnRail(accept: X402Accept, rail: PayRail, x402Version: 1 | 2): boolean {
  return rail === "svm" ? isSvmProtocolEligible(accept, x402Version) : isProtocolEligible(accept);
}

/**
 * EIP-712 ドメインがトークンのもの（本番 2026-08-22 の `eth_call` 実測）と矛盾しないか。
 * **売り手の名乗りを採用するためではなく、矛盾を検出するために読む。**
 */
function hasCanonicalUsdcDomain(accept: X402Accept): boolean {
  const name = accept.extra?.name;
  const version = accept.extra?.version;
  return (name === undefined || name === "USD Coin") && (version === undefined || version === "2");
}

/**
 * **提示された accepts から、条件を満たす最初のものを選ぶ。**
 *
 * 2026-09-05 まで、ここは `accepts[0]` を無条件に取っていた。実測（拒否側フィクスチャ
 * `agent.api.0x.org`）の 402 は accept を**3件**返す——Base USDC / Solana /
 * Base の `GatewayWalletBatched` ドメイン。先頭がたまたま正しかっただけで、
 * **売り手が順序を並べ替えれば SDK は Solana を掴み、拒否の理由がすり替わる**。
 * 拒否そのものは変わらないが、「拒否の理由は正確である」という主張が壊れる。
 *
 * 意味論は本番 `src/lib/observatory/x402-payer.ts` の `selectAccept` に揃える。
 * ただし**本番と1点だけ違う**: 本番は EIP-712 ドメインを `protocolEligible` の
 * ハードなフィルタに入れ、全滅すれば `no_eligible_accept` を返す。ここでは
 * ドメインは**優先順位**として使い、正規のものが1件も無ければ eligible の先頭を返す——
 * そのまま {@link evaluateMoneyGate} が `chain_or_asset_mismatch` で落とすので
 * 結論（署名しない）は同じで、**なぜ落ちたかがより具体的に残る**。
 *
 * @returns `eligible: false` は「提示は読めたが、払える形が1件も無い」。
 *   そのときも `accept` には**実際に提示された1件**を入れて返す——
 *   拒否理由を具体的に出すため、そして画に存在しない accept を映さないため。
 */
function selectAccept(
  raw: unknown[],
  rail: PayRail = "evm",
  x402Version: 1 | 2 = 2,
): { accept: X402Accept; eligible: boolean } | null {
  const normalized = raw.map(normalizeAccept).filter((a): a is X402Accept => a !== null);
  if (normalized.length === 0) return null;
  // Solana の payee なら Solana の accept だけを候補にする。**Base が先頭でも Solana を選べる**（逆も同じ）。
  // EIP-712 ドメインの優先順位は EVM だけのもの。
  if (rail === "svm") {
    const svmEligible = normalized.filter((a) => isSvmProtocolEligible(a, x402Version));
    return svmEligible.length === 0 ? { accept: normalized[0], eligible: false } : { accept: svmEligible[0], eligible: true };
  }
  const eligible = normalized.filter(isProtocolEligible);
  if (eligible.length === 0) return { accept: normalized[0], eligible: false };
  return { accept: eligible.find(hasCanonicalUsdcDomain) ?? eligible[0], eligible: true };
}

/** チャレンジは **transport のバージョンごと**読む——答える側のヘッダ名がそれで決まる。 */
function decodeChallenge(
  raw: string,
  rail: PayRail = "evm",
): { x402Version: 1 | 2; accept: X402Accept; eligible: boolean } | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
    const accepts = (json as { accepts?: unknown[] }).accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) return null;
    const version: 1 | 2 = (json as { x402Version?: unknown }).x402Version === 1 ? 1 : 2;
    const selected = selectAccept(accepts, rail, version);
    if (!selected) return null;
    return {
      x402Version: version,
      accept: selected.accept,
      eligible: selected.eligible,
    };
  } catch {
    return null;
  }
}

/**
 * 判定を引き、全部の条件を通ったときにだけ払う。結果は `decisionStore` を渡したときだけ
 * 1本の JSONL へ追記される（下の {@link appendDecision}）。
 */
export async function payOrRefuse(input: PayOrRefuseInput): Promise<PayOrRefuseResult> {
  // 0x の経路の署名者欄は、内部では常に値を持つ（Solana の呼び手には触れたら throw する番兵を置く）。
  // 判定の中で `account` を「無いかもしれない値」として扱わないため——型の上でも EVM の経路は 1 行も変えない。
  const result = await decideAndPay({ ...input, account: input.account ?? NO_EVM_ACCOUNT });
  if (input.decisionStore === undefined) return result;
  try {
    await appendDecision(
      {
        ...result.decision,
        at: new Date().toISOString(),
        status: result.status,
        resource: input.resource,
        txHash: result.txHash,
        nonce: result.nonce,
      },
      { store: input.decisionStore },
    );
    return { ...result, stored: true, storeError: null };
  } catch (error) {
    // 台帳に書けなかったことを理由に結果を握り潰さない。握り潰すと「払ったのに
    // nonce も txHash も残らない」が起きる。黙って成功にもしない（fail-loud）。
    return { ...result, stored: false, storeError: String(error instanceof Error ? error.message : error) };
  }
}

/**
 * `account` を渡さなかった呼び手の代わりに置く番兵。**署名に触れたら throw する**。
 * Solana の payee では使われない。0x の payee で `account` が欠けたまま ALLOW に着いたときだけ、ここで止まる。
 */
const NO_EVM_ACCOUNT: PayerAccount = {
  address: "0x0000000000000000000000000000000000000000",
  signTypedData: async () => {
    throw new Error("invalid_payer: no EIP-3009 account was given — a 0x payee needs account to pay on Base");
  },
};

/** 判定の内部入力。`account` は常に値（{@link NO_EVM_ACCOUNT} を含む）。 */
type DecideInput = PayOrRefuseBaseInput & { account: PayerAccount; svm?: SvmPayOptions };

async function decideAndPay(input: DecideInput): Promise<PayOrRefuseResult> {
  const fetchFn = input.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("invalid_fetch: pass the fetch implementation payOrRefuse should use");
  }
  // **呼び出し側の誤り**は判定でも拒否でもなく throw。0x でない payee はここで止まる:
  // 名前解決を支払いゲートの中で起こさない（解決先が入れ替われば payee_mismatch すら
  // 通ってしまうので、解決は呼び手の責任として外に出す）。B8。
  const isEvmPayee = typeof input.payee === "string" && WALLET_RE.test(input.payee);
  const isSvmPayee = typeof input.payee === "string" && SOLANA_RE.test(input.payee);
  if (!isEvmPayee && !isSvmPayee) {
    throw new Error(
      `invalid_payee_address: payOrRefuse takes a 0x address (Base) or a base58 address (Solana), got ${JSON.stringify(input.payee)}. ` +
        "ENS names are not resolved here — resolve it yourself and pass the resulting address.",
    );
  }
  // **レールは payee の形で決まる。** 署名者は形に合う方をちょうど 1 つ。`account` / `svm` の中身には
  // 触らない（有無だけを見る。`typeof` は Proxy の get を起こさない）——拒否経路から署名者への参照を作らない。
  const rail: PayRail = isEvmPayee ? "evm" : "svm";
  const svm = rail === "svm" ? assertSvmPayer(input) : null;
  // 0x の payee に `svm` を渡すのは 0.7.0 で足した入力の誤り（旧い呼び手は渡さない）ので throw する。
  // `account` の欠落は冒頭で止めない——0.6.0 は判定の前に `account` を見ておらず、BLOCK なら refused を
  // 返していた（JS の呼び手）。欠落のまま ALLOW に着いたときは、署名の番兵（NO_EVM_ACCOUNT）が throw する。
  if (rail === "evm" && input.svm !== undefined) {
    throw new Error(
      "invalid_payer: a 0x payee is paid on Base — pass account (an EIP-3009 signer) and no svm. Got svm present.",
    );
  }
  if (typeof input.resource !== "string" || input.resource.trim() === "") {
    throw new Error("invalid_resource: pass the URL that answers 402");
  }
  if (typeof input.amountUsd !== "number" || !Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
    throw new Error("invalid_amount_usd: pass a finite, non-negative USD amount");
  }
  // method / apiUrl は文字列でなければ呼び出し側エラー（2026-09-08 境界表）。`5.toUpperCase()` の TypeError で
  // 落ちるのは fail-closed だが、何が悪いかを言わない。null は「未指定」として既定へ落とす（`??` と同じ規則）。
  if (input.method != null && typeof input.method !== "string") {
    throw new Error("invalid_method: pass the resource's HTTP method as a string (default GET)");
  }
  if (input.apiUrl != null && typeof input.apiUrl !== "string") {
    throw new Error("invalid_api_url: pass the vet402 API origin as a string");
  }
  // 上限は有限・正でなければ呼び出し側エラー（2026-09-07 監査 A2）。`NaN ?? 1` は NaN のまま上限になり、
  // `amountUsd > NaN` も `units / 1e6 > NaN` も false で**上限比較が全部通っていた**。本番サーバは
  // max_per_tx_usd=NaN を 400 で止めるが、SDK 単体（偽サーバ・古いサーバ）に関門が無かった。
  assertMaxPerTxUsd(input.policy?.maxPerTxUsd);
  // **評価できない床を黙って無視しない**（WINDOW_PLAN §13「会期後に必ず直すもの #2」）。
  // 2026-09-05 まで、`minSubgraphReceipts` は既定 source が "vet402" のときどの分岐にも
  // 当たらず、床を指定したのに拒否も警告も出なかった。「壊れて見えない」型の欠陥。
  assertEvidencePolicy(input.policy?.evidence);
  // Solana の payee は The Graph の x402 Base subgraph に居ない（あの subgraph は Base の 0x アドレスを索引する）。
  // 読めば必ず 0 件か読めないので、床を宣言した呼び手に黙って「足りない」を返す代わりに、ここで原因を言う。
  if (rail === "svm") {
    const source = input.policy?.evidence?.source ?? "vet402";
    if (source === "subgraph" || source === "both") {
      throw new Error(
        `invalid_evidence_policy: evidence.source ${JSON.stringify(source)} reads The Graph's x402 Base subgraph, which does not index Solana payees. ` +
          'Use source "vet402" (the default) for a base58 payee.',
      );
    }
  }
  // §3.2: vet402 の判定を外すなら代わりの床が要る。**順序は evidence の整合が先**——
  // `{ minL1Deliveries: 3, source: "subgraph" }` のような誤りは、床の有無より前に、
  // 「その床は評価されない」と言われるべきだから。
  assertOverridePolicy(input.policy);
  // account は**検査しない**。`typeof account.signTypedData === "function"` と書いた瞬間に
  // 拒否経路から signer へのプロパティ参照が発生し、「到達できない」が嘘になる。

  const method = (input.method ?? "GET").toUpperCase();
  const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  const maxPerTxUsd = input.policy?.maxPerTxUsd ?? DEFAULT_MAX_PER_TX_USD;
  const source = input.source ?? "sdk";
  const headers: Record<string, string> = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};

  const requireVet402Allow = input.policy?.requireVet402Allow !== false;

  const evidence: PayEvidenceRow[] = [];
  /**
   * サーバが**同じ policy を当てて返した語**（`/decision` の `caller_policy.reason_codes`・
   * WINDOW_PLAN §16.3・2026-09-07）。決定行の `reason_codes` に**そのまま**載せる——
   * ローカルの関門は残す（二重防御）ので status を決めるのはローカルだが、
   * サーバの語を落とすと「サーバとローカルで答えが違った」ことが呼び手に見えない。
   * 食い違いは新語（`policy_disagreement` 等）で言わず、**両方の語を並べる**。
   */
  let serverPolicyReasons: string[] = [];
  const record = (
    recommendation: "ALLOW" | "REFUSE",
    reason_codes: string[],
    verdict_source: PayDecisionRecord["verdict_source"],
    decision: DecisionResult | null,
    payeeScore: PayeeScoreResult | null,
    policy_override: PayPolicyOverride | null = null,
  ): PayDecisionRecord => ({
    recommendation,
    // ローカルの語が先、サーバの policy 語が後。同じ語は 1 回だけ（順序は保つ）。
    reason_codes: [...new Set([...reason_codes, ...serverPolicyReasons])],
    verdict_source,
    evidence,
    decision,
    payeeScore,
    policy_override,
    source,
  });

  const refuse = (
    reason_codes: (PayRefuseReason | ServerReasonCode)[],
    verdict_source: PayDecisionRecord["verdict_source"],
    decision: DecisionResult | null = null,
    payeeScore: PayeeScoreResult | null = null,
    challenge: X402Accept | null = null,
  ): PayOrRefuseResult => ({
    status: "refused",
    decision: record("REFUSE", reason_codes, verdict_source, decision, payeeScore),
    signed: false,
    attested: false,
    txHash: null,
    nonce: null,
    challenge,
    stored: false,
    storeError: null,
    rail,
    svmTransaction: null,
  });

  // --- 2. 呼び手が名乗った上限は、判定を引く前に当てる（C9）---
  if (input.amountUsd > maxPerTxUsd) {
    return refuse(["price_above_ceiling"], "local_policy");
  }

  // --- 3. /decision ---
  const resourceId = input.resourceId ?? (await computeResourceId(method, input.resource));
  // 呼び手の policy をサーバにも当てさせる（§16.3）。402 の金額・上限・L1 の床を名乗ると、
  // サーバは判定と同じ文書に `caller_policy` を SDK と同じ語で足す。subgraph の床は送らない
  // （サーバは呼び手の Graph 鍵を持たないので、送っても `not_evaluated` に載るだけ）。
  const decisionQuery = new URLSearchParams({ role: "payer" });
  decisionQuery.set("amount_usd", String(input.amountUsd));
  decisionQuery.set("max_per_tx_usd", String(maxPerTxUsd));
  const l1Floor = input.policy?.evidence?.minL1Deliveries;
  const l1Source = input.policy?.evidence?.source ?? "vet402";
  const l1FloorSent = l1Floor !== undefined && (l1Source === "vet402" || l1Source === "both");
  if (l1FloorSent) {
    decisionQuery.set("min_l1_deliveries", String(l1Floor));
  }
  // `requireVet402Allow` も鏡写しにする（サーバ既定 true・2026-09-07 後段）。免除（false）は、
  // サーバが当てられる床（L1 ≥1）を一緒に送るときだけ宣言する。subgraph の床だけを根拠にした
  // 免除はサーバでは代わりにならず（読めない）、床なしの false は 400 `invalid_policy` になるので、
  // そのときは宣言しない＝サーバは既定の true を当て、WARN なら `payee_recommendation_not_allow`
  // を返す。ローカルは免除を保ったまま払い、その語は決定行に**併記**される（両方の語を並べる規則）。
  if (requireVet402Allow || (l1FloorSent && (l1Floor as number) >= 1)) {
    decisionQuery.set("require_vet402_allow", String(requireVet402Allow));
  }
  const decisionUrl = `${apiUrl}/resources/${resourceId}/decision?${decisionQuery.toString()}`;
  let decision: DecisionResult | null = null;
  let uncatalogued = false;
  try {
    const response = await fetchFn(decisionUrl, { headers });
    // 本文は**読めた object** だけを判定として扱う（2026-09-07 監査 A1 / A4）。
    // 2026-09-07 まで、読めなかった本文は `{}`、200 の JSON `null` はそのまま `decision` に入り、
    // `if (decision)` が偽になって ALLOW 検査ごと飛び、既定 policy のまま署名まで到達していた
    // （実測: null / false / 0 / "" の 4 値とも signTypedData 1 回）。読めなかったのだから払わない。
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 404 && isPlainObject(body) && body.error === "not_found") {
      // §3.1: カタログ外。`getResource()` は resource_id の単純照会なので未登録は必ずここ。
      uncatalogued = true;
    } else if (!response.ok) {
      return refuse(["evidence_unavailable"], "decision");
    } else if (!isPlainObject(body)) {
      return refuse(["evidence_unavailable"], "decision");
    } else {
      decision = body as unknown as DecisionResult;
    }
  } catch {
    // A3: 読めなかったのだから払わない。
    return refuse(["evidence_unavailable"], "decision");
  }

  // Solana のカタログ外は**ここで止める**。EVM の 404 経路は 402 の payTo で受取人スコアを引くが、
  // 受取人スコア API は base58 のアドレスを 400 で返す（0x しか受けない）。引いても判定材料は来ないので、
  // 402 も取らずに「一度も見たことがない資源で、証拠が読めない」と言って返す。
  if (uncatalogued && rail === "svm") {
    return refuse(["resource_uncatalogued", "evidence_unavailable"], "payee_score");
  }

  const pathReasons: PayRefuseReason[] = uncatalogued ? ["resource_uncatalogued"] : [];

  const serverReasons = serverReasonCodes(
    decision && Array.isArray(decision.reason_codes) ? decision.reason_codes : [],
  );
  serverPolicyReasons = Array.isArray(decision?.caller_policy?.reason_codes)
    ? decision.caller_policy.reason_codes.filter((r): r is string => typeof r === "string")
    : [];
  const evidenceVerdictSource: PayDecisionRecord["verdict_source"] = uncatalogued ? "payee_score" : "decision";

  // --- 3.5 宣言された証拠源を**すべて**読む。judgement の前に読むのは意図的で、
  // 「拒否したときにも、もう一方の源が何を知っているかは残る」ようにするため——
  // §3.1 の核（同じウォレットについて3つの情報源が3つ違うことを言う）は、まさに
  // 我々が拒否する相手について成り立つ。D14 はこの順序を固定している。
  const wantedSource = input.policy?.evidence?.source ?? "vet402";
  let subgraph: SubgraphReceipts | null = null;
  if (wantedSource === "subgraph" || wantedSource === "both") {
    const read = await readSubgraphReceipts({
      address: input.payee,
      fetch: fetchFn,
      apiKey: input.policy?.evidence?.graphApiKey,
      subgraphId: input.policy?.evidence?.subgraphId ?? X402_BASE_SUBGRAPH_ID,
      ...(input.policy?.evidence?.deploymentId === undefined ? {} : { deploymentId: input.policy.evidence.deploymentId }),
    });
    if (!read.ok) {
      // C12/D13: **どちらの源が読めなかったか**を機械可読で残す。黙って自社台帳へ落ちない。
      return refuse(
        [...pathReasons, ...serverReasons, "evidence_unavailable", "subgraph_evidence_unavailable"],
        evidenceVerdictSource,
        decision,
      );
    }
    subgraph = read;
    // D15: live であることの証跡（subgraphId / block / deployment / queriedAt）を同梱する。
    // D16: **自社台帳の行とは別の行**として持つ。件数も行ごとに別（合算しない）。
    evidence.push({
      level: "L1",
      source: "subgraph",
      url: read.publicUrl,
      subgraphId: read.subgraphId,
      block: read.block,
      ...(read.deployment ? { deployment: read.deployment } : {}),
      queriedAt: read.queriedAt,
      receipts: read.receipts,
    });
  }

  // 免除した判定。**通したときにだけ**決定行へ載せる（§3.2）。ここで控えておいて、
  // 床を当てたあとに `policy_override` を組む——免除だけしても床で落ちれば「通した規則」は
  // 存在しないので、そのときは何も書かない。
  let waived: PayPolicyOverride["waived"] | null = null;

  if (decision) {
    // A2: degraded は「測れなかった」。fail-closed のゲートにとっては読めなかったのと同じ。
    // **`requireVet402Allow: false` でもここは通さない**——免除したのは判定の中身であって、
    // 判定が存在しないことではない（J7）。
    // 「測れたか」は `verdict-shape` の 1 本（`scoreQualityDefect`）に訊く。ここに条件を写して
    // いたので、`degraded` しか見ておらず——`degraded: false` のまま `signalsUnavailable` が
    // 「この信号は読めなかった」と申告していても**署名して払っていた**（2026-09-12 実測:
    // `["native_drain"]` / 非配列 / `null` の 3 形で、デモの `judge` と 404 経路は拒み、
    // ここだけが払う）。`degraded` の型検査（2026-09-07 監査 追加1: 文字列 "true" が
    // `=== true` を素通りして払っていた）は `scoreQualityDefect` が "degraded" として持つ。
    // 理由コードは変えない——呼び手にとっては同じ「証拠が読めなかった」である。
    if (scoreQualityDefect(decision) !== null) {
      return refuse([...serverReasons, "evidence_unavailable"], "decision", decision);
    }
    // A1: ALLOW 以外。理由はサーバの reason_codes をそのまま通す（我々の語で上書きしない）。
    // **BLOCK は免除の対象外**（WINDOW_PLAN §3.2.1）。WARN は意見、BLOCK は遮断。
    // 判定語は前後の空白を落とし大文字化してから読む（`" BLOCK "` は BLOCK・2026-09-08）。
    if (isBlockVerdict(decision.recommendation)) {
      return refuse([...serverReasons, "payee_recommendation_block"], "decision", decision);
    }
    if (decision.recommendation !== "ALLOW") {
      if (requireVet402Allow) {
        return refuse([...serverReasons, "payee_recommendation_not_allow"], "decision", decision);
      }
      waived = {
        source: "decision",
        recommendation: String(decision.recommendation),
        score: null,
        reason_codes: serverReasons,
      };
    }
    // 読んだ証拠行は**判定の中身に関わらず**残す（§3.5 と同じ理由——拒否したときにも、
    // その源が何を知っているかは残る）。
    evidence.push(
      // 行は plain object だけ読む。`[null]` を map すると `row.level` の TypeError で落ちる（fail-closed だが
      // 理由が残らない・2026-09-08 境界表）。読めない行は捨て、読めた行は残す（台帳の読み方と同じ規則）。
      ...(Array.isArray(decision.evidence) ? decision.evidence.filter((row) => isPlainObject(row)) : []).map((row) => ({
        level: row.level,
        // **サーバが名乗った源をそのまま通す。** 決め打ちで "vet402" を入れると、
        // サーバが別の源の行を出した瞬間に「どの台帳が答えたか」を我々が塗り替える
        // ことになる。値が入っているので壊れて見えない——いちばん悪い形。
        // 源を名乗らない古いサーバの行だけ "vet402" と読む（そのサーバは自社台帳しか持たない）。
        source: row.source === "subgraph" ? ("subgraph" as const) : ("vet402" as const),
        url: row.url,
        ...(row.purchase_id ? { purchase_id: row.purchase_id } : {}),
        // live の証跡は落とさない（§15: これが無い行は静的データと区別できない）。
        ...(row.subgraphId ? { subgraphId: row.subgraphId } : {}),
        ...(row.block ? { block: row.block } : {}),
        ...(row.deployment ? { deployment: row.deployment } : {}),
        ...(row.queriedAt ? { queriedAt: row.queriedAt } : {}),
        ...(typeof row.receipts === "number" ? { receipts: row.receipts } : {}),
      })),
    );
  }

  // --- 3.6 呼び手が名指しした床を当てる。**カタログ外（decision が null）でも当てる**——
  // ここで無視すると、この機能がいちばん要る場所（一度も見たことのない売り手）で
  // 効かないことになる（C11c）。
  const floors = evaluateEvidencePolicy(input.policy?.evidence, decision, subgraph);
  if (floors.shortfall) {
    return refuse([...pathReasons, ...serverReasons, ...floors.shortfall], evidenceVerdictSource, decision);
  }

  // --- 4. 402 チャレンジ ---
  let accept: X402Accept | null = null;
  let x402Version: 1 | 2 = 2;
  // 「提示は読めたが、払える形が1件も無い」——**掴んだ1件が違った**とは別の所見なので、
  // 一次の所見としてこの語を先頭に置く（売り手が順序を変えても理由がすり替わらない）。
  let selectionReasons: PayRefuseReason[] = [];
  try {
    const response = await fetchFn(input.resource, { method });
    const raw = readHeader(response.headers, "payment-required");
    const challenge = raw ? decodeChallenge(raw, rail) : null;
    if (challenge) {
      accept = challenge.accept;
      x402Version = challenge.x402Version;
      selectionReasons = challenge.eligible ? [] : ["no_eligible_accept"];
    }
  } catch {
    accept = null;
  }
  if (!accept) {
    // 402 を読めない＝いくら誰に払うのかが分からない。判定と同じく fail-closed。
    return refuse([...pathReasons, "evidence_unavailable"], uncatalogued ? "payee_score" : "decision", decision);
  }

  if (rail === "svm") {
    // Solana: 払える形の accept が 1 件も無いなら、提示された別レールの accept の payTo を照合しても意味が無い
    // （Base の 0x と base58 の payee は必ず違う）。一次の所見 `no_eligible_accept` と具体の不一致を返す。
    if (selectionReasons.length > 0) {
      return refuse([...selectionReasons, "chain_or_asset_mismatch"], "decision", decision, null, accept);
    }
    // base58 は大文字小文字で別の鍵。**`===` で比べる**（下の sameAddress は 0x 用に大小を畳む）。
    if (accept.payTo !== input.payee) {
      return refuse(["payee_mismatch"], "decision", decision, null, accept);
    }
  }
  // A4: 照合は payTo で行う。402 の resource.url は内部ホスト名を返すことがある（§3）。
  if (!sameAddress(accept.payTo, input.payee)) {
    return refuse([...pathReasons, ...selectionReasons, "payee_mismatch"], uncatalogued ? "payee_score" : "decision", decision, null, accept);
  }
  const moneyGate = evaluateMoneyGate(accept, maxPerTxUsd, rail, x402Version);
  if (moneyGate) {
    return refuse([...pathReasons, ...selectionReasons, ...moneyGate], uncatalogued ? "payee_score" : "decision", decision, null, accept);
  }
  // A3（2026-09-07 監査）: 402 の額を**呼び手の名乗り**（amountUsd）とも照合する。上限は「これ以上は
  // 絶対に払わない」、名乗りは「この買い物はこの額のはず」で、別の関門。2026-09-07 まで後者が無く、
  // amountUsd 0.01 の呼び手に $1 の 402 を（上限 $1 以内だからと）払っていた。単位は USDC 6 桁の整数で
  // 比べる（浮動小数で 1 単位の差を丸めない）。amount は上で 10 進整数と確かめてある。
  if (BigInt(accept.amount) > BigInt(Math.round(input.amountUsd * 10 ** USDC_DECIMALS))) {
    return refuse([...pathReasons, ...selectionReasons, "price_above_declared"], uncatalogued ? "payee_score" : "decision", decision, null, accept);
  }

  // --- 3'. カタログ外なら、ここまでで分かった payTo で受取人スコアを引く（I23）---
  let payeeScore: PayeeScoreResult | null = null;
  if (uncatalogued) {
    const scoreUrl = `${apiUrl}/payees/${accept.payTo}/score`;
    try {
      const response = await fetchFn(scoreUrl, { headers });
      if (!response.ok) throw new Error("payee_score_unavailable");
      payeeScore = (await response.json()) as PayeeScoreResult;
    } catch {
      return refuse([...pathReasons, "evidence_unavailable"], "payee_score", null, null, accept);
    }
    // 免除の対象外（J7）。**測れなかったことは、ALLOW でないことと別**である。
    // `degraded` は boolean、`signalsUnavailable` は（在るなら）配列でなければ「測れた」と言えない
    // ——`/decision` 経路が 2026-09-07 に入れた規律を、ここへも同じ形で通す（2026-09-08）。
    if (scoreQualityDefect(payeeScore) !== null) {
      return refuse([...pathReasons, "evidence_unavailable"], "payee_score", null, payeeScore, accept);
    }
    // **BLOCK は免除の対象外**（WINDOW_PLAN §3.2.1）。上の decision 経路と同じ規則。
    if (isBlockVerdict(payeeScore?.recommendation)) {
      return refuse([...pathReasons, "payee_recommendation_block"], "payee_score", null, payeeScore, accept);
    }
    if (payeeScore?.recommendation !== "ALLOW") {
      if (requireVet402Allow) {
        return refuse([...pathReasons, "payee_recommendation_not_allow"], "payee_score", null, payeeScore, accept);
      }
      // §3.2 のカタログ外経路。**床は既に 3.6 で当たっている**——`requireVet402Allow: false`
      // は床が1つ以上あることを呼び出し側エラーで強制しているので、ここに来た時点で
      // 「vet402 の判定を外し、代わりの床は満たされている」が成立している。
      waived = {
        source: "payee_score",
        recommendation: String(payeeScore?.recommendation ?? "unknown"),
        score: typeof payeeScore?.score === "number" ? payeeScore.score : null,
        reason_codes: [],
      };
    }
    evidence.push({ level: "L0", source: "vet402", url: scoreUrl });
  }

  // どの規則で通したか。**免除を使ったときにだけ**組む（J8: vet402 が ALLOW を出したなら
  // 上書きは起きていないので null のまま）。
  const policyOverride: PayPolicyOverride | null = waived
    ? { rule: "requireVet402Allow:false", waived, floors_met: floors.met }
    : null;
  // vet402 が何と言っていたかは**消さない**。WARN の理由をそのまま残したうえで、
  // 誰が通したかを1語足す。弱くしたことを隠さないための形。
  const allowReasons = policyOverride
    ? [...pathReasons, ...policyOverride.waived.reason_codes, "allowed_by_caller_policy"]
    : pathReasons;

  // --- 5. ここから先だけが支払い。実装は ALLOW ブランチ内の動的 import（第3層）---
  // 署名 → **売り手へ再送** → 応答ヘッダのレシート。facilitator は買い手の経路に無い。
  // 通したのが vet402 の判定なのか、呼び手の規則なのか。**審査員が読むのはここ**（§3.2）。
  const verdictSource: PayDecisionRecord["verdict_source"] =
    policyOverride ? "caller_policy" : uncatalogued ? "payee_score" : "decision";

  if (svm !== null) {
    // Solana（SVM exact）。**支払い実装と @solana/web3.js はここで初めて評価される**（第3層・EVM と同じ形）。
    // 取引は SDK が組み、呼び手の署名者は署名するだけ。attest は POST しない（attest API は 0x の txHash しか受けない）。
    const { executeSvmPayment } = await import("./svm-pay.js");
    let svmMemo: string | null = null;
    const svmPaid = await executeSvmPayment({
      account: svm.account,
      rpcUrl: svm.rpcUrl,
      accept,
      resource: input.resource,
      method,
      fetch: fetchFn,
      onSigned: ({ memo }) => {
        svmMemo = memo;
      },
    }).catch((error: unknown) => {
      // 署名の**前**に落ちた（web3.js が無い・RPC が blockhash を返さない等）なら金は動いていない。そのまま投げる。
      if (svmMemo === null) throw error;
      return null;
    });
    if (svmPaid !== null && svmPaid.refused !== null) {
      // ALLOW ブランチ内の、署名者に触る前の拒否（payTo が曲線外・feePayer が署名者自身）。
      return refuse([svmPaid.refused], verdictSource, decision, payeeScore, accept);
    }
    const svmSettled = svmPaid !== null && svmPaid.settled;
    return {
      status: svmSettled ? "paid" : "failed",
      decision: record("ALLOW", svmSettled ? allowReasons : [...allowReasons, "settle_failed"], verdictSource, decision, payeeScore, policyOverride),
      // 署名者が値を返した以上 true。送らなかった（message 不一致）ときも隠さない（E18）。
      signed: true,
      attested: false,
      txHash: svmPaid?.txHash ?? null,
      nonce: svmPaid?.memo ?? svmMemo,
      challenge: accept,
      stored: false,
      storeError: null,
      rail,
      svmTransaction: svmPaid?.transactionB64 ?? null,
    };
  }

  const { executeX402Payment } = await import("./x402-pay.js");
  // 署名の直後に nonce を確定させる。ここから先で落ちても「何に署名したか」は残る。
  let signedNonce: string | null = null;
  const paid = await executeX402Payment({
    account: input.account,
    accept,
    resource: input.resource,
    method,
    chainId: BASE_CHAIN_ID,
    x402Version,
    fetch: fetchFn,
    onSigned: ({ nonce }) => {
      signedNonce = nonce;
    },
  }).catch((error: unknown) => {
    // 署名の**前**に落ちたなら金は動いていない。呼び出し側の誤りとしてそのまま投げる。
    if (signedNonce === null) throw error;
    // 署名の**後**で落ちた（再送の応答を読めなかった等）。null にして下で failed に畳む。
    return null;
  });
  if (paid === null) {
    // 2026-09-06 まで、ここは `decideAndPay` ごと throw して signedNonce を呼び手に返さなかった
    // ——上のコメントが嘘だった。署名した認可は validBefore まで生きた金で、遅れて決済され得る。
    // 例外を理由に nonce を失えば「払ったかもしれないのに照合できない」が起きる。
    return {
      status: "failed",
      decision: record("ALLOW", [...allowReasons, "settle_failed"], verdictSource, decision, payeeScore, policyOverride),
      signed: true,
      attested: false,
      txHash: null,
      nonce: signedNonce,
      challenge: accept,
      stored: false,
      storeError: null,
      rail,
      svmTransaction: null,
    };
  }

  if (!paid.settled) {
    // E18: 署名は実在する。隠さない。nonce も返す——署名した認可は validBefore まで
    // 生きた金で、後から遅れて決済され得る。何に署名したかが残らないと照合できない。
    return {
      status: "failed",
      decision: record("ALLOW", [...allowReasons, "settle_failed"], verdictSource, decision, payeeScore, policyOverride),
      signed: paid.signed,
      attested: false,
      txHash: paid.txHash,
      nonce: paid.nonce ?? signedNonce,
      challenge: accept,
      stored: false,
      storeError: null,
      rail,
      svmTransaction: null,
    };
  }

  let attested = false;
  if (paid.txHash) {
    try {
      const response = await fetchFn(`${apiUrl}/payments/x402`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: input.payee,
          txHash: paid.txHash,
          amount: accept.amount,
          network: accept.network,
          resource: input.resource,
          // 監査の nonce 束縛（本番 settlement-verify.ts）。attest がこれを載せて初めて、
          // 「その決済 tx はこの購入のものか」を第三者が確かめられる。
          authNonce: paid.nonce,
          source,
        }),
      });
      attested = response.ok === true;
    } catch {
      attested = false;
    }
  }

  return {
    status: "paid",
    decision: record("ALLOW", allowReasons, verdictSource, decision, payeeScore, policyOverride),
    signed: paid.signed,
    attested,
    txHash: paid.txHash,
    nonce: paid.nonce ?? signedNonce,
    challenge: accept,
    stored: false,
    storeError: null,
    rail,
    svmTransaction: null,
  };
}

/**
 * 金銭ゲート。**署名の前**にしか意味が無いので、呼ぶ位置を動かさないこと。
 * 本番には4チェーン提示の 402 が実在する（WINDOW_PLAN §4 B）。
 */
function evaluateMoneyGate(
  accept: X402Accept,
  maxPerTxUsd: number,
  rail: PayRail = "evm",
  x402Version: 1 | 2 = 2,
): PayRefuseReason[] | null {
  // scheme / network / asset / 転送方式。**選別と同じ述語**で見る——別の述語を書くと、
  // 選ばれたのに関門で落ちる（またはその逆の）食い違いが静かに入り込む。
  if (!isEligibleOnRail(accept, rail, x402Version)) return ["chain_or_asset_mismatch"];
  // EIP-712 ドメインはトークンのものであって売り手のものではない（本番 2026-08-22 監査）。
  // 矛盾する accept を**署名の前に**落とす: 誤ったドメインの署名は決済され得ないので、
  // 通せば「一円も動かないまま署名だけが生きている」状態を売り手が無料で作れてしまう。
  // Solana の accept に EIP-712 ドメインは無い（署名するのは取引であって型付きデータではない）。
  if (rail === "evm" && !hasCanonicalUsdcDomain(accept)) return ["chain_or_asset_mismatch"];
  // `amount` は uint256 の 10 進表記（数字だけ）に限る（2026-09-07 監査 A6）。`Number()` は
  // "0x10" / "1e4" / "20000.5" / " 20000 " を上限内の数に読むが、署名に載るのは**生文字列**なので、
  // 関門が見た額と署名した額が食い違う。読めない額は「いくら払うのか分からない」＝402 が読めないのと同じ語。
  if (!isDecimalUnits(accept.amount)) return ["evidence_unavailable"];
  const units = Number(accept.amount);
  if (!Number.isFinite(units) || units <= 0) return ["chain_or_asset_mismatch"];
  if (units / 10 ** USDC_DECIMALS > maxPerTxUsd) return ["price_above_ceiling"];
  return null;
}

/**
 * **呼び出し側の誤りを、通信の前に落とす。**
 *
 * `evidence` の床は、名乗った `source` が評価できるものでなければならない。
 * 評価できない床を黙って無視すると「床を指定したのに拒否も警告も出ない」——
 * 正しい値が別名で渡って下流で黙って捨てられるのと同じ、**壊れて見えない**型の欠陥になる
 * （WINDOW_PLAN §13「会期後に必ず直すもの #2」に実物が記録されている）。
 *
 * **黙って `source` を格上げする案は採らなかった。** 理由は2つ。
 *  (1) `{ source: "vet402", minSubgraphReceipts: 100 }` のように**明示的に矛盾**した指定は
 *      格上げでは扱えない（明示された "vet402" を勝手に "subgraph" へ変えるのは、
 *      呼び手が書いた文字を無視することであり、無視の一形態でしかない）。
 *  (2) 格上げしたとき呼び手が受け取るのは `evidence_unavailable`（鍵が無ければ必ずそうなる）で、
 *      **「source を書き忘れた」という本当の原因がどこにも出ない**。ここで throw すれば、
 *      通信の前に、call site で、原因そのものが名指しで返る。
 * 対称に、`{ source: "subgraph", minL1Deliveries: 3 }` も同じ理由で呼び出し側エラー。
 */
/**
 * Solana の payee に渡された署名者の**形**を、通信の前に見る。見るのは `svm` の欄の有無と `rpcUrl` だけで、
 * `svm.account` のプロパティには触らない（`typeof` は Proxy の get を起こさない）。
 */
function assertSvmPayer(input: DecideInput): SvmPayOptions {
  const svm: unknown = input.svm;
  if (input.account !== NO_EVM_ACCOUNT || typeof svm !== "object" || svm === null) {
    throw new Error(
      "invalid_payer: a base58 payee is paid on Solana — pass svm: { account, rpcUrl } and no account. " +
        `Got account ${input.account === NO_EVM_ACCOUNT ? "missing" : "present"}, svm ${typeof svm === "object" && svm !== null ? "present" : "missing"}.`,
    );
  }
  const { account, rpcUrl } = svm as { account?: unknown; rpcUrl?: unknown };
  if (typeof account !== "object" || account === null) {
    throw new Error("invalid_payer: svm.account must be a Solana signer ({ address, signTransaction })");
  }
  if (typeof rpcUrl !== "string" || !/^https?:\/\//.test(rpcUrl)) {
    throw new Error("invalid_payer: svm.rpcUrl must be an http(s) Solana RPC URL (the blockhash is read from it once, on ALLOW only)");
  }
  return svm as SvmPayOptions;
}

function assertMaxPerTxUsd(maxPerTxUsd: unknown): void {
  if (maxPerTxUsd === undefined) return;
  if (typeof maxPerTxUsd === "number" && Number.isFinite(maxPerTxUsd) && maxPerTxUsd > 0) return;
  throw new Error(
    `invalid_policy: policy.maxPerTxUsd must be a finite USD amount above 0, got ${String(maxPerTxUsd)}. ` +
      "NaN / Infinity / 0 / negatives would make every ceiling comparison pass or fail in silence.",
  );
}

/** 床は有限・非負の数でなければ呼び出し側エラー（A2）。NaN の床は `delivered < NaN` が常に false で床にならない。 */
function assertFiniteFloor(name: "minL1Deliveries" | "minSubgraphReceipts", floor: unknown): void {
  if (floor === undefined) return;
  if (typeof floor === "number" && Number.isFinite(floor) && floor >= 0) return;
  throw new Error(
    `invalid_evidence_policy: evidence.${name} must be a finite number ≥ 0, got ${String(floor)}. ` +
      "A NaN / Infinity / negative floor compares as never-short and would judge nothing.",
  );
}

function assertEvidencePolicy(policy: PayEvidencePolicy | undefined): void {
  if (!policy) return;
  assertFiniteFloor("minL1Deliveries", policy.minL1Deliveries);
  assertFiniteFloor("minSubgraphReceipts", policy.minSubgraphReceipts);
  const wanted = policy.source ?? "vet402";
  if (wanted !== "vet402" && wanted !== "subgraph" && wanted !== "both") {
    throw new Error(`invalid_evidence_policy: unknown evidence source ${JSON.stringify(wanted)}`);
  }
  if (policy.minSubgraphReceipts !== undefined && wanted !== "subgraph" && wanted !== "both") {
    throw new Error(
      `invalid_evidence_policy: minSubgraphReceipts needs evidence.source "subgraph" or "both", got ${JSON.stringify(wanted)}. ` +
        "It would otherwise be ignored in silence — the floor you set would never be applied.",
    );
  }
  if (policy.minL1Deliveries !== undefined && wanted !== "vet402" && wanted !== "both") {
    throw new Error(
      `invalid_evidence_policy: minL1Deliveries needs evidence.source "vet402" or "both", got ${JSON.stringify(wanted)}. ` +
        "It would otherwise be ignored in silence — the floor you set would never be applied.",
    );
  }
}

/**
 * 呼び手が名指しした証拠の床を当てる。**判定（`/decision`）と policy 評価を分けてある**のは、
 * 証拠源を足すときにここだけを差し替えられるようにするため。
 *
 * `subgraph` は**別の引数で受け取る**——`decision` の中に混ぜ込むと、そこから先で
 * 2つの源の数を1つにまとめる書き方が自然になってしまう（D16 が禁じている形）。
 * 源が違えば数えたものも違う。**足せる数ではない。**
 *
 * 未実装／未取得の証拠源を黙って弱い方（自社台帳）に落とさない: `subgraph` を名指しされたのに
 * 読めていないなら、それは `evidence_unavailable` である（DESIGN §3.5）。
 */
function evaluateEvidencePolicy(
  policy: PayEvidencePolicy | undefined,
  decision: DecisionResult | null,
  subgraph: SubgraphReceipts | null,
): { shortfall: PayRefuseReason[] | null; met: EvidenceFloorCheck[] } {
  const met: EvidenceFloorCheck[] = [];
  if (!policy) return { shortfall: null, met };
  const wanted = policy.source ?? "vet402";
  if ((wanted === "vet402" || wanted === "both") && policy.minL1Deliveries !== undefined) {
    const facts = decision?.facts as SellerFacts | undefined;
    const nDelivered = facts?.l1?.n_delivered;
    // 数えた件数は 0 以上の整数だけ。JSON.parse は `1e400` を Infinity に読み、Infinity はどの床も満たす
    // （2026-09-08 境界表・n_delivered=Infinity で床 1 を通って署名まで到達した）。整数でなければ 0 件と読む。
    const delivered = typeof nDelivered === "number" && Number.isInteger(nDelivered) && nDelivered >= 0 ? nDelivered : 0;
    if (delivered < policy.minL1Deliveries) {
      return { shortfall: ["insufficient_delivery_evidence"], met };
    }
    met.push({
      floor: "minL1Deliveries",
      source: "vet402",
      required: policy.minL1Deliveries,
      observed: delivered,
    });
  }
  if ((wanted === "subgraph" || wanted === "both") && policy.minSubgraphReceipts !== undefined) {
    // 読めていれば上（3.5）で必ず埋まっている。null は「読めなかった」であって 0 件ではない。
    if (!subgraph) return { shortfall: ["evidence_unavailable", "subgraph_evidence_unavailable"], met };
    if (subgraph.receipts < policy.minSubgraphReceipts) {
      return { shortfall: ["insufficient_subgraph_evidence"], met };
    }
    met.push({
      floor: "minSubgraphReceipts",
      source: "subgraph",
      required: policy.minSubgraphReceipts,
      observed: subgraph.receipts,
    });
  }
  return { shortfall: null, met };
}

/**
 * **vet402 の判定を外すなら、代わりを置け。**（WINDOW_PLAN §3.2）
 *
 * `requireVet402Allow: false` は「あなたは vet402 を信じなくてよい」という
 * 製品の主張そのものだが、**信じないことと、誰も判定しないことは違う**。
 * 床を1つも宣言せずに外せば、`payOrRefuse` は上限と 402 の整合だけを見る関数になり、
 * 「署名の前に判定する」という存在理由が消える。だから通信の前に、call site で落とす。
 *
 * **0 の床を床として数えない。** `{ minL1Deliveries: 0 }` は何も判定しないので、
 * これを許せば規則を1語足すだけで全部素通しにできる（＝抜け道が既定の使い方になる）。
 * 少なくとも1つは 1 以上でなければならない。
 *
 * `invalid_evidence_policy` と同じ思想（黙って無視せず、原因そのものを名指しで返す）だが、
 * **語を分けてある**——あちらは「その床は評価されない」、こちらは「床が存在しない」で、
 * 呼び手が直す場所が違う。
 */
function assertOverridePolicy(policy: PayPolicy | undefined): void {
  if (!policy || policy.requireVet402Allow !== false) return;
  const evidence = policy.evidence;
  const floors = [evidence?.minL1Deliveries, evidence?.minSubgraphReceipts];
  if (floors.some((floor) => typeof floor === "number" && floor > 0)) return;
  throw new Error(
    "invalid_policy: requireVet402Allow: false waives vet402's verdict, so it needs at least one " +
      "evidence floor above zero (policy.evidence.minL1Deliveries or policy.evidence.minSubgraphReceipts). " +
      "Without one, nothing would judge this payment — a floor of 0 judges nothing either.",
  );
}

// ============================================================
// 決定行の保存先（WINDOW_PLAN §2 #4 / F19・F20）
//
// **1本のローカル追記専用 JSONL に、行ごと `source` で区別して入れる。**
//
// なぜ1本か: デモ行と L1 行を別ファイルに分けると、「混ざっていない」が
// ファイルが違うという理由で構造的に自明になり、F20 が何も証明しなくなる。
// 同じ store に混ぜて、**読み手が正しく分ける**ことを要求してはじめて混線が検出できる。
//
// なぜローカルか: 会期中は本番のスキーマを触らない（実装凍結）。決定行は
// **本番 DB へは一切書かない**——`payOrRefuse` が出す書き込み系の HTTP は
// 支払いの再送と attest だけであることを F19 が固定している。
// ============================================================

/** 既定の保存先。呼び出し側の cwd からの相対。 */
export const DEFAULT_DECISION_STORE = ".vet402/decisions.jsonl";

export type DecisionStoreOptions = {
  /** JSONL のパス。既定 {@link DEFAULT_DECISION_STORE}。 */
  store?: string;
};

/** 保存する1行。決定そのものに、いつ・どの経路で出たかを添える。 */
export type StoredDecision = PayDecisionRecord & {
  at: string;
  status: PayOrRefuseResult["status"];
  resource: string;
  txHash: string | null;
  nonce: string | null;
};

/**
 * 決定行を1行追記する。**追記専用**——既存の行を書き換えない
 * （書き換えられる台帳は台帳ではない。過去の判定は後から都合よく直せてはいけない）。
 */
export async function appendDecision(
  row: StoredDecision,
  options: DecisionStoreOptions = {},
): Promise<void> {
  // node:fs は動的 import。ブラウザ／エッジで `payOrRefuse` を判定だけに使う呼び手が、
  // ファイルシステムを持たないという理由で import 時に落ちないようにする。
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const path = options.store ?? DEFAULT_DECISION_STORE;
  const dir = dirname(path);
  if (dir && dir !== "." && dir !== path) await mkdir(dir, { recursive: true });
  await appendFile(path, JSON.stringify(row) + "\n", "utf8");
}

/** store を読み、`source` が一致する行だけ返す。 */
async function readDecisions(source: string, options: DecisionStoreOptions): Promise<StoredDecision[]> {
  const { readFile } = await import("node:fs/promises");
  const path = options.store ?? DEFAULT_DECISION_STORE;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // まだ1行も書かれていない = 決定が0件。存在しないことを異常にしない。
    return [];
  }
  const rows: StoredDecision[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const row = JSON.parse(trimmed) as StoredDecision;
      // 追記専用ファイルは書き込みの途中で千切れ得る。読めない行は**捨てるが、
      // 読めた行は返す**——1行の破損で台帳全体が読めなくなる方が危険。
      if (row && row.source === source) rows.push(row);
    } catch {
      continue;
    }
  }
  return rows;
}

/** デモ（`source: "agent-demo"`）の決定行だけを返す。 */
export async function readDemoDecisions(options: DecisionStoreOptions = {}): Promise<StoredDecision[]> {
  return readDecisions("agent-demo", options);
}

/** L1（`source: "vet402"`）の決定行だけを返す。 */
export async function readL1Decisions(options: DecisionStoreOptions = {}): Promise<StoredDecision[]> {
  return readDecisions("vet402", options);
}

// ============================================================
// MPP payer — Tempo（eip155:4217）の Machine Payments Protocol 方言（2026-09-17）。
//
// Tempo には x402 が無い（2026-09-17 実測: TIP-20 は EIP-3009 を持たず、Permit2 も
// 無く、どの facilitator も eip155:4217 を載せていない）。Tempo で動いているのは
// MPP（Stripe + Tempo）で、mpp.dev の directory に 142 サービス・1,457 endpoint、
// うち 1,071 が `tempo`+`charge` の従量課金、通貨は USDC.e だけ。誰も納品率を
// 測っていない。vet402 はここを Tempo で最初に測る観測所になる。
//
// この module は x402-payer.ts / sol402-payer.ts と同じ「拒否の漏斗」である。
// **署名する前に、完全一致しないものは全部断る**——予算の予約より前に:
//   - challenge は `method="tempo"` `intent="charge"`、`methodDetails.chainId` が 4217
//   - `currency` は USDC.e に固定（売り手が選べない）
//   - `amount` はカタログ宣言と一致し、1 件の上限（$1）以下
//   - `recipient` は正しい EVM アドレスで、カタログが受取先を知っていれば一致
//   - `expires` を過ぎていない、`splits`（第三者への分配）が無い、pull mode が許される
// 署名そのものは参照実装 `mppx/client`（Stripe + Tempo）に任せる——Tempo の
// type 0x76 トランザクションの封筒を自前で再実装しない。ただし mppx にも同じ
// ピン（expectedChainId / allowedChainIds / expectedRecipients / mode:"pull"）を
// 渡し、我々の漏斗と mppx の漏斗の**両方**を通らなければ署名が出ない。
//
// 資金: 購入元は Base と同じ EOA（OBSERVATORY_WALLET_PRIVATE_KEY）。Tempo にはネイティブの
// ガス token が無く手数料は USD 建て TIP-20 で払うが、directory の challenge は
// `feePayer:true`（売り手側がガスを肩代わり）なので、我々が持つのは USDC.e だけでよい。
//
// 資金の関門は payer-funds.ts（USDC.e の balanceOf）、日次の別枠は budget.ts の
// CHAIN_DAILY_CAPS.tempo（既定 $2・全チェーン共有の $25 の内側）、予約は l1-runner.reserveSpend の 1 文。
// ============================================================
import { isAddress, keccak256, toBytes, type Account } from "viem";
import { MAX_PER_PURCHASE_UNITS, type ChallengeAccept } from "./x402-payer";

export const TEMPO_CHAIN_ID = 4217;
export const TEMPO_MAINNET_CAIP2 = "eip155:4217";
export const TEMPO_MODERATO_CAIP2 = "eip155:42431";
/** Bridged USDC（Stargate）— directory に載る唯一の資産（2026-09-17 実測）。decimals 6。 */
export const TEMPO_USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";
export const TEMPO_USDC_E_DECIMALS = 6;
/** 公開 RPC。既定には**しない**（レビュー #7）: 未設定は「読めない＝署名しない／照合しない／索引しない」。 */
export const TEMPO_PUBLIC_RPC_URL = "https://rpc.tempo.xyz";
/** MPP の帰属 memo に載せる我々の識別子（keccak の 10 バイト指紋になる）。 */
export const MPP_CLIENT_ID = "vet402-observatory";
/** x402_endpoints.source の値（mpp-directory.ts が同期する）。L0 が「MPP の壁を期待する」判定に使う。 */
export const MPP_DIRECTORY_SOURCE = "mpp_directory";
/** MPP の scheme 名。x402 の `exact` と同じ位置（ChallengeAccept.scheme）に置く観測属性。 */
export const MPP_CHARGE_SCHEME = "mpp:charge";

/** TEMPO_RPC_URL。未設定なら null——公開 RPC へ黙って倒れない（Arc の ARC_RPC_URL と同じ作法）。 */
export function tempoRpcUrl(): string | null {
  const raw = process.env.TEMPO_RPC_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function isTempoL1Enabled(): boolean {
  return process.env.OBSERVATORY_TEMPO_L1_ENABLED === "true";
}

// 日次の別枠は budget.ts の CHAIN_DAILY_CAPS（tempo 行・L1_TEMPO_DAILY_CAP_USD・既定 $2）。

// ------------------------------------------------------------
// WWW-Authenticate: Payment … の構造化ヘッダを読む。
//
// 実測（2026-09-17・POST https://fal.mpp.tempo.xyz/fal-ai/flux/dev）: 1 本のヘッダに
// 通貨ごとの `Payment …` challenge がカンマ区切りで複数並ぶ。値は引用文字列
// （`realm="…"`）で、`request` と `opaque` は base64url の JSON。
//
// 読むのは参照実装 mppx の `Challenge.deserializeList` **だけ**（2026-09-17 独立レビュー #6）。
// 自前のパーサを真実にすると、mppx が `\uXXXX` を戻す realm と我々の realm が食い違い、
// 帰属 memo（realm の keccak）が mppx の署名と一致せず、照合が `nonce_not_used` になる。
// mppx が読めないヘッダは「署名できない」（unsignable）——予約より前に落とす（#5）。
// 我々の漏斗（selectMppChallenge）は mppx の出力に対して掛ける。
// ------------------------------------------------------------
export type MppPaymentRequest = {
  amount: string;
  currency: string;
  recipient: string | null;
  methodDetails: {
    chainId: number | null;
    /**
     * `true` か非 null のオブジェクト（mppx は Account も許して true に畳む）→ true、
     * それ以外（false・欠落・null・文字列）→ false。false の challenge には署名しない
     * （自払いガスで USDC.e が台帳の外へ出るのを防ぐ・レビュー #1）。
     */
    feePayer: boolean;
    supportedModes: string[] | null;
    /** 売り手が指定した memo。あれば我々は帰属を束縛できないので署名しない（レビュー #2）。 */
    memo: string | null;
    splits: unknown[] | null;
  };
};

export type MppChallenge = {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: MppPaymentRequest | null;
  expires: string | null;
  description: string | null;
  opaque: string | null;
  digest: string | null;
  /** credential を載せるヘッダ名（challenge の `header` パラメータ・既定 Authorization）。 */
  credentialHeader: string;
  /** この challenge だけを mppx が直列化し直したヘッダ値（`Payment …`）。署名器へ渡すのはこれ。 */
  raw: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function decodeBase64UrlJson(value: string): unknown {
  try {
    const text = Buffer.from(value, "base64url").toString("utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** mppx の feePayer の畳み方と同じ: true か非 null のオブジェクトだけを true にする。 */
export function feePayerFlag(v: unknown): boolean {
  return v === true || (typeof v === "object" && v !== null);
}

function parsePaymentRequest(raw: unknown): MppPaymentRequest | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const amount = typeof rec.amount === "string" ? rec.amount : typeof rec.amount === "number" ? String(rec.amount) : null;
  const currency = typeof rec.currency === "string" ? rec.currency : null;
  if (!amount || !currency) return null;
  const md = asRecord(rec.methodDetails);
  const modes = Array.isArray(md?.supportedModes) ? md!.supportedModes.filter((m): m is string => typeof m === "string") : null;
  return {
    amount,
    currency,
    recipient: typeof rec.recipient === "string" ? rec.recipient : null,
    methodDetails: {
      chainId: typeof md?.chainId === "number" && Number.isInteger(md.chainId) ? md.chainId : null,
      feePayer: feePayerFlag(md?.feePayer),
      supportedModes: modes,
      memo: typeof md?.memo === "string" && md.memo !== "" ? md.memo : null,
      splits: Array.isArray(md?.splits) ? md!.splits : null,
    },
  };
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

export type MppChallengeParse = { challenges: MppChallenge[]; error: string | null };

/**
 * `WWW-Authenticate` の値から Payment challenge を全部読む（mppx `Challenge.deserializeList`）。
 * 読めなければ challenges は空で error に理由——L1 はこれを unsignable として予約前に落とす。
 */
export async function parseMppChallengeHeader(header: string | null | undefined): Promise<MppChallengeParse> {
  if (!header || header.trim() === "") return { challenges: [], error: null };
  const { Challenge } = await import("mppx");
  let list: ReturnType<typeof Challenge.deserializeList>;
  try {
    list = Challenge.deserializeList(header);
  } catch (error) {
    return { challenges: [], error: `unsignable: ${String(error).slice(0, 200)}` };
  }
  const out: MppChallenge[] = [];
  for (const c of list) {
    const rec = c as unknown as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.realm !== "string" || typeof rec.method !== "string" || typeof rec.intent !== "string") continue;
    let raw: string;
    let credentialHeader: string;
    try {
      raw = Challenge.serialize(c);
      credentialHeader = Challenge.credentialHeader(c);
    } catch {
      continue;
    }
    if (!HEADER_NAME_RE.test(credentialHeader)) credentialHeader = "Authorization";
    out.push({
      id: rec.id,
      realm: rec.realm,
      method: rec.method,
      intent: rec.intent,
      request: parsePaymentRequest(rec.request),
      expires: typeof rec.expires === "string" ? rec.expires : null,
      description: typeof rec.description === "string" ? rec.description : null,
      opaque: typeof rec.opaque === "string" ? rec.opaque : null,
      digest: typeof rec.digest === "string" ? rec.digest : null,
      credentialHeader,
      raw,
    });
  }
  return { challenges: out, error: null };
}

/** 配列だけ要る呼び手（L0）向け。読めないヘッダは空。 */
export async function parseMppChallenges(header: string | null | undefined): Promise<MppChallenge[]> {
  return (await parseMppChallengeHeader(header)).challenges;
}

/** Headers から読む（L0 / L1 共通の入口）。 */
export async function parseMppChallengesFromHeaders(headers: Headers): Promise<MppChallengeParse> {
  return await parseMppChallengeHeader(headers.get("www-authenticate"));
}

/**
 * MPP challenge を x402 の accept と同じ形に写す（L0 の価格・受取先の照合と、
 * L1 の予約・記帳が同じ列を読めるように）。request の無い challenge は null。
 */
export function mppChallengeToAccept(c: MppChallenge): (ChallengeAccept & { mpp: MppChallenge }) | null {
  // 受取先が address でない challenge は「払える accept」ではない（L0 は accepts_invalid、L1 は予約前に落ちる）。
  if (!c.request || !c.request.recipient || !isAddress(c.request.recipient, { strict: false })) return null;
  const chainId = c.request.methodDetails.chainId;
  return {
    scheme: MPP_CHARGE_SCHEME,
    network: chainId === null ? "" : `eip155:${chainId}`,
    amount: c.request.amount,
    asset: c.request.currency,
    payTo: c.request.recipient,
    extra: {
      realm: c.realm,
      intent: c.intent,
      method: c.method,
      feePayer: c.request.methodDetails.feePayer,
      expires: c.expires,
    },
    mpp: c,
  };
}

export type MppSelection =
  | { accept: ChallengeAccept & { mpp: MppChallenge }; reason: null; detail: null }
  | {
      accept: null;
      /** x402 側 selectAccept と同じ語彙（台帳の status に入る）。 */
      reason: "no_eligible_accept" | "price_mismatch" | "payto_mismatch" | "over_cap";
      /** 語彙の内側の細分（raw_response_meta に残す）。 */
      detail:
        | "no_tempo_charge"
        | "wrong_chain"
        | "wrong_currency"
        | "recipient_invalid"
        | "has_splits"
        | "fee_payer_absent"
        | "seller_memo"
        | "pull_not_supported"
        | "challenge_expired"
        | "recipient_mismatch"
        | "amount_mismatch"
        | "over_cap";
    };

export type MppRefusal = Extract<MppSelection, { accept: null }>;

/**
 * 金の関門。tempo/charge・chainId 4217・USDC.e・splits 無し・pull 可・未失効の challenge
 * だけが候補で、受取先はカタログが知っていれば一致、金額はカタログ宣言と一致し上限以下。
 * 拒否の順序は x402 側と同じ（受取先の食い違いは価格より重い所見）。
 */
export function selectMppChallenge(
  challenges: readonly MppChallenge[],
  options: { declaredAmount: string | null; declaredPayTo: string | null; now?: number },
): MppSelection {
  const now = options.now ?? Date.now();
  const refuse = (reason: MppRefusal["reason"], detail: MppRefusal["detail"]): MppRefusal => ({ accept: null, reason, detail });

  const tempoCharge = challenges.filter((c) => c.method === "tempo" && c.intent === "charge" && c.request !== null);
  if (tempoCharge.length === 0) return refuse("no_eligible_accept", "no_tempo_charge");

  const onChain = tempoCharge.filter((c) => c.request!.methodDetails.chainId === TEMPO_CHAIN_ID);
  if (onChain.length === 0) return refuse("no_eligible_accept", "wrong_chain");

  const inUsdc = onChain.filter((c) => c.request!.currency.toLowerCase() === TEMPO_USDC_E.toLowerCase());
  if (inUsdc.length === 0) return refuse("no_eligible_accept", "wrong_currency");

  // 署名器（mppx）が throw する形はここで落とす（予約より前）: 受取先が address でない、
  // 第三者への分配（splits）がある、pull mode が許されない。
  const validRecipient = inUsdc.filter((c) => typeof c.request!.recipient === "string" && isAddress(c.request!.recipient, { strict: false }));
  if (validRecipient.length === 0) return refuse("no_eligible_accept", "recipient_invalid");
  const noSplits = validRecipient.filter((c) => !c.request!.methodDetails.splits || c.request!.methodDetails.splits.length === 0);
  if (noSplits.length === 0) return refuse("no_eligible_accept", "has_splits");
  // レビュー #1: feePayer が true でない challenge は、我々が手数料 token（USD 建て TIP-20）を
  // 自払いする形になる。台帳（USDC.e の額）の外へ資金が出るので署名しない。
  const sponsored = noSplits.filter((c) => c.request!.methodDetails.feePayer === true);
  if (sponsored.length === 0) return refuse("no_eligible_accept", "fee_payer_absent");
  // レビュー #2: 売り手が memo を指定すると mppx はそれを transferWithMemo に載せる。我々の
  // 帰属 memo（challengeId・realm の keccak）で tx を購入に束縛できなくなるので署名しない。
  const ownMemo = sponsored.filter((c) => c.request!.methodDetails.memo === null);
  if (ownMemo.length === 0) return refuse("no_eligible_accept", "seller_memo");
  const pullable = ownMemo.filter((c) => {
    const modes = c.request!.methodDetails.supportedModes;
    return modes === null || modes.includes("pull");
  });
  if (pullable.length === 0) return refuse("no_eligible_accept", "pull_not_supported");
  const live = pullable.filter((c) => {
    if (!c.expires) return true;
    const t = Date.parse(c.expires);
    return Number.isFinite(t) && t > now;
  });
  if (live.length === 0) return refuse("no_eligible_accept", "challenge_expired");

  const declaredPayTo = options.declaredPayTo === null ? null : options.declaredPayTo.toLowerCase();
  const eligible = declaredPayTo === null ? live : live.filter((c) => c.request!.recipient!.toLowerCase() === declaredPayTo);
  if (eligible.length === 0) return refuse("payto_mismatch", "recipient_mismatch");

  for (const c of eligible) {
    let amount: bigint;
    try {
      amount = BigInt(c.request!.amount);
    } catch {
      continue;
    }
    if (amount <= 0n) continue;
    if (options.declaredAmount !== null && c.request!.amount !== options.declaredAmount) continue;
    if (amount > MAX_PER_PURCHASE_UNITS) continue;
    const accept = mppChallengeToAccept(c);
    if (accept) return { accept, reason: null, detail: null };
  }

  const allOverCap = eligible.every((c) => {
    try {
      return BigInt(c.request!.amount) > MAX_PER_PURCHASE_UNITS;
    } catch {
      return true;
    }
  });
  if (allOverCap) return refuse("over_cap", "over_cap");
  if (options.declaredAmount !== null && eligible.some((c) => c.request!.amount !== options.declaredAmount)) {
    return refuse("price_mismatch", "amount_mismatch");
  }
  return refuse("no_eligible_accept", "no_tempo_charge");
}

// ------------------------------------------------------------
// 帰属 memo（TIP-20 transferWithMemo の bytes32）。mppx の Attribution.encode と
// 同じ配置（tests/observatory-mpp-payer.test.ts が両者のバイト一致を検査する）:
//   0..3  keccak256("mpp")[0..3] ／ 4  version 0x01 ／ 5..14 keccak(realm)[0..9]
//   15..24 keccak(clientId)[0..9]（無ければ 0）／ 25..31 keccak(challengeId)[0..6]
// これを x402 の EIP-3009 nonce・Solana の memo と同じ役割（auth_nonce）で行に残し、
// 決済照合は tx の TransferWithMemo の memo がこれと一致することを要求する。
// ------------------------------------------------------------
export const MPP_MEMO_TAG = keccak256(toBytes("mpp")).slice(0, 10); // "0x" + 4 bytes
const MPP_MEMO_VERSION = 0x01;

function fingerprint(value: string, bytes: number): Uint8Array {
  return Buffer.from(keccak256(toBytes(value)).slice(2, 2 + bytes * 2), "hex");
}

export function encodeMppAttributionMemo(input: { challengeId: string; realm: string; clientId?: string | null }): `0x${string}` {
  const buf = new Uint8Array(32);
  buf.set(Buffer.from(MPP_MEMO_TAG.slice(2), "hex"), 0);
  buf[4] = MPP_MEMO_VERSION;
  buf.set(fingerprint(input.realm, 10), 5);
  if (input.clientId) buf.set(fingerprint(input.clientId, 10), 15);
  buf.set(fingerprint(input.challengeId, 7), 25);
  return `0x${Buffer.from(buf).toString("hex")}`;
}

/** memo が MPP の帰属 memo か（tag + version）。索引の attribution に使う。 */
export function isMppAttributionMemo(memo: string | null | undefined): boolean {
  if (typeof memo !== "string" || memo.length !== 66) return false;
  return memo.slice(0, 10).toLowerCase() === MPP_MEMO_TAG.toLowerCase() && memo.slice(10, 12) === "01";
}

// ------------------------------------------------------------
// 受領証（Payment-Receipt ヘッダ・base64url JSON）。
//   { method:"tempo", reference:"<tx hash>", status:"success", timestamp, … }
// x402 の parseSettlementResponse と同じ形へ写す（呼び手が同じ列に書けるように）。
// ------------------------------------------------------------
export function parseMppReceipt(headers: Headers): {
  success: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
  errorReason: string | null;
  /** 受領証の生 JSON（rawSettlement に残す）。 */
  receipt: Record<string, unknown> | null;
} | null {
  const raw = headers.get("payment-receipt");
  if (!raw) return null;
  const rec = asRecord(decodeBase64UrlJson(raw));
  if (!rec) return { success: false, transaction: null, network: null, payer: null, errorReason: "unparseable_receipt", receipt: null };
  const reference = typeof rec.reference === "string" && rec.reference !== "" ? rec.reference : null;
  return {
    success: rec.status === "success",
    transaction: reference,
    network: rec.method === "tempo" ? TEMPO_MAINNET_CAIP2 : null,
    payer: null,
    errorReason: rec.status === "success" ? null : "receipt_status_not_success",
    receipt: rec,
  };
}

// ------------------------------------------------------------
// 署名（credential の作成）。ネットワーク I/O を含む（Tempo RPC で nonce・gas を読む）。
// 参照実装 mppx/client に委ねるが、ピンは我々が渡す。テストは `deps.mppxCharge` を
// 差し替えて「どのピンを渡したか」を検査する（ネットワークへは出ない）。
// ------------------------------------------------------------
export type MppChargePins = {
  expectedChainId: number;
  allowedChainIds: readonly number[];
  expectedRecipients: readonly `0x${string}`[];
  mode: "pull";
  clientId: string;
  rpcUrl: Record<number, string>;
};

export function buildMppChargePins(recipient: string): MppChargePins {
  if (!isAddress(recipient, { strict: false })) throw new Error("mpp: recipient is not an address");
  return {
    expectedChainId: TEMPO_CHAIN_ID,
    allowedChainIds: [TEMPO_CHAIN_ID],
    expectedRecipients: [recipient as `0x${string}`],
    mode: "pull",
    clientId: MPP_CLIENT_ID,
    rpcUrl: { [TEMPO_CHAIN_ID]: tempoRpcUrl() ?? "" },
  };
}

export type MppxCharge = (input: {
  account: Account;
  pins: MppChargePins;
  /** 選んだ 1 つの challenge だけを載せた 402 応答（他の通貨の challenge は渡さない）。 */
  response: Response;
}) => Promise<string>;

/** 本番の署名器: mppx/client（サーバ専用・動的 import・globalThis.fetch は差し替えない）。 */
export const defaultMppxCharge: MppxCharge = async ({ account, pins, response }) => {
  const { Mppx, tempo } = await import("mppx/client");
  const { createClient, http } = await import("viem");
  const { tempo: tempoChain } = await import("viem/tempo/chains");
  const rpc = pins.rpcUrl[pins.expectedChainId];
  if (!rpc) throw new Error("tempo_rpc_unset: TEMPO_RPC_URL is required to sign an MPP charge");
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        account,
        clientId: pins.clientId,
        expectedChainId: pins.expectedChainId,
        allowedChainIds: pins.allowedChainIds,
        expectedRecipients: pins.expectedRecipients,
        mode: pins.mode,
        // RPC は我々が決める（mppx の既定 rpc.tempo.xyz へ黙って倒れない）。Tempo の
        // serializer を持つ chain 定義を渡す（type 0x76 の封筒はここから来る）。
        getClient: () => createClient({ chain: tempoChain, transport: http(rpc, { timeout: 10_000, retryCount: 1 }) }),
      }),
    ],
    polyfill: false,
  });
  return await mppx.createCredential(response);
};

/**
 * 選ばれた challenge の credential（`Authorization: Payment …` の値）を作る。
 * 返す memo は auth_nonce として行に残す（決済照合の束縛材料）。
 */
export async function createMppCredential(
  input: { account: Account; challenge: MppChallenge; recipient: string },
  deps: { mppxCharge?: MppxCharge } = {},
): Promise<{ headerName: string; headerValue: string; memo: `0x${string}`; pins: MppChargePins }> {
  const { account, challenge, recipient } = input;
  if (challenge.method !== "tempo" || challenge.intent !== "charge") throw new Error("mpp: not a tempo/charge challenge");
  // 売り手 memo の challenge はここまで来ない（selectMppChallenge が seller_memo で落とす）が、二重防御。
  if (challenge.request?.methodDetails.memo) throw new Error("mpp: seller-specified memo cannot be bound to this purchase");
  if (challenge.request?.recipient?.toLowerCase() !== recipient.toLowerCase()) throw new Error("mpp: recipient does not match the challenge");
  const pins = buildMppChargePins(recipient);
  const response = new Response(null, { status: 402, headers: { "www-authenticate": challenge.raw } });
  const credential = await (deps.mppxCharge ?? defaultMppxCharge)({ account, pins, response });
  if (typeof credential !== "string" || !/^Payment\s+\S+$/.test(credential)) {
    throw new Error("mpp: signer returned a credential that is not `Payment <base64url>`");
  }
  // auth_nonce は常に我々の帰属 memo（mppx も同じ入力・同じ配置で作る——テストがバイト一致を固定）。
  const memo = encodeMppAttributionMemo({ challengeId: challenge.id, realm: challenge.realm, clientId: MPP_CLIENT_ID });
  // credential を載せるヘッダは challenge の `header` パラメータ（既定 Authorization）。
  //
  // 2026-09-19（横断監査 W1）: ここを `authorization` に固定しない。MPP のサーバは自分が
  // 広告した名前でしか credential を読まない（mppx server/Transport.js getCredential は
  // `header` の名前——requiresAuth の売り手なら `Payment-Authorization`——だけを見る）ので、
  // 固定すると払ったのに 402 が返り、我々の不具合を売り手の不履行として台帳に書くことになる。
  // 代わりに、**漏れる経路の側**に関門を置いた: 呼び手（l1-runner の有料レグ）がこの名前を
  // safe-fetch へ宣言し、別オリジンへの転送では固定名の表と同じく必ず落ちる。
  return { headerName: challenge.credentialHeader.toLowerCase(), headerValue: credential, memo, pins };
}

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** 購入元の USDC.e 残高（基本単位）。TEMPO_RPC_URL を読む。未設定は throw → 呼び手は署名しない側へ倒す。 */
export async function readTempoUsdcBalance(owner: string): Promise<bigint> {
  const rpc = tempoRpcUrl();
  if (!rpc) throw new Error("tempo_rpc_unset: TEMPO_RPC_URL is required to read the payer's USDC.e balance");
  const { createPublicClient, http } = await import("viem");
  const { tempo } = await import("viem/chains");
  const client = createPublicClient({ chain: tempo, transport: http(rpc, { timeout: 5_000, retryCount: 1 }) });
  return await client.readContract({
    address: TEMPO_USDC_E as `0x${string}`,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [owner as `0x${string}`],
  });
}

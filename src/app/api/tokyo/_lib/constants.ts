// ============================================================
// /tokyo の定数（PLAN_v4.3 §3.7.1 W02・W04・W06）。**数と番地はここにしか置かない。**
//
// 審査員ボタンが書けるのは、下の4点（宛先 P_D・node・キー・値の2つ）の組だけ。
// リクエストが決めるのは「10001 にするか 10000 に戻すか」の1つだけで、
// 番地も名前もキーも値も、リクエストからは取らない。
//
// seller-a.eth はここに無い。W_op は P_a の x402-offer も書ける鍵なので
// （K1-06）、seller-a.eth を壊さない守りは「P_a の番地と seller-a の名前を
// このボタンの経路に1つも置かない」ことで持つ（tests/tokyo-mutate.test.ts W06）。
// ============================================================

/** Sepolia。リクエストからは取らず、サーバの RPC の getChainId() と照合する（W02）。 */
export const CHAIN_ID = 11155111 as const;

/** 壊してよい唯一の名前。 */
export const SELLER_D = "seller-d.eth" as const;

/** seller-d.eth 専用の PermissionedResolver（K1-D2 で配備・census の K1_ADDR.P_d と同じ）。 */
export const P_D = "0x9CF7990dAB364d1738ABB09532b953Ec48269831" as const;

/** dns("seller-d.eth")。PermissionedResolver.setText の第1引数は DNS 符号化の名前。 */
export const NODE = "0x0873656c6c65722d640365746800" as const;

/** 書いてよい唯一のキー。 */
export const KEY = "x402-offer" as const;

/** 約束の amount の2値。 */
export const AMOUNT = { off: "10000", on: "10001" } as const;

/**
 * x402-offer の2値（266 バイトの1行 JSON。K1 の mkOffer と同じ文字列で、違いは amount の1文字だけ）。
 * off が素の状態（証明が署名した値）、on が審査員が1文字変えた値。
 */
export const VALUES = {
  off: '{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","amount":"10000","payTo":"0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6","output":{"required":["result","observed_at"]}}',
  on: '{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","amount":"10001","payTo":"0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6","output":{"required":["result","observed_at"]}}',
} as const;

/** W_op（委任鍵）の公開アドレス。env の鍵から導いたアドレスがこれと違えば署名しない。 */
export const W_OP = "0xE3BB99911A8037F22D4d6b3a4d955D1b02229080" as const;

/** P_d で W_op が持つロール（setText の1ビット）。 */
export const ROLE_SET_TEXT = 0x10;

/** 証明のキー。W_op がここへ書こうとすると EACUnauthorizedAccountRoles で止まる（画面で eth_call して見せる）。 */
export const ATTESTATION_KEY = "attestations[x402-offer][atst.vet402.eth]" as const;

// ---- W03: 押下の上限と停止スイッチ ----
/** 1日（UTC）に押せる回数。資金の実測から（§4）。 */
export const DAILY_CAP = 60;
/** 同じ IP（のハッシュ）からの連打の間隔。関門には数えない。 */
export const IP_INTERVAL_MS = 20_000;
/** runtime_flags.name。止めるのは SQL 1文（§3.7.1「止め方」）。 */
export const HALT_FLAG = "tokyo_button_halt" as const;

// ---- W04: 残高の床 ----
/** 床の固定部分 0.005 ETH。 */
export const BALANCE_FLOOR_WEI = 5_000_000_000_000_000n;
/**
 * 1回押す = 変える＋戻すの2 tx。計画の実測は 78,506 × 2 = 157,012。
 * 2026-09-26 の estimateGas（W_op → P_d.setText(seller-d, x402-offer, 10001)）が 80,296 だったので、大きい方を取る。
 */
export const PRESS_GAS = 160_592n;
/** gasPrice の揺れに対する余裕。 */
export const GAS_SAFETY = 3n;

// ---- W05: 次に来た人が来たときに戻す ----
/** state から戻すのは、変えてからこの時間が過ぎた後だけ。 */
export const STATE_REVERT_AFTER_MS = 90_000;
/** 戻す権利（reverting_until）の長さ。 */
export const REVERT_CLAIM_SECONDS = 60;
/** 署名の排他（job_leases）。 */
export const LEASE_NAME = "tokyo-mutate" as const;
export const LEASE_TTL_SECONDS = 60;
/** 1本の tx の受領を待つ上限。mutate は最大2本を順に待つので、maxDuration 60 秒の内側に収める。 */
export const RECEIPT_TIMEOUT_MS = 25_000;

// ---- 読み取りの使い回し（RPC を大量に呼ばせない）----
/** 同じ名前の検証結果をプロセス内で使い回す長さ。読み終えた時刻から数える。 */
export const VERIFY_CACHE_MS = 12_000;
/** 使い回す名前の数の上限（古いものから捨てる）。 */
export const VERIFY_CACHE_MAX = 200;
/** state が読むチェーンの値（chainId・残高・gasPrice・seller-d.eth の約束）を使い回す長さ。 */
export const STATE_CACHE_MS = 5_000;
/** mutate / reset の応答に入れる「押した後の7段」を読む時間の上限。 */
export const AFTER_WRITE_BUDGET_MS = 30_000;
/** mutate / reset がここまでに応答を返す（maxDuration 60 秒の内側）。押した後の7段はこの残りでだけ読む。 */
export const RESPONSE_DEADLINE_MS = 50_000;

// ---- 読み取り（verify）----
export const DEFAULT_RPC = "https://sepolia.rpc.sentio.xyz" as const;
export const SECONDARY_RPC = "https://rpc.sepolia.ethpandaops.io" as const;
/** 検証が照合する約束の口と方法（CLI の verify と同じ既定）。 */
export const SELLER_RESOURCE = "https://vet402.com/api/tokyo/seller" as const;
export const SELLER_METHOD = "GET" as const;
/** base-sepolia の chain profile のうち checkEnsOffer が読む2欄。 */
export const BASE_SEPOLIA_PROFILE = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;
/** examples/tokyo-2026-demo/trusted-attesters.json と同じ値（テストで一致を固定）。公開の検証の鮮度は 7 日。 */
export const TRUSTED_ATTESTERS = [
  { name: "atst.vet402.eth", address: "0xDeb7C52356bCc227c1688cb39C9b66AF00A50b27", recordKeys: ["x402-offer"] },
] as const;
export const MIN_VALID = 1;
export const MAX_AGE_SECONDS = 604_800;

export const EXPLORER = "https://sepolia.etherscan.io" as const;
export const REPO_DEMO = "https://github.com/kzmttkc/vet402/tree/tokyo-2026-submission/examples/tokyo-2026-demo" as const;

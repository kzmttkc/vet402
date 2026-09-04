/**
 * x402 `exact` の支払い実行（EIP-3009 の署名 → facilitator `/settle`）。
 *
 * **このファイルは `payOrRefuse` の ALLOW ブランチからしか動的 import されない**
 * （`docs/ethonline-2026/WINDOW_PLAN.md` §4「呼べないことの4層証明」の第3層）。
 * 拒否経路ではモジュールの評価すら起きないので、「signer を呼ばなかった」ではなく
 * 「signer に**到達できない**」を構造で言える。static import に戻すと、この保証は消える。
 */
const TRANSFER_WITH_AUTHORIZATION = [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
];
/** 署名の有効窓。短いほど良いが、facilitator の確定までは持たせる必要がある。 */
const AUTHORIZATION_TTL_SECONDS = 600;
function randomNonce() {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
/**
 * 署名して facilitator に settle させる。**判定は一切しない**——ここへ来た時点で
 * 通っている、というのが `payOrRefuse` との契約。金額・チェーン・asset・payTo の
 * 検査を呼び出し側に残すのは、この関数を単体で「安全な支払い」として再利用させないため。
 */
export async function executeX402Payment(args) {
    const { accept } = args;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const message = {
        from: args.account.address,
        to: accept.payTo,
        value: accept.amount,
        validAfter: "0",
        validBefore: String(nowSeconds + AUTHORIZATION_TTL_SECONDS),
        nonce: randomNonce(),
    };
    // ここが「署名が存在する」唯一の行。プロパティ参照は1回だけに保つ
    // （テスト側の Proxy は回数ではなく参照そのものを数えている）。
    const signature = await args.account.signTypedData({
        domain: {
            name: accept.extra?.name ?? "USD Coin",
            version: accept.extra?.version ?? "2",
            chainId: args.chainId,
            verifyingContract: accept.asset,
        },
        types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
        primaryType: "TransferWithAuthorization",
        message,
    });
    const payload = {
        x402Version: 2,
        scheme: accept.scheme,
        network: accept.network,
        payload: { signature, authorization: message },
    };
    let settled = false;
    let txHash = null;
    try {
        const response = await args.fetch(`${args.facilitatorUrl.replace(/\/$/, "")}/settle`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: accept }),
        });
        let body = {};
        try {
            body = await response.json();
        }
        catch {
            body = {};
        }
        const ok = typeof body === "object" && body !== null && body.success === true;
        if (response.ok && ok) {
            settled = true;
            const tx = body.transaction;
            txHash = typeof tx === "string" ? tx : null;
        }
    }
    catch {
        settled = false;
    }
    return { signed: true, settled, txHash, payload };
}

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { explainTrustScore } from "./explain.js";
import { sanitizeToolError } from "./tool-errors.js";
import { payIfTrusted } from "./pay-if-trusted.js";
import { decideFromScore, decideFromFailure } from "./decision.js";
import { attestX402Payment, fetchAgentScore, fetchDecision, fetchPayeeScore, fetchWalletScore, } from "./vouch-client.js";
const server = new McpServer({
    name: "vouch-trust",
    version: "0.2.0",
});
/**
 * 2026-08-23 監査: MCP は判定を**型で**返す。
 *
 * 以前は API 応答をそのまま JSON にして返し、「degraded なら ALLOW として
 * 扱うな」は説明文の散文でしか言っていなかった。SDK の SpendGuard は同じ規律を
 * 型と分岐で強制しているのに、エージェント統合の主経路である MCP だけが
 * モデルの読解に依存していた。散文は無視できるが、フィールドは無視できない。
 *
 * 返す形は decision / safe_to_pay を**先頭**に置き、その後ろに測定そのものを
 * 付ける。読み手が最初に当たるのが判定になるように。
 */
function scoreToolResult(score) {
    const decision = decideFromScore(score);
    return {
        content: [{ type: "text", text: JSON.stringify({ ...decision, measurement: score }, null, 2) }],
        // ALLOW_PAY 以外を isError にはしない——REFUSE は「ツールが壊れた」ではなく
        // 「見た上での結論」。エラーと結論を混ぜると呼び手が区別できなくなる。
    };
}
/** 答えが返らなかったとき。沈黙は ALLOW ではない、を機械可読で返す。 */
function scoreToolFailure(error) {
    const detail = sanitizeToolError(error);
    const decision = decideFromFailure(detail);
    return {
        content: [{ type: "text", text: JSON.stringify(decision, null, 2) }],
        isError: true,
    };
}
const AGENT_ID = z.string().max(78).describe("ERC-8004 agent ID (tokenId)");
const WALLET = z.string().max(42).describe("EVM wallet address (0x...)");
const TX_HASH = z.string().max(66).describe("Payment transaction hash (0x + 64 hex)");
server.tool("check_agent_trust", [
    "ERC-8004 agent trust check on Base.",
    "Decide on decision (ALLOW_PAY | REFUSE) and safe_to_pay (boolean); pay only on",
    "ALLOW_PAY. An error result is REFUSE too — no answer is not an ALLOW.",
    "measurement carries the full score body as evidence, not as the decision.",
].join("\n"), {
    agentId: AGENT_ID,
    wallet: WALLET.optional().describe("Optional wallet to verify against agentWallet metadata"),
}, async ({ agentId, wallet }) => {
    try {
        const result = await fetchAgentScore(agentId, wallet);
        return scoreToolResult(result);
    }
    catch (error) {
        return scoreToolFailure(error);
    }
});
server.tool("check_wallet_trust", [
    "Trust check for a wallet address. Resolves ERC-8004 agents when registered.",
    "Decide on decision (ALLOW_PAY | REFUSE) and safe_to_pay (boolean); pay only on",
    "ALLOW_PAY. An error result is REFUSE too — no answer is not an ALLOW.",
    "measurement carries the full score body as evidence, not as the decision.",
].join("\n"), {
    wallet: WALLET,
}, async ({ wallet }) => {
    try {
        const result = await fetchWalletScore(wallet);
        return scoreToolResult(result);
    }
    catch (error) {
        return scoreToolFailure(error);
    }
});
// The description is the only thing the model reads before deciding what the
// result MEANS. It used to name score / dataDepth / ALLOW-WARN-BLOCK and stop
// there, so a model that got a `degraded` body with a stale ALLOW in it had
// no instruction not to act on it. The raw JSON always carried the two fields
// (the tool returns JSON.stringify of the whole body); nothing told the model
// they outrank the recommendation. Now it does. — 2026-08-22 audit
server.tool("check_payee_trust", [
    "Buyer-side check before paying a wallet.",
    "",
    "Read these two fields and nothing else to decide:",
    "- decision: ALLOW_PAY | REFUSE",
    "- safe_to_pay: boolean (always equals decision === ALLOW_PAY)",
    "",
    "Pay only on ALLOW_PAY. REFUSE already accounts for a degraded read, a",
    "partial measurement, a stale score, and a non-ALLOW recommendation;",
    "refuse_reasons names which. An error result is also REFUSE with",
    "safe_to_pay false — no answer is not an ALLOW.",
    "",
    "measurement carries the full score body (score, dataDepth, signals) for",
    "explanation and logging. It is evidence, not the decision.",
].join("\n"), {
    payee: WALLET.describe("Payee wallet address (0x...) the agent is about to pay"),
}, async ({ payee }) => {
    try {
        const result = await fetchPayeeScore(payee);
        return scoreToolResult(result);
    }
    catch (error) {
        return scoreToolFailure(error);
    }
});
server.tool("explain_trust_score", "Explain a trust score breakdown in plain language for an agent or wallet.", {
    agentId: AGENT_ID.optional(),
    wallet: WALLET.optional(),
}, async ({ agentId, wallet }) => {
    try {
        if (!agentId && !wallet) {
            throw new Error("agentId or wallet is required");
        }
        const result = agentId
            ? await fetchAgentScore(agentId, wallet)
            : await fetchWalletScore(wallet);
        return {
            content: [{ type: "text", text: explainTrustScore(result) }],
        };
    }
    catch (error) {
        return {
            content: [{ type: "text", text: sanitizeToolError(error) }],
            isError: true,
        };
    }
});
server.tool("attest_x402_payment", "Record an x402 payment attestation after settlement verification (idempotent on txHash).", {
    wallet: WALLET,
    txHash: TX_HASH,
    amount: z.string().max(78).optional(),
    network: z.string().max(32).optional(),
    resource: z.string().max(512).optional(),
}, async ({ wallet, txHash, amount, network, resource }) => {
    try {
        const result = await attestX402Payment({
            wallet,
            txHash,
            amount,
            network,
            resource,
        });
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (error) {
        return {
            content: [{ type: "text", text: sanitizeToolError(error) }],
            isError: true,
        };
    }
});
// ============================================================
// pay_if_trusted（ETHOnline 2026 / WINDOW_PLAN §2 #2）
//
// 上の4本は判定を**返す**。払うかどうかは呼び手が決める。これは signer を**握る**——
// 判定が ALLOW でなければ支払いモジュールは評価すらされない（§4「呼べないことの4層証明」）。
//
// **既定では払えない。** 署名鍵が設定されていなければ、このツールは関門を最後まで走らせて
// 判定を返し、支払いだけを構造的に起こさない。金を動かす能力を、設定していない利用者に
// 黙って持たせない。
// ============================================================
/** 触れられたら throw する署名者。payer 未設定のとき payIfTrusted へ渡す値で、到達しない。 */
const UNCONFIGURED_SIGNER = {
    address: "0x0000000000000000000000000000000000000000",
    signTypedData: async () => {
        throw new Error("payer_not_configured");
    },
};
/**
 * 署名者を作る。**viem はこのパッケージの依存ではない**——MCP サーバに秘密鍵を持たせるのは
 * 利用者が明示的に選ぶことなので、既定のインストールにその能力を含めない。
 * 鍵が設定されていて viem が解決できたときだけ署名者を返し、それ以外は null（fail-closed）。
 */
async function resolvePayer() {
    const key = process.env.VOUCH_PAYER_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
        return null;
    try {
        // 変数指定子。viem を静的依存にしない（未インストールでもビルドと起動が通る）。
        const specifier = "viem/accounts";
        const mod = await import(specifier);
        const account = mod.privateKeyToAccount(key);
        return {
            address: account.address,
            signTypedData: (typedData) => account.signTypedData(typedData),
        };
    }
    catch {
        return null;
    }
}
async function main() {
    // 製品定義書 §9.1（2026-09-02）: 新規統合は /decision を正規とする。
    // facts（L0–L2 の測定記録）と recommendation が同じ応答にある。
    const RESOURCE_ID = z.string().regex(/^[0-9a-f]{64}$/).describe("resource_id — sha256(method + \" \" + canonical_url). Get it from /api/v1/resolve?q=<url>");
    server.tool("check_resource_decision", [
        "Pre-payment decision for an x402 resource (role=payer) or pre-service decision for a payer (role=payee).",
        "Decide on decision (ALLOW_PAY | REFUSE) and safe_to_pay (boolean); pay only on ALLOW_PAY.",
        "WARN and BLOCK are both REFUSE under the default allow-only policy. An error is REFUSE too.",
        "measurement carries the full decision body: facts (L0 liveness, L1 settle-through, L2 conformance),",
        "reason_codes, freshness, evidence, and the rules_version that produced the recommendation.",
    ].join("\n"), {
        resourceId: RESOURCE_ID,
        role: z.enum(["payer", "payee"]).optional().describe("payer (default): should my agent pay this resource? payee: should this seller serve this payer?"),
        payer: z.string().max(120).optional().describe("Required when role=payee: chain:address, or a bare 0x / base58 address"),
        callerDialect: z.enum(["v1", "v2"]).optional().describe("Your x402 client dialect; a mismatch with the seller's wall is a WARN"),
    }, async ({ resourceId, role, payer, callerDialect }) => {
        try {
            const result = await fetchDecision(resourceId, { role, payer, callerDialect });
            const allow = result.recommendation === "ALLOW" && !result.degraded;
            const decision = {
                decision: allow ? "ALLOW_PAY" : "REFUSE",
                safe_to_pay: allow,
                refuse_reasons: allow ? [] : result.reason_codes,
                summary: `${result.recommendation} (${result.rules_version}) — ${result.reason_codes.join(", ")}`,
            };
            return { content: [{ type: "text", text: JSON.stringify({ ...decision, measurement: result }, null, 2) }] };
        }
        catch (error) {
            return scoreToolFailure(error);
        }
    });
    server.tool("pay_if_trusted", [
        "Pay an x402 resource ONLY if vet402's decision allows it. Unlike check_resource_decision,",
        "which returns a verdict for you to act on, this tool holds the signer: on anything other",
        "than ALLOW the payment module is never even loaded, so no signature can exist.",
        "",
        "Read these two fields and nothing else to know what happened:",
        "- decision: PAID | REFUSE | FAILED",
        "- safe_to_pay: boolean (always equals decision === PAID)",
        "",
        "REFUSE means it stopped BEFORE a signature existed; refuse_reasons carries the server's own",
        "reason_codes unchanged, plus one of evidence_unavailable, payee_recommendation_not_allow,",
        "payment_target_unknown, payer_not_configured, payee_mismatch, chain_or_asset_mismatch,",
        "price_above_ceiling. FAILED means it signed and the seller did not settle — signed and nonce",
        "are returned, not hidden, because the authorization stays live until validBefore.",
        "",
        "settlement is at most settle_claimed: the seller's PAYMENT-RESPONSE header is a claim, not an",
        "on-chain confirmation. measurement carries the /decision body verbatim, including evidence[]",
        "with each row's own source (vet402 or subgraph) so you can check which ledger answered.",
        "",
        "Omit resource/payee/amountUsd to run the gate without paying. Paying also requires",
        "VOUCH_PAYER_PRIVATE_KEY in this server's env and viem installed; without them the tool still",
        "returns the decision and refuses with payer_not_configured.",
    ].join("\n"), {
        resourceId: RESOURCE_ID,
        resource: z.string().max(2048).optional().describe("URL that answers 402. Required to actually pay."),
        payee: WALLET.optional().describe("Address you already expect to be paid; the 402's payTo must match it"),
        amountUsd: z.number().nonnegative().optional().describe("What you believe this costs, in USD"),
        method: z.string().max(10).optional().describe("HTTP method of the resource (default GET; The Graph's x402 endpoint is POST)"),
        maxPerTxUsd: z.number().positive().optional().describe("Per-payment ceiling in USD (default 1)"),
    }, async ({ resourceId, resource, payee, amountUsd, method, maxPerTxUsd }) => {
        try {
            const apiKey = process.env.VOUCH_API_KEY;
            if (!apiKey)
                throw new Error("missing_api_key");
            const rawTimeout = Number(process.env.VOUCH_TIMEOUT_MS);
            const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10_000;
            // 注入する fetch は必ず期限付き。ハングした上流はツール呼び出しを永久に返さず、
            // 返らない呼び出しはモデルが fail-closed に扱えない（vouch-client.ts と同じ規律）。
            const boundedFetch = (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
            const signer = await resolvePayer();
            const wantsPayment = resource !== undefined || payee !== undefined || amountUsd !== undefined;
            const result = await payIfTrusted({
                resourceId,
                signer: signer ?? UNCONFIGURED_SIGNER,
                fetch: boundedFetch,
                apiUrl: process.env.VOUCH_API_URL,
                apiKey,
                // payer が無いなら支払い先を**渡さない**。渡さなければ ALLOW でも第5段へ進めない。
                ...(signer ? { resource, payee, amountUsd, method, maxPerTxUsd } : {}),
            });
            if (!signer && wantsPayment) {
                result.refuse_reasons = [
                    ...result.refuse_reasons.filter((r) => r !== "payment_target_unknown"),
                    "payer_not_configured",
                ];
                result.summary =
                    "This server has no payer: set VOUCH_PAYER_PRIVATE_KEY in its env block and install viem " +
                        "in the server package to enable payment. The decision above was still measured.";
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (error) {
            return scoreToolFailure(error);
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});

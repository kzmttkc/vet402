#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { explainTrustScore } from "./explain.js";
import { sanitizeToolError } from "./tool-errors.js";
import { decideFromScore, decideFromFailure } from "./decision.js";
import { attestX402Payment, fetchAgentScore, fetchDecision, fetchPayeeScore, fetchWalletScore, } from "./vouch-client.js";
const server = new McpServer({
    name: "vouch-trust",
    version: "0.1.0",
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
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});

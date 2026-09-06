/**
 * 実 LLM を呼ぶアダプタ。**このセッションでは一度も実行していない**（実行は依頼元。
 * 課金と人間の判断が発生する）。純粋な部分——要求の組み立て・ツール往復・応答からの本文取り出し——
 * だけをテストで固定してある。
 *
 * **2026-09-06: Bazantic Gateway の MCP を tool として渡すようになった。**
 * それまではここが `messages.create` を1発叩くだけで、**ツールもネットワークも与えていなかった**——
 * Gateway の URL はプロンプトに文字列として載っていただけで、MCP は経路に入っていなかった。
 * 賞の問いは "Show us it can be done **using Bazantic built MCP server and recipe**" なので、
 * それでは中核を実演していない。
 *
 * **A と B には同じツールを渡す**（賞の要件 #5「Recipe を唯一の実質的な違いにする」）。
 * ツール一覧は `toolProvider` が1回だけ引いて使い回すので、条件で変わりようがない。
 *
 * SDK は**動的 import** する。examples に依存を持たせないため
 * （`npm i @anthropic-ai/sdk` を打った人だけが使える形）。
 *
 * **temperature を送らない。** 現行モデル（Claude Opus 5 等）は `temperature` /
 * `top_p` を受け付けず 400 を返す。§16 は「同一 temperature」を要求しているが、
 * **設定できないものは設定しない**。全試行で null（=送っていない）が揃っていることを
 * ハーネスがメタに残す。これは事前登録からの逸脱なので報告に書く。
 */
import { createMcpToolProvider, toAnthropicTools } from "../mcp.mjs";
import { RECIPE_FILE } from "../recipe.mjs";

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_EFFORT = "high";
/** ツール往復の上限。**超えたら止める**（黙って回り続けて課金だけ増える形にしない）。 */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/** @returns Messages API へそのまま渡す params。 */
export function buildRequestParams({ prompt, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, effort = DEFAULT_EFFORT, tools, messages }) {
  const params = {
    model,
    max_tokens: maxTokens,
    // thinking は指定しない——Claude Opus 5 は既定で adaptive。
    output_config: { effort },
    messages: messages ?? [{ role: "user", content: prompt }],
  };
  // **ツールが無いときは載せない。** 空配列を送ると「道具を与えたが空だった」に見える。
  if (Array.isArray(tools) && tools.length > 0) params.tools = tools;
  return params;
}

/** text ブロックだけを連結する。thinking を混ぜない（採点対象は答えだけ）。 */
export function extractText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

/** tool_use ブロックだけ取り出す。 */
export function extractToolUses(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((b) => b?.type === "tool_use");
}

/**
 * `DEMO_PAYER_PRIVATE_KEY` があれば署名者を作る。**この環境変数だけを読む**（鍵ファイルの復号は
 * ハーネスに入れない）。viem は動的 import——鍵の無い実行では読み込みすら起きない。
 * 鍵が無ければ null（橋は無く、402 はそのままモデルへ返る）。
 */
export async function payerFromEnv(env = process.env) {
  const key = env?.DEMO_PAYER_PRIVATE_KEY;
  if (typeof key !== "string" || key.length === 0) return null;
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  return { address: account.address, signTypedData: (td) => account.signTypedData(td) };
}

/** MCP の `tools/call` の戻りを、そのまま tool_result の中身にできる形へ。 */
function toToolResultContent(mcpResult) {
  const content = mcpResult?.content;
  if (Array.isArray(content) && content.length > 0) {
    const textOnly = content.filter((c) => c?.type === "text");
    if (textOnly.length === content.length) return textOnly.map((c) => c.text).join("\n");
  }
  return JSON.stringify(mcpResult ?? null);
}

/**
 * `runAgent` を作る。**依頼元が実行する唯一の場所。**
 *
 * - `client` を渡さなければ `@anthropic-ai/sdk` を動的 import して作る
 * - `toolProvider` を渡さなければ **Bazantic Gateway の MCP** につなぐ
 *   （`recipe/*.json` の `source.mcpUrl`。`mcpUrl` 引数で上書きできる）。
 *   `env.DEMO_PAYER_PRIVATE_KEY` があれば `payer` を作って渡し、**$0 の x402 402 を REST で払う橋**
 *   が有効になる（`src/mcp.mjs`）。Bazantic は $0 でも 402 を返し、MCP では払えないため。
 *   A/B の両条件に同一に効く（provider は1つ・条件を見ない）。
 *
 * どちらも1つの引数に隔離してあるので、**鍵もネットワークも無い環境で経路そのものを検査できる**
 * （`test/agents.test.mjs` / `test/mcp.test.mjs`）。
 */
export async function createAnthropicAgent({
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  maxTokens = DEFAULT_MAX_TOKENS,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
  client,
  toolProvider,
  mcpUrl,
  fetchImpl,
  payer,
  env = process.env,
} = {}) {
  let sdk = client;
  if (sdk === undefined) {
    let mod;
    try {
      mod = await import("@anthropic-ai/sdk");
    } catch {
      throw new Error(
        "the anthropic adapter needs the official SDK: run `npm i @anthropic-ai/sdk` in " +
          "examples/ethonline-2026-ab, and set ANTHROPIC_API_KEY (or `ant auth login`).",
      );
    }
    const Anthropic = mod.default ?? mod.Anthropic;
    sdk = new Anthropic();
  }

  let provider = toolProvider;
  if (provider === undefined) {
    const { readFile } = await import("node:fs/promises");
    const url = mcpUrl ?? JSON.parse(await readFile(RECIPE_FILE, "utf8")).source.mcpUrl;
    const resolvedPayer = payer !== undefined ? payer : await payerFromEnv(env);
    provider = createMcpToolProvider({
      url,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      ...(resolvedPayer ? { payer: resolvedPayer } : {}),
    });
  }

  // **ツール一覧は全試行を通して1回だけ解決する。**
  // A と B で同じ一覧が渡ることを、規律ではなく構造で保証する（賞の要件 #5）。
  // `provider` 側の実装が毎回引き直す作りでも、ここで固定されるので条件で変わりようがない。
  let toolsPromise = null;
  const resolveTools = () => {
    if (toolsPromise === null) {
      toolsPromise = Promise.resolve(provider.listTools())
        .then((mcpTools) => Object.freeze(toAnthropicTools(mcpTools)))
        .catch((e) => {
          toolsPromise = null;
          throw e;
        });
    }
    return toolsPromise;
  };

  return async function runAgent(prompt) {
    const tools = await resolveTools();

    const messages = [{ role: "user", content: prompt }];
    const toolCalls = [];
    let message = null;

    for (let round = 0; round <= maxToolRounds; round += 1) {
      message = await sdk.messages.create(buildRequestParams({ prompt, model, maxTokens, effort, tools, messages }));
      const uses = extractToolUses(message);
      if (uses.length === 0) break;
      if (round === maxToolRounds) {
        throw new Error(`agent exceeded ${maxToolRounds} tool rounds without producing an answer`);
      }
      messages.push({ role: "assistant", content: message.content });
      const results = [];
      for (const use of uses) {
        try {
          const out = await provider.callTool(use.name, use.input);
          // **橋が払ったなら、その tx を生ログに残す**（null = 橋は動いていない）。tx は生ログから数え直せる。
          toolCalls.push({ name: use.name, input: use.input, ok: true, x402Bridge: out?.x402Bridge ?? null });
          results.push({ type: "tool_result", tool_use_id: use.id, content: toToolResultContent(out) });
        } catch (e) {
          // **握り潰さない。** 失敗した事実をモデルへ返し、生ログにも残す。
          const messageText = e instanceof Error ? e.message : String(e);
          toolCalls.push({ name: use.name, input: use.input, ok: false, error: messageText });
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: messageText });
        }
      }
      messages.push({ role: "user", content: results });
    }

    return {
      text: extractText(message),
      model: message?.model ?? model,
      // **送っていないので null。** 0 と書くと「0 を指定した」という嘘になる。
      temperature: null,
      raw: {
        id: message?.id ?? null,
        stop_reason: message?.stop_reason ?? null,
        usage: message?.usage ?? null,
        effort,
        // **MCP が経路に入っていた証拠を生ログに残す。**
        mcpUrl: provider.url ?? null,
        toolNames: tools.map((t) => t.name),
        toolCalls,
      },
    };
  };
}

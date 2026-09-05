/**
 * 実 LLM を呼ぶアダプタ。**このセッションでは一度も実行していない**（実行は依頼元。
 * 課金と人間の判断が発生する）。純粋な部分——要求の組み立てと応答からの本文取り出し——
 * だけをテストで固定してある。
 *
 * SDK は**動的 import** する。examples に依存を持たせないため
 * （`npm i @anthropic-ai/sdk` を打った人だけが使える形）。
 *
 * **temperature を送らない。** 現行モデル（Claude Opus 5 等）は `temperature` /
 * `top_p` を受け付けず 400 を返す。§16 は「同一 temperature」を要求しているが、
 * **設定できないものは設定しない**。全試行で null（=送っていない）が揃っていることを
 * ハーネスがメタに残す。これは事前登録からの逸脱なので報告に書く。
 */
export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_EFFORT = "high";

/** @returns Messages API へそのまま渡す params。 */
export function buildRequestParams({ prompt, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, effort = DEFAULT_EFFORT }) {
  return {
    model,
    max_tokens: maxTokens,
    // thinking は指定しない——Claude Opus 5 は既定で adaptive。
    output_config: { effort },
    messages: [{ role: "user", content: prompt }],
  };
}

/** text ブロックだけを連結する。thinking を混ぜない（採点対象は答えだけ）。 */
export function extractText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

/**
 * `runAgent` を作る。**依頼元が実行する唯一の場所。**
 * `client` を渡さなければ `@anthropic-ai/sdk` を動的 import して作る。
 */
export async function createAnthropicAgent({ model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, maxTokens = DEFAULT_MAX_TOKENS, client } = {}) {
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
  return async function runAgent(prompt) {
    const message = await sdk.messages.create(buildRequestParams({ prompt, model, maxTokens, effort }));
    return {
      text: extractText(message),
      model: message?.model ?? model,
      // **送っていないので null。** 0 と書くと「0 を指定した」という嘘になる。
      temperature: null,
      raw: { id: message?.id ?? null, stop_reason: message?.stop_reason ?? null, usage: message?.usage ?? null, effort },
    };
  };
}

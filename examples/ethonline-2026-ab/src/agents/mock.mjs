/**
 * **モックのエージェント。これは測定ではない。**
 *
 * 目的はただ1つ——**鍵の無い環境でハーネス自体（20試行・集計・出力・検算）を通すこと**。
 * どのモデルの能力も表していないので、出力には `isMock` が立ち、summary.md の先頭に
 * その断り書きが出る（`writer.mjs`）。
 *
 * 設計上の縛り: **プロンプトしか見ない。** 正解表（fixtures.mjs）を import しない。
 * 覗いていたら「Recipe があると当たる」は自作自演になる。テストで固定してある。
 */
import { RECIPE_MARKER } from "../prompt.mjs";

export const MOCK_MODEL = "mock-scripted-v1";

/**
 * プロンプトの **Target ブロックだけ**から相手を見分ける（ctx を受け取らない）。
 * プロンプト全体を検索すると、条件 B では SKILL.md 本文の URL に釣られて
 * 相手を取り違える（実際に起きた。`test/agents.test.mjs` で固定）。
 */
function readTarget(fullPrompt) {
  const start = fullPrompt.indexOf("## Target");
  const end = fullPrompt.indexOf("## Your task", start === -1 ? 0 : start);
  const prompt = start === -1 || end === -1 ? fullPrompt : fullPrompt.slice(start, end);
  const ceiling = Number(/your ceiling:\s*\$([0-9.]+)/.exec(prompt)?.[1] ?? "1");
  const amount = Number(/amount:\s*\$([0-9.]+)/.exec(prompt)?.[1] ?? "0");
  const overCeiling = amount > ceiling;
  if (prompt.includes("gateway.thegraph.com")) return { kind: "thegraph", overCeiling };
  if (prompt.includes("agent.api.0x.org")) return { kind: "zeroex", overCeiling };
  if (prompt.includes("kronossignals.com")) return { kind: overCeiling ? "over" : "kronos", overCeiling };
  return { kind: "unknown", overCeiling };
}

/**
 * 台本。**A は「判定は当たるが理由を作る」**、**B は Recipe に載っている語を使う**——
 * WINDOW_PLAN §16 の「予測」と同じ形にしてある。**予測どおりに動く台本であって、
 * 予測が当たった証拠ではない。**
 */
const SCRIPT = {
  A: {
    kronos: { verdict: "proceed", reason_codes: ["payee_verified"] },
    thegraph: { verdict: "refuse", reason_codes: ["no_payment_history"] },
    zeroex: { verdict: "refuse", reason_codes: ["untrusted_payee"] },
    over: { verdict: "refuse", reason_codes: ["amount_exceeds_limit"] },
    unknown: { verdict: "refuse", reason_codes: ["unknown_target"] },
  },
  B: {
    kronos: { verdict: "proceed", reason_codes: ["l0_pass", "l1_delivered"] },
    thegraph: { verdict: "refuse", reason_codes: ["payee_recommendation_not_allow"] },
    zeroex: { verdict: "refuse", reason_codes: ["l1_not_attempted", "payee_recommendation_not_allow"] },
    over: { verdict: "refuse", reason_codes: ["price_above_ceiling"] },
    unknown: { verdict: "refuse", reason_codes: ["evidence_unavailable"] },
  },
};

/**
 * @param {{flaky?: boolean}} options `flaky` は10回に1回投げ、10回に1回 JSON を返さない
 *   （エラー経路と unparseable 経路が集計に載ることを実出力で見せるため）。
 */
export function createMockAgent({ flaky = false } = {}) {
  let calls = 0;
  return async function runAgent(prompt) {
    calls += 1;
    if (flaky && calls % 10 === 5) throw new Error("mock upstream error (scripted)");
    const condition = prompt.includes(RECIPE_MARKER) ? "B" : "A";
    const { kind } = readTarget(prompt);
    if (flaky && calls % 10 === 7) {
      return { text: "I would not pay this endpoint without more information.", model: MOCK_MODEL, temperature: 0 };
    }
    const answer = SCRIPT[condition][kind];
    return {
      text: JSON.stringify({ ...answer, explanation: `scripted mock answer for ${kind} under condition ${condition}` }),
      model: MOCK_MODEL,
      temperature: 0,
    };
  };
}

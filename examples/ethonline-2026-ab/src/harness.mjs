/**
 * A/B ハーネス本体。**§16 の事前登録をそのまま実行する。**
 *
 * 事前登録で固定されている数（1条件10試行・合計20試行・条件2つ）は
 * **引数で変えられない**。実装の都合で変えられるなら事前登録の意味が消える。
 *
 * 生ログはここが作り、集計は {@link ../src/aggregate.mjs} が**毎回この生ログから計算する**。
 * 集計値をここで持ち回らない（食い違う余地を作らない）。
 */
import { FIXTURES, fixtureReadiness } from "./fixtures.mjs";
import { buildPrompt, TASK } from "./prompt.mjs";
import { parseAgentAnswer } from "./parse.mjs";
import { grade } from "./grade.mjs";

/** §16「1条件あたり10試行・合計20試行」。 */
export const TRIALS_PER_CONDITION = 10;
export const CONDITIONS = Object.freeze(["A", "B"]);
export const PRE_REGISTRATION = "docs/ethonline-2026/WINDOW_PLAN.md §16 (2026-09-05 09:05)";

/**
 * @param {object} args
 * @param {(prompt: string, ctx: object) => Promise<{text: string, model?: string, temperature?: number, raw?: unknown}>} args.runAgent
 *   **LLM を呼ぶ唯一の場所。** 差し替え可能な1関数に隔離してある（鍵の無い環境でも
 *   ハーネス自体を検査できる・依頼元がモデルを選べる・再現性）。
 */
export async function runAbHarness({
  runAgent,
  resources,
  fixtures = FIXTURES,
  trialsPerCondition = TRIALS_PER_CONDITION,
  now = () => new Date(),
}) {
  if (trialsPerCondition !== TRIALS_PER_CONDITION) {
    throw new Error(
      `trialsPerCondition is pre-registered at ${TRIALS_PER_CONDITION} (${PRE_REGISTRATION}); ` +
        `refusing to run ${trialsPerCondition}. Change the pre-registration first, in the open.`,
    );
  }

  const startedAt = now().toISOString();
  const trials = [];
  const modelsSeen = new Set();
  const temperaturesSeen = new Set();

  for (const condition of CONDITIONS) {
    for (let i = 0; i < trialsPerCondition; i += 1) {
      // フィクスチャは決まった順で回す（§16「4フィクスチャ×2〜3周」）。
      // 乱数を使わない——同じ順序でなければ A と B が同じ課題を見たと言えない。
      const fixture = fixtures[i % fixtures.length];
      const prompt = buildPrompt({ condition, fixture, resources });
      const t0 = Date.now();
      let text = "";
      let error = null;
      let model = null;
      let temperature = null;
      let raw = null;
      try {
        const out = await runAgent(prompt, { condition, fixture, trialIndex: i });
        text = typeof out?.text === "string" ? out.text : "";
        model = out?.model ?? null;
        temperature = out?.temperature ?? null;
        raw = out?.raw ?? null;
      } catch (e) {
        // **握り潰さない。1試行として残す。** 失敗を捨てる経路を作らないのがこのハーネスの要件。
        error = { message: e instanceof Error ? e.message : String(e), name: e?.name ?? "Error" };
      }
      const durationMs = Date.now() - t0;
      const answer = error === null ? parseAgentAnswer(text) : { verdict: null, reasonCodes: [], explanation: null, unparseable: true };
      const oracle = { verdict: fixture.oracle.verdict, reasonCodes: [...fixture.oracle.reasonCodes], measured: fixture.oracle.measured };

      // **エラーになった試行を「モデルが変わった」と読まない**（未報告と不一致は別）。
      // 一方 temperature の `null` は値として数える——現行モデルは temperature を
      // 受け付けない（400）ので、「全試行 null」は同一 temperature が満たされた状態。
      if (error === null) {
        modelsSeen.add(model);
        temperaturesSeen.add(temperature);
      }

      trials.push({
        trialIndex: trials.length,
        condition,
        cycle: Math.floor(i / fixtures.length),
        fixtureId: fixture.id,
        model,
        temperature,
        prompt,
        rawResponse: text,
        raw,
        answer,
        oracle,
        grade: grade(answer, oracle),
        durationMs,
        error,
      });
    }
  }

  const models = [...modelsSeen];
  const temps = [...temperaturesSeen];
  return {
    meta: {
      preRegistration: PRE_REGISTRATION,
      task: TASK,
      conditions: [...CONDITIONS],
      trialsPerCondition,
      totalTrials: trials.length,
      startedAt,
      finishedAt: now().toISOString(),
      model: models.length === 1 ? models[0] : null,
      modelsSeen: models,
      // §16「同一モデル・同一 temperature」。違ったら黙らずメタに残す。
      singleModel: models.length === 1,
      temperature: temps.length === 1 ? temps[0] : null,
      temperaturesSeen: temps,
      singleTemperature: temps.length === 1,
      fixtureReadiness: fixtureReadiness(fixtures),
    },
    trials,
  };
}

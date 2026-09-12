// ============================================================
// 運用者の天井（2026-09-12 コード監査 H-1）
//
// **なぜ要るか。** `maxPerTxUsd` は MCP ツールの入力、つまり **モデルの出力** だった。
// 天井を名乗らなければ SDK の既定 $1 で止まるが、モデルが `maxPerTxUsd: 500` と
// 書けば $500 の EIP-3009 認可がそのまま署名される。監査はスタブ署名器でこれを
// 再現した（`amountUsd: 5` / 402 が $5.00 を要求 → 省略で `price_above_ceiling`、
// 500 を渡すと `PAID`・`signTypedData` 1 回・署名した value = 5000000）。
//
// 天井を決めるのはモデルではなく、**サーバを起動した人間** である。
// 秘密鍵（`VOUCH_PAYER_PRIVATE_KEY`）と Graph キー（`GRAPH_API_KEY`）を
// env からしか取らないのと同じ理由で、天井も env からしか取らない。
// ツール入力に残るのは **下げる** 手段だけで、**上げる** 手段は存在しない。
//
// **既定を緩めない。** env 未設定のときの天井は $1 ——
//   - SDK の `DEFAULT_MAX_PER_TX_USD`（packages/sdk/src/pay-or-refuse.ts）と同値。
//     二つ目の既定を作らない。
//   - 監査前も「モデルが `maxPerTxUsd` を書かなければ $1」だったので、
//     **今日より緩い状態を新しく作らない**。変わるのは「モデルが自分で上げられた」
//     ことだけで、それがこの修正の目的そのものである。
//   - env の値が読めない（負・0・非数・Infinity）ときも $1 に落ちる。
//     読めない設定を「無制限」と解釈しない（fail-closed）。壊れていることは
//     `ceilingNotes()` が応答の summary で名乗る（黙って落とさない）。
//
// **新しい理由コードは作らない。** 天井を超えた 402 は既存の `price_above_ceiling`
// で拒否される（SDK の語彙をそのまま使う）。ここが足すのは summary の1文だけで、
// 「切り下げたこと」がモデルと人間の両方に読める形で残る。
// ============================================================

/** env 未設定・不正のときの天井（USD）。SDK の `DEFAULT_MAX_PER_TX_USD` と同値。 */
export const DEFAULT_MAX_PER_TX_USD = 1;

/** 運用者が天井を宣言する環境変数。`VOUCH_API_KEY` / `VOUCH_TIMEOUT_MS` と同じ流儀。 */
export const MAX_PER_TX_USD_ENV = "VOUCH_MAX_PER_TX_USD";

export type MaxPerTxUsdResolution = {
  /** 実際に SDK とサーバへ渡す上限（USD）。常に `ceiling` 以下。 */
  effective: number;
  /** 運用者の天井（env が読めなければ {@link DEFAULT_MAX_PER_TX_USD}）。 */
  ceiling: number;
  /** ツール入力が名乗った値。名乗らなかった・使えない値だったなら `undefined`。 */
  requested?: number;
  /** ツール入力が天井より上だったので切り下げた。 */
  clamped: boolean;
  /** env に使える天井が宣言されていた（＝既定ではない）。 */
  ceilingConfigured: boolean;
  /** env に値はあったが読めなかったので既定へ落とした（fail-closed・要通知）。 */
  envRejected: boolean;
};

/**
 * ツール入力と env から、実際に使う上限を決める。**純関数**——
 * `index.ts` は `main()` を起動時に呼ぶので import できず、振る舞いをテストで
 * 固定できる場所がここしかない（test/tool-contract.test.mjs の冒頭に同じ事情）。
 *
 * @param requested ツール入力の `maxPerTxUsd`（モデルの出力）
 * @param rawEnv `process.env[MAX_PER_TX_USD_ENV]`
 */
export function resolveMaxPerTxUsd(
  requested: number | undefined,
  rawEnv: string | undefined,
): MaxPerTxUsdResolution {
  const trimmed = typeof rawEnv === "string" ? rawEnv.trim() : "";
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  const ceilingConfigured = Number.isFinite(parsed) && parsed > 0;
  const ceiling = ceilingConfigured ? parsed : DEFAULT_MAX_PER_TX_USD;
  // 値はあったのに使えなかった場合だけ「拒否した」と言う（未設定は拒否ではない）。
  const envRejected = trimmed !== "" && !ceilingConfigured;

  // ツール入力も同じ厳しさで読む。zod が既に正の有限数に絞っているが、
  // この関数はそれに依存しない（`dist` を直接呼ぶ経路もテストにある）。
  const wanted =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : undefined;

  return {
    effective: wanted === undefined ? ceiling : Math.min(wanted, ceiling),
    ceiling,
    ...(wanted === undefined ? {} : { requested: wanted }),
    clamped: wanted !== undefined && wanted > ceiling,
    ceilingConfigured,
    envRejected,
  };
}

/**
 * 応答の `summary` に足す1文。**何も起きていなければ空配列**——
 * 通常の応答文を天井の話で汚さない。新しい理由コードは作らない（§語彙は不変）。
 */
export function ceilingNotes(r: MaxPerTxUsdResolution): string[] {
  const notes: string[] = [];
  if (r.envRejected) {
    notes.push(
      `${MAX_PER_TX_USD_ENV} in this server's env is not a positive number, so it was ignored and the ` +
        `built-in ceiling of $${DEFAULT_MAX_PER_TX_USD} per payment applies. Fix the env block: an unreadable ` +
        `ceiling is never read as "no ceiling".`,
    );
  }
  if (r.clamped) {
    notes.push(
      `Server ceiling: this MCP server caps a single payment at $${r.ceiling}` +
        `${r.ceilingConfigured ? ` (${MAX_PER_TX_USD_ENV})` : ` (${MAX_PER_TX_USD_ENV} unset — built-in default)`}, ` +
        `so the maxPerTxUsd $${r.requested} in this tool call was lowered to $${r.ceiling}. Tool input can ` +
        `lower the ceiling but never raise it; only the operator who runs this server can.`,
    );
  }
  return notes;
}

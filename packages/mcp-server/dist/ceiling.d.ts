/** env 未設定・不正のときの天井（USD）。SDK の `DEFAULT_MAX_PER_TX_USD` と同値。 */
export declare const DEFAULT_MAX_PER_TX_USD = 1;
/** 運用者が天井を宣言する環境変数。`VOUCH_API_KEY` / `VOUCH_TIMEOUT_MS` と同じ流儀。 */
export declare const MAX_PER_TX_USD_ENV = "VOUCH_MAX_PER_TX_USD";
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
export declare function resolveMaxPerTxUsd(requested: number | undefined, rawEnv: string | undefined): MaxPerTxUsdResolution;
/**
 * 応答の `summary` に足す1文。**何も起きていなければ空配列**——
 * 通常の応答文を天井の話で汚さない。新しい理由コードは作らない（§語彙は不変）。
 */
export declare function ceilingNotes(r: MaxPerTxUsdResolution): string[];

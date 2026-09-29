export declare const KNOWN_ERROR_CODES: Set<string>;
/**
 * 既知の語に添える固定の説明（上流の文字列は使わない）。サーバが `reason` を返したときはそちらを優先する。
 * 語は変えない（先頭の語で分岐する呼び手がいる）——`<code>: <説明>` の形。
 */
export declare const KNOWN_ERROR_EXPLANATIONS: Readonly<Record<string, string>>;
/**
 * 呼び出し側の誤りで、**メッセージを我々自身のコードが組み立てる**もの（SDK の
 * `assertEvidencePolicy` / `assertOverridePolicy` と MCP の `assertPolicy`）。上流の文字列を
 * 含まないので、そのまま通してよい。`request_failed` に潰すと、呼び手（モデル）は
 * 「床を書き忘れた」のか「上流が落ちた」のか区別できず、直す場所が分からない。
 */
export declare const CALLER_ERROR_PREFIXES: string[];
/** Stable code returned when the trust lookup never answered. */
export declare const LOOKUP_TIMEOUT_MESSAGE = "lookup_timeout: the trust lookup did not answer in time \u2014 the payee was NOT checked";
/**
 * Turn an arbitrary thrown value into a string the model may see.
 *
 * Allow-list by design: anything not on the known-code list collapses to
 * `request_failed`, so an upstream stack trace or a URL with a key in it can
 * never reach the transcript.
 */
export declare function sanitizeToolError(error: unknown): string;

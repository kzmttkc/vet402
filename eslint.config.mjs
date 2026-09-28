import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/worktrees/**",
  ]),
  // サーバログの秘密（2026-09-29 監査 第2巡）: logServerError / logAndSwallow は
  // error.message を素で出し、viem の RPC エラーは URL（= 鍵入り）を本文に持つ。
  // src の呼び手は必ず "@/lib/util/log-safe" の *Safe を通す。除外は凍結中のファイル
  // （Tokyo 審査期間・log.ts 自身・lease.ts）と、伏せる層そのもの（log-safe.ts）だけ。
  // 同じ規則を tests/log-safe.test.ts が src の走査でも見ている（lint を回さない経路の保険）。
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/util/log.ts",
      "src/lib/util/log-safe.ts",
      "src/lib/cron/lease.ts",
      "src/app/tokyo/**",
      "src/app/api/tokyo/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/util/log", "**/util/log"],
              message:
                "logServerError / logAndSwallow は鍵入り URL を伏せない。@/lib/util/log-safe の logServerErrorSafe / logAndSwallowSafe を使う。",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;

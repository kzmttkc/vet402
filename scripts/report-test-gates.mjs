#!/usr/bin/env node
// 2026-08-22 監査。`npm test` は DB を要求する suite を丸ごと skip するので、
// ローカルでは「緑」と「資金ガードが検証された」が別物になる。
// CI は db-tests ジョブ（2026-08-19 追加・エフェメラル Postgres）で
// test:db を回すのでカバーされているが、**手元で回した人にそれが見えない**。
// 落とさずに、見えるようにする。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = "tests";
const gated = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => readFileSync(join(dir, f), "utf8").includes("TEST_DATABASE_URL"));

const set = Boolean(process.env.TEST_DATABASE_URL);
const head = set
  ? `\x1b[32m✔\x1b[0m TEST_DATABASE_URL is set — all ${gated.length} DB-backed suites will run.`
  : `\x1b[33m⚠\x1b[0m TEST_DATABASE_URL is NOT set — ${gated.length} DB-backed suites will SKIP locally.`;

console.log(`\n${head}`);
if (!set) {
  console.log(
    "  These cover the highest money-risk paths (L1 atomic reservation, daily cap,\n" +
      "  orphan sweep, settlement verification). CI runs them on every push via the\n" +
      "  `db-tests` job. To run them here (2026-08-23, measured on this machine):\n" +
      "    createdb vet402test\n" +
      "    export TEST_DATABASE_URL=postgres://$USER@localhost:5432/vet402test\n" +
      "    DATABASE_URL=$TEST_DATABASE_URL npm run db:push -- --force\n" +
      "    npm run test:db\n" +
      "  約2分・143件。資金経路の意味論を変えたら、push する前にここを通すこと。",
  );
  for (const f of gated) console.log(`    - tests/${f}`);
}
console.log("");

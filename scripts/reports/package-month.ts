// ============================================================
// 凍結済み月次レポートを Zenodo / Hugging Face / Dune 用の束に書く（I6）。
//
//   npx tsx scripts/reports/package-month.ts 2026-11 --fetch
//   npx tsx scripts/reports/package-month.ts 2026-11 --fetch --origin https://vet402.com
//
// --fetch のときだけ公開 URL へ GET する。環境変数は読まない。アップロードはしない。
// 出力: dist/reports/{month}/zenodo|huggingface|dune/
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_REPORTS_ORIGIN,
  fetchPublicMonthlyFreeze,
  packageMonthFromInput,
  type MonthlyPackageInput,
} from "../../src/lib/reports/package-month";
import { parseMonthlyFreezeMonth } from "../../src/lib/observatory/monthly-freeze";

export function parsePackageMonthArgv(argv: string[]): {
  month: string | null;
  fetch: boolean;
  origin: string;
  outRoot: string;
  fixtureJson: string | null;
} {
  let month: string | null = null;
  let fetch = false;
  let origin = DEFAULT_REPORTS_ORIGIN;
  let outRoot = join(process.cwd(), "dist", "reports");
  let fixtureJson: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--fetch") fetch = true;
    else if (arg === "--origin" && argv[i + 1]) origin = argv[++i]!;
    else if (arg === "--out" && argv[i + 1]) outRoot = argv[++i]!;
    else if (arg === "--fixture" && argv[i + 1]) fixtureJson = argv[++i]!;
    else if (!arg.startsWith("-") && !month) month = arg;
  }
  return { month, fetch, origin, outRoot, fixtureJson };
}

function loadFixture(path: string): MonthlyPackageInput {
  const raw = JSON.parse(readFileSync(path, "utf8")) as MonthlyPackageInput;
  if (!raw.summary || typeof raw.csvBody !== "string") {
    throw new Error("fixture must be { summary, csvBody }");
  }
  return raw;
}

async function main() {
  const args = parsePackageMonthArgv(process.argv);
  const parsed = parseMonthlyFreezeMonth(args.month);
  if (!parsed.ok) {
    console.error("package-month: pass YYYY-MM from 2026 through 2100");
    process.exit(1);
  }

  let input: MonthlyPackageInput | null = null;
  let trustFrozen = false;

  if (args.fixtureJson) {
    if (!existsSync(args.fixtureJson)) {
      console.error(`package-month: fixture not found: ${args.fixtureJson}`);
      process.exit(1);
    }
    input = loadFixture(args.fixtureJson);
  } else if (args.fetch) {
    const fetched = await fetchPublicMonthlyFreeze(parsed.month, args.origin);
    if (!fetched.ok) {
      if (fetched.status === "not_frozen_yet") {
        console.error("未凍結");
        process.exit(0);
      }
      if (fetched.status === "month_not_closed") {
        console.error("package-month: month is still open");
        process.exit(1);
      }
      console.error("package-month: invalid month");
      process.exit(1);
    }
    input = fetched.input;
    trustFrozen = true;
  } else {
    console.error("package-month: pass --fetch or --fixture <path.json>");
    process.exit(1);
  }

  const outcome = packageMonthFromInput(args.outRoot, input, { trustFrozen });
  if (outcome.status === "not_frozen_yet") {
    console.error("未凍結");
    process.exit(0);
  }
  if (outcome.status === "month_not_closed") {
    console.error("package-month: month is still open");
    process.exit(1);
  }
  if (outcome.status === "invalid_month") {
    console.error("package-month: invalid month");
    process.exit(1);
  }
  console.log(JSON.stringify({ month: outcome.result.month, root: outcome.result.rootDir, files: outcome.result.fileSha256 }, null, 2));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error("package-month: fatal", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
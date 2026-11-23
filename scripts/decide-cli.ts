// Rules-only decision CLI. One JSON object on stdin, one JSON object on stdout.
// No database, no network, no environment.
import {
  DECISION_RULES_VERSION,
  decidePayee,
  decidePayer,
  type PayeeOptions,
  type PayerOptions,
} from "../src/lib/decision/rules";
import type { BuyerFacts, SellerFacts } from "../src/lib/decision/types";
import { pathToFileURL } from "node:url";

type Input = {
  role?: unknown;
  facts?: unknown;
  now?: unknown;
  callerDialect?: PayerOptions["callerDialect"];
  allowWithoutL1?: boolean;
  operatorBlacklist?: boolean;
  dataDepth?: PayerOptions["dataDepth"];
  l1NotCounted?: PayerOptions["l1NotCounted"];
  l0UnverifiedCause?: string | null;
  l1Timeline?: PayerOptions["l1Timeline"];
  l2ConformNoRequiredKeys?: boolean;
};

function asNow(value: unknown, required: boolean): Date | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error("now is required for role payee");
    return undefined;
  }
  if (typeof value !== "string") throw new Error("now must be an ISO-8601 string");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("now is not a valid time");
  return date;
}

export function decisionFromInput(input: Input): { recommendation: string; reason_codes: string[]; rulesVersion: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected one JSON object");
  if (!input.facts || typeof input.facts !== "object" || Array.isArray(input.facts)) throw new Error("facts must be an object");
  if (input.role === "payer") {
    const now = asNow(input.now, false);
    const options: PayerOptions = {
      ...(input.callerDialect !== undefined ? { callerDialect: input.callerDialect } : {}),
      ...(input.allowWithoutL1 !== undefined ? { allowWithoutL1: input.allowWithoutL1 } : {}),
      ...(input.operatorBlacklist !== undefined ? { operatorBlacklist: input.operatorBlacklist } : {}),
      ...(input.dataDepth !== undefined ? { dataDepth: input.dataDepth } : {}),
      ...(input.l1NotCounted !== undefined ? { l1NotCounted: input.l1NotCounted } : {}),
      ...(input.l0UnverifiedCause !== undefined ? { l0UnverifiedCause: input.l0UnverifiedCause } : {}),
      ...(input.l1Timeline !== undefined ? { l1Timeline: input.l1Timeline } : {}),
      ...(input.l2ConformNoRequiredKeys !== undefined ? { l2ConformNoRequiredKeys: input.l2ConformNoRequiredKeys } : {}),
      ...(now ? { now } : {}),
    };
    return { ...decidePayer(input.facts as SellerFacts, options), rulesVersion: DECISION_RULES_VERSION };
  }
  if (input.role === "payee") {
    const now = asNow(input.now, true);
    const options: PayeeOptions = {
      now: now!,
      ...(input.operatorBlacklist !== undefined ? { operatorBlacklist: input.operatorBlacklist } : {}),
    };
    return { ...decidePayee(input.facts as BuyerFacts, options), rulesVersion: DECISION_RULES_VERSION };
  }
  throw new Error("role must be payer or payee");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

async function main(): Promise<void> {
  const text = (await readStdin()).trim();
  if (!text) throw new Error("expected one JSON object on stdin");
  const value = JSON.parse(text) as Input;
  process.stdout.write(`${JSON.stringify(decisionFromInput(value))}\n`);
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

if (runningAsCli()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

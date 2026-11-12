// POST /api/v1/payment-proof。鍵なし。署名も送金もしない。
// 売り手の success は主張で、状態はチェーンの読みが決める。
import { NextResponse, type NextRequest } from "next/server";
import {
  PAYMENT_PROOF_KEYLESS_LIMIT,
  PAYMENT_PROOF_KEYLESS_WINDOW_MS,
  PAYMENT_PROOF_RPC_TIMEOUT_MS,
} from "@/lib/api/keyless-limits";
import { publicRateLimit, type PublicGate } from "@/lib/api/public-route";
import { explorerTxUrl } from "@/lib/observatory/chains";
import {
  classifyPaymentNetwork,
  isReadableTx,
  readPaymentOnChain,
  type PaymentProofReaders,
} from "@/lib/payment-proof/chain";

const BODY_MAX_BYTES = 8_192;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UNAVAILABLE_RETRY_AFTER_S = 30;

const HTTP_MESSAGE = {
  invalid_payment_response: "paymentResponse must be base64 JSON with transaction and network.",
  invalid_body: "The body must be a JSON object.",
  invalid_fields: "Pass paymentResponse, or pass network and transaction.",
  invalid_transaction: "transaction must be a hash on that chain.",
  temporarily_unavailable: "The chain read did not finish. Retry in 30 seconds.",
} as const;

export type PaymentProofStatus = "confirmed" | "failed" | "not_found" | "unsupported_network";

export type PaymentProof = {
  found: boolean;
  network: string;
  tx: string;
  block: string | null;
  from: string | null;
  to: string | null;
  asset: string | null;
  amount: string | null;
  status: PaymentProofStatus;
  explorer: string | null;
  as_of: string;
};

export type PaymentProofDeps = {
  now?: () => Date;
  timeoutMs?: number;
  readers?: PaymentProofReaders;
};

type InputError = "invalid_body" | "invalid_payment_response" | "invalid_transaction";

type ParsedPayment = { network: string; transaction: string; payer: string | null };

export async function handlePaymentProof(request: NextRequest, deps?: PaymentProofDeps): Promise<Response> {
  const gate = await publicRateLimit(request, "payment-proof", PAYMENT_PROOF_KEYLESS_LIMIT, PAYMENT_PROOF_KEYLESS_WINDOW_MS);
  if (!gate.ok) return gate.response;

  let raw: string;
  try {
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return errorResponse(400, "invalid_body", gate);
    raw = await request.text();
  } catch {
    return errorResponse(400, "invalid_body", gate);
  }
  if (raw.length > BODY_MAX_BYTES) return errorResponse(400, "invalid_body", gate);

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return errorResponse(400, "invalid_body", gate);
  }
  const parsed = parseHttpBody(value);
  if (!parsed.ok) {
    return parsed.error === "invalid_fields"
      ? errorResponse(400, "invalid_body", gate, HTTP_MESSAGE.invalid_fields)
      : errorResponse(400, parsed.error, gate);
  }

  try {
    const proof = await withTimeout(buildProof(parsed.value, deps), deps?.timeoutMs ?? PAYMENT_PROOF_RPC_TIMEOUT_MS);
    return jsonResponse(200, proof, gate);
  } catch (error) {
    if (error instanceof ProofInputError) return errorResponse(400, error.code, gate);
    return errorResponse(503, "temporarily_unavailable", gate);
  }
}

export async function runCheckPaymentProof(
  args: { payment_response?: string; network?: string; transaction?: string },
  deps?: PaymentProofDeps,
): Promise<PaymentProof> {
  const parsed = parseMcpArgs(args);
  if (!parsed.ok) throw new Error(parsed.error);
  try {
    return await withTimeout(buildProof(parsed.value, deps), deps?.timeoutMs ?? PAYMENT_PROOF_RPC_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof ProofInputError) throw new Error(error.code);
    throw new Error("payment_proof_unavailable");
  }
}

class ProofInputError extends Error {
  constructor(readonly code: InputError) {
    super(code);
  }
}

async function buildProof(input: ParsedPayment, deps: PaymentProofDeps | undefined): Promise<PaymentProof> {
  const asOf = (deps?.now ?? (() => new Date()))().toISOString();
  const classified = classifyPaymentNetwork(input.network);
  if (classified.kind === "unsupported") {
    return proof({
      found: false,
      network: classified.caip,
      tx: input.transaction,
      block: null,
      from: null,
      to: null,
      asset: null,
      amount: null,
      status: "unsupported_network",
      explorer: null,
      as_of: asOf,
    });
  }
  if (!isReadableTx(input.transaction, classified.network)) throw new ProofInputError("invalid_transaction");
  const read = await readPaymentOnChain(classified.network, input.transaction.trim(), input.payer, deps?.readers);
  if (read.state === "unavailable") throw new Error("payment_proof_unavailable");
  const status: PaymentProofStatus = read.state;
  return proof({
    found: status === "confirmed" || status === "failed",
    network: classified.network.caip,
    tx: input.transaction.trim(),
    block: read.block,
    from: read.from,
    to: read.to,
    asset: read.asset,
    amount: read.amount,
    status,
    explorer: explorerTxUrl(classified.network.caip, input.transaction.trim()),
    as_of: asOf,
  });
}

function proof(value: PaymentProof): PaymentProof {
  return {
    found: value.found,
    network: value.network,
    tx: value.tx,
    block: value.block,
    from: value.from,
    to: value.to,
    asset: value.asset,
    amount: value.amount,
    status: value.status,
    explorer: value.explorer,
    as_of: value.as_of,
  };
}

function parseHttpBody(value: unknown): { ok: true; value: ParsedPayment } | { ok: false; error: InputError | "invalid_fields" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "invalid_body" };
  const rec = value as Record<string, unknown>;
  if ("paymentResponse" in rec && rec.paymentResponse !== undefined) {
    if (typeof rec.paymentResponse !== "string") return { ok: false, error: "invalid_payment_response" };
    const decoded = decodePaymentResponse(rec.paymentResponse);
    if (!decoded) return { ok: false, error: "invalid_payment_response" };
    return { ok: true, value: decoded };
  }
  if (typeof rec.network !== "string" || typeof rec.transaction !== "string") return { ok: false, error: "invalid_fields" };
  const network = rec.network.trim();
  const transaction = rec.transaction.trim();
  if (!network || !transaction) return { ok: false, error: "invalid_fields" };
  return { ok: true, value: { network, transaction, payer: null } };
}

function parseMcpArgs(args: {
  payment_response?: string;
  network?: string;
  transaction?: string;
}): { ok: true; value: ParsedPayment } | { ok: false; error: InputError } {
  if (args.payment_response !== undefined) {
    if (typeof args.payment_response !== "string") return { ok: false, error: "invalid_payment_response" };
    const decoded = decodePaymentResponse(args.payment_response);
    if (!decoded) return { ok: false, error: "invalid_payment_response" };
    return { ok: true, value: decoded };
  }
  if (typeof args.network !== "string" || typeof args.transaction !== "string") return { ok: false, error: "invalid_body" };
  const network = args.network.trim();
  const transaction = args.transaction.trim();
  if (!network || !transaction) return { ok: false, error: "invalid_body" };
  return { ok: true, value: { network, transaction, payer: null } };
}

export function decodePaymentResponse(raw: string): ParsedPayment | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !B64_RE.test(trimmed)) return null;
  let text: string;
  try {
    text = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return null;
  }
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.transaction !== "string" || typeof rec.network !== "string") return null;
  const transaction = rec.transaction.trim();
  const network = rec.network.trim();
  if (!transaction || !network) return null;
  const payer = typeof rec.payer === "string" && rec.payer.trim() ? rec.payer.trim() : null;
  return { network, transaction, payer };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("payment_proof_timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function jsonResponse(status: number, body: unknown, gate: Extract<PublicGate, { ok: true }>): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const [key, value] of Object.entries(gate.headers)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(
  status: number,
  code: InputError | "temporarily_unavailable",
  gate: Extract<PublicGate, { ok: true }>,
  message?: string,
): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const [key, value] of Object.entries(gate.headers)) headers.set(key, value);
  if (status === 503) headers.set("retry-after", String(UNAVAILABLE_RETRY_AFTER_S));
  return NextResponse.json({ error: code, message: message ?? HTTP_MESSAGE[code] }, { status, headers });
}

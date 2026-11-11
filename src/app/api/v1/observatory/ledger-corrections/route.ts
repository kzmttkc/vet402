import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { publicRateLimit } from "@/lib/api/public-route";
import {
  ledgerCorrectionSignMessage,
  parseAddressList,
  prepareLedgerCorrection,
  reverifyLedgerCorrectionRow,
  type LedgerCorrectionAuth,
  type LedgerCorrectionWriteInput,
} from "@/lib/observatory/ledger-corrections-public";
import { ledgerCorrectionStore } from "@/lib/observatory/ledger-corrections-store";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * /api/v1/observatory/ledger-corrections（2026-11-10 公平審査 3.8 の 6c）。
 *
 * GET  鍵なし。全行を古い順に返す。third_party の行は、その場で署名を確かめ直した結果
 *      （signatureValid）と、署名した文（signedMessage）を付ける。読んだ人も同じ検算ができる。
 * POST self は Authorization: Bearer <LEDGER_CORRECTION_SELF_TOKEN>。トークンが未設定なら self の口は閉じる。
 *      third_party は署名で書く。署名者は LEDGER_CORRECTION_THIRD_PARTY_PUBKEY（カンマ区切り）にあり、
 *      LEDGER_CORRECTION_SELF_PUBKEY（自社のアドレス）に無いこと。
 * 保存は追記だけ（ledger-corrections-store.ts）。保存先が無ければ 503 で閉じる。
 */

export const dynamic = "force-dynamic";

function authFromEnv(): LedgerCorrectionAuth {
  return {
    selfAddresses: parseAddressList(process.env.LEDGER_CORRECTION_SELF_PUBKEY),
    thirdPartyAddresses: parseAddressList(process.env.LEDGER_CORRECTION_THIRD_PARTY_PUBKEY),
  };
}

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(request: NextRequest): string {
  const h = request.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "ledger-corrections", 60);
  if (!gate.ok) return gate.response;
  const store = ledgerCorrectionStore();
  if (!store) {
    return NextResponse.json({ error: "ledger_corrections_unavailable" }, { status: 503, headers: gate.headers });
  }
  try {
    const entries = await store.list();
    const corrections = await Promise.all(
      entries.map(async (row) => {
        if (row.kind !== "third_party") return row;
        return {
          ...row,
          signedMessage: ledgerCorrectionSignMessage(row),
          signatureValid: await reverifyLedgerCorrectionRow(row),
        };
      }),
    );
    const retrievedAt = new Date().toISOString();
    const cite = `KIZUNA Creation. vet402 observatory ledger corrections, retrieved ${retrievedAt}. https://vet402.com/api/v1/observatory/ledger-corrections`;
    return NextResponse.json(
      {
        corrections,
        counts: {
          self: corrections.filter((c) => c.kind === "self").length,
          third_party: corrections.filter((c) => c.kind === "third_party").length,
        },
        verify:
          "A third_party row verifies with EIP-191 personal_sign recovery of signature over signedMessage. The recovered address must equal signerAddress. No key is needed.",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        retrievedAt,
        cite,
      },
      { headers: gate.headers },
    );
  } catch (error) {
    logServerErrorSafe("ledger_corrections_get", error);
    return NextResponse.json({ error: "ledger_corrections_unavailable" }, { status: 503, headers: gate.headers });
  }
}

export async function POST(request: NextRequest) {
  const gate = await publicRateLimit(request, "ledger-corrections-write", 10);
  if (!gate.ok) return gate.response;
  let body: LedgerCorrectionWriteInput;
  try {
    body = (await request.json()) as LedgerCorrectionWriteInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: gate.headers });
  }
  if (body?.kind === "self") {
    const expected = (process.env.LEDGER_CORRECTION_SELF_TOKEN ?? "").trim();
    if (expected === "") {
      return NextResponse.json({ error: "self_writes_closed" }, { status: 403, headers: gate.headers });
    }
    const given = bearer(request);
    if (given === "" || !sameSecret(given, expected)) {
      return NextResponse.json({ error: "self_token_invalid" }, { status: 403, headers: gate.headers });
    }
  }
  const store = ledgerCorrectionStore();
  if (!store) {
    return NextResponse.json({ error: "ledger_corrections_unavailable" }, { status: 503, headers: gate.headers });
  }
  const prepared = await prepareLedgerCorrection(body, authFromEnv());
  if (!prepared.ok) {
    const status = prepared.error === "self_key_cannot_write_third_party" || prepared.error === "third_party_signer_not_allowed" || prepared.error === "invalid_signature" ? 403 : 400;
    return NextResponse.json({ error: prepared.error }, { status, headers: gate.headers });
  }
  try {
    await store.append(prepared.entry);
    return NextResponse.json({ ok: true, id: prepared.entry.id, kind: prepared.entry.kind }, { status: 201, headers: gate.headers });
  } catch (error) {
    logServerErrorSafe("ledger_corrections_post", error);
    return NextResponse.json({ error: "ledger_corrections_unavailable" }, { status: 503, headers: gate.headers });
  }
}
